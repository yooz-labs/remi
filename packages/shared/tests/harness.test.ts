/**
 * Tests for the harness identity vocabulary (#1162, ADR 0032).
 *
 * Everything is imported through the package index, the only path consumers
 * use (there is deliberately no `package.json` exports entry for it).
 */

import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_HARNESS,
  HARNESS_IDS,
  createHelloAck,
  createQuestion,
  createSessionListResponse,
  deserialize,
  identityFromClaudeId,
  isHarnessId,
  serialize,
} from '../src/index.ts';
import type {
  Decision,
  DiscoverableSession,
  HarnessId,
  HelloAckMessage,
  Question,
  QuestionMessage,
  SessionIdentity,
} from '../src/index.ts';

describe('HARNESS_IDS', () => {
  test('names exactly claude, codex and opencode, in that order', () => {
    expect([...HARNESS_IDS]).toEqual(['claude', 'codex', 'opencode']);
  });
});

describe('DEFAULT_HARNESS', () => {
  test('is claude, and is one of the named harnesses', () => {
    expect(DEFAULT_HARNESS).toBe('claude');
    expect(HARNESS_IDS).toContain(DEFAULT_HARNESS);
  });
});

describe('isHarnessId', () => {
  test('accepts every named harness', () => {
    for (const id of HARNESS_IDS) {
      expect(isHarnessId(id)).toBe(true);
    }
  });

  test('rejects anything else, including near misses and non-strings', () => {
    const rejected: unknown[] = [
      'Claude',
      'CLAUDE',
      ' claude',
      'claude ',
      'gpt',
      'cursor',
      '',
      null,
      undefined,
      0,
      1,
      true,
      {},
      ['claude'],
    ];
    for (const value of rejected) {
      expect(isHarnessId(value)).toBe(false);
    }
  });

  test('narrows an unknown value so it can index a HarnessId-keyed record', () => {
    const labels: Record<HarnessId, string> = {
      claude: 'Claude Code',
      codex: 'Codex',
      opencode: 'OpenCode',
    };
    const stored: unknown = 'codex';
    // Only compiles because isHarnessId narrows `unknown` to HarnessId.
    expect(isHarnessId(stored) ? labels[stored] : null).toBe('Codex');
  });
});

describe('identityFromClaudeId', () => {
  test('wraps a Claude Code session id as a claude identity', () => {
    expect(identityFromClaudeId('3f9c2a1e-0000-4000-8000-000000000001')).toEqual({
      harness: 'claude',
      harnessSessionId: '3f9c2a1e-0000-4000-8000-000000000001',
    });
  });

  test('keeps a not-yet-known id as null, never the string "null" or undefined', () => {
    const identity: SessionIdentity = identityFromClaudeId(null);
    expect(identity).toEqual({ harness: 'claude', harnessSessionId: null });
    expect(Object.keys(identity).sort()).toEqual(['harness', 'harnessSessionId']);
  });

  test('uses the default harness', () => {
    expect(identityFromClaudeId('x').harness).toBe(DEFAULT_HARNESS);
  });
});

describe('Decision', () => {
  // Compile-time pin, enforced by `bun run typecheck` (test files are in its
  // include). `Decision` is an alias of `Question`, not a new shape (#1161
  // decided policy); if it ever becomes a distinct type, `Equal` resolves to
  // false and this assignment stops compiling. The runtime assertion below
  // only keeps the constant used.
  type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
  const decisionIsQuestion: Equal<Decision, Question> = true;

  test('is the same type as Question (checked at compile time)', () => {
    expect(decisionIsQuestion).toBe(true);
  });
});

describe('typed optional wire fields (#1162)', () => {
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const claudeId = '22222222-2222-4222-8222-222222222222';
  const question: Question = {
    id: '33333333-3333-4333-8333-333333333333',
    text: 'Allow Bash: ls?',
    options: [],
    allowsFreeText: false,
    isAnswered: false,
  };
  const discoverable: DiscoverableSession = {
    sessionId,
    projectPath: '/tmp/project',
    status: 'active',
    lastActivity: '2026-10-02T00:00:00.000Z',
    messageCount: 0,
    source: 'daemon',
    canAttach: true,
    canResume: false,
    claudeSessionId: claudeId,
  };

  test('no message factory emits harness or harnessSessionId', () => {
    const ack = createHelloAck('0.0.0-test', sessionId, {
      resumeInfo: { isResume: true, replayCount: 3, nextBulletId: 7 },
      binding: { claudeSessionId: claudeId, transcriptPath: '/tmp/t.jsonl' },
      attachState: 'attached',
      daemonVersion: '0.0.0-test',
    });
    const asked = createQuestion(question, sessionId, claudeId);
    const list = createSessionListResponse([discoverable], sessionId, [18765]);

    for (const message of [ack, asked, list]) {
      const wire = serialize(message);
      expect(wire).not.toContain('harness');
      expect(Object.keys(message)).not.toContain('harness');
      expect(Object.keys(message)).not.toContain('harnessSessionId');
    }
  });

  test('a message that does carry them round-trips, and exactOptionalPropertyTypes allows absence and undefined', () => {
    // Each assignment only compiles with `harness?: HarnessId | undefined` and
    // `harnessSessionId?: ... | undefined`: the repo sets exactOptionalPropertyTypes.
    const base = createQuestion(question, sessionId, claudeId);
    const withIdentity: QuestionMessage = {
      ...base,
      harness: 'codex',
      harnessSessionId: 'thread-1',
    };
    const withUndefined: QuestionMessage = {
      ...base,
      harness: undefined,
      harnessSessionId: undefined,
    };
    const ack: HelloAckMessage = {
      ...createHelloAck('0.0.0-test', null),
      harness: 'claude',
      harnessSessionId: null,
    };
    const listed: DiscoverableSession = {
      ...discoverable,
      harness: 'opencode',
      harnessSessionId: 'ses_1',
    };

    const back = deserialize(serialize(withIdentity)) as QuestionMessage;
    expect(back.harness).toBe('codex');
    expect(back.harnessSessionId).toBe('thread-1');
    expect(back.claudeSessionId).toBe(claudeId);

    // JSON drops undefined, so the wire form of an undefined field is absence.
    expect(serialize(withUndefined)).not.toContain('harness');

    const backAck = deserialize(serialize(ack)) as HelloAckMessage;
    expect(backAck.harness).toBe('claude');
    expect(backAck.harnessSessionId).toBeNull();

    const backList = deserialize(serialize(createSessionListResponse([listed], sessionId)));
    expect(backList?.type).toBe('session_list_response');
    if (backList?.type === 'session_list_response') {
      expect(backList.sessions[0]?.harness).toBe('opencode');
      expect(backList.sessions[0]?.harnessSessionId).toBe('ses_1');
    }
  });
});
