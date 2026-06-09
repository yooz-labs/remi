/**
 * TranscriptBinder — the single owner of one Remi session's binding state,
 * transcript watcher, and Claude-restart rotation (epic #453, phase 3).
 *
 * This is a BEHAVIOR-PRESERVING extraction of the logic previously scattered
 * across `cli/session-phases/hook-bridge-setup.ts` (`initFromHookEvent`,
 * `onSessionInfo`, `teardownWatcher`, `ensureWatcher`, the SessionStart
 * pre-empt, the SessionEnd id-match, `hasSiblingInDir`, `ownsTranscript`,
 * `adoptLockFromStore`) plus the fallback poll arming previously done in
 * `cli.ts`. The state machine reproduces the hook-bridge logic EXACTLY; the
 * phase-0 characterization suite (`tests/cli/session-phases/hook-bridge-setup.test.ts`)
 * is the contract this class must satisfy.
 *
 * Two entry points, with a strict ownership split:
 *
 *   - `decide(event)` is PURE — it runs the snapshot -> adopt -> rotation ->
 *     classify pipeline and returns a `BinderDecision` describing what the
 *     DRIVE path WOULD do, WITHOUT any external effect (no store write, no
 *     watcher start, no send, no teardown). It MAY advance the binder's OWN
 *     state fields so successive `decide()` calls track rotations the same
 *     way the live path does. This is the shadow-mode tap (design §3.1 v4 #8).
 *
 *   - `onHookEvent(event)` is the DRIVE path = decide-equivalent ordering plus
 *     the side effects, and the SINGLE caller of `rotate()`. Ordering mirrors
 *     `initFromHookEvent` to the line: snapshot -> adopt -> classify ->
 *     foreign/defer return -> restart funnels through `rotate()` -> the
 *     `if (currentBoundId) { ensureWatching; return }` tripwire (BEFORE the
 *     first-adopt emit, so the store-raced case stays zero-emit, #430) ->
 *     first-adopt: bindingStore.update + ensureWatching + (isRotation &&
 *     !announced) emitRotated.
 *
 * All rotation emits go through `emitRotated`, which is idempotent on
 * `lastAnnouncedRotationId` (design §3.1 v4 #2) so an A->B->A re-resume emits
 * A->B, B->A, and never a duplicate A->B.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createSessionRotated, errorToString } from '@remi/shared';
import type { ProtocolMessage, UUID } from '@remi/shared';

import type { MessageAPI } from '../api/message-api.ts';
import { log, logError } from '../cli/logger.ts';
import { startTranscriptFallback } from '../cli/transcript-fallback.ts';
import { startTranscriptWatcher } from '../cli/transcript-watcher-setup.ts';
import { classifySessionEvent } from '../hooks/session-lock-classifier.ts';
import type { SessionEventClass } from '../hooks/session-lock-classifier.ts';
import { claudeChildLooksAlive } from '../session/index.ts';
import type {
  SessionBindingStore,
  SessionRegistry,
  SessionRegistryFile,
} from '../session/index.ts';
import type { TranscriptDiscovery } from './transcript-discovery.ts';
import { readTranscriptOwnerPort } from './transcript-owner.ts';
import type { TranscriptWatcher } from './transcript-watcher.ts';

/**
 * Re-stat cadence for the #452 no-hooks rotation detector. 1500ms is a
 * deliberate middle: fast enough that a no-hooks rotation surfaces within
 * ~1.5–3s (comparable to the existing 2s fallback poll), slow enough that
 * readdir+stat on a ~tens-of-files dir is negligible CPU.
 */
const ROTATION_POLL_INTERVAL_MS = 1500;
/**
 * How long a NEW `.jsonl` may sit with an unreadable `remi:<port>` head marker
 * before we stop re-polling it. The marker-ready guard: an empty/unflushed file
 * reads `null` and is re-polled (it may still be flushing), never classified on
 * the empty edge. We discriminate "still flushing" from "settled non-remi file"
 * by the file's mtime AGE, not a tick count — so a slow-flushing OWN transcript
 * (or a transient EMFILE read) is NEVER permanently dropped within this window
 * (that permanent drop would be the exact #452 wedge: the kept fallback poll
 * only ever waits for the INITIAL transcript, not a rotated id). Only a file
 * settled-and-markerless for longer than this is recorded as seen. 10s is far
 * beyond Claude's synchronous create-to-marker gap.
 */
const MARKER_SETTLE_MS = 10_000;

/** A hook event as the binder consumes it (the subset it reads). */
export interface BinderHookEvent {
  readonly session_id?: string;
  readonly transcript_path?: string;
  readonly hook_event_name?: string;
  /** Subagent/team events carry agent_id; used by the SessionStart pre-empt. */
  readonly agent_id?: string;
}

/**
 * The pure result of `decide(event)`. Describes what the DRIVE path WOULD do
 * for this event, with no external effect performed.
 */
export interface BinderDecision {
  /** Three-way classification + the sibling-defer gate as a 4th outcome. */
  readonly classification: 'match' | 'foreign' | 'restart' | 'defer';
  /** Whether the drive path would emit a session_rotated for this event. */
  readonly wouldEmitRotation: boolean;
  /** Whether the drive path would (re)start a transcript watcher. */
  readonly wouldStartWatcher: boolean;
  /** The path the watcher would be (re)started on, when known. */
  readonly watcherPath: string | null;
  /** The bound claude session id AFTER this event is processed. */
  readonly boundIdAfter: string | null;
}

