import { test, expect, afterAll } from 'bun:test';
import * as os from 'node:os';
import type { Question, ProtocolMessage, ErrorMessage } from '@remi/shared';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  generateId,
  createHello,
  createHelloAck,
  createUserInput,
  createTranscriptContent,
  now,
} from '@remi/shared';
import { WebSocketAdapter } from '../../../daemon/src/adapters/websocket-adapter.ts';
import { WebSocketClient } from '../../src/lib/websocket-client.ts';
import {
  partialInputMessageId,
  markPartialInput,
  markInputReceipt,
} from '../../src/lib/input-refusal.ts';
import { mergeResyncSurvivors, selectResyncSurvivors } from '../../src/lib/message-resync.ts';
import { deduplicateMessage } from '../../src/lib/message-dedup.ts';
import { createSessionHandlers } from '../../../daemon/src/cli/handlers/session-events.ts';
import { ClaudeHarness } from '../../../daemon/src/harness/claude.ts';
import { TranscriptDiscovery } from '../../../daemon/src/transcript/transcript-discovery.ts';
import { SessionRegistryFile } from '../../../daemon/src/session/session-registry-file.ts';
import { reserveRange } from '../../../daemon/tests/session/port-test-helpers.ts';
import { PTYSession } from '../../../daemon/src/pty/pty-session.ts';
import { MessageAPI } from '../../../daemon/src/api/message-api.ts';
import { QuestionPresenceTracker } from '../../../daemon/src/api/question-presence-tracker.ts';
import { AutoApproveGate } from '../../../daemon/src/auto-approve/auto-approve-gate.ts';
import { HookEventBridge } from '../../../daemon/src/hooks/hook-event-bridge.ts';
import { HookServer } from '../../../daemon/src/hooks/hook-server.ts';
import { SessionRegistry } from '../../../daemon/src/session/session-registry.ts';
import { SessionStore } from '../../../daemon/src/session/session-store.ts';
import { SessionBindingStore } from '../../../daemon/src/session/session-binding-store.ts';
import {
  createInputHandlers,
  trackerScreenDeps,
} from '../../../daemon/src/cli/handlers/input-events.ts';
import { promptUpDeps } from '../../../daemon/src/cli/handlers/prompt-up.ts';
import { configureLogger } from '../../../daemon/src/cli/logger.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-queued-input-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
fs.mkdirSync(path.join(root, 'state'), { recursive: true, mode: 0o700 });
const logs: string[] = [];
configureLogger({ writeLog: (message) => logs.push(message) });

async function until(check: () => boolean, description: string) {
  const end = Date.now() + 2000;
  while (!check() && Date.now() < end) await Bun.sleep(2);
  if (!check()) throw new Error(description);
}
function requireFact(value: unknown, message: string) {
  if (!value) throw new Error(message);
}

