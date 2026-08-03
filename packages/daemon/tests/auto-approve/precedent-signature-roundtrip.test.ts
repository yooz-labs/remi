/**
 * #976: the RECORD side and the CONSULT side must derive the same signature.
 *
 * This is the one property the precedent widening rests on, and its failure
 * mode is invisible. Precedent records from an answered `Question.text`
 * (parsed by `parsePermissionQuestionText`) and consults from a raw
 * `(toolName, toolInput)` at decision time (`signatureForOperation`). If those
 * two ever produce different strings for the same operation, `matchApproved`
 * — an EXACT match by design — silently never fires. Nothing errors, nothing
 * logs; precedent just stops working, which looks exactly like "the user has
 * not approved this before."
 *
 * So this file does not test the two functions separately. It runs the REAL
 * `HookEventBridge.buildPermissionQuestion` to produce the question a user
 * would actually answer, parses it with the real record-side parser, and
 * compares against the real consult-side deriver. No literal expected strings:
 * a hardcoded `'Bash: git push'` would keep passing if BOTH sides changed
 * together, which is the case that matters least, and would fail spuriously on
 * a cosmetic question-text change, which is the case that matters not at all.
 */

import { describe, expect, test } from 'bun:test';
import type { Question, UUID } from '@remi/shared';
import {
  parsePermissionQuestionText,
  signatureForOperation,
} from '../../src/auto-approve/precedent.ts';
import { HookEventBridge } from '../../src/hooks/hook-event-bridge.ts';
import type { PermissionRequestHookInput } from '../../src/hooks/index.ts';

function bridge(): HookEventBridge {
  return new HookEventBridge('session-roundtrip' as UUID, {
    onStatusChange: () => {},
    onQuestion: (): undefined => undefined,
  });
}

function permissionRequest(
  toolName: string,
  toolInput: Record<string, unknown>,
  agentType?: string,
): PermissionRequestHookInput {
  return {
    session_id: 'claude-test',
    transcript_path: '/tmp/t.jsonl',
    cwd: '/d',
    permission_mode: 'default',
    hook_event_name: 'PermissionRequest',
    tool_name: toolName,
    tool_input: toolInput,
    ...(agentType !== undefined ? { agent_type: agentType } : {}),
  };
}

/** Every tool shape `summarizeToolInput` branches on, plus the no-argument
 *  case. Each is a real operation, not a synthetic string. */
const OPERATIONS: Array<[string, Record<string, unknown>]> = [
  ['Bash', { command: 'git push origin feature/x' }],
  ['Bash', { command: 'rm -rf ./build && bun run build' }],
  ['Bash', { cmd: 'ls -la' }],
  ['Write', { file_path: '/Users/x/project/src/index.ts', content: 'x' }],
  ['Read', { file_path: '/etc/hosts' }],
  ['Edit', { path: '/tmp/a.txt', old_string: 'a', new_string: 'b' }],
  ['Glob', { pattern: '**/*.ts' }],
  ['Grep', { pattern: 'TODO', path: '.' }],
  ['WebFetch', { url: 'https://example.com/a' }],
  ['SomeMcpTool', { description: 'do the thing' }],
  ['ToolWithNoSummarizableArgument', { unknown_field: 1 }],
  // Whitespace inside the command: the record side normalizes on store, the
  // consult side does not -- the matchers normalize both. This pins that the
  // RAW strings still agree, so normalization is not papering over a drift.
  ['Bash', { command: 'echo  "two  spaces"' }],
];

describe('#976 record-side and consult-side signatures agree', () => {
  for (const [toolName, toolInput] of OPERATIONS) {
    test(`${toolName}: ${JSON.stringify(toolInput).slice(0, 50)}`, () => {
      const question: Question = bridge().buildPermissionQuestion(
        permissionRequest(toolName, toolInput),
      );
      const recorded = parsePermissionQuestionText(question.text);
      expect(recorded).not.toBeNull();
      expect(recorded?.toolName).toBe(toolName);
      // The whole point: the string the user's ANSWER would store equals the
      // string a later evaluation would look up.
      expect(recorded?.signature).toBe(signatureForOperation(toolName, toolInput));
    });
  }

  test('a SUBAGENT question round-trips to the same signature as the main agent', () => {
    // The agent prefix (`reviewer · Bash: ...`) is display, not identity. If
    // the parser left it in, a subagent's answer would never authorize the
    // main agent's identical operation and vice versa.
    const input = { command: 'git push origin feature/x' };
    const asSubagent = bridge().buildPermissionQuestion(
      permissionRequest('Bash', input, 'code-reviewer'),
    );
    expect(asSubagent.text).toContain('code-reviewer · ');
    expect(parsePermissionQuestionText(asSubagent.text)?.signature).toBe(
      signatureForOperation('Bash', input),
    );
  });
});

describe('#976 truncation stays aligned across the split', () => {
  test('a >120-char Bash command truncates identically on both sides', () => {
    // `summarizeToolInput` is now shared, so this cannot drift -- which is
    // exactly why it is worth pinning: the previous arrangement had the cap in
    // a private method the consult side would have had to reimplement.
    const command = `echo ${'x'.repeat(300)}`;
    const question = bridge().buildPermissionQuestion(permissionRequest('Bash', { command }));
    const derived = signatureForOperation('Bash', { command });
    expect(derived.endsWith('...')).toBe(true);
    expect(question.text).toBe(`Allow ${derived}`);
  });

  test('a truncated signature is refused by the RECORD side, so it never stores', () => {
    // The other half of the truncation defense: both sides see the same
    // truncated string, and the record side declines it rather than storing a
    // signature that two different commands could share.
    const command = `echo ${'x'.repeat(300)}`;
    const question = bridge().buildPermissionQuestion(permissionRequest('Bash', { command }));
    expect(parsePermissionQuestionText(question.text)).toBeNull();
  });

  test('a long file_path is NOT truncated, on either side', () => {
    // Read/Write/Edit return the path verbatim at any length -- only Bash and
    // the generic fallback truncate. Pinned because `precedent.ts`'s own doc
    // used to claim otherwise, and because "is this value capped?" decides
    // whether the truncation refusal covers it.
    const file_path = `/Users/x/${'d/'.repeat(80)}file.ts`;
    expect(file_path.length).toBeGreaterThan(120);
    const derived = signatureForOperation('Write', { file_path, content: 'x' });
    expect(derived.endsWith('...')).toBe(false);
    const question = bridge().buildPermissionQuestion(
      permissionRequest('Write', { file_path, content: 'x' }),
    );
    expect(parsePermissionQuestionText(question.text)?.signature).toBe(derived);
  });
});
