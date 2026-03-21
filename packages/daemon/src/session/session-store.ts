/**
 * SessionStore - Persistent JSON storage for session metadata.
 *
 * Stores session records at ~/.remi/sessions.json so that
 * `remi --resume` can look up Claude session IDs across process restarts.
 *
 * Sessions track the remi wrapper PID so that stale "running" entries
 * (from crashed/killed processes) can be detected and auto-cleaned.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { UUID } from '@remi/shared';

export interface StoredSession {
  remiSessionId: UUID;
  claudeSessionId: string | null;
  projectPath: string;
  port: number;
  pid: number | null;
  startedAt: string;
  exitedAt: string | null;
  exitCode: number | null;
}

interface SessionsFile {
  version: 1;
  sessions: StoredSession[];
}

const REMI_DIR = path.join(os.homedir(), '.remi');
const SESSIONS_FILE = path.join(REMI_DIR, 'sessions.json');
const MAX_SESSIONS = 100;
const STALE_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export class SessionStore {
  private filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? SESSIONS_FILE;
  }

  /** Ensure the ~/.remi directory exists. */
  private ensureDir(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /** Read sessions file, returning empty list if missing or corrupt. */
  private read(): StoredSession[] {
    try {
      if (!fs.existsSync(this.filePath)) return [];
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(raw) as SessionsFile;
      if (data.version !== 1 || !Array.isArray(data.sessions)) return [];
      return data.sessions;
    } catch {
      return [];
    }
  }

  /** Write sessions to file. */
  private write(sessions: StoredSession[]): void {
    this.ensureDir();
    const data: SessionsFile = { version: 1, sessions };
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  /** Save or update a session record. Trims to MAX_SESSIONS. */
  save(session: StoredSession): void {
    const sessions = this.read();
    const idx = sessions.findIndex((s) => s.remiSessionId === session.remiSessionId);
    if (idx >= 0) {
      sessions[idx] = session;
    } else {
      sessions.push(session);
    }
    // Trim oldest exited sessions if over limit
    if (sessions.length > MAX_SESSIONS) {
      const exited = sessions.filter((s) => s.exitedAt !== null);
      exited.sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));
      const toRemove = sessions.length - MAX_SESSIONS;
      const removeIds = new Set(exited.slice(0, toRemove).map((s) => s.remiSessionId));
      const trimmed = sessions.filter((s) => !removeIds.has(s.remiSessionId));
      this.write(trimmed);
      return;
    }
    this.write(sessions);
  }

  /**
   * Purge stale sessions: mark dead "running" sessions as exited,
   * and remove exited sessions older than STALE_AGE_MS.
   * Returns true if any changes were written.
   */
  purgeStale(): boolean {
    const sessions = this.read();
    let changed = false;
    const now = Date.now();

    for (const s of sessions) {
      if (s.exitedAt !== null) continue;
      // No PID stored (legacy entry) or PID is dead: mark as exited
      if (s.pid === null || s.pid === undefined || !isProcessAlive(s.pid)) {
        s.exitedAt = new Date().toISOString();
        s.exitCode = null;
        changed = true;
      }
    }

    // Remove exited sessions older than 7 days
    const before = sessions.length;
    const kept = sessions.filter((s) => {
      if (s.exitedAt === null) return true;
      const exitedAge = now - new Date(s.exitedAt).getTime();
      return exitedAge < STALE_AGE_MS;
    });

    if (kept.length !== before) changed = true;

    if (changed) this.write(kept);
    return changed;
  }

  /** List all stored sessions, most recent first. Purges stale entries first. */
  list(): StoredSession[] {
    this.purgeStale();
    return this.read().sort((a, b) => (a.startedAt > b.startedAt ? -1 : 1));
  }

  /** Find a session by its Claude session ID. */
  findByClaudeSessionId(claudeSessionId: string): StoredSession | null {
    const sessions = this.read();
    return sessions.find((s) => s.claudeSessionId === claudeSessionId) ?? null;
  }

  /** Find a session by its Remi session ID. */
  findByRemiSessionId(remiSessionId: UUID): StoredSession | null {
    const sessions = this.read();
    return sessions.find((s) => s.remiSessionId === remiSessionId) ?? null;
  }

  /** Get the most recent session (by startedAt). */
  getMostRecent(): StoredSession | null {
    const sessions = this.list();
    return sessions[0] ?? null;
  }

  /** Mark a session as exited. */
  markExited(remiSessionId: UUID, exitCode: number | null): void {
    const sessions = this.read();
    const session = sessions.find((s) => s.remiSessionId === remiSessionId);
    if (session) {
      session.exitedAt = new Date().toISOString();
      session.exitCode = exitCode;
      this.write(sessions);
    }
  }

  /** Update the Claude session ID (extracted from transcript after startup). */
  updateClaudeSessionId(remiSessionId: UUID, claudeSessionId: string): void {
    const sessions = this.read();
    const session = sessions.find((s) => s.remiSessionId === remiSessionId);
    if (session) {
      session.claudeSessionId = claudeSessionId;
      this.write(sessions);
    }
  }
}

/**
 * Check if a process is alive by sending signal 0.
 * EPERM means the process exists but is owned by a different user.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return true;
    return false;
  }
}
