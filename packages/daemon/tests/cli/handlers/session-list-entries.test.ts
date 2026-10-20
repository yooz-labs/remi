/**
 * `buildSessionList` (#1274): the one builder of a daemon's session list, for the requested list and
 * the live-sessions broadcast. A real registry, session store, binding store, transcript discovery
 * and Claude harness over a temporary directory; the PTY is a stand-in, as in the handler tests.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { UUID } from '@remi/shared';
import { generateId } from '@remi/shared';
import type { MessageAPI } from '../../../src/api/message-api.ts';
import { buildSessionList } from '../../../src/cli/handlers/session-list-entries.ts';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
import { ClaudeHarness } from '../../../src/harness/index.ts';
import type { PTYSession } from '../../../src/pty/pty-session.ts';
import { SessionBindingStore } from '../../../src/session/session-binding-store.ts';
import { SessionRegistry } from '../../../src/session/session-registry.ts';
import { SessionStore } from '../../../src/session/session-store.ts';
import { TranscriptDiscovery } from '../../../src/transcript/transcript-discovery.ts';

const CLAUDE_ID = '66666666-6666-4666-8666-666666666666';
const EXTERNAL_ID = '77777777-7777-4777-8777-777777777777';

describe('buildSessionList (#1274)', () => {
  let tmpDir: string;
  let projectsDir: string;
  let sessionRegistry: SessionRegistry;
  let sessionStore: SessionStore;
  let sessionId: UUID;
  let logged: string[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-session-list-'));
    projectsDir = path.join(tmpDir, 'claude-projects');
    sessionRegistry = new SessionRegistry({ orphanTimeoutMs: 1000 });
    sessionStore = new SessionStore(path.join(tmpDir, 'sessions.json'));
    sessionId = sessionRegistry.createSessionId();
    sessionRegistry.registerSession(
      sessionId,
      '/test/dir',
      {
        id: generateId(),
        write: () => {},
        submitInput: async () => {},
        close: async () => {},
      } as unknown as PTYSession,
      { getFullBulletContent: () => null } as unknown as MessageAPI,
    );
    logged = [];
    configureLogger({ writeLog: (line: string) => logged.push(line) });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    await sessionRegistry.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const record = (fields: Record<string, unknown>) => ({
    remiSessionId: sessionId,
    claudeSessionId: null,
    projectPath: '/test/dir',
    port: 8765,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    exitedAt: null,
    exitCode: null,
    ...fields,
  });

  /** A Claude transcript on disk that no session here manages. */
  function externalTranscript(): void {
    const dir = path.join(projectsDir, '-elsewhere');
    fs.mkdirSync(dir, { recursive: true });
    const entry = {
      type: 'user',
      uuid: crypto.randomUUID(),
      parentUuid: null,
      sessionId: EXTERNAL_ID,
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'hello' },
    };
    fs.writeFileSync(path.join(dir, `${EXTERNAL_ID}.jsonl`), `${JSON.stringify(entry)}\n`);
  }

  function build(includeExternal: boolean) {
    const discovery = new TranscriptDiscovery({ projectsDir });
    const claude = new ClaudeHarness(discovery);
    return {
      claude,
      list: buildSessionList(
        {
          sessionRegistry,
          bindingStore: new SessionBindingStore(sessionStore),
          transcriptDiscovery: discovery,
          harness: claude,
        },
        includeExternal,
      ),
    };
  }

  test('a Claude session carries its harness, its Claude id and its transcript path', () => {
    sessionStore.save(record({ claudeSessionId: CLAUDE_ID }) as never);
    const { claude, list } = build(false);
    expect(list.own).toHaveLength(1);
    expect(list.own[0]).toMatchObject({
      sessionId,
      harness: 'claude',
      harnessSessionId: CLAUDE_ID,
      claudeSessionId: CLAUDE_ID,
      transcriptPath: claude.transcriptPath('/test/dir', CLAUDE_ID) as string,
    });
    expect(list.external).toEqual([]);
  });

  test('a Codex session whose thread is not known yet names its harness and nothing more', () => {
    sessionStore.save(record({ harness: 'codex' }) as never);
    const own = build(false).list.own[0];
    expect(own?.harness).toBe('codex');
    expect(own).not.toHaveProperty('harnessSessionId');
    expect(own).not.toHaveProperty('claudeSessionId');
    expect(own).not.toHaveProperty('transcriptPath');
  });

  test('external transcripts are listed only when asked for, leaving out the managed session', () => {
    sessionStore.save(record({ claudeSessionId: CLAUDE_ID }) as never);
    externalTranscript();
    expect(build(false).list.external).toEqual([]);
    expect(build(true).list.external.map((s) => s.sessionId)).toEqual([EXTERNAL_ID]);
  });

  test('a session store that cannot answer serves the raw entry, logs why, and still lists external transcripts', () => {
    externalTranscript();
    // Two records of one session: every lookup by its id is ambiguous and throws.
    fs.writeFileSync(
      path.join(tmpDir, 'sessions.json'),
      JSON.stringify({ version: 1, sessions: [record({}), record({ port: 8766 })] }),
    );
    const { list } = build(true);
    expect(list.own).toHaveLength(1);
    expect(list.own[0]?.sessionId).toBe(sessionId);
    expect(list.own[0]).not.toHaveProperty('harness');
    expect(list.external.map((s) => s.sessionId)).toEqual([EXTERNAL_ID]);
    const text = logged.join('\n');
    expect(text).toContain('serving raw entry');
    expect(text).toContain('external exclusion may be incomplete');
  });
});
