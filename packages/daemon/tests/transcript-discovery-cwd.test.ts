/**
 * The directory a transcript was recorded in (#1129, #1308 review). A session found only as a
 * transcript on disk has no stored record, and the project directory's name is a lossy encoding of
 * the path (every `/` became `-`), so a project with a dash in its name cannot be decoded. The
 * transcript's own `cwd` is the truth. Real files in a temp projects directory.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TranscriptDiscovery } from '../src/transcript/transcript-discovery.ts';

const SESSION = '3f9c2a1e-0000-4000-8000-000000000042';

describe('TranscriptDiscovery.readTranscriptCwd (#1129)', () => {
  let dir: string;
  let discovery: TranscriptDiscovery;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-transcript-cwd-'));
    discovery = new TranscriptDiscovery({ projectsDir: dir });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function transcript(lines: unknown[], project = '-Users-someone-yooz-engine'): string {
    const projectDir = path.join(dir, project);
    fs.mkdirSync(projectDir, { recursive: true });
    const file = path.join(projectDir, `${SESSION}.jsonl`);
    fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    return file;
  }

  test('reads the cwd of the first entry that has one', () => {
    const file = transcript([
      { type: 'summary', summary: 'no cwd on this one' },
      { type: 'user', sessionId: SESSION, cwd: '/Users/someone/yooz-engine', message: {} },
      { type: 'user', sessionId: SESSION, cwd: '/somewhere/else', message: {} },
    ]);

    expect(discovery.readTranscriptCwd(file)).toBe('/Users/someone/yooz-engine');
  });

  test('null when no entry names one, the file is gone, or the cwd is not text', () => {
    expect(discovery.readTranscriptCwd(transcript([{ type: 'summary' }]))).toBeNull();
    expect(discovery.readTranscriptCwd(path.join(dir, 'missing.jsonl'))).toBeNull();
    expect(discovery.readTranscriptCwd(transcript([{ type: 'user', cwd: 5 }]))).toBeNull();
    expect(discovery.readTranscriptCwd(transcript([{ type: 'user', cwd: '' }]))).toBeNull();
  });

  test('a line that is not JSON is skipped, not fatal', () => {
    const projectDir = path.join(dir, '-p');
    fs.mkdirSync(projectDir, { recursive: true });
    const file = path.join(projectDir, `${SESSION}.jsonl`);
    fs.writeFileSync(file, `not json\n${JSON.stringify({ type: 'user', cwd: '/ok' })}\n`);

    expect(discovery.readTranscriptCwd(file)).toBe('/ok');
  });

  test('reads only the head of a large file', () => {
    const big = 'x'.repeat(300_000);
    const file = transcript([
      { type: 'assistant', blob: big },
      { type: 'user', cwd: '/too/late' },
    ]);

    // The cwd sits past the bytes read, so it is not found: the read is bounded.
    expect(discovery.readTranscriptCwd(file)).toBeNull();
  });
});
