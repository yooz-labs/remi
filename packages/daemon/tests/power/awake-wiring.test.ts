import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateId } from '@remi/shared';
import type { Question } from '@remi/shared';
import { MessageAPI, type SessionWorkEvent } from '../../src/api/message-api.ts';
import { QuestionPresenceTracker } from '../../src/api/question-presence-tracker.ts';
import { __resetLoggerForTests, configureLogger } from '../../src/cli/logger.ts';
import { setupHookBridge } from '../../src/cli/session-phases/hook-bridge-setup.ts';
import type { AwakeConfig } from '../../src/config/config.ts';
import { HookServer } from '../../src/hooks/hook-server.ts';
import { AwakeHolder } from '../../src/power/awake-holder.ts';
import type { AwakeHolderBoundary, AwakeHolderResult } from '../../src/power/awake-holder.ts';
import { AwakeSession } from '../../src/power/awake-session.ts';
import { PTYSession } from '../../src/pty/pty-session.ts';
import { SessionBindingStore } from '../../src/session/session-binding-store.ts';
import { SessionRegistryFile } from '../../src/session/session-registry-file.ts';
import { SessionRegistry } from '../../src/session/session-registry.ts';
import { SessionStore } from '../../src/session/session-store.ts';
import { TranscriptDiscovery } from '../../src/transcript/index.ts';
import { reserveRange } from '../session/port-test-helpers.ts';

const SESSION_ID = generateId();
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

async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('awake wiring did not reach the expected state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('real hook HTTP and session question changes drive the awake policy; Codex status shares the funnel', async () => {
  configureLogger({ writeLog: () => {} });
  const directory = mkdtempSync(join(tmpdir(), 'remi-awake-wiring-'));
  const liveDirectory = join(directory, 'live-sessions');
  mkdirSync(liveDirectory, { recursive: true });
  const port = await reserveRange(1);
  const server = new HookServer({ port });
  const store = new SessionStore(join(directory, 'sessions.json'));
  const bindingStore = new SessionBindingStore(store);
  const liveSessions = new SessionRegistryFile(liveDirectory);
  const holder = new RecordingHolder();
  const awakeConfig: AwakeConfig = {
    level1: true,
    question_hold_minutes: 1,
    idle_grace_seconds: 1,
    stuck_busy_minutes: 1,
    ttl_minutes: 1,
  };
  let awake: AwakeSession | undefined;
  const registry = new SessionRegistry(
    { orphanTimeoutMs: 60_000 },
    {
      onQuestionsChanged: (id, questions) =>
        id === SESSION_ID && awake?.questionsChanged(questions.length),
    },
  );
  const messageApi = new MessageAPI(
    { sessionId: SESSION_ID },
    {
      onQuestion: (question) => registry.addQuestion(SESSION_ID, question, 'awake-wiring-test'),
    },
  );
  const workEvents: SessionWorkEvent[] = [];
  const unsubscribeWorkEvents = messageApi.subscribeWorkEvents((event) => workEvents.push(event));
  awake = new AwakeSession(SESSION_ID, messageApi, awakeConfig, () => {}, {
    createHolder: () => holder,
  });
  const pty = new PTYSession({ cwd: directory });
  registry.registerSession(SESSION_ID, directory, pty, messageApi);
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
      sessionId: SESSION_ID,
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

  try {
    expect(
      (
        await post({
          hook_event_name: 'Notification',
          notification_type: 'auth_success',
          message: '',
        })
      ).status,
    ).toBe(200);
    expect(
      (await post({ hook_event_name: 'UserPromptSubmit', prompt: 'reason without tools' })).status,
    ).toBe(200);
    expect(workEvents.some((event) => event.type === 'turn-open')).toBe(true);
    await waitUntil(() => awake?.isHolding === true);
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

    const question: Question = {
      id: generateId(),
      text: 'Continue?',
      options: [],
      allowsFreeText: false,
      isAnswered: false,
      source: 'permission_request',
    };
    messageApi.handleQuestion(question, { held: true });
    expect(registry.getQuestion(SESSION_ID, question.id)).not.toBeNull();
    expect(awake.isHolding).toBe(true);
    registry.removeQuestion(SESSION_ID, question.id, 'answered');
    expect(registry.getQuestion(SESSION_ID, question.id)).toBeNull();

    expect((await post({ hook_event_name: 'Stop', stop_hook_active: false })).status).toBe(200);
    expect(workEvents.some((event) => event.type === 'turn-close')).toBe(true);
    await waitUntil(() => awake?.isHolding === false);
    expect(holder.stops).toBe(1);

    // CodexSession.publish reports through this same MessageAPI status funnel.
    const codexEventStart = workEvents.length;
    messageApi.handleStatusChange('executing');
    expect(
      workEvents
        .slice(codexEventStart)
        .some((event) => event.type === 'status' && event.status === 'executing'),
    ).toBe(true);
    await waitUntil(() => awake?.isHolding === true);
    expect(holder.starts).toBe(2);
    const turnClosesBeforeEnd = workEvents.filter((event) => event.type === 'turn-close').length;
    expect((await post({ hook_event_name: 'SessionEnd', reason: 'clear' })).status).toBe(200);
    expect(workEvents.filter((event) => event.type === 'turn-close').length).toBe(
      turnClosesBeforeEnd + 1,
    );
    expect(workEvents.at(-1)).toEqual({ type: 'status', status: 'idle' });
    await waitUntil(() => awake?.isHolding === false);
    expect(holder.stops).toBe(2);

    // After /clear, Claude continues in the same PTY under a new session id.
    const clearedId = `${CLAUDE_SESSION_ID}-after-clear`;
    expect(
      (
        await post({
          hook_event_name: 'UserPromptSubmit',
          prompt: 'next turn after clear',
          session_id: clearedId,
          transcript_path: join(directory, `${clearedId}.jsonl`),
        })
      ).status,
    ).toBe(200);
    await waitUntil(() => awake?.isHolding === true);
    expect(holder.starts).toBe(3);
  } finally {
    awake.dispose();
    unsubscribeWorkEvents();
    bridge.closeBinder();
    server.stop();
    await registry.shutdown();
    __resetLoggerForTests();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('missing caffeinate logs once and leaves the session running without a hold', async () => {
  const messageApi = new MessageAPI({ sessionId: generateId() });
  const messages: string[] = [];
  const awake = new AwakeSession(
    generateId(),
    messageApi,
    {
      level1: true,
      question_hold_minutes: 1,
      idle_grace_seconds: 1,
      stuck_busy_minutes: 1,
      ttl_minutes: 1,
    },
    (message) => messages.push(message),
    {
      createHolder: (onUnexpectedExit) =>
        new AwakeHolder({
          targetPid: process.pid,
          ttlSeconds: 60,
          executable: '/__remi_awake_missing__/caffeinate',
          platform: 'darwin',
          onUnexpectedExit,
        }),
    },
  );
  try {
    messageApi.handleStatusChange('executing');
    await waitUntil(() => messages.some((message) => message.includes('caffeinate unavailable')));
    expect(awake.isHolding).toBe(false);
    expect(messages.filter((message) => message.includes('caffeinate unavailable'))).toHaveLength(
      1,
    );
    expect(() => messageApi.handleStatusChange('thinking')).not.toThrow();
    expect(messages.filter((message) => message.includes('caffeinate unavailable'))).toHaveLength(
      1,
    );
  } finally {
    awake.dispose();
  }
});
