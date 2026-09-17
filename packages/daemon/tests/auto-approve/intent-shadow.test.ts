import { describe, expect, test } from 'bun:test';
import { AutoApproveService } from '../../src/auto-approve/auto-approve-service.ts';
import { MAX_INTENT_OPERATION_CHARS } from '../../src/auto-approve/intent-assessment.ts';
import type { AutoApproveConfig } from '../../src/auto-approve/types.ts';

interface ShadowServer {
  readonly url: string;
  readonly calls: () => number;
  readonly requests: () => readonly string[];
  readonly releaseHeldIntent: () => void;
  readonly stop: () => void;
}

function startShadowServer(
  intentResponse: string,
  intentDelayMs = 0,
  reviewDelayMs = 0,
  holdIntent = false,
  responseModel = 'fixture-model',
): ShadowServer {
  let callCount = 0;
  const requestBodies: string[] = [];
  const heldIntentResolvers: Array<() => void> = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      callCount++;
      const body = await request.text();
      requestBodies.push(body);
      let messages: Array<{ content?: string }> = [];
      try {
        const parsed = JSON.parse(body) as { messages?: Array<{ content?: string }> };
        messages = parsed.messages ?? [];
      } catch {
        // The production client will report malformed provider responses; the
        // fixture still returns a valid response so the test can inspect the
        // service's parser and guard behavior.
      }
      const prompt = messages.map((message) => message.content ?? '').join('\n');
      const isIntentRequest = prompt.includes('advisory semantic-intent assessor');
      if (isIntentRequest && holdIntent) {
        await new Promise<void>((resolve) => heldIntentResolvers.push(resolve));
      } else if (isIntentRequest && intentDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, intentDelayMs));
      } else if (
        !isIntentRequest &&
        prompt.includes('You grade how strongly a user authorized') &&
        reviewDelayMs > 0
      ) {
        await new Promise((resolve) => setTimeout(resolve, reviewDelayMs));
      }
      const content = isIntentRequest
        ? intentResponse
        : prompt.includes('You grade how strongly a user authorized')
          ? 'implicit'
          : '{"decision":"approve","reasoning":"read-only repository inspection"}';
      return new Response(
        JSON.stringify({
          choices: [{ message: { content } }],
          model: responseModel,
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    },
  });
  return {
    url: `http://localhost:${server.port}/v1`,
    calls: () => callCount,
    requests: () => requestBodies,
    releaseHeldIntent: () => heldIntentResolvers.shift()?.(),
    stop: () => server.stop(true),
  };
}

function makeConfig(serverUrl: string, overrides?: Partial<AutoApproveConfig>): AutoApproveConfig {
  return {
    enabled: true,
    provider: serverUrl,
    model: 'fixture-model',
    api_key: '',
    base_url: serverUrl,
    timeout: 5,
    log_decisions: false,
    residual_action: 'escalate',
    risk_review: 'shadow',
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
    session_precedent: true,
    hold_timeout: 0,
    push_hold_timeout: 0,
    delivery_confirm_timeout: 0,
    hold_unconfirmed_timeout: 0,
    ...overrides,
  };
}

const validIntent = JSON.stringify({
  intent: 'local_read',
  effects: ['filesystem_read'],
  scope: 'repository',
  reversible: true,
  confidence: 0.98,
  reasoning: 'The operation reads repository state only.',
});

