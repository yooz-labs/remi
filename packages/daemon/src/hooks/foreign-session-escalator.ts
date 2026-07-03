/**
 * ForeignSessionEscalator — the fail-safe fallback for a PermissionRequest hook
 * that `TranscriptBinder.admits()` rejects (#672).
 *
 * Claude Code hooks are project-scoped: every `claude` process sharing a
 * project directory fires PermissionRequest at every daemon watching that
 * directory. `admits()` recognizes only events from our own session (exact
 * id, a subagent sharing our transcript, or a marker-proven reclaim); anything
 * else used to be dropped with a single debug-level log line and NOTHING else
 * — no auto-approve evaluation, no escalation to the user. For a genuinely
 * separate top-level session (a teammate, or any other unmanaged `claude`
 * process in the same cwd), that means its permission prompts are silently
 * lost: nobody evaluates them and nobody is told they are waiting.
 *
 * This class runs a three-way ownership ladder for such an event:
 *
 *   1. SIBLING — a DIFFERENT live remi daemon owns it (via the durable binding
 *      store's reverse lookup, or the transcript's own port marker naming a
 *      currently-live sibling). That daemon's own admission path handles it;
 *      we stay silent.
 *   2. UNCLAIMED — no live daemon claims it. Fire a rate-limited INFORMATIONAL
 *      push so the user at least knows a permission prompt is stuck somewhere
 *      unmanaged. This is NOT a `Question`: nothing here is answerable through
 *      Remi. The hook for a foreign session is not ours to resolve — Claude
 *      is blocked waiting in that OTHER process, not ours — so an "answer"
 *      from the phone would have nowhere valid to go. Reusing the normal
 *      Question/hold machinery would risk exactly that: an answer routed back
 *      through OUR `resolveHeld` would inject into OUR PTY, the wrong session
 *      entirely (the evil twin of #538). The push therefore carries no
 *      `category` and no `options`: iOS only renders action buttons for the
 *      three registered categories (REMI_YN / REMI_YNA / REMI_MULTI,
 *      `AppDelegate.swift`), so a push with neither is a plain, dismiss-only
 *      banner — tapping it can only open the app, never submit an answer.
 *   3. UNDETERMINED — ownership could not be proven either way: a
 *      registry/store read failed, OR the transcript's marker is unreadable
 *      AND the file is too recent to trust that as "genuinely markerless"
 *      (see below). Log at ERROR level only; never escalate on an
 *      inconclusive read, so a filesystem hiccup — or our own in-flight
 *      rotation — cannot turn into a notification storm / a self-targeted
 *      false alarm.
 *
 * MARKER-UNREADABLE SUB-CASE (post-review hardening): `readTranscriptOwnerPort`
 * returning null does not by itself mean "no remi daemon manages this session."
 * It can also mean OUR OWN transcript, seconds into a rotation (/clear,
 * /resume), whose head marker Claude has not finished flushing yet — and with
 * a sibling present in the directory, `TranscriptBinder.admits()` rejects our
 * OWN PermissionRequest during exactly that window (the sibling-defer gate
 * cannot yet prove the new transcript is ours either). Escalating in that
 * window would push "Unbound Claude session" about the user's OWN, perfectly
 * normal session. The fix: a null marker on a file young enough to still be
 * mid-flush (MARKER_SETTLE_MS) classifies as UNDETERMINED, not UNCLAIMED; only
 * a null marker on a file that has sat that way well past the settle window
 * is treated as genuinely foreign.
 *
 * All of this runs from a synchronous hook resolver (`setPermissionResolver`)
 * that must return 'passthrough' immediately regardless of what this class
 * decides — `handleUnadmitted` performs its (cheap, synchronous) ownership
 * check inline, then fires the push in the background without making the
 * caller await it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { UUID } from '@remi/shared';
import { errorToString } from '@remi/shared';

import type { DeviceTokenEntry } from '../cli/handlers/trivial-events.ts';
import { log, logError } from '../cli/logger.ts';
import type { PushConfig, PushFn } from '../notifications/notification-dispatcher.ts';
import { sendPushTrigger } from '../notifications/push-client.ts';
import type { SessionBindingStore } from '../session/index.ts';
import { type SessionRegistryFile, claudeChildLooksAlive } from '../session/index.ts';
import { MARKER_SETTLE_MS, readTranscriptOwnerPort } from '../transcript/transcript-owner.ts';
import type { PermissionRequestHookInput } from './hook-types.ts';

/** At most one informational escalation per foreign claude session_id within
 *  this window, so a busy unclaimed session cannot spam the user's phone. */
const DEFAULT_RATE_LIMIT_MS = 5 * 60_000;

