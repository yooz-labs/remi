/**
 * A harness that names no transcript file (#1176 item 4): `Harness.transcriptPath`
 * may return `null`, and the three places that ask it read that as "no file".
 *
 * Each stand-in harness here is the consumer's own dependency type
 * (`Pick<Harness, 'transcriptPath'>` and the like), so it compiles only
 * because the member's return type admits `null`. The Claude cases stay in
 * `transcript-path-golden.test.ts`, `session-events-harness.test.ts` and
 * `transcript-events-harness.test.ts`, which this change leaves unmodified.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProtocolMessage, UUID } from '@remi/shared';
import { generateId } from '@remi/shared';
import type { MessageAPI } from '../../src/api/message-api.ts';
import { SubagentViewRegistry } from '../../src/api/subagent-view-registry.ts';
import { makeCurrentSessionResolver } from '../../src/cli/current-session.ts';
import {
  type SessionHandlerDeps,
  createSessionHandlers,
} from '../../src/cli/handlers/session-events.ts';
import {
  type TranscriptHandlerDeps,
  createTranscriptHandlers,
} from '../../src/cli/handlers/transcript-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../src/cli/logger.ts';
import type { PTYSession } from '../../src/pty/pty-session.ts';
import { SessionBindingStore } from '../../src/session/session-binding-store.ts';
import { SessionRegistryFile } from '../../src/session/session-registry-file.ts';
import { SessionRegistry } from '../../src/session/session-registry.ts';
import { SessionStore } from '../../src/session/session-store.ts';
import { TranscriptIndex } from '../../src/session/transcript-index.ts';
import { TranscriptDiscovery } from '../../src/transcript/transcript-discovery.ts';
import type { TranscriptWatcher } from '../../src/transcript/transcript-watcher.ts';

const CID = 'conn0000-0000-0000-0000-000000000000' as UUID;
const REQ = 'req00000-0000-0000-0000-000000000000' as UUID;
const REMI_ID = '99999999-9999-4999-8999-999999999999' as UUID;
const CLAUDE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT = '/test/dir';

/** A harness with no transcript file to name, in each consumer's own type. */
const noFile = { transcriptPath: () => null };

describe('Harness.transcriptPath returning null is "no file"', () => {
  let tmpDir: string;
  let sessionStore: SessionStore;
  let logged: string[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-null-transcript-'));
    sessionStore = new SessionStore(path.join(tmpDir, 'sessions.json'));
    logged = [];
    configureLogger({
      writeLog: (line) => logged.push(line),
      consoleLog: (...args) => logged.push(args.join(' ')),
    });
  });

  afterEach(() => {
    __resetLoggerForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function saveBound(): void {
    sessionStore.save({
      remiSessionId: REMI_ID,
      claudeSessionId: CLAUDE_ID,
      projectPath: PROJECT,
      port: 8765,
      pid: process.pid,
      startedAt: new Date(0).toISOString(),
      exitedAt: null,
      exitCode: null,
    });
  }

  test('the current-session resolver reports the id and a null transcript path', () => {
    saveBound();
    const current = makeCurrentSessionResolver({
      getPrimarySessionId: () => REMI_ID,
      sessionStore,
      harness: noFile,
      harnessId: 'claude',
    })();

    expect(current?.claudeSessionId).toBe(CLAUDE_ID as UUID);
    expect(current?.transcriptPath).toBeNull();
  });

  test('a listed session is decorated with its id and no transcriptPath key at all', async () => {
    saveBound();
    const sessionRegistry = new SessionRegistry({ orphanTimeoutMs: 1000 });
    try {
      sessionRegistry.registerSession(
        REMI_ID,
        PROJECT,
        {
          id: generateId(),
          write: () => {},
          submitInput: async () => {},
          close: async () => {},
        } as unknown as PTYSession,
        { getFullBulletContent: () => null } as unknown as MessageAPI,
      );
      const sent: ProtocolMessage[] = [];
      const harness: SessionHandlerDeps['harness'] = { gracefulExitInput: null, ...noFile };
      createSessionHandlers({
        sessionRegistry,
        bindingStore: new SessionBindingStore(sessionStore),
        transcriptDiscovery: new TranscriptDiscovery({ projectsDir: path.join(tmpDir, 'p') }),
        harness,
        liveSessionsRegistry: new SessionRegistryFile(path.join(tmpDir, 'live-sessions')),
        currentPort: () => 8765,
        untrackConnection: () => {},
        onConnectionRemoved: () => {},
        send: (_connectionId, message) => {
          sent.push(message);
          return true;
        },
      }).onSessionListRequest(CID, REQ, false);

      const response = sent[0] as unknown as {
        type: string;
        sessions: Array<Record<string, unknown>>;
      };
      expect(response.type).toBe('session_list_response');
      const entry = response.sessions[0] as Record<string, unknown>;
      expect(entry['claudeSessionId']).toBe(CLAUDE_ID);
      expect('transcriptPath' in entry).toBe(false);
    } finally {
      await sessionRegistry.shutdown();
    }
  });

  test('a durable-index hit with no file to load is NOT_FOUND, and says why', async () => {
    const transcriptIndex = new TranscriptIndex(path.join(tmpDir, 'transcript-index.json'));
    transcriptIndex.record(REMI_ID, CLAUDE_ID, PROJECT);
    const projectsDir = path.join(tmpDir, 'claude-projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    const sent: ProtocolMessage[] = [];
    const harness: TranscriptHandlerDeps['harness'] = noFile;

    createTranscriptHandlers({
      transcriptDiscovery: new TranscriptDiscovery({ projectsDir }),
      harness,
      transcriptWatchers: new Map<UUID, TranscriptWatcher>(),
      bindingStore: new SessionBindingStore(sessionStore, transcriptIndex),
      transcriptIndex,
      currentOwnedSession: () => null,
      subagentViews: new SubagentViewRegistry(),
      send: (_connectionId, message) => {
        sent.push(message);
        return true;
      },
    }).onTranscriptLoadRequest(CID, REMI_ID, REQ);

    const deadline = Date.now() + 2000;
    while (!sent.some((m) => (m as { code?: string }).code === 'NOT_FOUND')) {
      if (Date.now() > deadline) throw new Error('no NOT_FOUND response');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(logged.some((l) => l.includes('the harness has no transcript file'))).toBe(true);
    // Not the "indexed but the file is gone" branch, which names a path.
    expect(logged.some((l) => l.includes('absent on disk'))).toBe(false);
  });
});
