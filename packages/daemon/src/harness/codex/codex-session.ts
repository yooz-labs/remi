/**
 * The Codex launch behind the harness seam (epic #1175, phase 3 #1177):
 * OBSERVE-ONLY. It spawns `codex --no-alt-screen <validated arguments>` in a PTY,
 * learns which thread of the shared app-server is the session's, and reports that
 * thread's status. No approval card, no answer, no chat, no turn push and no wire
 * field exists yet (phases 4 to 6); the session types nothing into the PTY on its
 * own, so the child's stdin sees only what a person types at the terminal or
 * sends as raw input.
 *
 * Order of the state-changing steps (`createCodexSession`):
 * 1. `validateCodexArgs`: a refusal exits 2.
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
 * backoff; if no connection is ready 30 s after the spawn (or after a drop), one
 * log line and one system message say so, and the session carries on as a plain
 * terminal session.
 */

import { generateId, now } from '@remi/shared';
import type { AgentStatus, Message } from '@remi/shared';

import {
  NOOP_OUTPUT_SINK,
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
import type { DecisionChannel, HarnessLaunchContext, HarnessSession } from '../types.ts';
import { AppServerClient, type AppServerClientOptions } from './app-server-client.ts';
import { resolveCodexWorkingDirectory, validateCodexArgs } from './codex-args.ts';
import { UntrustedSocketError, resolveCodexSocketPath } from './codex-socket.ts';
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
  log: (message: string) => void;
  /**
   * Test seams (production leaves them out): the client's reconnect backoff, the 30 s link
   * watchdog, and the tracker's attach retry period and ambiguity window.
   */
  appServer?: Pick<AppServerClientOptions, 'backoff'>;
  linkWatchdogMs?: number;
  linkStableMs?: number;
  tracker?: Pick<ThreadTrackerDeps, 'retryMs' | 'ambiguityMs' | 'noIdentityMs'>;
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
  | { ok: true; args: string[]; resumeThreadId: string | null }
  | { ok: false; exitCode: 1 | 2; message: string };

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
    `Run \`remi stop --all\` for the live ones, then start remi codex again. The first version that keeps the id is ${IDENTITY_SHIM_MIN_VERSION}.`,
  ].join('\n');
}

/**
 * Steps 1 and 2 of the launch, and for a resume a check that no live remi
 * session already holds the thread: arguments, then the older-daemon gate, with
 * nothing written before either passes (the store is purged only after the gate).
 */
export function checkCodexLaunch(
  deps: Pick<CodexLaunchDeps, 'legacyWriters' | 'sessionStore'>,
  userArgs: readonly string[],
): CodexPreflight {
  const parsed = validateCodexArgs(userArgs);
  if (!parsed.ok) return { ok: false, exitCode: 2, message: parsed.error };
  const writers = deps.legacyWriters();
  if (writers.length > 0) return { ok: false, exitCode: 1, message: legacyWriterRefusal(writers) };
  const threadId = parsed.resumeThreadId;
  if (threadId !== null) {
    try {
      // Only an ACTIVE holder matters (the purge in `list()` has already turned a dead
      // process's record into history, and the store refuses two active holders). Not
      // `findByHarnessSessionId`: it reads several exited rows of one thread, which every
      // second resume leaves, as an ambiguity and would refuse the third until the purge.
      const owner = deps.sessionStore
        .list()
        .find(
          (s) => s.harness === 'codex' && s.harnessSessionId === threadId && s.exitedAt === null,
        );
      if (owner !== undefined) {
        return {
          ok: false,
          exitCode: 1,
          message: `Codex thread ${threadId} is already open in remi session ${owner.remiSessionId.slice(0, 8)} (port ${owner.port}); attach to it with \`remi attach\` or close it first.`,
        };
      }
    } catch (error) {
      if (!(error instanceof AmbiguousSessionIdentityError)) throw error;
      return { ok: false, exitCode: 1, message: error.message };
    }
  }
  return { ok: true, args: parsed.args, resumeThreadId: threadId };
}

