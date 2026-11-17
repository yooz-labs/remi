import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { inProcessResumeRefusal } from '../../src/profiles/in-process-resume.ts';
import { parseProfiles } from '../../src/profiles/profile-config.ts';
import { resumeProfile } from '../../src/profiles/resume-profile.ts';
import { SessionProfilesFile } from '../../src/session/session-profiles-file.ts';
import { SessionStore, type StoredSession } from '../../src/session/session-store.ts';

test('in-process resume checks real ownership records and conceals read errors', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-profile-'));
  try {
    const profiles = parseProfiles({
      work: { label: 'Work', claude: { expects: 'subscription' } },
      other: { label: 'Other', claude: { expects: 'subscription' } },
    });
    if ('error' in profiles) throw new Error(profiles.error);
    const revision = profiles.entries['work']?.revision as string;
    const id = crypto.randomUUID();
    const record: StoredSession = {
      remiSessionId: crypto.randomUUID(),
      claudeSessionId: id,
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
    const logs: string[] = [];
    const check = (own: string, key = id) =>
      inProcessResumeRefusal(store, new SessionProfilesFile(root), profiles, own, key, (line) =>
        logs.push(line),
      );
    expect(check('work')).toBeNull();
    expect(check('other')).toContain('belongs to profile work');
    expect(check('work', crypto.randomUUID())).toContain('has no remi record');
    expect(check('default', crypto.randomUUID())).toBeNull();
    const plainId = crypto.randomUUID();
    const plainRecord = {
      ...record,
      remiSessionId: crypto.randomUUID(),
      claudeSessionId: plainId,
      profile: undefined,
      profileSnapshot: undefined,
    } as StoredSession;
    store.save(plainRecord);
    expect(check('work', plainId)).toContain('belongs to profile default');
    fs.writeFileSync(path.join(root, 'sessions.json'), 'not json');
    const error = check('work');
    expect(error).toBe(
      "This session's profile could not be checked: the host's session records could not be read.",
    );
    expect(error).not.toContain(root);
    expect(logs[0]).toContain(root);
    const plain = { ...record, profile: undefined, profileSnapshot: undefined } as StoredSession;
    const empty = path.join(root, 'empty');
    fs.mkdirSync(empty);
    expect(
      resumeProfile(plain, { entries: {}, notices: [] }, new SessionProfilesFile(empty)),
    ).toEqual({ id: 'default' });
    expect(fs.readdirSync(empty)).toEqual([]);
    for (const damaged of ['not json', '{"version":2,"sessions":{}}']) {
      fs.writeFileSync(path.join(root, 'session-profiles.json'), damaged);
      expect(resumeProfile(record, profiles, new SessionProfilesFile(root))).toEqual({
        error:
          "This session's profile information was changed by another remi process. Start a new session.",
      });
      expect(
        resumeProfile(plain, { entries: {}, notices: [] }, new SessionProfilesFile(root)),
      ).toEqual({ id: 'default' });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
