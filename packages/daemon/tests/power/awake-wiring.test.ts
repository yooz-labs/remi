/**
 * Keep-awake wiring (#1773): the production `AwakeWiring` (the glue `cli.ts`
 * runs) over a real `SessionRegistry` built through `registryEvents`, a real
 * `MessageAPI`, the real hook bridge behind a real `HookServer`, and the real
 * policy and `AwakeSession`. Only the caffeinate process is replaced, by a holder
 * that records its starts and stops (the real one is covered by
 * `awake-holder.test.ts`), and the cases that wait out a bound drive the
 * session's clock by hand. The PTY output and Codex feeds are pinned in
 * `harness/claude-pty-output.test.ts` and `harness/codex/codex-session.test.ts`.
 */

import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Question, UUID } from '@remi/shared';
import { generateId } from '@remi/shared';
import { MessageAPI, type SessionWorkEvent } from '../../src/api/message-api.ts';
import { QuestionPresenceTracker } from '../../src/api/question-presence-tracker.ts';
import { __resetLoggerForTests, configureLogger } from '../../src/cli/logger.ts';
import { setupHookBridge } from '../../src/cli/session-phases/hook-bridge-setup.ts';
import type { AwakeConfig } from '../../src/config/config.ts';
import { HookServer } from '../../src/hooks/hook-server.ts';
import { AwakeHolder } from '../../src/power/awake-holder.ts';
import type { AwakeHolderBoundary, AwakeHolderResult } from '../../src/power/awake-holder.ts';
import type { AwakeClock, AwakeSession } from '../../src/power/awake-session.ts';
import { AwakeWiring, awakeApplies } from '../../src/power/awake-wiring.ts';
import { PTYSession } from '../../src/pty/pty-session.ts';
import { SessionBindingStore } from '../../src/session/session-binding-store.ts';
import { SessionRegistryFile } from '../../src/session/session-registry-file.ts';
import { SessionRegistry } from '../../src/session/session-registry.ts';
import { SessionStore } from '../../src/session/session-store.ts';
import { TranscriptDiscovery } from '../../src/transcript/index.ts';
import { reserveRange } from '../session/port-test-helpers.ts';

const CLAUDE_SESSION_ID = 'claude-awake-wire';

class RecordingHolder implements AwakeHolderBoundary {
  starts = 0;
  renewals = 0;
  stops = 0;
  private activePid: number | null = null;

  get pid(): number | null {
    return this.activePid;
  }

  async start(): Promise<AwakeHolderResult> {
    this.starts += 1;
    this.activePid = 900_001;
    return { ok: true };
  }

  async renew(): Promise<AwakeHolderResult> {
    this.renewals += 1;
    this.activePid = 900_001 + this.renewals;
    return { ok: true };
  }

  release(): void {
    if (this.activePid === null) return;
    this.activePid = null;
    this.stops += 1;
  }

  dispose(): void {
    this.release();
  }
}

/** The session's timers, run only when a test advances the clock. */
class ManualClock implements AwakeClock {
  private current = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.current;
  }

  setTimer(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.current + Math.max(0, delayMs), callback });
    return id;
  }

  clearTimer(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      let dueId: number | null = null;
      let dueAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < dueAt) {
          dueId = id;
          dueAt = timer.at;
        }
      }
      if (dueId === null) break;
      const timer = this.timers.get(dueId);
      this.timers.delete(dueId);
      this.current = Math.max(this.current, dueAt);
      timer?.callback();
    }
    this.current = target;
  }
}

const DEFAULTS: AwakeConfig = {
  level1: true,
  question_hold_minutes: 30,
  idle_grace_seconds: 120,
  stuck_busy_minutes: 15,
  ttl_minutes: 20,
};

async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('awake wiring did not reach the expected state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface Fixture {
  readonly sessionId: UUID;
  readonly directory: string;
  readonly registry: SessionRegistry;
  readonly messageApi: MessageAPI;
  readonly holder: RecordingHolder;
  readonly wiring: AwakeWiring;
  readonly awake: AwakeSession;
  readonly workEvents: SessionWorkEvent[];
  readonly logs: string[];
  post(event: Record<string, unknown>): Promise<Response>;
  /** The first hook event binds the transcript, so later main-agent hooks are admitted. */
  bind(): Promise<void>;
  stop(): Promise<void>;
}

