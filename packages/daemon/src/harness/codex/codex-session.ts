/**
 * The Codex launch behind the harness seam (epic #1175; phase 3 #1177 launched
 * it and reported its status, phase 4 #1178 added the approvals): it spawns
 * `codex --no-alt-screen <validated arguments>` in a PTY, learns which thread of
 * the shared app-server is the session's, reports that thread's status, and
 * shows the thread's approval requests as phone cards (`CodexDecisions`). No
 * turn push and no wire identity field exists yet (phases 5 and 6).
 *
 * remi RELAYS an approval; Codex decides. Nothing is ever typed into the PTY for an
 * answer: a phone answer goes to the app-server as the request's result, and
 * chat text typed from a client (the phone, Telegram, the relay) is refused with
 * `PROMPT_WAITING` (`acceptsTypedChat: false`), because the TUI cannot be read and
 * a typed message and its Enter could land on a modal. The child's stdin sees only
 * what is typed at the terminal and raw input (an attach client's keystrokes, the
 * Escape button, `/interrupt`), which the client marks `raw` and the daemon cannot
 * tell from a script.
 *
 * Order of the state-changing steps (`createCodexSession`):
 * 1. `validateCodexArgs`: a refusal exits 2. (The working directory must also exist
 *    and be searchable, after the gate: exit 1.)
 * 2. The older-daemon gate (`deps.legacyWriters`, `findLegacyWriters`): a live
 *    process older than the identity shim would erase `harness` and
 *    `harnessSessionId` the next time it writes `sessions.json`, so while one
 *    exists the launch refuses (exit 1) BEFORE any non-Claude record is written.
 *    The gate narrows that hazard, it does not close it: an older binary started
 *    AFTER this launch (any `remi --sessions`, `--resume`, wrapper start or a
 *    LaunchAgent hub restarting on an old binary) can still rewrite the file,
 *    and one registered nowhere is never seen. The launch says so
 *    (`olderRemiNotice`). `findLegacyWriters` is not read-only: its
 *    `listLive()` deletes live-sessions entries whose pid is dead or whose JSON
 *    is invalid.
 * 3. `preAssign` of `{harness: 'codex', claudeSessionId: null, harnessSessionId:
 *    <thread id or null>}`.
 * 4. The PTY, then the app-server client. The PTY goes first because the TUI
 *    starts the shared daemon.
 *
 * remi NEVER starts, stops, restarts or upgrades the shared Codex daemon: it is
 * shared with the user's other Codex windows. The client polls the socket with
 * backoff; if no connection is ready 30 s after the spawn (or after a drop that
 * stays), one log line and one system message say so, and the session carries on
 * as a plain terminal session. The message is a system-sender message that some
 * clients, the web client today, do not show.
 */

import { escapeUnsafeText, generateId, now } from '@remi/shared';
import type { AgentStatus, Message, UUID } from '@remi/shared';

import {
  type PtyOutputSink,
  createPtySessionForSession,
} from '../../cli/session-phases/pty-session-setup.ts';
import { IDENTITY_SHIM_MIN_VERSION } from '../../session/legacy-writers.ts';
import type { LegacyWriter } from '../../session/legacy-writers.ts';
import type { SessionBindingStore } from '../../session/session-binding-store.ts';
import type { SessionRegistryFile } from '../../session/session-registry-file.ts';
import type { SessionRegistry } from '../../session/session-registry.ts';
import {
  AmbiguousSessionIdentityError,
  type SessionStore,
  isClaudeRecord,
} from '../../session/session-store.ts';
import { shellQuote } from '../../session/shell-quote.ts';
import type { HarnessLaunchContext, HarnessSession } from '../types.ts';
import { AppServerClient, type AppServerClientOptions } from './app-server-client.ts';
import { parseResolved } from './approval-cards.ts';
import { localAttachCommand } from './attach-hint.ts';
import { resolveCodexWorkingDirectory, validateCodexArgs } from './codex-args.ts';
import { CodexDecisions, type CodexDecisionsDeps } from './codex-decisions.ts';
import { UntrustedSocketError, resolveCodexSocketPath } from './codex-socket.ts';
import { TERMINAL, type TerminalWords, attachWords } from './terminal-words.ts';
import type { ThreadStatus } from './thread-protocol.ts';
import { ThreadClaimedError, ThreadTracker, type ThreadTrackerDeps } from './thread-tracker.ts';

