/**
 * A resume spawns with the harness's resume arguments (#1163).
 *
 * `resume-session-events.test.ts` pins that a Claude resume spawns with
 * `['--resume', id]`, but a handler that still hardcodes `--resume` passes it
 * too. This test gives `createResumeSessionHandlers` a harness whose resume
 * arguments differ, so only a handler that asks the harness passes.
 *
 * The harness is the handler's own dependency type (`Pick<Harness,
 * 'resumeArgs'>`), so a stand-in carries only what the handler can ask.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProtocolMessage, UUID } from '@remi/shared';
import { generateId } from '@remi/shared';
import type { MessageAPI } from '../../../src/api/message-api.ts';
import {
  type ResumeSessionHandlerDeps,
  createResumeSessionHandlers,
} from '../../../src/cli/handlers/resume-session-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
import { ClaudeHarness } from '../../../src/harness/index.ts';
import type { PTYSession } from '../../../src/pty/pty-session.ts';
import { SessionBindingStore } from '../../../src/session/session-binding-store.ts';
import { SessionRegistry } from '../../../src/session/session-registry.ts';
import { SessionStore } from '../../../src/session/session-store.ts';
import { TranscriptDiscovery } from '../../../src/transcript/transcript-discovery.ts';

const CID = 'conn0000-0000-0000-0000-000000000000' as UUID;
const REQ = 'req00000-0000-0000-0000-000000000000' as UUID;
const REMI_ID = 'abababab-abab-abab-abab-abababababab' as UUID;
const HARNESS_SESSION_ID = '55555555-5555-4555-8555-555555555555';

describe('createResumeSessionHandlers launch arguments, driven by the harness (#1163)', () => {
  let tmpDir: string;
  let sessionRegistry: SessionRegistry;
  let sessionStore: SessionStore;
  let discovery: TranscriptDiscovery;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-resume-harness-'));
    sessionRegistry = new SessionRegistry({ orphanTimeoutMs: 1000 });
    sessionStore = new SessionStore(path.join(tmpDir, 'sessions.json'));
    discovery = new TranscriptDiscovery({ projectsDir: path.join(tmpDir, 'claude-projects') });
    configureLogger({ writeLog: () => {} });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    await sessionRegistry.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function resumeWith(harness: ResumeSessionHandlerDeps['harness']): Promise<string[][]> {
    const projectDir = path.join(tmpDir, 'real-project');
    fs.mkdirSync(projectDir, { recursive: true });
    sessionStore.save({
      remiSessionId: REMI_ID,
      claudeSessionId: HARNESS_SESSION_ID,
      projectPath: projectDir,
      port: 0,
      pid: null,
      startedAt: new Date().toISOString(),
      exitedAt: null,
      exitCode: null,
    });

    const spawned: string[][] = [];
    const sent: ProtocolMessage[] = [];
    await createResumeSessionHandlers({
      childSessions: null,
      harnessId: 'claude',
      harnesses: () => ['claude'],
      sessionRegistry,
      sessionStore,
      bindingStore: new SessionBindingStore(sessionStore),
      transcriptDiscovery: discovery,
      harness,
      createNewSession: async (sessionId, _dir, _sendMessage, extraArgs) => {
        spawned.push([...extraArgs]);
        const pty = {
          id: generateId(),
          write: () => {},
          submitInput: async () => {},
          close: async () => {},
        } as unknown as PTYSession;
        sessionRegistry.registerSession(sessionId, '/resumed/dir', pty, {
          getFullBulletContent: () => null,
        } as unknown as MessageAPI);
        return undefined;
      },
      send: (_connectionId, message) => {
        sent.push(message);
        return true;
      },
    }).onResumeSessionRequest(CID, REMI_ID, REQ);

    const response = sent.find((m) => m.type === 'resume_session_response') as
      | { success: boolean }
      | undefined;
    expect(response?.success).toBe(true);
    return spawned;
  }

  test("spawns with the harness's resume arguments, not a hardcoded --resume", async () => {
    const spawned = await resumeWith({ resumeArgs: (id) => ['--continue-from', id] });

    expect(spawned).toEqual([['--continue-from', HARNESS_SESSION_ID]]);
  });

  test("ClaudeHarness's resume arguments still spawn --resume <id> through the same handler", async () => {
    const spawned = await resumeWith(new ClaudeHarness(discovery));

    expect(spawned).toEqual([['--resume', HARNESS_SESSION_ID]]);
  });
});