/** Construction mode (immutable for the binder lifetime; design §3.1 v4 #9). */
export type BinderMode = 'shadow' | 'drive';

export interface TranscriptBinderDeps {
  sessionRegistry: SessionRegistry;
  bindingStore: SessionBindingStore;
  liveSessionsRegistry: SessionRegistryFile;
  transcriptWatchers: Map<UUID, TranscriptWatcher>;
  transcriptFallbackTimers: Map<UUID, ReturnType<typeof setInterval>>;
  transcriptDiscovery: TranscriptDiscovery;
  messageApi: MessageAPI;
  sendAndRecord: (message: ProtocolMessage) => void;
  /** PORT is reassigned during daemon-mode port probing; read lazily. */
  currentPort: () => number;
  /**
   * Injected rotation side effects that live OUTSIDE the binder's concern
   * (clear the presence tracker's pending record + sessionRegistry questions).
   * Called from `rotate()` only, matching the old restart branch's
   * `tracker.clearPending(); sessionRegistry.clearQuestions()`.
   */
  onRotation: () => void;
}

export interface TranscriptBinderArgs {
  sessionId: UUID;
  workingDirectory: string;
}

/** Test-only overrides for the rotation dir-poll cadence. */
export interface TranscriptBinderTuning {
  /** Rotation re-stat cadence (ms). Defaults to ROTATION_POLL_INTERVAL_MS. */
  rotationPollIntervalMs?: number;
  /** Marker-settle window (ms). Defaults to MARKER_SETTLE_MS. */
  markerSettleMs?: number;
}

export class TranscriptBinder {
  // --- Owned binding state (the OWN pre-adopt copy is the snapshot source) ---
  /** Our currently-bound Claude session id, or null before first adopt. */
  private currentBoundId: string | null = null;
  /** Set when main explicitly ended (SessionEnd id-match) or the SessionStart
   *  pre-empt fired; makes the classifier treat the next id as 'restart'. */
  private mainSessionEnded = false;
  /** Idempotency scalar: the last id we announced a rotation for. */
  private lastAnnouncedRotationId: string | null = null;
  /** Last transcript path we (re)started a watcher on; for snapshot(). */
  private lastTranscriptPath: string | null = null;

  // --- Re-arming rotation dir-poll (#452, drive-mode only) ---
  /**
   * The periodic dir RE-STAT interval handle; null when unarmed (shadow mode,
   * pre-start, post-close). Distinct from `deps.transcriptFallbackTimers` —
   * this is the rotation detector, NOT the first-bind fallback poll.
   */
  private rotationPollTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * The project transcript dir we re-stat. Resolved once at start() so the poll
   * never recomputes the lossy path encoding per tick; null when unarmed.
   */
  private rotationPollDir: string | null = null;
  /**
   * Every Claude session id we have ALREADY considered for rotation — fed,
   * bound, announced, or proven-foreign. A candidate in this set is never
   * re-fed, so each rotation fires `onHookEvent` exactly once even though the
   * poll re-stats the dir every tick. Seeded with the initial claudeId at
   * start(); cleared by close().
   */
  private readonly seenRotationIds: Set<string> = new Set();
  /** Test override for the poll cadence; defaults to ROTATION_POLL_INTERVAL_MS. */
  private rotationPollIntervalMs: number = ROTATION_POLL_INTERVAL_MS;
  /** Marker-settle window (ms): a new candidate whose `remi:<port>` marker is not
   *  yet readable is re-polled until its file has been settled-and-markerless for
   *  this long (by mtime), then recorded as seen. Test-overridable. */
  private markerSettleMs: number = MARKER_SETTLE_MS;

  private readonly deps: TranscriptBinderDeps;
  private readonly sessionId: UUID;
  private readonly workingDirectory: string;
  private readonly mode: BinderMode;

  constructor(
    deps: TranscriptBinderDeps,
    args: TranscriptBinderArgs,
    mode: BinderMode,
    tuning?: TranscriptBinderTuning,
  ) {
    this.deps = deps;
    this.sessionId = args.sessionId;
    this.workingDirectory = args.workingDirectory;
    this.mode = mode;
    if (tuning?.rotationPollIntervalMs !== undefined) {
      this.rotationPollIntervalMs = tuning.rotationPollIntervalMs;
    }
    if (tuning?.markerSettleMs !== undefined) {
      this.markerSettleMs = tuning.markerSettleMs;
    }
  }

  // =========================================================================
  // PURE decision path (shadow tap). NO external effects.
  // =========================================================================