export interface CodexLaunchDeps {
  sessionRegistry: SessionRegistry;
  sessionStore: SessionStore;
  bindingStore: SessionBindingStore;
  liveSessionsRegistry: SessionRegistryFile;
  currentPort: () => number;
  wsPort: () => number;
  cleanup: () => Promise<void>;
  /** `CODEX_HOME` (where the app-server's control socket is) comes from here. */
  env: () => Readonly<Record<string, string | undefined>>;
  /** The older-daemon gate (`findLegacyWriters`), read before any non-Claude record is written. */
  legacyWriters: () => LegacyWriter[];
  /** remi's own version, sent as the app-server client's version. */
  remiVersion: string;
  /**
   * A card stopped being pending without a phone answer (the TUI answered, the replay did not
   * bring it back): broadcast `question_resolved` and clear its lock-screen push.
   */
  onQuestionResolved: (sid: UUID, qid: UUID, reason: 'answered' | 'cancelled') => void;
  log: (message: string) => void;
  /**
   * Test seams (production leaves them out): the client's reconnect backoff and keepalive, the 30 s link
   * watchdog, the tracker's attach retry period and ambiguity window, and the approval cards'
   * replay window and link grace.
   */
  appServer?: Pick<AppServerClientOptions, 'backoff' | 'keepalive'>;
  linkWatchdogMs?: number;
  linkStableMs?: number;
  /** How soon after the spawn an exit still logs what Codex printed (default 10 s). */
  startupFailureWindowMs?: number;
  tracker?: Pick<ThreadTrackerDeps, 'retryMs' | 'ambiguityMs' | 'noIdentityMs'>;
  decisions?: Pick<CodexDecisionsDeps, 'replayWindowMs' | 'disconnectGraceMs' | 'confirmMs'>;
}

/** A launch remi refuses, with the exit code `cli.ts` ends with (2 for arguments, 1 otherwise). */
export class CodexLaunchRefusal extends Error {
  constructor(
    message: string,
    readonly exitCode: 1 | 2,
  ) {
    super(message);
    this.name = 'CodexLaunchRefusal';
  }
}

export type CodexPreflight =
  | { ok: true; args: string[]; resumeThreadId: string | null; directory: string }
  | { ok: false; exitCode: 1 | 2; message: string };

/**
 * The message and exit code of an error a Codex launch may end in, or null for any other.
 * `cli.ts` prints it on the real stderr (a wrapper's console goes to the log, so a refusal
 * after boot would otherwise leave no trace on screen) and exits with the code.
 */
export function codexLaunchRefusal(error: unknown): { message: string; exitCode: 1 | 2 } | null {
  if (error instanceof CodexLaunchRefusal) {
    return { message: error.message, exitCode: error.exitCode };
  }
  // The store refuses to choose between two records of one thread (a race between two resumes,
  // or a store that already holds the thread twice).
  if (error instanceof AmbiguousSessionIdentityError)
    return { message: error.message, exitCode: 1 };
  return null;
}

/**
 * The command that resumes a Codex session from `remi --sessions`. `remi codex resume` runs
 * Codex in the current directory and the new record takes that directory as its project path,
 * so the line changes into the session's own first; the path and the id are each quoted as
 * one shell word, so pasting the line cannot run anything else (a thread id is a UUID by
 * the time it is stored, but it is printed from a file, so it is quoted anyway).
 */
export function codexResumeCommand(projectPath: string, threadId: string): string {
  return `cd ${shellQuote(projectPath)} && remi codex resume ${shellQuote(threadId)}`;
}

/** What the launch prints so nobody learns the hazard from a lost session id (see the file header). */
export function olderRemiNotice(): string {
  return `remi codex: the Codex thread id is saved in sessions.json, and a remi older than ${IDENTITY_SHIM_MIN_VERSION} that writes that file later (remi --sessions, remi --resume, a restarted hub on an old binary) erases it, so \`remi codex resume\` could no longer find this session.`;
}

/** The message of the older-daemon refusal: each writer with its file and pid identity, the minimum version, the fix. */
export function legacyWriterRefusal(writers: readonly LegacyWriter[]): string {
  const lines = writers.map((w) => {
    const version = w.version === undefined ? 'no version recorded' : `version ${w.version}`;
    const file = w.file ?? 'an entry remi cannot name';
    return w.pidIdentity === 'verified'
      ? `  pid ${w.pid} (${w.source}, ${version}), recorded in ${file}`
      : `  pid ${w.pid} (${w.source}, ${version}), recorded in ${file}: unverified, so if that process is no longer a remi, delete ${file}`;
  });
  return [
    'remi codex will not start: an older remi is running, and it would erase the Codex session id from sessions.json the next time it writes that file.',
    ...lines,
    `Run \`remi stop --all\` for the live ones (it also ends interactive remi sessions), then start remi codex again. The first version that keeps the id is ${IDENTITY_SHIM_MIN_VERSION}; a version that does not parse, such as a PR-stamped build, counts as older.`,
  ].join('\n');
}

