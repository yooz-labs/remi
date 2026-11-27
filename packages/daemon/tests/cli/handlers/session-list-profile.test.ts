import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionProfileRef } from '@remi/shared';
import type { MessageAPI } from '../../../src/api/message-api.ts';
import {
  buildSessionList,
  visibleLivePorts,
} from '../../../src/cli/handlers/session-list-entries.ts';
import { ClaudeHarness } from '../../../src/harness/index.ts';
import { type Profiles, parseProfiles } from '../../../src/profiles/profile-config.ts';
import { readProfileSidecar } from '../../../src/profiles/session-owner.ts';
import { visibleProfileRoots } from '../../../src/profiles/visibility.ts';
import type { PTYSession } from '../../../src/pty/pty-session.ts';
import { SessionBindingStore } from '../../../src/session/session-binding-store.ts';
import { SessionProfilesFile } from '../../../src/session/session-profiles-file.ts';
import { SessionRegistryFile } from '../../../src/session/session-registry-file.ts';
import { SessionRegistry } from '../../../src/session/session-registry.ts';
import { SessionStore } from '../../../src/session/session-store.ts';
import { TranscriptDiscovery } from '../../../src/transcript/transcript-discovery.ts';

test('session lists use sidecar ownership for profile labels and hidden entries', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2b-list-owner-'));
  const registry = new SessionRegistry({ orphanTimeoutMs: 1000 });
  try {
    const profiles = parseProfiles({
      work: { label: 'Work', remote_selectable: true, claude: { expects: 'subscription' } },
      secret: { label: 'Hidden label', remote_visible: false, claude: { expects: 'subscription' } },
    });
    if ('error' in profiles) throw new Error(profiles.error);
    const store = new SessionStore(path.join(root, 'sessions.json'));
    const id = registry.createSessionId();
    registry.registerSession(
      id,
      root,
      {
        id: crypto.randomUUID(),
        write: () => {},
        submitInput: async () => {},
        close: async () => {},
      } as unknown as PTYSession,
      { getFullBulletContent: () => null } as unknown as MessageAPI,
    );
    const record = (profile?: string, revision = 'old') => ({
      remiSessionId: id,
      claudeSessionId: null,
      projectPath: root,
      port: 19200,
      pid: null,
      startedAt: new Date().toISOString(),
      exitedAt: null,
      exitCode: null,
      ...(profile && { profile, profileSnapshot: { revision, label: 'Snapshot' } }),
    });
    // Positive control: a visible profile's external transcript, listed while hidden ones drop.
    const workProjects = path.join(root, 'work-projects');
    const visibleId = crypto.randomUUID();
    fs.mkdirSync(path.join(workProjects, '-project'), { recursive: true });
    fs.writeFileSync(
      path.join(workProjects, '-project', `${visibleId}.jsonl`),
      `${JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: 'hello' } })}\n`,
    );
    const discovery = new TranscriptDiscovery({
      projectsDir: path.join(root, 'projects'),
      profileRoots: () => [{ profile: 'work', projectsDir: workProjects }],
    });
    const list = (policy: Profiles = profiles) =>
      buildSessionList(
        {
          profiles: () => policy,
          sidecar: () => readProfileSidecar(new SessionProfilesFile(root)),
          profileOfSession: (sessionId) => store.findByRemiSessionId(sessionId),
          withholdTranscriptPaths: false,
          sessionRegistry: registry,
          bindingStore: new SessionBindingStore(store),
          transcriptDiscovery: discovery,
          harness: new ClaudeHarness(discovery),
        },
        true,
      );
    const build = (policy: Profiles = profiles) => list(policy).own;
    const check = (profile: string, revision: string, expected: SessionProfileRef | undefined) => {
      store.save(record(profile, revision), { profile, revision });
      new SessionProfilesFile(root).reconcile([id], { id, profile, revision });
      expect(build()[0]?.profile).toEqual(expected);
    };
    check('work', profiles.entries['work']?.revision ?? '', {
      id: 'work',
      label: 'Work',
      state: 'current',
    });
    check('work', 'old', { id: 'work', label: 'Work', state: 'changed' });
    check('removed', 'old', undefined);
    expect(build()).toEqual([]);
    expect(JSON.stringify(build())).not.toContain('Snapshot');
    expect(build({ error: 'invalid' })).toEqual([]);
    check('secret', 'old', undefined);
    expect(build()).toEqual([]);
    expect(list().external).toMatchObject([
      { sessionId: visibleId, profile: { id: 'work', label: 'Work', state: 'current' } },
    ]);
    expect(list({ error: 'invalid' }).external).toEqual([]);
    store.save(record());
    expect(build()).toEqual([]);
    fs.writeFileSync(path.join(root, 'session-profiles.json'), '{');
    expect(build()).toEqual([]);
    fs.rmSync(path.join(root, 'session-profiles.json'));
    expect(build()[0]?.profile).toBeUndefined();
  } finally {
    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('hidden transcript roots are excluded before the discovery cap', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2b-roots-'));
  const registry = new SessionRegistry({ orphanTimeoutMs: 1000 });
  try {
    const hidden = path.join(root, 'hidden');
    const visible = path.join(root, 'visible');
    const profiles = parseProfiles({
      secret: {
        label: 'Secret',
        remote_visible: false,
        claude: { expects: 'subscription', dir: hidden },
      },
      work: {
        label: 'Work',
        remote_selectable: true,
        claude: { expects: 'subscription', dir: visible },
      },
    });
    if ('error' in profiles) throw new Error(profiles.error);
    for (const [dir, count] of [
      [hidden, 60],
      [visible, 5],
    ] as const) {
      const project = path.join(dir, 'projects', '-project');
      fs.mkdirSync(project, { recursive: true });
      for (let i = 0; i < count; i++) {
        const file = path.join(project, `${crypto.randomUUID()}.jsonl`);
        fs.writeFileSync(
          file,
          `${JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: 'hello' } })}\n`,
        );
        if (dir === hidden)
          fs.utimesSync(file, new Date(Date.now() + 10000), new Date(Date.now() + 10000));
      }
    }
    const discovery = new TranscriptDiscovery({
      projectsDir: path.join(root, 'default'),
      profileRoots: () => visibleProfileRoots(profiles, profiles),
    });
    const entries = discovery.discoverSessions();
    expect(entries).toHaveLength(5);
    for (const entry of entries)
      expect(discovery.profileOfTranscript(entry.sessionId)).toBe('work');
    const store = new SessionStore(path.join(root, 'sessions.json'));
    const list = buildSessionList(
      {
        profiles: () => profiles,
        sidecar: () => readProfileSidecar(new SessionProfilesFile(root)),
        profileOfSession: (id) => store.findByRemiSessionId(id),
        withholdTranscriptPaths: false,
        sessionRegistry: registry,
        bindingStore: new SessionBindingStore(store),
        transcriptDiscovery: discovery,
        harness: new ClaudeHarness(discovery),
      },
      true,
    );
    expect(list.external).toHaveLength(5);
    for (const entry of list.external)
      expect(entry.profile).toEqual({ id: 'work', label: 'Work', state: 'current' });
  } finally {
    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a live session with no record yet is left out of the ports while profiles are in use', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2b-live-ports-'));
  try {
    const profiles = parseProfiles({
      work: { label: 'Work', remote_selectable: true, claude: { expects: 'subscription' } },
    });
    if ('error' in profiles) throw new Error(profiles.error);
    const revision = profiles.entries['work']?.revision ?? '';
    const store = new SessionStore(path.join(root, 'sessions.json'));
    const live = new SessionRegistryFile(path.join(root, 'live'));
    const register = (sessionId: string, wsPort: number) =>
      live.register({
        sessionId,
        pid: process.pid,
        wsPort,
        hookPort: wsPort + 1,
        projectPath: root,
        name: `s${wsPort}`,
        startedAt: new Date().toISOString(),
      });
    // A child that registered live and has not written its record yet.
    register(crypto.randomUUID(), 19410);
    // A visible session with its record: the positive control.
    const recorded = crypto.randomUUID();
    register(recorded, 19420);
    store.save(
      {
        remiSessionId: recorded,
        claudeSessionId: null,
        projectPath: root,
        port: 19420,
        pid: null,
        startedAt: new Date().toISOString(),
        exitedAt: null,
        exitCode: null,
        profile: 'work',
        profileSnapshot: { revision },
      },
      { profile: 'work', revision },
    );
    const ports = (policy: Profiles) =>
      visibleLivePorts({
        listLive: () => live.listLive(),
        profileOfSession: (id) => store.findByRemiSessionId(id),
        profiles: () => policy,
        sidecar: () => readProfileSidecar(new SessionProfilesFile(root)),
      }).sort();
    expect(ports(profiles)).toEqual([19420]);
    expect(ports({ error: 'Could not read or parse configuration' })).toEqual([]);
    // No [profiles] table: the record-less entry is listed, as before profiles (and the work
    // record, whose profile is no longer configured, is hidden: L1).
    expect(ports({ entries: {}, notices: [] })).toEqual([19410]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
