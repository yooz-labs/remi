/**
 * Reserved last-row status bar for wrapper mode (#565).
 *
 * remi is the PTY wrapper; Claude is its child. Two mechanisms together keep
 * the last row remi's alone:
 *   1. **winsize** — report `rows - 1` to Claude's PTY (see `computeTermSize` /
 *      the resize handler) so Claude lays out within rows `1..N-1`.
 *   2. **scroll region** — set DECSTBM to `1..N-1` (in every bar paint) so the
 *      terminal can only scroll the rows above the bar. The winsize trick alone
 *      is insufficient because Claude renders inline (no alternate screen): on
 *      output the terminal would scroll the whole screen and the bar would
 *      bleed up into Claude's content. The region pins row `N` fixed.
 *
 * remi then owns row `N` exclusively and draws a persistent status bar there —
 * visible even while Claude shows a permission/question prompt, which is exactly
 * when the native `statusLine` cue (#560) is hidden.
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
 *
 * Exposure reduction (#932, PR #933): this bar and Claude's own PTY output
 * are two writers on the same fd, both synchronous `fs.writeSync` in the
 * same process and thread -- so byte-level interleaving WITHIN one write is
 * not the mechanism. The real hazard is a paint landing BETWEEN two PTY-
 * forwarding chunks, at a boundary that happens to split one of Claude's
 * own escape sequences (the DECSC/DECRC pair above shares Claude's own
 * cursor-save slot -- 166/421 occurrences in the installed binary). PR #933
 * did not fix that; it only cut how often a paint is attempted:
 *   1. `render()` no-ops while `hasLiveQuestions()` reports a pending
 *      question -- except for one fresh paint on the transition INTO that
 *      state (see `render()`'s `onset`), so the bar is current the moment
 *      Claude's native statusLine (#560) disappears for an AskUserQuestion
 *      dialog, then freezes rather than risk a later paint landing
 *      mid-render. One more forced paint on the transition back OUT (see
 *      `resumed`) recovers row N before normal cadence resumes, since the
 *      dialog may have redrawn it while it owned the screen.
 *   2. A paint whose built escape sequence is byte-identical to the last one
 *      actually written is skipped -- most ticks rewrite identical bytes, and
 *      every write is an exposure window -- but only up to `HEARTBEAT_MS`: an
 *      unbounded skip would stop reasserting DECSTBM (see `buildBarSequence`)
 *      and trade this exposure for the region-reset bleed it exists to
 *      prevent. `stop()` resets this so the next `render()` after a restart
 *      always writes unconditionally.
 *
 * Protection 2 is also a restoration, not a new optimization: #565 specified
 * redraw "on: status change ... and on resize." The unconditional ~250ms
 * timer was added later, in #576, and exceeded that original design.
 *
 * The durable fix (#932 follow-up, this file's `isBoundaryClean` /
 * `isQuiescent` deps): a quiescence + clean-boundary gate, backed by
 * `PtyQuiescenceGate` (`pty-quiescence-gate.ts`), a small scanner over the
 * PTY chunks actually forwarded to this fd. `isBoundaryClean()` is a HARD
 * requirement checked before every write, with no exceptions -- a paint can
 * no longer land at a boundary that splits one of Claude's own escape
 * sequences, making that hazard ("mode 1") structurally impossible rather
 * than just less frequent. `isQuiescent()` is a SOFT requirement that only
 * gates a routine (non-edge, non-heartbeat) paint, reducing but not
 * eliminating "mode 2" (a paint landing inside a save/restore pair that
 * spans a quiet gap -- an accepted residual, see `pty-quiescence-gate.ts`).
 * Both deps default to always-true (same fail-open pattern as
 * `hasLiveQuestions`) so a caller that omits them -- tests, or a bar not
 * wired to a PTY forwarder -- keeps pre-gate behavior. See `render()` for
 * how the hard/soft split interacts with the heartbeat and the
 * onset/resumed edges without weakening either.
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
/** Upper bound (ms) on how long an unchanged-status paint can be skipped
 *  (#932). Every paint re-asserts DECSTBM (see `buildBarSequence`); skipping
 *  unchanged paints forever would mean that assertion never fires while the
 *  status happens to sit still, and Claude's own binary can reset the region
 *  (`ESC[r`) at any time. 2000ms keeps that gap bounded to well under what a
 *  user would notice as "the bar stopped updating," while still cutting the
 *  write rate roughly 8x versus the old unconditional 250ms cadence -- most
 *  of protection 2's exposure reduction. Not configurable: it exists to keep
 *  the dedup and the region invariant coupled, not to be tuned per caller.
 *
 *  #932 durable fix interaction: `render()`'s soft quiescence gate
 *  (`isQuiescent`) is bypassed once this heartbeat is due, precisely so a
 *  continuously streaming Claude session cannot defer this reassertion
 *  indefinitely -- the heartbeat still fires within `HEARTBEAT_MS` of the
 *  last write, unchanged from before the durable fix. The HARD boundary
 *  gate (`isBoundaryClean`) is NOT bypassed for the heartbeat, and cannot
 *  be: writing at a dirty boundary is the exact hazard the gate exists to
 *  prevent, so weakening it here would defeat the fix it is coupled to. In
 *  the realistic case this costs nothing -- an escape sequence completes
 *  within the same or the very next PTY chunk, microseconds to
 *  milliseconds, not a measurable fraction of 2000ms (see
 *  `pty-quiescence-gate.ts`'s capture data). The only way the boundary gate
 *  could delay a heartbeat past this window is a pathologically long
 *  unterminated sequence -- effectively the same failure mode
 *  `MAX_RENDER_ERRORS` and the config kill-switch already exist as escape
 *  hatches for, and, like mode 2, an accepted residual rather than
 *  something this gate can close without becoming a full VT emulator. */