  /**
   * Compute the decision for an event WITHOUT performing any side effect.
   * Mirrors `onHookEvent` ordering but performs nothing external: no
   * bindingStore.update, no watcher start, no sendAndRecord, no teardown.
   * It MAY advance the binder's own state fields (currentBoundId,
   * mainSessionEnded, lastAnnouncedRotationId) so successive decide() calls
   * track rotations identically to the drive path.
   *
   * MODE CONTRACT: a `'shadow'` instance receives ONLY `decide()`; a `'drive'`
   * instance receives ONLY `onHookEvent()`. They mutate the same fields, so
   * mixing them on one instance would let one advance `lastAnnouncedRotationId`
   * and silently suppress the other's emit. The shadow harness (commit 3)
   * constructs a dedicated shadow instance for this reason. (Tests may call both
   * on one drive instance purely to inspect intermediate state.)
   */
  decide(event: BinderHookEvent): BinderDecision {
    const inert: BinderDecision = {
      classification: 'defer',
      wouldEmitRotation: false,
      wouldStartWatcher: false,
      watcherPath: null,
      boundIdAfter: this.currentBoundId,
    };
    if (!event.session_id) return inert;

    // 1) Snapshot BEFORE adopt (preserves the #430/#433 invariant).
    const previous = this.currentBoundId;

    // 2) Adopt from the disk-backed binding store (a read, never a write).
    this.adoptLockFromStore();

    // 3) Rotation is decided against the pre-adopt snapshot, never the store.
    const isRotation = previous !== null && previous !== event.session_id;

    // 4) Classify.
    let classification = this.classify(event.session_id);

    if (classification === 'foreign') {
      // Stale-lock recovery (#518): an event the classifier calls foreign is
      // actually OURS when its transcript carries our port marker. Re-adopt it
      // as a restart instead of dropping. See `incomingReclaimsViaMarker`.
      if (this.incomingReclaimsViaMarker(event)) {
        classification = 'restart';
      } else {
        return {
          classification: 'foreign',
          wouldEmitRotation: false,
          wouldStartWatcher: false,
          watcherPath: null,
          boundIdAfter: this.currentBoundId,
        };
      }
    }

    // Restart PROLOGUE (pure mirror of rotate()): announce (idempotent +
    // path-guarded), NULL the lock, reset mainSessionEnded — then FALL THROUGH to
    // the tripwire + first-adopt gate below, so a restart with a live sibling and
    // an unproven transcript defers (#451) instead of binding, and a path-less
    // restart leaves the lock null (no rebind), exactly as the old code does.
    let rotationAnnounced = false;
    if (classification === 'restart') {
      if (
        isRotation &&
        !!event.transcript_path &&
        event.session_id !== this.lastAnnouncedRotationId
      ) {
        this.lastAnnouncedRotationId = event.session_id;
        rotationAnnounced = true;
      }
      this.currentBoundId = null;
      this.mainSessionEnded = false;
    }

    // Tripwire: a lock is already held (match, or store-raced) -> ensureWatching
    // path, no emit, no store write. The store-raced zero-emit case (#430).
    if (this.currentBoundId) {
      return {
        classification,
        wouldEmitRotation: false,
        // ensureWatching only starts when none running AND a path is present;
        // for a pure decision we report intent on path presence.
        wouldStartWatcher: !!event.transcript_path,
        watcherPath: event.transcript_path ?? null,
        boundIdAfter: this.currentBoundId,
      };
    }

    // First adopt. No path -> nothing to bind (a path-less restart lands here
    // with the lock null; the prologue may already have announced).
    if (!event.transcript_path) {
      return {
        classification,
        wouldEmitRotation: rotationAnnounced,
        wouldStartWatcher: false,
        watcherPath: null,
        boundIdAfter: this.currentBoundId,
      };
    }

    // Sibling-defer gate (separate from classify): a co-located sibling and the
    // marker does not prove ownership -> defer (no bind, no watcher). A restart
    // that already announced still reports the emit.
    if (this.hasSiblingInDir() && !this.ownsTranscript(event.transcript_path)) {
      return {
        classification: 'defer',
        wouldEmitRotation: rotationAnnounced,
        wouldStartWatcher: false,
        watcherPath: null,
        boundIdAfter: this.currentBoundId,
      };
    }

    // Adopt: bind the new id, maybe announce the rotation (unless the prologue
    // already did).
    const wouldEmit =
      isRotation && !rotationAnnounced && event.session_id !== this.lastAnnouncedRotationId;
    if (wouldEmit) {
      this.lastAnnouncedRotationId = event.session_id;
    }
    this.currentBoundId = event.session_id;
    this.lastTranscriptPath = event.transcript_path;
    return {
      classification,
      wouldEmitRotation: wouldEmit || rotationAnnounced,
      wouldStartWatcher: true,
      watcherPath: event.transcript_path,
      boundIdAfter: this.currentBoundId,
    };
  }

  // =========================================================================
  // DRIVE path. decide + side effects. SINGLE caller of rotate().
  // =========================================================================

