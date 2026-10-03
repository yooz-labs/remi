/**
 * `ClaudeHarness.createSession` (epic #1161, phase 3 #1164), built the way the
 * daemon builds it: a real harness over real stores, registry, message API,
 * dispatcher and (for the hook-server cases) a real `HookServer`. Most cases
 * only create the session, so nothing spawns `claude`; one starts a real PTY
 * running a fake `claude`, with a `cleanup` that never resolves so the PTY's
 * exit handler can never reach `process.exit` in the test runner. The
 * black-box launch is pinned by `integration/launch-characterization.test.ts`.
 *
 * What these pin is what that test cannot see: what the launch registers in
 * the daemon's per-session maps, that it reads the daemon's changing values
 * when it launches (`PORT`, the websocket port and the hook server are only
 * known after the harness is built), what a wrapper-mode launch does (hold
 * policy, terminal size, the local-terminal feed), and that `cli.ts` passes
 * the values the harness needs.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { UUID } from '@remi/shared';
import { generateId } from '@remi/shared';
import type { QuestionPresenceTracker } from '../../src/api/question-presence-tracker.ts';
import { SubagentViewRegistry } from '../../src/api/subagent-view-registry.ts';
import { SubagentAlerter } from '../../src/auto-approve/index.ts';
import { __resetLoggerForTests, configureLogger } from '../../src/cli/logger.ts';
import type { SessionGateHandle } from '../../src/cli/session-phases/hook-bridge-setup.ts';
import { createMessageApiForSession } from '../../src/cli/session-phases/message-api-setup.ts';
import { childRows } from '../../src/cli/status-bar.ts';
import {
  __resetWrapperStateForTests,
  setPtyStdoutFd,
  setWrapperDetached,
} from '../../src/cli/wrapper-state.ts';
import { ClaudeHarness } from '../../src/harness/index.ts';
import type { ClaudeLaunchDeps, HarnessSession } from '../../src/harness/index.ts';
import { ForeignSessionEscalator, HookServer } from '../../src/hooks/index.ts';
import type { HookInput } from '../../src/hooks/index.ts';
import type { NotificationDispatcher } from '../../src/notifications/notification-dispatcher.ts';
import { SessionBindingStore } from '../../src/session/session-binding-store.ts';
import { SessionRegistryFile } from '../../src/session/session-registry-file.ts';
import { SessionRegistry } from '../../src/session/session-registry.ts';
import { SessionStore } from '../../src/session/session-store.ts';
import { TranscriptDiscovery } from '../../src/transcript/index.ts';
import type { TranscriptWatcher } from '../../src/transcript/index.ts';

const SRC = path.resolve(import.meta.dir, '..', '..', 'src');

/** Strip comments, so a commented-out line cannot satisfy a source pin. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
}

/** The source of `file` under `src`, comments removed. */
function source(...file: string[]): string {
  return stripComments(fs.readFileSync(path.join(SRC, ...file), 'utf8'));
}

/** A fake `claude`: records what a wrapper-mode launch gave it, prints a line, waits. */
const FAKE_CLAUDE = `#!/bin/sh
d="$FAKE_CLAUDE_DIR"
printf '%s' "$REMI_STATUS_BAR" > "$d/status_bar"
stty size > "$d/size"
printf 'hello-from-fake-claude\\n'
i=0
while [ ! -e "$d/release" ] && [ $i -lt 200 ]; do
  sleep 0.1
  i=$((i + 1))
done
`;

