import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HarnessSession } from '../../src/harness/types.ts';
import { currentProfiles } from '../../src/profiles/current-profiles.ts';
import { parseProfiles } from '../../src/profiles/profile-config.ts';
import {
  FileDownloadSessionHost,
  launchDownloadRoots,
} from '../../src/tunnel/file-download-session-host.ts';
import { downloadFixture } from '../helpers/file-download-service-fixture.ts';

test('all configured roots are protected and selected roots stay required', () => {
  const profiles = parseProfiles({
    work: {
      label: 'Work',
      claude: { dir: '/tmp/work-claude', expects: 'subscription' },
      codex: { dir: '/tmp/work-codex', expects: 'subscription' },
    },
    home: { label: 'Home', claude: { dir: '/tmp/home-claude', expects: 'subscription' } },
    other: { label: 'Other', codex: { dir: '/tmp/other-codex', expects: 'subscription' } },
  });
  if (!('entries' in profiles)) throw new Error('invalid fixture');
  const selected = profiles.entries['work'];
  const base = {
    home: '/tmp/remi',
    userHome: '/tmp/user',
    harness: 'claude' as const,
    profile: selected,
    env: {},
  };
  const ordinary = launchDownloadRoots(base)('/tmp/project');
  const roots = launchDownloadRoots({ ...base, configuredProfiles: () => profiles })(
    '/tmp/project',
  );
  for (const name of ['/tmp/work-claude', '/tmp/work-codex'])
    expect(roots).toContainEqual({ pathname: name, required: true });
  for (const name of ['/tmp/home-claude', '/tmp/other-codex'])
    expect(roots).toContainEqual({ pathname: name, required: false });
  expect(
    launchDownloadRoots({ ...base, configuredProfiles: () => ({ error: 'invalid' }) })(
      '/tmp/project',
    ),
  ).toEqual(ordinary);
});

test('real download host protects an inactive adopted directory inside the project', async () => {
  const f = await downloadFixture();
  const home = path.join(f.files.directory, 'host-state');
  const inactive = path.join(f.files.work, 'inactive-profile');
  const selected = path.join(f.files.directory, 'selected');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(inactive);
  fs.mkdirSync(selected);
  fs.writeFileSync(path.join(inactive, 'private.txt'), 'private fixture');
  f.write('public.txt', 'public fixture');
  let profiles = parseProfiles({
    inactive: { label: 'Inactive', claude: { dir: inactive, expects: 'subscription' } },
  });
  const runtime = { pty: f.base.pty } as HarnessSession;
  const host = new FileDownloadSessionHost({
    home,
    sessions: f.base.registry,
    bindings: f.bindings,
    runtimeFor: () => runtime,
    directAdapter: () => undefined,
    rootsFor: launchDownloadRoots({
      home,
      userHome: f.files.userHome,
      harness: 'claude',
      profile: { claude: { dir: selected } },
      env: {},
      configuredProfiles: () => profiles,
    }),
    onReady: () => {},
  });
  const id = f.sessionId();
  try {
    expect(await host.open(f.base.trust)).toBe(true);
    const configured = profiles;
    profiles = parseProfiles({});
    host.beginSession(id, f.files.work);
    host.bindSession(id, runtime);
    host.afterClaudeCommit(id, f.binding().harnessSessionId, true);
    host.started(id);
    const before = host.contextFor(id);
    expect(before).not.toBeNull();
    expect(before?.protectedRootPaths).not.toContain(inactive);
    profiles = configured;
    const context = host.contextFor(id);
    expect(context).not.toBe(before);
    expect(context?.protectedRootPaths).toContain(inactive);
    f.setContext(context);
    const peer = await f.client();
    expect(await peer.submit(peer.begin('inactive-profile/private.txt'))).toMatchObject({
      type: 'file_fetch_refused',
      code: 'unavailable',
    });
    const accepted = await peer.submit(peer.begin('public.txt'));
    expect(accepted.type).toBe('file_fetch_accepted');
    if (accepted.type === 'file_fetch_accepted') await peer.submit(peer.cancel(accepted.requestId));
  } finally {
    await host.closeAll();
    await f.close();
  }
}, 20000);