/**
 * The refusal for a resume of a thread a live remi session already holds, or null. Only an ACTIVE
 * holder matters: the purge in `list()` has already turned a dead process's record into history, and
 * the store refuses two active holders. A lookup that read the exited rows too would see the several
 * rows of one thread that every second resume leaves as an ambiguity, and refuse the third resume
 * until the purge. Used by the launch (`checkCodexLaunch`) and by the hub before it spawns a child for a
 * `resume` (#1179, H2), so the two say the same thing: the child's refusal reached a remote client
 * only as "Daemon process exited unexpectedly".
 */
export function heldThreadRefusal(sessionStore: SessionStore, threadId: string): string | null {
  const held = findHeldThread(sessionStore, threadId);
  if (held === null) return null;
  if (held.kind === 'ambiguous') return held.message;
  // For the person at the machine, with an address that can be pasted into a shell (P9).
  return `Codex thread ${threadId} is already open in remi session ${held.remiSessionId.slice(0, 8)} (port ${held.port}); attach to it with \`${localAttachCommand(held.port, held.remiSessionId)}\` or close it first.`;
}

/** Who holds a thread: a live session, or a store that cannot say (it holds two active records of it). */
export type HeldThread =
  | { readonly kind: 'held'; readonly remiSessionId: string; readonly port: number }
  | { readonly kind: 'ambiguous'; readonly message: string };

/**
 * The live session that holds `threadId`, or null. `heldThreadRefusal` words it for the person
 * at the machine; the hub reads the holder to put it in its own log and tells the client less
 * (#1204 round 2, P4).
 */
export function findHeldThread(sessionStore: SessionStore, threadId: string): HeldThread | null {
  try {
    const owner = sessionStore
      .list()
      .find((s) => s.harness === 'codex' && s.harnessSessionId === threadId && s.exitedAt === null);
    if (owner === undefined) return null;
    return { kind: 'held', remiSessionId: owner.remiSessionId, port: owner.port };
  } catch (error) {
    if (!(error instanceof AmbiguousSessionIdentityError)) throw error;
    return { kind: 'ambiguous', message: error.message };
  }
}

/**
 * Steps 1 and 2 of the launch, the working directory, and for a resume a check
 * that no live remi session already holds the thread: arguments, then the
 * older-daemon gate, then the directory (which must exist and be searchable),
 * with nothing written before any of them passes (the store is purged only
 * after the gate). `directory` in the result is the working directory as
 * `realpath` resolves it, the one identity matching compares against.
 */
export function checkCodexLaunch(
  deps: Pick<CodexLaunchDeps, 'legacyWriters' | 'sessionStore'>,
  userArgs: readonly string[],
  workingDirectory: string,
): CodexPreflight {
  const parsed = validateCodexArgs(userArgs);
  if (!parsed.ok) return { ok: false, exitCode: 2, message: parsed.error };
  const writers = deps.legacyWriters();
  if (writers.length > 0) return { ok: false, exitCode: 1, message: legacyWriterRefusal(writers) };
  const cwd = resolveCodexWorkingDirectory(workingDirectory);
  if (!cwd.ok) return { ok: false, exitCode: 1, message: cwd.error };
  const threadId = parsed.resumeThreadId;
  if (threadId !== null) {
    const held = heldThreadRefusal(deps.sessionStore, threadId);
    if (held !== null) return { ok: false, exitCode: 1, message: held };
  }
  return { ok: true, args: parsed.args, resumeThreadId: threadId, directory: cwd.directory };
}

/**
 * Said at EVERY rotation (a `/new` in the TUI, or a plain codex window in the same directory that
 * looks like one): the session keeps its approval authority across the move, so the person is
 * told, each time, that approvals now come from the new thread. It is not a security boundary
 * (same user, same machine); it is only never silent.
 */
const ROTATION_MESSAGE = 'remi now follows a new Codex thread; approvals come from it';

/** What the link notices say of the session itself: it works in the terminal, or `remi attach` shows it. */
const linkUnavailableMessage = (words: TerminalWords): string =>
  `remi cannot reach the shared Codex app-server, so its status here is not updating; ${words.works}.`;
