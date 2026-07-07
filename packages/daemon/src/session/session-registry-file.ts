/**
 * SessionRegistryFile - File-based registry for live remi sessions.
 *
 * Each remi wrapper process writes a JSON file to ~/.remi/live-sessions/<session-id>.json
 * so that `remi ls` and `remi attach` can discover all running sessions across
 * multiple remi processes (each on a different port).
 *
 * Stale entries (from crashed processes) are detected via PID liveness checks.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DAEMON_BASE_PORT, DAEMON_PORT_RANGE, errorToString } from '@remi/shared';
import { normalizeProjectPath } from '../cli/path-resolver.ts';
import { findAvailableTcpPort } from './port-utils.ts';
import { isProcessAlive } from './process-alive.ts';

const REMI_DIR = path.join(os.homedir(), '.remi');
const LIVE_SESSIONS_DIR = path.join(REMI_DIR, 'live-sessions');

/** A live session entry written by each remi wrapper process. */
export interface LiveSessionEntry {
  readonly sessionId: string;
  readonly pid: number;
  readonly wsPort: number;
  readonly hookPort: number;
  readonly projectPath: string;
  readonly name: string;
  readonly startedAt: string;
  /**
   * OS pid of the spawned `claude` child, recorded once the PTY starts.
   * Absent on legacy entries and during the pre-spawn registration window.
   * Lets co-located daemons tell a live sibling from a zombie (daemon
   * process alive, its Claude long dead) — see {@link claudeChildLooksAlive}.
   */
  readonly claudeChildPid?: number;
  /**
   * Set true when the Claude child exits while the daemon keeps running.
   * Distinguishes "known dead" (recycle-proof: never reconsidered live even
   * if the OS reassigns the old pid) from "unknown" (field absent ⇒ treated
   * as live, the fail-safe for legacy entries).
   */
  readonly claudeChildExited?: boolean;
}

/**
 * Whether a registry entry's Claude child should be treated as a live sibling.
 *
 * Fail-safe by design: an entry with no recorded child pid (legacy writer, or
 * the pre-spawn window) counts as live so we never drop a guard we cannot
 * disprove. A child explicitly marked exited is permanently dead (pid-reuse
 * proof); otherwise we probe the recorded pid.
 */
export function claudeChildLooksAlive(entry: LiveSessionEntry): boolean {
  if (entry.claudeChildExited === true) return false;
  if (entry.claudeChildPid === undefined) return true;
  return isProcessAlive(entry.claudeChildPid);
}

/** Default port range for auto-selection (single source of truth in @remi/shared). */
export const DEFAULT_BASE_PORT = DAEMON_BASE_PORT;
export const DEFAULT_PORT_RANGE = DAEMON_PORT_RANGE;

/** Type guard for LiveSessionEntry after JSON.parse. */
function isValidEntry(data: unknown): data is LiveSessionEntry {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  const childPid = obj['claudeChildPid'];
  const childPidOk =
    childPid === undefined ||
    (typeof childPid === 'number' && Number.isInteger(childPid) && childPid > 0);
  const childExited = obj['claudeChildExited'];
  const childExitedOk = childExited === undefined || typeof childExited === 'boolean';
  return (
    typeof obj['sessionId'] === 'string' &&
    obj['sessionId'].length > 0 &&
    typeof obj['pid'] === 'number' &&
    obj['pid'] > 0 &&
    typeof obj['wsPort'] === 'number' &&
    obj['wsPort'] > 0 &&
    obj['wsPort'] <= 65535 &&
    childPidOk &&
    childExitedOk
  );
}