async function until(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('ClaudeHarness.createSession', () => {
  let tmpDir: string;
  let sessionRegistry: SessionRegistry;
  let sessionStore: SessionStore;
  let bindingStore: SessionBindingStore;
  let transcriptWatchers: Map<UUID, TranscriptWatcher>;
  let transcriptFallbackTimers: Map<UUID, ReturnType<typeof setInterval>>;
  let sessionNotifiers: Map<UUID, NotificationDispatcher>;
  let sessionGateHandles: Map<UUID, SessionGateHandle>;
  let sessionTrackers: Map<UUID, QuestionPresenceTracker>;
  let binderClosers: Map<UUID, () => void>;
  let sessionAdmitsHandles: Map<UUID, (input: HookInput) => boolean>;
  let hookServer: HookServer | null;
  let port: number;
  let wsPort: number;
  let prompts: { hold_seconds: number; daemon_hold_seconds: number };
  let observed: string[];
  let launched: HarnessSession[];
  let servers: HookServer[];
  let registries: SessionRegistry[];
  let restoreEnv: Array<() => void>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-claude-session-'));
    configureLogger({ writeLog: () => {} });
    sessionRegistry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    sessionStore = new SessionStore(path.join(tmpDir, 'sessions.json'));
    bindingStore = new SessionBindingStore(sessionStore);
    transcriptWatchers = new Map();
    transcriptFallbackTimers = new Map();
    sessionNotifiers = new Map();
    sessionGateHandles = new Map();
    sessionTrackers = new Map();
    binderClosers = new Map();
    sessionAdmitsHandles = new Map();
    hookServer = null;
    port = 0;
    wsPort = 19999;
    prompts = { hold_seconds: 90, daemon_hold_seconds: 3540 };
    observed = [];
    launched = [];
    servers = [];
    registries = [sessionRegistry];
    restoreEnv = [];
  });

  afterEach(async () => {
    for (const session of launched) {
      if (session.pty.isRunning) session.pty.signal('SIGKILL');
    }
    for (const restore of restoreEnv) restore();
    __resetWrapperStateForTests();
    for (const close of binderClosers.values()) close();
    for (const timer of transcriptFallbackTimers.values()) clearInterval(timer);
    for (const server of servers) server.stop();
    __resetLoggerForTests();
    for (const registry of registries) await registry.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function buildDeps(): ClaudeLaunchDeps {
    const liveSessionsRegistry = new SessionRegistryFile(path.join(tmpDir, 'live-sessions'));
    fs.mkdirSync(liveSessionsRegistry.dirPath, { recursive: true });
    return {
      sessionRegistry,
      sessionStore,
      bindingStore,
      liveSessionsRegistry,
      transcriptDiscovery: new TranscriptDiscovery({ projectsDir: path.join(tmpDir, 'p') }),
      transcriptWatchers,
      transcriptFallbackTimers,
      subagentViews: new SubagentViewRegistry(),
      foreignSessionEscalator: new ForeignSessionEscalator({
        liveSessionsRegistry,
        bindingStore,
        deviceTokens: new Map(),
        pushConfig: () => ({ signalingUrl: 'http://127.0.0.1:1' }),
        currentPort: () => port,
      }),
      subagentAlerts: { alerter: new SubagentAlerter([]), deliver: () => {} },
      onQuestionResolved: () => {},
      onHarnessDenied: () => {},
      pushTurnFailed: () => {},
      dismissTurnFailed: () => {},
      prompts: () => prompts,
      hookServer: () => hookServer,
      currentPort: () => port,
      wsPort: () => wsPort,
      // Never resolves: the PTY's exit handler then never reaches `process.exit`.
      cleanup: () => new Promise<void>(() => {}),
      observeLocalPtyOutput: (data) => {
        observed.push(Buffer.from(data).toString('utf8'));
      },
      sessionNotifiers,
      sessionGateHandles,
      sessionTrackers,
      binderClosers,
      sessionAdmitsHandles,
    };
  }

  function newHarness(): ClaudeHarness {
    return new ClaudeHarness(new TranscriptDiscovery({ projectsDir: tmpDir }), buildDeps());
  }

  function newHookServer(): HookServer {
    const server = new HookServer({ port: 0 }, { onError: () => {} });
    servers.push(server);
    return server;
  }

  /** A registry that has no session yet (a registry hosts one), for the next harness. */
  function freshRegistry(): void {
    sessionRegistry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    registries.push(sessionRegistry);
  }

  function launch(
    harness: ClaudeHarness,
    opts: { passThrough?: boolean; reservedRows?: number; register?: boolean } = {},
  ) {
    const sessionId: UUID = generateId();
    const { messageApi, sendAndRecord, notifications } = createMessageApiForSession(
      {
        sessionRegistry,
        transcriptWatchers,
        deviceTokens: new Map(),
        pushConfig: () => ({ signalingUrl: 'http://127.0.0.1:1' }),
        updateRemiStatus: () => {},
        maxBulletLength: 500,
        sendMessage: () => {},
      },
      sessionId,
    );
    const session = harness.createSession({
      sessionId,
      workingDirectory: tmpDir,
      extraArgs: [],
      passThrough: opts.passThrough ?? false,
      reservedRows: opts.reservedRows ?? 0,
      messageApi,
      sendAndRecord,
      sendMessage: () => {},
      notifications,
    });
    launched.push(session);
    // The shell registers the PTY between createSession and start(); a held
    // prompt needs the registered session to land its card in.
    if (opts.register) {
      sessionRegistry.registerSession(sessionId, tmpDir, session.pty, messageApi, false, false);
    }
    return { session, sessionId, notifications };
  }

  function claudeSessionIdOf(sessionId: UUID): string {
    const id = bindingStore.get(sessionId)?.claudeSessionId;
    if (!id) throw new Error('no binding was persisted');
    return id;
  }

  /** POST a PermissionRequest the way Claude Code does; the response waits on the hold. */
  function postPermissionRequest(server: HookServer, claudeSessionId: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${server.port}/hooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hook_event_name: 'PermissionRequest',
        session_id: claudeSessionId,
        cwd: tmpDir,
        permission_mode: 'default',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        permission_suggestions: [],
      }),
    }).catch(() => new Response(null, { status: 499 }));
  }

  test('a harness built without launch dependencies refuses to create a session', () => {
    const harness = new ClaudeHarness(new TranscriptDiscovery({ projectsDir: tmpDir }));
    expect(() => launch(harness)).toThrow('without launch dependencies');
  });

  test('returns an unstarted session, registers its notifier and tracker, and binds the port read at launch', () => {
    const harness = newHarness();
    // PORT is reassigned by port probing after the harness exists; the launch
    // must read it when it runs, not when the harness was built.
    port = 19123;

    const { session, sessionId, notifications } = launch(harness);

    expect(session.pty.isRunning).toBe(false);
    expect(session.pty.childPid).toBeNull();
    expect(sessionNotifiers.get(sessionId)).toBe(notifications);
    expect(sessionTrackers.has(sessionId)).toBe(true);
    const stored = sessionStore.findByRemiSessionId(sessionId);
    expect(stored?.port).toBe(19123);
    expect(stored?.pid).toBe(process.pid);
    expect(stored?.exitedAt).toBeNull();
    expect(stored?.claudeSessionId).toMatch(/^[0-9a-f-]{36}$/);
    // No hook server: the bridge is never built, so nothing else registers.
    expect(sessionGateHandles.has(sessionId)).toBe(false);
    expect(binderClosers.has(sessionId)).toBe(false);
    expect(sessionAdmitsHandles.has(sessionId)).toBe(false);
  });

  test('reads the hook server and the websocket port when it launches, and with a server registers the gate, the binder and the turn filter', () => {
    // The daemon builds the harness before the hook server or the websocket
    // port exist; both are read per launch.
    hookServer = null;
    wsPort = 0;
    const harness = newHarness();
    wsPort = 19999;

    const before = launch(harness);
    expect(sessionGateHandles.has(before.sessionId)).toBe(false);

    hookServer = newHookServer();
    const { sessionId } = launch(harness);

    expect(sessionGateHandles.has(sessionId)).toBe(true);
    expect(binderClosers.has(sessionId)).toBe(true);
    // preAssign ran before the bridge read the binding: the binder armed its
    // fallback poll for the pre-assigned id.
    expect(transcriptFallbackTimers.has(sessionId)).toBe(true);
    const own = {
      session_id: claudeSessionIdOf(sessionId),
      cwd: tmpDir,
      hook_event_name: 'Stop',
    } as HookInput;
    const admits = sessionAdmitsHandles.get(sessionId);
    expect(admits?.(own)).toBe(true);
    expect(admits?.({ ...own, session_id: generateId() } as HookInput)).toBe(false);
  });

  test('a wrapper session runs claude on the reduced terminal and feeds the local-terminal observer', async () => {
    const fakeDir = path.join(tmpDir, 'fake');
    const fakeBin = path.join(tmpDir, 'fake-bin');
    fs.mkdirSync(fakeDir);
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, 'claude'), FAKE_CLAUDE);
    fs.chmodSync(path.join(fakeBin, 'claude'), 0o755);
    for (const [name, value] of [
      ['PATH', `${fakeBin}:${process.env['PATH'] ?? ''}`],
      ['FAKE_CLAUDE_DIR', fakeDir],
    ] as const) {
      const previous = process.env[name];
      process.env[name] = value;
      restoreEnv.push(() => {
        if (previous === undefined) Reflect.deleteProperty(process.env, name);
        else process.env[name] = previous;
      });
    }
    // The wrapper's real terminal, here a file: `onRawData` writes to it and
    // then feeds the observer with the same bytes.
    const terminal = fs.openSync(path.join(tmpDir, 'terminal.out'), 'w');
    restoreEnv.push(() => fs.closeSync(terminal));
    setPtyStdoutFd(terminal);
    setWrapperDetached(false);
    hookServer = newHookServer();

    const { session } = launch(newHarness(), { passThrough: true, reservedRows: 2 });
    await session.start();

    await until(() => fs.existsSync(path.join(fakeDir, 'size')), 'the fake claude to start');
    // reservedRows > 0 makes the child's statusLine drop the remi prefix, and
    // passThrough sizes the child from the wrapper's own terminal minus the bar.
    expect(fs.readFileSync(path.join(fakeDir, 'status_bar'), 'utf8')).toBe('1');
    expect(fs.readFileSync(path.join(fakeDir, 'size'), 'utf8').trim()).toBe(
      `${childRows(process.stdout.rows || 40, true)} ${process.stdout.columns || 120}`,
    );
    await until(
      () => observed.join('').includes('hello-from-fake-claude'),
      'the local-terminal observer to see the PTY output',
    );
    expect(fs.readFileSync(path.join(tmpDir, 'terminal.out'), 'utf8')).toContain(
      'hello-from-fake-claude',
    );
  });

  test('the hold deadline follows passThrough: a wrapper session hands a prompt back after hold_seconds, a daemon session keeps it', async () => {
    prompts = { hold_seconds: 1, daemon_hold_seconds: 3540 };

    /** Whether the session still holds a main prompt 1.5 s after it was held. */
    async function holdsAfterDeadline(passThrough: boolean): Promise<boolean> {
      hookServer = newHookServer();
      hookServer.start();
      freshRegistry();
      const { sessionId } = launch(newHarness(), { passThrough, register: true });
      const gate = sessionGateHandles.get(sessionId);
      if (!gate) throw new Error('no gate was registered');
      void postPermissionRequest(hookServer, claudeSessionIdOf(sessionId));
      await until(() => gate.hasMainHold(), 'the prompt to be held');
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return gate.hasMainHold();
    }

    expect(await holdsAfterDeadline(true)).toBe(false);
    expect(await holdsAfterDeadline(false)).toBe(true);
  });
});

