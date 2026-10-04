/**
 * Source-level guards for the relay v2 library (ADR 0034).
 *
 * They pin properties of the code itself that no behavioral test can see:
 * nothing reads a clock or a random source except the one named export, nothing
 * logs, and the library depends on nothing outside its own directory, so it
 * stays independent of the v1 modules R3 deletes.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(import.meta.dir, '..', '..', 'src', 'relay');
const FILES = readdirSync(DIR).filter((f) => f.endsWith('.ts'));

/** Code lines only: comments are prose and may name what the code forbids. */
function codeLines(file: string): string[] {
  let inBlock = false;
  const out: string[] = [];
  for (const line of readFileSync(join(DIR, file), 'utf8').split('\n')) {
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

describe('relay v2 source guards', () => {
  test('the library has files to guard', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(10);
  });

  test('no file reads a clock, and only systemRandom reads the platform random source', () => {
    const clock = /Date\.now|new Date\(|performance\.now|Math\.random|setTimeout|setInterval/;
    const offenders: string[] = [];
    const randomUses: string[] = [];
    for (const f of FILES) {
      for (const line of codeLines(f)) {
        if (clock.test(line)) offenders.push(`${f}: ${line.trim()}`);
        if (line.includes('getRandomValues')) randomUses.push(`${f}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
    expect(randomUses).toEqual([
      'primitives.ts: export const systemRandom: Rng = (n) => crypto.getRandomValues(new Uint8Array(n));',
    ]);
  });

  test('no file logs or touches the process, the network or storage', () => {
    const forbidden = /console\.|process\.|\bfetch\(|WebSocket|localStorage|sessionStorage|node:/;
    for (const f of FILES) {
      const hits = codeLines(f).filter((l) => forbidden.test(l));
      expect([f, hits]).toEqual([f, []]);
    }
  });

  test('every import stays inside the relay directory, so v1 and the other packages cannot leak in', () => {
    const importPattern = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/;
    let seen = 0;
    for (const f of FILES) {
      for (const line of codeLines(f)) {
        const specifier = importPattern.exec(line)?.[1];
        if (specifier === undefined) continue;
        seen++;
        expect([f, specifier.startsWith('./') && !specifier.includes('..')]).toEqual([f, true]);
      }
    }
    expect(seen).toBeGreaterThan(20);
  });
});
