/**
 * #976: precedent as authorization, wired into the decision path.
 *
 * These drive the REAL `AutoApproveService.evaluate` with a REAL
 * `PrecedentStore` and REAL signatures. No engine is needed and none is
 * skipped: the approve direction returns at 0ms BEFORE any LLM call, which is
 * half the reason it sits where it does. Nothing here stubs a decision.
 *
 * `base_url` points at a port nothing listens on, deliberately. If any test
 * here ever reaches the model, it fails loudly instead of quietly measuring
 * something else — the "0ms, pre-LLM" claim is then not a comment, it is what
 * makes the test pass at all.
 */

import { describe, expect, test } from 'bun:test';
import { AutoApproveService } from '../../src/auto-approve/auto-approve-service.ts';
import {
  type PrecedentReader,
  PrecedentStore,
  signatureForOperation,
} from '../../src/auto-approve/precedent.ts';
import type { AutoApproveConfig } from '../../src/auto-approve/types.ts';

/** A URL nothing serves: reaching the model is a test failure, not a slow path. */
const UNREACHABLE = 'http://127.0.0.1:1';

function config(overrides?: Partial<AutoApproveConfig>): AutoApproveConfig {
  return {
    enabled: true,
    provider: UNREACHABLE,
    model: 'test-model',
    api_key: '',
    base_url: UNREACHABLE,
    timeout: 2,
    log_decisions: false,
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
    engine: 'owned' as const,
    engine_path: '',
    engine_port: 19924,
    engine_autostart: false,
    disable_thinking: true,
    always_escalate_tools: [],
    session_precedent: true,
    hold_timeout: 0,
    push_hold_timeout: 0,
    hold_unconfirmed_timeout: 0,
    ...overrides,
  } as AutoApproveConfig;
}

/** Read-only view of a real store, exactly as `hook-bridge-setup.ts` builds it. */
function readerFor(store: PrecedentStore): PrecedentReader {
  return {
    matchApproved: (tool, signature) => store.matchApproved(tool, signature),
    matchDenied: (tool, signature) => store.matchDenied(tool, signature),
  };
}

/** Record a human answer the way `handleAnswer` does: the signature the
 *  question carried, not a hand-written string. */
function humanAnswered(
  store: PrecedentStore,
  toolName: string,
  toolInput: Record<string, unknown>,
  decision: 'approved' | 'denied',
): void {
  store.record(toolName, signatureForOperation(toolName, toolInput), decision);
}

const service = (overrides?: Partial<AutoApproveConfig>) =>
  new AutoApproveService(config(overrides), () => {});

describe('#976 an earlier approval authorizes the identical repeat, at 0ms', () => {
  test('a moderate-band repeat approves on precedent alone', async () => {
    const store = new PrecedentStore();
    const input = { command: 'git push origin feature/x' };
    humanAnswered(store, 'Bash', input, 'approved');

    const result = await service().evaluate(
      'Bash',
      input,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      readerFor(store),
    );
    expect(result.decision).toBe('approve');
    expect(result.reasoning).toContain('session precedent');
    // 0ms is the claim, and with an unreachable base_url it is also the only
    // way this could have returned an approve at all.
    expect(result.durationMs).toBe(0);
  });

  test('a DIFFERENT command is not covered, however similar', async () => {
    // Exact match, per ADR 0010: precedent AUTHORIZES, so it must be precise.
    // `--force` and `main` are both new; either alone must break coverage.
    const store = new PrecedentStore();
    humanAnswered(store, 'Bash', { command: 'git push origin feature/x' }, 'approved');

    const result = await service().evaluate(
      'Bash',
      { command: 'git push --force origin main' },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      readerFor(store),
    );
    // Falls through to the LLM, which is unreachable -> escalate. The
    // assertion that matters is that it is NOT an approve.
    expect(result.decision).not.toBe('approve');
  });

  test('a SHORT approval does not cover a longer command that contains it', async () => {
    // The privilege escalation ADR 0010 names, and the one a plausible
    // "loosen it slightly" change reintroduces: approving `git push` must not
    // authorize `git push --force origin main`, which EMBEDS it as a prefix.
    //
    // Added after mutation-testing: swapping the exact comparison for
    // `target.includes(storedSignature)` turned ZERO tests red, because the
    // existing "different command" case differs in the MIDDLE (`--force`
    // between `push` and `origin`) and so fails a substring test too. Only a
    // genuine prefix relationship distinguishes exact from substring.
    const store = new PrecedentStore();
    humanAnswered(store, 'Bash', { command: 'git push' }, 'approved');

    const result = await service().evaluate(
      'Bash',
      { command: 'git push --force origin main' },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      readerFor(store),
    );
    expect(result.decision).not.toBe('approve');
  });

  test('a LONGER approval does not cover the shorter command inside it', async () => {
    // The other direction of the same mistake. `findDeniedPrecedent` matches
    // both ways ON PURPOSE (broad is right for a stop rule); the approve side
    // must match neither way.
    const store = new PrecedentStore();
    humanAnswered(store, 'Bash', { command: 'git push --dry-run origin main' }, 'approved');

    const result = await service().evaluate(
      'Bash',
      { command: 'git push' },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      readerFor(store),
    );
    expect(result.decision).not.toBe('approve');
  });

  test('a different TOOL with the same argument text is not covered', async () => {
    const store = new PrecedentStore();
    humanAnswered(store, 'Read', { file_path: '/etc/hosts' }, 'approved');
    const result = await service().evaluate(
      'Write',
      { file_path: '/etc/hosts', content: 'x' },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      readerFor(store),
    );
    expect(result.decision).not.toBe('approve');
  });
});