export const HEARTBEAT_MS = 2000;

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

  // #755: label from the REAL attach state (the session's attached-connections
  // set, #795), not the raw connection counter — `connections` also counts
  // query-mode utility clients (remi ls / kill / phone list polls), which is
  // how the bar used to read "1 client(s)" with nobody attached. `queued` is
  // always 0 now that there is no more exclusive lock/FIFO queue; the
  // "+N waiting" branch below is dead code kept only for an older daemon
  // writing this same status file. Fall back to the old counter label only
  // when the attach fields are absent (older writer).
  const queued = status.queuedCount ?? 0;
  const clients =
    status.attached === undefined
      ? status.connections > 0
        ? `${status.connections} client(s)`
        : 'no clients'
      : status.attached
        ? queued > 0
          ? `attached (+${queued} waiting)`
          : 'attached'
        : queued > 0
          ? `${queued} waiting`
          : 'no clients';
  const repoBranch = status.repo ? `${status.repo}:${status.branch}` : status.branch;
  const head = repoBranch ? `remi:${status.wsPort} ${repoBranch}` : `remi:${status.wsPort}`;
  return `${head} | ${clients} | ${state}`;
}

/**
 * Build the escape sequence that paints `text` on `row` (1-based) as a
 * full-width reverse-video bar, then restores the prior cursor + rendition.
 * `text` is truncated to `cols` and padded with spaces so the bar spans the
 * full width.
 *
 * Crucially it also sets the **scroll region** (DECSTBM) to rows `1..row-1`.
 * The winsize trick alone is not enough: Claude renders inline (no alternate
 * screen), so without a scroll region the terminal scrolls the *whole* screen
 * on output and the bar bleeds up into Claude's content (#565). With the region
 * pinned to `1..row-1`, the terminal can only scroll the rows above the bar, so
 * `row` stays fixed. The region is re-asserted on every paint in case Claude
 * ever resets it (#932: this is why `StatusBar.render()`'s change-detection
 * dedup is bounded by `HEARTBEAT_MS` rather than unconditional -- skipping
 * this call forever would mean the region is never reasserted). DECSTBM
 * homes the cursor, but DECSC/DECRC (ESC7/ESC8) restore it, and DECRC does
 * not touch the region, so the region persists after.
 */
export function buildBarSequence(row: number, cols: number, text: string): string {
  const visible = text.length > cols ? text.slice(0, cols) : text;
  const padded = visible.padEnd(cols, ' ');
  // ESC7     DECSC: save cursor, rendition, charset, origin mode
  // ESC[?6l  DECOM off: absolute addressing, so CUP can reach row `row`
  // ESC[1;Nr DECSTBM: scroll region = rows 1..row-1 (protects the bar row)
  // ESC[r;1H CUP to the bar row   ESC[2K erase line   ESC[7m reverse video
  // ESC[0m   reset rendition      ESC8 DECRC: restore cursor (region persists)
  return `\x1b7\x1b[?6l\x1b[1;${row - 1}r\x1b[${row};1H\x1b[2K\x1b[7m${padded}\x1b[0m\x1b8`;
}

/**
 * Build the escape sequence that resets the scroll region to the full screen
 * (ESC[r) and clears `row`, handing the terminal back clean on teardown.
 * Bracketed by DECSC/DECRC so Claude's cursor is preserved; DECRC does not
 * restore the region, so the full-screen region persists.
 */