  /**
   * The drive entry point. Reproduces `initFromHookEvent` exactly: snapshot,
   * adopt, classify, foreign/defer return, restart via `rotate()`, the
   * tripwire BEFORE the first-adopt emit, then first-adopt
   * (bindingStore.update + ensureWatching + rotation announce).
   */
  onHookEvent(event: BinderHookEvent): void {
    if (!event.session_id) return;

    // 1) Snapshot BEFORE adopt.
    const previous = this.currentBoundId;

    // 2) Adopt from the store.
    this.adoptLockFromStore();

    // 3) Rotation against the pre-adopt snapshot.
    const isRotation = previous !== null && previous !== event.session_id;

    // 4) Classify.
    let classification = this.classify(event.session_id);

    if (classification === 'foreign') {
      // Stale-lock recovery (#518): the incoming transcript carries OUR port
      // marker, so it is provably our own Claude — a rotation we missed because
      // we adopted a stale lock (mid-session attach / restart) and never saw the
      // SessionStart. Re-adopt it as a restart instead of dropping it forever.
      if (this.incomingReclaimsViaMarker(event)) {
        log(
          `[Binder] Reclaiming own session via port marker (stale lock): lock=${this.currentBoundId?.slice(0, 8)} -> ${event.session_id.slice(0, 8)}`,
        );
        classification = 'restart';
      } else {
        log(
          `[Binder] Dropped foreign ${event.hook_event_name ?? 'event'}: lock=${this.currentBoundId?.slice(0, 8)} incoming=${event.session_id.slice(0, 8)}`,
        );
        return;
      }
    }

    let rotationAnnounced = false;
    if (classification === 'restart') {
      log(
        `[Binder] Claude restart detected (ended=${this.mainSessionEnded}): ${this.currentBoundId} -> ${event.session_id}`,
      );
      // The single rotation funnel. Performs teardown -> onRotation ->
      // emitRotated (path-guarded) -> bindingStore.update -> currentBoundId=new
      // -> mainSessionEnded=false. emitRotated only fires when a path is
      // present and isRotation holds.
      rotationAnnounced = this.rotate(
        event.session_id,
        event.transcript_path,
        previous,
        isRotation,
      );
    }

    // classification === 'match' (or restart fell through with the new lock).
    // Tripwire: lock already held -> ensure a watcher, return BEFORE the
    // first-adopt emit so the store-raced case stays zero-emit (#430).
    if (this.currentBoundId) {
      this.ensureWatching(event.transcript_path, 'match');
      return;
    }

    // First adopt path.
    if (!event.transcript_path) return;

    if (this.hasSiblingInDir() && !this.ownsTranscript(event.transcript_path)) {
      // Defer to the fallback poll: cannot prove this event is ours.
      return;
    }

    try {
      this.currentBoundId = event.session_id;
      this.lastTranscriptPath = event.transcript_path;
      log(
        `[Binder] Transcript from ${event.hook_event_name ?? 'hook'}: claude=${this.currentBoundId}, transcript=${event.transcript_path}`,
      );
      this.deps.bindingStore.update(this.sessionId, this.currentBoundId);

      // Announce the rotation as ONE atomic event. Skip on first-init (not a
      // rotation) and skip if rotate() already announced it.
      if (isRotation && !rotationAnnounced) {
        this.emitRotated(event.session_id, event.transcript_path, previous);
      }

      this.startOrReplaceWatcher(event.transcript_path);
    } catch (err) {
      logError(`[Binder] onHookEvent failed for session ${this.sessionId}: ${errorToString(err)}`);
      this.currentBoundId = null; // Reset so the fallback can take over.
    }
  }

  // =========================================================================
  // Classification.
  // =========================================================================

  /**
   * Wraps `classifySessionEvent` with the binder's live inputs. The
   * sibling-defer gate is applied SEPARATELY in onHookEvent/decide (it gates
   * the first-adopt only), matching the old code where classify never knew
   * about siblings.
   */
  private classify(incomingSessionId: string): SessionEventClass {
    return classifySessionEvent({
      currentLock: this.currentBoundId,
      incomingSessionId,
      mainPtyRunning: this.deps.sessionRegistry.getSession(this.sessionId)?.pty.isRunning ?? false,
      mainSessionEnded: this.mainSessionEnded,
    });
  }

  // =========================================================================
  // SessionStart pre-empt + SessionEnd id-match.
  // =========================================================================

  /**
   * The SessionStart pre-empt (old `hook-bridge-setup.ts:585-610`). On any
   * in-process session_id rotation while our PTY is alive, flip
   * mainSessionEnded=true so the classifier returns 'restart'. Gated by the
   * subagent check + the sibling/ownership guard. Must be called by the
   * driver BEFORE onHookEvent for SessionStart, mirroring the old order.
   */
  preemptOnSessionStart(event: BinderHookEvent): void {
    if (
      !this.isSubagentEvent(event) &&
      this.currentBoundId &&
      event.session_id &&
      event.session_id !== this.currentBoundId &&
      (!this.hasSiblingInDir() || this.ownsTranscript(event.transcript_path))
    ) {
      log(`[Binder] Main lifecycle transition: ${this.currentBoundId} -> ${event.session_id}`);
      this.mainSessionEnded = true;
    }
  }

  /**
   * SessionEnd handler (old `hook-bridge-setup.ts:665-670`). Mark main ended
   * ONLY when the session_id matches our lock — foreign SessionEnds (subagents,
   * siblings) must not unlock our tracking. THIS WAS MISSING in v2; without it
   * clean-exit restarts drop.
   */
  onSessionEnd(event: BinderHookEvent): void {
    if (event.session_id && this.currentBoundId && event.session_id === this.currentBoundId) {
      this.mainSessionEnded = true;
    }
  }

