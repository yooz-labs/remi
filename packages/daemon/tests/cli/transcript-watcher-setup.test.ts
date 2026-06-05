import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProtocolMessage, UUID } from '@remi/shared';
import type { MessageAPI } from '../../src/api/message-api.ts';
import { __resetLoggerForTests, configureLogger } from '../../src/cli/logger.ts';
import { startTranscriptWatcher } from '../../src/cli/transcript-watcher-setup.ts';
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

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-tws-'));
    configureLogger({ writeLog: () => {} });
  });

  afterEach(() => {
    __resetLoggerForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
