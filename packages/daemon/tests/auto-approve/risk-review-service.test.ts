import { afterEach, describe, expect, test } from 'bun:test';
import { AutoApproveService } from '../../src/auto-approve/auto-approve-service.ts';
import type { AutoApproveConfig } from '../../src/auto-approve/types.ts';

interface ReviewServer {
  readonly url: string;
  readonly calls: () => number;
  readonly requests: () => readonly Record<string, unknown>[];
  readonly stop: () => void;
}

function startReviewServer(
  responses: readonly string[],
  status: number | readonly number[] = 200,
): ReviewServer {
  let calls = 0;
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const content = responses[Math.min(calls, responses.length - 1)] ?? '';
      const responseStatus = Array.isArray(status)
        ? (status[Math.min(calls, status.length - 1)] ?? 200)
        : status;
      requests.push((await request.json()) as Record<string, unknown>);
      calls++;
      if (content === '__delay__') await new Promise((resolve) => setTimeout(resolve, 100));
      return new Response(
        JSON.stringify({
          choices: [{ message: { content } }],
          model: 'review-test-model',
        }),
        {
          status: responseStatus,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    },
  });
  return {
    url: `http://localhost:${server.port}/v1`,
    calls: () => calls,
    requests: () => requests,
    stop: () => server.stop(true),
  };
}

function makeConfig(serverUrl: string, overrides?: Partial<AutoApproveConfig>): AutoApproveConfig {
  return {
    enabled: true,
    provider: serverUrl,
    model: 'primary-test-model',
    api_key: '',
    base_url: serverUrl,
    timeout: 2,
    log_decisions: false,
    residual_action: 'escalate',
    risk_review: 'off',
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
    queue_timeout: 240,
    cache_idle: 0,
    keep_alive: 0,
    engine: 'owned',
    engine_path: '',
    model_cache: '',
    disable_thinking: false,
    always_escalate_tools: [],
    session_precedent: false,
    hold_timeout: 0,
    push_hold_timeout: 0,
    delivery_confirm_timeout: 0,
    hold_unconfirmed_timeout: 0,
    ...overrides,
  };
}

const servers: ReviewServer[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});

