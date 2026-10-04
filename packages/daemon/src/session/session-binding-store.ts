/**
 * SessionBindingStore — the single typed accessor for the durable session binding
 * (remiUUID <-> claudeSessionId) persisted in sessions.json.
 *
 * Epic #453 phase 2. Today the binding is read/written from ~12 scattered sites and
 * the two resume resolvers read it independently (and can diverge after a rotation).
 * This facade consolidates the binding surface so every reader/writer goes through
 * one auditable API, and gives phase-3's TranscriptBinder a single binding dependency.
 *
 * NO CACHE — deliberately. It delegates straight to the stateless SessionStore
 * (fs.readFileSync on every findBy* call), so every read stays disk-fresh and the
 * accessor is behavior-identical to today's direct SessionStore calls. The phase-2
 * adversarial review showed a write-through in-memory copy would reintroduce #321
 * (a cached claudeSessionId wedging classify) and break the #430 "re-adopt on
 * rotation" characterization test, because today's cross-process freshness comes
 * precisely from SessionStore being stateless. The cost of a readFileSync on a
 * <100-entry JSON is microseconds; binding reads are not a hot path. (Design §3.2 v3.)
 *
 * Scope: the durable binding ONLY. Liveness (pid/childPid/claudeChildExited) stays in
 * SessionRegistryFile; transcriptPath has no disk column today (a phase-3 concern).
 */

import { errorToString } from '@remi/shared';
import type { HarnessId, SessionIdentity, UUID } from '@remi/shared';

import { log } from '../cli/logger.ts';
import { identityOfRecord, isClaudeRecord } from './session-store.ts';
import type { SessionStore, StoredSession } from './session-store.ts';
import type { TranscriptIndex } from './transcript-index.ts';

export interface SessionBinding {
  /**
   * For a Claude record this column is the single source of the harness
   * identity (ADR 0032); `harness` and `harnessSessionId` are never consulted
   * for Claude.
   */
  claudeSessionId: string | null;
}

export class SessionBindingStore {
  /**
   * Optional durable mirror (#577). Every binding write (preAssign + update)
   * also records {remiUUID -> claudeSessionId, projectPath} here so the
   * transcript handler can rebuild an old session's on-disk path after
   * sessions.json purges it. Co-located on the single binding accessor so a
   * rotation that updates the binding can never forget to refresh the index.
   */
  constructor(
    private readonly store: SessionStore,
    private readonly transcriptIndex?: TranscriptIndex,
  ) {}

  /**
   * Current durable binding for this Remi session, or null when no record exists.
   * Disk-backed every call (no cache) so a sibling/rotation write is always observed
   * (#321/#430). Returns an object iff the record exists — exactly mirroring
   * `findByRemiSessionId(id)?.claudeSessionId`: a record present with a null binding
   * yields `{ claudeSessionId: null }`, an absent record yields `null`. Callers that
   * want the id keep using `?.claudeSessionId`, so the substitution is behavior-identical.
   */
  get(remiSessionId: UUID): SessionBinding | null {
    const stored = this.store.findByRemiSessionId(remiSessionId);
    return stored ? { claudeSessionId: stored.claudeSessionId } : null;
  }

  /**
   * The harness-neutral identity of this Remi session (#1162, ADR 0032), or
   * null when no record exists OR the record names a harness this build does
   * not know. `get()` is deliberately not widened: it keeps returning exactly
   * `{ claudeSessionId }`, and every existing caller is untouched.
   *
   * Derived, never cached (same no-cache rule as `get()`): a record with no
   * `harness` is a Claude record, and so is one that names `claude`, whose id
   * is ALWAYS the `claudeSessionId` column. The two cannot disagree after a
   * rotation (`update()` writes only that column), because for Claude the
   * stored `harnessSessionId` is never read. A record naming another known
   * harness reports its stored `harnessSessionId`, or null when it has none
   * yet. An unrecognized `harness` string is null rather than a guess, so a
   * caller never treats a newer daemon's record that names its harness as a
   * string as Claude. A non-string `harness` never reaches here: the parser
   * treats it as absent, so it reads as Claude (ADR 0032, decision 5).
   *
   * The session list's decoration and every question emission call it (#1179).
   */
  getIdentity(remiSessionId: UUID): SessionIdentity | null {
    const stored = this.store.findByRemiSessionId(remiSessionId);
    return stored ? identityOfRecord(stored) : null;
  }

  /** Reverse lookup: the full record bound to a Claude session id (disk-backed). */
  getByClaudeSessionId(claudeSessionId: string): StoredSession | null {
    return this.store.findByClaudeSessionId(claudeSessionId);
  }

