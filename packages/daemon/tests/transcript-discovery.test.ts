/**
 * Tests for TranscriptDiscovery.
 *
 * Uses real filesystem operations against the actual
 * ~/.claude/projects/ directory (read-only).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TranscriptDiscovery } from '../src/transcript/index.ts';

const TEMP_DIR = path.join(os.tmpdir(), 'remi-test-discovery');

function makeProjectDir(projectPath: string): string {
  const encoded = projectPath.replace(/\//g, '-');
  const dir = path.join(TEMP_DIR, encoded);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeTranscript(dir: string, sessionId: string, entries: object[]): string {
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  const content = `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`;
  fs.writeFileSync(filePath, content);
  return filePath;
}

function makeUserEntry(content: string): object {
  return {
    type: 'user',
    uuid: crypto.randomUUID(),
    parentUuid: null,
    sessionId: 'test',
    timestamp: new Date().toISOString(),
    message: { role: 'user', content },
  };
}

function makeAssistantEntry(text: string, model = 'claude-opus-4-5-20251101'): object {
  return {
    type: 'assistant',
    uuid: crypto.randomUUID(),
    parentUuid: null,
    sessionId: 'test',
    timestamp: new Date().toISOString(),
    message: {
      model,
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  };
}

beforeEach(() => {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
});

describe('TranscriptDiscovery', () => {
  test('discovers sessions from transcript files', () => {
    const projectDir = makeProjectDir('/Users/test/project');
    writeTranscript(projectDir, 'session-1', [makeUserEntry('hello'), makeAssistantEntry('hi')]);

    const discovery = new TranscriptDiscovery({ projectsDir: TEMP_DIR });
    const sessions = discovery.discoverSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe('session-1');
    expect(sessions[0]?.source).toBe('transcript');
    expect(sessions[0]?.canAttach).toBe(false);
  });

  test('discovers multiple sessions across projects', () => {
    const dir1 = makeProjectDir('/Users/test/project-a');
    const dir2 = makeProjectDir('/Users/test/project-b');

    writeTranscript(dir1, 'session-a1', [makeUserEntry('a1')]);
    writeTranscript(dir1, 'session-a2', [makeUserEntry('a2')]);
    writeTranscript(dir2, 'session-b1', [makeUserEntry('b1')]);

    const discovery = new TranscriptDiscovery({ projectsDir: TEMP_DIR });
    const sessions = discovery.discoverSessions();

    expect(sessions).toHaveLength(3);
  });

  test('excludes specified session IDs', () => {
    const projectDir = makeProjectDir('/Users/test/project');
    writeTranscript(projectDir, 'keep-me', [makeUserEntry('keep')]);
    writeTranscript(projectDir, 'exclude-me', [makeUserEntry('exclude')]);

    const discovery = new TranscriptDiscovery({ projectsDir: TEMP_DIR });
    const sessions = discovery.discoverSessions(new Set(['exclude-me']));

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe('keep-me');
  });

  test('sorts by most recently modified first', async () => {
    const projectDir = makeProjectDir('/Users/test/project');

    writeTranscript(projectDir, 'old-session', [makeUserEntry('old')]);
    // Small delay to ensure different mtime
    await new Promise((resolve) => setTimeout(resolve, 50));
    writeTranscript(projectDir, 'new-session', [makeUserEntry('new')]);

    const discovery = new TranscriptDiscovery({ projectsDir: TEMP_DIR });
    const sessions = discovery.discoverSessions();

    expect(sessions[0]?.sessionId).toBe('new-session');
    expect(sessions[1]?.sessionId).toBe('old-session');
  });

  test('extracts model info from transcript', () => {
    const projectDir = makeProjectDir('/Users/test/project');
    writeTranscript(projectDir, 'with-model', [
      makeUserEntry('test'),
      makeAssistantEntry('response', 'claude-sonnet-4-20250514'),
    ]);

    const discovery = new TranscriptDiscovery({ projectsDir: TEMP_DIR });
    const sessions = discovery.discoverSessions();

    expect(sessions[0]?.model).toBe('claude-sonnet-4-20250514');
  });

  test('extracts last message preview', () => {
    const projectDir = makeProjectDir('/Users/test/project');
    writeTranscript(projectDir, 'preview', [
      makeUserEntry('first message'),
      makeAssistantEntry('the assistant responds'),
    ]);

    const discovery = new TranscriptDiscovery({ projectsDir: TEMP_DIR });
    const sessions = discovery.discoverSessions();

    expect(sessions[0]?.lastMessage).toBe('the assistant responds');
  });

  test('truncates long last message preview', () => {
    const projectDir = makeProjectDir('/Users/test/project');
    const longText = 'a'.repeat(200);
    writeTranscript(projectDir, 'long', [makeAssistantEntry(longText)]);

    const discovery = new TranscriptDiscovery({ projectsDir: TEMP_DIR });
    const sessions = discovery.discoverSessions();

    expect(sessions[0]?.lastMessage?.length).toBeLessThanOrEqual(100);
    expect(sessions[0]?.lastMessage?.endsWith('...')).toBe(true);
  });

  test('respects maxResults limit', () => {
    const projectDir = makeProjectDir('/Users/test/project');
    for (let i = 0; i < 10; i++) {
      writeTranscript(projectDir, `session-${i}`, [makeUserEntry(`msg ${i}`)]);
    }

    const discovery = new TranscriptDiscovery({ projectsDir: TEMP_DIR, maxResults: 3 });
    const sessions = discovery.discoverSessions();

    expect(sessions).toHaveLength(3);
  });

  test('determines status based on modification time', async () => {
    const projectDir = makeProjectDir('/Users/test/project');
    const filePath = writeTranscript(projectDir, 'recent', [makeUserEntry('just now')]);

    const discovery = new TranscriptDiscovery({ projectsDir: TEMP_DIR });
    const sessions = discovery.discoverSessions();

    // Just written, should be active
    expect(sessions[0]?.status).toBe('active');

    // Modify the file's mtime to be old
    const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago
    fs.utimesSync(filePath, oldTime, oldTime);

    const sessions2 = discovery.discoverSessions();
    expect(sessions2[0]?.status).toBe('completed');
  });

  test('findLatestTranscript returns most recent file', async () => {
    const projectDir = makeProjectDir('/Users/test/myproject');

    writeTranscript(projectDir, 'old-session', [makeUserEntry('old')]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    writeTranscript(projectDir, 'new-session', [makeUserEntry('new')]);

    const discovery = new TranscriptDiscovery({ projectsDir: TEMP_DIR });
    const latest = discovery.findLatestTranscript('/Users/test/myproject');

    expect(latest).toContain('new-session.jsonl');
  });

  test('findLatestTranscript returns null for unknown project', () => {
    const discovery = new TranscriptDiscovery({ projectsDir: TEMP_DIR });
    const latest = discovery.findLatestTranscript('/nonexistent/project');

    expect(latest).toBeNull();
  });

  test('handles empty projects directory', () => {
    const discovery = new TranscriptDiscovery({ projectsDir: TEMP_DIR });
    const sessions = discovery.discoverSessions();

    expect(sessions).toHaveLength(0);
  });

  test('handles non-existent projects directory', () => {
    const discovery = new TranscriptDiscovery({
      projectsDir: '/tmp/remi-nonexistent-dir-12345',
    });
    const sessions = discovery.discoverSessions();

    expect(sessions).toHaveLength(0);
  });

  test('findTranscriptBySessionId returns path for known session', () => {
    const projectDir = makeProjectDir('/Users/test/find-by-id');
    const filePath = writeTranscript(projectDir, 'known-session-abc', [makeUserEntry('hello')]);

    const discovery = new TranscriptDiscovery({ projectsDir: TEMP_DIR });
    const result = discovery.findTranscriptBySessionId('known-session-abc');

    expect(result).toBe(filePath);
  });

  test('findTranscriptBySessionId returns null for unknown session', () => {
    makeProjectDir('/Users/test/find-by-id-miss');

    const discovery = new TranscriptDiscovery({ projectsDir: TEMP_DIR });
    const result = discovery.findTranscriptBySessionId('nonexistent-session-xyz');

    expect(result).toBeNull();
  });

  test('findTranscriptBySessionId finds correct session among multiple', () => {
    const projectDir = makeProjectDir('/Users/test/find-by-id-multi');
    writeTranscript(projectDir, 'session-one', [makeUserEntry('one')]);
    const targetPath = writeTranscript(projectDir, 'session-two', [makeUserEntry('two')]);
    writeTranscript(projectDir, 'session-three', [makeUserEntry('three')]);

    const discovery = new TranscriptDiscovery({ projectsDir: TEMP_DIR });
    const result = discovery.findTranscriptBySessionId('session-two');

    expect(result).toBe(targetPath);
  });
});