async function buildFixture(
  options: { config?: AwakeConfig; clock?: AwakeClock } = {},
): Promise<Fixture> {
  configureLogger({ writeLog: () => {} });
  const sessionId = generateId();
  const directory = mkdtempSync(join(tmpdir(), 'remi-awake-wiring-'));
  const liveDirectory = join(directory, 'live-sessions');
  mkdirSync(liveDirectory, { recursive: true });
  const port = await reserveRange(1);
  const server = new HookServer({ port });
  const store = new SessionStore(join(directory, 'sessions.json'));
  const bindingStore = new SessionBindingStore(store);
  const liveSessions = new SessionRegistryFile(liveDirectory);
  const holder = new RecordingHolder();
  const logs: string[] = [];
  const wiring = new AwakeWiring({
    serveMode: false,
    platform: 'darwin',
    config: options.config ?? DEFAULTS,
    log: (message) => logs.push(message),
    session: { createHolder: () => holder, ...(options.clock && { clock: options.clock }) },
  });
  const registry = new SessionRegistry({ orphanTimeoutMs: 60_000 }, wiring.registryEvents({}));
  const messageApi = new MessageAPI(
    { sessionId },
    { onQuestion: (question) => registry.addQuestion(sessionId, question, 'awake-wiring-test') },
  );
  const workEvents: SessionWorkEvent[] = [];
  const unsubscribe = messageApi.subscribeWorkEvents((event) => workEvents.push(event));
  const awake = wiring.attach(sessionId, messageApi);
  if (!awake) throw new Error('keep-awake did not attach on darwin');
  registry.registerSession(sessionId, directory, new PTYSession({ cwd: directory }), messageApi);
  const bridge = setupHookBridge(
    {
      sessionRegistry: registry,
      bindingStore,
      liveSessionsRegistry: liveSessions,
      transcriptWatchers: new Map(),
      transcriptFallbackTimers: new Map(),
      currentPort: () => port,
      transcriptDiscovery: new TranscriptDiscovery(),
      holdMs: 5_000,
      hookTimeoutMs: 10_000,
    },
    {
      hookServer: server,
      sessionId,
      workingDirectory: directory,
      messageApi,
      sendAndRecord: () => {},
      tracker: new QuestionPresenceTracker((question) => messageApi.handleQuestion(question)),
      hasLocalTerminal: false,
    },
  );
  server.start();
  const post = (event: Record<string, unknown>) =>
    fetch(server.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: CLAUDE_SESSION_ID,
        transcript_path: join(directory, `${CLAUDE_SESSION_ID}.jsonl`),
        cwd: directory,
        ...event,
      }),
    });
  return {
    sessionId,
    directory,
    registry,
    messageApi,
    holder,
    wiring,
    awake,
    workEvents,
    logs,
    post,
    bind: async () => {
      const response = await post({
        hook_event_name: 'Notification',
        notification_type: 'auth_success',
        message: '',
      });
      expect(response.status).toBe(200);
    },
    stop: async () => {
      wiring.disposeAll();
      unsubscribe();
      bridge.closeBinder();
      server.stop();
      await registry.shutdown();
      __resetLoggerForTests();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

const question = (): Question => ({
  id: generateId(),
  text: 'Continue?',
  options: [],
  allowsFreeText: false,
  isAnswered: false,
  source: 'permission_request',
});

const count = (events: readonly SessionWorkEvent[], type: SessionWorkEvent['type']): number =>
  events.filter((event) => event.type === type).length;

test('real hook HTTP and session question changes drive the awake policy; Codex status shares the funnel', async () => {
  const f = await buildFixture({
    config: {
      level1: true,
      question_hold_minutes: 1,
      idle_grace_seconds: 1,
      stuck_busy_minutes: 1,
      ttl_minutes: 1,
    },
  });
  const { awake, holder, workEvents, registry, messageApi, post } = f;
  try {
    await f.bind();
    expect(
      (await post({ hook_event_name: 'UserPromptSubmit', prompt: 'reason without tools' })).status,
    ).toBe(200);
    expect(workEvents.some((event) => event.type === 'turn-open')).toBe(true);
    await waitUntil(() => awake.isHolding === true);
    expect(holder.starts).toBe(1);

    expect(
      (
        await post({
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_input: { file_path: '/tmp/awake-wire' },
          tool_use_id: 'toolu_awake_wire',
        })
      ).status,
    ).toBe(200);
    expect(
      workEvents.some((event) => event.type === 'status' && event.status === 'executing'),
    ).toBe(true);
    expect(workEvents.some((event) => event.type === 'activity')).toBe(true);
    expect(
      (
        await post({
          hook_event_name: 'PostToolUse',
          tool_name: 'Read',
          tool_input: { file_path: '/tmp/awake-wire' },
          tool_use_id: 'toolu_awake_wire',
          tool_response: { content: 'read' },
        })
      ).status,
    ).toBe(200);
    expect(workEvents.some((event) => event.type === 'status' && event.status === 'thinking')).toBe(
      true,
    );
    expect(awake.isHolding).toBe(true);

    const pending = question();
    messageApi.handleQuestion(pending, { held: true });
    expect(registry.getQuestion(f.sessionId, pending.id)).not.toBeNull();
    expect(awake.isHolding).toBe(true);
    registry.removeQuestion(f.sessionId, pending.id, 'answered');
    expect(registry.getQuestion(f.sessionId, pending.id)).toBeNull();

    expect((await post({ hook_event_name: 'Stop', stop_hook_active: false })).status).toBe(200);
    expect(workEvents.some((event) => event.type === 'turn-close')).toBe(true);
    await waitUntil(() => awake.isHolding === false);
    expect(holder.stops).toBe(1);

    // CodexSession.publish reports through this same MessageAPI status funnel.
    const codexEventStart = workEvents.length;
    messageApi.handleStatusChange('executing');
    expect(
      workEvents
        .slice(codexEventStart)
        .some((event) => event.type === 'status' && event.status === 'executing'),
    ).toBe(true);
    await waitUntil(() => awake.isHolding === true);
    expect(holder.starts).toBe(2);
    const turnClosesBeforeEnd = workEvents.filter((event) => event.type === 'turn-close').length;
    expect((await post({ hook_event_name: 'SessionEnd', reason: 'clear' })).status).toBe(200);
    expect(workEvents.filter((event) => event.type === 'turn-close').length).toBe(
      turnClosesBeforeEnd + 1,
    );
    expect(workEvents.at(-1)).toEqual({ type: 'status', status: 'idle' });
    await waitUntil(() => awake.isHolding === false);
    expect(holder.stops).toBe(2);

    // After /clear, Claude continues in the same PTY under a new session id.
    const clearedId = `${CLAUDE_SESSION_ID}-after-clear`;
    expect(
      (
        await post({
          hook_event_name: 'UserPromptSubmit',
          prompt: 'next turn after clear',
          session_id: clearedId,
          transcript_path: join(f.directory, `${clearedId}.jsonl`),
        })
      ).status,
    ).toBe(200);
    await waitUntil(() => awake.isHolding === true);
    expect(holder.starts).toBe(3);
  } finally {
    await f.stop();
  }
});

test('missing caffeinate logs once and leaves the session running without a hold', async () => {
  const messageApi = new MessageAPI({ sessionId: generateId() });
  const messages: string[] = [];
  const wiring = new AwakeWiring({
    serveMode: false,
    platform: 'darwin',
    config: {
      level1: true,
      question_hold_minutes: 1,
      idle_grace_seconds: 1,
      stuck_busy_minutes: 1,
      ttl_minutes: 1,
    },
    log: (message) => messages.push(message),
    session: {
      createHolder: (onUnexpectedExit) =>
        new AwakeHolder({
          targetPid: process.pid,
          ttlSeconds: 60,
          executable: '/__remi_awake_missing__/caffeinate',
          platform: 'darwin',
          onUnexpectedExit,
        }),
    },
  });
  const awake = wiring.attach(generateId(), messageApi);
  if (!awake) throw new Error('keep-awake did not attach on darwin');
  try {
    messageApi.handleStatusChange('executing');
    await waitUntil(() => messages.some((message) => message.includes('caffeinate unavailable')));
    expect(awake.isHolding).toBe(false);
    expect(messages.filter((message) => message.includes('caffeinate unavailable'))).toHaveLength(
      1,
    );
    expect(messages.find((message) => message.includes('caffeinate unavailable'))).toContain(
      'not found at /__remi_awake_missing__/caffeinate (ENOENT)',
    );
    expect(() => messageApi.handleStatusChange('thinking')).not.toThrow();
    expect(messages.filter((message) => message.includes('caffeinate unavailable'))).toHaveLength(
      1,
    );
  } finally {
    wiring.disposeAll();
  }
});

test('only a non-serve process on darwin with level1 on attaches keep-awake', async () => {
  expect(awakeApplies(false, 'darwin', DEFAULTS)).toBe(true);
  const cases: ReadonlyArray<readonly [boolean, NodeJS.Platform, boolean]> = [
    [true, 'darwin', true],
    [false, 'linux', true],
    [false, 'win32', true],
    [false, 'darwin', false],
  ];
  for (const [serveMode, platform, level1] of cases) {
    expect(awakeApplies(serveMode, platform, { ...DEFAULTS, level1 })).toBe(false);
    const holder = new RecordingHolder();
    const wiring = new AwakeWiring({
      serveMode,
      platform,
      config: { ...DEFAULTS, level1 },
      log: () => {},
      session: { createHolder: () => holder },
    });
    const messageApi = new MessageAPI({ sessionId: generateId() });
    expect(wiring.enabled).toBe(false);
    expect(wiring.attach(generateId(), messageApi)).toBeNull();
    messageApi.handleStatusChange('executing');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(holder.starts).toBe(0);
  }

  const holder = new RecordingHolder();
  const wiring = new AwakeWiring({
    serveMode: false,
    platform: 'darwin',
    config: DEFAULTS,
    log: () => {},
    session: { createHolder: () => holder },
  });
  const messageApi = new MessageAPI({ sessionId: generateId() });
  const sessionId = generateId();
  expect(wiring.attach(sessionId, messageApi)).toBe(wiring.session(sessionId) ?? null);
  messageApi.handleStatusChange('executing');
  await waitUntil(() => holder.starts === 1);
  wiring.disposeAll();
  expect(holder.stops).toBe(1);
});

test('a question alone holds through the registry, and its removal releases after the grace', async () => {
  const clock = new ManualClock();
  const f = await buildFixture({ clock });
  try {
    const pending = question();
    f.registry.addQuestion(f.sessionId, pending, 'awake-wiring-test');
    await waitUntil(() => f.awake.isHolding);
    expect(count(f.workEvents, 'turn-open')).toBe(0);
    expect(f.logs).toContain(`[Awake] Hold started for ${f.sessionId} (question)`);

    f.registry.removeQuestion(f.sessionId, pending.id, 'answered');
    clock.advance(119_999);
    expect(f.awake.isHolding).toBe(true);
    clock.advance(1);
    expect(f.awake.isHolding).toBe(false);
    expect(f.holder.stops).toBe(1);
    expect(f.logs.at(-1)).toBe(`[Awake] Hold ended for ${f.sessionId} (grace)`);
  } finally {
    await f.stop();
  }
});

test('an Escape-interrupted turn (UserPromptSubmit, no Stop) releases at the stuck bound with one warning', async () => {
  const clock = new ManualClock();
  const f = await buildFixture({ clock });
  try {
    await f.bind();
    expect(
      (await f.post({ hook_event_name: 'UserPromptSubmit', prompt: 'then Escape' })).status,
    ).toBe(200);
    await waitUntil(() => f.awake.isHolding);
    clock.advance(15 * 60_000 - 1);
    expect(f.awake.isHolding).toBe(true);
    clock.advance(1);
    expect(f.awake.isHolding).toBe(false);
    expect(f.logs.filter((message) => message.includes('stuck bound reached'))).toHaveLength(1);
    expect(f.logs.at(-1)).toBe(`[Awake] Hold ended for ${f.sessionId} (stuck bound)`);

    // Later PTY output does not re-arm the stale turn.
    f.messageApi.noteWorkEvent({ type: 'activity' });
    clock.advance(20 * 60_000);
    expect(f.awake.isHolding).toBe(false);
    expect(f.holder.starts).toBe(1);
    expect(f.logs.filter((message) => message.includes('stuck bound reached'))).toHaveLength(1);
  } finally {
    await f.stop();
  }
});

test('admitted PreToolUse and PostToolUse hooks are each an activity work event', async () => {
  const f = await buildFixture({ clock: new ManualClock() });
  try {
    await f.bind();
    await f.post({ hook_event_name: 'UserPromptSubmit', prompt: 'use a tool' });
    const before = count(f.workEvents, 'activity');
    expect(
      (
        await f.post({
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_input: { file_path: '/tmp/awake-activity' },
          tool_use_id: 'toolu_awake_activity',
        })
      ).status,
    ).toBe(200);
    expect(count(f.workEvents, 'activity')).toBe(before + 1);
    expect(
      (
        await f.post({
          hook_event_name: 'PostToolUse',
          tool_name: 'Read',
          tool_input: { file_path: '/tmp/awake-activity' },
          tool_use_id: 'toolu_awake_activity',
          tool_response: { content: 'read' },
        })
      ).status,
    ).toBe(200);
    expect(count(f.workEvents, 'activity')).toBe(before + 2);
  } finally {
    await f.stop();
  }
});

test('a main StopFailure closes the turn, so the hold ends after the grace', async () => {
  const clock = new ManualClock();
  const f = await buildFixture({ clock });
  try {
    await f.bind();
    await f.post({ hook_event_name: 'UserPromptSubmit', prompt: 'hit a rate limit' });
    await waitUntil(() => f.awake.isHolding);
    expect((await f.post({ hook_event_name: 'StopFailure', error: 'rate_limit' })).status).toBe(
      200,
    );
    expect(count(f.workEvents, 'turn-close')).toBe(1);
    clock.advance(120_000);
    expect(f.awake.isHolding).toBe(false);
    expect(f.logs.at(-1)).toBe(`[Awake] Hold ended for ${f.sessionId} (grace)`);
  } finally {
    await f.stop();
  }
});

test('SessionEnd with reason clear, then UserPromptSubmit, holds again', async () => {
  const clock = new ManualClock();
  const f = await buildFixture({ clock });
  try {
    await f.bind();
    await f.post({ hook_event_name: 'UserPromptSubmit', prompt: 'before clear' });
    await waitUntil(() => f.awake.isHolding);
    expect(f.holder.starts).toBe(1);
    expect((await f.post({ hook_event_name: 'SessionEnd', reason: 'clear' })).status).toBe(200);
    clock.advance(120_000);
    expect(f.awake.isHolding).toBe(false);
    expect(f.holder.stops).toBe(1);

    const clearedId = `${CLAUDE_SESSION_ID}-cleared`;
    await f.post({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'after clear',
      session_id: clearedId,
      transcript_path: join(f.directory, `${clearedId}.jsonl`),
    });
    await waitUntil(() => f.awake.isHolding);
    expect(f.holder.starts).toBe(2);
  } finally {
    await f.stop();
  }
});

test('a registry close disposes the session hold, and later work holds nothing', async () => {
  const f = await buildFixture({ clock: new ManualClock() });
  try {
    f.messageApi.handleStatusChange('executing');
    await waitUntil(() => f.awake.isHolding);
    f.registry.closeSession(f.sessionId, 'forced');
    expect(f.awake.isHolding).toBe(false);
    expect(f.holder.stops).toBe(1);
    expect(f.logs.at(-1)).toBe(`[Awake] Hold ended for ${f.sessionId} (session end)`);
    expect(f.wiring.session(f.sessionId)).toBeUndefined();
    f.messageApi.handleStatusChange('executing');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.holder.starts).toBe(1);
  } finally {
    await f.stop();
  }
});

test('disposeAll (daemon cleanup and exit) releases every attached session', async () => {
  const holders: RecordingHolder[] = [];
  const wiring = new AwakeWiring({
    serveMode: false,
    platform: 'darwin',
    config: DEFAULTS,
    log: () => {},
    session: {
      createHolder: () => {
        const holder = new RecordingHolder();
        holders.push(holder);
        return holder;
      },
    },
  });
  const ids = [generateId(), generateId()];
  const apis = ids.map((id) => new MessageAPI({ sessionId: id }));
  ids.forEach((id, index) => wiring.attach(id, apis[index] as MessageAPI));
  for (const api of apis) api.handleStatusChange('executing');
  await waitUntil(() => holders.every((holder) => holder.pid !== null));
  wiring.disposeAll();
  expect(holders.map((holder) => holder.stops)).toEqual([1, 1]);
  expect(ids.map((id) => wiring.session(id))).toEqual([undefined, undefined]);
});
