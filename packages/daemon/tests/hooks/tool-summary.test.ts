/**
 * `summarizeToolInput`'s display form: a long Bash command truncates to 120
 * chars, paths/patterns/urls never do. (The untruncated SIGNATURE form, #990,
 * was deleted with auto-approve precedent in #1125.)
 */

import { describe, expect, it } from 'bun:test';
import { summarizeToolInput } from '../../src/hooks/tool-summary.ts';

describe('summarizeToolInput — display form', () => {
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
});