  /**
   * Session filter (DRIVE-mode replacement for the old `filterBySession`,
   * `hook-bridge-setup.ts:603-607`). Accept events only from our own Claude.
   * Before the lock is known, block events when a live sibling exists (they
   * could be from the sibling's Claude). Ported line-for-line: adopt the
   * disk-fresh lock first, then gate on it (or the sibling guard). Pure read
   * (the adopt is a store read, never a write); no rotation, no watcher.
   */
  admits(event: BinderHookEvent): boolean {
    this.adoptLockFromStore();
    if (!this.currentBoundId) return !this.hasSiblingInDir();
    if (event.session_id === this.currentBoundId) return true;
    // Stale-lock recovery (#518): the lock disagrees, but the incoming event's
    // transcript carries OUR port marker, so it is provably ours. Admit it; the
    // next binding event's onHookEvent re-adopts the lock. Pure read (the marker
    // check is read-only), so admits() stays side-effect-free.
    return this.incomingReclaimsViaMarker(event);
  }

  /**
   * Stale-lock recovery test (#518). The classifier calls an event `foreign`
   * whenever its session_id differs from our lock and our PTY is running. That
   * is wrong when the daemon adopted a STALE lock (a mid-session attach or a
   * restart that missed the live session's SessionStart): the live session is
   * then dropped forever. Its transcript, however, carries our `remi:<port>`
   * head marker — content only OUR daemon's `-n remi:<port>` causes Claude to
   * write — so `ownsTranscript` proves it is ours. A genuine sibling's
   * transcript carries the sibling's port, so this stays false for it and
   * cross-session isolation (#451) is preserved.
   */
  private incomingReclaimsViaMarker(event: BinderHookEvent): boolean {
    return !!event.transcript_path && this.ownsTranscript(event.transcript_path);
  }

  // =========================================================================
  // Watcher lifecycle.
  // =========================================================================

  /**
   * Idempotent watcher ensure (subsumes old `ensureWatcher` + the init start).
   * No-op if a watcher exists; else cancel the fallback timer, replace a
   * stale-path watcher, and start. Only called for 'match' events (our own
   * Claude), whose transcript_path is therefore ours.
   */
  ensureWatching(transcriptPath: string | undefined, _source: string): void {
    // Steady-state no-op: a watcher is already running.
    if (this.deps.transcriptWatchers.has(this.sessionId)) return;
    if (!this.deps.sessionRegistry.hasSession(this.sessionId)) return;
    if (!transcriptPath) {
      logError(
        `[Binder] ensureWatching: match event without transcript_path for ${this.sessionId.slice(0, 8)}; watcher still missing`,
      );
      return;
    }
    this.cancelFallbackTimer();
    log(
      `[Binder] Ensuring watcher (self-heal) for ${this.sessionId.slice(0, 8)}: ${transcriptPath}`,
    );
    this.lastTranscriptPath = transcriptPath;
    startTranscriptWatcher(
      { transcriptWatchers: this.deps.transcriptWatchers },
      this.sessionId,
      transcriptPath,
      this.deps.messageApi,
      this.deps.sendAndRecord,
    );
  }

  /**
   * First-adopt watcher start with the stale-path replace (old
   * initFromHookEvent tail). Cancels the fallback timer, replaces a watcher
   * pointed at a different file, then starts if none running.
   */
  private startOrReplaceWatcher(transcriptPath: string): void {
    this.cancelFallbackTimer();

    const existingWatcher = this.deps.transcriptWatchers.get(this.sessionId);
    if (
      existingWatcher &&
      path.resolve(existingWatcher.filePath) !== path.resolve(transcriptPath)
    ) {
      log(`[Binder] Replacing stale watcher: ${existingWatcher.filePath} -> ${transcriptPath}`);
      this.teardownWatcher('stale-replace');
    }

    if (
      !this.deps.transcriptWatchers.has(this.sessionId) &&
      this.deps.sessionRegistry.hasSession(this.sessionId)
    ) {
      this.lastTranscriptPath = transcriptPath;
      startTranscriptWatcher(
        { transcriptWatchers: this.deps.transcriptWatchers },
        this.sessionId,
        transcriptPath,
        this.deps.messageApi,
        this.deps.sendAndRecord,
      );
    }
  }

  /**
   * Tear down the existing watcher + reset message state. Errors from stop()
   * are swallowed. Does NOT emit a wire message (the rotation is announced
   * atomically via emitRotated, #438). Mirrors old `teardownWatcher`.
   */
  private teardownWatcher(label: string): void {
    const watcher = this.deps.transcriptWatchers.get(this.sessionId);
    if (!watcher) return;
    this.deps.transcriptWatchers.delete(this.sessionId); // Remove FIRST.
    try {
      watcher.stop();
    } catch (stopErr) {
      logError(`[Binder] Failed to stop watcher (${label}): ${errorToString(stopErr)}`);
    }
    this.deps.messageApi.reset();
  }

  private cancelFallbackTimer(): void {
    const fallbackTimer = this.deps.transcriptFallbackTimers.get(this.sessionId);
    if (fallbackTimer) {
      clearInterval(fallbackTimer);
      this.deps.transcriptFallbackTimers.delete(this.sessionId);
    }
  }

