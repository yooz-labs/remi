import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readTranscriptOwnerPort } from '../../src/transcript/transcript-owner.ts';

describe('readTranscriptOwnerPort', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-owner-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeLines(name: string, lines: object[]): string {
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n'));
    return filePath;
  }

  test('returns the wsPort from a remi custom-title head marker', () => {
    const file = writeLines('a.jsonl', [
      { type: 'custom-title', customTitle: 'remi:18767', sessionId: 'x' },
      { type: 'user', message: { role: 'user', content: 'hi' } },
    ]);
    expect(readTranscriptOwnerPort(file)).toBe(18767);
  });

  test('returns null when the title is a user-supplied name (not remi:<port>)', () => {
    const file = writeLines('b.jsonl', [
      { type: 'custom-title', customTitle: 'my project', sessionId: 'x' },
      { type: 'user', message: { role: 'user', content: 'hi' } },
    ]);
    expect(readTranscriptOwnerPort(file)).toBeNull();
  });

  test('returns null when there is no custom-title head marker', () => {
    const file = writeLines('c.jsonl', [
      { type: 'user', message: { role: 'user', content: 'hi' } },
      { type: 'assistant', message: { role: 'assistant', content: [] } },
    ]);
    expect(readTranscriptOwnerPort(file)).toBeNull();
  });

  test('stops early once conversation entries begin (no marker)', () => {
    // A custom-title appearing AFTER real conversation must not be picked up;
    // the marker is only ever at the head.
    const file = writeLines('d.jsonl', [
      { type: 'user', message: { role: 'user', content: 'hi' } },
      { type: 'custom-title', customTitle: 'remi:19999', sessionId: 'x' },
    ]);
    expect(readTranscriptOwnerPort(file)).toBeNull();
  });

  test('returns null for a missing file', () => {
    expect(readTranscriptOwnerPort(path.join(tmpDir, 'nope.jsonl'))).toBeNull();
  });

  test('returns null for an empty file', () => {
    const file = path.join(tmpDir, 'empty.jsonl');
    fs.writeFileSync(file, '');
    expect(readTranscriptOwnerPort(file)).toBeNull();
  });

  test('tolerates a leading blank/garbage line before the marker', () => {
    const file = path.join(tmpDir, 'e.jsonl');
    fs.writeFileSync(
      file,
      `\nnot json\n${JSON.stringify({ type: 'custom-title', customTitle: 'remi:18770' })}\n`,
    );
    expect(readTranscriptOwnerPort(file)).toBe(18770);
  });

  test('rejects an out-of-range port', () => {
    const file = writeLines('f.jsonl', [{ type: 'custom-title', customTitle: 'remi:99999999' }]);
    expect(readTranscriptOwnerPort(file)).toBeNull();
  });
});
