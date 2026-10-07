/**
 * The Phase 5 wire change is additive (#1179, #1165 A and B): the golden
 * fixtures of the five messages it touches gain fields and lose nothing.
 *
 * Each `LEGACY` literal below is the golden as it stood before Phase 5, minus
 * its random `id` and `timestamp`. The test holds the CURRENT fixture to two
 * rules:
 * 1. every legacy field is still there with the same value (an older client
 *    that ignores unknown fields keeps working), and
 * 2. the fields that are not legacy are exactly the named additions.
 *
 * Regenerating the fixtures rewrites every file's random `id` and `timestamp`,
 * which is not part of this contract, so those two are not compared.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'protocol');

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function load(name: string): { [key: string]: Json } {
  const parsed = JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.json`), 'utf-8')) as {
    [key: string]: Json;
  };
  const { id: _id, timestamp: _timestamp, ...rest } = parsed;
  return rest;
}

/** Paths in `current` that `legacy` does not have; `legacy` fields that changed or went missing are reported as `-path`. */
function diffPaths(legacy: Json, current: Json, at = ''): string[] {
  if (Array.isArray(legacy)) {
    if (!Array.isArray(current) || current.length !== legacy.length) return [`-${at}`];
    return legacy.flatMap((item, i) => diffPaths(item, current[i] as Json, `${at}[${i}]`));
  }
  if (typeof legacy === 'object' && legacy !== null) {
    if (typeof current !== 'object' || current === null || Array.isArray(current))
      return [`-${at}`];
    const lost = Object.keys(legacy).flatMap((key) =>
      key in current
        ? diffPaths(legacy[key] as Json, current[key] as Json, at === '' ? key : `${at}.${key}`)
        : [`-${at === '' ? key : `${at}.${key}`}`],
    );
    const added = Object.keys(current)
      .filter((key) => !(key in legacy))
      .map((key) => (at === '' ? key : `${at}.${key}`));
    return [...lost, ...added];
  }
  return legacy === current ? [] : [`-${at}`];
}

const CLAUDE_ID = 'fixture-claude-session-id';

const LEGACY: Record<string, { value: { [key: string]: Json }; added: string[] }> = {
  hello_ack: {
    value: {
      type: 'hello_ack',
      serverVersion: '1.0.0',
      sessionId: 'fixture-session-id',
      isResume: false,
      replayCount: 0,
      nextBulletId: 1,
      claudeSessionId: CLAUDE_ID,
      transcriptPath: '/Users/fixture/transcript.jsonl',
      attachState: 'attached',
      daemonVersion: '0.7.4-dev.1',
    },
    added: ['harness', 'harnessSessionId', 'harnesses', 'protocolVersion', 'capabilities'],
  },
  question: {
    value: {
      type: 'question',
      question: {
        id: 'fixture-question-id',
        text: 'Allow Bash: ls?',
        options: [
          {
            label: 'Yes',
            value: 'yes',
            isRecommended: true,
            isYes: true,
            isNo: false,
          },
        ],
        allowsFreeText: false,
        isAnswered: false,
      },
      sessionId: 'fixture-session-id',
      claudeSessionId: CLAUDE_ID,
    },
    added: ['harness', 'harnessSessionId'],
  },
  session_list_response: {
    value: {
      type: 'session_list_response',
      sessions: [
        {
          sessionId: 'fixture-session-id',
          name: 'fixture-host/fixture-project/main',
          projectPath: '/Users/fixture/project',
          status: 'active',
          createdAt: '2026-01-01T00:00:00.000Z',
          lastActivity: '2026-01-01T00:00:00.000Z',
          messageCount: 3,
          model: 'yooz-quality',
          lastMessage: 'Last message preview',
          source: 'daemon',
          canAttach: true,
          canResume: false,
          claudeSessionId: CLAUDE_ID,
          transcriptPath: '/Users/fixture/transcript.jsonl',
          wsPort: 19924,
          daemonHost: 'fixture-host',
        },
      ],
      requestId: 'fixture-request-id',
      daemonPorts: [19924, 19925],
    },
    added: ['sessions[0].harness', 'sessions[0].harnessSessionId'],
  },
  create_session_request: {
    value: { type: 'create_session_request', directory: '/Users/fixture/project' },
    added: ['harness', 'args'],
  },
  create_session_response: {
    value: {
      type: 'create_session_response',
      success: true,
      requestId: 'fixture-request-id',
      sessionId: 'fixture-session-id',
      port: 19924,
    },
    added: ['notice'],
  },
};

