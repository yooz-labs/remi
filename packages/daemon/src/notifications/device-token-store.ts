/**
 * DeviceTokenStore — the APNS device-token registry (epic #603 Phase 6, R4;
 * tombstones added #690).
 *
 * Replaces the per-daemon in-memory `Map` that was never persisted and never
 * shared, which caused two failures:
 *   - a fresh worktree daemon the phone never connected to had ZERO tokens, so
 *     its escalations could never push (a black-hole);
 *   - a dead/rotated token (BadDeviceToken / Unregistered) was never pruned, so
 *     the daemon retried it on every escalation forever.
 *
 * A device token is MACHINE-scoped consent: the shared `~/.remi/device-tokens.json`
 * keys entries by TOKEN, not by daemon/connection, so every local daemon the
 * phone has ever connected to shares the same entry. This matters for removal:
 * an earlier design remembered "removed" tokens in an IN-MEMORY-only Set, which
 * broke with more than one daemon sharing the file (#690, reviewer-verified with
 * a two-instance script):
 *   - RESURRECTION: daemon A removes a token; daemon B still holds it in memory
 *     (adopted earlier) and writes it right back on its next unrelated persist().
 *   - REGRESSION: daemon B restarts after A's write emptied the file and comes
 *     up with the token gone, even for machines/servers the user never removed.
 *
 * This store instead persists TOMBSTONES `{token, removedAt}` alongside the live
 * `tokens` list. `unregister`/`prune` always write a tombstone (whether or not
 * this instance currently holds the token); `register` always clears one (a
 * fresh registration is inherently newer). On every load/persist/refresh, the
 * fresher timestamp wins per token: a registration newer than its tombstone
 * clears the tombstone; a tombstone newer than (or equal to) the registration
 * drops the token — regardless of which daemon originally wrote either side.
 * This is what lets an explicit removal on one daemon propagate to every other
 * daemon sharing the file, while a still-wanted server's fresh re-registration
 * (see the web client's handleDisconnect) reliably outraces a sibling server's
 * tombstone for the SAME shared token.
 *
 * Old-format files (no `tombstones` key) load fine (treated as no tombstones).
 * Tombstones older than 30 days are garbage-collected on every write.
 *
 * Writes are atomic via a per-pid `.tmp` + rename (#461 pattern).
 */

import * as fs from 'node:fs';

import type { DeviceTokenEntry } from '../cli/handlers/trivial-events.ts';
import { log, logError } from '../cli/logger.ts';

/** A tombstone recording that `token` was explicitly removed at `removedAt`
 *  (epoch ms). Persisted so the removal is visible to every daemon sharing
 *  the file, not just the one that recorded it in memory. */
interface StoredTombstone {
  token: string;
  removedAt: number;
}

/** Tombstones older than this are dropped on write; nothing should need one
 *  this stale (a token this old would have rotated or been re-registered). */
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Strictly-increasing timestamp for `registeredAt` / `removedAt` (#690).
 * `Date.now()`'s millisecond resolution can tie two calls made back to back
 * in the same synchronous run (e.g. a rotation-prune's tombstone immediately
 * followed by re-adopting the rotated-out token's OLDER on-disk copy during
 * the SAME persist(), or an unregister immediately followed by a re-register
 * for the same token). `reconcile`'s tie-break (entry wins on an exact tie,
 * so a genuine re-registration is never defeated by its own just-written
 * tombstone) then cannot tell "genuinely simultaneous" apart from "this one
 * actually happened after that one" — and within one process, operations are
 * always strictly ordered. Monotonically bumping resolves that ambiguity by
 * construction: whichever call happens later always gets a strictly larger
 * value, matching real call order instead of colliding on the clock's
 * resolution.
 */
let lastTimestamp = 0;
function monotonicNow(): number {
  const now = Date.now();
  lastTimestamp = now > lastTimestamp ? now : lastTimestamp + 1;
  return lastTimestamp;
}

function isValidEntry(e: unknown): e is DeviceTokenEntry {
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as DeviceTokenEntry).token === 'string' &&
    (e as DeviceTokenEntry).token.length > 0 &&
    typeof (e as DeviceTokenEntry).platform === 'string' &&
    typeof (e as DeviceTokenEntry).connectionId === 'string'
  );
}

