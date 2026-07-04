/**
 * DeviceTokenStore — the APNS device-token registry (epic #603 Phase 6, R4).
 *
 * Replaces the per-daemon in-memory `Map` that was never persisted and never
 * shared, which caused two failures:
 *   - a fresh worktree daemon the phone never connected to had ZERO tokens, so
 *     its escalations could never push (a black-hole);
 *   - a dead/rotated token (BadDeviceToken / Unregistered) was never pruned, so
 *     the daemon retried it on every escalation forever.
 *
 * This store:
 *   - persists to a shared `~/.remi/device-tokens.json` every local daemon loads
 *     on start, so a token registered by one daemon is visible to the next;
 *   - prunes a token on a permanent APNS rejection (self-healing) and remembers
 *     it so a concurrent daemon's stale copy is not re-adopted;
 *   - writes atomically via a per-pid `.tmp` + rename (#461 pattern), and
 *     read-merges before each write so a concurrent daemon's registrations are
 *     not clobbered (last-writer-wins on the SAME token; union across tokens).
 *
 * The in-memory `map` is mutated in place (never replaced) so existing consumers
 * (the dispatcher's iteration) keep a stable reference.
 */

import * as fs from 'node:fs';

import type { DeviceTokenEntry } from '../cli/handlers/trivial-events.ts';
import { log, logError } from '../cli/logger.ts';

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

export class DeviceTokenStore {
  private readonly tokens = new Map<string, DeviceTokenEntry>();
  /** Tokens this store intentionally REMOVED this session — pruned (dead) OR
   *  rotated out. Kept so the read-merge on persist does NOT re-adopt one from
   *  the stale on-disk copy (this store wrote it before removing it). Cleared for
   *  a token if it is later re-registered. */
  private readonly removed = new Set<string>();

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
    for (const e of this.readFile()) {
      this.tokens.set(e.token, e);
    }
    if (this.tokens.size > 0) {
      log(`[DeviceTokens] Loaded ${this.tokens.size} persisted device token(s)`);
    }
  }

  /**
   * Register (or refresh) a device token. Mirrors the prior #585 rotation prune:
   * a re-registration from the SAME connection drops any OTHER token that
   * connection previously registered (APNS token rotation). Persists.
   */
  register(token: string, platform: string, connectionId: string): void {
    for (const [existingToken, entry] of this.tokens) {
      if (existingToken !== token && entry.connectionId === connectionId) {
        this.tokens.delete(existingToken);
        this.removed.add(existingToken); // do not re-adopt the rotated-out token on merge
        log(
          `[DeviceTokens] Pruned stale token from ${connectionId} (rotated): ${existingToken.slice(0, 20)}...`,
        );
      }
    }
    this.tokens.set(token, { token, platform, registeredAt: Date.now(), connectionId });
    // A token registered again is no longer considered removed.
    this.removed.delete(token);
    this.persist();
  }

  /**
   * Prune a dead token (permanent APNS rejection). Self-healing: the daemon stops
   * retrying it, and it is remembered so a concurrent daemon's stale copy is not
   * re-adopted on the next read-merge. Returns true iff the token was present.
   */
  prune(token: string, reason: string): boolean {
    const had = this.tokens.delete(token);
    this.removed.add(token);
    if (had) {
      log(`[DeviceTokens] Pruned dead token (${reason}): ${token.slice(0, 20)}...`);
      this.persist();
    }
    return had;
  }

  /**
   * Unregister a token on explicit user removal (#690) — the user removed this
   * server/machine from the phone app. Same semantics as `prune` (delete +
   * remember so a concurrent daemon's stale copy is not re-adopted), distinct
   * reason for the log line. Does NOT fire on mere disconnect/app suspension;
   * push-while-suspended must keep working, so tokens persist across those.
   * Returns true iff the token was present.
   */
  unregister(token: string): boolean {
    const had = this.tokens.delete(token);
    this.removed.add(token);
    if (had) {
      log(`[DeviceTokens] Unregistered by device: ${token.slice(0, 20)}...`);
      this.persist();
    }
    return had;
  }

  private readFile(): DeviceTokenEntry[] {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      const list = (parsed as { tokens?: unknown })?.tokens;
      if (Array.isArray(list)) return list.filter(isValidEntry);
    } catch {
      // Missing or corrupt -> treat as empty; the file is rebuilt on the next write.
    }
    return [];
  }

  /** Read-merge then atomic write, so a concurrent daemon's registrations survive
   *  (union across tokens) while this daemon's prunes/refreshes win on the same token. */
  private persist(): void {
    try {
      for (const e of this.readFile()) {
        // Adopt another daemon's token we do not have and have not removed.
        if (!this.tokens.has(e.token) && !this.removed.has(e.token)) {
          this.tokens.set(e.token, e);
        }
      }
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ tokens: [...this.tokens.values()] }));
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      // Persistence is best-effort: the in-memory map is still authoritative for
      // this process, so a write failure must not break push delivery.
      logError(`[DeviceTokens] Failed to persist registry: ${err}`);
    }
  }
}
