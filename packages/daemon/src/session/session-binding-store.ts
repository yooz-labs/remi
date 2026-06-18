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

import type { UUID } from '@remi/shared';

import { log } from '../cli/logger.ts';
import type { SessionStore, StoredSession } from './session-store.ts';
import type { TranscriptIndex } from './transcript-index.ts';

export interface SessionBinding {
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

  /** Reverse lookup: the full record bound to a Claude session id (disk-backed). */
  getByClaudeSessionId(claudeSessionId: string): StoredSession | null {
    return this.store.findByClaudeSessionId(claudeSessionId);
  }

  /**
   * Update the durable binding on rotation / first discovery. Delegates to
   * SessionStore.updateClaudeSessionId (a no-op when the record is absent, matching
   * today). Together with preAssign, the ONLY claudeSessionId writer.
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
   * Pre-spawn deterministic assignment: persist the full session record. Takes the
   * whole StoredSession (not just the binding) because save() creates the row,
   * including the liveness fields (pid/port/exitedAt) which are the CALLER's
   * responsibility to populate correctly — the accessor does not own them.
   */
  preAssign(session: StoredSession): void {
    this.store.save(session);
    // Seed the durable mirror at spawn so the binding is recoverable even if the
    // session never rotates and is later purged from sessions.json (#577).
    if (session.claudeSessionId) {
      this.transcriptIndex?.record(
        session.remiSessionId,
        session.claudeSessionId,
        session.projectPath,
      );
    } else if (this.transcriptIndex) {
      // No claude id yet (deferred to the first update() on hook adopt/rotation).
      // Log so the deferred index seed is traceable rather than silently skipped.
      log(
        `[transcript-index] preAssign for ${session.remiSessionId} has no claudeSessionId yet; index seed deferred to update()`,
      );
    }
  }
}
