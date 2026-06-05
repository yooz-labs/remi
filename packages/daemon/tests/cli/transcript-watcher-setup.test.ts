import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProtocolMessage, UUID } from '@remi/shared';
import type { MessageAPI } from '../../src/api/message-api.ts';
import { __resetLoggerForTests, configureLogger } from '../../src/cli/logger.ts';
import {
  extractClaudeSessionId,
  startTranscriptWatcher,
} from '../../src/cli/transcript-watcher-setup.ts';
import { SessionBindingStore } from '../../src/session/session-binding-store.ts';
import { SessionStore } from '../../src/session/session-store.ts';
import type { TranscriptWatcher } from '../../src/transcript/transcript-watcher.ts';

const SID = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789' as UUID;

function fakeMessageAPI(): MessageAPI {
  return {
    handleMessage: () => {},
    handleStatusChange: () => {},
    handleQuestion: () => {},
  } as unknown as MessageAPI;
}

describe('transcript-watcher-setup', () => {
  let tmpDir: string;
  let sessionStore: SessionStore;
  let bindingStore: SessionBindingStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-tws-'));
    sessionStore = new SessionStore(path.join(tmpDir, 'sessions.json'));
    bindingStore = new SessionBindingStore(sessionStore);
    configureLogger({ writeLog: () => {} });
    // Seed a session so updateClaudeSessionId has a row to update
    sessionStore.save({
      remiSessionId: SID,
      claudeSessionId: null,
      projectPath: tmpDir,
      port: 0,
      pid: null,
      startedAt: new Date().toISOString(),
      exitedAt: null,
      exitCode: null,
    });
  });

  afterEach(() => {
    __resetLoggerForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('extractClaudeSessionId', () => {
    test('reads UUID from a plain filename and persists it', () => {
      const claudeId = '11111111-2222-3333-4444-555555555555';
      const filePath = path.join(tmpDir, `${claudeId}.jsonl`);

      const result = extractClaudeSessionId({ bindingStore }, filePath, SID);

      expect(result).toBe(claudeId);
      expect(sessionStore.findByRemiSessionId(SID)?.claudeSessionId).toBe(claudeId);
    });

    test('accepts prefixed _UUID filenames (picks the last segment)', () => {
      const claudeId = '66666666-7777-8888-9999-000000000000';
      const filePath = path.join(tmpDir, `prefix_${claudeId}.jsonl`);

      const result = extractClaudeSessionId({ bindingStore }, filePath, SID);

      expect(result).toBe(claudeId);
    });

    test('returns null and does not persist when the filename has no usable id', () => {
      const filePath = path.join(tmpDir, 'ab.jsonl'); // under 8 chars
      const result = extractClaudeSessionId({ bindingStore }, filePath, SID);
      expect(result).toBeNull();
      expect(sessionStore.findByRemiSessionId(SID)?.claudeSessionId).toBeNull();
    });
  });

  describe('startTranscriptWatcher', () => {
    test('registers a watcher in the shared map and reads an existing transcript', async () => {
      const claudeId = 'abcdef01-2345-6789-abcd-ef0123456789';
      const filePath = path.join(tmpDir, `${claudeId}.jsonl`);
      fs.writeFileSync(
        filePath,
        `${JSON.stringify({
          type: 'user',
          uuid: 'u1',
          sessionId: claudeId,
          cwd: tmpDir,
          timestamp: new Date().toISOString(),
          message: { role: 'user', content: 'hi' },
        })}\n`,
      );

      const transcriptWatchers = new Map<UUID, TranscriptWatcher>();
      const sendCalls: ProtocolMessage[] = [];
      const sendAndRecord = (m: ProtocolMessage) => sendCalls.push(m);

      startTranscriptWatcher(
        { transcriptWatchers },
        SID,
        filePath,
        fakeMessageAPI(),
        sendAndRecord,
      );

      expect(transcriptWatchers.has(SID)).toBe(true);
      // Give the watcher's start() a tick to read existing content.
      await new Promise((resolve) => setTimeout(resolve, 100));

      const watcher = transcriptWatchers.get(SID);
      expect(watcher).toBeDefined();
      watcher?.stop();
    });
  });
});