/**
 * Hard ceiling on distinct foreign session_ids tracked for rate-limiting at
 * once. The age-based prune in `shouldEscalate` only evicts entries OLDER
 * than `rateLimitMs`, so a burst of many DISTINCT foreign session_ids within
 * a single window (all fresh, none prunable yet) would otherwise grow the
 * map unbounded. This is a second, independent bound: once exceeded, the
 * OLDEST entries (by recorded timestamp) are evicted first.
 */
const MAX_TRACKED_FOREIGN_SESSIONS = 500;

export interface ForeignSessionEscalatorDeps {
  liveSessionsRegistry: SessionRegistryFile;
  bindingStore: SessionBindingStore;
  deviceTokens: Map<string, DeviceTokenEntry>;
  pushConfig: () => PushConfig;
  currentPort: () => number;
  /** Test override for the push transport; defaults to the real sendPushTrigger. */
  pushFn?: PushFn;
  /** Test override for the rate-limit window (ms); defaults to 5 minutes. */
  rateLimitMs?: number;
  /** Test override for the marker-settle window (ms); defaults to the shared
   *  MARKER_SETTLE_MS (10s) TranscriptBinder's dir-poll also uses. */
  markerSettleMs?: number;
  /** Test override clock; defaults to Date.now. */
  now?: () => number;
}

type Ownership = 'sibling' | 'unclaimed' | 'undetermined';

export class ForeignSessionEscalator {
  private readonly pushFn: PushFn;
  private readonly rateLimitMs: number;
  private readonly markerSettleMs: number;
  private readonly now: () => number;
  /** Foreign claude session_id -> epoch ms of its last escalation. Pruned on
   *  every check so the map never grows unbounded across a long daemon life. */
  private readonly lastEscalated = new Map<string, number>();

  constructor(private readonly deps: ForeignSessionEscalatorDeps) {
    this.pushFn = deps.pushFn ?? sendPushTrigger;
    this.rateLimitMs = deps.rateLimitMs ?? DEFAULT_RATE_LIMIT_MS;
    this.markerSettleMs = deps.markerSettleMs ?? MARKER_SETTLE_MS;
    this.now = deps.now ?? Date.now;
  }

  /**
   * Called by a session's PermissionRequest resolver when `binder.admits()`
   * rejected the event. `callerSessionId` is the remi session that DETECTED
   * the foreign event (used only to route the informational push somewhere
   * real; it is never treated as the owner of `input`).
   */
  handleUnadmitted(input: PermissionRequestHookInput, callerSessionId: UUID): void {
    let ownership: Ownership;
    try {
      ownership = this.classifyOwnership(input);
    } catch (err) {
      logError(
        `[ForeignSession] Could not determine ownership of ${input.session_id.slice(0, 8)} ` +
          `(registry read failed); staying quiet to avoid an escalation storm: ${errorToString(err)}`,
      );
      return;
    }
    if (ownership === 'sibling') {
      log(
        `[ForeignSession] ${input.session_id.slice(0, 8)} (tool=${input.tool_name}) claimed by a live sibling daemon; staying silent`,
      );
      return;
    }
    if (ownership === 'undetermined') {
      logError(
        `[ForeignSession] Ownership of ${input.session_id.slice(0, 8)} (tool=${input.tool_name}) could not be proven yet (marker unreadable on a still-recent transcript -- possibly our own in-flight rotation); staying quiet rather than risk a false-alarm push`,
      );
      return;
    }
    if (!this.shouldEscalate(input.session_id)) {
      log(
        `[ForeignSession] Suppressing repeat escalation for ${input.session_id.slice(0, 8)} (rate-limited)`,
      );
      return;
    }
    // Fire-and-forget: the caller (a synchronous hook resolver) must not wait
    // on a network push before returning its own decision.
    void this.pushInformational(input, callerSessionId).catch((err) => {
      logError(`[ForeignSession] Informational push threw: ${errorToString(err)}`);
    });
  }

