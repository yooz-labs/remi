import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { inProcessResumeRefusal } from '../../src/profiles/in-process-resume.ts';
import { parseProfiles } from '../../src/profiles/profile-config.ts';
import { sessionProfileRef } from '../../src/profiles/session-profile-ref.ts';
import {
  deviceDefault,
  hiddenDirectory,
  isProfileHidden,
  isProfileSelectable,
} from '../../src/profiles/visibility.ts';
import { SessionProfilesFile } from '../../src/session/session-profiles-file.ts';
import { SessionStore, type StoredSession } from '../../src/session/session-store.ts';

const entry = (dir: string, extra: Record<string, unknown> = {}) => ({
  label: 'Example',
  folders: [dir],
  claude: { expects: 'subscription', dir: `${dir}/config` },
  ...extra,
});

test('in-process selection uses current visibility before ownership validation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2b-resume-'));
  try {
    const original = parseProfiles({ work: entry('/p2b/work', { remote_selectable: true }) });
    if ('error' in original) throw new Error(original.error);
    const revision = original.entries['work']?.revision as string;
    const claudeId = crypto.randomUUID();
    const record: StoredSession = {
      remiSessionId: crypto.randomUUID(),
      claudeSessionId: claudeId,
      projectPath: root,
      port: 19200,
      pid: null,
      startedAt: new Date().toISOString(),
      exitedAt: null,
      exitCode: null,
      profile: 'work',
      profileSnapshot: { revision },
    };
    const store = new SessionStore(path.join(root, 'sessions.json'));
    store.save(record, { profile: 'work', revision });
    const check = (current: ReturnType<typeof parseProfiles>) =>
      inProcessResumeRefusal(
        store,
        new SessionProfilesFile(root),
        original,
        current,
        'work',
        claudeId,
        () => {},
      );
    expect(check(original)).toBeNull();
    expect(check(parseProfiles({ work: entry('/p2b/work') }))).toBe(
      "This session's profile work does not accept sessions from your devices. Resume it on that machine with remi --resume, or add remote_selectable = true to [profiles.work] in config.toml there.",
    );
    expect(check(parseProfiles({ work: entry('/p2b/work', { remote_visible: false }) }))).toBe(
      'That session was not found on this machine.',
    );
    expect(check({ error: 'invalid' })).toBe('That session was not found on this machine.');
    // A removed profile retains the existing ownership check rather than being called unselectable.
    expect(check(parseProfiles(undefined))).toBe(
      'This session was started in profile work, which no longer exists. Start a new session.',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('remote profile policy', () => {
  const profiles = parseProfiles({
    work: entry('/p2b/work', { remote_selectable: true }),
    quiet: entry('/p2b/quiet'),
    secret: entry('/p2b/secret', { remote_visible: false, remote_selectable: true }),
  });
  test('loads defaults, notices, and independent revisions', () => {
    if ('error' in profiles) throw new Error(profiles.error);
    expect(profiles.entries['quiet']).toMatchObject({
      remoteVisible: true,
      remoteSelectable: false,
    });
    expect(profiles.notices).toContain(
      'profiles.secret: remote_selectable has no effect while remote_visible is false',
    );
    const changed = parseProfiles({ work: entry('/p2b/work', { remote_visible: false }) });
    if ('error' in changed) throw new Error(changed.error);
    expect(changed.entries['work']?.revision).toBe(profiles.entries['work']?.revision);
    for (const key of ['remote_visible', 'remote_selectable']) {
      expect(parseProfiles({ work: entry('/p2b/work', { [key]: 'yes' }) })).toEqual({
        error: `profiles.work.${key}: expected a boolean`,
      });
    }
  });
  test('applies visibility and selectability, including an invalid configuration', () => {
    const invalid = { error: 'invalid' };
    for (const [id, hidden, selectable] of [
      ['default', false, true],
      ['work', false, true],
      ['quiet', false, false],
      ['secret', true, false],
      ['unknown', false, false],
    ] as const) {
      expect(isProfileHidden(id, profiles)).toBe(hidden);
      expect(isProfileSelectable(id, profiles)).toBe(selectable);
      expect(isProfileHidden(id, invalid)).toBe(id !== 'default');
      expect(isProfileSelectable(id, invalid)).toBe(id === 'default');
    }
    expect(hiddenDirectory('/p2b/secret/config/projects', profiles)).toBe(true);
    expect(hiddenDirectory('/p2b/work', profiles)).toBe(false);
    expect(hiddenDirectory('/p2b/work', invalid)).toBe(true);
  });
  test('resolves the same folder and machine defaults', () => {
    expect(deviceDefault('/p2b/work/project', profiles)).toEqual({ id: 'work', source: 'folder' });
    expect(deviceDefault('/elsewhere', profiles, 'quiet')).toEqual({
      id: 'quiet',
      source: 'machine_default',
    });
    expect(deviceDefault('/elsewhere', profiles)).toEqual({ id: 'default', source: 'built_in' });
    expect(deviceDefault('/elsewhere', { error: 'invalid' }, 'work')).toEqual({ error: 'invalid' });
    expect(deviceDefault('/elsewhere', { error: 'invalid' }, 'default')).toEqual({
      error: 'invalid',
    });
    expect(
      sessionProfileRef(
        { owner: 'hidden' },
        { revision: 'old', label: 'Private label' },
        { error: 'invalid' },
      ),
    ).toBeUndefined();
  });
});