  /**
   * The port recorded for this remi session at spawn time (#672). Written once
   * by `preAssign` and never refreshed on a later daemon restart, so it stays
   * fixed at whatever port was live when the session was created — unlike the
   * live `currentPort()`, which can drift to a different port after a restart
   * (port-selection #146). Callers use this as a fallback ownership signal when
   * a transcript's `remi:<port>` marker no longer matches the live port: the
   * marker may still match the port THIS session originally ran on.
   */
  getStoredPort(remiSessionId: UUID): number | null {
    return this.store.findByRemiSessionId(remiSessionId)?.port ?? null;
  }

  /**
   * Update the durable binding on rotation / first discovery. Delegates to
   * SessionStore.updateClaudeSessionId (a no-op when the record is absent, matching
   * today). Together with preAssign, the ONLY claudeSessionId writer. Throws for
   * a record of another harness (#1176), before the transcript index is touched.
   */
  update(remiSessionId: UUID, claudeSessionId: string): void {
    const updated = this.store.updateClaudeSessionId(remiSessionId, claudeSessionId);
    // Refresh the durable mirror with the (possibly rotated) claude id so a
    // later transcript load resolves the CURRENT transcript, not a stale one.
    // Mirror from the SAME record the write produced — a second
    // findByRemiSessionId read could race a concurrent purgeStale() and observe
    // a null record, leaving the index pinned to the pre-rotation id (#577).
    if (updated) {
      this.transcriptIndex?.record(remiSessionId, claudeSessionId, updated.projectPath);
    }
  }

  /**
   * Record a non-Claude harness's own session id (#1176): first discovery, or
   * a rotation. The counterpart of `update()` for a record that names its
   * harness. A no-op when the record is absent, like `update()`. It does not
   * touch the transcript index, which maps a Claude id to a Claude transcript;
   * a non-Claude harness has no entry there.
   *
   * The Codex launch (#1177) records the thread id with it, once the app-server
   * names one. It purges first: a record whose process died without exiting
   * cleanly still counts as an active holder of its thread id until a purge
   * marks it exited, and would make this write refuse a thread that is free.
   */
  updateHarnessIdentity(
    remiSessionId: UUID,
    harness: Exclude<HarnessId, 'claude'>,
    harnessSessionId: string,
  ): void {
    this.purgeBeforeIdentity();
    this.store.updateHarnessIdentity(remiSessionId, harness, harnessSessionId);
  }

  /**
   * Mark records of dead processes exited before an identity is recorded, as
   * `store.list()` does for Claude's `--resume`. Best effort: a purge that
   * fails (a lock timeout) must not stop the write that follows, which fails
   * on its own if the store is really unavailable.
   */
  private purgeBeforeIdentity(): void {
    try {
      this.store.purgeStale();
    } catch (err) {
      log(`[sessions] purge before recording a harness identity failed: ${errorToString(err)}`);
    }
  }

  /**
   * Pre-spawn deterministic assignment: persist the full session record. Takes the
   * whole StoredSession (not just the binding) because save() creates the row,
   * including the liveness fields (pid/port/exitedAt) which are the CALLER's
   * responsibility to populate correctly — the accessor does not own them.
   */
  preAssign(session: StoredSession): void {
    // A non-Claude record that names its thread id up front (a Codex resume)
    // must not collide with a dead process's unpurged record of that thread.
    if (!isClaudeRecord(session) && typeof session.harnessSessionId === 'string') {
      this.purgeBeforeIdentity();
    }
    // Mirror from save()'s returned (normalized) record, not the raw input —
    // otherwise a caller passing an unnormalized projectPath would seed
    // TranscriptIndex with a value that silently diverges from what
    // SessionStore actually persisted (#680 review).
    const saved = this.store.save(session);
    // Seed the durable mirror at spawn so the binding is recoverable even if the
    // session never rotates and is later purged from sessions.json (#577).
    if (saved.claudeSessionId) {
      this.transcriptIndex?.record(saved.remiSessionId, saved.claudeSessionId, saved.projectPath);
    } else if (this.transcriptIndex && isClaudeRecord(saved)) {
      // No claude id yet (deferred to the first update() on hook adopt/rotation).
      // Log so the deferred index seed is traceable rather than silently skipped.
      // A non-Claude record never seeds this index, so there is nothing deferred
      // to trace for it (#1176).
      log(
        `[transcript-index] preAssign for ${saved.remiSessionId} has no claudeSessionId yet; index seed deferred to update()`,
      );
    }
  }
}
