/**
 * Session precedent must be scoped to the private hook working directory.
 *
 * This drives the real AutoApproveService with a real PrecedentStore and an
 * unreachable model endpoint. The matching case can only pass by taking the
 * pre-LLM precedent path; the other cases must not approve from that record.
 */

import { describe, expect, test } from 'bun:test';
import { generateId } from '@remi/shared';
import type { UUID } from '@remi/shared';
import { QuestionPresenceTracker } from '../../src/api/question-presence-tracker.ts';
import {
  type AutoApproveEvaluator,
  AutoApproveGate,
} from '../../src/auto-approve/auto-approve-gate.ts';
import { AutoApproveService } from '../../src/auto-approve/auto-approve-service.ts';
import {
  PrecedentStore,
  readerFrom,
  signatureForOperation,
} from '../../src/auto-approve/precedent.ts';
import type { AutoApproveConfig } from '../../src/auto-approve/types.ts';
import type { PermissionRequestHookInput } from '../../src/hooks/index.ts';
import type { PTYSession } from '../../src/pty/pty-session.ts';
import { SessionRegistry } from '../../src/session/session-registry.ts';

const MODEL_URL = 'http://127.0.0.1:1';
const PROJECT_CWD = '/tmp/remi-context-project';

function makeConfig(): AutoApproveConfig {
  return {
    enabled: true,
    provider: 'openai',
    model: 'test-model',
    api_key: '',
    base_url: MODEL_URL,
    timeout: 1,
    log_decisions: false,
    residual_action: 'escalate',
    allow: [],
    deny: [],
    subagent_alert: [],
    approve_groups: [],
    level: 'strict',
    deny_groups: [],
    instructions: '',
    multichoice: 'skip',
    multichoice_model: '',
    escalate_model: '',
    escalate_timeout: 0,
    queue_timeout: 0,
    cache_idle: 0,
    keep_alive: 0,
    engine: 'owned',
    engine_path: '',
    model_cache: '',
    disable_thinking: true,
    always_escalate_tools: [],
    session_precedent: true,
    hold_timeout: 0,
    push_hold_timeout: 0,
    delivery_confirm_timeout: 0,
    hold_unconfirmed_timeout: 0,
  };
}

describe('AutoApproveService session precedent context', () => {
  test('reuses an approval only in the originating normalized project', async () => {
    const store = new PrecedentStore();
    const input = { command: 'git status' };
    store.record('Bash', signatureForOperation('Bash', input), 'approved', true, PROJECT_CWD);
    const service = new AutoApproveService(makeConfig(), () => {});

    const sameProject = await service.evaluate(
      'Bash',
      input,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      readerFrom(store),
      undefined,
      `${PROJECT_CWD}/child/..`,
    );
    expect(sameProject.decision).toBe('approve');
    expect(sameProject.durationMs).toBe(0);

    const siblingProject = await service.evaluate(
      'Bash',
      input,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      readerFrom(store),
      undefined,
      '/tmp/remi-other-project',
    );
    expect(siblingProject.decision).toBe('escalate');

    const missingContext = await service.evaluate(
      'Bash',
      input,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      readerFrom(store),
      undefined,
      undefined,
    );
    expect(missingContext.decision).toBe('escalate');
  });

  test('the gate uses the canonical session directory when hook cwd changes', async () => {
    const sessionId = generateId() as UUID;
    const registry = new SessionRegistry({ orphanTimeoutMs: 60_000 });
    const pty = {
      id: generateId(),
      isRunning: true,
      write: () => {},
      submitInput: async () => {},
      close: async () => {},
    } as unknown as PTYSession;
    registry.registerSession(sessionId, PROJECT_CWD, pty, {
      handleMessage: () => {},
      handleQuestion: () => {},
      handleStatusChange: () => {},
    } as never);

    let receivedDirectory: string | undefined;
    const evaluator: AutoApproveEvaluator = {
      evaluate: async (
        _toolName,
        _toolInput,
        _tag,
        _suggestions,
        _modelOverride,
        _evalId,
        _scope,
        _isSubagent,
        _authority,
        _precedent,
        _agentType,
        workingDirectory,
      ) => {
        receivedDirectory = workingDirectory;
        return { decision: 'escalate', reasoning: 'test', durationMs: 0, model: 'test' };
      },
      cancel: () => true,
    };
    const gate = new AutoApproveGate(
      {
        service: evaluator,
        sessionRegistry: registry,
        tracker: new QuestionPresenceTracker(() => undefined),
        isInSubagentContext: () => false,
        escalate: () => generateId(),
        workingDirectory: PROJECT_CWD,
      },
      sessionId,
    );

    try {
      const input: PermissionRequestHookInput = {
        session_id: 'claude-test',
        transcript_path: '/tmp/t.jsonl',
        cwd: '/tmp/remi-other-project',
        permission_mode: 'default',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'git status' },
      };
      expect(await gate.resolvePermission(input)).toBe('passthrough');
      expect(receivedDirectory).toBe(PROJECT_CWD);
    } finally {
      await registry.shutdown();
    }
  });
});