/**
 * Nothing is held and nothing is answerable (phase 3 shows no cards), which is
 * what the answer, chat and Stop handlers already read for a session with no
 * gate. Phase 4 replaces it with the real channel.
 */
const NO_DECISIONS: DecisionChannel = {
  answerHeld: () => 'unknown',
  retireQuestion: () => {},
  isHeld: () => false,
  hasMainHold: () => false,
  hasOpenHookPrompt: () => false,
  noteTerminalEscape: () => {},
  forceRelease: () => ({ resolved: 0 }),
};

const LINK_UNAVAILABLE_MESSAGE =
  'remi cannot reach the shared Codex app-server, so its status here is not updating; the session still works in the terminal.';
/** Said instead when the socket was found but refused: the cause is a fixable permission. */
const LINK_UNTRUSTED_MESSAGE =
  'remi will not connect to the shared Codex app-server: its control directory is not private (the remi log says which); the session still works in the terminal.';
const DEFAULT_LINK_WATCHDOG_MS = 30_000;
/** A link counts as up, and the watchdog is cancelled, once it has stayed up this long (the client's own `stableMs`). */
const DEFAULT_LINK_STABLE_MS = 5_000;

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

  const checked = checkCodexLaunch(deps, ctx.extraArgs);
  if (!checked.ok) throw new CodexLaunchRefusal(checked.message, checked.exitCode);
  const cwd = resolveCodexWorkingDirectory(workingDirectory);
  if (!cwd.ok) throw new CodexLaunchRefusal(cwd.error, 1);

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
          ? LINK_UNTRUSTED_MESSAGE
          : LINK_UNAVAILABLE_MESSAGE,
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
        link.tracker?.handleDisconnected();
        armWatchdog();
      } else if (event.type === 'notification') {
        link.tracker?.handleNotification(event.method, event.params);
      }
      // A server request is for phase 4; it is never answered here.
    },
  );
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
    // Another ACTIVE codex session in this directory that has no thread yet may own the next new
    // thread there; the store's purge (in `list()`) has already dropped the dead.
    siblingSeekingIdentity: () =>
      deps.sessionStore.list().some((s) => {
        if (isClaudeRecord(s) || s.exitedAt !== null || s.remiSessionId === sessionId) return false;
        if (s.harnessSessionId !== undefined && s.harnessSessionId !== null) return false;
        const there = resolveCodexWorkingDirectory(s.projectPath);
        return there.ok && there.directory === cwd.directory;
      }),
    notice: sendSystemMessage,
    onIdentity: (threadId) => {
      try {
        deps.bindingStore.updateHarnessIdentity(sessionId, 'codex', threadId);
      } catch (error) {
        // Another session took the thread between the tracker's check and this write.
        if (error instanceof AmbiguousSessionIdentityError) throw new ThreadClaimedError(threadId);
        throw error;
      }
      // What the old thread's descendants were doing says nothing about the new one. On a
      // rotation say so now, since a new thread whose frame carries no status would republish
      // nothing; a first identity has nothing stale to clear, and "unknown" is not "idle".
      const rotating = trackedId !== null;
      trackedId = threadId;
      statuses.clear();
      if (rotating) publish();
    },
    onStatus: (threadId, status) => {
      // Only an active thread counts, so only an active one is kept.
      if (status.type === 'active') statuses.set(threadId, status);
      else statuses.delete(threadId);
      publish();
    },
    log,
    ...deps.tracker,
  });
  link.tracker = tracker;

  const pty = createPtySessionForSession(
    {
      sessionRegistry: deps.sessionRegistry,
      sessionStore: deps.sessionStore,
      liveSessionsRegistry: deps.liveSessionsRegistry,
      outputSink: NOOP_OUTPUT_SINK,
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
    decisions: NO_DECISIONS,
    acceptsTypedChat: false,
    start: async () => {
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
    },
  };
}
