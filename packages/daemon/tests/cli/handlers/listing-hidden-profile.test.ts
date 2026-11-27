import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateId } from '@remi/shared';
import { createRecentRepositoriesHandlers } from '../../../src/cli/handlers/recent-repositories-events.ts';
import { createTrivialHandlers } from '../../../src/cli/handlers/trivial-events.ts';
import { getRecentDirectories } from '../../../src/cli/recent-client.ts';
import { currentProfilesStrict } from '../../../src/profiles/current-profiles.ts';
import { readProfileSidecar } from '../../../src/profiles/session-owner.ts';
import { SessionProfilesFile } from '../../../src/session/session-profiles-file.ts';
import { SessionRegistry } from '../../../src/session/session-registry.ts';
import { SessionStore } from '../../../src/session/session-store.ts';
import { RecentRepositoryStore } from '../../../src/workspace/recent-store.ts';
import {
  MAX_RECENT_REPOSITORIES,
  recentRepositoriesReport,
} from '../../../src/workspace/recent.ts';

test('device directory lists hide session and remembered sources without rewriting history', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p2b-list-')));
  const marker = path.join(root, 'P2B-MARKER-HIDDEN');
  const shared = path.join(root, 'shared');
  const mapped = path.join(root, 'mapped');
  for (const dir of [marker, shared, mapped]) {
    fs.mkdirSync(dir);
    expect(spawnSync('/usr/bin/git', ['init', '-q', dir]).status).toBe(0);
  }
  const config = path.join(root, 'config.toml');
  const table = `[profiles.secret]\nlabel="Hidden label"\nremote_visible=false\nfolders=["${mapped}"]\n[profiles.secret.claude]\nexpects="subscription"\ndir="${marker}"\n`;
  fs.writeFileSync(config, table);
  const store = new SessionStore(path.join(root, 'sessions.json'));
  const history = new RecentRepositoryStore(path.join(root, 'history.json'));
  const registry = new SessionRegistry({ maxReplayHistory: 10 });
  const time = new Date().toISOString();
  const add = (projectPath: string, profile?: string, startedAt = time) =>
    store.save(
      {
        remiSessionId: generateId(),
        claudeSessionId: null,
        projectPath,
        port: 0,
        pid: null,
        startedAt,
        exitedAt: startedAt,
        exitCode: 0,
        ...(profile && { profile, profileSnapshot: { revision: 'old' } }),
      },
      profile ? { profile, revision: 'old' } : undefined,
    );
  for (const directory of [marker, shared]) {
    const { profile: _profile, profileSnapshot: _snapshot, ...stripped } = add(directory, 'secret');
    store.save(stripped);
  }
  for (const dir of [marker, shared, mapped]) await history.remember(dir, dir);
  const saved = fs.readFileSync(history.filePath, 'utf8');
  const profiles = () => currentProfilesStrict(config);
  const sidecar = () => readProfileSidecar(new SessionProfilesFile(root));
  let recent: unknown;
  let sessionHistory: unknown;
  const recentHandler = createRecentRepositoriesHandlers({
    sessionStore: store,
    repositoryStore: history,
    profiles,
    sidecar,
    send: (_id, message) => {
      recent = message;
      return true;
    },
  });
  const trivial = createTrivialHandlers({
    sessionStore: store,
    sessionRegistry: registry,
    profiles,
    sidecar,
    registerDeviceToken: () => {},
    unregisterDeviceToken: () => {},
    send: (_id, message) => {
      sessionHistory = message;
      return true;
    },
  });
  const read = async () => {
    await recentHandler.onRecentRepositoriesRequest(generateId(), generateId(), undefined);
    trivial.onSessionHistoryRequest(generateId(), generateId(), undefined);
  };
  try {
    await read();
    expect(JSON.stringify([recent, sessionHistory])).not.toContain(marker);
    expect(JSON.stringify([recent, sessionHistory])).not.toContain(shared);
    expect(JSON.stringify(recent)).not.toContain(mapped);
    expect(fs.readFileSync(history.filePath, 'utf8')).toBe(saved);
    const sidecarPath = path.join(root, 'session-profiles.json');
    const sidecarBytes = fs.readFileSync(sidecarPath);
    fs.writeFileSync(sidecarPath, '{');
    await read();
    expect(JSON.stringify([recent, sessionHistory])).not.toContain(marker);
    expect(JSON.stringify([recent, sessionHistory])).not.toContain(shared);
    fs.writeFileSync(sidecarPath, sidecarBytes);
    const visibleTime = new Date(Date.now() - 60_000).toISOString();
    add(shared, undefined, visibleTime);
    await read();
    expect(sessionHistory).toMatchObject({
      directories: [{ directory: shared, sessionCount: 1, lastUsed: visibleTime }],
    });
    expect(recent).toMatchObject({
      repositories: [{ repository: shared, lastUsedAt: visibleTime }],
    });
    expect(JSON.stringify(recent)).toContain(shared);
    fs.writeFileSync(config, table.replace('remote_visible=false', 'remote_visible=true'));
    await read();
    for (const dir of [marker, shared, mapped]) expect(JSON.stringify(recent)).toContain(dir);
    fs.writeFileSync(config, '[[invalid');
    await read();
    expect(recent).toMatchObject({ repositories: [] });
    expect(sessionHistory).toMatchObject({ directories: [] });
    fs.unlinkSync(config);
    await read();
    // No table, but the sidecar still names secret for the stripped records: an owner that is no
    // longer configured is hidden (L1, lead PR 1828 round 2), so the marker repository stays out.
    expect(JSON.stringify(recent)).not.toContain(marker);
    for (const dir of [shared, mapped]) expect(JSON.stringify(recent)).toContain(dir);
    // With no profile evidence left at all, both lists are today's.
    fs.unlinkSync(sidecarPath);
    await read();
    for (const dir of [marker, shared, mapped]) expect(JSON.stringify(recent)).toContain(dir);
    const originalRecent = await recentRepositoriesReport(store.list(), {
      limit: MAX_RECENT_REPOSITORIES,
      remembered: history.list(),
    });
    expect(recent).toMatchObject({ repositories: originalRecent.repositories });
    expect(sessionHistory).toMatchObject({ directories: getRecentDirectories(store, 20) });
  } finally {
    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