describe('#976 the matrix still bounds what a precedent may authorize', () => {
  test('a CRITICAL operation is never approved, even after the human approved it', async () => {
    // The deny floor's population. A human may answer a catastrophic operation
    // at a card every single time; one answer must not spend all future ones.
    const store = new PrecedentStore();
    const input = { command: 'rm -rf /' };
    humanAnswered(store, 'Bash', input, 'approved');

    const result = await service().evaluate(
      'Bash',
      input,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      readerFor(store),
    );
    expect(result.decision).not.toBe('approve');
  });

  test('a HIGH-band operation IS approved: a precedent carries the witness text cannot', async () => {
    // The asymmetry that makes the whole matrix worth building. `rm -rf` of a
    // project dir is `high`; no amount of conversation text can authorize it
    // (text caps at `implicit`), but an answer the human actually gave can.
    const store = new PrecedentStore();
    const input = { command: 'rm -rf ./build' };
    humanAnswered(store, 'Bash', input, 'approved');

    const result = await service().evaluate(
      'Bash',
      input,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      readerFor(store),
    );
    expect(result.decision).toBe('approve');
    expect(result.reasoning).toContain('band=high');
  });
});

describe('#976 the freshest human decision governs', () => {
  test('a later denial of the same operation revokes an earlier approval', async () => {
    const store = new PrecedentStore();
    const input = { command: 'git push origin feature/x' };
    humanAnswered(store, 'Bash', input, 'approved');
    humanAnswered(store, 'Bash', input, 'denied');

    const result = await service().evaluate(
      'Bash',
      input,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      readerFor(store),
    );
    expect(result.decision).not.toBe('approve');
  });
});

describe('#976 session_precedent gates the WIDENING only', () => {
  test('off: an earlier approval no longer authorizes a repeat', async () => {
    const store = new PrecedentStore();
    const input = { command: 'git push origin feature/x' };
    humanAnswered(store, 'Bash', input, 'approved');

    const result = await service({ session_precedent: false }).evaluate(
      'Bash',
      input,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      readerFor(store),
    );
    expect(result.decision).not.toBe('approve');
  });

  test('off: an earlier DENIAL is still honored -- the flag is not "forget my no"', async () => {
    // The deny direction is post-model and needs an LLM verdict to downgrade,
    // so what is asserted here is the reachable half: with the flag off and a
    // denial on record, nothing approves. A user who asked for fewer 0ms
    // approvals did not ask to have their refusals discarded.
    const store = new PrecedentStore();
    const input = { command: 'git push --force origin main' };
    humanAnswered(store, 'Bash', input, 'denied');

    const result = await service({ session_precedent: false }).evaluate(
      'Bash',
      input,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      readerFor(store),
    );
    expect(result.decision).not.toBe('approve');
  });
});

describe('#976 no precedent reader means pre-#976 behavior', () => {
  test('omitting the reader consults nothing and reaches the normal path', async () => {
    const result = await service().evaluate('Bash', { command: 'git push origin feature/x' });
    expect(result.decision).not.toBe('approve');
    expect(result.reasoning).not.toContain('session precedent');
  });
});

describe('#976 the user’s own config still wins over precedent', () => {
  test('a deny_groups match beats an approved precedent', async () => {
    // Ordering, made observable: config deny is checked first and returns
    // before the precedent consult. A standing rule the user WROTE must not be
    // overridden by an answer they gave once.
    const store = new PrecedentStore();
    const input = { command: 'mkdir /tmp/x' };
    humanAnswered(store, 'Bash', input, 'approved');

    const result = await service({ deny_groups: ['fs-write'] }).evaluate(
      'Bash',
      input,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      readerFor(store),
    );
    expect(result.decision).toBe('deny');
  });
});
