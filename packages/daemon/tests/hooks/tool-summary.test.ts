/**
 * #990: `summarizeToolInput`'s two forms -- DISPLAY (default, truncates a
 * long Bash command to 120 chars) and SIGNATURE (`forSignature: true`,
 * never truncates). Precedent's exact-match authorization depends on the
 * signature form being genuinely untruncated at any length; this file pins
 * that property directly at the source, independent of `precedent.ts` or
 * `HookEventBridge` (both are covered separately -- this is the one place
 * the two forms can diverge, so it gets its own focused coverage).
 */

import { describe, expect, it } from 'bun:test';
import { summarizeToolInput } from '../../src/hooks/tool-summary.ts';

describe('summarizeToolInput — display form (default)', () => {
  it('returns a Bash command verbatim under the 120-char cap', () => {
    expect(summarizeToolInput('Bash', { command: 'git push origin main' })).toBe(
      'git push origin main',
    );
  });

  it('truncates a Bash command over 120 chars to 117 chars + "..."', () => {
    const command = `echo ${'x'.repeat(300)}`;
    const summary = summarizeToolInput('Bash', { command });
    expect(summary).not.toBeNull();
    expect(summary?.length).toBe(120);
    expect(summary?.endsWith('...')).toBe(true);
    expect(summary).toBe(`${command.slice(0, 117)}...`);
  });

  it('does not truncate a long file_path (Read/Write/Edit)', () => {
    const file_path = `/Users/x/${'d/'.repeat(80)}file.ts`;
    expect(file_path.length).toBeGreaterThan(120);
    expect(summarizeToolInput('Write', { file_path, content: 'x' })).toBe(file_path);
  });

  it('does not truncate a long Glob/Grep pattern', () => {
    const pattern = `**/${'x'.repeat(150)}/*.ts`;
    expect(summarizeToolInput('Glob', { pattern })).toBe(pattern);
  });

  it('does not truncate a long WebFetch url', () => {
    const url = `https://example.com/${'x'.repeat(150)}`;
    expect(summarizeToolInput('WebFetch', { url })).toBe(url);
  });

  it('explicit forSignature: false behaves exactly like the default', () => {
    const command = `echo ${'x'.repeat(300)}`;
    expect(summarizeToolInput('Bash', { command }, { forSignature: false })).toBe(
      summarizeToolInput('Bash', { command }),
    );
  });
});

describe('summarizeToolInput — signature form (forSignature: true, #990)', () => {
  it('returns the FULL Bash command past 120 chars, never truncated', () => {
    const command = `echo ${'x'.repeat(300)}`;
    const summary = summarizeToolInput('Bash', { command }, { forSignature: true });
    expect(summary).toBe(command);
    expect(summary?.endsWith('...')).toBe(false);
  });

  it('two commands that DISPLAY-truncate to the identical summary remain distinct as signatures', () => {
    const prefix = 'a'.repeat(117);
    const cmdA = `${prefix} && echo one`;
    const cmdB = `${prefix} && echo two-but-different`;
    // Sanity: the display forms really do collide (the #990 bug shape).
    expect(summarizeToolInput('Bash', { command: cmdA })).toBe(
      summarizeToolInput('Bash', { command: cmdB }),
    );
    // The signature forms must not.
    const sigA = summarizeToolInput('Bash', { command: cmdA }, { forSignature: true });
    const sigB = summarizeToolInput('Bash', { command: cmdB }, { forSignature: true });
    expect(sigA).not.toBe(sigB);
    expect(sigA).toBe(cmdA);
    expect(sigB).toBe(cmdB);
  });

  it('a short Bash command is identical in both forms', () => {
    expect(summarizeToolInput('Bash', { command: 'git status' }, { forSignature: true })).toBe(
      summarizeToolInput('Bash', { command: 'git status' }),
    );
  });

  it('Read/Write/Edit/Glob/Grep/WebFetch are unaffected by forSignature (already untruncated)', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['Write', { file_path: '/tmp/a.txt', content: 'x' }],
      ['Read', { file_path: '/tmp/a.txt' }],
      ['Edit', { path: '/tmp/a.txt', old_string: 'a', new_string: 'b' }],
      ['Glob', { pattern: '**/*.ts' }],
      ['Grep', { pattern: 'TODO' }],
      ['WebFetch', { url: 'https://example.com' }],
    ];
    for (const [toolName, toolInput] of cases) {
      expect(summarizeToolInput(toolName, toolInput, { forSignature: true })).toBe(
        summarizeToolInput(toolName, toolInput),
      );
    }
  });

  it('the Bash `cmd` fallback field is also untruncated under forSignature', () => {
    const cmd = `ls ${'x'.repeat(300)}`;
    expect(summarizeToolInput('Bash', { cmd }, { forSignature: true })).toBe(cmd);
  });

  it('returns null for a tool with no summarizable argument, in either form', () => {
    expect(summarizeToolInput('SomeTool', { unrelated: 1 })).toBeNull();
    expect(summarizeToolInput('SomeTool', { unrelated: 1 }, { forSignature: true })).toBeNull();
  });
});