export function buildClearSequence(row: number): string {
  return `\x1b7\x1b[?6l\x1b[r\x1b[${row};1H\x1b[2K\x1b8`;
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
  /** True iff the session currently has at least one pending question
   *  (mirrors `hasLiveQuestions` in `question-presence-tracker.ts`, backed by
   *  `sessionRegistry.getSession(id)?.currentQuestions.size > 0`). #932:
   *  `render()` paints once on the transition into this being true, then
   *  freezes for as long as it stays true, then paints once more on the
   *  transition back out before resuming normal cadence -- so the bar can
   *  never paint over a live prompt but also never freezes on stale content
   *  (see `render()`'s `onset` / `resumed`). Optional; defaults to
   *  always-false (no suppression) so a caller that omits it keeps the
   *  pre-#932 behavior instead of silently losing the bar.
   *
   *  Session-wide, not agent-scoped: it is true whenever ANY agent in the
   *  session has a pending question, so in a concurrent multi-agent session
   *  (Agent Teams, Task-tool subagents) the freeze can span output from an
   *  UNRELATED agent that is still actively writing to this same PTY/fd
   *  while a different agent's question sits open. The protection this
   *  buys is deliberately biased toward never painting over a real prompt,
   *  not toward a precise per-agent freeze window -- see #932's PR
   *  discussion for the full reasoning on why that tradeoff was kept. */
  readonly hasLiveQuestions?: () => boolean;
  /** #932 durable fix, HARD gate: true iff a write right now would NOT land
   *  inside an unterminated Claude escape sequence -- backed by
   *  `PtyQuiescenceGate.isBoundaryClean()` fed from the PTY chunks actually
   *  forwarded to this fd (see `pty-quiescence-gate.ts`). `render()` checks
   *  this before every write, with no exceptions -- not even for the
   *  heartbeat or an onset/resumed edge paint -- because writing at a dirty
   *  boundary is the exact hazard the gate exists to make structurally
   *  impossible. Optional; defaults to always-true (same fail-open pattern
   *  as `hasLiveQuestions`) so a caller that omits it -- tests, or a bar
   *  not wired to a PTY forwarder -- keeps pre-gate behavior. */
  readonly isBoundaryClean?: () => boolean;
  /** #932 durable fix, SOFT gate: true iff the PTY has been quiet for at
   *  least `QUIESCENCE_MS` (`pty-quiescence-gate.ts`). Unlike
   *  `isBoundaryClean`, this gate has documented exceptions: a heartbeat-due
   *  write, and the onset/resumed edge paints, all proceed as soon as
   *  `isBoundaryClean()` allows even when this is false -- otherwise a
   *  continuously streaming Claude session could starve the heartbeat's
   *  DECSTBM reassertion or delay an onset/resumed capture past the moment
   *  it is meant to capture. Only a routine (content-changed,
   *  non-edge/non-heartbeat) paint waits on this. Optional; defaults to
   *  always-true, same fail-open pattern as the other predicates here. */
  readonly isQuiescent?: () => boolean;
  /** Write to the terminal fd. Injectable for tests; defaults to fs.writeSync. */
  readonly writeToFd?: (fd: number, data: string) => void;
  /** Current epoch ms. Injectable for tests; defaults to Date.now. */
  readonly now?: () => number;
  /** Logger for render-failure notes. Required so a draw failure is never
   *  silently swallowed by an accidental no-op default. */
  readonly log: (msg: string) => void;
  /** Refresh cadence in ms. Default 250 so the `evaluating Ns` counter and AA
   *  state changes feel smooth (#576). The repaint reads in-memory status only —
   *  no disk I/O — so a faster cadence costs just one small fd write per tick. */
  readonly intervalMs?: number;
}

/**
 * Owns the reserved-row redraw loop. `start()` paints immediately and then on a
 * ~250ms timer (#576) so the `evaluating Ns` counter stays smooth. Each tick
 * still calls `render()` unconditionally, but `render()` itself now (#932)
 * skips the actual fd write when the built sequence is unchanged from the
 * last one written AND less than `HEARTBEAT_MS` has passed since the last
 * write -- so a byte-identical status (the common case) mostly costs no
 * write, while the DECSTBM re-assertion `buildBarSequence` depends on still
 * happens at least every `HEARTBEAT_MS` regardless. While a question is
 * live, every tick is a no-op EXCEPT the first one after the transition
 * into "live" and the first one after the transition back out, both of
 * which always write (edge-triggered onset/resume paints, not the
 * dedup/heartbeat path). `stop()` clears the row and halts the loop. All
 * draws are no-ops unless `isEnabled()` and a live fd and enough rows.
 */
