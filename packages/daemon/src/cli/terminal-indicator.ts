/**
 * Out-of-band terminal feedback for the auto-approve lifecycle (#513, epic
 * #481 item 5).
 *
 * Two channels, both written to the REAL terminal fd (the saved
 * `ptyStdoutFd`) as OSC escape sequences. OSC is out-of-band: it sets the
 * window title / fires a desktop notification without drawing into the screen
 * grid, so it never corrupts Claude's alternate-screen TUI (an in-viewport
 * "corner badge" would be overwritten on Claude's next redraw — the title bar
 * is the only cue channel that does not fight the renderer).
 *
 *  1. Animated TITLE status cue: a spinner while the LLM evaluates, then a
 *     check (auto-handled) or warning (escalated) glyph; restored to an idle
 *     title afterward.
 *  2. Escalation NOTIFICATION: a desktop notification at the escalate seam
 *     (osc9 / osc777 / bell / off), so a user looking away from a terminal
 *     that swallows the prompt (e.g. Ghostty) still gets pinged.
 *
 * The writer is injected, so the class is testable without a real terminal and
 * the production writer can guard on fd-present / not-detached and silently
 * no-op in headless/daemon mode.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { logError } from './logger.ts';
import { getPtyStdoutFd, isWrapperDetached } from './wrapper-state.ts';

const ESC = '\x1b';
const BEL = '\x07';

/** Where to fire the escalation notification. */
export type TerminalNotifyChannel = 'osc9' | 'osc777' | 'bell' | 'off';

export interface TerminalCueConfig {
  /** Escalation notification channel. 'off' disables it. */
  readonly notify: TerminalNotifyChannel;
  /** Animate the terminal title (evaluating spinner -> done/needs-you). */
  readonly statusCue: boolean;
}

/** Spinner frames (braille) cycled while the eval is in flight. */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

const SPINNER_INTERVAL_MS = 120;
/** How long the ✓ title lingers before restoring the idle title. */
const HANDLED_LINGER_MS = 1500;

/**
 * Strip the bytes that would terminate or break out of an OSC string, so an
 * interpolated value can never inject its own escape sequence. Our texts are
 * static today; this is defensive for future dynamic titles.
 */
function sanitize(text: string): string {
  return text.replace(/[\x00-\x1f\x7f]/g, ' ');
}

/** OSC 2: set the window/tab title. */
export function oscTitle(text: string): string {
  return `${ESC}]2;${sanitize(text)}${BEL}`;
}

/** OSC 9: iTerm2 / Ghostty desktop notification (single string). */
export function osc9Notify(text: string): string {
  return `${ESC}]9;${sanitize(text)}${BEL}`;
}

/** OSC 777: kitty / wezterm / urxvt desktop notification (title + body). */
export function osc777Notify(title: string, body: string): string {
  return `${ESC}]777;notify;${sanitize(title)};${sanitize(body)}${BEL}`;
}

/**
 * Wrap an escape sequence for tmux passthrough so OSC reaches the outer
 * terminal instead of being eaten by tmux. Requires `set -g allow-passthrough
 * on` in tmux; harmless if absent (the sequence is just ignored). The inner
 * ESC bytes must be doubled.
 */
export function wrapTmuxPassthrough(seq: string): string {
  return `${ESC}Ptmux;${ESC}${seq.replaceAll(ESC, ESC + ESC)}${ESC}\\`;
}

export interface TerminalIndicatorDeps {
  /** Write a (possibly tmux-wrapped) sequence to the terminal. Must no-op when
   *  no terminal is attached (headless/detached). */
  readonly write: (sequence: string) => void;
  readonly config: TerminalCueConfig;
  /** Title to restore to when idle. Empty string clears the title. */
  readonly idleTitle?: string;
  /** True when running inside tmux; OSC is passthrough-wrapped. */
  readonly tmux?: boolean;
  /** Injected timers (defaults to globals) so tests stay deterministic. */
  readonly setIntervalFn?: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  readonly clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void;
  readonly setTimeoutFn?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * Renders the auto-approve eval lifecycle to the terminal. One instance per
 * daemon process (a single terminal); shared across sessions. Concurrent evals
 * are rare in wrapper mode (one foreground Claude); the last writer wins and
 * `resolve`/`stop` always clears the spinner, so no spinner can leak.
 */
export class TerminalIndicator {
  private readonly write: (sequence: string) => void;
  private readonly config: TerminalCueConfig;
  private readonly idleTitle: string;
  private readonly tmux: boolean;
  private readonly setIntervalFn: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly clearIntervalFn: (handle: ReturnType<typeof setInterval>) => void;
  private readonly setTimeoutFn: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimeoutFn: (handle: ReturnType<typeof setTimeout>) => void;

  private spinnerHandle: ReturnType<typeof setInterval> | null = null;
  private lingerHandle: ReturnType<typeof setTimeout> | null = null;
  private frame = 0;

