/**
 * sharedEvents handler for resuming a previously-run Claude Code session:
 *   onResumeSessionRequest
 *
 * Three possible paths:
 *   1. The target session id is STILL LIVE in this daemon — just attach and
 *      replay history. (Covers "rejoin my own active session" after a
 *      network blip.)
 *   2. The target session id is STORED LOCALLY (Remi store or Claude
 *      transcript index) and this daemon has no active session — spawn a
 *      new PTY with `claude --resume <claudeSessionId>` in the stored
 *      project directory.
 *   3. Neither: respond with a failure.
 *
 * Spawning is delegated back to `cli.ts`'s `createNewSession` via an
 * injected dep; keeping it opaque here means we don't have to drag the
 * entire createNewSession closure (PTY + MessageAPI + transcript watcher
 * + hook setup) out of cli.ts to test this handler.
 *
 * A daemon that hosts another harness than Claude (`remi codex`, #1179) refuses
 * resume the same way, with the same code: every path below finds a Claude
 * session id in the Claude transcript layout and spawns `claude --resume`, which
 * a Codex daemon must never do. A Codex thread resumes from a terminal
 * (`remi codex resume <thread id>`); resuming one through a hub is not built.
 *
 * Hub mode (`remi serve`, #1124, #1129): the hub is a session-less supervisor and must never run
 * Claude itself. A direct `Connection` dispatches resume requests to this handler. With
 * `childSessions` set, the stored session is
 * resolved as in path 2 and then, instead of spawning a PTY, a CHILD session daemon is started with
 * `--resume <id>` through the same path a create request uses (`startSession`: the remote-argument
 * allowlist, the held-session check, a port, the spawn). The response carries the child's port; the
 * hub attaches nobody and sends no `hello_ack`, because the session belongs to another process and
 * the client reaches it through the session list and a direct connection. Until #1129 every such
 * request was refused with `UNSUPPORTED`.
 * The current HubRelay routes session-targeted resumes to live child proxies; it cannot resume an
 * exited stored session through this hub starter. That relay resume path remains unsupported.
 */

import * as path from 'node:path';
import {
  createHelloAck,
  createReplayBatch,
  createResumeSessionResponse,
  errorToString,
  escapeUnsafeText,
} from '@remi/shared';
import type { HarnessId, ProtocolMessage, UUID } from '@remi/shared';

import type { Harness } from '../../harness/types.ts';
import { AmbiguousSessionIdentityError, isClaudeRecord } from '../../session/index.ts';
import type { SessionBindingStore, SessionRegistry, SessionStore } from '../../session/index.ts';
import type { TranscriptDiscovery } from '../../transcript/index.ts';
import { DAEMON_CAPABILITIES } from '../capabilities.ts';
import { log, logError } from '../logger.ts';
import { resolveDirectory } from '../path-resolver.ts';
import type { StartChildSession } from './create-session-events.ts';
import { resendPendingQuestions } from './pending-question-resend.ts';
import type { SendToConnection } from './trivial-events.ts';

/**
 * Spawn a new Claude Code session in the given working directory. Mirrors
 * the signature of cli.ts's `createNewSession` for the arguments the resume
 * flow actually uses. The PTYSession return value is dropped, the caller
 * only needs the side effect (session registered in SessionRegistry).
 */
export type CreateNewSessionFn = (
  sessionId: UUID,
  workingDirectory: string,
  sendMessage: (sessionId: UUID, message: ProtocolMessage) => void,
  extraArgs: string[],
) => Promise<unknown>;

/**
 * Why a daemon hosting another harness refuses resume (#1179). The words name the one command
 * that works for Codex; they never echo the request, which is client-supplied.
 */
export function harnessResumeUnsupportedMessage(harnessId: HarnessId): string {
  return harnessId === 'codex'
    ? "Resuming a session from the app is not supported for Codex yet. Run 'remi codex resume <thread id>' from a terminal on the host machine ('remi --sessions' lists the ids)."
    : `Resuming a session from the app is not supported for ${harnessId} yet.`;
}

