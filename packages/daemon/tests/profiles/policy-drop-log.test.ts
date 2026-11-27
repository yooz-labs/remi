/**
 * Fail-closed drops log once, with the id prefix only (#1749, PR 1828 round 1 F4): the session
 * list, the live ports and the transcript load each drop a session whose record cannot be read.
 */
import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { UUID } from '@remi/shared';
import type { MessageAPI } from '../../src/api/message-api.ts';
import { buildSessionList, visibleLivePorts } from '../../src/cli/handlers/session-list-entries.ts';
import { __resetLoggerForTests, configureLogger } from '../../src/cli/logger.ts';
import { ClaudeHarness } from '../../src/harness/index.ts';
import { parseProfiles } from '../../src/profiles/profile-config.ts';
import { makeIsHiddenSessionOwner, readProfileSidecar } from '../../src/profiles/session-owner.ts';
import type { PTYSession } from '../../src/pty/pty-session.ts';
import { SessionBindingStore } from '../../src/session/session-binding-store.ts';
import { SessionProfilesFile } from '../../src/session/session-profiles-file.ts';
import { SessionRegistryFile } from '../../src/session/session-registry-file.ts';
import { SessionRegistry } from '../../src/session/session-registry.ts';
import { SessionStore } from '../../src/session/session-store.ts';
import { TranscriptDiscovery } from '../../src/transcript/transcript-discovery.ts';

afterEach(() => __resetLoggerForTests());

test('each fail-closed drop logs once, naming only the id prefix', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2b-drop-log-P2B-MARKER-PATH-'));
  const registry = new SessionRegistry({ orphanTimeoutMs: 1000 });
  const lines: string[] = [];
  configureLogger({ writeLog: (line) => lines.push(line) });
  try {
    const profiles = parseProfiles({
      work: { label: 'Work', remote_selectable: true, claude: { expects: 'subscription' } },
    });
    if ('error' in profiles) throw new Error(profiles.error);
    // A sessions file that cannot be parsed: every record lookup throws.
    const storePath = path.join(root, 'sessions.json');
    fs.writeFileSync(storePath, '{ not json');
    const store = new SessionStore(storePath);
    const own = registry.createSessionId();
    registry.registerSession(
      own,
      root,
      {
        id: crypto.randomUUID(),
        write: () => {},
        submitInput: async () => {},
        close: async () => {},
      } as unknown as PTYSession,
      { getFullBulletContent: () => null } as unknown as MessageAPI,
    );
    const sibling = crypto.randomUUID();
    const live = new SessionRegistryFile(path.join(root, 'live'));
    live.register({
      sessionId: sibling,
      pid: process.pid,
      wsPort: 19710,
      hookPort: 19711,
      projectPath: root,
      name: 'sibling',
      startedAt: new Date().toISOString(),
    });
    const discovery = new TranscriptDiscovery({ projectsDir: path.join(root, 'projects') });
    const sidecar = () => readProfileSidecar(new SessionProfilesFile(root));
    const listDeps = {
      profiles: () => profiles,
      sidecar,
      profileOfSession: (id: UUID) => store.findByRemiSessionId(id),
      withholdTranscriptPaths: false,
      sessionRegistry: registry,
      bindingStore: new SessionBindingStore(store),
      transcriptDiscovery: discovery,
      harness: new ClaudeHarness(discovery),
    };
    const portDeps = {
      listLive: () => live.listLive(),
      profileOfSession: (id: UUID) => store.findByRemiSessionId(id),
      profiles: () => profiles,
      sidecar,
    };
    const hidden = makeIsHiddenSessionOwner({ sessionStore: store, discovery }, () => ({
      profiles,
      sidecar: sidecar(),
    }));
    for (let i = 0; i < 2; i++) {
      expect(buildSessionList(listDeps, false).own).toEqual([]);
      expect(visibleLivePorts(portDeps)).toEqual([]);
      expect(hidden(sibling)).toBe(true);
    }
    const drops = lines.filter((line) => line.includes('[Profiles]'));
    expect(drops).toEqual([
      `[error] [Profiles] session list: left out ${own.slice(0, 8)}; its owner could not be read`,
      `[error] [Profiles] live ports: left out ${sibling.slice(0, 8)}; its owner could not be read`,
      `[error] [Profiles] transcript load: left out ${sibling.slice(0, 8)}; its owner could not be read`,
    ]);
    for (const line of drops) {
      expect(line).not.toContain('P2B-MARKER-PATH');
      expect(line).not.toContain(own.slice(8));
    }
  } finally {
    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
