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

  private readonly deps: TranscriptBinderDeps;
  private readonly sessionId: UUID;
  private readonly workingDirectory: string;
  private readonly mode: BinderMode;

  constructor(deps: TranscriptBinderDeps, args: TranscriptBinderArgs, mode: BinderMode) {
    this.deps = deps;
    this.sessionId = args.sessionId;
    this.workingDirectory = args.workingDirectory;
    this.mode = mode;
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
    const classification = this.classify(event.session_id);

    if (classification === 'foreign') {
      return {
        classification: 'foreign',
        wouldEmitRotation: false,
        wouldStartWatcher: false,
        watcherPath: null,
        boundIdAfter: this.currentBoundId,
      };
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
    const classification = this.classify(event.session_id);

    if (classification === 'foreign') {
      log(
        `[Binder] Dropped foreign ${event.hook_event_name ?? 'event'}: lock=${this.currentBoundId?.slice(0, 8)} incoming=${event.session_id.slice(0, 8)}`,
      );
      return;
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
   * Arm the transcript discovery. In SHADOW mode this is a NO-OP (no fs.watch,
   * no fallback timer — the binder is provably side-effect-free, design §3.1
   * v4 #8). In DRIVE mode it arms the existing fallback poll only.
   *
   * TODO(#453 commit 4): add the re-arming directory watcher (the #452
   * no-hooks-rotation fix) here. That is a separate commit; this seam stays
   * fallback-poll-only for now.
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
  }

  /**
   * Single teardown owner: clears the watcher AND the fallback/dir-watch timer
   * (fixes the transcriptFallbackTimers leak at cli.ts:822-829).
   */
  close(): void {
    this.teardownWatcher('close');
    this.cancelFallbackTimer();
  }

  /** Current binding for callers that stamp outgoing messages. */
  snapshot(): { claudeSessionId: string | null; transcriptPath: string | null } {
    return {
      claudeSessionId: this.currentBoundId,
      transcriptPath: this.lastTranscriptPath,
    };
  }
}
