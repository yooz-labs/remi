import { afterEach, describe, expect, test } from 'bun:test';
import { AutoApproveService } from '../../src/auto-approve/auto-approve-service.ts';
import {
  PrecedentStore,
  readerFrom,
  signatureForOperation,
} from '../../src/auto-approve/precedent.ts';
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
  test('approves the observed branch inventory with one authorization call', async () => {
    const server = startReviewServer(['explicit']);
    servers.push(server);
    const logs: string[] = [];
    const service = new AutoApproveService(makeConfig(server.url), (line) => logs.push(line));

    const result = await evaluate(
      service,
      BRANCH_INVENTORY,
      'Please check which local branches have unpushed commits.',
    );

    expect(result.decision).toBe('approve');
    expect(server.calls()).toBe(1);
    expect(server.requests()[0]?.['max_tokens']).toBe(8);
    const request = requestText(server.requests()[0]);
    expect(request).toContain(BRANCH_INVENTORY);
    expect(request).toContain('Please check which local branches have unpushed commits.');
    // Text cannot mint explicit authorization; the measured provenance cap
    // collapses the deliberately over-strong response to implicit.
    expect(result.reasoning).toContain('authorization matrix=approve (grade=implicit)');
    expect(logs).toContain(
      '[AutoApprove session-a] VERIFIED REVIEW Bash: status=ok proof=proved risk=moderate leaves=4 observed_auth=explicit auth=implicit matrix=approve final=approve',
    );
  });

  test('approves the safe rewrite of the worktree inventory and no other model call', async () => {
    const server = startReviewServer(['implicit']);
    servers.push(server);
    const service = new AutoApproveService(makeConfig(server.url), () => undefined);

    const result = await evaluate(
      service,
      SAFE_REWRITE,
      'Please inspect the worktrees and show their current status.',
    );

    expect(result.decision).toBe('approve');
    expect(server.calls()).toBe(1);
    expect(requestText(server.requests()[0])).toContain(SAFE_REWRITE);
  });

  test('replay corpus approves only proven moderate reads and fail-closes adversarial variants', async () => {
    const server = startReviewServer(['implicit']);
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
    expect(server.calls()).toBe(4);

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
    expect(server.calls()).toBe(4);
  });

  test('reviewer disagreement escalates and never falls back to the primary model', async () => {
    const server = startReviewServer(['topical']);
    servers.push(server);
    const service = new AutoApproveService(makeConfig(server.url), () => undefined);

    const result = await evaluate(service, 'git status --porcelain');

    expect(result.decision).toBe('escalate');
    expect(result.reasoning).toContain('authorization matrix=escalate');
    expect(server.calls()).toBe(1);
  });

  test('missing context, unknown shell, and high-risk proof matches all escalate without a model call', async () => {
    const server = startReviewServer(['unexpected']);
    servers.push(server);
    const service = new AutoApproveService(makeConfig(server.url), () => undefined);

    const noContext = await evaluate(service, 'git status --porcelain', '   ');
    expect(noContext.decision).toBe('escalate');
    expect(noContext.reasoning).toContain('no current human authorization context');

    const unknownShell = await evaluate(service, "awk '{print $1}' file");
    expect(unknownShell.decision).toBe('escalate');
    expect(unknownShell.reasoning).toContain('proof rejected (interpreter)');

    const highRisk = await evaluate(service, 'echo rm -rf /');
    expect(highRisk.decision).toBe('escalate');
    expect(highRisk.reasoning).toContain('risk band=critical');
    expect(server.calls()).toBe(0);
  });

  test('the proof removes assignment false positives but preserves dangerous read words', async () => {
    const server = startReviewServer(['implicit']);
    servers.push(server);
    const service = new AutoApproveService(makeConfig(server.url), () => undefined);

    // The general classifier calls this high because the leading assignment
    // can alter the command environment. The proof establishes that the
    // substitution is a read-only status query, so verified mode may treat it
    // as effective moderate risk.
    const result = await evaluate(service, 'b=$(git status --porcelain); echo "$b"');

    expect(result.decision).toBe('approve');
    expect(result.reasoning).toContain('risk=moderate');
    expect(server.calls()).toBe(1);

    // A proof-qualified read is not automatically low risk: the raw dangerous
    // whole-word backstop still keeps a credential path at high and terminal.
    const dangerousRead = await evaluate(service, 'cat ~/.ssh/id_rsa');
    expect(dangerousRead.decision).toBe('escalate');
    expect(dangerousRead.reasoning).toContain('risk band=high');
    if (dangerousRead.decision === 'escalate') {
      expect(dangerousRead.suppressSecondOpinion).toBe(true);
    }
    expect(server.calls()).toBe(1);
  });

  test('does not review a command longer than the exact reviewer bound', async () => {
    const server = startReviewServer(['implicit']);
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
    const server = startReviewServer(['explicit']);
    servers.push(server);
    const service = new AutoApproveService(
      makeConfig(server.url, { session_precedent: true }),
      () => undefined,
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
    expect(server.calls()).toBe(1);
  });

  test('malformed reviewer output escalates', async () => {
    const server = startReviewServer(['not a grade']);
    servers.push(server);
    const service = new AutoApproveService(makeConfig(server.url), () => undefined);

    const result = await evaluate(service, 'git status --porcelain');

    expect(result.decision).toBe('escalate');
    expect(result.reasoning).toContain('reviewer was malformed');
    expect(server.calls()).toBe(1);
  });

  test('reviewer unavailability escalates', async () => {
    const server = startReviewServer(['unavailable'], 503);
    servers.push(server);
    const service = new AutoApproveService(makeConfig(server.url), () => undefined);

    const result = await evaluate(service, 'git status --porcelain');

    expect(result.decision).toBe('escalate');
    expect(result.reasoning).toContain('reviewer was unavailable');
    expect(server.calls()).toBe(1);
  });

  test('reviewer timeout escalates within the original deadline', async () => {
    const server = startReviewServer(['__delay__']);
    servers.push(server);
    const service = new AutoApproveService(
      makeConfig(server.url, { timeout: 0.05 }),
      () => undefined,
    );

    const started = Date.now();
    const result = await evaluate(service, 'git status --porcelain');

    expect(result.decision).toBe('escalate');
    expect(result.reasoning).toContain('reviewer was timeout');
    expect(server.calls()).toBe(1);
    expect(Date.now() - started).toBeLessThan(250);
  });

  test('user cancellation still wins over a delayed verified review', async () => {
    const server = startReviewServer(['__delay__']);
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
    for (let i = 0; i < 100 && server.calls() < 1; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(server.calls()).toBe(1);
    expect(service.cancel('answered locally', 42, 'session-a')).toBe(true);
    expect((await evaluation).decision).toBe('cancelled');
  });

  test('deterministic, structural, and subagent routes do not use verified review', async () => {
    const server = startReviewServer(['{"decision":"approve","reasoning":"primary"}']);
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
    const server = startReviewServer(['implicit']);
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
    expect(server.calls()).toBe(16);
    const requests = server.requests().map(requestText);
    expect(requests.filter((request) => request.includes('Session A asks')).length).toBe(8);
    expect(requests.filter((request) => request.includes('Session B asks')).length).toBe(8);
    expect(requests.every((request) => request.includes('git status --porcelain'))).toBe(true);
  });
});