/** Same code vocabulary as the `error` frame (see `connection.ts` UNSUPPORTED). */
export const RESUME_UNSUPPORTED_CODE = 'UNSUPPORTED';

/** What a resume request names, or why it names nothing. */
type ResumeTarget =
  | { ok: true; claudeSessionId: string; workingDirectory: string }
  | { ok: false; error: string };

/** Canonical 8-4-4-4-12 hex UUID shape: the only Claude session id `--resume` takes. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The longest part of a requested id that is read back to the requester. */
const SHOWN_ID_MAX = 80;

/**
 * How long a session stays "just resumed" after a hub started its child (#1129 review, M2). The
 * store learns the new row's Claude id only once Claude binds, a few seconds after the spawn, and a
 * second request in that window (a double tap, two phones) passes the held check and starts a
 * second child that loses the race.
 */
const RESUME_HOLD_MS = 15_000;

const JUST_RESUMED_TEXT =
  'That session was just resumed on the host; open it from the session list.';
const NO_SESSION_NAMED_TEXT = 'The request does not name a session to resume.';

/** A requested id as it is read back or logged: written out, and cut when it is long. */
function shownId(id: string): string {
  return escapeUnsafeText(id.length > SHOWN_ID_MAX ? `${id.slice(0, SHOWN_ID_MAX)}...` : id);
}

/** What a requester reads when the child could not be started: the host's log has the cause. */
const CHILD_START_FAILED_TEXT =
  "The session could not be started on the host; the host's remi log has the reason.";

export interface ResumeSessionHandlerDeps {
  /**
   * Set in hub mode (`remi serve`) and only there: starts a child session daemon (#1129). The hub is
   * session-less and must never run Claude (#1124), so it is handed no way to: a resume there goes
   * through this instead of `createNewSession`. `null` for a session daemon or wrapper, which
   * resumes in its own process. Deliberately required with no default: a new composition root that
   * forgets it fails to compile instead of failing open into running Claude in a hub.
   */
  childSessions: StartChildSession | null;
  /**
   * The harness this daemon hosts. Anything but Claude refuses resume (#1179). Required with no
   * default, like `childSessions`: a composition root that forgets it fails to compile instead of
   * failing open into `claude --resume` inside a Codex daemon.
   */
  harnessId: HarnessId;
  /**
   * The harnesses this daemon can start, named on the acks this handler sends so
   * that every hello_ack carries them (#1179).
   */
  harnesses: () => readonly HarnessId[];
  /**
   * The capabilities named on every ack (#1237, ADR 0035): {@link DAEMON_CAPABILITIES} unless a
   * test gives another list to see it reach each ack.
   */
  capabilities?: readonly string[];
  sessionRegistry: SessionRegistry;
  /** Full-record reads that also need projectPath (resume seed by remi id). */
  sessionStore: SessionStore;
  /** Binding-only reverse lookup (resolve by claude session id) — routed through
   *  the accessor so it cannot diverge from the other resume resolver. */
  bindingStore: SessionBindingStore;
  transcriptDiscovery: TranscriptDiscovery;
  /** The clock for the "just resumed" window; a test gives its own. */
  now?: () => number;
  /** Builds the launch arguments that resume a stored session (`resumeArgs`). */
  harness: Pick<Harness, 'resumeArgs'>;
  createNewSession: CreateNewSessionFn;
  send: SendToConnection;
}

export type ResumeSessionHandlers = ReturnType<typeof createResumeSessionHandlers>;

