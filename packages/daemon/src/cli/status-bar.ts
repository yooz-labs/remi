/**
 * Reserved last-row status bar for wrapper mode (#565).
 *
 * remi is the PTY wrapper; Claude is its child. By reporting `rows - 1` to
 * Claude's PTY winsize (see `computeTermSize` / the resize handler), Claude
 * lays out entirely within rows `1..N-1` and never touches the real terminal's
 * last row. remi then owns row `N` exclusively and draws a persistent status
 * bar there — visible even while Claude shows a permission/question prompt,
 * which is exactly when the native `statusLine` cue (#560) is hidden.
 *
 * The draw is bracketed by DECSC/DECRC (ESC7/ESC8) save/restore so it never
 * disturbs Claude's cursor position or character rendition. Origin mode is
 * forced off (`ESC[?6l`) for the absolute cursor move so that any scroll region
 * Claude may have set (DECSTBM) cannot clamp the write up into Claude's content
 * area. DECSC also saves/restores origin mode, so forcing it off is transparent
 * to Claude.
 *
 * Every path fails safe to "no bar": the renderer no-ops when disabled, when
 * the wrapper has detached (stdout fd is null), or when the terminal is too
 * short to spare a row. A render error backs the bar off rather than crashing
 * the wrapper.
 */

import * as fs from 'node:fs';
import { errorToString } from '@remi/shared';
import { ESCALATE_FRESH_S, type RemiStatus } from './status-writer.ts';

/** Rows reserved for the status bar. */
export const RESERVED_ROWS = 1;
/** A bar needs at least one row for Claude plus one for itself. */
export const MIN_ROWS_FOR_BAR = 2;
/** Leak-safety cap: a stuck `inFlight` stops reading as "evaluating" after this
 *  many seconds (mirrors the 600s in statusline-installer.ts). */
export const EVALUATING_CAP_S = 600;
/** An 'approved' verdict fades from the bar after this many seconds (mirrors the
 *  5s in statusline-installer.ts). */
export const APPROVED_FRESH_S = 5;
/** Consecutive render failures tolerated before the bar backs off for good. A
 *  single transient write error (e.g. an interrupted syscall) must not silence
 *  the bar for the whole session; a genuinely dead fd trips this within seconds. */
export const MAX_RENDER_ERRORS = 3;

/**
 * Rows to report to the child PTY given the real terminal height and whether
 * the status bar is reserving its row. Reserves only when there is room — a
 * 1-row terminal gives every row to Claude (no bar).
 */
export function childRows(realRows: number, reserve: boolean): number {
  return reserve && realRows >= MIN_ROWS_FOR_BAR ? realRows - RESERVED_ROWS : realRows;
}

/**
 * Build the human-readable status string (no styling, no truncation). Mirrors
 * the render logic in `statusline-installer.ts` so the reserved-row bar and the
 * native statusLine agree on what the auto-approve state reads as.
 *
 *   remi:<port> <repo>:<branch> | <N> client(s) | <state>
 *
 * `state` is the live auto-approve cue when a permission is being decided
 * (`evaluating Ns` / `needs you` / `approved`), otherwise Claude's agent status.
 */
export function formatStatusBar(status: Readonly<RemiStatus>, nowMs: number): string {
  const nowS = Math.floor(nowMs / 1000);
  const aa = status.autoApprove;
  const elapsed = nowS - aa.sinceS;
  const age = nowS - aa.lastVerdictAtS;

  let state: string = status.sessionStatus;
  if (aa.inFlight > 0 && elapsed >= 0 && elapsed < EVALUATING_CAP_S) {
    state = `evaluating ${elapsed}s`;
  } else if (aa.lastVerdict === 'escalated' && age >= 0 && age < ESCALATE_FRESH_S) {
    state = 'needs you';
  } else if (aa.lastVerdict === 'approved' && age >= 0 && age < APPROVED_FRESH_S) {
    state = 'approved';
  }

  const clients = status.connections > 0 ? `${status.connections} client(s)` : 'no clients';
  const repoBranch = status.repo ? `${status.repo}:${status.branch}` : status.branch;
  const head = repoBranch ? `remi:${status.wsPort} ${repoBranch}` : `remi:${status.wsPort}`;
  return `${head} | ${clients} | ${state}`;
}

/**
 * Build the escape sequence that paints `text` on `row` (1-based) as a
 * full-width reverse-video bar, then restores the prior cursor + rendition.
 * `text` is truncated to `cols` and padded with spaces so the bar spans the
 * full width.
 */
export function buildBarSequence(row: number, cols: number, text: string): string {
  const visible = text.length > cols ? text.slice(0, cols) : text;
  const padded = visible.padEnd(cols, ' ');
  // ESC7   DECSC: save cursor, rendition, charset, origin mode
  // ESC[?6l DECOM off: absolute addressing, immune to a scroll region
  // ESC[r;1H CUP to the reserved row   ESC[2K erase line   ESC[7m reverse video
  // ESC[0m reset rendition             ESC8 DECRC: restore everything DECSC saved
  return `\x1b7\x1b[?6l\x1b[${row};1H\x1b[2K\x1b[7m${padded}\x1b[0m\x1b8`;
}

/** Build the escape sequence that clears `row` (on teardown). */
export function buildClearSequence(row: number): string {
  return `\x1b7\x1b[?6l\x1b[${row};1H\x1b[2K\x1b8`;
}

