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

import type { SessionStore, StoredSession } from './session-store.ts';

export interface SessionBinding {
  claudeSessionId: string | null;
}

export class SessionBindingStore {
  constructor(private readonly store: SessionStore) {}

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
    this.store.updateClaudeSessionId(remiSessionId, claudeSessionId);
  }

  /** Pre-spawn deterministic assignment: persist the full session record. */
  preAssign(session: StoredSession): void {
    this.store.save(session);
  }
}