for (const scenario of [
  'prompt-already-up',
  'prompt-appears-while-queued',
  'prompt-appears-before-enter',
  'detach-while-queued',
  'binding-rotates-while-queued',
  'healthy',
  'raw-during-prompt',
  'wire-partial',
  'stop-while-queued',
  'stop-before-enter',
])
  test(scenario, async () => {
    const dir = fs.mkdtempSync(path.join(root, 'state', `${scenario}-`));
    fs.chmodSync(dir, 0o700);
    const sid = generateId();
    let cid = generateId();
    let adapter: WebSocketAdapter | undefined;
    let client: WebSocketClient | undefined;
    const received: ProtocolMessage[] = [];
    const bindingId = generateId();
    const targetId = generateId();
    const started = performance.now();
    let output = '';
    const events: unknown[] = [];
    const errors: ProtocolMessage[] = [];
    let heldQuestion: Question | undefined;
    const pty = new PTYSession(
      { command: '/bin/cat', args: [], cwd: dir, env: { HOME: dir, REMI_HOME: dir } },
      {
        onData(data) {
          output += data;
          events.push({
            atMs: performance.now() - started,
            kind: 'real-pty-output',
            data,
            held: gate?.hasMainHold() ?? false,
          });
        },
      },
    );
    const registry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    const api = new MessageAPI(
      { sessionId: sid },
      {
        onQuestion: (q) => {
          heldQuestion = q;
          registry.addQuestion(sid, q, q.source ?? 'unknown');
        },
      },
    );
    const binding = new SessionBindingStore(new SessionStore(path.join(dir, 'sessions.json')));
    binding.preAssign({
      remiSessionId: sid,
      claudeSessionId: bindingId,
      projectPath: dir,
      port: 12345,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      exitedAt: null,
      exitCode: null,
    });
    const tracker = new QuestionPresenceTracker((q, opts) => api.handleQuestion(q, opts));
    const bridge = new HookEventBridge(sid, {
      onQuestion: (q) => {
        tracker.recordPendingHook(q);
        return undefined;
      },
      onStatusChange: () => {},
    });
    const gate = new AutoApproveGate(
      {
        sessionRegistry: registry,
        isInSubagentContext: () => bridge.isInSubagentContext(),
        hasLocalTerminal: true,
        holdMs: 60000,
        escalate: (input) => bridge.handlePermissionRequest(input),
        onHeldEscalate: (id, answerPath) => tracker.pushHeldHook(id, answerPath),
      },
      sid,
    );
    tracker.setHookPromptProbe(() => gate!.hasOpenHookPrompt());
    const prompt = promptUpDeps(
      () => gate,
      () => tracker,
    );
    const handlers = createInputHandlers({
      sessionRegistry: registry,
      bindingStore: binding,
      send: (_cid, message) => {
        errors.push(message);
        return adapter?.sendRaw(_cid, message) ?? true;
      },
      ...prompt,
      ...trackerScreenDeps(() => tracker),
    });
    const hook = new HookServer({ port: 0, hostname: '127.0.0.1' });
    hook.setPermissionResolver((input, signal) => gate!.resolvePermission(input, signal));
    let response: Promise<Response> | undefined;
    const hold = async () => {
      response = fetch(hook.url, {
        method: 'POST',
        body: JSON.stringify({
          session_id: bindingId,
          transcript_path: path.join(dir, 'transcript.jsonl'),
          cwd: dir,
          permission_mode: 'default',
          hook_event_name: 'PermissionRequest',
          tool_name: 'Bash',
          tool_input: { command: 'printf owned-probe' },
        }),
      });
      await until(() => gate!.hasMainHold(), 'real PermissionRequest did not establish its hold');
      events.push({
        atMs: performance.now() - started,
        kind: 'real-http-hold-established',
        prompt: prompt.promptUp(sid),
        targetAlreadyWritten: output.includes('QUEUED_CHAT_PROBE'),
      });
    };
    try {
      await pty.start();
      registry.registerSession(sid, dir, pty, api, false, true);
      requireFact(
        registry.attachConnection(sid, cid).success,
        'could not attach actual connection',
      );
      hook.start();
      requireFact(prompt.promptUp(sid) === null, 'precondition: prompt should be absent');
      if (scenario === 'wire-partial') {
        const port = await reserveRange(1, 20, '127.0.0.1');
        adapter = new WebSocketAdapter(
          { port, host: '127.0.0.1' },
          {
            onConnect(id) {
              cid = id;
              registry.attachConnection(sid, cid);
              adapter!.sendRaw(cid, createHelloAck('1.0.0', sid));
            },
            onUserInput: handlers.onUserInput,
          },
        );
        await adapter.start();
        client = new WebSocketClient(
          { url: `ws://127.0.0.1:${port}/ws`, autoReconnect: false, heartbeatInterval: 0 },
          {
            onStatusChange(status) {
              if (status === 'authenticating')
                client!.send(createHello(generateId(), 'owned-queue-proof'));
            },
            onMessage(message) {
              received.push(message);
            },
          },
        );
        client.connect();
        await until(
          () => received.some((m) => m.type === 'hello_ack'),
          'actual wire hello missing',
        );
      }
      if (['prompt-already-up', 'raw-during-prompt'].includes(scenario)) await hold();
      const primers = [
        'prompt-already-up',
        'prompt-appears-before-enter',
        'raw-during-prompt',
        'wire-partial',
        'stop-before-enter',
      ].includes(scenario)
        ? []
        : Array.from({ length: 4 }, (_, i) =>
            handlers.onUserInput(cid, sid, `PRIMER_${i}`, false, bindingId, generateId()),
          );
      let queued: Promise<void> = Promise.resolve();
      if (scenario.startsWith('stop-')) {
        const discovery = new TranscriptDiscovery({ projectsDir: path.join(dir, 'projects') });
        const stop = createSessionHandlers({
          sessionRegistry: registry,
          bindingStore: binding,
          transcriptDiscovery: discovery,
          harness: new ClaudeHarness(discovery),
          liveSessionsRegistry: new SessionRegistryFile(path.join(dir, 'live-sessions')),
          currentPort: () => 12345,
          untrackConnection: () => {},
          onConnectionRemoved: () => {},
          send: (_id, message) => {
            errors.push(message);
            return true;
          },
          ...prompt,
          exitFallbackMs: 1000,
        });
        stop.onKillSessionRequest(cid, sid, targetId);
      } else if (scenario === 'wire-partial') {
        client!.send(createUserInput(sid, 'QUEUED_CHAT_PROBE', undefined, bindingId, targetId));
      } else
        queued = handlers.onUserInput(
          cid,
          sid,
          'QUEUED_CHAT_PROBE',
          scenario === 'raw-during-prompt',
          bindingId,
          targetId,
        );
      events.push({
        atMs: performance.now() - started,
        kind: 'target-handler-returned-promise',
        prompt: prompt.promptUp(sid),
      });
      if (['prompt-appears-while-queued', 'stop-while-queued'].includes(scenario)) await hold();
      if (['prompt-appears-before-enter', 'wire-partial', 'stop-before-enter'].includes(scenario)) {
        const marker = scenario === 'stop-before-enter' ? '/exit' : 'QUEUED_CHAT_PROBE';
        await until(() => output.includes(marker), 'target text was not observed before its Enter');
        requireFact(!output.includes(`${marker}\r`), 'Enter arrived before the late-prompt probe');
        await hold();
        requireFact(!output.includes(`${marker}\r`), 'Enter beat actual held prompt establishment');
      }
      if (scenario === 'detach-while-queued') {
        registry.detachConnection(cid, true);
        events.push({
          atMs: performance.now() - started,
          kind: 'actual-registry-detached',
          attached: Boolean(registry.getSessionForConnection(cid)),
        });
      }
      if (scenario === 'binding-rotates-while-queued') {
        binding.update(sid, generateId());
        events.push({
          atMs: performance.now() - started,
          kind: 'actual-durable-binding-rotated',
          currentBinding: binding.getIdentity(sid)?.harnessSessionId,
        });
      }
      await Promise.all([...primers, queued]);
      await Bun.sleep(100);
      const targetWritten = output.includes('QUEUED_CHAT_PROBE\r');
      if (scenario === 'wire-partial')
        await until(
          () => received.some((m) => m.type === 'error' && partialInputMessageId(m) === targetId),
          'actual correlated wire refusal missing',
        );
      const refusal = errors.find(
        (e): e is ErrorMessage => e.type === 'error' && e.details?.['messageId'] === targetId,
      );
      if (scenario.startsWith('stop-')) {
        await until(() => !registry.getSession(sid), 'Stop did not force-close stale context');
        expect(output.includes('/exit\r')).toBe(false);
        expect(output.includes('/exit')).toBe(scenario === 'stop-before-enter');
      } else if (scenario === 'healthy') {
        expect(targetWritten).toBe(true);
        expect(refusal).toBeUndefined();
      } else if (scenario === 'raw-during-prompt') {
        expect(output.includes('QUEUED_CHAT_PROBE')).toBe(true);
        expect(targetWritten).toBe(false);
        expect(refusal).toBeUndefined();
      } else if (['prompt-appears-before-enter', 'wire-partial'].includes(scenario)) {
        expect(output.includes('QUEUED_CHAT_PROBE')).toBe(true);
        expect(targetWritten).toBe(false);
        expect(refusal?.code).toBe('PROMPT_WAITING');
        expect(refusal?.details?.['inputMayBePartial']).toBe(true);
      } else {
        expect(output.includes('QUEUED_CHAT_PROBE')).toBe(false);
        expect(refusal?.details?.['inputMayBePartial']).toBeUndefined();
        expect(refusal?.code).toBe(
          scenario === 'detach-while-queued'
            ? 'SESSION_NOT_FOUND'
            : scenario === 'binding-rotates-while-queued'
              ? 'STALE_BINDING'
              : 'PROMPT_WAITING',
        );
      }
      if (scenario === 'wire-partial') {
        const receipt = received.findIndex((m) => m.type === 'ack' && m.ack.messageId === targetId);
        const rejection = received.findIndex(
          (m) => m.type === 'error' && partialInputMessageId(m) === targetId,
        );
        expect(receipt).toBeGreaterThanOrEqual(0);
        expect(rejection).toBeGreaterThan(receipt);
        const bubble = markPartialInput({
          id: targetId,
          sessionId: sid,
          sender: 'user',
          content: 'QUEUED_CHAT_PROBE',
          timestamp: new Date().toISOString(),
          state: 'delivered',
          isEditing: false,
        });
        expect(markInputReceipt(bubble)).toBe(bubble);
        expect(bubble.inputMayBePartial).toBe(true);
        const transcriptCopy = {
          ...bubble,
          id: generateId(),
          inputMayBePartial: false,
          state: 'delivered' as const,
        };
        expect(selectResyncSurvivors([bubble], sid)).toContain(bubble);
        expect(mergeResyncSurvivors([transcriptCopy], [bubble])).toContain(bubble);
        const transcriptId = generateId();
        api.handleMessage({
          id: transcriptId,
          sessionId: sid,
          sender: 'user',
          content: bubble.content,
          createdAt: now(),
          state: 'sent',
          stateChangedAt: now(),
          isEditing: false,
        });
        const structured = api.getMessage(transcriptId);
        if (!structured) throw new Error('No actual MessageAPI transcript structure');
        adapter!.sendRaw(
          cid,
          createTranscriptContent(sid, transcriptId, 'user', bubble.content, structured, false),
        );
        await until(
          () =>
            received.some((m) => m.type === 'transcript_content' && m.entryUuid === transcriptId),
          'Matching transcript did not cross the real wire',
        );
        const actualTranscript = received.find(
          (m) => m.type === 'transcript_content' && m.entryUuid === transcriptId,
        );
        if (actualTranscript?.type !== 'transcript_content')
          throw new Error('No actual transcript frame');
        expect(
          deduplicateMessage([bubble], {
            sessionId: actualTranscript.sessionId,
            sender: actualTranscript.role,
            content: actualTranscript.content,
            entryUuid: actualTranscript.entryUuid,
            source: 'transcript',
          }),
        ).toEqual({ action: 'add' });
      }
      if (scenario === 'detach-while-queued') {
        registry.attachConnection(sid, cid);
        await handlers.onUserInput(
          cid,
          sid,
          'HEALTHY_AFTER_REFUSAL',
          false,
          bindingId,
          generateId(),
        );
        await until(
          () => output.includes('HEALTHY_AFTER_REFUSAL\r'),
          'queue was poisoned by refusal',
        );
        expect(output.includes('HEALTHY_AFTER_REFUSAL\r')).toBe(true);
      }
    } finally {
      const q = heldQuestion;
      if (q && gate.hasMainHold()) {
        const no = q.options.find((o) => o.isNo);
        if (no) gate.answerHeld(q.id, { kind: 'option', option: no });
      }
      if (response) await response;
      client?.disconnect();
      await adapter?.stop();
      hook.stop();
      gate.cancelStale('owned diagnosis complete');
      await registry.shutdown();
      await pty.close(2000);
    }
  }, 10000);
