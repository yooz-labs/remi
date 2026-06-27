/**
 * Optional raw PTY I/O capture for diagnosing terminal-UI interactions (#627).
 *
 * Set `REMI_PTY_CAPTURE=/path/to/file` to append every byte written to the child
 * (`IN` — your keystrokes) and read from it (`OUT` — Claude's rendered frames),
 * each as a JSON-escaped line:
 *
 *   IN  1719500000000 "[B"
 *   OUT 1719500000001 "[2K❯ 1. Yes ..."
 *
 * Off unless the env var is set (a single boolean check on the hot path when
 * disabled). Its purpose is to capture the `AskUserQuestion` keystroke model from
 * a real session so the answer driver is built from observed bytes — and can be
 * re-verified when Claude Code's renderer drifts (cf. ExitPlanMode order, #598).
 *
 * Capture is best-effort: a write error disables it and logs ONCE, so a full disk
 * or a bad path can never disturb the live PTY.
 */

import { appendFileSync } from 'node:fs';

// Env is read lazily per call (not cached at import) so a process that sets
// REMI_PTY_CAPTURE before spawning a PTY is honored, and so the behavior is
// unit-testable. The read is a cheap property access; PTY byte volume is low.
let disabled = false;

function capturePath(): string | undefined {
  return process.env['REMI_PTY_CAPTURE'];
}

function record(dir: 'IN' | 'OUT', data: string | Uint8Array): void {
  const path = capturePath();
  if (!path || disabled) return;
  try {
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    appendFileSync(path, `${dir} ${Date.now()} ${JSON.stringify(text)}\n`);
  } catch (err) {
    disabled = true;
    // Loud-once: never silent, never recurring, never fatal to the PTY.
    console.error(
      `[pty-capture] disabled after write error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Raw PTY I/O capture sink (no-op unless `REMI_PTY_CAPTURE` is set). */
export const ptyCapture = {
  /** True when capture is enabled (env var set and not yet disabled by error). */
  get enabled(): boolean {
    return Boolean(capturePath()) && !disabled;
  },
  /** Record bytes written TO the child process (keystrokes). */
  in: (data: string | Uint8Array): void => record('IN', data),
  /** Record bytes read FROM the child process (rendered output). */
  out: (data: Uint8Array): void => record('OUT', data),
};
