import { describe, expect, test } from 'bun:test';
import {
  type AutoApprovePrimaryLLMTrace,
  AutoApproveService,
} from '../../src/auto-approve/auto-approve-service.ts';
import { groupsForLevel } from '../../src/auto-approve/levels.ts';
import type { AutoApproveConfig } from '../../src/auto-approve/types.ts';
import { RESIDUAL_MODEL_BANK } from './residual-model-bank.ts';

let nextResidualModelPort = 19_980;

function makeConfig(overrides: Partial<AutoApproveConfig> = {}): AutoApproveConfig {
  return {
    enabled: true,
    provider: 'residual-bank-fixture',
    model: 'residual-bank-model',
    api_key: '',
    base_url: 'http://127.0.0.1:1',
    timeout: 2,
    log_decisions: false,
    residual_action: 'escalate',
    risk_review: 'off',
    allow: [],
    deny: [],
    subagent_alert: [],
    approve_groups: groupsForLevel('strict'),
    level: 'strict',
    deny_groups: [],
    instructions: '',
    multichoice: 'skip',
    multichoice_model: '',
    escalate_model: '',
    escalate_timeout: 0,
    queue_timeout: 2,
    cache_idle: 0,
    keep_alive: 0,
    engine: 'owned',
    engine_path: '',
    model_cache: '',
    disable_thinking: true,
    always_escalate_tools: [],
    session_precedent: false,
    hold_timeout: 0,
    push_hold_timeout: 0,
    delivery_confirm_timeout: 0,
    hold_unconfirmed_timeout: 0,
    ...overrides,
  };
}

describe('residual model bank', () => {
  test('pins the deterministic control against the exact residual compounds', () => {
    const service = new AutoApproveService(makeConfig(), () => undefined);

    for (const sample of RESIDUAL_MODEL_BANK) {
      const verdict = service.evaluateDeterministic('Bash', { command: sample.command });
      if (sample.expectedRoute === 'deterministic') {
        expect(verdict?.decision, sample.id).toBe('approve');
      } else {
        expect(verdict, sample.id).toBeNull();
      }
    }
  });

  test('captures the primary request and raw response without changing the verdict', async () => {
    const requests: Record<string, unknown>[] = [];
    const server = Bun.serve({
      port: nextResidualModelPort++,
      fetch: async (request) => {
        requests.push((await request.json()) as Record<string, unknown>);
        return Response.json({
          model: 'residual-bank-model-returned',
          choices: [
            {
              message: {
                content: JSON.stringify({ decision: 'approve', reasoning: 'read-only control' }),
              },
            },
          ],
        });
      },
    });

    try {
      const trace: {
        requests: Parameters<NonNullable<AutoApprovePrimaryLLMTrace['onRequest']>>[0][];
        responses: Parameters<NonNullable<AutoApprovePrimaryLLMTrace['onResponse']>>[0][];
      } = { requests: [], responses: [] };
      const service = new AutoApproveService(
        makeConfig({
          provider: `http://127.0.0.1:${server.port}`,
          base_url: `http://127.0.0.1:${server.port}`,
          approve_groups: [],
        }),
        () => undefined,
        undefined,
        {
          onRequest: (event) => trace.requests.push(event),
          onResponse: (event) => trace.responses.push(event),
        },
      );

      const sample = RESIDUAL_MODEL_BANK[1];
      if (sample === undefined) throw new Error('residual bank control missing');
      const result = await service.evaluate('Bash', { command: sample.command });

      expect(result.decision).toBe('approve');
      if (result.decision === 'cancelled') throw new Error('fixture evaluation was cancelled');
      expect(result.model).toBe('residual-bank-model-returned');
      expect(requests).toHaveLength(1);
      expect(trace.requests).toHaveLength(1);
      expect(trace.responses).toHaveLength(1);
      expect(trace.requests[0]?.toolName).toBe('Bash');
      expect(trace.requests[0]?.model).toBe('residual-bank-model');
      expect(
        trace.requests[0]?.messages.some((message) => message.content.includes(sample.command)),
      ).toBe(true);
      expect(trace.responses[0]?.content).toContain('read-only control');
    } finally {
      server.stop(true);
    }
  });
});
