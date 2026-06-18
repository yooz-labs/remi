import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { UUID } from '@remi/shared';
import { TranscriptIndex } from '../../src/session/transcript-index.ts';

function makeTmpPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-tidx-'));
  return path.join(dir, 'transcript-index.json');
}

const remi = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}` as UUID;

describe('TranscriptIndex (#577)', () => {
  let filePath: string;
  let index: TranscriptIndex;

  beforeEach(() => {
    filePath = makeTmpPath();
    index = new TranscriptIndex(filePath);
  });

  afterEach(() => {
    try {
      fs.rmSync(path.dirname(filePath), { recursive: true });
    } catch {
      // ignore
    }
  });

  test('get returns null when nothing recorded', () => {
    expect(index.get(remi(1))).toBeNull();
  });

  test('record then get round-trips the binding', () => {
    index.record(remi(1), 'claude-abc', '/Users/me/project');
    const entry = index.get(remi(1));
    expect(entry?.claudeSessionId).toBe('claude-abc');
    expect(entry?.projectPath).toBe('/Users/me/project');
    expect(entry?.remiSessionId).toBe(remi(1));
  });

  test('record upserts by remiSessionId (rotation refresh)', () => {
    index.record(remi(1), 'claude-old', '/proj');
    index.record(remi(1), 'claude-new', '/proj');
    const all = index.get(remi(1));
    expect(all?.claudeSessionId).toBe('claude-new');
    // Still a single entry (upsert, not append).
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(raw.entries).toHaveLength(1);
  });

  test('persists across a fresh instance (durability beyond process)', () => {
    index.record(remi(7), 'claude-7', '/p7');
    const reopened = new TranscriptIndex(filePath);
    expect(reopened.get(remi(7))?.claudeSessionId).toBe('claude-7');
  });

  test('outlives many recordings (no 100-entry cap like sessions.json)', () => {
    for (let i = 0; i < 250; i++) {
      index.record(remi(i), `claude-${i}`, `/p/${i}`);
    }
    // The oldest entry is still resolvable; sessions.json would have trimmed it.
    expect(index.get(remi(0))?.claudeSessionId).toBe('claude-0');
    expect(index.get(remi(249))?.claudeSessionId).toBe('claude-249');
  });

  test('prunes entries older than the 90-day TTL on write', () => {
    // Seed an entry whose updatedAt is 100 days old by writing the file directly.
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        entries: [
          { remiSessionId: remi(1), claudeSessionId: 'old', projectPath: '/p', updatedAt: old },
        ],
      }),
    );
    // A new record triggers prune; the 100-day-old entry should be dropped.
    index.record(remi(2), 'fresh', '/p2');
    expect(index.get(remi(1))).toBeNull();
    expect(index.get(remi(2))?.claudeSessionId).toBe('fresh');
  });

  test('keeps entries within the TTL', () => {
    const recent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        entries: [
          {
            remiSessionId: remi(1),
            claudeSessionId: 'recent',
            projectPath: '/p',
            updatedAt: recent,
          },
        ],
      }),
    );
    index.record(remi(2), 'fresh', '/p2');
    expect(index.get(remi(1))?.claudeSessionId).toBe('recent');
  });

  test('handles corrupt JSON gracefully', () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'not json', 'utf-8');
    expect(index.get(remi(1))).toBeNull();
    // Can still record after corruption.
    index.record(remi(1), 'after', '/p');
    expect(index.get(remi(1))?.claudeSessionId).toBe('after');
  });

  test('ignores a wrong-version file', () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ version: 99, entries: [] }), 'utf-8');
    expect(index.get(remi(1))).toBeNull();
  });

  test('over cap: NaN-timestamp entries are trimmed BEFORE valid ones (#577 FIX 2)', () => {
    // Regression for the prune sort defect: a string compare sorted an
    // unparseable updatedAt to the FRONT, so the cap trimmed the newest VALID
    // entries first and a NaN-heavy file looped forever. Numeric NaN->0 (oldest)
    // makes the cap drop the bad entries first.
    const capped = new TranscriptIndex(filePath, 2); // maxEntries = 2
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const valid1 = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        entries: [
          { remiSessionId: remi(1), claudeSessionId: 'bad-a', projectPath: '/p', updatedAt: 'NaN' },
          {
            remiSessionId: remi(2),
            claudeSessionId: 'bad-b',
            projectPath: '/p',
            updatedAt: 'garbage',
          },
          {
            remiSessionId: remi(3),
            claudeSessionId: 'valid-1',
            projectPath: '/p',
            updatedAt: valid1,
          },
        ],
      }),
    );
    // record() (with cap=2) triggers prune. After the new entry there are 4;
    // trimming to 2 must drop the two NaN entries first, keeping the valid ones.
    capped.record(remi(4), 'valid-2', '/p');

    expect(capped.get(remi(1))).toBeNull(); // NaN -> trimmed
    expect(capped.get(remi(2))).toBeNull(); // NaN -> trimmed
    expect(capped.get(remi(3))?.claudeSessionId).toBe('valid-1'); // valid -> kept
    expect(capped.get(remi(4))?.claudeSessionId).toBe('valid-2'); // valid -> kept
  });
});
