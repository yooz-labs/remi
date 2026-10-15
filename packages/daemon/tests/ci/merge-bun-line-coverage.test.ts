import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  type SourceSnapshot,
  linePercent,
  lineSummary,
  parseLineCoverage,
  sourceIdentity,
  unionLineCoverage,
} from '../../../../scripts/ci/merge-bun-line-coverage';
const root = mkdtempSync(path.join(tmpdir(), 'remi-lcov-contract-'));
writeFileSync(path.join(root, 'actual.ts'), 'export const one = 1;\nexport const two = 2;\n');
writeFileSync(path.join(root, 'zero.ts'), '// no executable lines\n');
const sources: SourceSnapshot = {
  'actual.ts': sourceIdentity(path.join(root, 'actual.ts')),
  'zero.ts': sourceIdentity(path.join(root, 'zero.ts')),
};
const report = (name: string, da: string, lf: number, lh: number) =>
  `TN:\nSF:${name}\nFNF:1\nFNH:1\n${da}LF:${lf}\nLH:${lh}\nend_of_record\n`;
const a = report('actual.ts', 'DA:1,1\nDA:2,0\n', 2, 1);
const b = report('actual.ts', 'DA:1,0\nDA:2,2\n', 2, 1);
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('strict executable/covered line union preserves overlap and uses Bun per-file mean including zeroLF', () => {
  const merged = unionLineCoverage([
    parseLineCoverage(a, root, sources),
    parseLineCoverage(b, root, sources),
  ]);
  expect(merged['actual.ts']?.covered).toEqual([1, 2]);
  expect(linePercent(merged)).toBe('100.00');
  const twoFiles = parseLineCoverage(a + report('zero.ts', '', 0, 0), root, sources);
  expect(lineSummary(twoFiles)).toBe('All files | N/A | 75.00 |\n');
  // Weighted LH/LF is50%; Bun's actual per-file mean is75%, not their average.
  expect(linePercent(twoFiles)).not.toBe('50.00');
});

test('corrupt schema, totals, identities, mappings and duplicates cannot become coverage', () => {
  for (const value of [
    a.slice(0, -1),
    a.replace('LF:2', 'LF:3'),
    a.replace('LH:1', 'LH:0'),
    a.replace('DA:1,1', 'DA:1,1\nDA:1,0'),
    a.replace('DA:1,1', 'DA:99,1'),
    a.replace('DA:1,1', 'DA:1,-1'),
    a.replace('SF:actual.ts', 'SF:../actual.ts'),
    a.replace('SF:actual.ts', 'SF:unknown.ts'),
    a.replace('FNF:1', 'FN:1,missing'),
    a + a,
  ])
    expect(() => parseLineCoverage(value, root, sources)).toThrow();
  const stale = structuredClone(sources);
  if (stale['actual.ts']) stale['actual.ts'].sha256 = '0'.repeat(64);
  expect(() => parseLineCoverage(a, root, stale)).toThrow('Source changed');
});
