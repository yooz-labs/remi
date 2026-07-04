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
import { errorToString } from '@remi/shared';
import type { UUID } from '@remi/shared';
import { normalizeProjectPath } from '../cli/path-resolver.ts';
import { isProcessAlive } from './process-alive.ts';

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

  /**
   * Read sessions file, returning empty list if missing or corrupt.
   * I/O errors (permissions, disk) are propagated so callers that
   * write back (purgeStale, save) do not overwrite with empty data.
   */
  private read(): StoredSession[] {
    if (!fs.existsSync(this.filePath)) return [];
    const raw = fs.readFileSync(this.filePath, 'utf-8');
    try {
      const data = JSON.parse(raw) as SessionsFile;
      if (data.version !== 1 || !Array.isArray(data.sessions)) return [];
      // Normalize legacy entries that lack the pid field
      for (const s of data.sessions) {
        s.pid ??= null;
        // Self-heal a tilde-form or otherwise unnormalized projectPath (#680):
        // every read re-normalizes so a legacy entry (or one written by an
        // older binary) becomes safe to `chdir`/compare against without a
        // dedicated migration. Mirrors SessionRegistryFile's persist-side fix
        // for #674; not written back to disk here, but any subsequent write()
        // (save/markExited/updateClaudeSessionId/purge) persists the fix.
        s.projectPath = normalizeProjectPath(s.projectPath);
      }
      return data.sessions;
    } catch (err) {
      if (!(err instanceof SyntaxError)) {
        console.warn(`[sessions] Unexpected error reading sessions: ${errorToString(err)}`);
      }
      return [];
    }
  }

  /** Write sessions to file (atomic via tmp + rename). */
  private write(sessions: StoredSession[]): void {
    this.ensureDir();
    const data: SessionsFile = { version: 1, sessions };
    // Per-writer-unique tmp path. A fixed `${filePath}.tmp` shared across
    // processes is a multi-writer race (#461): when two daemons in the same
    // ~/.remi write concurrently, both target the same tmp file and whichever
    // renames second hits ENOENT because the first already moved it away.
    // The pid scopes the tmp per process; the synchronous write+rename
    // serialize within a process, so the pid alone makes collisions impossible.
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    try {
      fs.renameSync(tmpPath, this.filePath);
    } catch (err) {
      // Don't leave our tmp file behind if the rename fails.
      try {
        fs.rmSync(tmpPath, { force: true });
      } catch {
        // best-effort cleanup; surface the original error
      }
      throw err;
    }
  }

  /**
   * Save or update a session record. Trims to MAX_SESSIONS. Normalizes
   * `projectPath` (expands `~`, resolves to absolute) before persisting, so a
   * caller passing a raw, unexpanded path never writes a malformed entry that
   * `--resume` would later `chdir` into (#680). Mirrors SessionRegistryFile's
   * `register()` fix for the live-sessions registry (#674).
   */
  save(session: StoredSession): void {
    const normalized: StoredSession = {
      ...session,
      projectPath: normalizeProjectPath(session.projectPath),
    };
    const sessions = this.read();
    const idx = sessions.findIndex((s) => s.remiSessionId === normalized.remiSessionId);
    if (idx >= 0) {
      sessions[idx] = normalized;
    } else {
      sessions.push(normalized);
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
   * Returns whether changes were written and the (possibly updated) session list.
   *
   * Note: PID recycling could cause a false "alive" result for a stale session
   * whose PID was reused by an unrelated process. This is acceptable because
   * the 7-day age pruning will eventually clean it, and PID collisions for
   * short-lived CLI processes are rare in practice.
   */
  private doPurge(): { changed: boolean; sessions: StoredSession[] } {
    const sessions = this.read();
    let changed = false;
    const now = Date.now();

    for (const s of sessions) {
      if (s.exitedAt !== null) continue;
      // No PID stored (legacy entry) or PID is dead: mark as exited
      if (s.pid === null || !isProcessAlive(s.pid)) {
        s.exitedAt = new Date().toISOString();
        s.exitCode = null;
        changed = true;
      }
    }

    // Remove exited sessions older than 7 days
    const before = sessions.length;
    const kept = sessions.filter((s) => {
      if (s.exitedAt === null) return true;
      const exitedTime = new Date(s.exitedAt).getTime();
      if (Number.isNaN(exitedTime)) return true; // keep entries with invalid dates
      return now - exitedTime < STALE_AGE_MS;
    });

    if (kept.length !== before) changed = true;

    if (changed) this.write(kept);
    return { changed, sessions: kept };
  }

  /** Purge stale sessions. Returns true if any changes were written. */
  purgeStale(): boolean {
    return this.doPurge().changed;
  }

  /** List all stored sessions, most recent first. Best-effort purge of stale entries. */
  list(): StoredSession[] {
    try {
      const { sessions } = this.doPurge();
      return sessions.sort((a, b) => (a.startedAt > b.startedAt ? -1 : 1));
    } catch (purgeErr) {
      console.warn(`[sessions] Purge failed: ${errorToString(purgeErr)}`);
      try {
        return this.read().sort((a, b) => (a.startedAt > b.startedAt ? -1 : 1));
      } catch {
        return [];
      }
    }
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

  /**
   * Update the Claude session ID (extracted from transcript after startup).
   * Returns the updated record (already in memory from the read-modify-write) so
   * callers that mirror the binding elsewhere don't need a second disk read — a
   * separate read could race a concurrent purgeStale() and observe a null record
   * mid-rotation (#577). Returns null when no record exists (a no-op, as before).
   */
  updateClaudeSessionId(remiSessionId: UUID, claudeSessionId: string): StoredSession | null {
    const sessions = this.read();
    const session = sessions.find((s) => s.remiSessionId === remiSessionId);
    if (session) {
      session.claudeSessionId = claudeSessionId;
      this.write(sessions);
      return session;
    }
    return null;
  }
}
