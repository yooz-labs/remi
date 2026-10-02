/**
 * The chat guard (#1140) driven from where its bugs lived: the REAL
 * `OutputProcessor` parsing PTY bytes, feeding the REAL
 * `QuestionPresenceTracker`, read by the REAL `createInputHandlers`
 * (`trackerScreenDeps`, the wiring `cli.ts` uses). The callbacks below mirror
 * `cli.ts`'s for a session with no hook server (`onQuestion` ->
 * `tracker.onPTYPromptVisible`, `onStatusChange` -> `tracker.onStatusChange`
 * with no agent, since a PTY-parsed status names none). The terminal is the
 * only double.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProtocolMessage, UUID } from '@remi/shared';
import { PROMPT_WAITING_ERROR_CODE } from '@remi/shared';
import { QuestionPresenceTracker } from '../../../src/api/question-presence-tracker.ts';
import { createInputHandlers, trackerScreenDeps } from '../../../src/cli/handlers/input-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
import { HookEventBridge } from '../../../src/hooks/hook-event-bridge.ts';
import type {
  PreToolUseHookInput,
  SubagentStartHookInput,
  SubagentStopHookInput,
} from '../../../src/hooks/hook-types.ts';
import { OutputProcessor } from '../../../src/parser/output-processor.ts';
import { SessionBindingStore } from '../../../src/session/session-binding-store.ts';
import { SessionRegistry } from '../../../src/session/session-registry.ts';
import { SessionStore } from '../../../src/session/session-store.ts';
import { WRAPPED_DIRECTORY_DIALOG } from '../../parser/fixtures/claude-dialogs.ts';
import { CID, type PtyCapture, errorsOf, fakeMessageAPI, fakePTY } from './menu-test-helpers.ts';

describe('chat guard driven by the real OutputProcessor (#1140)', () => {
  let sessionRegistry: SessionRegistry;
  let tmpDir: string;
  let sent: Array<{ connectionId: UUID; message: ProtocolMessage }>;
  let pty: PtyCapture;
  let sessionId: UUID;
  let tracker: QuestionPresenceTracker;
  let processor: OutputProcessor;
  let handlers: ReturnType<typeof createInputHandlers>;

  beforeEach(() => {
    sessionRegistry = new SessionRegistry({ orphanTimeoutMs: 1000 });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-chat-guard-op-'));
    sent = [];
    configureLogger({ writeLog: () => {} });
    pty = { writes: [], submits: [] };
    sessionId = sessionRegistry.createSessionId();
    sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(pty), fakeMessageAPI());
    sessionRegistry.attachConnection(sessionId, CID);
    tracker = new QuestionPresenceTracker((q) => {
      sessionRegistry.addQuestion(sessionId, q);
      return undefined;
    });
    processor = new OutputProcessor(
      { sessionId, streamStatusOnly: true },
      {
        onMessage: () => {},
        onQuestion: (question) => tracker.onPTYPromptVisible(question),
        onStatusChange: (status) => tracker.onStatusChange(status),
      },
    );
    handlers = createInputHandlers({
      sessionRegistry,
      bindingStore: new SessionBindingStore(new SessionStore(path.join(tmpDir, 'sessions.json'))),
      send: (connectionId, message) => {
        sent.push({ connectionId, message });
        return true;
      },
      ...trackerScreenDeps((sid) => (sid === sessionId ? tracker : undefined)),
    });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    await sessionRegistry.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Feed PTY output and let the processor parse it. */
  function screen(bytes: string): void {
    processor.process(bytes);
    processor.flush();
  }

  const observedValues = () => tracker.observedPromptOptions()?.map((o) => o.value) ?? null;

  describe('which observed prompts refuse chat', () => {
    test('a numbered selection box refuses', async () => {
      screen(WRAPPED_DIRECTORY_DIALOG);
      expect(observedValues()).toEqual(['1', '2', '3']);

      await handlers.onUserInput(CID, sessionId, 'use rm -i instead', false);

      expect(pty.submits).toEqual([]);
      const errors = errorsOf(sent);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe(PROMPT_WAITING_ERROR_CODE);
    });

    test('a subprocess (y/n) prompt is observed with options y/n and still takes chat text', async () => {
      screen('Overwrite existing file? (y/n) ');
      expect(observedValues()).toEqual(['y', 'n']);

      await handlers.onUserInput(CID, sessionId, 'y', false);

      expect(pty.submits).toEqual(['y']);
      expect(errorsOf(sent)).toHaveLength(0);
    });

    test('Claude prose ending in (y/n) stays typeable too', async () => {
      screen('The lockfile is out of date, so I can regenerate it. Should I go ahead? (y/n) ');
      expect(observedValues()).toEqual(['y', 'n']);

      await handlers.onUserInput(CID, sessionId, 'yes, but keep the old one', false);

      expect(pty.submits).toEqual(['yes, but keep the old one']);
      expect(errorsOf(sent)).toHaveLength(0);
    });

    test('a free-text waiting prompt observes no options and takes chat text', async () => {
      screen('Please enter your response: ');
      expect(observedValues()).toEqual([]);

      await handlers.onUserInput(CID, sessionId, 'my answer', false);

      expect(pty.submits).toEqual(['my answer']);
      expect(errorsOf(sent)).toHaveLength(0);
    });
  });
  /**
   * What clears the observation, driven from both status sources: a PTY-parsed
   * status (the OutputProcessor, naming no agent) clears as it always did, and
   * a hook status from a subagent or teammate (the real `HookEventBridge`, its
   * `onStatusChange` wired to the tracker exactly as `setupHookBridge` does it,
   * which `hook-bridge-setup.test.ts` drives through the real listeners) does
   * not.
   */
  describe('what clears the observation (#1140)', () => {
    let bridge: HookEventBridge;

    beforeEach(() => {
      bridge = new HookEventBridge(
        sessionId,
        {
          onStatusChange: (status, _context, agentId) =>
            tracker.onStatusChange(status, { agentId }),
          onQuestion: () => undefined,
        },
        '/test/dir',
      );
    });

    const common = {
      session_id: 'claude-1',
      transcript_path: '/tmp/t.jsonl',
      cwd: '/test/dir',
      permission_mode: 'default',
    };

    test('a subagent starting and stopping while the dialog is up does not unlock the chat', async () => {
      screen(WRAPPED_DIRECTORY_DIALOG);
      expect(observedValues()).toEqual(['1', '2', '3']);

      bridge.handleSubagentStart({
        ...common,
        hook_event_name: 'SubagentStart',
        agent_id: 'sub-1',
        agent_type: 'general-purpose',
      } as SubagentStartHookInput);
      await handlers.onUserInput(CID, sessionId, 'after the subagent started', false);
      bridge.handleSubagentStop({
        ...common,
        hook_event_name: 'SubagentStop',
        agent_id: 'sub-1',
      } as SubagentStopHookInput);
      await handlers.onUserInput(CID, sessionId, 'after the subagent stopped', false);

      expect(observedValues()).toEqual(['1', '2', '3']);
      expect(pty.submits).toEqual([]);
      expect(errorsOf(sent)).toHaveLength(2);
    });

    test('the main agent moving on (a hook event with no agent_id) unlocks it', async () => {
      screen(WRAPPED_DIRECTORY_DIALOG);
      bridge.handlePreToolUse({
        ...common,
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      } as PreToolUseHookInput);

      expect(observedValues()).toBeNull();
      await handlers.onUserInput(CID, sessionId, 'typed now', false);
      expect(pty.submits).toEqual(['typed now']);
      expect(errorsOf(sent)).toHaveLength(0);
    });

    test('a PTY-parsed non-waiting status (it names no agent) clears it as before', async () => {
      screen(WRAPPED_DIRECTORY_DIALOG);
      expect(observedValues()).toEqual(['1', '2', '3']);

      // A tool-use line: the real parser reads it as 'executing'.
      screen('\u23fa Running the test suite\n');

      expect(observedValues()).toBeNull();
      await handlers.onUserInput(CID, sessionId, 'typed now', false);
      expect(pty.submits).toEqual(['typed now']);
      expect(errorsOf(sent)).toHaveLength(0);
    });

    test('a subagent status after a PTY-parsed one changes nothing: still unlocked', async () => {
      screen(WRAPPED_DIRECTORY_DIALOG);
      screen('\u23fa Running the test suite\n');
      bridge.handleSubagentStart({
        ...common,
        hook_event_name: 'SubagentStart',
        agent_id: 'sub-1',
        agent_type: 'general-purpose',
      } as SubagentStartHookInput);

      expect(observedValues()).toBeNull();
    });
  });
});
