/**
 * Single-mutator regression gate for the pending-question card map (#888
 * criterion i-b).
 *
 * The property this locks in is already true today and was hand-verified in
 * #888's rescope comment (2026-07-30, against `develop` @ 7bafa22):
 * `SessionRegistry`'s `currentQuestions` is typed `ReadonlyMap`
 * (`session-registry.ts:150`), and
 *
 *   grep -rn "currentQuestions\.set(\|currentQuestions\.delete(\|currentQuestions\.clear(" packages/daemon/src
 *
 * returns zero hits: `QuestionStore` (`session/question-store.ts`) is the
 * sole mutator of the map every other reader sees only as a read-only view.
 * This test makes that a CHECKED-IN assertion instead of a one-off grep, so
 * a future change that adds a second mutation site fails CI loudly instead
 * of regressing silently (see AGENTS.md "Verify before you describe" --
 * a true-today property is not the same as an enforced one).
 *
 * Scope: `ManagedSession.currentQuestions` and `QuestionStore.questions` are
 * the ONLY two handles external code has onto the card map (`QuestionStore`'s
 * backing `Map` field is `private`), so a mutation site anywhere outside
 * `question-store.ts` has to go through one of those two names. This test
 * scans every non-test `.ts` file under `packages/daemon/src` (except
 * `question-store.ts` itself, the legitimate owner) for a `.set(` / `.delete(`
 * / `.clear(` call chained directly off either handle.
 *
 * Deliberately NOT covered: criterion (ii) covers the DIFFERENT hazard of a
 * brand-new, wholly separate map that duplicates the card map's job under a
 * different name -- that cannot be caught by scanning for mutations of
 * `currentQuestions`/`questionStore.questions`, since a parallel map would
 * never touch either handle. See `question-containers-classification.test.ts`.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC_ROOT = join(import.meta.dir, '..', '..', 'src');
const OWNER_FILE = join('session', 'question-store.ts');

/** Recursively collect every non-test `.ts` file under `dir`, relative-path
 *  sorted for deterministic output. Robust to files/directories moving --
 *  nothing here is keyed by a line number or a fixed file list. */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...collectSourceFiles(full));
      continue;
    }
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    out.push(full);
  }
  return out;
}

/**
 * Strip line comments and multi-line block comments so a mention inside a
 * doc comment (e.g. `question-store.ts`'s own class doc, which literally
 * spells out `.set(` / `.delete(` / `.clear(` in prose) can never masquerade
 * as a real mutation call. Not a full TS parser -- good enough for detecting
 * `identifier.method(` call syntax, which never legitimately needs to span a
 * string literal containing a comment delimiter.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

/**
 * Matches a `.set(` / `.delete(` / `.clear(` call chained directly off
 * `currentQuestions` or `questionStore.questions` -- the two read-only-typed
 * handles onto the card map. Does NOT match the getter *definition*
 * (`get currentQuestions() { return questionStore.questions; }`, which has
 * no `.set`/`.delete`/`.clear` following it) or a plain read (`.get`/`.has`/
 * `.size`/`.values`/`.keys`).
 */
const MUTATION_PATTERN =
  /\b(?:currentQuestions|questionStore\s*\.\s*questions)\s*\.\s*(set|delete|clear)\s*\(/g;

describe('detector sanity: MUTATION_PATTERN catches the shapes it must catch', () => {
  test('flags a direct .set( on currentQuestions', () => {
    MUTATION_PATTERN.lastIndex = 0;
    expect(MUTATION_PATTERN.test('session.currentQuestions.set(id, q);')).toBe(true);
  });

  test('flags .delete( and .clear( on currentQuestions too', () => {
    for (const method of ['delete', 'clear']) {
      MUTATION_PATTERN.lastIndex = 0;
      expect(MUTATION_PATTERN.test(`session.currentQuestions.${method}(id);`)).toBe(true);
    }
  });

  test('flags a mutation via the questionStore.questions handle', () => {
    MUTATION_PATTERN.lastIndex = 0;
    expect(MUTATION_PATTERN.test('this.questionStore.questions.set(id, q);')).toBe(true);
  });

  test('does NOT flag a read (.get/.has/.size/.values/.keys) or the getter definition', () => {
    const src = `
      get currentQuestions(): ReadonlyMap<UUID, Question> {
        return questionStore.questions;
      }
      const q = session.currentQuestions.get(id);
      const has = session.currentQuestions.has(id);
      const n = session.currentQuestions.size;
      for (const v of session.currentQuestions.values()) { /* noop */ }
    `;
    MUTATION_PATTERN.lastIndex = 0;
    expect(MUTATION_PATTERN.test(src)).toBe(false);
  });

  test('does NOT flag the owner itself, which mutates its own private `map` field', () => {
    const src = `
      this.map.delete(question.id);
      this.map.set(question.id, question);
      this.map.clear();
    `;
    MUTATION_PATTERN.lastIndex = 0;
    expect(MUTATION_PATTERN.test(src)).toBe(false);
  });
});

describe('QuestionStore is the single mutator of the card map (#888 i-b)', () => {
  const files = collectSourceFiles(SRC_ROOT);
  const scannedFiles = files.filter((f) => relative(SRC_ROOT, f) !== OWNER_FILE);

  test('sanity: the scan is not vacuous (found the owner file and a real reader)', () => {
    const relPaths = files.map((f) => relative(SRC_ROOT, f));
    expect(relPaths).toContain(OWNER_FILE);
    expect(relPaths).toContain(join('session', 'session-registry.ts'));
    // Loose lower bound: the daemon source tree has 100+ files; a much
    // smaller count would mean the walk silently stopped early.
    expect(relPaths.length).toBeGreaterThan(80);
  });

  test('no file outside question-store.ts mutates currentQuestions / questionStore.questions', () => {
    const offenders: string[] = [];
    for (const file of scannedFiles) {
      const source = stripComments(readFileSync(file, 'utf8'));
      MUTATION_PATTERN.lastIndex = 0;
      if (MUTATION_PATTERN.test(source)) {
        offenders.push(relative(SRC_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the owner file itself DOES mutate its own backing map (sanity: not just an empty scan)', () => {
    const source = readFileSync(join(SRC_ROOT, OWNER_FILE), 'utf8');
    expect(source).toContain('this.map.set(');
    expect(source).toContain('this.map.delete(');
    expect(source).toContain('this.map.clear(');
  });
});