test('last good config and symlinked inactive root protect downloads', async () => {
  const f = await downloadFixture();
  const home = path.join(f.files.directory, 'host-state');
  const selected = path.join(f.files.directory, 'selected');
  const target = path.join(f.files.work, 'real-profile');
  const link = path.join(f.files.directory, 'profile-link');
  const config = path.join(f.files.directory, 'config.toml');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(selected);
  fs.mkdirSync(target);
  fs.symlinkSync(target, link);
  fs.writeFileSync(path.join(target, 'private.txt'), 'fixture');
  f.write('public.txt', 'fixture');
  fs.writeFileSync(
    config,
    `[profiles.inactive]\nlabel="Inactive"\n[profiles.inactive.claude]\ndir="${link}"\nexpects="subscription"\n`,
  );
  const good = currentProfiles(config);
  expect(good).toHaveProperty('entries');
  fs.writeFileSync(config, '[[invalid');
  const runtime = { pty: f.base.pty } as HarnessSession;
  const host = new FileDownloadSessionHost({
    home,
    sessions: f.base.registry,
    bindings: f.bindings,
    runtimeFor: () => runtime,
    directAdapter: () => undefined,
    rootsFor: launchDownloadRoots({
      home,
      userHome: f.files.userHome,
      harness: 'claude',
      profile: { claude: { dir: selected } },
      env: {},
      configuredProfiles: () => currentProfiles(config),
    }),
    onReady: () => {},
  });
  const id = f.sessionId();
  try {
    expect(await host.open(f.base.trust)).toBe(true);
    host.beginSession(id, f.files.work);
    host.bindSession(id, runtime);
    host.afterClaudeCommit(id, f.binding().harnessSessionId, true);
    host.started(id);
    const context = host.contextFor(id);
    expect(context?.protectedRootPaths).toContain(target);
    f.setContext(context);
    const peer = await f.client();
    expect(await peer.submit(peer.begin('real-profile/private.txt'))).toMatchObject({
      type: 'file_fetch_refused',
      code: 'unavailable',
    });
    const accepted = await peer.submit(peer.begin('public.txt'));
    expect(accepted.type).toBe('file_fetch_accepted');
    if (accepted.type === 'file_fetch_accepted') await peer.submit(peer.cancel(accepted.requestId));
  } finally {
    await host.closeAll();
    await f.close();
  }
}, 20000);

test.each(['file', 'unreadable', 'dangling', 'ancestor'] as const)(
  'inactive %s root does not disrupt unrelated downloads',
  async (kind) => {
    const f = await downloadFixture();
    const home = path.join(f.files.directory, 'host-state');
    const selected = path.join(f.files.directory, 'selected');
    const inactive =
      kind === 'ancestor' ? f.files.directory : path.join(f.files.directory, 'inactive');
    fs.mkdirSync(home, { mode: 0o700 });
    fs.mkdirSync(selected);
    if (kind === 'file') fs.writeFileSync(inactive, 'fixture');
    if (kind === 'unreadable') {
      fs.mkdirSync(inactive);
      fs.chmodSync(inactive, 0o000);
    }
    if (kind === 'dangling') fs.symlinkSync(path.join(f.files.directory, 'missing'), inactive);
    f.write('public.txt', 'fixture');
    const runtime = { pty: f.base.pty } as HarnessSession;
    const host = new FileDownloadSessionHost({
      home,
      sessions: f.base.registry,
      bindings: f.bindings,
      runtimeFor: () => runtime,
      directAdapter: () => undefined,
      rootsFor: launchDownloadRoots({
        home,
        userHome: f.files.userHome,
        harness: 'claude',
        profile: { claude: { dir: selected } },
        env: {},
        configuredProfiles: () => ({
          entries: {
            inactive: {
              id: 'inactive',
              label: 'Inactive',
              claude: { dir: inactive, expects: 'subscription' },
              revision: '',
              args: [],
              folders: [],
              env: {},
            },
          },
          notices: [],
        }),
      }),
      onReady: () => {},
    });
    const id = f.sessionId();
    try {
      expect(await host.open(f.base.trust)).toBe(true);
      host.beginSession(id, f.files.work);
      host.bindSession(id, runtime);
      host.afterClaudeCommit(id, f.binding().harnessSessionId, true);
      host.started(id);
      const context = host.contextFor(id);
      expect(context).not.toBeNull();
      f.setContext(context);
      const peer = await f.client();
      const result = await peer.submit(peer.begin('public.txt'));
      expect(result.type).toBe(kind === 'ancestor' ? 'file_fetch_refused' : 'file_fetch_accepted');
      if (result.type === 'file_fetch_accepted') await peer.submit(peer.cancel(result.requestId));
    } finally {
      if (kind === 'unreadable') fs.chmodSync(inactive, 0o700);
      await host.closeAll();
      await f.close();
    }
  },
  20000,
);