  constructor(deps: TerminalIndicatorDeps) {
    this.write = deps.write;
    this.config = deps.config;
    this.idleTitle = deps.idleTitle ?? '';
    this.tmux = deps.tmux ?? false;
    this.setIntervalFn = deps.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms));
    this.clearIntervalFn = deps.clearIntervalFn ?? ((h) => clearInterval(h));
    this.setTimeoutFn = deps.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimeoutFn = deps.clearTimeoutFn ?? ((h) => clearTimeout(h));
  }

  /** Emit a sequence, tmux-wrapped when inside tmux. */
  private emit(sequence: string): void {
    this.write(this.tmux ? wrapTmuxPassthrough(sequence) : sequence);
  }

  private setTitle(text: string): void {
    this.emit(oscTitle(text));
  }

  /** Eval started: begin the animated title spinner. */
  start(): void {
    this.clearTimers();
    if (!this.config.statusCue) return;
    this.frame = 0;
    this.renderSpinnerFrame();
    this.spinnerHandle = this.setIntervalFn(() => {
      this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
      this.renderSpinnerFrame();
    }, SPINNER_INTERVAL_MS);
  }

  private renderSpinnerFrame(): void {
    this.setTitle(`${SPINNER_FRAMES[this.frame]} Remi · evaluating…`);
  }

  /**
   * Verdict reached. 'handled' => the permission was auto-approved/denied
   * silently (✓, then restore idle). 'escalate' => the user must answer (⚠,
   * persist + fire the notification).
   */
  resolve(outcome: 'handled' | 'escalate'): void {
    this.stopSpinner();
    if (outcome === 'escalate') {
      if (this.config.statusCue) this.setTitle('⚠ Remi · needs you');
      this.notifyEscalation();
      return;
    }
    // handled
    if (this.config.statusCue) {
      this.setTitle('✓ Remi');
      this.lingerHandle = this.setTimeoutFn(() => {
        this.setTitle(this.idleTitle);
        this.lingerHandle = null;
      }, HANDLED_LINGER_MS);
    }
  }

  /** Eval ended without a verdict (cancelled — user already advanced). Stop the
   *  spinner AND any pending linger, then restore the idle title; no
   *  notification. clearTimers (not just stopSpinner) so a linger scheduled by a
   *  prior resolve('handled') cannot fire a redundant idle-title write later. */
  stop(): void {
    this.clearTimers();
    if (this.config.statusCue) this.setTitle(this.idleTitle);
  }

  private notifyEscalation(): void {
    const title = 'Remi';
    const body = 'A permission needs your approval';
    switch (this.config.notify) {
      case 'osc9':
        this.emit(osc9Notify(`${title}: ${body}`));
        break;
      case 'osc777':
        this.emit(osc777Notify(title, body));
        break;
      case 'bell':
        this.emit(BEL);
        break;
      case 'off':
        break;
    }
  }

  private stopSpinner(): void {
    if (this.spinnerHandle !== null) {
      this.clearIntervalFn(this.spinnerHandle);
      this.spinnerHandle = null;
    }
  }

  private clearTimers(): void {
    this.stopSpinner();
    if (this.lingerHandle !== null) {
      this.clearTimeoutFn(this.lingerHandle);
      this.lingerHandle = null;
    }
  }

  /** Teardown: clear any running timers. Safe to call repeatedly. */
  dispose(): void {
    this.clearTimers();
  }
}

/**
 * The production terminal writer: writes to the saved real-terminal fd, guarded
 * exactly like the raw PTY pass-through (fd present AND wrapper still attached),
 * so it silently no-ops in headless/daemon mode or after the terminal closed.
 * A failed write means the terminal is gone; swallow it (the pass-through path
 * already handles the detach bookkeeping on the next raw write).
 */
function writeToRealTerminal(sequence: string): void {
  const fd = getPtyStdoutFd();
  if (fd === null || isWrapperDetached()) return;
  try {
    fs.writeSync(fd, sequence);
  } catch (err) {
    // EBADF/EPIPE/EIO/ENXIO == the terminal vanished; expected and silent (the
    // raw pass-through write owns the authoritative detach flip). Anything else
    // is unexpected — surface it rather than swallow (no silent failures).
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EBADF' && code !== 'EPIPE' && code !== 'EIO' && code !== 'ENXIO') {
      logError('[TerminalIndicator] terminal write failed:', err);
    }
  }
}

/**
 * Build the process-wide TerminalIndicator with the production writer, tmux
 * detection, and an idle title derived from the working directory (the
 * conventional terminal title). One per daemon; shared across sessions.
 */
export function createTerminalIndicator(
  config: TerminalCueConfig,
  workingDirectory: string,
): TerminalIndicator {
  return new TerminalIndicator({
    write: writeToRealTerminal,
    config,
    idleTitle: path.basename(workingDirectory) || '',
    tmux: typeof process.env['TMUX'] === 'string' && process.env['TMUX'].length > 0,
  });
}