describe('what cli.ts hands the harness (#1164)', () => {
  const cli = source('cli.ts');
  const claudeSession = source('harness', 'claude-session.ts');

  /** The text of `cli.ts` from `marker` to the first `end` after it. */
  function slice(marker: string, end: string): string {
    const start = cli.indexOf(marker);
    expect(start, marker).toBeGreaterThan(0);
    const stop = cli.indexOf(end, start);
    expect(stop, `${marker} ... ${end}`).toBeGreaterThan(start);
    return cli.slice(start, stop);
  }

  // Scoped to the harness's own construction: `currentPort: () => PORT` is
  // also spelled by other dependencies elsewhere in the file.
  const construction = () => slice('const harness = new ClaudeHarness(', '\n});');

  test('getters for hookServer, the port, the websocket port and [prompts]', () => {
    expect(construction()).toContain('hookServer: () => hookServer,');
    expect(construction()).toContain('currentPort: () => PORT,');
    expect(construction()).toContain('wsPort: () => remiStatus.wsPort,');
    expect(construction()).toContain('prompts: () => remiConfig.prompts,');
  });

  test('the local-terminal observer feeds the wrapper quiescence gate and status bar', () => {
    expect(construction()).toContain('observeLocalPtyOutput: (data) => {');
    expect(construction()).toContain('wrapperPtyGate.observe(data)');
    expect(construction()).toContain('statusBar?.notifyScrollRegionReset()');
  });

  test('createNewSession passes passThrough and reservedRows to createSession', () => {
    const call = slice('harness.createSession({', '});');
    expect(call).toContain('passThrough,');
    expect(call).toContain('reservedRows,');
    expect(call).toContain('extraArgs,');
  });

  test('createClaudeSession gives the PTY the context it was handed', () => {
    expect(claudeSession).toContain(
      '{ sessionId, workingDirectory, extraArgs: binding.args, passThrough, reservedRows },',
    );
  });

  test('the PTY output callbacks read hookServer when the event fires, not when the session launches', () => {
    const start = claudeSession.indexOf('new OutputProcessor(');
    const end = claudeSession.indexOf('resolveClaudeBinding(', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const callbacks = claudeSession.slice(start, end);
    expect(callbacks).toContain('if (deps.hookServer()) {');
    expect(callbacks).toContain('if (!deps.hookServer()) {');
  });

  test('a commented-out line does not satisfy a pin', () => {
    expect(stripComments('// hookServer: () => hookServer,\nconst a = 1;')).not.toContain(
      'hookServer: () => hookServer,',
    );
    expect(stripComments('/* passThrough, */ x')).not.toContain('passThrough,');
  });
});
