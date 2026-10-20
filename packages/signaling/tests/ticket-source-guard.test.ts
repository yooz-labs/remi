/**
 * Source-level guards for the relay Worker (ADR 0034 sections 4, 14 and 19).
 *
 * They pin properties of the code itself that no behavioral test can see:
 * the admission ticket's hash is compared only through `admitTagMatches`, the
 * ticket is never logged, and the room never parses what it forwards.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '..', 'src');

/** Code lines only: comments are prose and may name what the code forbids. */
function codeLines(file: string): string[] {
  let inBlock = false;
  const out: string[] = [];
  for (const line of readFileSync(join(SRC, file), 'utf8').split('\n')) {
    const t = line.trim();
    if (inBlock) {
      if (t.includes('*/')) inBlock = false;
      continue;
    }
    if (t.startsWith('/*')) {
      inBlock = !t.includes('*/');
      continue;
    }
    if (t === '' || t.startsWith('//')) continue;
    out.push(line);
  }
  return out;
}

const RELAY_FILES = ['admission.ts', 'connection-room.ts', 'limiter.ts', 'limits.ts'];

describe('the admission ticket', () => {
  test('its hash is compared through admitTagMatches, which admission.ts calls', () => {
    const calls = codeLines('admission.ts').filter((l) => /\badmitTagMatches\(/.test(l));
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  test('no line that touches a ticket or a hash compares it with an ordinary operator', () => {
    const touchesTicket = /ticket|hash|registered|\.h\b|\bh:/i;
    const comparison =
      /===|!==|[^=!<>]==[^=]|!=[^=]|\.indexOf\(|\.includes\(|\.localeCompare\(|\.startsWith\(|\.endsWith\(|\.has\(|\.equals\(/;
    const offenders: string[] = [];
    for (const file of ['admission.ts', 'connection-room.ts']) {
      for (const line of codeLines(file)) {
        if (touchesTicket.test(line) && comparison.test(line))
          offenders.push(`${file}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('neither the ticket nor anything else is written to a log', () => {
    for (const file of RELAY_FILES) {
      const hits = codeLines(file).filter((l) => /console\.|logger|\.log\(/.test(l));
      expect([file, hits]).toEqual([file, []]);
    }
  });
});

describe('the room is a courier', () => {
  test('nothing it forwards is parsed, decoded or inspected beyond its size', () => {
    const parsing = /JSON\.parse|TextDecoder|decodeDataFrame|decodeHello|new Uint8Array\(data/;
    const hits = codeLines('connection-room.ts').filter((l) => parsing.test(l));
    expect(hits).toEqual([]);
  });

  test('it holds no key, secret or session material: it imports nothing but the relay library and its own modules', () => {
    const importPattern = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/;
    for (const file of RELAY_FILES) {
      for (const line of codeLines(file)) {
        const specifier = importPattern.exec(line)?.[1];
        if (specifier === undefined) continue;
        const allowed = specifier.startsWith('./') || specifier === '@remi/shared/relay/index.ts';
        expect([file, specifier, allowed]).toEqual([file, specifier, true]);
      }
    }
  });
});