export class SessionRegistryFile {
  private readonly dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? LIVE_SESSIONS_DIR;
  }

  /** Path to the live-sessions directory. */
  get dirPath(): string {
    return this.dir;
  }

  /** Ensure the live-sessions directory exists. */
  private ensureDir(): void {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
  }

  /**
   * Register a live session (atomic write). Normalizes `projectPath` (expands
   * `~`, resolves to absolute) before persisting so a caller passing a raw,
   * unexpanded path never writes a malformed entry (#674). Since `patchEntry`
   * round-trips through this method, an on-disk entry that still carries a raw
   * `~` also gets normalized the next time it's patched — but a value already
   * mangled into an unrecoverable shape (e.g. a `~` concatenated mid-string
   * onto another absolute path) cannot be un-concatenated after the fact; only
   * preventing the write in the first place fixes that case.
   */
  register(entry: LiveSessionEntry): void {
    this.ensureDir();
    const normalized: LiveSessionEntry = {
      ...entry,
      projectPath: normalizeProjectPath(entry.projectPath),
    };
    const filePath = path.join(this.dir, `${entry.sessionId}.json`);
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(normalized, null, 2), 'utf-8');
    fs.renameSync(tmpPath, filePath);
  }

  /** Unregister a session (delete its file). */
  unregister(sessionId: string): void {
    const filePath = path.join(this.dir, `${sessionId}.json`);
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        console.error(`[live-sessions] Failed to unregister ${sessionId}: ${errorToString(err)}`);
      }
    }
  }

  /**
   * Merge fields into an existing entry, preserving everything else (notably
   * startedAt). No-op if the entry is gone. Best-effort: enumeration/parse
   * failures are swallowed so a registry hiccup never propagates into the
   * spawn or PTY-exit path.
   */
  private patchEntry(sessionId: string, patch: Partial<LiveSessionEntry>): void {
    const filePath = path.join(this.dir, `${sessionId}.json`);
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data: unknown = JSON.parse(raw);
      if (!isValidEntry(data)) {
        // The on-disk entry is malformed (e.g. a torn write). Skipping the
        // patch silently would disable the zombie guard for this session with
        // no trace; surface it (listLive will reap the bad entry separately).
        console.error(`[live-sessions] Cannot patch ${sessionId}: existing entry is invalid`);
        return;
      }
      this.register({ ...data, ...patch });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return; // entry already gone
      console.error(`[live-sessions] Failed to patch ${sessionId}: ${errorToString(err)}`);
    }
  }

  /** Record the Claude child pid once the PTY has spawned. */
  setClaudeChildPid(sessionId: string, claudeChildPid: number): void {
    this.patchEntry(sessionId, { claudeChildPid, claudeChildExited: false });
  }

  /**
   * Mark the Claude child as exited while keeping the daemon entry (the
   * daemon process is still alive and must remain discoverable for
   * `remi ls`/attach/resume). Recycle-proof: the entry is never reconsidered
   * a live sibling regardless of pid reassignment.
   */
  markClaudeChildExited(sessionId: string): void {
    this.patchEntry(sessionId, { claudeChildExited: true });
  }

  /**
   * List all live sessions, removing stale entries (dead PIDs).
   * Returns entries sorted by startedAt (most recent first).
   */
  listLive(): LiveSessionEntry[] {
    if (!fs.existsSync(this.dir)) {
      return [];
    }

    const entries: LiveSessionEntry[] = [];
    let dirEntries: string[];
    try {
      dirEntries = fs.readdirSync(this.dir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        console.error(`[live-sessions] Cannot read directory ${this.dir}: ${errorToString(err)}`);
      }
      return [];
    }

    for (const fileName of dirEntries) {
      if (!fileName.endsWith('.json') || fileName.endsWith('.tmp')) continue;

      const filePath = path.join(this.dir, fileName);
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const data: unknown = JSON.parse(raw);

        if (!isValidEntry(data)) {
          console.error(`[live-sessions] Invalid entry in ${fileName}, removing`);
          try {
            fs.unlinkSync(filePath);
          } catch {
            // best-effort cleanup
          }
          continue;
        }

        if (isProcessAlive(data.pid)) {
          entries.push(data);
        } else {
          // Stale entry; clean up
          try {
            fs.unlinkSync(filePath);
          } catch (cleanupErr) {
            const code = (cleanupErr as NodeJS.ErrnoException).code;
            if (code !== 'ENOENT') {
              console.error(
                `[live-sessions] Failed to remove stale entry ${fileName}: ${errorToString(cleanupErr)}`,
              );
            }
          }
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') continue; // file removed between readdir and read
        if (err instanceof SyntaxError) {
          // Corrupt JSON; remove the invalid file
          console.error(`[live-sessions] Corrupt JSON in ${fileName}, removing`);
          try {
            fs.unlinkSync(filePath);
          } catch {
            // best-effort cleanup
          }
          continue;
        }
        console.error(`[live-sessions] Failed to read ${fileName}: ${errorToString(err)}`);
      }
    }

    entries.sort((a, b) => (a.startedAt > b.startedAt ? -1 : 1));
    return entries;
  }

  /**
   * Find the first available port in the given range.
   * Combines file-registry check (skip known sessions) with real TCP
   * bind-probe (detect ports occupied by non-remi processes).
   * Returns null if all ports are exhausted.
   */
  async findAvailablePort(
    basePort: number = DEFAULT_BASE_PORT,
    range: number = DEFAULT_PORT_RANGE,
  ): Promise<number | null> {
    const live = this.listLive();
    const usedPorts = new Set(live.map((e) => e.wsPort));
    return findAvailableTcpPort(basePort, range, usedPorts);
  }

  /** Find a live session by session ID. */
  findBySessionId(sessionId: string): LiveSessionEntry | null {
    const live = this.listLive();
    return live.find((e) => e.sessionId === sessionId) ?? null;
  }

  /** Find a live session by name (exact or prefix match). */
  findByName(name: string): LiveSessionEntry | null {
    const live = this.listLive();

    // Exact match first
    const exact = live.find((e) => e.name === name);
    if (exact) return exact;

    // Prefix match (only if unambiguous)
    const prefixMatches = live.filter((e) => e.name.startsWith(name));
    if (prefixMatches.length === 1) return prefixMatches[0]!;

    return null;
  }

  /** Get unique wsPort values from all live sessions. */
  getLivePorts(): number[] {
    const live = this.listLive();
    return [...new Set(live.map((e) => e.wsPort))];
  }
}
