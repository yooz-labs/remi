import { afterEach, describe, expect, test } from 'bun:test';
import { AutoApproveService } from '../../src/auto-approve/auto-approve-service.ts';
import {
  PrecedentStore,
  readerFrom,
  signatureForOperation,
} from '../../src/auto-approve/precedent.ts';
import type { RiskBand } from '../../src/auto-approve/risk-bands.ts';
import type { AutoApproveConfig } from '../../src/auto-approve/types.ts';

interface ReviewServer {
  readonly url: string;
  readonly calls: () => number;
  readonly requests: () => readonly Record<string, unknown>[];
  readonly stop: () => void;
}

type FixtureResponse = string | ((prompt: string) => string);

type VerifiedEffectReviewProbe = {
  runVerifiedEffectReview: (
    toolName: string,
    toolInput: Record<string, unknown>,
    authority: string | undefined,
    riskBand: RiskBand,
    proofFacts: readonly string[],
    model: string,
    signal: AbortSignal,
    deadlineAt: number,
  ) => Promise<{ readonly kind: string }>;
};

let nextVerifiedFixturePort = 19_900;

function startReviewServer(
  responses: readonly FixtureResponse[],
  status: number | readonly number[] = 200,
): ReviewServer {
  let calls = 0;
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({
    // Bun's test runner can start fixture listeners concurrently, while this
    // environment rejects port-0 listeners. Deterministic per-fixture ports
    // preserve isolation without changing the production path.
    port: nextVerifiedFixturePort++,
    fetch: async (request) => {
      const body = (await request.json()) as Record<string, unknown>;
      requests.push(body);
      const prompt = requestText(body);
      const isIntentRequest = prompt.includes('advisory semantic-intent assessor');
      const isEffectReviewRequest = prompt.includes('independent risk, effect, and authorization');
      const responseIndex = isIntentRequest ? 0 : isEffectReviewRequest ? 1 : 2;
      const fixture = responses[responseIndex] ?? responses[responses.length - 1];
      const content = typeof fixture === 'function' ? fixture(prompt) : (fixture ?? '');
      const responseStatus = Array.isArray(status)
        ? (status[Math.min(calls, status.length - 1)] ?? 200)
        : status;
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
    risk_review: 'verified',
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

function requestText(request: Record<string, unknown> | undefined): string {
  const messages = request?.['messages'];
  if (!Array.isArray(messages)) return '';
  return messages
    .filter(
      (message): message is Record<string, unknown> =>
        message !== null && typeof message === 'object',
    )
    .map((message) => (typeof message['content'] === 'string' ? message['content'] : ''))
    .join('\n');
}

const LOCAL_INTENT = JSON.stringify({
  intent: 'local_read',
  effects: ['filesystem_read'],
  scope: 'repository',
  reversible: true,
  confidence: 0.98,
  reasoning: 'The operation reads repository state only.',
});

const REMOTE_INTENT = JSON.stringify({
  intent: 'remote_read',
  effects: ['filesystem_read', 'network_read', 'remote_read'],
  scope: 'remote_repository',
  reversible: true,
  confidence: 0.98,
  reasoning: 'The operation reads repository and remote metadata only.',
});

const LOCAL_EFFECT_REVIEW = JSON.stringify({
  risk: 'moderate',
  intent: 'local_read',
  effects: ['filesystem_read'],
  scope: 'repository',
  reversible: true,
  confidence: 0.97,
  authorization: 'explicit',
  reasoning: 'The operation is a reversible repository read.',
});

const LOCAL_EFFECT_REVIEW_TOPICAL = JSON.stringify({
  risk: 'moderate',
  intent: 'local_read',
  effects: ['filesystem_read'],
  scope: 'repository',
  reversible: true,
  confidence: 0.97,
  authorization: 'topical',
  reasoning: 'The operation is mentioned but not requested.',
});

const LOCAL_EFFECT_REVIEW_LOW_CONFIDENCE = JSON.stringify({
  risk: 'moderate',
  intent: 'local_read',
  effects: ['filesystem_read'],
  scope: 'repository',
  reversible: true,
  confidence: 0.5,
  authorization: 'implicit',
  reasoning: 'The operation probably reads repository state.',
});

const INTERPRETER_INTENT = JSON.stringify({
  intent: 'interpreter',
  effects: ['filesystem_read', 'process_execution'],
  scope: 'repository',
  reversible: true,
  confidence: 0.98,
  reasoning: 'The bounded interpreter formats repository data without mutation.',
});

const INTERPRETER_EFFECT_REVIEW = JSON.stringify({
  risk: 'moderate',
  intent: 'interpreter',
  effects: ['filesystem_read', 'process_execution'],
  scope: 'repository',
  reversible: true,
  confidence: 0.97,
  authorization: 'implicit',
  reasoning: 'The bounded interpreter performs a reversible repository read.',
});

const INTERPRETER_EFFECT_REVIEW_MISSING_PROCESS = JSON.stringify({
  risk: 'moderate',
  intent: 'interpreter',
  effects: ['filesystem_read'],
  scope: 'repository',
  reversible: true,
  confidence: 0.97,
  authorization: 'implicit',
  reasoning: 'The operation reads repository state.',
});

const REMOTE_INTERPRETER_INTENT = JSON.stringify({
  intent: 'remote_read',
  effects: ['filesystem_read', 'network_read', 'remote_read', 'process_execution'],
  scope: 'remote_repository',
  reversible: true,
  confidence: 0.98,
  reasoning: 'The bounded interpreter formats local and remote repository metadata.',
});

const REMOTE_INTERPRETER_EFFECT_REVIEW = JSON.stringify({
  risk: 'moderate',
  intent: 'remote_read',
  effects: ['filesystem_read', 'network_read', 'remote_read', 'process_execution'],
  scope: 'remote_repository',
  reversible: true,
  confidence: 0.97,
  authorization: 'implicit',
  reasoning: 'The bounded interpreter performs a reversible remote repository read.',
});

const REMOTE_EFFECT_REVIEW = JSON.stringify({
  risk: 'moderate',
  intent: 'remote_read',
  effects: ['filesystem_read', 'network_read', 'remote_read'],
  scope: 'remote_repository',
  reversible: true,
  confidence: 0.97,
  authorization: 'explicit',
  reasoning: 'The operation reads remote repository metadata.',
});

function localRemoteOrInterpreterFixture(
  local: string,
  remote: string,
  interpreter: string,
  remoteInterpreter: string,
): FixtureResponse {
  return (prompt: string) =>
    prompt.includes('awk') && prompt.includes('ls-remote')
      ? remoteInterpreter
      : prompt.includes('awk')
        ? interpreter
        : prompt.includes('ls-remote')
          ? remote
          : local;
}

const WORKTREE_INVENTORY = `for wt in $(git worktree list --porcelain)
do b=$(git -C "$wt" rev-parse --abbrev-ref HEAD)
merged=$(git branch -r --contains "$b")
remote=$(git ls-remote --heads origin "$b")
dirty=$(git -C "$wt" status --porcelain)
ahead=$(git rev-list --count origin/dev.."$b")
echo "$b | merged_into_dev_or_main=$merged | on_remote=$remote | dirty=$dirty | ahead_of_dev=$ahead | $wt"
done`;

const BRANCH_INVENTORY = `for b in fix/adr-0064-on004212-basis fix/issue-1386-default-branch fix/dev-email-allowlist feature/issue-1336-docs-central-rule feature/issue-1406-epic-anonymous-deposit feature/issue-1374-fleet-annex-policy feature/issue-1159-import-normalize fix/issue-1392-key-registration docs/changelog-0103 feature/issue-1338-phase0-orcid-docs-gate fix/issue-1344-live-tier-guard
do n=$(git log "$b" --not --remotes --oneline 2>/dev/null | wc -l | tr -d ' ')
echo "$b -> unpushed commits: $n"
done`;

const SAFE_REWRITE = `for wt in $(git worktree list --porcelain | grep '^worktree' | cut -d ' ' -f 2 | tail -n +2)
do git -C "$wt" status --porcelain
done`;

const servers: ReviewServer[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});

function evaluate(
  service: AutoApproveService,
  command: string,
  authority = 'Please inspect the repository and report its current state.',
  scope = 'session-a',
  isSubagent = false,
) {
  return service.evaluate(
    'Bash',
    { command },
    scope,
    undefined,
    undefined,
    undefined,
    scope,
    isSubagent,
    authority,
    undefined,
    undefined,
    '/same/project/path',
  );
}

describe('verified read-only risk review (#1081 phase 4)', () => {
  test('approves the observed branch inventory with two independent calls', async () => {
    const server = startReviewServer([LOCAL_INTENT, LOCAL_EFFECT_REVIEW]);
    servers.push(server);
    const logs: string[] = [];
    const service = new AutoApproveService(makeConfig(server.url), (line) => logs.push(line));

    const result = await evaluate(
      service,
      BRANCH_INVENTORY,
      'Please check which local branches have unpushed commits.',
    );
    expect(result.decision).toBe('approve');
    expect(server.calls()).toBe(2);
    expect(server.requests()[0]?.['max_tokens']).toBe(128);
    expect(server.requests()[1]?.['max_tokens']).toBe(128);
    const request = requestText(server.requests()[0]);
    expect(request).toContain('for b in fix/adr-0064-on004212-basis');
    expect(request).toContain('git log');
    expect(request).toContain('"verified_intent": "local_read"');
    expect(request).toContain('"verified_scope": "repository"');
    expect(request).toContain('Please check which local branches have unpushed commits.');
    expect(requestText(server.requests()[1])).not.toContain(
      'The operation reads repository state only.',
    );
    // Text cannot mint explicit authorization; the measured provenance cap
    // collapses the deliberately over-strong response to implicit.
    expect(result.reasoning).toContain(
      'semantic and independent effect reports agree, risk=moderate, authorization matrix=approve',
    );
    expect(
      logs.some(
        (line) =>
          line.startsWith(
            '[AutoApprove session-a] VERIFIED REVIEW Bash: status=ok proof=proved risk=moderate reported_risk=moderate leaves=4 review_model=review-test-model review_latency_ms=',
          ) &&
          line.includes(
            'semantic_match=yes independent_match=yes agreement=yes observed_auth=explicit auth=implicit matrix=approve final=approve',
          ),
      ),
    ).toBe(true);
  });

  test('approves the safe rewrite of the worktree inventory after both reviews', async () => {
    const server = startReviewServer([LOCAL_INTENT, LOCAL_EFFECT_REVIEW]);
    servers.push(server);
    const service = new AutoApproveService(makeConfig(server.url), () => undefined);

    const result = await evaluate(
      service,
      SAFE_REWRITE,
      'Please inspect the worktrees and show their current status.',
    );

    expect(result.decision).toBe('approve');
    expect(server.calls()).toBe(2);
    expect(requestText(server.requests()[0])).toContain(
      'for wt in $(git worktree list --porcelain',
    );
  });

  test('passes the exact bounded-interpreter effect set to the production reviewer', async () => {
    const server = startReviewServer([INTERPRETER_INTENT, INTERPRETER_EFFECT_REVIEW]);
    servers.push(server);
    const service = new AutoApproveService(makeConfig(server.url), () => undefined);
    const command =
      "git worktree list --porcelain | grep '^worktree' | tail -n +2 | awk '{print $2}'";

    const result = await evaluate(service, command);

    expect(result.decision).toBe('approve');
    expect(server.calls()).toBe(2);
    expect(requestText(server.requests()[1])).toContain(
      'CODE-OWNED EFFECT SET (exact observation to copy): ["filesystem_read","process_execution"]',
    );
  });

  test('a production reviewer that omits process_execution still escalates', async () => {
    const server = startReviewServer([
      INTERPRETER_INTENT,
      INTERPRETER_EFFECT_REVIEW_MISSING_PROCESS,
    ]);
    servers.push(server);
    const service = new AutoApproveService(makeConfig(server.url), () => undefined);

    const result = await evaluate(
      service,
      "git worktree list --porcelain | grep '^worktree' | tail -n +2 | awk '{print $2}'",
    );

    expect(result.decision).toBe('escalate');
    expect(result.reasoning).toContain('independent effect reviewer conflicted');
    expect(server.calls()).toBe(2);
  });

  test('invalid deterministic effect facts skip the reviewer and return a distinct failure', async () => {
    const server = startReviewServer(['unused']);
    servers.push(server);
    const service = new AutoApproveService(makeConfig(server.url), () => undefined);
    const probe = service as unknown as VerifiedEffectReviewProbe;

    const outcome = await probe.runVerifiedEffectReview(
      'Bash',
      { command: 'git status --porcelain' },
      undefined,
      'moderate',
      ['verified_effects=filesystem_read,'],
      'review-test-model',
      new AbortController().signal,
      Date.now() + 1_000,
    );

    expect(outcome.kind).toBe('invalid-effect-facts');
    expect(server.calls()).toBe(0);
  });

  test('replay corpus approves only proven moderate reads and fail-closes adversarial variants', async () => {
    const server = startReviewServer([
      localRemoteOrInterpreterFixture(
        LOCAL_INTENT,
        REMOTE_INTENT,
        INTERPRETER_INTENT,
        REMOTE_INTERPRETER_INTENT,
      ),
      localRemoteOrInterpreterFixture(
        LOCAL_EFFECT_REVIEW,
        REMOTE_EFFECT_REVIEW,
        INTERPRETER_EFFECT_REVIEW,
        REMOTE_INTERPRETER_EFFECT_REVIEW,
      ),
    ]);
    servers.push(server);
    const service = new AutoApproveService(makeConfig(server.url), () => undefined);

    const awkWorktreeInventory = WORKTREE_INVENTORY.replace(
      'for wt in $(git worktree list --porcelain)',
      "for wt in $(git worktree list --porcelain | grep '^worktree' | tail -n +2 | awk '{print $2}')",
    );
    for (const command of [
      BRANCH_INVENTORY,
      SAFE_REWRITE,
      awkWorktreeInventory,
      'git status --porcelain',
    ]) {
      expect((await evaluate(service, command)).decision).toBe('approve');
    }
    expect(server.calls()).toBe(8);

    for (const command of [
      WORKTREE_INVENTORY.replace(
        'for wt in $(git worktree list --porcelain)',
        "for wt in $(git worktree list --porcelain | grep '^worktree' | tail -n +2 | awk '{print $2}' /tmp/paths)",
      ),
      'for f in a b; do git push origin main; done',
      'git status > /tmp/out',
    ]) {
      const result = await evaluate(service, command);
      expect(result.decision).toBe('escalate');
    }
    // Every adversarial command was rejected by the deterministic proof before
    // it could reach either the reviewer or a primary action model.
    expect(server.calls()).toBe(8);
  });

  test('reviewer disagreement escalates and never falls back to the primary model', async () => {
    const server = startReviewServer([LOCAL_INTENT, LOCAL_EFFECT_REVIEW_TOPICAL]);
    servers.push(server);
    const service = new AutoApproveService(makeConfig(server.url), () => undefined);

    const result = await evaluate(service, 'git status --porcelain');

    expect(result.decision).toBe('escalate');
    expect(result.reasoning).toContain('authorization matrix=escalate');
    expect(server.calls()).toBe(2);
  });

  test('a low-confidence independent report escalates even when its fields look benign', async () => {
    const server = startReviewServer([LOCAL_INTENT, LOCAL_EFFECT_REVIEW_LOW_CONFIDENCE]);
    servers.push(server);
    const service = new AutoApproveService(makeConfig(server.url), () => undefined);

    const result = await evaluate(service, 'git status --porcelain');

    expect(result.decision).toBe('escalate');
    expect(result.reasoning).toContain('independent effect reviewer conflicted');
    expect(server.calls()).toBe(2);
  });

  test('missing context, unknown shell, and high-risk proof matches all escalate without a model call', async () => {
    const server = startReviewServer([LOCAL_INTENT, LOCAL_EFFECT_REVIEW]);
    servers.push(server);
    const decisionLogs: string[] = [];
    const service = new AutoApproveService(
      makeConfig(server.url, { log_decisions: true }),
      (message) => decisionLogs.push(message),
    );

    const noContext = await evaluate(service, 'git status --porcelain', '   ');
    expect(noContext.decision).toBe('escalate');
    expect(noContext.reasoning).toContain('no current human authorization context');

    // The proof passes and verified mode computes its effective band before
    // the authority gate, but the missing-authority gate still escalates.
    // Because the result is not an eligible approval, final telemetry must
    // retain the classifier's raw high band rather than the effective moderate
    // band used by an approved verified read.
    const assignmentWithoutContext = await evaluate(
      service,
      'b=$(git status --porcelain); echo "$b"',
      '   ',
    );
    expect(assignmentWithoutContext.decision).toBe('escalate');
    expect(assignmentWithoutContext.reasoning).toContain('no current human authorization context');
    expect(decisionLogs).toContainEqual(
      expect.stringContaining('[band=high authority=no decided_by=model]'),
    );

    const unknownShell = await evaluate(service, "awk '{print $1}' file");
    expect(unknownShell.decision).toBe('escalate');
    expect(unknownShell.reasoning).toContain('proof rejected (interpreter)');

    const highRisk = await evaluate(service, 'echo rm -rf /');
    expect(highRisk.decision).toBe('escalate');
    expect(highRisk.reasoning).toContain('risk band=critical');
    expect(server.calls()).toBe(0);
  });

  test('the proof removes assignment false positives but preserves dangerous read words', async () => {
    const server = startReviewServer([LOCAL_INTENT, LOCAL_EFFECT_REVIEW]);
    servers.push(server);
    const decisionLogs: string[] = [];
    const service = new AutoApproveService(
      makeConfig(server.url, { log_decisions: true }),
      (message) => decisionLogs.push(message),
    );

    // The general classifier calls this high because the leading assignment
    // can alter the command environment. The proof establishes that the
    // substitution is a read-only status query, so verified mode may treat it
    // as effective moderate risk.
    const result = await evaluate(service, 'b=$(git status --porcelain); echo "$b"');

    expect(result.decision).toBe('approve');
    expect(result.reasoning).toContain('risk=moderate');
    expect(decisionLogs).toContainEqual(
      expect.stringContaining('[band=moderate authority=yes decided_by=model]'),
    );
    expect(server.calls()).toBe(2);

    // A proof-qualified read is not automatically low risk: the raw dangerous
    // whole-word backstop still keeps a credential path at high and terminal.
    const dangerousRead = await evaluate(service, 'cat ~/.ssh/id_rsa');
    expect(dangerousRead.decision).toBe('escalate');
    expect(dangerousRead.reasoning).toContain('risk band=high');
    if (dangerousRead.decision === 'escalate') {
      expect(dangerousRead.suppressSecondOpinion).toBe(true);
    }
    expect(server.calls()).toBe(2);
  });

  test('does not review a command longer than the exact reviewer bound', async () => {
    const server = startReviewServer([LOCAL_INTENT, LOCAL_EFFECT_REVIEW]);
    servers.push(server);
    const service = new AutoApproveService(makeConfig(server.url), () => undefined);
    const command = `echo "${'a'.repeat(2001)}"`;

    const result = await evaluate(service, command);

    expect(result.decision).toBe('escalate');
    expect(result.reasoning).toContain('reviewer input bound');
    if (result.decision === 'escalate') expect(result.suppressSecondOpinion).toBe(true);
    expect(server.calls()).toBe(0);
  });

  test('a denied session precedent overrides a verified reviewer approval', async () => {
    const server = startReviewServer([LOCAL_INTENT, LOCAL_EFFECT_REVIEW]);
    servers.push(server);
    const decisionLogs: string[] = [];
    const service = new AutoApproveService(
      makeConfig(server.url, { log_decisions: true, session_precedent: true }),
      (message) => decisionLogs.push(message),
    );
    const command = 'git status --porcelain';
    const store = new PrecedentStore();
    store.record(
      'Bash',
      signatureForOperation('Bash', { command }),
      'denied',
      true,
      '/same/project/path',
    );

    const result = await service.evaluate(
      'Bash',
      { command },
      'session-a',
      undefined,
      undefined,
      undefined,
      'session-a',
      false,
      'Please inspect the repository.',
      readerFrom(store),
      undefined,
      '/same/project/path',
    );

    expect(result.decision).toBe('escalate');
    expect(result.reasoning).toContain('Session precedent');
    if (result.decision === 'escalate') expect(result.suppressSecondOpinion).toBe(true);
    expect(server.calls()).toBe(2);
    expect(decisionLogs).toContainEqual(
      expect.stringContaining('[band=moderate authority=yes decided_by=precedent]'),
    );
  });

  test('malformed reviewer output escalates', async () => {
    const server = startReviewServer([LOCAL_INTENT, 'not a review']);
    servers.push(server);
    const service = new AutoApproveService(makeConfig(server.url), () => undefined);

    const result = await evaluate(service, 'git status --porcelain');

    expect(result.decision).toBe('escalate');
    expect(result.reasoning).toContain('independent effect reviewer was malformed');
    expect(server.calls()).toBe(2);
  });

  test('reviewer unavailability escalates', async () => {
    const server = startReviewServer([LOCAL_INTENT, 'unavailable'], [200, 503]);
    servers.push(server);
    const service = new AutoApproveService(makeConfig(server.url), () => undefined);

    const result = await evaluate(service, 'git status --porcelain');

    expect(result.decision).toBe('escalate');
    expect(result.reasoning).toContain('independent effect reviewer was unavailable');
    expect(server.calls()).toBe(2);
  });

  test('reviewer timeout escalates within the original deadline', async () => {
    const server = startReviewServer([LOCAL_INTENT, '__delay__']);
    servers.push(server);
    const service = new AutoApproveService(
      makeConfig(server.url, { timeout: 0.05 }),
      () => undefined,
    );

    const started = Date.now();
    const result = await evaluate(service, 'git status --porcelain');

    expect(result.decision).toBe('escalate');
    expect(result.reasoning).toContain('independent effect reviewer was timeout');
    expect(server.calls()).toBe(2);
    expect(Date.now() - started).toBeLessThan(250);
  });

  test('user cancellation still wins over a delayed verified review', async () => {
    const server = startReviewServer([LOCAL_INTENT, '__delay__']);
    servers.push(server);
    const service = new AutoApproveService(makeConfig(server.url), () => undefined);

    const evaluation = service.evaluate(
      'Bash',
      { command: 'git status --porcelain' },
      'session-a',
      undefined,
      undefined,
      42,
      'session-a',
      false,
      'Please inspect the repository.',
      undefined,
      undefined,
      '/same/project/path',
    );
    for (let i = 0; i < 100 && server.calls() < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(server.calls()).toBe(2);
    expect(service.cancel('answered locally', 42, 'session-a')).toBe(true);
    expect((await evaluation).decision).toBe('cancelled');
  });

  test('deterministic, structural, and subagent routes do not use verified review', async () => {
    const server = startReviewServer([
      LOCAL_INTENT,
      LOCAL_EFFECT_REVIEW,
      '{"decision":"approve","reasoning":"primary"}',
    ]);
    servers.push(server);
    const service = new AutoApproveService(
      makeConfig(server.url, {
        always_escalate_tools: ['AskUserQuestion'],
      }),
      () => undefined,
    );
    const deterministicService = new AutoApproveService(
      makeConfig(server.url, {
        approve_groups: ['vcs-read'],
      }),
      () => undefined,
    );

    expect((await evaluate(deterministicService, 'git status --porcelain')).decision).toBe(
      'approve',
    );
    expect(
      (await service.evaluate('AskUserQuestion', { questions: [{ question: 'Which branch?' }] }))
        .decision,
    ).toBe('escalate');
    expect(
      (
        await service.evaluate('Bash', { command: 'git status --porcelain' }, undefined, [
          'Inspect',
          'Explain',
          'Continue',
        ])
      ).decision,
    ).toBe('escalate');
    // A post-render subagent evaluation may call the service with isSubagent;
    // it stays on the ordinary primary path and cannot use the verified route.
    expect(
      (
        await evaluate(
          service,
          'git status --porcelain',
          'Please inspect the repository.',
          'subagent-session',
          true,
        )
      ).decision,
    ).toBe('approve');
    expect(server.calls()).toBe(1);
    expect(JSON.stringify(server.requests()[0])).not.toContain('You grade how strongly');
  });

  test('two same-path sessions retain their own authorization context under soak', async () => {
    const server = startReviewServer([LOCAL_INTENT, LOCAL_EFFECT_REVIEW]);
    servers.push(server);
    const service = new AutoApproveService(makeConfig(server.url), () => undefined);

    const rounds = await Promise.all(
      Array.from({ length: 8 }, (_, round) =>
        Promise.all([
          evaluate(
            service,
            'git status --porcelain',
            `Session A asks to inspect the repository in round ${round}.`,
            'session-A',
          ),
          evaluate(
            service,
            'git status --porcelain',
            `Session B asks to inspect the repository in round ${round}.`,
            'session-B',
          ),
        ]),
      ),
    );

    const results = rounds.flat();
    expect(results).toHaveLength(16);
    expect(results.every((result) => result.decision === 'approve')).toBe(true);
    expect(server.calls()).toBe(32);
    const requests = server.requests().map(requestText);
    const sessionARequests = requests.filter((request) => request.includes('Session A asks'));
    const sessionBRequests = requests.filter((request) => request.includes('Session B asks'));
    expect(sessionARequests.length).toBe(16);
    expect(sessionBRequests.length).toBe(16);
    expect(sessionARequests.every((request) => !request.includes('Session B asks'))).toBe(true);
    expect(sessionBRequests.every((request) => !request.includes('Session A asks'))).toBe(true);
    expect(requests.every((request) => request.includes('git status --porcelain'))).toBe(true);
  });
});