export function createResumeSessionHandlers(deps: ResumeSessionHandlerDeps) {
  const {
    childSessions,
    now = Date.now,
    harnessId,
    harnesses,
    capabilities = DAEMON_CAPABILITIES,
    sessionRegistry,
    sessionStore,
    bindingStore,
    transcriptDiscovery,
    harness,
    createNewSession,
    send,
  } = deps;

  /**
   * What a resume request names: the Claude session to resume and the directory it ran in, or the
   * text that tells the requester why there is none. Looks the id up as a remi id, then a Claude id,
   * then a transcript on disk. A record of another harness has no Claude session id, so it is never
   * resumed with Claude's flag.
   */
  function resolveResumeTarget(targetSessionId: string): ResumeTarget {
    let claudeSessionId: string | null = null;
    let projectPath: string | null = null;
    const shown = shownId(targetSessionId);

    try {
      const storedByRemi = sessionStore.findByRemiSessionId(targetSessionId as UUID);
      if (storedByRemi) {
        // A record of another harness answers to its remi id too, whatever its Claude column holds.
        if (!isClaudeRecord(storedByRemi)) {
          return {
            ok: false,
            error: 'That session ran under another harness and cannot be resumed from here.',
          };
        }
        claudeSessionId = storedByRemi.claudeSessionId;
        projectPath = storedByRemi.projectPath;
      }

      if (!claudeSessionId) {
        // Several exited rows of one Claude session resolve to the newest: every resume adds one.
        const storedByClaude = bindingStore.getResumableByClaudeSessionId(targetSessionId);
        if (storedByClaude) {
          claudeSessionId = storedByClaude.claudeSessionId;
          projectPath = storedByClaude.projectPath;
        }
      }

      if (!claudeSessionId) {
        const transcriptPath = transcriptDiscovery.findTranscriptBySessionId(targetSessionId);
        if (transcriptPath) {
          claudeSessionId = targetSessionId;
          // The transcript names the directory it was recorded in; the project folder's name is a
          // lossy encoding of it (every `/` became `-`), the fallback for an old transcript.
          projectPath =
            transcriptDiscovery.readTranscriptCwd(transcriptPath) ??
            path.basename(path.dirname(transcriptPath)).replace(/-/g, '/');
        }
      }
    } catch (error) {
      // An ambiguity message is written to be printed (a short id, a count). Any other failure can
      // hold a path or a lock holder, which is the host's business: the log has it.
      logError(`[Resume] Cannot resolve ${shown}: ${escapeUnsafeText(errorToString(error))}`);
      return {
        ok: false,
        error:
          error instanceof AmbiguousSessionIdentityError
            ? `Cannot resolve session ${shown}: ${error.message}`
            : `Cannot resolve session ${shown}: the host's session records could not be read.`,
      };
    }

    if (!claudeSessionId) {
      return {
        ok: false,
        error: `Session ${shown} not found. No Claude session ID available for resume.`,
      };
    }

    if (!projectPath) {
      return { ok: false, error: 'Cannot resume: original project path is unknown.' };
    }

    const dirResult = resolveDirectory(projectPath);
    if ('error' in dirResult) {
      const hint = projectPath.includes('/')
        ? ' Path may be inaccurate for projects with dashes in their name.'
        : '';
      return { ok: false, error: `Project directory not found: ${projectPath}.${hint}` };
    }
    return { ok: true, claudeSessionId, workingDirectory: dirResult.resolved };
  }

  /** Session ids resumed through this hub lately: Claude id -> when the hold ends (ms). */
  const resuming = new Map<string, number>();

  /**
   * A resume through the hub (#1129): start a child session daemon with `--resume` in the stored
   * directory and answer with its port. Nothing is attached and no ack is sent: the session is in
   * another process. The child start goes through the create-session checks, so the remote-argument
   * allowlist and the "a live remi session already holds that Claude session" refusal apply to a
   * resume exactly as they do to a create request that names `--resume`.
   */
  async function resumeThroughHub(
    connectionId: UUID,
    targetSessionId: string,
    requestId: UUID,
    startChild: StartChildSession,
  ): Promise<void> {
    const target = resolveResumeTarget(targetSessionId);
    if (!target.ok) {
      send(connectionId, createResumeSessionResponse(false, requestId, undefined, target.error));
      return;
    }
    if (!UUID_SHAPE.test(target.claudeSessionId)) {
      // The stored id is not one `--resume` takes; the child start would refuse it with words about
      // arguments, which mean nothing to the person.
      logError(
        `[Resume] The stored Claude session id is not a UUID: ${escapeUnsafeText(target.claudeSessionId)}`,
      );
      send(
        connectionId,
        createResumeSessionResponse(
          false,
          requestId,
          undefined,
          "That session's Claude id is not a valid session id, so it cannot be resumed.",
        ),
      );
      return;
    }
    const key = target.claudeSessionId.toLowerCase();
    for (const [id, until] of resuming) if (until <= now()) resuming.delete(id);
    if (resuming.has(key)) {
      log(`Refusing a second resume of ${key}: one is in flight or just finished`);
      send(
        connectionId,
        createResumeSessionResponse(false, requestId, undefined, JUST_RESUMED_TEXT),
      );
      return;
    }
    // Held for the whole start, so a request that arrives while it runs is refused, and then for a
    // short while after a success. A failed start frees the session at once.
    resuming.set(key, Number.POSITIVE_INFINITY);
    log(
      `Resuming Claude session ${target.claudeSessionId} through a child daemon in ${escapeUnsafeText(target.workingDirectory)}`,
    );
    let outcome: Awaited<ReturnType<StartChildSession>> = {
      ok: false,
      error: CHILD_START_FAILED_TEXT,
    };
    try {
      outcome = await startChild(target.workingDirectory, {
        args: harness.resumeArgs(target.claudeSessionId),
      });
    } catch (error) {
      // `startSession` does not throw; a caller that does is answered the way it would have been.
      logError(
        `[Resume] Failed to start a child daemon: ${escapeUnsafeText(errorToString(error))}`,
      );
    } finally {
      if (outcome.ok) resuming.set(key, now() + RESUME_HOLD_MS);
      else resuming.delete(key);
    }
    if (!outcome.ok) {
      send(connectionId, createResumeSessionResponse(false, requestId, undefined, outcome.error));
      return;
    }
    send(
      connectionId,
      createResumeSessionResponse(
        true,
        requestId,
        outcome.sessionId,
        undefined,
        undefined,
        outcome.port,
      ),
    );
    log(
      `Session ${outcome.sessionId} resumed through a child daemon on port ${outcome.port} (claude: ${target.claudeSessionId})`,
    );
  }

  return {
    onResumeSessionRequest: async (
      connectionId: UUID,
      targetSessionId: string,
      requestId: UUID,
    ): Promise<void> => {
      // The envelope is validated, the payload is not: the id can be missing, null or an array.
      if (typeof (targetSessionId as unknown) !== 'string') {
        log(`Resume session request from ${connectionId} names no session; refused`);
        send(
          connectionId,
          createResumeSessionResponse(false, requestId, undefined, NO_SESSION_NAMED_TEXT),
        );
        return;
      }
      // The id came off the wire: written out, so a control character in it cannot act on a
      // terminal that reads the log.
      log(`Resume session request from ${connectionId} for session ${shownId(targetSessionId)}`);

      // A daemon that hosts another harness has no Claude session to resume or attach a Claude
      // resume to (#1179): refused with the hub's code, before any path below runs.
      if (harnessId !== 'claude') {
        log(`Refusing resume: this daemon hosts ${harnessId}, not Claude`);
        send(
          connectionId,
          createResumeSessionResponse(
            false,
            requestId,
            undefined,
            harnessResumeUnsupportedMessage(harnessId),
            RESUME_UNSUPPORTED_CODE,
          ),
        );
        return;
      }

      // The hub never runs Claude (#1124): it starts a child session daemon that does (#1129).
      if (childSessions !== null) {
        await resumeThroughHub(connectionId, targetSessionId, requestId, childSessions);
        return;
      }

      // Path 1: target matches the live session, try to attach.
      const existingSession = sessionRegistry.getSession(targetSessionId as UUID);
      if (existingSession) {
        const result = sessionRegistry.attachConnection(targetSessionId as UUID, connectionId);
        if (result.success) {
          send(connectionId, createResumeSessionResponse(true, requestId, targetSessionId as UUID));
          send(
            connectionId,
            createHelloAck('1.0.0', targetSessionId as UUID, {
              resumeInfo: {
                isResume: true,
                replayCount: result.replayMessages.length,
                nextBulletId: result.nextBulletId,
              },
              harnesses: harnesses(),
              capabilities,
            }),
          );
          if (result.replayMessages.length > 0) {
            send(
              connectionId,
              createReplayBatch(targetSessionId as UUID, result.replayMessages, true),
            );
          }
          // #753 (#760 review finding 2): this attach surface needs the same
          // live re-send as the hello attach path, or a session switched-to
          // mid-held-question shows nothing.
          const resent = resendPendingQuestions(
            (m) => send(connectionId, m),
            targetSessionId as UUID,
            result.currentQuestions,
          );
          if (resent > 0) {
            log(`Re-sent ${resent} pending question(s) to resumed connection ${connectionId}`);
          }
          log(`Session ${targetSessionId} still alive; attached connection`);
          return;
        }
        send(connectionId, createResumeSessionResponse(false, requestId, undefined, result.error));
        return;
      }

      // No live session for that id. One session per daemon: if this daemon
      // already has a DIFFERENT active session, we can't spawn another here.
      if (sessionRegistry.activeSession !== null) {
        send(
          connectionId,
          createResumeSessionResponse(
            false,
            requestId,
            undefined,
            "This daemon already has an active session. Use 'remi new' to start a new daemon for resume.",
          ),
        );
        return;
      }

      // Path 2: transcript-based resume. Resolve a Claude session id + project path.
      const target = resolveResumeTarget(targetSessionId);
      if (!target.ok) {
        send(connectionId, createResumeSessionResponse(false, requestId, undefined, target.error));
        return;
      }
      const { claudeSessionId, workingDirectory } = target;

      const newSessionId = sessionRegistry.createSessionId();
      log(
        `Resuming Claude session ${claudeSessionId} as new Remi session ${newSessionId} in ${workingDirectory}`,
      );

      try {
        await createNewSession(
          newSessionId,
          workingDirectory,
          (sid, msg) => {
            // #795: fan out to every attached connection, not a single
            // exclusive one. In practice this window is before `connectionId`
            // has attached below, so this is normally a no-op either way.
            const session = sessionRegistry.getSession(sid);
            if (!session) return;
            for (const connId of session.attachedConnections) {
              send(connId, msg);
            }
          },
          harness.resumeArgs(claudeSessionId),
        );

        const result = sessionRegistry.attachConnection(newSessionId, connectionId);

        if (result.success) {
          send(connectionId, createResumeSessionResponse(true, requestId, newSessionId));
          send(
            connectionId,
            createHelloAck('1.0.0', newSessionId, {
              resumeInfo: { isResume: false, replayCount: 0, nextBulletId: 1 },
              harnesses: harnesses(),
              capabilities,
            }),
          );
          log(`Session ${newSessionId} created via resume (claude: ${claudeSessionId})`);
        } else {
          sessionRegistry.closeSession(newSessionId, 'forced');
          send(
            connectionId,
            createResumeSessionResponse(false, requestId, undefined, result.error),
          );
        }
      } catch (error) {
        const msg = errorToString(error);
        logError('Failed to resume session:', msg);
        sessionRegistry.closeSession(newSessionId, 'forced');
        send(connectionId, createResumeSessionResponse(false, requestId, undefined, msg));
      }
    },
  };
}