async function waitForCalls(server: ShadowServer, expected: number): Promise<void> {
  for (let attempt = 0; attempt < 200 && server.calls() < expected; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(server.calls()).toBeGreaterThanOrEqual(expected);
}

describe('AutoApproveService - semantic intent shadow (#1093)', () => {
  test('assesses the complete bounded context without changing the primary result', async () => {
    const server = startShadowServer(validIntent);
    const logs: string[] = [];
    try {
      const service = new AutoApproveService(makeConfig(server.url), (message) =>
        logs.push(message),
      );
      const result = await service.evaluate(
        'Bash',
        { command: 'git status --short' },
        'session-a',
        undefined,
        undefined,
        17,
        'session-a',
        false,
        'Inspect the repository state before continuing.',
        undefined,
        undefined,
        '/tmp/remi-session-a',
      );

      expect(result.decision).toBe('approve');
      // Primary model, semantic assessor, then the pre-existing authorization
      // shadow reviewer. All three share one serialized evaluation slot.
      expect(server.calls()).toBe(3);
      const bodies = server.requests().map(
        (body) =>
          JSON.parse(body) as {
            max_tokens?: number;
            messages?: Array<{ content?: string }>;
          },
      );
      expect(bodies[0]?.['max_tokens']).toBeUndefined();
      expect(bodies[1]?.['max_tokens']).toBe(128);
      expect(JSON.stringify(bodies[1])).toContain('advisory semantic-intent assessor');
      expect(bodies[2]?.['max_tokens']).toBe(8);
      expect(JSON.stringify(bodies[2])).toContain('You grade how strongly a user authorized');
      const intentBody = bodies.find((body) =>
        body.messages?.some((message) =>
          message.content?.includes('advisory semantic-intent assessor'),
        ),
      );
      expect(intentBody).toBeDefined();
      const intentPrompt =
        intentBody?.messages?.map((message) => message.content ?? '').join('\n') ?? '';
      expect(intentPrompt).toContain('git status --short');
      expect(intentPrompt).toContain('Inspect the repository state before continuing.');
      expect(intentPrompt).toContain('/tmp/remi-session-a');

      const intentLog = logs.find((message) => message.includes('SHADOW INTENT Bash'));
      expect(intentLog).toBeDefined();
      expect(intentLog).toStartWith('[AutoApprove session-a] SHADOW INTENT Bash:');
      expect(intentLog).toContain('proof=proved');
      expect(intentLog).toContain('status=ok');
      expect(intentLog).toContain('eval_id=17');
      expect(intentLog).toMatch(/op_fp=[0-9a-f]{16}/);
      expect(intentLog).toContain('intent=local_read');
      expect(intentLog).toContain('effects=filesystem_read');
      expect(intentLog).toContain('target_scope=repository');
      expect(intentLog).toContain('final=approve');
      expect(intentLog).not.toContain('git status --short');
      expect(intentLog).not.toContain('Inspect the repository state');
      expect(intentLog).not.toContain('reads repository state only');
    } finally {
      server.stop();
    }
  });

  test('keeps provider model labels single-line in semantic telemetry', async () => {
    const server = startShadowServer(validIntent, 0, 0, false, 'fixture\nmodel');
    const logs: string[] = [];
    try {
      const service = new AutoApproveService(makeConfig(server.url), (message) =>
        logs.push(message),
      );
      await service.evaluate('Bash', { command: 'git status --short' });

      const intentLog = logs.find((message) => message.includes('SHADOW INTENT Bash'));
      expect(intentLog).toContain('model=fixture?model');
      expect(intentLog).not.toContain('\n');
    } finally {
      server.stop();
    }
  });

  test('malformed semantic output is telemetry-only and preserves the guarded decision', async () => {
    const server = startShadowServer('{"intent":"local_read"}');
    const logs: string[] = [];
    try {
      const service = new AutoApproveService(makeConfig(server.url), (message) =>
        logs.push(message),
      );
      const result = await service.evaluate('Bash', { command: 'git status --short' });

      expect(result.decision).toBe('approve');
      expect(server.calls()).toBe(3);
      expect(logs.some((message) => message.includes('SHADOW INTENT Bash: status=malformed'))).toBe(
        true,
      );
    } finally {
      server.stop();
    }
  });

  test('bounded semantic input is recorded without making an assessor call', async () => {
    const server = startShadowServer(validIntent);
    const logs: string[] = [];
    try {
      const service = new AutoApproveService(makeConfig(server.url), (message) =>
        logs.push(message),
      );
      const result = await service.evaluate('Bash', {
        command: `echo ${'x'.repeat(MAX_INTENT_OPERATION_CHARS)}`,
      });

      expect(result.decision).toBe('approve');
      expect(server.calls()).toBe(2);
      expect(
        server.requests().some((body) => body.includes('advisory semantic-intent assessor')),
      ).toBe(false);
      expect(logs.some((message) => message.includes('SHADOW INTENT Bash: status=truncated'))).toBe(
        true,
      );
    } finally {
      server.stop();
    }
  });

  test('a valid but conflicting semantic assessment cannot approve or deny', async () => {
    const conflictingIntent = JSON.stringify({
      intent: 'destructive',
      effects: ['filesystem_delete'],
      scope: 'repository',
      reversible: false,
      confidence: 1,
      reasoning: 'The operation deletes repository data.',
    });
    const server = startShadowServer(conflictingIntent);
    try {
      const service = new AutoApproveService(makeConfig(server.url), () => undefined);
      const result = await service.evaluate('Bash', { command: 'git status --short' });

      expect(result.decision).toBe('approve');
      expect(server.calls()).toBe(3);
    } finally {
      server.stop();
    }
  });

  test('deadline returns the primary result and leaves no late shadow result', async () => {
    const server = startShadowServer(validIntent, 200);
    const logs: string[] = [];
    try {
      const service = new AutoApproveService(makeConfig(server.url, { timeout: 0.05 }), (message) =>
        logs.push(message),
      );
      const result = await service.evaluate('Bash', { command: 'git status --short' });

      expect(result.decision).toBe('approve');
      expect(server.calls()).toBe(2);
      expect(logs.some((message) => message.includes('SHADOW INTENT Bash: status=timeout'))).toBe(
        true,
      );
      const beforeLateCheck = logs.length;
      await new Promise((resolve) => setTimeout(resolve, 220));
      expect(logs.length).toBe(beforeLateCheck);
    } finally {
      server.stop();
    }
  });

  test('cancellation aborts the shadow call without returning a late result', async () => {
    const server = startShadowServer(validIntent, 0, 0, true);
    const logs: string[] = [];
    try {
      const service = new AutoApproveService(makeConfig(server.url), (message) =>
        logs.push(message),
      );
      const evaluation = service.evaluate(
        'Bash',
        { command: 'git status --short' },
        'session-a',
        undefined,
        undefined,
        42,
        'session-a',
      );
      await waitForCalls(server, 2);

      expect(service.cancel('answered locally', 42, 'session-a')).toBe(true);
      const result = await evaluation;
      expect(result.decision).toBe('cancelled');
      expect(logs.some((message) => message.includes('SHADOW INTENT Bash: status=cancelled'))).toBe(
        true,
      );
      const beforeLateCheck = logs.length;
      await new Promise((resolve) => setTimeout(resolve, 220));
      expect(logs.length).toBe(beforeLateCheck);
    } finally {
      server.releaseHeldIntent();
      server.stop();
    }
  });

  test('scope isolates semantic context, logs, and queued cancellation', async () => {
    const server = startShadowServer(validIntent, 0, 100);
    const logs: string[] = [];
    try {
      const service = new AutoApproveService(makeConfig(server.url), (message) =>
        logs.push(message),
      );
      const sessionA = service.evaluate(
        'Bash',
        { command: 'git status --short' },
        'session-A',
        undefined,
        undefined,
        1,
        'scope-A',
        false,
        'A-only task context',
        undefined,
        undefined,
        '/tmp/session-a',
      );
      await waitForCalls(server, 3);

      const sessionB = service.evaluate(
        'Bash',
        { command: 'git diff --stat' },
        'session-B',
        undefined,
        undefined,
        2,
        'scope-B',
        false,
        'B-only task context',
        undefined,
        undefined,
        '/tmp/session-b',
      );
      expect(service.cancel('session B ended', 2, 'scope-B')).toBe(true);
      const cancelledB = await sessionB;
      expect(cancelledB.decision).toBe('escalate');
      expect(cancelledB.reasoning).toContain('force-released');

      const resultA = await sessionA;
      expect(resultA.decision).toBe('approve');

      const survivingB = await service.evaluate(
        'Bash',
        { command: 'git diff --stat' },
        'session-B',
        undefined,
        undefined,
        3,
        'scope-B',
        false,
        'B-only task context',
        undefined,
        undefined,
        '/tmp/session-b',
      );
      expect(survivingB.decision).toBe('approve');

      const semanticRequests = server
        .requests()
        .filter((body) => body.includes('advisory semantic-intent assessor'));
      expect(semanticRequests).toHaveLength(2);
      expect(semanticRequests[0]).toContain('A-only task context');
      expect(semanticRequests[0]).toContain('/tmp/session-a');
      expect(semanticRequests[0]).not.toContain('B-only task context');
      expect(semanticRequests[1]).toContain('B-only task context');
      expect(semanticRequests[1]).toContain('/tmp/session-b');
      expect(semanticRequests[1]).not.toContain('A-only task context');

      const semanticLogs = logs.filter((message) => message.includes('SHADOW INTENT Bash'));
      expect(semanticLogs).toHaveLength(2);
      expect(semanticLogs[0]).toContain('session_scope=scope-A');
      expect(semanticLogs[1]).toContain('session_scope=scope-B');
    } finally {
      server.stop();
    }
  });

  test('semantic assessment is disabled when risk review is off', async () => {
    const server = startShadowServer(validIntent);
    const logs: string[] = [];
    try {
      const service = new AutoApproveService(
        makeConfig(server.url, { risk_review: 'off' }),
        (message) => logs.push(message),
      );
      const result = await service.evaluate('Bash', { command: 'git status --short' });

      expect(result.decision).toBe('approve');
      expect(server.calls()).toBe(1);
      expect(logs.some((message) => message.includes('SHADOW INTENT'))).toBe(false);
    } finally {
      server.stop();
    }
  });

  test('deterministic approvals bypass all model calls, including semantic shadow', async () => {
    const server = startShadowServer(validIntent);
    try {
      const service = new AutoApproveService(
        makeConfig(server.url, { allow: ['git status'] }),
        () => undefined,
      );
      const result = await service.evaluate('Bash', { command: 'git status --short' });

      expect(result.decision).toBe('approve');
      expect(server.calls()).toBe(0);
    } finally {
      server.stop();
    }
  });
});
