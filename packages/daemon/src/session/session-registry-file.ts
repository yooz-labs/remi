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
}

/** Default port range for auto-selection. */
export const DEFAULT_BASE_PORT = 18765;
export const DEFAULT_PORT_RANGE = 10;

export class SessionRegistryFile {
  private readonly dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? LIVE_SESSIONS_DIR;
  }

  /** Ensure the live-sessions directory exists. */
  private ensureDir(): void {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
  }

  /** Register a live session (atomic write). */
  register(entry: LiveSessionEntry): void {
    this.ensureDir();
    const filePath = path.join(this.dir, `${entry.sessionId}.json`);
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(entry, null, 2), 'utf-8');
    fs.renameSync(tmpPath, filePath);
  }

  /** Unregister a session (delete its file). */
  unregister(sessionId: string): void {
    const filePath = path.join(this.dir, `${sessionId}.json`);
    try {
      fs.unlinkSync(filePath);
    } catch {
      // File may already be removed
    }
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
    } catch {
      return [];
    }

    for (const fileName of dirEntries) {
      if (!fileName.endsWith('.json') || fileName.endsWith('.tmp')) continue;

      const filePath = path.join(this.dir, fileName);
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const entry = JSON.parse(raw) as LiveSessionEntry;

        if (!entry.sessionId || !entry.pid || !entry.wsPort) continue;

        if (isProcessAlive(entry.pid)) {
          entries.push(entry);
        } else {
          // Stale entry; clean up
          try {
            fs.unlinkSync(filePath);
          } catch {
            // Ignore cleanup errors
          }
        }
      } catch {
        // Corrupt or unreadable file; skip
      }
    }

    entries.sort((a, b) => (a.startedAt > b.startedAt ? -1 : 1));
    return entries;
  }

  /**
   * Find the first available port in the given range.
   * Checks live entries to avoid conflicts.
   * Returns null if all ports are exhausted.
   */
  findAvailablePort(
    basePort: number = DEFAULT_BASE_PORT,
    range: number = DEFAULT_PORT_RANGE,
  ): number | null {
    const live = this.listLive();
    const usedPorts = new Set(live.map((e) => e.wsPort));

    for (let offset = 0; offset < range; offset++) {
      const candidate = basePort + offset;
      if (!usedPorts.has(candidate)) {
        return candidate;
      }
    }

    return null;
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

/** Check if a process is alive by sending signal 0. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