  /**
   * Sibling / unclaimed / undetermined. Two independent signals prove a live
   * sibling daemon owns `input`:
   *   (a) the durable binding store already maps this claude session id to a
   *       DIFFERENT remi session, and that session's daemon is currently live
   *       (cross-checked against the live-sessions registry, not just the
   *       store's own coarser bookkeeping);
   *   (b) the foreign transcript's `remi:<port>` marker names a port some
   *       OTHER currently-live daemon is bound to. Unlike TranscriptBinder's
   *       storedPort reclaim fallback (which trusts a value frozen at OUR
   *       session's spawn time, arbitrarily long ago), every input to this
   *       comparison is read fresh at decision time -- the incoming marker
   *       AND the sibling's liveness -- so there is no stale/frozen value to
   *       go stale between recording and use; a symmetric freshness gate here
   *       would add no protection (post-review non-blocking item, addressed
   *       by leaving this asymmetric on purpose).
   * A null marker (unreadable) is NOT immediately 'unclaimed': see the module
   * doc's "MARKER-UNREADABLE SUB-CASE".
   * Deliberately NOT try/catch'd here: the caller wraps this call so a
   * registry/store read failure is logged once at error level instead of
   * silently falling through to an escalation.
   */
  private classifyOwnership(input: PermissionRequestHookInput): Ownership {
    const live = this.deps.liveSessionsRegistry.listLive();

    const stored = this.deps.bindingStore.getByClaudeSessionId(input.session_id);
    if (stored) {
      const owner = live.find((e) => e.sessionId === stored.remiSessionId);
      if (owner && claudeChildLooksAlive(owner)) return 'sibling';
    }

    const ownerPort = readTranscriptOwnerPort(input.transcript_path);
    if (ownerPort === null) {
      return this.markerMayStillBeSettling(input.transcript_path) ? 'undetermined' : 'unclaimed';
    }

    if (
      ownerPort !== this.deps.currentPort() &&
      live.some((e) => e.wsPort === ownerPort && claudeChildLooksAlive(e))
    ) {
      return 'sibling';
    }

    return 'unclaimed';
  }

  /**
   * Whether `transcriptPath` is too fresh to trust a null marker read as
   * proof of "genuinely markerless" (post-review). Mirrors the same
   * MARKER_SETTLE_MS threshold TranscriptBinder's rotation dir-poll uses for
   * the identical "still flushing vs. settled" question. An unreadable/missing
   * file (stat failure) also returns true: fail toward NOT escalating on an
   * inconclusive read, same philosophy as the registry-read-error case.
   */
  private markerMayStillBeSettling(transcriptPath: string): boolean {
    try {
      return Date.now() - fs.statSync(transcriptPath).mtimeMs <= this.markerSettleMs;
    } catch {
      return true;
    }
  }

  /** Rate-limit gate: true (and records `now`) iff this claude session id has
   *  not been escalated within the last `rateLimitMs`. */
  private shouldEscalate(claudeSessionId: string): boolean {
    const now = this.now();
    for (const [id, at] of this.lastEscalated) {
      if (now - at > this.rateLimitMs) this.lastEscalated.delete(id);
    }
    const last = this.lastEscalated.get(claudeSessionId);
    if (last !== undefined && now - last < this.rateLimitMs) return false;
    this.lastEscalated.set(claudeSessionId, now);
    this.evictOldestIfOverCap();
    return true;
  }

  /** Hard size cap, independent of the age-based prune above: a burst of many
   *  distinct foreign session_ids within one rate-limit window are all
   *  "fresh" and none would be pruned by age alone. Evicts the OLDEST entries
   *  (by recorded timestamp) until back at the cap. */
  private evictOldestIfOverCap(): void {
    const over = this.lastEscalated.size - MAX_TRACKED_FOREIGN_SESSIONS;
    if (over <= 0) return;
    const oldestFirst = [...this.lastEscalated.entries()].sort((a, b) => a[1] - b[1]);
    for (const [id] of oldestFirst.slice(0, over)) {
      this.lastEscalated.delete(id);
    }
  }

  /**
   * Fire a dismiss-only informational push (case 2). Deliberately NOT routed
   * through `sessionRegistry.addQuestion` / the tracker's hold machinery: this
   * is not a question anyone can answer through Remi. See the module doc for
   * why no `category` / `options` are set.
   */
  private async pushInformational(
    input: PermissionRequestHookInput,
    callerSessionId: UUID,
  ): Promise<void> {
    const { deviceTokens, pushConfig } = this.deps;
    const shortId = input.session_id.slice(0, 8);
    if (deviceTokens.size === 0) {
      log(
        `[ForeignSession] No device tokens registered; cannot notify about unbound session ${shortId}`,
      );
      return;
    }
    const cfg = pushConfig();
    const cwdHint = input.cwd ? path.basename(input.cwd) : undefined;
    const title = `Unbound Claude session (${shortId})`;
    const body = `${input.tool_name} requested permission in a Claude session Remi does not manage${cwdHint ? ` (${cwdHint})` : ''}. Not connected to Remi; answer it in that terminal directly.`;

    const results = await Promise.allSettled(
      [...deviceTokens.values()].map((dt) =>
        this.pushFn(cfg.signalingUrl, dt.token, {
          title,
          body,
          ...(cfg.pushSecret !== undefined ? { pushSecret: cfg.pushSecret } : {}),
          sessionId: callerSessionId,
          // Deliberately no `category` / `options`: dismiss-only, no action
          // buttons (see module doc). Also no `questionId` -- there is no
          // Question backing this push for an answer to resolve against.
        }),
      ),
    );
    if (!results.some((r) => r.status === 'fulfilled')) {
      logError(
        `[ForeignSession] Escalation push failed for all device tokens (session ${shortId})`,
      );
    }
  }
}
