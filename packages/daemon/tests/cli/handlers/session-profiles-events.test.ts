import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { type SessionProfilesResponseMessage, generateId, serialize } from '@remi/shared';
import { createCreateSessionHandlers } from '../../../src/cli/handlers/create-session-events.ts';
import { createSessionProfilesHandlers } from '../../../src/cli/handlers/session-profiles-events.ts';
import { HarnessRegistry } from '../../../src/harness/registry.ts';
import { currentProfilesStrict } from '../../../src/profiles/current-profiles.ts';
import { parseProfiles } from '../../../src/profiles/profile-config.ts';
import { SessionRegistryFile } from '../../../src/session/session-registry-file.ts';

test('profile picker lists selectable profiles and fails closed', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p2b-picker-')));
  const config = path.join(root, 'config.toml');
  const dirs = ['work', 'quiet', 'secret'].map((name) => path.join(root, name));
  for (const dir of dirs) fs.mkdirSync(dir);
  const table = dirs
    .map((dir, index) => {
      const name = ['work', 'quiet', 'secret'][index];
      return `[profiles.${name}]\nlabel="${name} label"\nfolders=["${dir}"]\nremote_selectable=${index === 0}\nremote_visible=${index !== 2}\n[profiles.${name}.claude]\nexpects="subscription"\n`;
    })
    .join('\n');
  try {
    fs.writeFileSync(config, table);
    const frames: SessionProfilesResponseMessage[] = [];
    const handler = createSessionProfilesHandlers({
      profiles: () => currentProfilesStrict(config),
      send: (_id, message) => {
        if (message.type !== 'session_profiles_response') throw new Error('unexpected response');
        frames.push(message);
        return true;
      },
    });
    const ask = (directory: unknown) => {
      handler.onSessionProfilesRequest(generateId(), generateId(), directory as string | undefined);
      const frame = frames.at(-1);
      if (!frame) throw new Error('missing response');
      return frame;
    };
    expect(ask(dirs[0])).toMatchObject({
      profiles: [
        { id: 'default', harnesses: ['claude', 'codex'] },
        { id: 'work', harnesses: ['claude'] },
      ],
      default: { id: 'work', source: 'folder' },
    });
    const quiet = ask(dirs[1]);
    expect(quiet.default).toBeUndefined();
    expect(quiet.profiles.map((profile) => profile.id)).not.toContain('quiet');
    expect(ask(dirs[2]).default).toBeUndefined();
    expect(JSON.stringify(frames)).not.toContain('secret');
    for (const invalid of [42, '-x', 'bad\npath'])
      expect(ask(invalid)).toMatchObject({ profiles: [], refused: 'directory_invalid' });
    expect(ask('.').refused).toBeUndefined();
    for (const broken of [
      '[[invalid',
      table.replace('remote_selectable=true', 'remote_selectable="invalid"'),
    ]) {
      fs.writeFileSync(config, broken);
      for (const dir of [dirs[0], root])
        expect(ask(dir)).toMatchObject({ profiles: [], refused: 'profiles_invalid' });
    }
    const maximal = Array.from(
      { length: 32 },
      (_, i) =>
        `[profiles.p${i}]\nlabel="${'L'.repeat(64)}"\nremote_selectable=true\n[profiles.p${i}.claude]\nexpects="subscription"\n[profiles.p${i}.codex]\nexpects="subscription"\n`,
    ).join('\n');
    fs.writeFileSync(config, maximal);
    expect(Buffer.byteLength(serialize(ask(root)))).toBeLessThan(65536);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a relative directory has the same default in the picker and create path', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2b-relative-'));
  try {
    const profiles = parseProfiles({
      work: {
        label: 'Work',
        folders: [process.cwd()],
        remote_selectable: true,
        claude: { expects: 'subscription' },
      },
    });
    let answer: SessionProfilesResponseMessage | undefined;
    const list = createSessionProfilesHandlers({
      profiles: () => profiles,
      send: (_id, message) => {
        if (message.type === 'session_profiles_response') answer = message;
        return true;
      },
    });
    list.onSessionProfilesRequest(generateId(), generateId(), '.');
    expect(answer?.default).toEqual({ id: 'work', source: 'folder' });
    let spawned: string[] = [];
    const create = createCreateSessionHandlers({
      harnesses: new HarnessRegistry({}),
      liveSessionsRegistry: new SessionRegistryFile(root),
      spawningPorts: new Set(),
      basePort: 19200,
      portRange: 1,
      bindHost: '127.0.0.1',
      inheritedArgs: () => [],
      profiles: () => profiles,
      findAvailableTcpPort: async () => 19200,
      spawnDaemon: async (_port, _directory, args) => {
        spawned = args;
        return { sessionId: generateId(), port: 19200, pid: 1 };
      },
      send: () => true,
    });
    expect((await create.startSession('.')).ok).toBe(true);
    expect(spawned[0]).toBe('--remi-profile');
    expect(spawned[1]).toBe(answer?.default?.id);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