describe('AutoApproveService phase 2 shadow reviewer', () => {
  test('off preserves the one-call path and emits no shadow event', async () => {
    const server = startReviewServer(['{"decision":"approve","reasoning":"read-only"}']);
    servers.push(server);
    const logs: string[] = [];
    const service = new AutoApproveService(makeConfig(server.url), (line) => logs.push(line));

    const result = await service.evaluate('Bash', { command: 'git status' });

    expect(result.decision).toBe('approve');
    expect(server.calls()).toBe(1);
    expect(logs.some((line) => line.includes('SHADOW REVIEW'))).toBe(false);
  });

  test('shadow mode makes a second graded call but preserves the primary decision', async () => {
    const server = startReviewServer([
      '{"decision":"approve","reasoning":"read-only"}',
      'implicit',
    ]);
    servers.push(server);
    const logs: string[] = [];
    const service = new AutoApproveService(
      makeConfig(server.url, { risk_review: 'shadow' }),
      (line) => logs.push(line),
    );

    const result = await service.evaluate(
      'Bash',
      { command: 'git status' },
      'session-a',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'Please inspect the repository.',
    );

    expect(result.decision).toBe('approve');
    expect(server.calls()).toBe(2);
    expect(server.requests()[1]?.['max_tokens']).toBe(8);
    expect(JSON.stringify(server.requests()[1])).toContain('git status');
    expect(JSON.stringify(server.requests()[1])).toContain('Please inspect the repository.');
    expect(logs).toContain(
      '[AutoApprove session-a] SHADOW REVIEW Bash: status=ok risk=moderate authority=yes observed_auth=implicit auth=implicit matrix=approve primary=approve final=approve decided_by=model disagreement=none',
    );
  });

  test('shadow request retains the complete non-Bash operation payload', async () => {
    const server = startReviewServer([
      '{"decision":"approve","reasoning":"safe edit"}',
      'implicit',
    ]);
    servers.push(server);
    const service = new AutoApproveService(
      makeConfig(server.url, { risk_review: 'shadow' }),
      () => undefined,
    );

    const result = await service.evaluate(
      'Write',
      { file_path: '/tmp/report.txt', content: 'the complete payload matters' },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'Update the report file.',
    );

    expect(result.decision).toBe('approve');
    expect(server.calls()).toBe(2);
    const shadowRequest = JSON.stringify(server.requests()[1]);
    expect(shadowRequest).toContain('the complete payload matters');
    expect(shadowRequest).toContain('Update the report file.');
    expect(server.requests()[1]?.['max_tokens']).toBe(8);
  });

  test('shadow disagreement cannot override the deterministic risk ceiling', async () => {
    const server = startReviewServer([
      '{"decision":"approve","reasoning":"the user asked"}',
      'explicit',
    ]);
    servers.push(server);
    const logs: string[] = [];
    const service = new AutoApproveService(
      makeConfig(server.url, { risk_review: 'shadow' }),
      (line) => logs.push(line),
    );

    const result = await service.evaluate('Bash', { command: 'rm -rf ./build' });

    expect(result.decision).toBe('escalate');
    expect(result.reasoning).toContain('Risk ceiling');
    expect(server.calls()).toBe(2);
    expect(logs.some((line) => line.includes('risk=high') && line.includes('final=escalate'))).toBe(
      true,
    );
  });

  test('malformed reviewer output preserves the guarded primary result', async () => {
    const server = startReviewServer([
      '{"decision":"approve","reasoning":"read-only"}',
      'not a grade',
    ]);
    servers.push(server);
    const logs: string[] = [];
    const service = new AutoApproveService(
      makeConfig(server.url, { risk_review: 'shadow' }),
      (line) => logs.push(line),
    );

    const result = await service.evaluate('Bash', { command: 'git status' });

    expect(result.decision).toBe('approve');
    expect(server.calls()).toBe(2);
    expect(logs.some((line) => line.includes('SHADOW REVIEW Bash: status=malformed'))).toBe(true);
  });

  test('reviewer unavailability preserves the guarded primary result', async () => {
    const server = startReviewServer(
      ['{"decision":"approve","reasoning":"read-only"}', 'unavailable'],
      [200, 503],
    );
    servers.push(server);
    const logs: string[] = [];
    const service = new AutoApproveService(
      makeConfig(server.url, { risk_review: 'shadow' }),
      (line) => logs.push(line),
    );

    const result = await service.evaluate('Bash', { command: 'git status' });

    expect(result.decision).toBe('approve');
    expect(server.calls()).toBe(2);
    expect(logs.some((line) => line.includes('SHADOW REVIEW Bash: status=unavailable'))).toBe(true);
  });

  test('reviewer timeout preserves the primary result within the original deadline', async () => {
    const server = startReviewServer([
      '{"decision":"approve","reasoning":"read-only"}',
      '__delay__',
    ]);
    servers.push(server);
    const logs: string[] = [];
    const service = new AutoApproveService(
      makeConfig(server.url, { risk_review: 'shadow', timeout: 0.05 }),
      (line) => logs.push(line),
    );

    const result = await service.evaluate('Bash', { command: 'git status' });

    expect(result.decision).toBe('approve');
    expect(server.calls()).toBe(2);
    expect(logs.some((line) => line.includes('SHADOW REVIEW Bash: status=timeout'))).toBe(true);
  });

  test('user cancellation still cancels a shadow call instead of returning a stale result', async () => {
    const server = startReviewServer([
      '{"decision":"approve","reasoning":"read-only"}',
      '__delay__',
    ]);
    servers.push(server);
    const service = new AutoApproveService(
      makeConfig(server.url, { risk_review: 'shadow', timeout: 1 }),
      () => undefined,
    );

    const evaluation = service.evaluate(
      'Bash',
      { command: 'git status' },
      undefined,
      undefined,
      undefined,
      42,
      'session-a',
    );
    for (let i = 0; i < 100 && server.calls() < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(server.calls()).toBe(2);
    expect(service.cancel('answered locally', 42, 'session-a')).toBe(true);
    expect((await evaluation).decision).toBe('cancelled');
  });

  test('deterministic approvals bypass both model and shadow reviewer', async () => {
    const server = startReviewServer(['unexpected']);
    servers.push(server);
    const logs: string[] = [];
    const service = new AutoApproveService(
      makeConfig(server.url, { risk_review: 'shadow', approve_groups: ['vcs-read'] }),
      (line) => logs.push(line),
    );

    const result = await service.evaluate('Bash', { command: 'git status' });

    expect(result.decision).toBe('approve');
    expect(server.calls()).toBe(0);
    expect(logs.some((line) => line.includes('SHADOW REVIEW'))).toBe(false);
  });

  test('design questions bypass both model and shadow reviewer', async () => {
    const server = startReviewServer(['unexpected']);
    servers.push(server);
    const service = new AutoApproveService(
      makeConfig(server.url, {
        risk_review: 'shadow',
        always_escalate_tools: ['AskUserQuestion'],
      }),
      () => undefined,
    );

    const result = await service.evaluate('AskUserQuestion', {
      questions: [{ question: 'Which database?' }],
    });

    expect(result.decision).toBe('escalate');
    expect(server.calls()).toBe(0);
  });

  test('multichoice skip and evaluate paths do not invoke the shadow reviewer', async () => {
    const skipServer = startReviewServer(['unexpected']);
    const evaluateServer = startReviewServer(['{"decision":"pick","index":1}']);
    servers.push(skipServer, evaluateServer);

    const skip = new AutoApproveService(
      makeConfig(skipServer.url, { risk_review: 'shadow', multichoice: 'skip' }),
      () => undefined,
    );
    const skipResult = await skip.evaluate('Bash', { command: 'ls' }, undefined, [
      'Inspect',
      'Explain',
      'Continue',
    ]);
    expect(skipResult.decision).toBe('escalate');
    expect(skipServer.calls()).toBe(0);

    const evaluate = new AutoApproveService(
      makeConfig(evaluateServer.url, { risk_review: 'shadow', multichoice: 'evaluate' }),
      () => undefined,
    );
    const evaluateResult = await evaluate.evaluate('Bash', { command: 'ls' }, undefined, [
      'Inspect',
      'Explain',
      'Continue',
    ]);
    expect(evaluateResult.decision).toBe('pick');
    expect(evaluateServer.calls()).toBe(1);
  });
});
