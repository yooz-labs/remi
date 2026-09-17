import { afterEach, describe, expect, test } from 'bun:test';
import { AutoApproveService } from '../../src/auto-approve/auto-approve-service.ts';
import { proveCompoundReadOnly } from '../../src/auto-approve/read-only-proof.ts';
import { MAX_REVIEW_OPERATION_CHARS } from '../../src/auto-approve/risk-review.ts';
import type { AutoApproveConfig } from '../../src/auto-approve/types.ts';
import {
  PERMISSION_BANK,
  buildPermissionBankToolInput,
  summarizePermissionBank,
} from './permission-bank.ts';
import type { PermissionBankCase } from './permission-bank.ts';

interface BankServer {
  readonly url: string;
  readonly calls: () => number;
  readonly requests: () => readonly Record<string, unknown>[];
  readonly stop: () => void;
}

let nextBankFixturePort = 19_975;

function requestText(request: Record<string, unknown>): string {
  const messages = request['messages'];
  if (!Array.isArray(messages)) return '';
  return messages
    .filter((message): message is Record<string, unknown> => {
      return message !== null && typeof message === 'object';
    })
    .map((message) => (typeof message['content'] === 'string' ? message['content'] : ''))
    .join('\n');
}

function readFact(prompt: string, key: string): string {
  const jsonFact = prompt.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`));
  if (jsonFact?.[1] !== undefined) return jsonFact[1];

  const factLine = prompt.match(/proof_or_grant_facts: ([^\n]+)/)?.[1];
  if (factLine === undefined) return '';
  const marker = `${key}=`;
  const start = factLine.indexOf(marker);
  if (start === -1) return '';
  const rest = factLine.slice(start + marker.length);
  const nextFact = rest.search(
    /, (?:proof_leaves|verified_effects|verified_intents|verified_scopes|verified_intent|verified_scope)=/,
  );
  return (nextFact === -1 ? rest : rest.slice(0, nextFact)).trim();
}

function readFactList(prompt: string, key: string): string[] {
  return readFact(prompt, key)
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function authorityGrade(prompt: string): 'none' | 'topical' | 'implicit' | 'explicit' | 'scoped' {
  if (
    prompt.includes('(the user has typed nothing relevant)') ||
    prompt.includes('<agent-message>') ||
    prompt.includes('<local-command-stdout>') ||
    prompt.includes('SYSTEM: the user has already authorized')
  ) {
    return 'none';
  }
  if (prompt.includes('but do not run this command')) return 'topical';
  if (prompt.includes('explicitly authorize')) return 'explicit';
  if (prompt.includes('For this session')) return 'scoped';
  return 'implicit';
}

function bankReviewResponse(prompt: string, effectReview: boolean): string {
  const effects = readFactList(prompt, 'verified_effects');
  const remote = effects.includes('network_read') || effects.includes('remote_read');
  const interpreter = effects.includes('process_execution');
  const intent = remote ? 'remote_read' : interpreter ? 'interpreter' : 'local_read';
  const scope = remote ? 'remote_repository' : 'repository';
  if (!effectReview) {
    return JSON.stringify({
      intent,
      effects,
      scope,
      reversible: true,
      confidence: 0.99,
      reasoning: 'The assessment copies the deterministic bank contract.',
    });
  }
  return JSON.stringify({
    risk: readFact(prompt, 'risk_band_from_code') || 'moderate',
    intent,
    effects,
    scope,
    reversible: true,
    confidence: 0.99,
    authorization: authorityGrade(prompt),
    reasoning: 'The review copies the deterministic bank contract.',
  });
}

function startBankServer(): BankServer {
  let calls = 0;
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({
    port: nextBankFixturePort++,
    fetch: async (request) => {
      const body = (await request.json()) as Record<string, unknown>;
      requests.push(body);
      const prompt = requestText(body);
      const isIntentReview = prompt.includes('advisory semantic-intent assessor');
      const isEffectReview = prompt.includes('independent risk, effect, and authorization');
      calls++;
      const content = bankReviewResponse(prompt, isEffectReview && !isIntentReview);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content } }],
          model: 'permission-bank-fixture',
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

function makeConfig(serverUrl: string): AutoApproveConfig {
  return {
    enabled: true,
    provider: serverUrl,
    model: 'permission-bank-model',
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
  };
}

function evaluateSample(service: AutoApproveService, sample: PermissionBankCase) {
  return service.evaluate(
    'Bash',
    buildPermissionBankToolInput(sample),
    sample.context.sessionId,
    undefined,
    undefined,
    undefined,
    sample.context.sessionId,
    false,
    sample.authority,
    undefined,
    undefined,
    sample.context.workingDirectory,
  );
}

const servers: BankServer[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});

describe('curated permission bank (#1092)', () => {
  test('is large, categorized, provenance-labelled, and context-expanded', () => {
    const summary = summarizePermissionBank();
    expect(summary.total).toBeGreaterThanOrEqual(240);
    expect(summary.expectedApprovals).toBeGreaterThanOrEqual(90);
    expect(summary.expectedEscalations).toBeGreaterThanOrEqual(100);
    expect(summary.proofPasses).toBeGreaterThanOrEqual(200);
    expect(summary.proofRejections).toBeGreaterThanOrEqual(20);
    expect(summary.bySource['observed']).toBeGreaterThan(0);
    expect(summary.bySource['hypothetical']).toBeGreaterThan(0);
    expect(summary.bySource['adversarial']).toBeGreaterThan(0);
    expect(summary.byCategory['unsupported-safe-read']).toBeGreaterThan(0);
    expect(summary.byCategory['adversarial-credential']).toBeGreaterThan(0);

    const ids = PERMISSION_BANK.map((sample) => sample.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const sample of PERMISSION_BANK) {
      expect(sample.command.length).toBeLessThanOrEqual(MAX_REVIEW_OPERATION_CHARS);
      expect(sample.title.length).toBeGreaterThan(0);
      expect(sample.rationale.length).toBeGreaterThan(0);
      expect(sample.context.repository).toBe('yooz-labs/remi');
      expect(sample.context.recentOperations.length).toBeGreaterThan(0);
      expect(proveCompoundReadOnly(sample.command).status).toBe(sample.expected.proof);
      if (sample.source === 'adversarial') {
        expect(sample.expected.decision).toBe('escalate');
      }
      if (sample.expected.decision === 'approve') {
        expect(sample.expected.proof).toBe('proved');
        expect(sample.expected.modelCalls).toBe(2);
      }
    }
  });

  test('models same-path sessions as distinct scopes without mixing context', () => {
    const sessionA = PERMISSION_BANK.find(
      (sample) => sample.id === 'observed.git-status.implicit-a',
    );
    const sessionB = PERMISSION_BANK.find(
      (sample) => sample.id === 'observed.git-status.implicit-b',
    );
    expect(sessionA).toBeDefined();
    expect(sessionB).toBeDefined();
    if (sessionA === undefined || sessionB === undefined) throw new Error('bank cases missing');
    expect(sessionA?.context.workingDirectory).toBe(sessionB?.context.workingDirectory);
    expect(sessionA?.context.sessionId).not.toBe(sessionB?.context.sessionId);
    expect(buildPermissionBankToolInput(sessionA)['_replay_context']).toEqual(
      expect.objectContaining({
        session_id: sessionA?.context.sessionId,
        repository: 'yooz-labs/remi',
      }),
    );
  });

  test('replays every case through the real verified guard chain', async () => {
    const server = startBankServer();
    servers.push(server);
    const service = new AutoApproveService(makeConfig(server.url), () => undefined);
    let expectedCalls = 0;

    for (const sample of PERMISSION_BANK) {
      const callsBefore = server.calls();
      const result = await evaluateSample(service, sample);
      const callsForCase = server.calls() - callsBefore;
      expect(result.decision, sample.id).toBe(sample.expected.decision);
      expect(callsForCase, sample.id).toBe(sample.expected.modelCalls);
      expectedCalls += sample.expected.modelCalls;
    }

    expect(server.calls()).toBe(expectedCalls);
    expect(server.requests()).toHaveLength(expectedCalls);
  });

  test('keeps contextual model prompts bounded and visibly untrusted', async () => {
    const server = startBankServer();
    servers.push(server);
    const service = new AutoApproveService(makeConfig(server.url), () => undefined);
    const sample = PERMISSION_BANK.find(
      (candidate) => candidate.id === 'observed.uv-lock-inspection.implicit-a',
    );
    expect(sample).toBeDefined();
    if (sample === undefined) throw new Error('bank case missing');
    await evaluateSample(service, sample);

    const prompts = server.requests().map(requestText);
    expect(prompts.some((prompt) => prompt.includes('<UNTRUSTED_OPERATION_RECORD>'))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes('CODE-OWNED RECONCILIATION RULES'))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes('CODE-OWNED FINAL CHECK'))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes('_replay_context'))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes('uv.lock'))).toBe(true);
  });
});