export class StatusBar {
  private timer: ReturnType<typeof setInterval> | null = null;
  private errorLogged = false;
  /** Consecutive render failures; reset to 0 on any success. */
  private consecutiveErrors = 0;
  /** Set after MAX_RENDER_ERRORS consecutive failures; the bar backs off for
   *  good (the fd has gone bad). A success before then clears the streak. */
  private disabled = false;
  /** The last escape sequence actually written, or null before the first
   *  write (or right after `stop()`). #932 protection 2: a paint identical to
   *  this is skipped rather than rewritten, bounded by `lastWriteAtMs` /
   *  `HEARTBEAT_MS` below. */
  private lastRendered: string | null = null;
  /** Epoch ms of the last actual write, or null before the first write (or
   *  right after `stop()`). #932: a paint is forced once `HEARTBEAT_MS` has
   *  elapsed since this, even if `lastRendered` is unchanged -- see
   *  `HEARTBEAT_MS`'s doc for why this must stay bounded. */
  private lastWriteAtMs: number | null = null;
  /** True while the last `render()` call observed a live question. #932:
   *  `render()` compares this against the current `hasLiveQuestions()` read
   *  to detect both transitions -- INTO "live" and back OUT (edge, not
   *  level) -- see `render()` for why each edge forces a fresh paint. Reset
   *  by `stop()` so a restart starts from "not live" again. */
  private wasQuestionLive = false;
  /** Set by `notifyScrollRegionReset()`; cleared only once a write actually
   *  lands. #932: the ESC[r bonus signal -- if `isBoundaryClean()` refuses
   *  the immediate attempt (the reset chunk was followed by more bytes that
   *  left the stream mid-sequence), this stays true so the very next
   *  capable `render()` call -- the next tick, or the next chunk-triggered
   *  notify -- retries rather than the intent being silently dropped. */
  private forceRepaintPending = false;
  private readonly getStdoutFd: () => number | null;
  private readonly getStatus: () => Readonly<RemiStatus>;
  private readonly getSize: () => { cols: number; rows: number };
  private readonly isEnabled: () => boolean;
  private readonly hasLiveQuestions: () => boolean;
  private readonly isBoundaryClean: () => boolean;
  private readonly isQuiescent: () => boolean;
  private readonly writeToFd: (fd: number, data: string) => void;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly intervalMs: number;

  constructor(deps: StatusBarDeps) {
    this.getStdoutFd = deps.getStdoutFd;
    this.getStatus = deps.getStatus;
    this.getSize = deps.getSize;
    this.isEnabled = deps.isEnabled;
    this.hasLiveQuestions = deps.hasLiveQuestions ?? (() => false);
    this.isBoundaryClean = deps.isBoundaryClean ?? (() => true);
    this.isQuiescent = deps.isQuiescent ?? (() => true);
    this.writeToFd = deps.writeToFd ?? ((fd, data) => fs.writeSync(fd, data));
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log;
    this.intervalMs = deps.intervalMs ?? 250;
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
    // #932: the physical row is now the clear sequence, not `lastRendered`'s
    // bar sequence -- reset so a future render() after a restart always
    // writes unconditionally rather than comparing against stale content.
    this.lastRendered = null;
    this.lastWriteAtMs = null;
    this.wasQuestionLive = false;
    this.forceRepaintPending = false;
  }

  /**
   * #932 durable fix: notify the bar that the PTY-forwarding scanner just
   * observed Claude emit a bare `ESC[r` (DECSTBM full-screen scroll-region
   * reset) -- row N is unprotected until the region is re-asserted, so this
   * attempts an immediate repaint rather than waiting out the normal tick
   * or the up-to-`HEARTBEAT_MS` heartbeat window. Safe to call any time
   * (same guards as `render()` apply); if `isBoundaryClean()` still refuses
   * the attempt -- the reset chunk was followed by more bytes that left the
   * stream mid-sequence -- the intent is not dropped: it stays pending for
   * the next capable `render()` call (see `forceRepaintPending`'s doc).
   */
  notifyScrollRegionReset(): void {
    this.forceRepaintPending = true;
    this.render();
  }

