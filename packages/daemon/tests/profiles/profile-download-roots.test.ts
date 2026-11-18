import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HarnessSession } from '../../src/harness/types.ts';
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
  const profiles = parseProfiles({
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
    host.beginSession(id, f.files.work);
    host.bindSession(id, runtime);
    host.afterClaudeCommit(id, f.binding().harnessSessionId, true);
    host.started(id);
    const context = host.contextFor(id);
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
