/** Launch-time read-only capture (#1620). No wire authority, PTY input or replay sink. */
import { realpathSync } from 'node:fs';
import type { PTYObservation, PTYSession } from '../pty/pty-session.ts';
import { TerminalReservationError, TerminalReservations } from './reservations.ts';
import { BoundedScreen, SCREEN_LIMITS, type ScreenSnapshot } from './screen.ts';

// Native PTY reads can fragment a 32 KiB redraw into many 1 KiB callbacks.
// Coalesce into one owned bounded operation, without raising the primitive's limits.
const INGRESS_BATCH_BYTES = 16 * 1024;

export interface BorrowedTerminalFrame {
  readonly revision: number;
  readonly snapshot: ScreenSnapshot;
  /** Drop the frame/projection before releasing its accounting slot. */
  release(): void;
}
export interface TerminalCaptureContext {
  readonly revision: number;
  readonly available: boolean;
  borrow(): BorrowedTerminalFrame | null;
}
interface Capture {
  readonly sessionId: string;
  readonly reservation: string;
  readonly ledger: TerminalReservations;
  context: TerminalCaptureContext | null;
  observation: PTYObservation | null;
  screen: BoundedScreen | null;
  ingress: { readonly bytes: Uint8Array; used: number } | null;
  revision: number;
  retired: boolean;
  borrowed: boolean;
  monitoring: boolean;
  settled: boolean;
  safeToRelease: boolean;
  queued: boolean;
  idle: Promise<void>;
}

