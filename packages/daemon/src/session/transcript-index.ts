/**
 * TranscriptIndex — a durable, append-only remiUUID -> {claudeSessionId,
 * projectPath} map persisted at ~/.remi/transcript-index.json.
 *
 * Phase 6 (#577). The `remiUUID <-> claudeSessionId` binding lives in
 * sessions.json (SessionStore), but that store is bounded two ways that both
 * lose old bindings: MAX_SESSIONS=100 trims the oldest exited rows, and
 * STALE_AGE_MS=7d purges exited rows. For a user running Claude across many
 * worktrees the 100-entry cap fills fast, so a transcript_load_request for an
 * older session resolves to nothing and returns NOT_FOUND ("Transcript for
 * session <id> not found").
 *
 * This index decouples binding durability from the liveness store: it is NOT
 * subject to the 100-entry cap and uses a much longer TTL (90 days). It stores
 * only what the transcript handler needs to RECONSTRUCT the on-disk path
 * (claudeSessionId + projectPath, fed through TranscriptDiscovery's
 * deterministic encoding) — no liveness, no pid, no port churn.
 *
 * Atomic writes use the same per-process `.<pid>.tmp` pattern as SessionStore
 * (#461) so two daemons sharing ~/.remi never race on a shared tmp path.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { errorToString } from '@remi/shared';
import type { UUID } from '@remi/shared';
import { logError } from '../cli/logger.ts';

export interface TranscriptIndexEntry {
  remiSessionId: UUID;
  claudeSessionId: string;
  projectPath: string;
  /** ISO timestamp of the most recent write for this entry; drives TTL pruning. */
  updatedAt: string;
}

interface TranscriptIndexFile {
  version: 1;
  entries: TranscriptIndexEntry[];
}

const REMI_DIR = path.join(os.homedir(), '.remi');
const INDEX_FILE = path.join(REMI_DIR, 'transcript-index.json');
/** Far longer than SessionStore's 7d so old transcripts stay loadable (#577). */
const INDEX_STALE_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
/** Hard ceiling so a long-lived heavy-worktree machine cannot grow unbounded. */
const DEFAULT_MAX_INDEX_ENTRIES = 2000;

export class TranscriptIndex {
  private filePath: string;
  private maxEntries: number;

  /** `maxEntries` is overridable for tests; production uses the 2000 default. */
  constructor(filePath?: string, maxEntries: number = DEFAULT_MAX_INDEX_ENTRIES) {
    this.filePath = filePath ?? INDEX_FILE;
    this.maxEntries = maxEntries;
  }

  private ensureDir(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /** Read the index, returning [] on a missing/corrupt file (never throws on parse). */
  private read(): TranscriptIndexEntry[] {
    if (!fs.existsSync(this.filePath)) return [];
    const raw = fs.readFileSync(this.filePath, 'utf-8');
    try {
      const data = JSON.parse(raw) as TranscriptIndexFile;
      if (data.version !== 1 || !Array.isArray(data.entries)) {
        // A future-version or malformed index is discarded, not merged. Log it
        // so the silent drop is visible (a recovery index must be debuggable);
        // an unknown version usually means a newer daemon wrote this file.
        logError(
          `[transcript-index] Ignoring index with unexpected shape (version=${String(
            (data as { version?: unknown }).version,
          )}); recovery lookups will miss until it is rewritten`,
        );
        return [];
      }
      return data.entries;
    } catch (err) {
      if (!(err instanceof SyntaxError)) {
        logError(`[transcript-index] Unexpected error reading index: ${errorToString(err)}`);
      }
      return [];
    }
  }

  /** Write the index atomically (per-process tmp + rename), same as SessionStore (#461). */
  private write(entries: TranscriptIndexEntry[]): void {
    this.ensureDir();
    const data: TranscriptIndexFile = { version: 1, entries };
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    try {
      fs.renameSync(tmpPath, this.filePath);
    } catch (err) {
      try {
        fs.rmSync(tmpPath, { force: true });
      } catch {
        // best-effort cleanup; surface the original error
      }
      throw err;
    }
  }

  /** Parse updatedAt to epoch ms; NaN (unparseable) becomes 0 = oldest. */
  private static updatedAtMs(entry: TranscriptIndexEntry): number {
    const t = new Date(entry.updatedAt).getTime();
    return Number.isNaN(t) ? 0 : t;
  }

  /** Drop entries older than the TTL, then trim oldest if over the hard cap. */
  private prune(entries: TranscriptIndexEntry[]): TranscriptIndexEntry[] {
    const now = Date.now();
    let sawBadTimestamp = false;
    let kept = entries.filter((e) => {
      const t = new Date(e.updatedAt).getTime();
      if (Number.isNaN(t)) {
        // Keep on NaN here (conservative: never TTL-drop on bad data alone), but
        // flag it so the cap step below treats it as oldest and trims it first.
        sawBadTimestamp = true;
        return true;
      }
      return now - t < INDEX_STALE_AGE_MS;
    });
    if (sawBadTimestamp) {
      logError(
        '[transcript-index] Found entry with unparseable updatedAt; treating as oldest for cap trimming',
      );
    }
    if (kept.length > this.maxEntries) {
      // Sort numerically with NaN -> 0 (oldest). A string compare here would
      // sort a NaN/garbage timestamp to the FRONT and the cap would then trim
      // the NEWEST valid entries first, looping forever on a bad file (#577).
      kept = [...kept]
        .sort((a, b) => TranscriptIndex.updatedAtMs(a) - TranscriptIndex.updatedAtMs(b))
        .slice(kept.length - this.maxEntries);
    }
    return kept;
  }

  /**
   * Record (or refresh) the binding for a session. Upserts by remiSessionId and
   * bumps updatedAt; prunes stale/overflow entries on every write so the file
   * self-maintains. Fails soft: a disk error is logged, not thrown, so a
   * persistence hiccup never aborts session creation (the index is an
   * optimization on top of sessions.json, not the authority).
   */
  record(remiSessionId: UUID, claudeSessionId: string, projectPath: string): void {
    try {
      const entries = this.read();
      const idx = entries.findIndex((e) => e.remiSessionId === remiSessionId);
      const entry: TranscriptIndexEntry = {
        remiSessionId,
        claudeSessionId,
        projectPath,
        updatedAt: new Date().toISOString(),
      };
      if (idx >= 0) {
        entries[idx] = entry;
      } else {
        entries.push(entry);
      }
      this.write(this.prune(entries));
    } catch (err) {
      logError(
        `[transcript-index] Failed to record binding for ${remiSessionId}: ${errorToString(err)}`,
      );
    }
  }

  /** Resolve a remi session id to its durable binding, or null. Never throws. */
  get(remiSessionId: UUID): TranscriptIndexEntry | null {
    try {
      const entries = this.read();
      return entries.find((e) => e.remiSessionId === remiSessionId) ?? null;
    } catch (err) {
      logError(
        `[transcript-index] Failed to read binding for ${remiSessionId}: ${errorToString(err)}`,
      );
      return null;
    }
  }
}
