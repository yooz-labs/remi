/**
 * Tests for TranscriptWatcher.
 *
 * Uses real filesystem operations (no mocks).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TranscriptWatcher } from '../src/transcript/index.ts';
import type { AssistantEntry, UserEntry } from '../src/transcript/index.ts';

const TEMP_DIR = path.join(os.tmpdir(), 'remi-test-transcript');

function createTempFile(name: string): string {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const filePath = path.join(TEMP_DIR, name);
  fs.writeFileSync(filePath, '');
  return filePath;
}

function appendLine(filePath: string, entry: object): void {
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`);
}

function makeUserEntry(content: string, uuid?: string): object {
  return {
    type: 'user',
    uuid: uuid ?? crypto.randomUUID(),
    parentUuid: null,
    sessionId: 'test-session',
    timestamp: new Date().toISOString(),
    message: { role: 'user', content },
  };
}

function makeAssistantEntry(text: string, uuid?: string, model?: string): object {
  return {
    type: 'assistant',
    uuid: uuid ?? crypto.randomUUID(),
    parentUuid: null,
    sessionId: 'test-session',
    timestamp: new Date().toISOString(),
    message: {
      model: model ?? 'claude-opus-4-5-20251101',
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  };
}

function makeSummaryEntry(summary: string): object {
  return {
    type: 'summary',
    summary,
    leafUuid: crypto.randomUUID(),
  };
}

beforeEach(() => {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
});

describe('TranscriptWatcher', () => {
  test('reads existing entries on start', async () => {
    const filePath = createTempFile('existing.jsonl');
    appendLine(filePath, makeUserEntry('hello'));
    appendLine(filePath, makeAssistantEntry('hi there'));
    appendLine(filePath, makeUserEntry('how are you'));

    const watcher = new TranscriptWatcher({ filePath, readExisting: true });
    await watcher.start();

    expect(watcher.entryCount).toBe(3);
    expect(watcher.getUserMessages()).toHaveLength(2);
    expect(watcher.getAssistantMessages()).toHaveLength(1);

    watcher.stop();
  });

  test('skips existing entries when readExisting is false', async () => {
    const filePath = createTempFile('skip-existing.jsonl');
    appendLine(filePath, makeUserEntry('old message'));

    const watcher = new TranscriptWatcher({ filePath, readExisting: false });
    await watcher.start();

    expect(watcher.entryCount).toBe(0);

    watcher.stop();
  });

  test('detects new entries appended to file', async () => {
    const filePath = createTempFile('live.jsonl');

    const receivedUsers: UserEntry[] = [];
    const receivedAssistants: AssistantEntry[] = [];

    const watcher = new TranscriptWatcher(
      { filePath, readExisting: true, pollIntervalMs: 50 },
      {
        onUserMessage: (entry) => receivedUsers.push(entry),
        onAssistantMessage: (entry) => receivedAssistants.push(entry),
      },
    );
    await watcher.start();

    // Append new entries
    appendLine(filePath, makeUserEntry('new message'));
    appendLine(filePath, makeAssistantEntry('response'));

    // Wait for poll to pick up
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(receivedUsers).toHaveLength(1);
    expect(receivedAssistants).toHaveLength(1);
    expect(receivedUsers[0]?.message.content).toBe('new message');

    watcher.stop();
  });

  test('deduplicates entries by UUID', async () => {
    const filePath = createTempFile('dedup.jsonl');
    const uuid = crypto.randomUUID();

    appendLine(filePath, makeUserEntry('first', uuid));
    appendLine(filePath, makeUserEntry('duplicate', uuid));

    const watcher = new TranscriptWatcher({ filePath, readExisting: true });
    await watcher.start();

    expect(watcher.entryCount).toBe(1);
    expect(watcher.getUserMessages()[0]?.message.content).toBe('first');

    watcher.stop();
  });

  test('handles summary entries', async () => {
    const filePath = createTempFile('summary.jsonl');
    appendLine(filePath, makeSummaryEntry('test summary'));
    appendLine(filePath, makeUserEntry('after summary'));

    const watcher = new TranscriptWatcher({ filePath, readExisting: true });
    await watcher.start();

    expect(watcher.entryCount).toBe(2);
    const entries = watcher.getEntries();
    expect(entries[0]?.type).toBe('summary');
    expect(entries[1]?.type).toBe('user');

    watcher.stop();
  });

  test('getEntry retrieves by UUID', async () => {
    const filePath = createTempFile('lookup.jsonl');
    const uuid = crypto.randomUUID();
    appendLine(filePath, makeUserEntry('findme', uuid));
    appendLine(filePath, makeAssistantEntry('other'));

    const watcher = new TranscriptWatcher({ filePath, readExisting: true });
    await watcher.start();

    const found = watcher.getEntry(uuid) as UserEntry;
    expect(found).toBeDefined();
    expect(found.message.content).toBe('findme');

    watcher.stop();
  });

  test('getAssistantText extracts text blocks only', async () => {
    const filePath = createTempFile('text-extract.jsonl');
    const entry = {
      type: 'assistant',
      uuid: crypto.randomUUID(),
      parentUuid: null,
      sessionId: 'test',
      timestamp: new Date().toISOString(),
      message: {
        model: 'claude-opus-4-5-20251101',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'internal thought' },
          { type: 'text', text: 'visible response' },
          { type: 'tool_use', id: 't1', name: 'Read', input: {} },
          { type: 'text', text: 'more text' },
        ],
      },
    };
    appendLine(filePath, entry);

    const watcher = new TranscriptWatcher({ filePath, readExisting: true });
    await watcher.start();

    const assistants = watcher.getAssistantMessages();
    // biome-ignore lint/style/noNonNullAssertion: test file with known data
    const text = watcher.getAssistantText(assistants[0]!);
    expect(text).toBe('visible response\nmore text');

    watcher.stop();
  });

  test('getModel returns model from assistant entry', async () => {
    const filePath = createTempFile('model.jsonl');
    appendLine(filePath, makeAssistantEntry('test', undefined, 'claude-sonnet-4-20250514'));

    const watcher = new TranscriptWatcher({ filePath, readExisting: true });
    await watcher.start();

    const assistants = watcher.getAssistantMessages();
    // biome-ignore lint/style/noNonNullAssertion: test file with known data
    expect(watcher.getModel(assistants[0]!)).toBe('claude-sonnet-4-20250514');

    watcher.stop();
  });

  test('handles malformed lines gracefully', async () => {
    const filePath = createTempFile('malformed.jsonl');
    fs.writeFileSync(
      filePath,
      `${JSON.stringify(makeUserEntry('good'))}\nnot valid json\n${JSON.stringify(makeAssistantEntry('also good'))}\n`,
    );

    const errors: Error[] = [];
    const watcher = new TranscriptWatcher(
      { filePath, readExisting: true },
      { onError: (e) => errors.push(e) },
    );
    await watcher.start();

    expect(watcher.entryCount).toBe(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('Failed to parse');

    watcher.stop();
  });

  test('stop cleans up watchers', async () => {
    const filePath = createTempFile('cleanup.jsonl');
    appendLine(filePath, makeUserEntry('test'));

    const watcher = new TranscriptWatcher({ filePath, readExisting: true, pollIntervalMs: 50 });
    await watcher.start();
    expect(watcher.isRunning).toBe(true);

    watcher.stop();
    expect(watcher.isRunning).toBe(false);

    // Appending after stop should not trigger events
    appendLine(filePath, makeUserEntry('after stop'));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(watcher.entryCount).toBe(1); // Only the initial entry
  });

  test('waits for non-existent file then reads entries when it appears', async () => {
    const filePath = path.join(TEMP_DIR, 'deferred.jsonl');
    // File does NOT exist yet

    const receivedUsers: UserEntry[] = [];
    const receivedAssistants: AssistantEntry[] = [];

    const watcher = new TranscriptWatcher(
      { filePath, readExisting: true, pollIntervalMs: 50 },
      {
        onUserMessage: (entry) => receivedUsers.push(entry),
        onAssistantMessage: (entry) => receivedAssistants.push(entry),
      },
    );
    await watcher.start();
    expect(watcher.isRunning).toBe(true);

    // File appears after a short delay with initial content
    await new Promise((resolve) => setTimeout(resolve, 20));
    fs.writeFileSync(filePath, `${JSON.stringify(makeUserEntry('hello'))}\n`);

    // Wait for poll to detect the file and read it
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(receivedUsers).toHaveLength(1);
    expect(receivedUsers[0]?.message.content).toBe('hello');

    // Append more content and verify it is also picked up
    appendLine(filePath, makeAssistantEntry('response'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(receivedAssistants).toHaveLength(1);

    watcher.stop();
  });

  test('waits for non-existent file then detects new entries after initial read', async () => {
    const filePath = path.join(TEMP_DIR, 'deferred-live.jsonl');
    // File does NOT exist yet

    const receivedAssistants: AssistantEntry[] = [];

    const watcher = new TranscriptWatcher(
      { filePath, readExisting: true, pollIntervalMs: 50 },
      {
        onAssistantMessage: (entry) => receivedAssistants.push(entry),
      },
    );
    await watcher.start();

    // Create the file with one entry
    fs.writeFileSync(filePath, `${JSON.stringify(makeAssistantEntry('initial'))}\n`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(receivedAssistants).toHaveLength(1);

    // Append a second entry after the file is being watched
    appendLine(filePath, makeAssistantEntry('follow-up'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(receivedAssistants).toHaveLength(2);
    expect(receivedAssistants[1]?.message.content[0]).toEqual({
      type: 'text',
      text: 'follow-up',
    });

    watcher.stop();
  });

  test('stop during waitForFile prevents watching from starting', async () => {
    const filePath = path.join(TEMP_DIR, 'stop-wait.jsonl');
    // File does NOT exist yet

    const receivedUsers: UserEntry[] = [];

    const watcher = new TranscriptWatcher(
      { filePath, readExisting: true, pollIntervalMs: 50 },
      {
        onUserMessage: (entry) => receivedUsers.push(entry),
      },
    );
    await watcher.start();
    expect(watcher.isRunning).toBe(true);

    // Stop before the file appears
    watcher.stop();
    expect(watcher.isRunning).toBe(false);

    // Now create the file; watcher should not read it
    fs.writeFileSync(filePath, `${JSON.stringify(makeUserEntry('should not see'))}\n`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(receivedUsers).toHaveLength(0);
  });
});