/** Said instead when the socket was found but refused: the cause is a fixable permission. */
const linkUntrustedMessage = (words: TerminalWords): string =>
  `remi will not connect to the shared Codex app-server: its control directory is not private (the remi log says which); ${words.works}.`;
/** How long after its start a session with no thread may still be the one a new thread is for. */
const FIRST_THREAD_WINDOW_MS = 60_000;
const DEFAULT_LINK_WATCHDOG_MS = 30_000;
/** A link counts as up, and the watchdog is canceled, once it has stayed up this long (the client's own `stableMs`). */
const DEFAULT_LINK_STABLE_MS = 5_000;
/** What Codex printed before the session named a thread: kept up to this many characters, and logged only if it exits within the window. */
const STARTUP_OUTPUT_CHARS = 2048;
const DEFAULT_STARTUP_FAILURE_WINDOW_MS = 10_000;

/** The session's status from its thread and its descendants: waiting beats thinking beats idle. */
function aggregateStatus(statuses: Iterable<ThreadStatus>): AgentStatus {
  let busy = false;
  for (const status of statuses) {
    if (status.type !== 'active') continue;
    if (status.activeFlags.length > 0) return 'waiting';
    busy = true;
  }
  return busy ? 'thinking' : 'idle';
}

export function createCodexSession(
  deps: CodexLaunchDeps,
  ctx: HarnessLaunchContext,
): HarnessSession {
  const { sessionId, workingDirectory, messageApi } = ctx;
  const log = (message: string): void => deps.log(`[Codex] ${message}`);
  // Where the person looks and answers (G12): the terminal of a wrapper session; for one a hub or
  // `remi codex --daemon` runs there is none, and `remi attach` names this session. Read when a
  // message is made, since the port settles after the session is built.
  const words = (): TerminalWords =>
    ctx.passThrough ? TERMINAL : attachWords(deps.wsPort(), sessionId);

  const checked = checkCodexLaunch(deps, ctx.extraArgs, workingDirectory);
  if (!checked.ok) throw new CodexLaunchRefusal(checked.message, checked.exitCode);
  const cwd = { directory: checked.directory };

  try {
    deps.bindingStore.preAssign({
      remiSessionId: sessionId,
      claudeSessionId: null,
      harness: 'codex',
      harnessSessionId: checked.resumeThreadId,
      projectPath: workingDirectory,
      port: deps.currentPort(),
      pid: process.pid,
      startedAt: new Date().toISOString(),
      exitedAt: null,
      exitCode: null,
    });
  } catch (error) {
    // Another session took the thread between the check above and this write: a refusal,
    // not a crash.
    const refusal = codexLaunchRefusal(error);
    if (refusal) throw new CodexLaunchRefusal(refusal.message, refusal.exitCode);
    throw error;
  }

  // The statuses of the tracked thread and its descendants, and the one the session last reported.
  const statuses = new Map<string, ThreadStatus>();
  let reported: AgentStatus | null = null;
  const publish = (): void => {
    const next = aggregateStatus(statuses.values());
    if (next === reported) return;
    reported = next;
    try {
      messageApi.handleStatusChange(next);
    } catch (error) {
      log(`could not report the status (${error instanceof Error ? error.name : typeof error})`);
    }
  };

  // The tracked thread's id, as far as this session knows it (a resume names it up front).
  let trackedId: string | null = checked.resumeThreadId;
  // What Codex printed before this session bound a thread, kept (bounded) for the one log line a
  // startup failure gets: LV-4 saw Codex exit 2 on a flag error, and its message went nowhere. It
  // is dropped when a thread is bound, logged only to the daemon log (escaped, on one line), and
  // never sent to a client.
  let startupOutput = '';
  let identified = false;
  let spawnedAtMs: number | null = null;
  const startupSink: PtyOutputSink = {
    process: (text) => {
      if (identified || startupOutput.length >= STARTUP_OUTPUT_CHARS) return;
      startupOutput += text.slice(0, STARTUP_OUTPUT_CHARS - startupOutput.length);
    },
    // Runs when the PTY exits.
    flush: () => {
      const output = startupOutput;
      startupOutput = '';
      if (identified || output === '' || spawnedAtMs === null) return;
      const elapsedMs = Date.now() - spawnedAtMs;
      if (elapsedMs > (deps.startupFailureWindowMs ?? DEFAULT_STARTUP_FAILURE_WINDOW_MS)) return;
      log(
        `exited with code ${pty.processExitCode} ${elapsedMs} ms after it started, before it named a thread; its first output (escaped, at most ${STARTUP_OUTPUT_CHARS} characters): ${escapeUnsafeText(output).replaceAll('\n', '\\n')}`,
      );
    },
  };
  /** Forget what the subagents were doing: the link that told us is gone, or the thread is. */
  const dropDescendantStatuses = (): void => {
    let dropped = false;
    for (const id of [...statuses.keys()]) {
      if (id !== trackedId) dropped = statuses.delete(id) || dropped;
    }
    // Nothing dropped, nothing to say: a first `ready` must not turn "unknown" into "idle".
    if (dropped) publish();
  };

  // The tracker needs the client and the client's events need the tracker, so the events
  // reach it through this holder (nothing arrives before `client.start()`).
  const link: { tracker?: ThreadTracker } = {};
  // Set first by dispose(): stopping the client reports a drop, which must not re-arm the watchdog.
  let disposed = false;
  /** Why the last attempt to find the socket failed, to word the watchdog's notice. */
  let socketError: unknown;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let stableTimer: ReturnType<typeof setTimeout> | undefined;
  let warned = false;
  const cancelWatchdog = (): void => {
    clearTimeout(watchdog);
    watchdog = undefined;
  };
  /** A system-sender message to the clients; a failure to send it is logged, never thrown. */
  const sendSystemMessage = (content: string): void => {
    const stamp = now();
    const message: Message = {
      id: generateId(),
      sessionId,
      sender: 'system',
      content,
      createdAt: stamp,
      state: 'sent',
      stateChangedAt: stamp,
      isEditing: false,
    };
    try {
      messageApi.handleMessage(message);
    } catch (error) {
      log(`could not send the notice (${error instanceof Error ? error.name : typeof error})`);
    }
  };
  const armWatchdog = (): void => {
    if (warned || watchdog !== undefined) return;
    watchdog = setTimeout(() => {
      warned = true;
      log(
        'the shared app-server is not reachable; the session continues as a plain terminal session',
      );
      sendSystemMessage(
        socketError instanceof UntrustedSocketError
          ? linkUntrustedMessage(words())
          : linkUnavailableMessage(words()),
      );
    }, deps.linkWatchdogMs ?? DEFAULT_LINK_WATCHDOG_MS);
  };

  const client = new AppServerClient(
    {
      socketPath: () => {
        try {
          const found = resolveCodexSocketPath(deps.env());
          socketError = undefined;
          return found;
        } catch (error) {
          socketError = error;
          throw error;
        }
      },
      clientInfo: { name: 'remi', title: null, version: deps.remiVersion },
      log,
      ...deps.appServer,
    },
    (event) => {
      if (disposed) return;
      if (event.type === 'ready') {
        dropDescendantStatuses();
        // A link that accepts and drops within a few seconds is not up: only one that stays up
        // for linkStableMs cancels the watchdog, so a flapping link still gets its notice.
        clearTimeout(stableTimer);
        stableTimer = setTimeout(cancelWatchdog, deps.linkStableMs ?? DEFAULT_LINK_STABLE_MS);
        const version = /^[^\s/]+\/(\d[^\s]*)/.exec(event.userAgent)?.[1];
        if (version !== undefined) log(`app-server ${version}`);
        link.tracker?.handleReady();
      } else if (event.type === 'disconnected') {
        clearTimeout(stableTimer);
        dropDescendantStatuses();
        decisions.handleDisconnected();
        link.tracker?.handleDisconnected();
        armWatchdog();
      } else if (event.type === 'notification') {
        link.tracker?.handleNotification(event.method, event.params);
        if (event.method === 'serverRequest/resolved') {
          const resolved = parseResolved(event.params);
          if (resolved !== null) decisions.handleResolved(resolved);
        }
      } else if (event.type === 'serverRequest') {
        // Only `CodexDecisions` may answer one, and only a card's own option.
        decisions.handleServerRequest({ id: event.id, method: event.method, params: event.params });
      }
    },
  );
  const decisions = new CodexDecisions({
    sessionId,
    sessionDirectory: cwd.directory,
    client,
    sessionRegistry: deps.sessionRegistry,
    present: (question) => {
      messageApi.handleQuestion(question, { held: true });
    },
    onQuestionResolved: deps.onQuestionResolved,
    threadRole: (threadId) => link.tracker?.role(threadId) ?? null,
    log,
    notice: sendSystemMessage,
    terminal: words,
    ...deps.decisions,
  });
  // A card whose request is pending is not evicted by the pending-question cap.
  deps.sessionRegistry.setQuestionEvictionGuard(sessionId, (id) => decisions.isHeld(id));
  const tracker = new ThreadTracker({
    client,
    sessionCwd: cwd.directory,
    // Taken at construction: `start()` follows within milliseconds, and the tracker allows 5 s.
    spawnedAtMs: Date.now(),
    expectedThreadId: checked.resumeThreadId,
    // This session's own record is no special case: a thread it holds is the tracker's own, and the
    // tracker never takes a thread twice.
    claimedByOthers: () =>
      new Set(
        deps.sessionStore
          .list()
          .filter(
            (s) =>
              !isClaudeRecord(s) && s.exitedAt === null && typeof s.harnessSessionId === 'string',
          )
          .map((s) => s.harnessSessionId as string),
      ),
    // A new thread in this directory may be another live session's. A first bind is in the way of
    // a sibling that has no thread yet and is still inside its first-thread window; a rotation
    // is in the way of any sibling, bound or not, because a `/new` frame cannot be attributed.
    // The store's purge (in `list()`) has already dropped the dead.
    siblingInDirectory: (rotating) =>
      deps.sessionStore.list().some((s) => {
        if (isClaudeRecord(s) || s.exitedAt !== null || s.remiSessionId === sessionId) return false;
        const there = resolveCodexWorkingDirectory(s.projectPath);
        if (!(there.ok && there.directory === cwd.directory)) return false;
        if (rotating) return true;
        if (s.harnessSessionId !== undefined && s.harnessSessionId !== null) return false;
        // Fails closed: a start time that cannot be read counts as a start a moment ago.
        return !(Date.now() - Date.parse(s.startedAt) >= FIRST_THREAD_WINDOW_MS);
      }),
    notice: sendSystemMessage,
    terminal: words,
    onIdentity: (threadId) => {
      try {
        deps.bindingStore.updateHarnessIdentity(sessionId, 'codex', threadId);
      } catch (error) {
        if (error instanceof AmbiguousSessionIdentityError) {
          // Another session took THIS thread between the tracker's check and this write. A refusal
          // over some other thread's two holders is the store's trouble, not a claim on this one.
          if (error.identity === 'codex' && error.value === threadId) {
            throw new ThreadClaimedError(threadId);
          }
          log(`the store refused the write over another record: ${error.message}`);
        }
        throw error;
      }
      // What the old thread's descendants were doing says nothing about the new one. On a
      // rotation say so now, since a new thread whose frame carries no status would republish
      // nothing; a first identity has nothing stale to clear, and "unknown" is not "idle".
      const rotating = trackedId !== null;
      trackedId = threadId;
      identified = true;
      startupOutput = '';
      statuses.clear();
      if (rotating) {
        // The old thread's cards are not this session's any more, and must not be answered.
        decisions.forceRelease('the session moved to a new thread');
        sendSystemMessage(ROTATION_MESSAGE);
        publish();
      }
    },
    onStatus: (threadId, status) => {
      // Only an active thread counts, so only an active one is kept.
      if (status.type === 'active') statuses.set(threadId, status);
      else statuses.delete(threadId);
      publish();
    },
    onAttached: () => decisions.handleReattached(),
    log,
    ...deps.tracker,
  });
  link.tracker = tracker;

  const pty = createPtySessionForSession(
    {
      sessionRegistry: deps.sessionRegistry,
      sessionStore: deps.sessionStore,
      liveSessionsRegistry: deps.liveSessionsRegistry,
      outputSink: startupSink,
      wsPort: deps.wsPort(),
      sendMessage: ctx.sendMessage,
      cleanup: deps.cleanup,
    },
    {
      sessionId,
      workingDirectory,
      extraArgs: ['--no-alt-screen', ...checked.args],
      passThrough: ctx.passThrough,
      // Codex's inline mode manages its own scroll regions; the reserved status row was built for Claude's.
      reservedRows: 0,
      launch: { command: 'codex', childEnv: {} },
    },
  );

  return {
    pty,
    decisions,
    acceptsTypedChat: false,
    start: async () => {
      spawnedAtMs = Date.now();
      await pty.start();
      client.start();
      armWatchdog();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(stableTimer);
      cancelWatchdog();
      tracker.dispose();
      client.stop();
      decisions.dispose();
    },
  };
}
