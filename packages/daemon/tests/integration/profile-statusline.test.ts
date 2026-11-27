import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cleanupHub, makeIsolatedDirs, pollUntil, spawnDaemon } from './hub-test-utils.ts';

test('session daemon registers only an isolated profile status line', async () => {
  const dirs = makeIsolatedDirs();
  const remi = path.join(dirs.home, '.remi');
  const adopted = path.join(dirs.home, 'adopted');
  const bin = path.join(dirs.home, 'bin');
  fs.mkdirSync(remi);
  fs.mkdirSync(adopted);
  fs.mkdirSync(path.join(remi, 'p', 'local', 'claude'), { recursive: true });
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, 'claude'),
    '#!/bin/sh\nif [ "$1 $2 $3" = "auth status --json" ]; then echo "{\\"loggedIn\\":true,\\"authMethod\\":\\"claude.ai\\",\\"apiProvider\\":\\"firstParty\\"}"; exit 0; fi\ni=0; while [ ! -e "$HOME/release" ] && [ "$i" -lt 300 ]; do /bin/sleep 0.1; i=$((i+1)); done\n',
    { mode: 0o700 },
  );
  fs.writeFileSync(
    path.join(remi, 'config.toml'),
    `[profiles.local]\nlabel="Local"\n[profiles.local.claude]\nexpects="subscription"\n[profiles.adopted]\nlabel="Adopted"\n[profiles.adopted.claude]\nexpects="subscription"\ndir=${JSON.stringify(adopted)}\n`,
  );
  const env = { PATH: `${bin}:/usr/bin:/bin`, REMI_HOME: remi };
  const started = [];
  try {
    for (const name of ['local', 'adopted']) {
      const child = await spawnDaemon(dirs.home, dirs.work, env, ['--remi-profile', name]);
      started.push({ ...child, ...dirs });
      await pollUntil(
        () =>
          fs.existsSync(path.join(remi, `status-${child.port}.json`)) ||
          child.proc.exitCode !== null,
        15000,
        'profile startup',
      );
      expect(child.proc.exitCode).toBeNull();
    }
    const localSettings = path.join(remi, 'p', 'local', 'claude', 'settings.json');
    expect(JSON.parse(fs.readFileSync(localSettings, 'utf8')).statusLine.type).toBe('command');
    expect(fs.existsSync(path.join(adopted, 'settings.json'))).toBe(false);
    expect(fs.existsSync(path.join(dirs.home, '.claude', 'settings.json'))).toBe(false);
  } finally {
    fs.writeFileSync(path.join(dirs.home, 'release'), '');
    for (const child of started) {
      child.proc.kill('SIGTERM');
      await child.proc.exited;
    }
    if (started.length > 0) await cleanupHub(started[0] as (typeof started)[number]);
    else {
      fs.rmSync(dirs.home, { recursive: true, force: true });
      fs.rmSync(dirs.work, { recursive: true, force: true });
    }
  }
}, 35000);
