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
 * Hub mode (`remi serve`, #1124): the hub is a session-less supervisor and
 * must never run Claude itself, but both transports (`server/connection.ts`,
 * `remote/relay-adapter.ts`) dispatch resume requests to this handler
 * unconditionally. With `hubMode` set, every request is refused up front
 * with `errorCode: 'UNSUPPORTED'` and none of the three paths above runs.
 * Resuming through the hub by spawning a child session daemon is tracked in
 * #1129; it needs two things that do not exist yet (a session daemon that
 * honors Claude args, and a web resume flow that can follow a session on
 * another port).
 */

import * as path from 'node:path';
import {
  createHelloAck,
  createReplayBatch,
  createResumeSessionResponse,
  errorToString,
} from '@remi/shared';
import type { HarnessId, ProtocolMessage, UUID } from '@remi/shared';

import type { Harness } from '../../harness/types.ts';
import type { SessionBindingStore, SessionRegistry, SessionStore } from '../../session/index.ts';
import type { TranscriptDiscovery } from '../../transcript/index.ts';
import { log, logError } from '../logger.ts';
import { resolveDirectory } from '../path-resolver.ts';
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

/** Canonical 8-4-4-4-12 hex UUID shape; anything else is never echoed back. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Why a hub refuses resume. Names the one way that works today so the phone
 * user is not left at a dead end. The hub only answers; it never starts
 * Claude (#1124, follow-up #1129).
 *
 * The requested id is echoed into the command only when it is UUID-shaped;
 * anything else (the id is client-supplied) gets the generic `<session>`
 * placeholder, so the refusal can never reflect arbitrary input.
 */
export function hubResumeUnsupportedMessage(requestedSessionId: string): string {
  const session = UUID_SHAPE.test(requestedSessionId) ? requestedSessionId : '<session>';
  return `Resuming a session through the hub is not supported yet. Run 'remi --resume ${session}' from a terminal on the host machine.`;
}

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
export const HUB_RESUME_UNSUPPORTED_CODE = 'UNSUPPORTED';

export interface ResumeSessionHandlerDeps {
  /**
   * True when this process is the session-less hub (`remi serve`). The hub
   * must never run Claude, so resume is refused instead of calling
   * `createNewSession` (#1124). `false` (session daemon, wrapper) keeps the
   * resume behavior exactly as before. Deliberately required with no default:
   * a new composition root that forgets it fails to compile instead of
   * failing open into running Claude in a hub.
   */
  hubMode: boolean;
  /**
   * The harness this daemon hosts. Anything but Claude refuses resume (#1179). Required with no
   * default, like `hubMode`: a composition root that forgets it fails to compile instead of
   * failing open into `claude --resume` inside a Codex daemon.
   */
  harnessId: HarnessId;
  /**
   * The harnesses this daemon can start, named on the acks this handler sends so
   * that every hello_ack carries them (#1179).
   */
  harnesses: () => readonly HarnessId[];
  sessionRegistry: SessionRegistry;
  /** Full-record reads that also need projectPath (resume seed by remi id). */
  sessionStore: SessionStore;
  /** Binding-only reverse lookup (resolve by claude session id) — routed through
   *  the accessor so it cannot diverge from the other resume resolver. */
  bindingStore: SessionBindingStore;
  transcriptDiscovery: TranscriptDiscovery;
  /** Builds the launch arguments that resume a stored session (`resumeArgs`). */
  harness: Pick<Harness, 'resumeArgs'>;
  createNewSession: CreateNewSessionFn;
  send: SendToConnection;
}

export type ResumeSessionHandlers = ReturnType<typeof createResumeSessionHandlers>;

export function createResumeSessionHandlers(deps: ResumeSessionHandlerDeps) {
  const {
    hubMode,
    harnessId,
    harnesses,
    sessionRegistry,
    sessionStore,
    bindingStore,
    transcriptDiscovery,
    harness,
    createNewSession,
    send,
  } = deps;

  return {
    onResumeSessionRequest: async (
      connectionId: UUID,
      targetSessionId: string,
      requestId: UUID,
    ): Promise<void> => {
      log(`Resume session request from ${connectionId} for session ${targetSessionId}`);

      // The hub never runs Claude (#1124). Answered with a resume response (not
      // a bare `error` frame) because that is the only reply the web client
      // uses to clear its "resuming" spinner and show the reason in chat.
      if (hubMode) {
        log('Refusing resume: hub mode never starts Claude');
        send(
          connectionId,
          createResumeSessionResponse(
            false,
            requestId,
            undefined,
            hubResumeUnsupportedMessage(targetSessionId),
            HUB_RESUME_UNSUPPORTED_CODE,
          ),
        );
        return;
      }

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
            HUB_RESUME_UNSUPPORTED_CODE,
          ),
        );
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
      let claudeSessionId: string | null = null;
      let projectPath: string | null = null;

      try {
        const storedByRemi = sessionStore.findByRemiSessionId(targetSessionId as UUID);
        if (storedByRemi) {
          claudeSessionId = storedByRemi.claudeSessionId;
          projectPath = storedByRemi.projectPath;
        }

        if (!claudeSessionId) {
          const storedByClaude = bindingStore.getByClaudeSessionId(targetSessionId);
          if (storedByClaude) {
            claudeSessionId = storedByClaude.claudeSessionId;
            projectPath = storedByClaude.projectPath;
          }
        }

        if (!claudeSessionId) {
          const transcriptPath = transcriptDiscovery.findTranscriptBySessionId(targetSessionId);
          if (transcriptPath) {
            claudeSessionId = targetSessionId;
            const dirName = path.basename(path.dirname(transcriptPath));
            projectPath = dirName.replace(/-/g, '/');
          }
        }
      } catch (error) {
        const msg = `Cannot resolve session ${targetSessionId}: ${errorToString(error)}`;
        logError(`[Resume] ${msg}`);
        send(connectionId, createResumeSessionResponse(false, requestId, undefined, msg));
        return;
      }

      if (!claudeSessionId) {
        send(
          connectionId,
          createResumeSessionResponse(
            false,
            requestId,
            undefined,
            `Session ${targetSessionId} not found. No Claude session ID available for resume.`,
          ),
        );
        return;
      }

      if (!projectPath) {
        send(
          connectionId,
          createResumeSessionResponse(
            false,
            requestId,
            undefined,
            'Cannot resume: original project path is unknown.',
          ),
        );
        return;
      }

      const dirResult = resolveDirectory(projectPath);
      if ('error' in dirResult) {
        const hint = projectPath.includes('/')
          ? ' Path may be inaccurate for projects with dashes in their name.'
          : '';
        send(
          connectionId,
          createResumeSessionResponse(
            false,
            requestId,
            undefined,
            `Project directory not found: ${projectPath}.${hint}`,
          ),
        );
        return;
      }
      const workingDirectory = dirResult.resolved;

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
