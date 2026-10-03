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
import { SubagentViewRegistry } from '../../src/api/subagent-view-registry.ts';
import { SubagentAlerter } from '../../src/auto-approve/index.ts';
import { __resetLoggerForTests, configureLogger } from '../../src/cli/logger.ts';
import { createMessageApiForSession } from '../../src/cli/session-phases/message-api-setup.ts';
import { childRows } from '../../src/cli/status-bar.ts';
import {
  __resetWrapperStateForTests,
  setPtyStdoutFd,
  setWrapperDetached,
} from '../../src/cli/wrapper-state.ts';
import type { ClaudeLaunchDeps } from '../../src/harness/claude-session.ts';
import { ClaudeHarness } from '../../src/harness/index.ts';
import type { HarnessSession } from '../../src/harness/index.ts';
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
    for (const session of launched) session.dispose();
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

  /** The Stop event Claude Code would send for `sessionId`'s own Claude session. */
  function stopEventFor(sessionId: UUID): HookInput {
    return {
      session_id: claudeSessionIdOf(sessionId),
      cwd: tmpDir,
      hook_event_name: 'Stop',
    } as HookInput;
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

  /**
   * Launch a session on a fresh registry and hook server, POST a
   * PermissionRequest, and wait until the session holds it. Returns the held
   * card and the pending hook response.
   */
  async function holdPrompt(passThrough: boolean) {
    hookServer = newHookServer();
    hookServer.start();
    freshRegistry();
    const { session, sessionId } = launch(newHarness(), { passThrough, register: true });
    const response = postPermissionRequest(hookServer, claudeSessionIdOf(sessionId));
    await until(() => session.decisions.hasMainHold(), 'the prompt to be held');
    const card = [...(sessionRegistry.getSession(sessionId)?.currentQuestions.values() ?? [])][0];
    if (!card) throw new Error('the held prompt did not reach the registry as a card');
    return { decisions: session.decisions, card, response };
  }

  test('a harness built without launch dependencies refuses to create a session', () => {
    const harness = new ClaudeHarness(new TranscriptDiscovery({ projectsDir: tmpDir }));
    expect(() => launch(harness)).toThrow('without launch dependencies');
  });

  test('returns an unstarted session, registers its notifier and exposes its screen, and binds the port read at launch', () => {
    const harness = newHarness();
    // PORT is reassigned by port probing after the harness exists; the launch
    // must read it when it runs, not when the harness was built.
    port = 19123;

    const { session, sessionId, notifications } = launch(harness);

    expect(session.pty.isRunning).toBe(false);
    expect(session.pty.childPid).toBeNull();
    expect(sessionNotifiers.get(sessionId)).toBe(notifications);
    expect(session.decisions.screen).toBeDefined();
    const stored = sessionStore.findByRemiSessionId(sessionId);
    expect(stored?.port).toBe(19123);
    expect(stored?.pid).toBe(process.pid);
    expect(stored?.exitedAt).toBeNull();
    expect(stored?.claudeSessionId).toMatch(/^[0-9a-f-]{36}$/);
    // No hook server: the bridge is never built, so no turn filter registers.
    expect(harness.admitsAnySession(stopEventFor(sessionId))).toBe(false);
  });

  test('reads the hook server and the websocket port when it launches, and with a server arms the binder and the turn filter', () => {
    // The daemon builds the harness before the hook server or the websocket
    // port exist; both are read per launch.
    hookServer = null;
    wsPort = 0;
    const harness = newHarness();
    wsPort = 19999;

    const before = launch(harness);
    expect(harness.admitsAnySession(stopEventFor(before.sessionId))).toBe(false);

    hookServer = newHookServer();
    const { sessionId } = launch(harness);

    // preAssign ran before the bridge read the binding: the binder armed its
    // fallback poll for the pre-assigned id.
    expect(transcriptFallbackTimers.has(sessionId)).toBe(true);
    const own = stopEventFor(sessionId);
    expect(harness.admitsAnySession(own)).toBe(true);
    expect(harness.admitsAnySession({ ...own, session_id: generateId() } as HookInput)).toBe(false);
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

    /** What a session still reports 1.5 s after it was held. */
    async function afterDeadline(passThrough: boolean) {
      const { decisions } = await holdPrompt(passThrough);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return { held: decisions.hasMainHold(), open: decisions.hasOpenHookPrompt() };
    }

    // The wrapper's dialog is on its own terminal: no longer held, still open.
    expect(await afterDeadline(true)).toEqual({ held: false, open: true });
    expect(await afterDeadline(false)).toEqual({ held: true, open: true });
  });

  test('with a hook server its decisions answer the prompt that server holds', async () => {
    const { decisions, card, response } = await holdPrompt(false);
    const yes = card.options.find((option) => option.isYes);
    if (!yes) throw new Error('the held card has no Yes option');

    expect(decisions.isHeld(card.id as UUID)).toBe(true);
    expect(decisions.isHeld(generateId())).toBe(false);
    expect(decisions.answerHeld(card.id as UUID, { kind: 'option', option: yes })).toBe('resolved');

    expect(JSON.stringify(await (await response).json())).toContain('"allow"');
    expect(decisions.hasMainHold()).toBe(false);
    expect(decisions.isHeld(card.id as UUID)).toBe(false);
  });

  test('retire, force release and a terminal Escape reach the gate through the decisions', async () => {
    // A retired live hold ends with the empty response, never a decision.
    const retired = await holdPrompt(false);
    retired.decisions.retireQuestion(retired.card.id as UUID);
    expect(retired.decisions.hasMainHold()).toBe(false);
    expect(await (await retired.response).text()).not.toMatch(/allow|deny/);

    // `remi unstick` hands a live hold to the terminal.
    const forced = await holdPrompt(false);
    expect(typeof forced.decisions.forceRelease('test').resolved).toBe('number');
    expect(forced.decisions.hasMainHold()).toBe(false);
    expect(await (await forced.response).text()).not.toMatch(/allow|deny/);

    // A prompt released at the wrapper's deadline stays open until an Escape
    // sent through remi resolves it.
    prompts = { hold_seconds: 1, daemon_hold_seconds: 3540 };
    const wrapper = await holdPrompt(true);
    await until(() => !wrapper.decisions.hasMainHold(), 'the wrapper hold to reach its deadline');
    expect(wrapper.decisions.hasOpenHookPrompt()).toBe(true);
    wrapper.decisions.noteTerminalEscape();
    expect(wrapper.decisions.hasOpenHookPrompt()).toBe(false);
  });

  test('a session with no hook server reads as nothing held', () => {
    const { session } = launch(newHarness());
    const { decisions } = session;

    expect(decisions.hasMainHold()).toBe(false);
    expect(decisions.hasOpenHookPrompt()).toBe(false);
    expect(decisions.isHeld(generateId())).toBe(false);
    expect(decisions.answerHeld(generateId(), { kind: 'cancel' })).toBe('unknown');
    expect(decisions.forceRelease('test')).toEqual({ resolved: 0 });
    expect(() => decisions.retireQuestion(generateId())).not.toThrow();
    expect(() => decisions.noteTerminalEscape()).not.toThrow();
  });

  test('each session claims only its own events, and dispose releases the binder and the filter (#914)', () => {
    hookServer = newHookServer();
    const harness = newHarness();
    const a = launch(harness);
    const b = launch(harness);
    const eventA = stopEventFor(a.sessionId);
    const eventB = stopEventFor(b.sessionId);

    expect(transcriptFallbackTimers.has(a.sessionId)).toBe(true);
    expect(harness.admitsAnySession(eventA)).toBe(true);
    expect(harness.admitsAnySession(eventB)).toBe(true);
    expect(harness.admitsAnySession({ ...eventA, session_id: generateId() } as HookInput)).toBe(
      false,
    );

    a.session.dispose();
    expect(transcriptFallbackTimers.has(a.sessionId)).toBe(false);
    // A second dispose must not close the binder again: a sentinel timer
    // registered under the id survives it (a second `binder.close()` would
    // delete the entry).
    const sentinel = setInterval(() => {}, 1e6);
    transcriptFallbackTimers.set(a.sessionId, sentinel);
    a.session.dispose();
    expect(transcriptFallbackTimers.get(a.sessionId)).toBe(sentinel);
    clearInterval(sentinel);
    transcriptFallbackTimers.delete(a.sessionId);

    expect(harness.admitsAnySession(eventA)).toBe(false);
    expect(harness.admitsAnySession(eventB)).toBe(true);
    expect(transcriptFallbackTimers.has(b.sessionId)).toBe(true);
  });

  test('a binder that fails to close still loses its turn filter', () => {
    // The binder's close looks its fallback timer up first; make that throw.
    let failLookup = false;
    class FlakyTimers extends Map<UUID, ReturnType<typeof setInterval>> {
      override get(key: UUID) {
        if (failLookup) throw new Error('binder close failed');
        return super.get(key);
      }
    }
    transcriptFallbackTimers = new FlakyTimers();
    hookServer = newHookServer();
    const harness = newHarness();
    const { session, sessionId } = launch(harness);
    const own = stopEventFor(sessionId);
    expect(harness.admitsAnySession(own)).toBe(true);

    failLookup = true;
    expect(() => session.dispose()).toThrow('binder close failed');
    failLookup = false;

    expect(harness.admitsAnySession(own)).toBe(false);
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

  /** The text of the top-level function `name` in `cli.ts`, to its closing brace. */
  function functionBody(name: string): string {
    return slice(`function ${name}(`, '\n}\n');
  }

  test('createNewSession stores the session after createSession returns, before it registers it', () => {
    const shell = slice('async function createNewSession(', '\n}\n');
    const created = shell.indexOf('harness.createSession({');
    const stored = shell.indexOf('harnessSessions.set(sessionId, session);');
    const registered = shell.indexOf('sessionRegistry.registerSession(');
    expect(created).toBeGreaterThan(0);
    expect(stored).toBeGreaterThan(created);
    expect(registered).toBeGreaterThan(stored);
  });

  test('remi unstick force-releases every harness session and logs the session count', () => {
    const body = functionBody('forceReleaseAllSessions');
    expect(body).toContain('harnessSessions.entries()');
    expect(body).toContain("session.decisions.forceRelease('force-release (remi unstick)')");
    // A session with no hook server counts too: it has 0 cards to resolve.
    expect(body).toContain('${harnessSessions.size} session(s)');
  });

  test('session close disposes the harness session before it drops it', () => {
    const closed = slice(
      'onSessionClosed: (sessionId, reason) => {',
      'sessionNotifiers.delete(sessionId);',
    );
    const disposed = closed.indexOf('harnessSessions.get(sessionId)?.dispose();');
    const dropped = closed.indexOf('harnessSessions.delete(sessionId);');
    expect(disposed).toBeGreaterThan(0);
    expect(dropped).toBeGreaterThan(disposed);
  });

  test('cleanup stops the hook server before it disposes the sessions, and keeps them in the map', () => {
    const body = functionBody('cleanup');
    const stopped = body.indexOf('hookServer.stop();');
    const disposed = body.indexOf('session.dispose();');
    expect(stopped).toBeGreaterThan(0);
    expect(disposed).toBeGreaterThan(stopped);
    expect(body).not.toContain('harnessSessions.clear()');
  });

  test('the answer handlers and the turn-stop listener read the harness sessions', () => {
    // The gate handlers (answer, retire, terminal Escape) read the session's decisions.
    const handlers = slice('const inputHandlers: InputHandlers = createInputHandlers({', '\n});');
    expect(handlers).toContain(
      '...gateAnswerDeps((sessionId) => harnessSessions.get(sessionId)?.decisions),',
    );
    // onTurnStop applies the #914 session filter first and returns when no session claims the event.
    const turnStop = functionBody('onTurnStop');
    expect(turnStop).toContain('if (!harness.admitsAnySession(input)) return;');
  });

  test('a commented-out line does not satisfy a pin', () => {
    expect(stripComments('// hookServer: () => hookServer,\nconst a = 1;')).not.toContain(
      'hookServer: () => hookServer,',
    );
    expect(stripComments('/* passThrough, */ x')).not.toContain('passThrough,');
  });
});