  /** Paint the reserved row now. Safe no-op when disabled / detached / no
   *  room / a dirty escape-sequence boundary. While a question is live
   *  (#932), paints once on the transition into that state and freezes
   *  after; paints once more on the transition back out, then resumes
   *  normal cadence -- see the `onset`/`resumed` comment below for why both
   *  edges force a fresh paint. */
  render(): void {
    if (this.disabled || !this.isEnabled()) return;
    // fd/room/boundary checks come BEFORE hasLiveQuestions() is read and
    // wasQuestionLive is mutated (#932 review fix, preserved by the durable
    // fix): a transition landing on a tick where a paint isn't even
    // possible must not be consumed. If it were, the flag would flip with
    // no write to show for it, and the NEXT successful tick would compute
    // onset/resumed against the already-flipped flag -- neither true -- and
    // freeze on stale content for the rest of the window: the exact bug
    // this whole mechanism exists to prevent, reintroduced through
    // ordering. Same pattern `disabled`/`isEnabled()` above already use:
    // return before touching any state a later, capable tick still needs to
    // see as unconsumed.
    const fd = this.getStdoutFd();
    if (fd === null) return;
    const { cols, rows } = this.getSize();
    if (rows < MIN_ROWS_FOR_BAR || cols < 1) return;
    // #932 durable fix, HARD gate: a write can never land at a boundary
    // that splits one of Claude's own escape sequences -- this belongs in
    // the same "cannot physically paint" group as the fd/room checks above,
    // for the identical ordering reason: it must run before
    // hasLiveQuestions() so a question transition landing while the
    // boundary is dirty is never consumed either. No exception exists for
    // this gate -- not onset, not resumed, not the heartbeat -- because
    // writing here is not merely undesirable, it is the exact hazard #932
    // documents (a bar write parsed as the continuation of Claude's own
    // half-delivered sequence).
    if (!this.isBoundaryClean()) return;
    const questionLive = this.hasLiveQuestions();
    const wasLive = this.wasQuestionLive;
    this.wasQuestionLive = questionLive;
    // #932 protection 1 is edge-triggered, not level-triggered. Freezing row
    // N while a question is live is right, but freezing it on WHATEVER was
    // last painted is wrong: Claude's native statusLine (#560) disappears
    // entirely while an AskUserQuestion dialog is open, so this bar is
    // exactly the cue that has to be current the moment that happens -- not
    // up to `HEARTBEAT_MS` stale. `onset` is true only on the first
    // render() call after the transition into "live"; it forces one fresh
    // paint below, capturing the status at that instant. Every later call
    // while still live hits the early return just below. `resumed` is the
    // mirror on the way back out: the dialog may have redrawn or consumed
    // row N while it owned the screen, so the physical row cannot be
    // trusted to still match `lastRendered` either -- the very first
    // render() after the question clears also forces a fresh paint, then
    // normal dedup/heartbeat cadence takes back over.
    const onset = questionLive && !wasLive;
    const resumed = !questionLive && wasLive;
    if (questionLive && !onset) return;
    // The whole draw stays inside the try: an exception escaping into the
    // setInterval callback would surface as an uncaughtException and could take
    // the wrapper down — the one thing a cosmetic bar must never do. The
    // accessors and pure builders don't throw over a well-typed status, so in
    // practice only the fd write can fail here.
    try {
      const text = formatStatusBar(this.getStatus(), this.now());
      const sequence = buildBarSequence(rows, cols, text);
      const nowMs = this.now();
      const heartbeatDue =
        this.lastWriteAtMs === null || nowMs - this.lastWriteAtMs >= HEARTBEAT_MS;
      // #932 durable fix: onset/resumed/heartbeat/an observed ESC[r all
      // bypass the SOFT quiescence gate below (they still obey the HARD
      // boundary gate above) -- each is either a correctness-critical
      // instant capture (onset/resumed) or an explicit bound that must not
      // be starved by continuous output (heartbeat's DECSTBM reassertion,
      // the scroll-region-reset recovery). This is the documented answer to
      // "what happens when the gate could defer a paint past the heartbeat
      // window": it cannot -- the heartbeat is exempt from the soft gate,
      // so it still fires within HEARTBEAT_MS of the last write regardless
      // of how busy the PTY is, same as before this fix.
      const bypassesQuiescence = onset || resumed || heartbeatDue || this.forceRepaintPending;
      // #932 protection 2 (unchanged): skip the write when nothing changed
      // since the last successful paint, UNLESS this is one of the forced
      // paths above.
      if (!bypassesQuiescence && sequence === this.lastRendered) return;
      // #932 durable fix, SOFT gate: a routine paint (content changed, none
      // of the forced reasons above) additionally waits for PTY quiescence
      // -- reduces "mode 2" exposure (a paint landing inside a save/restore
      // pair that spans a quiet gap). See `isQuiescent`'s doc for why this
      // check does not apply to the forced paths.
      if (!bypassesQuiescence && !this.isQuiescent()) return;
      this.writeToFd(fd, sequence);
      this.lastRendered = sequence;
      this.lastWriteAtMs = nowMs;
      this.forceRepaintPending = false;
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
