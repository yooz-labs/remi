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
import * as ts from 'typescript';

const DIR = join(import.meta.dir, '..', '..', 'src', 'relay');
const FILES = readdirSync(DIR).filter((f) => f.endsWith('.ts'));

/** Parse expressions: new Date(value) is pure conversion; Date() reads the clock. */
function clockUses(source: string): string[] {
  const file = ts.createSourceFile('relay.ts', source, ts.ScriptTarget.Latest, true);
  const hits: string[] = [];
  const root = (node: ts.Expression): string | undefined => {
    if (ts.isParenthesizedExpression(node)) return root(node.expression);
    if (ts.isIdentifier(node)) return node.text;
    // Keep the original conservative ban on statically named qualified clocks.
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))
      return node.argumentExpression.text;
    return undefined;
  };
  const visit = (node: ts.Node): void => {
    const member = ts.isPropertyAccessExpression(node)
      ? [root(node.expression), node.name.text]
      : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)
        ? [root(node.expression), node.argumentExpression.text]
        : undefined;
    if (
      (ts.isIdentifier(node) && ['setTimeout', 'setInterval'].includes(node.text)) ||
      (ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        ['setTimeout', 'setInterval'].includes(node.argumentExpression.text)) ||
      (member && ['Date.now', 'performance.now', 'Math.random'].includes(member.join('.'))) ||
      (ts.isNewExpression(node) &&
        root(node.expression) === 'Date' &&
        ((node.arguments?.length ?? 0) === 0 || node.arguments?.some(ts.isSpreadElement))) ||
      (ts.isCallExpression(node) &&
        ['Date', 'setTimeout', 'setInterval'].includes(root(node.expression) ?? ''))
    )
      hits.push(node.getText(file));
    ts.forEachChild(node, visit);
  };
  visit(file);
  return hits;
}

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
    const offenders: string[] = [];
    const randomUses: string[] = [];
    for (const f of FILES) {
      for (const use of clockUses(readFileSync(join(DIR, f), 'utf8')))
        offenders.push(`${f}: ${use}`);
      for (const line of codeLines(f)) {
        if (line.includes('getRandomValues')) randomUses.push(`${f}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
    expect(randomUses).toEqual([
      'primitives.ts: export const systemRandom: Rng = (n) => crypto.getRandomValues(new Uint8Array(n));',
    ]);
  });

  test('clock guard distinguishes explicit date conversion and rejects real clock reads', () => {
    expect(clockUses('new Date(issuedAt * 1000).toISOString()')).toEqual([]);
    expect(clockUses('// Date.now(); new Date();\nconst note = "Date.now()";')).toEqual([]);
    for (const source of [
      'Date.now()',
      'Date["now"]()',
      'globalThis.Date.now()',
      '(globalThis).Date.now()',
      'self.Date.now()',
      'window.Math.random()',
      'globalThis["Date"]["now"]()',
      'new Date()',
      'new Date(\n)',
      'new globalThis.Date()',
      'new (globalThis).Date()',
      'new Date(...[])',
      'Date(issuedAt)',
      'performance.now()',
      'globalThis.performance.now()',
      'Math.random()',
      'globalThis.Math.random()',
      'setTimeout(callback, 1)',
      'setInterval(callback, 1)',
      'globalThis.setTimeout(callback, 1)',
      'globalThis["setInterval"](callback, 1)',
      'globalThis[`setTimeout`](callback, 1)',
      'globalThis[`setInterval`](callback, 1)',
      'new Date(Date.now())',
    ])
      expect(clockUses(source).length, source).toBeGreaterThan(0);
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
  test('the scalar-import key path is test-only: no production module reaches it', () => {
    const risky =
      /ecPairFromScalar|signerFromSeed|P256_PKCS8|ED25519_PKCS8|validScalar|deterministic\.ts/;
    for (const f of FILES) {
      if (f === 'deterministic.ts' || f === 'internal.ts') continue;
      const hits = codeLines(f).filter((l) => risky.test(l));
      expect([f, hits]).toEqual([f, []]);
    }
    // `ecGenerate(rng)` is the same path under another name and is also confined.
    for (const f of FILES) {
      if (f === 'deterministic.ts' || f === 'internal.ts') continue;
      expect([f, codeLines(f).some((l) => /\becGenerate\b/.test(l))]).toEqual([f, false]);
    }
    expect(codeLines('internal.ts').some((l) => l.includes('deterministic.ts'))).toBe(true);
  });
});