describe('the Phase 5 golden fixtures only add fields (#1179)', () => {
  for (const [name, { value, added }] of Object.entries(LEGACY)) {
    test(`${name}: every legacy field is unchanged and exactly ${added.join(', ')} were added`, () => {
      expect(diffPaths(value, load(name)).sort()).toEqual([...added].sort());
    });
  }

  test('the Claude fixtures dual-emit: harnessSessionId equals claudeSessionId', () => {
    const ack = load('hello_ack');
    expect(ack['harness']).toBe('claude');
    expect(ack['harnessSessionId']).toBe(CLAUDE_ID);
    expect(ack['harnessSessionId']).toBe(ack['claudeSessionId']);

    const question = load('question');
    expect(question['harness']).toBe('claude');
    expect(question['harnessSessionId']).toBe(question['claudeSessionId']);

    const listed = (load('session_list_response')['sessions'] as { [key: string]: Json }[])[0];
    expect(listed?.['harness']).toBe('claude');
    expect(listed?.['harnessSessionId']).toBe(listed?.['claudeSessionId']);
  });

  test('the hello_ack fixture names the protocol version and the capabilities (#1237)', () => {
    const ack = load('hello_ack');
    expect(ack['protocolVersion']).toBe(1);
    expect(ack['capabilities']).toEqual(['workspaces']);
  });

  test('the hello_ack_legacy golden is the ack of a daemon before #1237: the same, without version or capabilities', () => {
    const { protocolVersion: _v, capabilities: _c, ...before } = load('hello_ack');
    expect(load('hello_ack_legacy')).toEqual(before);
  });

  test('the hello_ack fixture advertises the harnesses a client may ask for', () => {
    expect(load('hello_ack')['harnesses']).toEqual(['claude', 'codex']);
  });

  test('the plain create_session_request golden is exactly the request an older client sends: no harness, no arguments (G16)', () => {
    // The registry fixture became a Codex request in Phase 5; the plain shape stays pinned here.
    expect(load('create_session_request_plain')).toEqual({
      type: 'create_session_request',
      directory: '/Users/fixture/project',
    });
  });

  test('the workspace goldens: a request for a new worktree, and the response that says where (#1236)', () => {
    expect(load('create_session_request_workspace')).toEqual({
      type: 'create_session_request',
      directory: '/Users/fixture/project',
      workspace: {
        repository: '/Users/fixture/project',
        worktree: { branch: 'feature/fixture', base: 'main' },
      },
    });
    expect(load('create_session_response_workspace')).toEqual({
      type: 'create_session_response',
      success: true,
      requestId: 'fixture-request-id',
      sessionId: 'fixture-session-id',
      port: 19924,
      workspace: {
        repository: '/Users/fixture/project',
        directory: '/Users/fixture/remi-worktrees/project-feature-fixture',
        worktree: { branch: 'feature/fixture', base: '0123456789abcdef0123456789abcdef01234567' },
      },
    });
  });

  test('the create_session_request fixture names a harness and its arguments', () => {
    const request = load('create_session_request');
    expect(request['harness']).toBe('codex');
    expect(request['args']).toEqual(['-m', 'fixture-model']);
  });

  test('the create_session_response fixture carries a notice, which says nothing of readiness being known', () => {
    const notice = load('create_session_response')['notice'];
    expect(typeof notice).toBe('string');
    expect((notice as string).length).toBeGreaterThan(0);
  });

  test('the diff helper reports a lost or changed legacy field, so this test can fail', () => {
    const legacy = { a: 1, nested: { b: 'x' }, list: [1, 2] };
    expect(diffPaths(legacy, { a: 1, nested: { b: 'x' }, list: [1, 2] })).toEqual([]);
    expect(diffPaths(legacy, { a: 1, nested: { b: 'x', c: 2 }, list: [1, 2] })).toEqual([
      'nested.c',
    ]);
    expect(diffPaths(legacy, { a: 2, nested: { b: 'x' }, list: [1, 2] })).toEqual(['-a']);
    expect(diffPaths(legacy, { nested: { b: 'x' }, list: [1, 2] })).toEqual(['-a']);
    expect(diffPaths(legacy, { a: 1, nested: { b: 'x' }, list: [1] })).toEqual(['-list']);
  });
});
