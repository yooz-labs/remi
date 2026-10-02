/**
 * `ClaudeHarness.createSession` (epic #1161, phase 3 #1164), built the way the
 * daemon builds it: a real harness over real stores, registry, message API,
 * dispatcher and (for the hook-server case) a real `HookServer`. The PTY is
 * created but never started here, so nothing spawns `claude`; the black-box
 * launch is pinned by `integration/launch-characterization.test.ts`.
 *
 * What these pin is what that test cannot see: what the launch registers in
 * the daemon's per-session maps, that it reads the daemon's changing values
 * when it launches (`PORT` is reassigned by port probing after the harness is
 * built), and that `cli.ts` passes getters for them.
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
  let launched: HarnessSession[];

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
    launched = [];
  });

  afterEach(async () => {
    for (const close of binderClosers.values()) close();
    for (const timer of transcriptFallbackTimers.values()) clearInterval(timer);
    hookServer?.stop();
    __resetLoggerForTests();
    await sessionRegistry.shutdown();
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
      prompts: () => ({ hold_seconds: 90, daemon_hold_seconds: 3540 }),
      hookServer: () => hookServer,
      currentPort: () => port,
      wsPort: () => 19999,
      cleanup: async () => {},
      observeLocalPtyOutput: () => {},
      sessionNotifiers,
      sessionGateHandles,
      sessionTrackers,
      binderClosers,
      sessionAdmitsHandles,
    };
  }

  function launch(harness: ClaudeHarness, sessionId: UUID = generateId()) {
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
      passThrough: false,
      reservedRows: 0,
      messageApi,
      sendAndRecord,
      sendMessage: () => {},
      notifications,
    });
    launched.push(session);
    return { session, sessionId, notifications };
  }

  test('a harness built without launch dependencies refuses to create a session', () => {
    const harness = new ClaudeHarness(new TranscriptDiscovery({ projectsDir: tmpDir }));
    expect(() => launch(harness)).toThrow('without launch dependencies');
  });

  test('returns an unstarted session, registers its notifier and tracker, and binds the port read at launch', () => {
    const harness = new ClaudeHarness(
      new TranscriptDiscovery({ projectsDir: tmpDir }),
      buildDeps(),
    );
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

  test('with a hook server it also registers the gate handle, the binder closer and the turn filter', () => {
    hookServer = new HookServer({ port: 0 }, { onError: () => {} });
    const harness = new ClaudeHarness(
      new TranscriptDiscovery({ projectsDir: tmpDir }),
      buildDeps(),
    );

    const { sessionId } = launch(harness);

    expect(sessionGateHandles.has(sessionId)).toBe(true);
    expect(binderClosers.has(sessionId)).toBe(true);
    const claudeSessionId = bindingStore.get(sessionId)?.claudeSessionId;
    if (!claudeSessionId) throw new Error('no binding was persisted');
    const admits = sessionAdmitsHandles.get(sessionId);
    const own = { session_id: claudeSessionId, cwd: tmpDir, hook_event_name: 'Stop' } as HookInput;
    expect(admits?.(own)).toBe(true);
    expect(admits?.({ ...own, session_id: generateId() } as HookInput)).toBe(false);
  });
});

describe('the launch reads the daemon values that change while it runs (#1164)', () => {
  const cli = fs.readFileSync(path.join(SRC, 'cli.ts'), 'utf8');
  const claudeSession = fs.readFileSync(path.join(SRC, 'harness', 'claude-session.ts'), 'utf8');

  test('cli.ts hands the harness getters for hookServer, the port and the websocket port', () => {
    // Scoped to the harness's own construction: `currentPort: () => PORT` is
    // also spelled by other dependencies elsewhere in the file.
    const start = cli.indexOf('const harness = new ClaudeHarness(');
    const end = cli.indexOf('\n});', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const construction = cli.slice(start, end);
    expect(construction).toContain('hookServer: () => hookServer,');
    expect(construction).toContain('currentPort: () => PORT,');
    expect(construction).toContain('wsPort: () => remiStatus.wsPort,');
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
});
