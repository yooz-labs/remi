/**
 * `createTranscriptHandlers` rebuilds a purged session's transcript path from
 * the harness (#1163).
 *
 * `transcript-events.test.ts` and `transcript-path-golden.test.ts` pin that a
 * Claude durable-index load finds `<projectsDir>/<encoded>/<id>.jsonl`, but a
 * handler that still builds that path itself passes them too. Here the
 * transcript exists ONLY at the path a stand-in harness derives, so only a
 * handler that asks the harness finds it.
 *
 * The harness is a real `Harness` whose `gracefulExitInput` and `resumeArgs`
 * delegate to `ClaudeHarness`; only `transcriptPath` differs.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProtocolMessage, UUID } from '@remi/shared';
import { SubagentViewRegistry } from '../../../src/api/subagent-view-registry.ts';
import { createTranscriptHandlers } from '../../../src/cli/handlers/transcript-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
import { ClaudeHarness, type Harness } from '../../../src/harness/index.ts';
import { SessionBindingStore } from '../../../src/session/session-binding-store.ts';
import { SessionStore } from '../../../src/session/session-store.ts';
import { TranscriptIndex } from '../../../src/session/transcript-index.ts';
import { TranscriptDiscovery } from '../../../src/transcript/transcript-discovery.ts';
import type { TranscriptWatcher } from '../../../src/transcript/transcript-watcher.ts';

const CID = 'conn0000-0000-0000-0000-000000000000' as UUID;
const REQ = 'req00000-0000-0000-0000-000000000000' as UUID;
const REMI_ID = '77777777-7777-4777-8777-777777777777' as UUID;
const CLAUDE_ID = '88888888-8888-4888-8888-888888888888';
const PROJECT = '/Users/x/my.proj';

describe('createTranscriptHandlers durable-index load, driven by the harness (#1163)', () => {
  let tmpDir: string;
  let standInDir: string;
  let transcriptIndex: TranscriptIndex;
  let bindingStore: SessionBindingStore;
  let discovery: TranscriptDiscovery;
  let sent: ProtocolMessage[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-transcript-harness-'));
    standInDir = path.join(tmpDir, 'stand-in');
    fs.mkdirSync(standInDir, { recursive: true });
    // An empty, real projects directory: nothing here can satisfy the load.
    const projectsDir = path.join(tmpDir, 'claude-projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    discovery = new TranscriptDiscovery({ projectsDir });
    const sessionStore = new SessionStore(path.join(tmpDir, 'sessions.json'));
    transcriptIndex = new TranscriptIndex(path.join(tmpDir, 'transcript-index.json'));
    bindingStore = new SessionBindingStore(sessionStore, transcriptIndex);
    sent = [];
    configureLogger({ writeLog: () => {} });
  });

  afterEach(() => {
    __resetLoggerForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** A real harness; only the transcript path differs from Claude's. */
  function standInHarness(): { harness: Harness; transcriptFile: string } {
    const claude = new ClaudeHarness(discovery);
    const transcriptFile = path.join(standInDir, `${CLAUDE_ID}.jsonl`);
    return {
      transcriptFile,
      harness: {
        gracefulExitInput: claude.gracefulExitInput,
        resumeArgs: (id) => claude.resumeArgs(id),
        transcriptPath: (_projectPath, id) => path.join(standInDir, `${id}.jsonl`),
        createSession: (ctx) => claude.createSession(ctx),
      },
    };
  }

  function loadFromIndex(harness: Harness): void {
    createTranscriptHandlers({
      transcriptDiscovery: discovery,
      harness,
      transcriptWatchers: new Map<UUID, TranscriptWatcher>(),
      bindingStore,
      transcriptIndex,
      currentOwnedSession: () => null,
      subagentViews: new SubagentViewRegistry(),
      send: (_connectionId, message) => {
        sent.push(message);
        return true;
      },
    }).onTranscriptLoadRequest(CID, REMI_ID, REQ);
  }

  async function settled(): Promise<void> {
    const deadline = Date.now() + 2000;
    while (
      !sent.some(
        (m) =>
          m.type === 'transcript_load_complete' || (m as { code?: string }).code === 'NOT_FOUND',
      )
    ) {
      if (Date.now() > deadline) {
        throw new Error(`no final message; got ${JSON.stringify(sent.map((m) => m.type))}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  test("a purged session's transcript is found at the path the harness derives", async () => {
    const { harness, transcriptFile } = standInHarness();
    fs.writeFileSync(
      transcriptFile,
      `${JSON.stringify({
        type: 'user',
        uuid: 'u1',
        sessionId: CLAUDE_ID,
        cwd: PROJECT,
        timestamp: new Date(0).toISOString(),
        message: { role: 'user', content: 'stand-in history' },
      })}\n`,
    );
    transcriptIndex.record(REMI_ID, CLAUDE_ID, PROJECT);
    expect(bindingStore.get(REMI_ID)).toBeNull();

    loadFromIndex(harness);
    await settled();

    expect(sent.some((m) => (m as { code?: string }).code === 'NOT_FOUND')).toBe(false);
    expect(sent.some((m) => m.type === 'transcript_load_complete')).toBe(true);
  });

  test('the same index entry is NOT_FOUND when the harness derives a path with no file', async () => {
    // Control: without the file at the harness's path the load must fail, so
    // the test above cannot pass by finding the transcript some other way.
    const { harness } = standInHarness();
    transcriptIndex.record(REMI_ID, CLAUDE_ID, PROJECT);

    loadFromIndex(harness);
    await settled();

    expect(sent.some((m) => (m as { code?: string }).code === 'NOT_FOUND')).toBe(true);
    expect(sent.some((m) => m.type === 'transcript_load_complete')).toBe(false);
  });
});