  // =========================================================================
  // Rotation funnel + idempotent emit.
  // =========================================================================

  /**
   * Restart PROLOGUE (#438 ordering) — mirrors `initFromHookEvent`'s restart
   * branch EXACTLY: teardownWatcher -> onRotation() -> emitRotated (idempotent,
   * path-guarded) -> NULL the lock -> reset mainSessionEnded. It deliberately
   * does NOT bind the new id or write the store: `onHookEvent` falls through to
   * the first-adopt path, so the sibling-defer / ownership gate (#451) still
   * applies before any watcher start or store write, AND a path-less restart
   * leaves the lock null (no rebind) — both matching the old code (`:353` nulls
   * the lock; `:370` returns before the store write on a path-less restart).
   * Returns whether the rotation was announced so the first-adopt emit is
   * suppressed.
   */
  private rotate(
    newId: string,
    newPath: string | undefined,
    previousId: string | null,
    isRotation: boolean,
  ): boolean {
    this.teardownWatcher('restart');
    // Injected: clear presence-tracker pending + sessionRegistry questions.
    this.deps.onRotation();
    // Announce (idempotent + path-guarded). A path-less restart emits nothing.
    let announced = false;
    if (isRotation && newPath) {
      announced = this.emitRotated(newId, newPath, previousId);
    }
    this.currentBoundId = null;
    this.mainSessionEnded = false;
    return announced;
  }

  /**
   * Idempotent rotation announce. ALL emit sites go through this. Emits only
   * when a path is present and newId !== lastAnnouncedRotationId, so an
   * A->B->A re-resume emits A->B, B->A, and never a duplicate A->B. Returns
   * whether it emitted.
   */
  private emitRotated(
    newId: string,
    transcriptPath: string | undefined,
    prev: string | null,
  ): boolean {
    if (!transcriptPath) return false;
    if (newId === this.lastAnnouncedRotationId) return false;
    try {
      this.deps.sendAndRecord(
        createSessionRotated(
          this.sessionId,
          newId as UUID,
          transcriptPath,
          'restart',
          (prev ?? undefined) as UUID | undefined,
        ),
      );
      this.lastAnnouncedRotationId = newId;
      return true;
    } catch (err) {
      logError(`[Binder] Failed to emit session_rotated: ${errorToString(err)}`);
      return false;
    }
  }

  // =========================================================================
  // Adopt + ownership/sibling helpers (ported verbatim from hook-bridge).
  // =========================================================================

  /**
   * Adopt the canonical claudeSessionId from the disk-backed binding store.
   * Disk-fresh every call (no cache) so a sibling/fallback write is observed
   * (#321/#430). On change only; wrapped in try/catch so an EMFILE flake on
   * the sessions file does not propagate into the dispatch loop.
   */
  private adoptLockFromStore(): void {
    try {
      const storedId = this.deps.bindingStore.get(this.sessionId)?.claudeSessionId ?? null;
      if (storedId === null || storedId === this.currentBoundId) return;
      const previous = this.currentBoundId;
      this.currentBoundId = storedId;
      log(
        `[Binder] Lock ${previous === null ? 'adopted' : 'updated'} from binding store: claude=${storedId.slice(0, 8)}${previous ? ` (was ${previous.slice(0, 8)})` : ''}`,
      );
    } catch (err) {
      logError(`[Binder] adoptLockFromStore failed: ${errorToString(err)}`);
    }
  }

