import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateId } from '@remi/shared';
import { createSessionProfilesHandlers } from '../../src/cli/handlers/session-profiles-events.ts';
import { currentProfiles, currentProfilesStrict } from '../../src/profiles/current-profiles.ts';
import { launchDownloadRoots } from '../../src/tunnel/file-download-session-host.ts';

test('strict remote policy fails closed without changing last-good download protection', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2b-strict-'));
  const config = path.join(root, 'config.toml');
  const mapped = path.join(root, 'mapped');
  const profileDir = path.join(root, 'profile');
  fs.mkdirSync(mapped);
  fs.mkdirSync(profileDir);
  const good = `[profiles.work]\nlabel="Work label"\nfolders=["${mapped}"]\nremote_selectable=true\n[profiles.work.claude]\nexpects="subscription"\ndir="${profileDir}"\n`;
  try {
    fs.writeFileSync(config, good);
    expect(currentProfiles(config)).toHaveProperty('entries.work');
    expect(currentProfilesStrict(config)).toHaveProperty('entries.work');
    for (const broken of [
      '[[invalid',
      good.replace('remote_selectable=true', 'remote_selectable="invalid"'),
    ]) {
      fs.writeFileSync(config, broken);
      expect(currentProfilesStrict(config)).toHaveProperty('error');
      expect(currentProfiles(config)).toHaveProperty('entries.work');
      const frames: unknown[] = [];
      const handler = createSessionProfilesHandlers({
        profiles: () => currentProfilesStrict(config),
        send: (_id, message) => {
          frames.push(message);
          return true;
        },
      });
      for (const directory of [mapped, root])
        handler.onSessionProfilesRequest(generateId(), generateId(), directory);
      for (const frame of frames)
        expect(frame).toMatchObject({ refused: 'profiles_invalid', profiles: [] });
      expect(JSON.stringify(frames)).not.toContain('work');
      expect(JSON.stringify(frames)).not.toContain('Work label');
      const roots = launchDownloadRoots({
        home: root,
        userHome: root,
        harness: 'claude',
        profile: undefined,
        env: {},
        configuredProfiles: () => currentProfiles(config),
      })(root);
      expect(roots).toContainEqual({ pathname: profileDir, required: false });
    }
    fs.unlinkSync(config);
    expect(currentProfilesStrict(config)).toEqual({ entries: {}, notices: [] });
    expect(currentProfiles(config)).toHaveProperty('entries.work');
    fs.writeFileSync(config, 'not a directory');
    expect(currentProfilesStrict(path.join(config, 'config.toml'))).toHaveProperty('error');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
