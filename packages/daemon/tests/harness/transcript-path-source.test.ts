/**
 * Source-level guard for the Claude transcript path (#1163).
 *
 * `ClaudeHarness.transcriptPath` is the one place the session transcript path
 * `<dir>/<id>.jsonl` is composed. The handlers still receive a
 * `TranscriptDiscovery` for other reasons, so reverting one site to
 * `${transcriptDiscovery.getProjectTranscriptDir(...)}/${id}.jsonl` compiles
 * and passes every Claude-valued test. This test fails that revert by
 * asserting where `getProjectTranscriptDir(` may appear in
 * `packages/daemon/src`:
 *
 * - `transcript/transcript-discovery.ts`: defines it.
 * - `harness/claude.ts`: composes the path from it.
 * - `transcript/transcript-binder.ts`: asks for the directory itself (the
 *   rotation poll), not a session's transcript path.
 *
 * Any other caller is a new place building a transcript path, or a new
 * directory reader that belongs on this list on purpose.
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC = path.join(import.meta.dir, '..', '..', 'src');

const ALLOWED = [
  'harness/claude.ts',
  'transcript/transcript-binder.ts',
  'transcript/transcript-discovery.ts',
];

/** Strip comments, so a commented-out call cannot trip the check. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
}

/** Every `.ts` file under `dir`, as a path relative to `SRC` mapped to its source. */
function readSources(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) {
        files[path.relative(SRC, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf8');
      }
    }
  };
  walk(dir);
  return files;
}

/** 'ok', or why `sources` has a caller outside the allowlist or lost the harness's own. */
function transcriptDirVerdict(sources: Record<string, string>): string {
  const callers = Object.entries(sources)
    .filter(([, src]) => /getProjectTranscriptDir\s*\(/.test(stripComments(src)))
    .map(([file]) => file)
    .sort();
  const unexpected = callers.filter((file) => !ALLOWED.includes(file));
  if (unexpected.length > 0) return `unexpected caller: ${unexpected.join(', ')}`;
  if (!callers.includes('harness/claude.ts'))
    return 'harness/claude.ts no longer composes the path';
  return 'ok';
}

describe('getProjectTranscriptDir callers in packages/daemon/src (#1163)', () => {
  test('only the discovery, the binder and ClaudeHarness call it', () => {
    const sources = readSources(SRC);
    expect(Object.keys(sources).length).toBeGreaterThan(50);
    expect(transcriptDirVerdict(sources)).toBe('ok');
  });

  // The checks on the check run against a small synthetic tree, not the real
  // one, so a violation in the real source fails only the test above.
  const CLEAN: Record<string, string> = {
    'harness/claude.ts': 'return `${d.getProjectTranscriptDir(p)}/${id}.jsonl`;',
    'transcript/transcript-binder.ts': 'this.dir = d.getProjectTranscriptDir(p);',
    'transcript/transcript-discovery.ts':
      'getProjectTranscriptDir(p: string): string { return p; }',
    'cli/handlers/session-events.ts': 'const p = harness.transcriptPath(a, b);',
  };

  test('the synthetic tree is clean', () => {
    expect(transcriptDirVerdict(CLEAN)).toBe('ok');
  });

  test.each([
    [
      'a handler building the path itself again',
      {
        ...CLEAN,
        'cli/handlers/session-events.ts':
          'const p = `${transcriptDiscovery.getProjectTranscriptDir(x)}/${id}.jsonl`;',
      },
      'unexpected caller: cli/handlers/session-events.ts',
    ],
    [
      'a call added to a new file',
      { ...CLEAN, 'cli/new-reader.ts': 'discovery.getProjectTranscriptDir(p);' },
      'unexpected caller: cli/new-reader.ts',
    ],
    [
      'the harness no longer calling it',
      { ...CLEAN, 'harness/claude.ts': 'export class ClaudeHarness {}' },
      'harness/claude.ts no longer composes the path',
    ],
  ])('the check fails with %s', (_name, mutated, verdict) => {
    expect(transcriptDirVerdict(mutated)).toBe(verdict);
  });

  test('a commented-out call does not count as a caller', () => {
    const withComment = {
      ...CLEAN,
      'cli/new-reader.ts':
        '// discovery.getProjectTranscriptDir(p);\n/* getProjectTranscriptDir(p) */',
    };
    expect(transcriptDirVerdict(withComment)).toBe('ok');
  });
});