  /**
   * Whether a co-located sibling daemon (live Claude child) serves the same
   * directory. Ported verbatim from `hook-bridge-setup.ts:hasSiblingInDir`.
   */
  private hasSiblingInDir(): boolean {
    try {
      // Probe the dir ourselves so an enumeration failure flips to the safe
      // default of "sibling present" (PR #358).
      fs.readdirSync(this.deps.liveSessionsRegistry.dirPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return false; // first daemon
      logError(
        `[Binder] Could not enumerate live-sessions; assuming sibling present: ${errorToString(err)}`,
      );
      return true;
    }
    return this.deps.liveSessionsRegistry.listLive().some(
      (e) =>
        e.projectPath === this.workingDirectory &&
        e.sessionId !== this.sessionId &&
        e.wsPort !== this.deps.currentPort() &&
        // A zombie (daemon alive, Claude dead) must not count as a sibling
        // (#451). Legacy entries with no recorded child pid stay fail-safe live.
        claudeChildLooksAlive(e),
    );
  }

  /**
   * Whether the transcript named by an event was written by OUR Claude (the
   * remi:<port> head marker matches our port). Ported verbatim from
   * `hook-bridge-setup.ts:ownsTranscript`.
   */
  private ownsTranscript(transcriptPath: string | undefined): boolean {
    return (
      typeof transcriptPath === 'string' &&
      readTranscriptOwnerPort(transcriptPath) === this.deps.currentPort()
    );
  }

  /** Subagent/team events carry agent_id. */
  private isSubagentEvent(event: BinderHookEvent): boolean {
    return typeof event.agent_id === 'string' && event.agent_id.length > 0;
  }

  // =========================================================================
  // Lifecycle: start / close / snapshot.
  // =========================================================================

  /**
   * Arm the transcript discovery. In SHADOW mode this is a NO-OP (no dir-poll,
   * no fallback timer — the binder is provably side-effect-free, design §3.1
   * v4 #8). In DRIVE mode it arms BOTH:
   *
   *   - the existing fallback poll (Case A: our pre-assigned file appears), the
   *     safety net the #452 critic mandated — KEPT, unchanged;
   *   - the re-arming rotation dir-poll (Case B: a NEW Claude id with NO hook
   *     event — the hooks-down / no-hooks rotation the #452 dir-watcher targets).
   */
  start(claudeId: string): void {
    if (this.mode === 'shadow') return;
    startTranscriptFallback(
      {
        sessionRegistry: this.deps.sessionRegistry,
        transcriptDiscovery: this.deps.transcriptDiscovery,
        transcriptWatchers: this.deps.transcriptWatchers,
        transcriptFallbackTimers: this.deps.transcriptFallbackTimers,
      },
      this.sessionId,
      this.workingDirectory,
      claudeId,
      this.deps.messageApi,
      this.deps.sendAndRecord,
    );
    this.armRotationPoll(claudeId);
  }

  /**
   * Single teardown owner: clears the watcher, the fallback timer, AND the
   * rotation dir-poll (fixes the transcriptFallbackTimers leak at
   * cli.ts:822-829 and ensures the dir-poll never outlives the binder).
   */
  close(): void {
    this.teardownWatcher('close');
    this.cancelFallbackTimer();
    this.cancelRotationPoll();
  }

  // =========================================================================
  // Re-arming rotation dir-poll (#452 no-hooks rotation). Drive-mode only.
  //
  // ROBUSTNESS: a level-triggered RE-STAT poll over SETTLED state, not an
  // edge-triggered fs.watch. The empty-file edge that wedged #452 is
  // structurally absent — the poll observes the new `.jsonl` only at quantized
  // ticks, by which point Claude has flushed the `remi:<port>` head marker. The
  // marker-ready guard re-polls a not-yet-flushed candidate (RECENT by mtime),
  // only seen-setting a settled-and-markerless file so a slow flush is never
  // permanently dropped (#452); the seen-set is the exactly-once gate; the
  // marker == currentPort check is
  // the sibling gate. NON-EMITTING: every detection routes through the single
  // funnel onHookEvent(); we never call rotate()/emitRotated directly.
  // =========================================================================

  /**
   * Arm the periodic dir RE-STAT poll. Idempotent (no-op if already armed, so
   * the post-rotation re-arm — which is a no-op by construction here — is safe).
   * Seeds `seenRotationIds` with the initial claudeId so our own first
   * transcript is never mistaken for a rotation. Resolves the dir ONCE.
   */
  private armRotationPoll(initialClaudeId: string): void {
    if (this.mode === 'shadow') return;
    if (this.rotationPollTimer !== null) return; // already armed
    this.rotationPollDir = this.deps.transcriptDiscovery.getProjectTranscriptDir(
      this.workingDirectory,
    );
    this.seenRotationIds.add(initialClaudeId);
    this.rotationPollTimer = setInterval(
      () => this.rotationPollTick(),
      this.rotationPollIntervalMs,
    );
  }

  private cancelRotationPoll(): void {
    if (this.rotationPollTimer !== null) {
      clearInterval(this.rotationPollTimer);
      this.rotationPollTimer = null;
    }
    this.rotationPollDir = null;
    this.seenRotationIds.clear();
  }

  /**
   * One rotation-poll tick. Re-stats the project transcript dir, finds a NEW
   * Claude session id (not our current bind, not previously seen), verifies the
   * `remi:<port>` head marker proves it is OURS, and — only then — synthesizes a
   * hook-shaped event into the SINGLE funnel `onHookEvent()`. NEVER calls
   * `rotate()` / `emitRotated()` directly. Exposed (package-private) so a test
   * can drive a deterministic tick without waiting on the interval.
   */
  rotationPollTick(): void {
    // A throw escaping the setInterval callback permanently kills the timer with
    // no log or recovery. The inner fs reads have their own catches; this is the
    // backstop for an unexpected throw (sessionRegistry/currentPort/etc.).
    try {
      this.rotationPollTickInner();
    } catch (err) {
      logError(`[Binder] rotation poll tick failed unexpectedly: ${errorToString(err)}`);
    }
  }

  private rotationPollTickInner(): void {
    if (this.mode === 'shadow') return;
    // Session gone -> the lifecycle owner will close() us; do nothing meanwhile.
    if (!this.deps.sessionRegistry.hasSession(this.sessionId)) return;
    if (this.rotationPollDir === null) return;

    let entries: string[];
    try {
      entries = fs.readdirSync(this.rotationPollDir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // ENOENT is routine before Claude first writes the project dir; stay quiet.
      if (code !== undefined && code !== 'ENOENT') {
        logError(`[Binder] rotation poll readdir failed: ${errorToString(err)}`);
      }
      return;
    }

    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const candidateId = name.slice(0, -'.jsonl'.length);

      // (a) EXACTLY-ONCE + non-duplication gate. Skip our current bind, the last
      //     id we announced, and anything already considered. Re-read the lock
      //     disk-fresh so a hook/fallback bind we already absorbed is excluded.
      this.adoptLockFromStore();
      if (candidateId === this.currentBoundId) continue;
      if (candidateId === this.lastAnnouncedRotationId) continue;
      if (this.seenRotationIds.has(candidateId)) continue;

      const candidatePath = path.join(this.rotationPollDir, name);

      // (b) MARKER-READY GUARD. Unlike fs.watch's instant rename edge, by the
      //     time a tick observes the file Claude has almost always flushed the
      //     head marker. We still bounded-re-poll: a null read (empty/unflushed
      //     OR markerless) gives the candidate a few more ticks rather than
      //     classifying on an unproven edge.
      const ownerPort = readTranscriptOwnerPort(candidatePath);

      if (ownerPort === null) {
        // Null marker = empty/unflushed (mid-create), a non-remi session that
        // will never carry our marker, OR a transient read error. Do NOT
        // permanently drop on a tick count — a slow-flushing OWN transcript (or a
        // transient EMFILE) would then silently never rotate (the #452 wedge).
        // Keep re-polling RECENT files (still flushing); only stop touching a
        // file once it has been settled-and-markerless (by mtime) beyond the
        // grace window — a genuine non-remi/sibling file we'll never own.
        let ageMs = 0;
        try {
          ageMs = Date.now() - fs.statSync(candidatePath).mtimeMs;
        } catch {
          ageMs = 0; // raced a delete/rename -> treat as recent, re-poll.
        }
        if (ageMs > this.markerSettleMs) {
          this.seenRotationIds.add(candidateId);
        }
        continue;
      }

      // (c) SIBLING-MARKER GATE. The marker is readable AND must be OURS. A
      //     sibling daemon's fresh transcript carries the sibling's port; it
      //     must NOT rotate us. Mark seen so we never re-read it.
      if (ownerPort !== this.deps.currentPort()) {
        this.seenRotationIds.add(candidateId);
        log(
          `[Binder] rotation poll: ${candidateId.slice(0, 8)} owned by port ${ownerPort}, not ${this.deps.currentPort()}; ignoring`,
        );
        continue;
      }

      // (d) OURS + NEW. Mark seen BEFORE feeding so a re-entrant readdir on the
      //     next tick (or a throw) can never double-feed.
      this.seenRotationIds.add(candidateId);
      this.feedSyntheticRotation(candidateId, candidatePath);

      // One rotation per tick is enough; the next new id (if any) is picked up
      // next tick. Bounding to one keeps the tick cheap and avoids feeding two
      // synthetic restarts in a single synchronous frame.
      return;
    }
  }

  /**
   * NON-EMITTING FEEDER: synthesizes a hook-shaped event and routes it through
   * the SINGLE funnel `onHookEvent()`. Never calls `rotate()` / `emitRotated()`.
   * The no-hooks case means NO SessionStart fired to flip `mainSessionEnded`, so
   * we mirror `preemptOnSessionStart` first (gated identically) to make
   * `classify()` return 'restart' rather than 'foreign' while our PTY is alive.
   * Ownership is already proven (marker == our port), so the sibling guard
   * inside the pre-empt is satisfied. After the funnel runs, re-arm (a no-op by
   * construction for the dir-poll, but keeps the lifecycle explicit).
   */
  private feedSyntheticRotation(candidateId: string, candidatePath: string): void {
    if (this.mode === 'shadow') return;
    log(
      `[Binder] No-hooks rotation detected via dir poll: ${this.currentBoundId?.slice(0, 8) ?? 'none'} -> ${candidateId.slice(0, 8)} (${candidatePath})`,
    );
    const synthetic: BinderHookEvent = {
      session_id: candidateId,
      transcript_path: candidatePath,
      hook_event_name: 'DirPollRotation', // sentinel; not a real CC hook
    };
    try {
      // Flip mainSessionEnded so a different id with a live PTY classifies as a
      // restart, not foreign — the SessionStart that would normally do this
      // never arrived (the hooks-down premise of #452).
      this.preemptOnSessionStart(synthetic);
      this.onHookEvent(synthetic);
    } catch (err) {
      logError(`[Binder] synthetic rotation funnel failed: ${errorToString(err)}`);
    }
    // Re-arm for the NEXT rotation. The interval keeps running, so this is a
    // no-op in the common case; it only re-creates the timer if a prior
    // teardown nulled it (defensive, keeps the lifecycle symmetric).
    this.armRotationPoll(candidateId);
  }

  /** Current binding for callers that stamp outgoing messages. */
  snapshot(): { claudeSessionId: string | null; transcriptPath: string | null } {
    return {
      claudeSessionId: this.currentBoundId,
      transcriptPath: this.lastTranscriptPath,
    };
  }

  /**
   * Whether our main session has ended (SessionEnd id-match fired and no
   * subsequent restart reset it). Read by the bridge's post-SessionEnd
   * Notification drop so that gate reads the binder's single source of truth in
   * drive mode rather than a duplicated closure flag (the closure
   * `mainSessionEnded` is reset on restart by `rotate()`; mirroring that reset
   * outside the binder would be fragile). The Notification-drop gate itself is
   * a question-pipeline concern that moves onto the binder in phase 4.
   */
  isMainEnded(): boolean {
    return this.mainSessionEnded;
  }
}