export interface StatusBarDeps {
  /** Real terminal stdout fd, or null once the wrapper has detached. */
  readonly getStdoutFd: () => number | null;
  /** Live status snapshot (the StatusWriter's in-memory object). */
  readonly getStatus: () => Readonly<RemiStatus>;
  /** Real terminal size (the full height, including the reserved row). */
  readonly getSize: () => { cols: number; rows: number };
  /** Master enable (config flag + wrapper mode + a real TTY). */
  readonly isEnabled: () => boolean;
  /** Write to the terminal fd. Injectable for tests; defaults to fs.writeSync. */
  readonly writeToFd?: (fd: number, data: string) => void;
  /** Current epoch ms. Injectable for tests; defaults to Date.now. */
  readonly now?: () => number;
  /** Logger for render-failure notes. Required so a draw failure is never
   *  silently swallowed by an accidental no-op default. */
  readonly log: (msg: string) => void;
  /** Refresh cadence in ms. Default 1000 (the `evaluating Ns` counter ticks 1Hz). */
  readonly intervalMs?: number;
}

/**
 * Owns the reserved-row redraw loop. `start()` paints immediately and then on a
 * 1Hz timer; the unconditional periodic repaint keeps the bar asserted even if
 * Claude's output scrolled it (inline mode) since the last tick. `stop()` clears
 * the row and halts the loop. All draws are no-ops unless `isEnabled()` and a
 * live fd and enough rows.
 */
export class StatusBar {
  private timer: ReturnType<typeof setInterval> | null = null;
  private errorLogged = false;
  /** Consecutive render failures; reset to 0 on any success. */
  private consecutiveErrors = 0;
  /** Set after MAX_RENDER_ERRORS consecutive failures; the bar backs off for
   *  good (the fd has gone bad). A success before then clears the streak. */
  private disabled = false;
  private readonly getStdoutFd: () => number | null;
  private readonly getStatus: () => Readonly<RemiStatus>;
  private readonly getSize: () => { cols: number; rows: number };
  private readonly isEnabled: () => boolean;
  private readonly writeToFd: (fd: number, data: string) => void;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly intervalMs: number;

  constructor(deps: StatusBarDeps) {
    this.getStdoutFd = deps.getStdoutFd;
    this.getStatus = deps.getStatus;
    this.getSize = deps.getSize;
    this.isEnabled = deps.isEnabled;
    this.writeToFd = deps.writeToFd ?? ((fd, data) => fs.writeSync(fd, data));
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log;
    this.intervalMs = deps.intervalMs ?? 1000;
  }

  /** Begin the redraw loop (idempotent). Paints once immediately. */
  start(): void {
    if (this.timer || this.disabled) return;
    this.render();
    // A single failing initial paint does not disable the bar (the loop retries
    // up to MAX_RENDER_ERRORS); only a prior permanent back-off skips the timer.
    if (this.disabled) return;
    this.timer = setInterval(() => this.render(), this.intervalMs);
    // The bar must never, on its own, keep the process alive.
    this.timer.unref?.();
  }

  /** Halt the redraw loop and clear the reserved row (idempotent). */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.clearRow();
  }

  /** Paint the reserved row now. Safe no-op when disabled / detached / no room. */
  render(): void {
    if (this.disabled || !this.isEnabled()) return;
    const fd = this.getStdoutFd();
    if (fd === null) return;
    const { cols, rows } = this.getSize();
    if (rows < MIN_ROWS_FOR_BAR || cols < 1) return;
    // The whole draw stays inside the try: an exception escaping into the
    // setInterval callback would surface as an uncaughtException and could take
    // the wrapper down — the one thing a cosmetic bar must never do. The
    // accessors and pure builders don't throw over a well-typed status, so in
    // practice only the fd write can fail here.
    try {
      const text = formatStatusBar(this.getStatus(), this.now());
      this.writeToFd(fd, buildBarSequence(rows, cols, text));
      this.consecutiveErrors = 0;
      this.errorLogged = false;
    } catch (err) {
      // Log the first failure of a streak (a later success clears it, so a new
      // streak logs again). Back off for good only after repeated failures so a
      // single transient error doesn't silence the bar for the whole session.
      this.consecutiveErrors += 1;
      if (!this.errorLogged) {
        this.log(
          `[status-bar] render failed (backs off after ${MAX_RENDER_ERRORS}): ${errorToString(err)}`,
        );
        this.errorLogged = true;
      }
      if (this.consecutiveErrors >= MAX_RENDER_ERRORS) {
        this.disabled = true;
        if (this.timer) {
          clearInterval(this.timer);
          this.timer = null;
        }
      }
    }
  }

  private clearRow(): void {
    if (this.disabled) return;
    const fd = this.getStdoutFd();
    if (fd === null) return;
    const { rows } = this.getSize();
    if (rows < MIN_ROWS_FOR_BAR) return;
    try {
      this.writeToFd(fd, buildClearSequence(rows));
    } catch (err) {
      // Teardown path: the terminal may already be gone on SIGHUP. Nothing to
      // recover, but on a keybinding-detach with a live fd a failed clear leaves
      // a stale row in the returned shell, so leave a diagnostic.
      this.log(`[status-bar] clear failed on teardown: ${errorToString(err)}`);
    }
  }
}
