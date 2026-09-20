import { describe, expect, test } from 'bun:test';
import { AutoApproveService } from '../../src/auto-approve/auto-approve-service.ts';
import {
  SessionWorkflowGrantStore,
  classifySessionWorkflowOperation,
} from '../../src/auto-approve/session-workflow-grant.ts';
import type { AutoApproveConfig } from '../../src/auto-approve/types.ts';

let nextWorkflowFixturePort = 19_870;

function makeConfig(baseUrl: string, overrides?: Partial<AutoApproveConfig>): AutoApproveConfig {
  return {
    enabled: true,
    provider: baseUrl,
    model: 'fixture-model',
    api_key: '',
    base_url: baseUrl,
    timeout: 5,
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
    session_precedent: true,
    hold_timeout: 0,
    push_hold_timeout: 0,
    delivery_confirm_timeout: 0,
    hold_unconfirmed_timeout: 0,
    ...overrides,
  };
}

function startWorkflowServer(response: string | readonly string[]): {
  readonly url: string;
  readonly calls: () => number;
  readonly requests: () => readonly string[];
  readonly stop: () => void;
} {
  let calls = 0;
  const requests: string[] = [];
  const server = Bun.serve({
    // Bun's test runner can start these fixtures concurrently, while this
    // environment rejects concurrent port-0 listeners. Keep the fixture
    // deterministic and isolated without changing the production path.
    port: nextWorkflowFixturePort++,
    fetch: async (request) => {
      const body = await request.text();
      requests.push(body);
      calls++;
      const parsed = JSON.parse(body) as {
        messages?: Array<{ content?: string }>;
      };
      const prompt = parsed.messages?.map((message) => message.content ?? '').join('\n') ?? '';
      const responseIndex = prompt.includes('independent risk, effect, and authorization') ? 1 : 0;
      const content = Array.isArray(response)
        ? (response[responseIndex] ?? response[response.length - 1] ?? '')
        : response;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content } }],
          model: 'workflow-fixture',
        }),
        { headers: { 'Content-Type': 'application/json' } },
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

function grantFor(repository = 'yooz-labs/remi') {
  const operation = classifySessionWorkflowOperation(
    'Bash',
    { command: "gh issue create --title 'x' --body 'y'" },
    { sessionId: 'session-a', workingDirectory: '/repo/a', repository },
  );
  if (operation === undefined) throw new Error('fixture operation did not classify');
  const store = new SessionWorkflowGrantStore('session-a', '/repo/a', repository);
  if (!store.grant(operation)) throw new Error('fixture grant did not install');
  return { store, operation };
}

const validAssessment = JSON.stringify({
  intent: 'remote_mutation',
  effects: ['network_write', 'remote_mutation'],
  scope: 'remote_repository',
  reversible: true,
  confidence: 0.96,
  reasoning: 'Creates a planning issue in the scoped GitHub repository.',
});

const validIndependentReview = JSON.stringify({
  risk: 'high',
  intent: 'remote_mutation',
  effects: ['network_write', 'remote_mutation'],
  scope: 'remote_repository',
  reversible: true,
  confidence: 0.96,
  authorization: 'none',
  reasoning: 'Creates a reversible planning issue in the scoped repository.',
});

const missingRemoteMutationReview = JSON.stringify({
  risk: 'high',
  intent: 'remote_mutation',
  effects: ['network_write'],
  scope: 'remote_repository',
  reversible: true,
  confidence: 0.96,
  authorization: 'none',
  reasoning: 'Creates a planning issue in the scoped repository.',
});

const conflictingIndependentReview = JSON.stringify({
  risk: 'high',
  intent: 'remote_read',
  effects: ['network_read', 'remote_read'],
  scope: 'remote_repository',
  reversible: true,
  confidence: 0.96,
  authorization: 'none',
  reasoning: 'This response intentionally conflicts with the grant facts.',
});

