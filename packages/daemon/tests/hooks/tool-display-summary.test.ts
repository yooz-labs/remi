import { describe, expect, it } from 'bun:test';
import { escapeUnsafeText } from '@remi/shared';
import { summarizeToolInputForDisplay } from '../../src/hooks/tool-display-summary.ts';

describe('summarizeToolInputForDisplay', () => {
  it('escapes tool-controlled display fields through the real wrapper', () => {
    const hostile = 'start\x1b]52;c;QUJD\x07RTL\u202eoverride\u2066isolate\u200bzero\u200f';
    const expected = escapeUnsafeText(hostile);
    const fields = [
      ['Bash', { command: hostile }],
      ['Write', { file_path: hostile }],
      ['Glob', { pattern: hostile }],
      ['WebFetch', { url: hostile }],
      ['PowerShell', { command: hostile }],
    ] as const;

    for (const [tool, input] of fields) {
      const summary = summarizeToolInputForDisplay(tool, input);
      expect(summary).toBe(expected);
      expect(summary).not.toContain('\x1b');
      expect(summary).not.toContain('\x07');
      expect(summary).not.toContain('\u202e');
      expect(summary).not.toContain('\u2066');
      expect(summary).not.toContain('\u200b');
      expect(summary).not.toContain('\u200f');
    }
  });

  it('escapes before Bash truncation and keeps complete escaped input available', () => {
    const nearHead = `${'a'.repeat(79)}\u202e${'b'.repeat(80)}`;
    const escapedHead = escapeUnsafeText(nearHead);
    const headSummary = summarizeToolInputForDisplay('Bash', { command: nearHead });
    expect(headSummary).toBe(
      `${'a'.repeat(79)} … [${escapedHead.length - 79 - 30} chars hidden] … ${escapedHead.slice(-30)}`,
    );
    expect(headSummary).not.toContain('\\u20');

    const nearTail = `${'a'.repeat(120)}\u202e`;
    const escapedTail = escapeUnsafeText(nearTail);
    const tailSummary = summarizeToolInputForDisplay('Bash', { command: nearTail });
    expect(tailSummary).toBe(
      `${escapedTail.slice(0, 80)} … [${escapedTail.length - 110} chars hidden] … ${escapedTail.slice(-30)}`,
    );
    expect(tailSummary).toContain('\\u202E');
    expect(tailSummary).not.toContain('\\u20b');

    const generic = `${'g'.repeat(90)}\u202e${'t'.repeat(90)}`;
    const escapedGeneric = escapeUnsafeText(generic);
    expect(summarizeToolInputForDisplay('PowerShell', { command: generic })).toBe(
      `${escapedGeneric.slice(0, 80)} … [${escapedGeneric.length - 110} chars hidden] … ${escapedGeneric.slice(-30)}`,
    );

    expect(summarizeToolInputForDisplay('Bash', { command: nearHead }, { complete: true })).toBe(
      escapedHead,
    );
  });

  it('escapes long paths, patterns, and URLs without cutting their visible value', () => {
    const filePath = `/Users/x/${'d/'.repeat(80)}file.ts\u202e`;
    const pattern = `**/${'x'.repeat(150)}/*.ts\u2066`;
    const url = `https://example.com/${'x'.repeat(150)}\u200f`;

    expect(summarizeToolInputForDisplay('Read', { file_path: filePath })).toBe(
      escapeUnsafeText(filePath),
    );
    expect(summarizeToolInputForDisplay('Glob', { pattern })).toBe(escapeUnsafeText(pattern));
    expect(summarizeToolInputForDisplay('WebFetch', { url })).toBe(escapeUnsafeText(url));
  });
});