function isValidTombstone(t: unknown): t is StoredTombstone {
  return (
    typeof t === 'object' &&
    t !== null &&
    typeof (t as StoredTombstone).token === 'string' &&
    (t as StoredTombstone).token.length > 0 &&
    typeof (t as StoredTombstone).removedAt === 'number'
  );
}

export class DeviceTokenStore {
  private readonly tokens = new Map<string, DeviceTokenEntry>();
  /** token -> removedAt (epoch ms). See class doc for the merge/reconcile rules. */
  private readonly tombstones = new Map<string, number>();

  constructor(private readonly filePath: string) {}

  /** The live in-memory map. Stable reference — mutated in place, never replaced. */
  get map(): Map<string, DeviceTokenEntry> {
    return this.tokens;
  }

  get size(): number {
    return this.tokens.size;
  }

  /** Load the persisted registry into memory. Tolerant of a missing/corrupt file
   *  (starts empty). Call once at daemon start. */
  load(): void {
    const { tokens, tombstones } = this.readFile();
    for (const e of tokens) this.tokens.set(e.token, e);
    for (const t of tombstones) this.tombstones.set(t.token, t.removedAt);
    this.reconcile();
    if (this.tokens.size > 0) {
      log(`[DeviceTokens] Loaded ${this.tokens.size} persisted device token(s)`);
    }
  }

  /**
   * Pull in whatever another daemon on this machine has written since this
   * store last read the file, and reconcile — WITHOUT writing back (#690).
   * Cheap (one JSON read); meant to be called right before a push decision so
   * a removal recorded by a sibling daemon is visible immediately, instead of
   * waiting for this daemon's own next register/prune call to persist(). A
   * read error is a no-op: in-memory state stays authoritative for this
   * process either way.
   */
  refreshFromDisk(): void {
    try {
      const { tokens, tombstones } = this.readFile();
      this.mergeForeign(tokens, tombstones);
      this.reconcile();
    } catch {
      // Best-effort refresh; swallow and keep current in-memory state.
    }
  }

  /**
   * Register (or refresh) a device token. Mirrors the prior #585 rotation prune:
   * a re-registration from the SAME connection drops any OTHER token that
   * connection previously registered (APNS token rotation) — tombstoning the
   * rotated-out token so siblings drop it too. Persists.
   */
  register(token: string, platform: string, connectionId: string): void {
    for (const [existingToken, entry] of this.tokens) {
      if (existingToken !== token && entry.connectionId === connectionId) {
        this.tokens.delete(existingToken);
        this.tombstones.set(existingToken, monotonicNow());
        log(
          `[DeviceTokens] Pruned stale token from ${connectionId} (rotated): ${existingToken.slice(0, 20)}...`,
        );
      }
    }
    this.tokens.set(token, { token, platform, registeredAt: monotonicNow(), connectionId });
    // A fresh registration is always newer than any prior tombstone for it.
    this.tombstones.delete(token);
    this.persist();
  }

  /**
   * Prune a dead token (permanent APNS rejection). Self-healing: the daemon stops
   * retrying it. Always tombstones (even if this instance did not hold the
   * token locally) so the removal reaches every daemon sharing the file on
   * their next merge/refresh. Returns true iff the token was present here.
   */
  prune(token: string, reason: string): boolean {
    const had = this.tokens.delete(token);
    this.tombstones.set(token, monotonicNow());
    if (had) {
      log(`[DeviceTokens] Pruned dead token (${reason}): ${token.slice(0, 20)}...`);
    }
    this.persist();
    return had;
  }

  /**
   * Unregister a token on explicit user removal (#690) — the user removed this
   * server/machine from the phone app. Same semantics as `prune` (always
   * tombstones, whether or not this instance held the token), distinct log
   * reason. Does NOT fire on mere disconnect/app suspension; push-while-
   * suspended must keep working, so tokens persist across those. Returns true
   * iff the token was present here.
   */
  unregister(token: string): boolean {
    const had = this.tokens.delete(token);
    this.tombstones.set(token, monotonicNow());
    if (had) {
      log(`[DeviceTokens] Unregistered by device: ${token.slice(0, 20)}...`);
    }
    this.persist();
    return had;
  }