describe('AutoApproveService session workflow authorization (#1095)', () => {
  test('uses one fresh local semantic confirmation and skips the ordinary primary call', async () => {
    const server = startWorkflowServer(validAssessment);
    const logs: string[] = [];
    try {
      const { store } = grantFor();
      const service = new AutoApproveService(makeConfig(server.url), (message) =>
        logs.push(message),
      );
      const result = await service.evaluate(
        'Bash',
        { command: "gh issue create --title 'x' --body 'y'" },
        'session-a',
        undefined,
        undefined,
        1,
        'session-a',
        false,
        'Create the planned GitHub issue for the current task.',
        undefined,
        undefined,
        '/repo/a',
        { reader: store, repository: 'yooz-labs/remi' },
      );

      expect(result.decision).toBe('approve');
      expect(server.requests()).toHaveLength(1);
      const prompt = JSON.parse(server.requests()[0] ?? '{}') as {
        messages?: Array<{ content?: string }>;
      };
      const content = prompt.messages?.map((message) => message.content ?? '').join('\n') ?? '';
      expect(content).toContain('advisory semantic-intent assessor');
      expect(content).toContain('workflow_kind');
      expect(content).toContain('github-issue-create');
      expect(content).toContain('Create the planned GitHub issue for the current task.');
      expect(logs.some((line) => line.includes('WORKFLOW GRANT Bash: approve'))).toBe(true);
    } finally {
      server.stop();
    }
  });

  test('verified mode requires an independent effect review but uses the grant as authorization', async () => {
    const server = startWorkflowServer([validAssessment, validIndependentReview]);
    const logs: string[] = [];
    try {
      const { store } = grantFor();
      const service = new AutoApproveService(
        makeConfig(server.url, { risk_review: 'verified' }),
        (message) => logs.push(message),
      );
      const result = await service.evaluate(
        'Bash',
        { command: "gh issue create --title 'x' --body 'y'" },
        'session-a',
        undefined,
        undefined,
        6,
        'session-a',
        false,
        'Create the planned GitHub issue for the current task.',
        undefined,
        undefined,
        '/repo/a',
        { reader: store, repository: 'yooz-labs/remi' },
      );

      expect(result.decision).toBe('approve');
      expect(server.calls()).toBe(2);
      const effectPrompt = JSON.parse(server.requests()[1] ?? '{}') as {
        messages?: Array<{ content?: string }>;
      };
      const content =
        effectPrompt.messages?.map((message) => message.content ?? '').join('\n') ?? '';
      expect(content).toContain('independent risk, effect, and authorization');
      expect(content).toContain('session_grant=present');
      expect(content).toContain('github-issue-create');
      expect(content).toContain(
        'CODE-OWNED EFFECT SET (exact observation to copy): ["network_write","remote_mutation"]',
      );
      expect(result.reasoning).toContain('code-verified grant supplied authorization');
      expect(logs.some((line) => line.includes('VERIFIED WORKFLOW REVIEW Bash: status=ok'))).toBe(
        true,
      );
    } finally {
      server.stop();
    }
  });

  test('verified workflow effect omission escalates through the production path', async () => {
    const server = startWorkflowServer([validAssessment, missingRemoteMutationReview]);
    try {
      const { store } = grantFor();
      const service = new AutoApproveService(
        makeConfig(server.url, { risk_review: 'verified' }),
        () => {},
      );
      const result = await service.evaluate(
        'Bash',
        { command: "gh issue create --title 'x' --body 'y'" },
        'session-a',
        undefined,
        undefined,
        16,
        'session-a',
        false,
        'Create the planned GitHub issue for the current task.',
        undefined,
        undefined,
        '/repo/a',
        { reader: store, repository: 'yooz-labs/remi' },
      );

      expect(result.decision).toBe('escalate');
      expect(result.reasoning).toContain('contract-mismatch');
      expect(server.calls()).toBe(2);
    } finally {
      server.stop();
    }
  });

  test('verified workflow disagreement escalates without calling the ordinary primary model', async () => {
    const server = startWorkflowServer([validAssessment, conflictingIndependentReview]);
    try {
      const { store } = grantFor();
      const service = new AutoApproveService(
        makeConfig(server.url, { risk_review: 'verified' }),
        () => {},
      );
      const result = await service.evaluate(
        'Bash',
        { command: "gh issue create --title 'x' --body 'y'" },
        'session-a',
        undefined,
        undefined,
        7,
        'session-a',
        false,
        'Create the planned GitHub issue for the current task.',
        undefined,
        undefined,
        '/repo/a',
        { reader: store, repository: 'yooz-labs/remi' },
      );

      expect(result.decision).toBe('escalate');
      if (result.decision === 'escalate') expect(result.suppressSecondOpinion).toBe(true);
      expect(result.reasoning).toContain('contract-mismatch');
      expect(server.calls()).toBe(2);
    } finally {
      server.stop();
    }
  });

  test('a critical workflow never uses a grant or model call to approve', async () => {
    const server = startWorkflowServer([validAssessment, validIndependentReview]);
    try {
      const logs: string[] = [];
      const operation = classifySessionWorkflowOperation(
        'Bash',
        { command: "gh issue create --title 'chmod 777 production' --body 'planning'" },
        { sessionId: 'session-a', workingDirectory: '/repo/a', repository: 'yooz-labs/remi' },
      );
      expect(operation).toBeDefined();
      if (operation === undefined) return;
      const store = new SessionWorkflowGrantStore('session-a', '/repo/a', 'yooz-labs/remi');
      expect(store.grant(operation)).toBe(true);
      const service = new AutoApproveService(
        makeConfig(server.url, { risk_review: 'verified' }),
        (message) => logs.push(message),
      );
      const result = await service.evaluate(
        'Bash',
        { command: "gh issue create --title 'chmod 777 production' --body 'planning'" },
        'session-a',
        undefined,
        undefined,
        8,
        'session-a',
        false,
        'Create the planned GitHub issue for the current task.',
        undefined,
        undefined,
        '/repo/a',
        { reader: store, repository: 'yooz-labs/remi' },
      );

      expect(result.decision).toBe('escalate');
      if (result.decision === 'escalate') expect(result.suppressSecondOpinion).toBe(true);
      expect(server.calls()).toBe(0);
      expect(result.reasoning).toContain('critical');
      expect(logs.some((line) => line.includes('VERIFIED WORKFLOW REVIEW'))).toBe(false);
      expect(logs.some((line) => line.includes('WORKFLOW GRANT Bash: status=critical-risk'))).toBe(
        true,
      );
    } finally {
      server.stop();
    }
  });

  test('verified workflow never sends a truncated long command to either reviewer', async () => {
    const server = startWorkflowServer([validAssessment, validIndependentReview]);
    try {
      const command = `gh issue create --title 'x' --body '${'a'.repeat(2_001)}'`;
      const operation = classifySessionWorkflowOperation(
        'Bash',
        { command },
        { sessionId: 'session-a', workingDirectory: '/repo/a', repository: 'yooz-labs/remi' },
      );
      expect(operation).toBeDefined();
      if (operation === undefined) return;
      const store = new SessionWorkflowGrantStore('session-a', '/repo/a', 'yooz-labs/remi');
      expect(store.grant(operation)).toBe(true);
      const logs: string[] = [];
      const service = new AutoApproveService(
        makeConfig(server.url, { risk_review: 'verified' }),
        (message) => logs.push(message),
      );

      const result = await service.evaluate(
        'Bash',
        { command },
        'session-a',
        undefined,
        undefined,
        9,
        'session-a',
        false,
        'Create the planned GitHub issue for the current task.',
        undefined,
        undefined,
        '/repo/a',
        { reader: store, repository: 'yooz-labs/remi' },
      );

      expect(result.decision).toBe('escalate');
      expect(result.reasoning).toContain('independent-review bound');
      expect(server.calls()).toBe(0);
      expect(
        logs.some((line) => line.includes('VERIFIED GATE Bash: status=operation-too-long')),
      ).toBe(true);
    } finally {
      server.stop();
    }
  });

  test('fails closed when semantic confirmation is malformed and suppresses a second opinion', async () => {
    const server = startWorkflowServer('{"intent":"remote_mutation"}');
    try {
      const { store } = grantFor();
      const service = new AutoApproveService(
        makeConfig(server.url, { escalate_model: 'heavy-fixture', escalate_timeout: 5 }),
        () => {},
      );
      const result = await service.evaluate(
        'Bash',
        { command: "gh issue create --title 'x' --body 'y'" },
        'session-a',
        undefined,
        undefined,
        2,
        'session-a',
        false,
        undefined,
        undefined,
        undefined,
        '/repo/a',
        { reader: store, repository: 'yooz-labs/remi' },
      );
      expect(result.decision).toBe('escalate');
      if (result.decision === 'escalate') expect(result.suppressSecondOpinion).toBe(true);
      expect(server.requests()).toHaveLength(1);
    } finally {
      server.stop();
    }
  });

  test('does not consult the semantic path without a matching session grant', async () => {
    const server = startWorkflowServer('{"decision":"approve","reasoning":"fixture primary"}');
    try {
      const { store } = grantFor();
      store.clear();
      const service = new AutoApproveService(makeConfig(server.url), () => {});
      const result = await service.evaluate(
        'Bash',
        { command: "echo 'safe fixture'" },
        'session-a',
        undefined,
        undefined,
        3,
        'session-a',
        false,
        undefined,
        undefined,
        undefined,
        '/repo/a',
        { reader: store, repository: 'yooz-labs/remi' },
      );
      expect(result.decision).toBe('approve');
      const prompt = JSON.parse(server.requests()[0] ?? '{}') as {
        messages?: Array<{ content?: string }>;
      };
      expect(
        prompt.messages?.some((message) =>
          message.content?.includes('advisory semantic-intent assessor'),
        ),
      ).toBe(false);
    } finally {
      server.stop();
    }
  });

  test('never sends a matched operation to a non-local semantic provider', async () => {
    const { store } = grantFor();
    const service = new AutoApproveService(makeConfig('https://example.invalid/v1'), () => {});
    const result = await service.evaluate(
      'Bash',
      { command: "gh issue create --title 'x' --body 'y'" },
      'session-a',
      undefined,
      undefined,
      4,
      'session-a',
      false,
      undefined,
      undefined,
      undefined,
      '/repo/a',
      { reader: store, repository: 'yooz-labs/remi' },
    );
    expect(result.decision).toBe('escalate');
    if (result.decision === 'escalate') expect(result.suppressSecondOpinion).toBe(true);
  });

  test('does not let a session grant bypass multi-choice routing', async () => {
    const server = startWorkflowServer(validAssessment);
    try {
      const { store } = grantFor();
      const service = new AutoApproveService(
        makeConfig(server.url, { multichoice: 'evaluate' }),
        () => {},
      );
      const result = await service.evaluate(
        'Bash',
        { command: "gh issue create --title 'x' --body 'y'" },
        'session-a',
        ['Continue', 'No'],
        undefined,
        5,
        'session-a',
        false,
        undefined,
        undefined,
        undefined,
        '/repo/a',
        { reader: store, repository: 'yooz-labs/remi' },
      );
      expect(result.decision).toBe('escalate');
      expect(server.requests()).toHaveLength(1);
      const prompt = JSON.parse(server.requests()[0] ?? '{}') as {
        messages?: Array<{ content?: string }>;
      };
      expect(prompt.messages?.some((message) => message.content?.includes('Options:'))).toBe(true);
      expect(
        prompt.messages?.some((message) =>
          message.content?.includes('advisory semantic-intent assessor'),
        ),
      ).toBe(false);
    } finally {
      server.stop();
    }
  });
});
