import { describe, expect, test } from 'bun:test';
import { extractJsonObject } from '../../src/auto-approve/json-extract.ts';

describe('extractJsonObject', () => {
  test('parses a bare object', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  test('parses an object with surrounding whitespace', () => {
    expect(extractJsonObject('  \n {"a":1}\n ')).toEqual({ a: 1 });
  });

  test('strips a ```json code fence', () => {
    expect(extractJsonObject('```json\n{"decision":"approve"}\n```')).toEqual({
      decision: 'approve',
    });
  });

  test('strips a bare ``` fence with no language tag', () => {
    expect(extractJsonObject('```\n{"decision":"deny"}\n```')).toEqual({ decision: 'deny' });
  });

  test('extracts the first balanced object after a preamble', () => {
    expect(extractJsonObject('Sure, here it is: {"decision":"escalate"} done')).toEqual({
      decision: 'escalate',
    });
  });

  test('is string-aware: braces inside a string value do not miscount', () => {
    expect(extractJsonObject('{"reasoning":"glob {a,b} and a } brace","decision":"deny"}')).toEqual(
      {
        reasoning: 'glob {a,b} and a } brace',
        decision: 'deny',
      },
    );
  });

  test('honours escaped quotes inside string values', () => {
    expect(extractJsonObject('{"reasoning":"a \\"quoted\\" word","decision":"approve"}')).toEqual({
      reasoning: 'a "quoted" word',
      decision: 'approve',
    });
  });

  test('returns null for free text with no object', () => {
    expect(extractJsonObject('I would approve this but it is risky')).toBeNull();
  });

  test('returns null for a JSON array (must be an object)', () => {
    expect(extractJsonObject('[{"decision":"approve"}]')).toBeNull();
  });

  test('returns null for a JSON null/number literal', () => {
    expect(extractJsonObject('null')).toBeNull();
    expect(extractJsonObject('42')).toBeNull();
  });

  test('returns null for an unbalanced/truncated object', () => {
    expect(extractJsonObject('{"decision":"approve"')).toBeNull();
  });

  test('parses a fenced object whose reasoning carries newlines', () => {
    const raw = '```json\n{\n  "decision": "approve",\n  "reasoning": "safe\\nread"\n}\n```';
    expect(extractJsonObject(raw)).toEqual({ decision: 'approve', reasoning: 'safe\nread' });
  });
});