  /**
   * Union foreign tombstones (max removedAt wins) and adopt any foreign token
   * entry this store does not already hold. A foreign tombstone that a
   * CURRENTLY-HELD local entry already supersedes (registeredAt >= removedAt)
   * is skipped entirely rather than merged in: without this, a same-tick
   * register() -> persist() (the two calls run back to back with no time for
   * a sibling to observe the cleared tombstone first) would read back its own
   * stale on-disk tombstone here and hand it straight to `reconcile`, which on
   * an exact-millisecond tie could re-drop the token it was just told to keep.
   * Adopting a stale foreign TOKEN this store does not hold is fine to leave
   * to `reconcile` (always run immediately after this): if this store already
   * holds a newer tombstone for it, reconcile drops it right back out.
   */
  private mergeForeign(
    foreignTokens: DeviceTokenEntry[],
    foreignTombstones: StoredTombstone[],
  ): void {
    for (const t of foreignTombstones) {
      const entry = this.tokens.get(t.token);
      if (entry && entry.registeredAt >= t.removedAt) continue;
      const existing = this.tombstones.get(t.token) ?? 0;
      if (t.removedAt > existing) this.tombstones.set(t.token, t.removedAt);
    }
    for (const e of foreignTokens) {
      if (!this.tokens.has(e.token)) this.tokens.set(e.token, e);
    }
  }

  /**
   * The fresher timestamp wins for any token known to both maps, regardless of
   * which daemon originally wrote either side (#690): a registration AT OR
   * AFTER its tombstone's removedAt clears the tombstone (a re-registration
   * anywhere un-removes a token — ties go to the registration, since it is an
   * explicit action and `register()` has already cleared its own tombstone in
   * memory before persist() ever re-reads a stale on-disk copy of it); a
   * tombstone strictly newer than the registration drops the token entry (a
   * removal anywhere propagates here). Run after every merge (load/refresh/
   * persist) so this store's own long-held entries are re-checked against a
   * newly-arrived sibling tombstone, not just newly-adopted ones.
   */
  private reconcile(): void {
    for (const [token, removedAt] of this.tombstones) {
      const entry = this.tokens.get(token);
      if (!entry) continue;
      if (entry.registeredAt >= removedAt) {
        this.tombstones.delete(token);
      } else {
        this.tokens.delete(token);
      }
    }
  }

  private gcTombstones(): void {
    const cutoff = Date.now() - TOMBSTONE_TTL_MS;
    for (const [token, removedAt] of this.tombstones) {
      if (removedAt < cutoff) this.tombstones.delete(token);
    }
  }

  private readFile(): { tokens: DeviceTokenEntry[]; tombstones: StoredTombstone[] } {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      const tokenList = (parsed as { tokens?: unknown })?.tokens;
      const tombstoneList = (parsed as { tombstones?: unknown })?.tombstones;
      return {
        tokens: Array.isArray(tokenList) ? tokenList.filter(isValidEntry) : [],
        // Absent on an old-format file (pre-#690) -> no tombstones, loads fine.
        tombstones: Array.isArray(tombstoneList) ? tombstoneList.filter(isValidTombstone) : [],
      };
    } catch {
      // Missing or corrupt -> treat as empty; the file is rebuilt on the next write.
    }
    return { tokens: [], tombstones: [] };
  }

  /** Read-merge, reconcile, GC, then atomic write. See class doc for why this
   *  reconciles against tombstones/entries this store did not itself just
   *  write, not only against freshly-adopted foreign data. */
  private persist(): void {
    try {
      const { tokens, tombstones } = this.readFile();
      this.mergeForeign(tokens, tombstones);
      this.reconcile();
      this.gcTombstones();
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      fs.writeFileSync(
        tmp,
        JSON.stringify({
          tokens: [...this.tokens.values()],
          tombstones: [...this.tombstones.entries()].map(([token, removedAt]) => ({
            token,
            removedAt,
          })),
        }),
      );
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      // Persistence is best-effort: the in-memory map is still authoritative for
      // this process, so a write failure must not break push delivery.
      logError(`[DeviceTokens] Failed to persist registry: ${err}`);
    }
  }
}
