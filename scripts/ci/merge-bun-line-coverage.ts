import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

export type SourceIdentity = { sha256: string; mode: number; lines: number };
export type SourceSnapshot = Record<string, SourceIdentity>;
export type LineRecord = { identity: SourceIdentity; executable: number[]; covered: number[] };
export type LineCoverage = Record<string, LineRecord>;

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function sourceIdentity(file: string): SourceIdentity {
  const info = lstatSync(file);
  requireValue(info.isFile() && realpathSync(file) === file, 'Noncanonical source file');
  const bytes = readFileSync(file);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    mode: info.mode & 0o777,
    lines: text.split('\n').length,
  };
}

function integer(value: string | undefined): number {
  requireValue(value !== undefined && /^(0|[1-9][0-9]*)$/.test(value), 'Invalid LCOV integer');
  const result = Number(value);
  requireValue(Number.isSafeInteger(result), 'Unsafe LCOV integer');
  return result;
}

/** Only the pinned Bun line schema is supported; unknown mapping/schema fails closed. */
export function parseLineCoverage(
  text: string,
  root: string,
  sources: SourceSnapshot,
): LineCoverage {
  requireValue(text.endsWith('end_of_record\n'), 'Unterminated LCOV');
  const result: LineCoverage = {};
  for (const block of text.split('end_of_record\n').slice(0, -1)) {
    const tags = new Map<string, string>();
    const lines = new Map<number, number>();
    for (const row of block.split('\n').slice(0, -1)) {
      const colon = row.indexOf(':');
      requireValue(colon > 0, 'Malformed LCOV row');
      const key = row.slice(0, colon);
      const value = row.slice(colon + 1);
      requireValue(['TN', 'SF', 'FNF', 'FNH', 'DA', 'LF', 'LH'].includes(key), 'Unknown LCOV tag');
      if (key === 'DA') {
        const values = value.split(',');
        requireValue(values.length === 2, 'Malformed DA');
        const number = integer(values[0]);
        requireValue(number > 0 && !lines.has(number), 'Duplicate/invalid DA line');
        lines.set(number, integer(values[1]));
      } else {
        requireValue(!tags.has(key), 'Duplicate LCOV tag');
        tags.set(key, value);
      }
    }
    requireValue(
      tags.size === 6 && ['TN', 'SF', 'FNF', 'FNH', 'LF', 'LH'].every((key) => tags.has(key)),
      'Missing LCOV tag',
    );
    const name = tags.get('SF');
    requireValue(
      name &&
        !path.isAbsolute(name) &&
        !name.includes('\\') &&
        name.split('/').every((part) => part !== '' && part !== '.' && part !== '..') &&
        !Object.hasOwn(result, name),
      'Noncanonical/duplicate SF',
    );
    const expected = sources[name];
    requireValue(expected !== undefined, `Unbound source: ${name}`);
    const actual = sourceIdentity(path.join(root, name));
    requireValue(JSON.stringify(actual) === JSON.stringify(expected), `Source changed: ${name}`);
    const covered = [...lines].filter(([, hits]) => hits > 0).map(([number]) => number);
    requireValue(
      integer(tags.get('LF')) === lines.size &&
        integer(tags.get('LH')) === covered.length &&
        integer(tags.get('FNH')) <= integer(tags.get('FNF')) &&
        [...lines.keys()].every((number) => number <= actual.lines),
      'LCOV totals/source line bounds disagree',
    );
    result[name] = {
      identity: actual,
      executable: [...lines.keys()].sort((a, b) => a - b),
      covered: covered.sort((a, b) => a - b),
    };
  }
  requireValue(Object.keys(result).length > 0, 'Empty LCOV universe');
  return result;
}

export function unionLineCoverage(reports: LineCoverage[]): LineCoverage {
  requireValue(reports.length > 0, 'No coverage reports');
  const result: LineCoverage = {};
  for (const report of reports) {
    requireValue(Object.keys(report).length > 0, 'Empty coverage report');
    for (const [name, row] of Object.entries(report)) {
      const previous = result[name];
      requireValue(
        !previous || JSON.stringify(previous.identity) === JSON.stringify(row.identity),
        'Coverage source identity disagreement',
      );
      result[name] = {
        identity: row.identity,
        executable: [...new Set([...(previous?.executable ?? []), ...row.executable])].sort(
          (a, b) => a - b,
        ),
        covered: [...new Set([...(previous?.covered ?? []), ...row.covered])].sort((a, b) => a - b),
      };
    }
  }
  return Object.fromEntries(
    Object.entries(result).sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b))),
  );
}

/** Bun af24 averages per-file fractions, with zero executable lines counted as 100%. */
export function linePercent(report: LineCoverage): string {
  const rows = Object.values(unionLineCoverage([report]));
  return (
    (rows.reduce(
      (sum, row) =>
        sum + (row.executable.length === 0 ? 1 : row.covered.length / row.executable.length),
      0,
    ) /
      rows.length) *
    100
  ).toFixed(2);
}

export function lineSummary(report: LineCoverage): string {
  // Function/branch identities are absent from Bun LCOV: never manufacture their union.
  return `All files | N/A | ${linePercent(report)} |\n`;
}

export function serializeLineCoverage(report: LineCoverage): string {
  return Object.entries(report)
    .map(([name, row]) =>
      [
        'TN:line-only-union',
        `SF:${name}`,
        ...row.executable.map((number) => `DA:${number},${row.covered.includes(number) ? 1 : 0}`),
        `LF:${row.executable.length}`,
        `LH:${row.covered.length}`,
        'end_of_record',
        '',
      ].join('\n'),
    )
    .join('');
}