export class TerminalCaptureHost {
  private ledger: TerminalReservations | undefined;
  private readonly captures = new Map<string, Capture>();
  private readonly retiring = new Set<Capture>();
  private readonly cleanup: Capture[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closing = false;

  constructor(private readonly home: string) {}

  /** Startup admission only. A busy attempt has allocated no model or uncertain reservation. */
  async prepare(sessionId: string, pty: PTYSession): Promise<boolean> {
    if (this.closing || this.captures.has(sessionId) || pty.sessionState !== 'created')
      return false;
    const deadline = performance.now() + 50;
    let reservation: string;
    let ledger: TerminalReservations;
    for (;;) {
      if (this.closing || this.captures.has(sessionId) || pty.sessionState !== 'created')
        return false;
      try {
        ledger = this.ledger ??= TerminalReservations.open(realpathSync(this.home));
        reservation = ledger.reserveModel(sessionId);
        break;
      } catch (error) {
        if (
          !(error instanceof TerminalReservationError) ||
          error.code !== 'busy' ||
          performance.now() >= deadline ||
          this.closing
        )
          return false;
        const remaining = deadline - performance.now();
        if (remaining <= 0) return false;
        await Bun.sleep(Math.min(1, remaining));
        if (performance.now() >= deadline) return false;
      }
    }
    const capture: Capture = {
      sessionId,
      reservation,
      ledger,
      context: null,
      observation: null,
      screen: null,
      ingress: null,
      revision: 0,
      retired: false,
      borrowed: false,
      monitoring: false,
      settled: false,
      safeToRelease: true,
      queued: false,
      idle: Promise.resolve(),
    };
    const host = this;
    capture.context = Object.freeze({
      get revision() {
        return capture.revision;
      },
      get available() {
        return host.available(capture);
      },
      borrow: () => host.borrow(capture),
    });
    this.captures.set(sessionId, capture);
    capture.observation = pty.observeFromLaunch({
      starting: (size) => {
        capture.screen = new BoundedScreen(size.cols, size.rows);
        if (!capture.screen.available) this.retire(capture);
      },
      output: (bytes) => {
        if (!this.ingest(capture, bytes) || !this.advance(capture)) this.retire(capture);
        else this.monitor(capture);
      },
      resized: (size) => {
        if (
          !this.flushIngress(capture) ||
          !capture.screen?.resize(size.cols, size.rows) ||
          !this.advance(capture)
        )
          this.retire(capture);
        else this.monitor(capture);
      },
      ended: () => this.retire(capture),
      unavailable: () => this.retire(capture),
    });
    if (!capture.observation || this.closing || pty.sessionState !== 'created') {
      this.retire(capture);
      return false;
    }
    return true; // Prepared, not a claim that a running/current screen is available yet.
  }

  private advance(capture: Capture): boolean {
    if (capture.revision === Number.MAX_SAFE_INTEGER) return false;
    capture.revision++;
    return true;
  }

  private ingest(capture: Capture, bytes: Uint8Array): boolean {
    const screen = capture.screen;
    if (screen?.available && !bytes.byteLength) return true;
    if (
      !screen?.available ||
      bytes.byteLength >
        SCREEN_LIMITS.queuedBytes - screen.pending.bytes - (capture.ingress?.used ?? 0)
    )
      return false;
    const ingress = capture.ingress;
    if (ingress) {
      if (bytes.byteLength <= ingress.bytes.byteLength - ingress.used) {
        ingress.bytes.set(bytes, ingress.used);
        ingress.used += bytes.byteLength;
        return true;
      }
      if (!this.flushIngress(capture)) return false;
    }
    if (!screen.pending.operations || bytes.byteLength >= INGRESS_BATCH_BYTES)
      return screen.observe(bytes);
    if (screen.pending.operations >= SCREEN_LIMITS.queuedOperations) return false;
    // Capacity, including unused padding, plus primitive-owned bytes never exceeds 64 KiB.
    const capacity = Math.min(
      INGRESS_BATCH_BYTES,
      SCREEN_LIMITS.queuedBytes - screen.pending.bytes,
    );
    if (capacity < bytes.byteLength) return false;
    const buffer = new Uint8Array(capacity);
    buffer.set(bytes);
    capture.ingress = { bytes: buffer, used: bytes.byteLength };
    return true;
  }

  private flushIngress(capture: Capture): boolean {
    const ingress = capture.ingress;
    if (!ingress) return !!capture.screen?.available;
    capture.ingress = null;
    // At most 16 KiB of transient handoff storage. Later reads never retain the old batch.
    return !!capture.screen?.observe(ingress.bytes.subarray(0, ingress.used));
  }

  private monitor(capture: Capture): void {
    if (capture.monitoring || !capture.screen || capture.retired) return;
    capture.monitoring = true;
    void capture.screen.whenIdle().then(() => {
      capture.monitoring = false;
      if (capture.retired) return;
      if (!capture.screen?.available || !this.flushIngress(capture)) this.retire(capture);
      else if (capture.screen.pending.operations) this.monitor(capture);
    });
  }

  private available(capture: Capture): boolean {
    if (capture.retired || this.captures.get(capture.sessionId) !== capture) return false;
    if (
      (capture.observation && !capture.observation.active) ||
      (capture.screen && !capture.screen.available)
    ) {
      this.retire(capture);
      return false;
    }
    return !!capture.observation?.running && !!capture.screen?.available;
  }

  contextFor(sessionId: string): TerminalCaptureContext | null {
    const capture = this.captures.get(sessionId);
    return capture && this.available(capture) ? capture.context : null;
  }

  private borrow(capture: Capture): BorrowedTerminalFrame | null {
    if (
      !this.available(capture) ||
      capture.borrowed ||
      capture.ingress ||
      capture.screen?.pending.operations
    )
      return null;
    try {
      if (!capture.ledger.owns(capture.reservation)) {
        this.retire(capture);
        return null;
      }
    } catch (error) {
      if (!(error instanceof TerminalReservationError) || error.code !== 'busy')
        this.retire(capture);
      return null; // A busy quota check permits no frame, and does not invent lost ownership.
    }
    const snapshot = capture.screen?.snapshot();
    if (!snapshot) {
      if (!capture.screen?.available) this.retire(capture);
      return null;
    }
    capture.borrowed = true;
    let released = false;
    return Object.freeze({
      revision: capture.revision,
      snapshot,
      release: () => {
        if (released) return;
        released = true;
        capture.borrowed = false;
        this.queueCleanup(capture);
      },
    });
  }

  retireSession(sessionId: string): void {
    const capture = this.captures.get(sessionId);
    if (capture) this.retire(capture);
  }

  private retire(capture: Capture): void {
    if (capture.retired) return;
    capture.retired = true;
    if (this.captures.get(capture.sessionId) === capture) this.captures.delete(capture.sessionId);
    capture.observation?.dispose();
    capture.observation = null;
    const screen = capture.screen;
    capture.screen = null;
    capture.ingress = null;
    try {
      screen?.retire();
    } catch {
      capture.safeToRelease = false;
    } // Unconfirmed disposal retains charge until process death.
    capture.idle = screen?.whenIdle() ?? Promise.resolve();
    this.retiring.add(capture);
    void capture.idle.then(() => {
      capture.settled = true;
      this.queueCleanup(capture);
    });
  }

  private queueCleanup(capture: Capture): void {
    if (
      !capture.retired ||
      !capture.settled ||
      capture.borrowed ||
      !capture.safeToRelease ||
      capture.queued
    )
      return;
    capture.queued = true;
    this.cleanup.push(capture);
    this.schedule(0);
  }

  private schedule(milliseconds: number): void {
    if (this.closing || this.timer || !this.cleanup.length) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flushOne();
      this.schedule(250);
    }, milliseconds);
    this.timer.unref();
  }

  /** At most one nonblocking filesystem transaction per scheduled cleanup tick. */
  private flushOne(): void {
    const capture = this.cleanup.shift();
    if (!capture) return;
    try {
      capture.ledger.release(capture.reservation);
      // false leaves any foreign charge untouched; an ambiguous prior release
      // may already have removed our row. Content is disposed in either case.
      capture.queued = false;
      this.retiring.delete(capture);
    } catch {
      this.cleanup.push(capture); // Live metadata debt stays charged; no raw-output I/O or replay.
    }
  }

  async closeAll(): Promise<boolean> {
    this.closing = true;
    for (const capture of this.captures.values()) this.retire(capture);
    await Promise.all([...this.retiring].map((capture) => capture.idle));
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const attempts = this.cleanup.length;
    for (let index = 0; index < attempts; index++) this.flushOne();
    // Stop retries after shutdown. Any unconfirmed charge remains until process death.
    return this.retiring.size === 0;
  }
}
