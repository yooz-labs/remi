import { describe, expect, test } from 'bun:test';
import {
  SubagentViewRegistry,
  deriveSubagentTranscriptPath,
} from '../../src/api/subagent-view-registry.ts';

const MAIN = '/Users/y/.claude/projects/-Users-y-proj/7c3a497d-a1d8-4337-a359-d48bf74e69f8.jsonl';

describe('deriveSubagentTranscriptPath', () => {
  test('replaces .jsonl with the per-session subagents subdir (the on-disk layout)', () => {
    expect(deriveSubagentTranscriptPath(MAIN, 'ab2e2dd0b25acb847')).toBe(
      '/Users/y/.claude/projects/-Users-y-proj/7c3a497d-a1d8-4337-a359-d48bf74e69f8/subagents/agent-ab2e2dd0b25acb847.jsonl',
    );
  });
});

describe('SubagentViewRegistry', () => {
  test('records a subagent on start with the derived path, active', () => {
    const reg = new SubagentViewRegistry();
    reg.recordStart('a1', 'Explore', MAIN);
    expect(reg.size).toBe(1);
    expect(reg.list()).toEqual([
      {
        agentId: 'a1',
        agentType: 'Explore',
        transcriptPath: deriveSubagentTranscriptPath(MAIN, 'a1'),
        active: true,
      },
    ]);
    expect(reg.resolvePath('a1')).toBe(deriveSubagentTranscriptPath(MAIN, 'a1'));
  });

  test('stop marks inactive but keeps it viewable', () => {
    const reg = new SubagentViewRegistry();
    reg.recordStart('a1', 'Explore', MAIN);
    reg.recordStop('a1');
    expect(reg.size).toBe(1);
    expect(reg.list()[0]?.active).toBe(false);
    expect(reg.resolvePath('a1')).not.toBeNull();
  });

  test('active subagents are listed before finished ones', () => {
    const reg = new SubagentViewRegistry();
    reg.recordStart('done', 'code-reviewer', MAIN);
    reg.recordStop('done');
    reg.recordStart('running', 'Explore', MAIN);
    expect(reg.list().map((v) => v.agentId)).toEqual(['running', 'done']);
  });

  test('ignores empty agentId or transcript path (defensive)', () => {
    const reg = new SubagentViewRegistry();
    reg.recordStart(undefined, 'X', MAIN);
    reg.recordStart('', 'X', MAIN);
    reg.recordStart('a1', 'X', '');
    expect(reg.size).toBe(0);
    expect(reg.resolvePath('missing')).toBeNull();
    expect(() => reg.recordStop(undefined)).not.toThrow();
  });

  test('clear forgets everything (rotation)', () => {
    const reg = new SubagentViewRegistry();
    reg.recordStart('a1', 'Explore', MAIN);
    reg.clear();
    expect(reg.size).toBe(0);
    expect(reg.list()).toEqual([]);
  });

  test('rejects a path-traversal agentId (it becomes a path segment)', () => {
    const reg = new SubagentViewRegistry();
    reg.recordStart('../../etc/passwd', 'X', MAIN);
    reg.recordStart('a/b', 'X', MAIN);
    reg.recordStart('a.b', 'X', MAIN);
    expect(reg.size).toBe(0);
    reg.recordStart('ab2e2dd0b25acb847', 'Explore', MAIN); // the real hex shape
    expect(reg.size).toBe(1);
  });

  test('rejects a main transcript path without a .jsonl suffix (derivation guard)', () => {
    const reg = new SubagentViewRegistry();
    reg.recordStart('a1', 'Explore', '/Users/y/.claude/projects/-Users-y-proj/sess'); // no .jsonl
    expect(reg.size).toBe(0);
  });

  test('self-clears when the parent session rotates (main transcript path changes)', () => {
    const reg = new SubagentViewRegistry();
    const MAIN2 = MAIN.replace('7c3a497d', '99999999');
    reg.recordStart('a1', 'Explore', MAIN);
    reg.recordStart('a2', 'code-reviewer', MAIN); // same parent -> both kept
    expect(reg.size).toBe(2);
    reg.recordStart('a3', 'Explore', MAIN2); // new parent -> drop a1/a2
    expect(reg.list().map((v) => v.agentId)).toEqual(['a3']);
  });
});
