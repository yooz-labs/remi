import * as fs from 'node:fs';
import * as path from 'node:path';
import { remiHome } from '../config/remi-home.ts';
import { withInterprocessFileLock } from '../storage/interprocess-file-lock.ts';

export interface SessionProfileEntry {
  profile: string;
  revision: string;
}

/** Separate ownership evidence survives older writers of sessions.json. */
export class SessionProfilesFile {
  private readonly file: string;

  constructor(home = remiHome()) {
    this.file = path.join(home, 'session-profiles.json');
  }

  private readUnlocked(): Record<string, SessionProfileEntry> {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.create(null);
      throw error;
    }
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data))
      throw new Error('Invalid session profile file');
    const record = data as Record<string, unknown>;
    const sessions = record['sessions'];
    if (
      record['version'] !== 1 ||
      !sessions ||
      typeof sessions !== 'object' ||
      Array.isArray(sessions)
    )
      throw new Error('Invalid session profile file');
    const result: Record<string, SessionProfileEntry> = Object.create(null);
    for (const [id, value] of Object.entries(sessions)) {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid session profile file');
      const entry = value as Record<string, unknown>;
      if (typeof entry['profile'] !== 'string' || typeof entry['revision'] !== 'string')
        throw new Error('Invalid session profile file');
      result[id] = { profile: entry['profile'], revision: entry['revision'] };
    }
    return result;
  }

  get(id: string): SessionProfileEntry | undefined {
    return withInterprocessFileLock(this.file, () => this.readUnlocked()[id]);
  }

  /** Called while the sessions file lock is held; preserve evidence erased by an older writer. */
  reconcile(
    ids: readonly string[],
    addition?: { id: string; profile: string; revision: string },
  ): void {
    if (!fs.existsSync(this.file) && !addition) return;
    withInterprocessFileLock(this.file, () => {
      const entries = this.readUnlocked();
      const live = new Set(ids);
      for (const id of Object.keys(entries)) if (!live.has(id)) Reflect.deleteProperty(entries, id);
      if (addition)
        entries[addition.id] = { profile: addition.profile, revision: addition.revision };
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(temporary, JSON.stringify({ version: 1, sessions: entries }, null, 2), {
          mode: 0o600,
        });
        fs.chmodSync(temporary, 0o600);
        fs.renameSync(temporary, this.file);
      } finally {
        fs.rmSync(temporary, { force: true });
      }
    });
  }
}
