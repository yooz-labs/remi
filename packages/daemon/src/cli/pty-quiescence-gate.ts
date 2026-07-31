/**
 * PTY output quiescence + clean-boundary gate (#932 durable fix).
 *
 * remi's reserved-row status bar (`status-bar.ts`) and Claude's own PTY
 * output are two writers on the same terminal fd. Both are synchronous
 * `fs.writeSync` calls on the same thread, so byte-level interleaving
 * WITHIN one write is impossible -- the actual hazard (see #932's
 * corrected mechanism, recorded in status-bar.ts's module doc) is a bar
 * paint landing BETWEEN two of Claude's own PTY-forwarding chunks, at a
 * boundary that happens to split one of Claude's escape sequences. The
 * terminal then parses the bar's bytes as the continuation of Claude's
 * half-delivered sequence, garbling both ("mode 1").
 *
 * This module tracks, over the stream of chunks actually forwarded to one
 * terminal fd, the two things a caller needs in order to decide whether a
 * write right now is safe:
 *
 *   1. `isBoundaryClean()` -- HARD requirement. False while the last fed
 *      chunk left the stream inside an unterminated ESC / CSI / OSC (etc.)
 *      sequence. A write must NEVER happen while this is false -- that is
 *      the structural fix for mode 1: a paint can no longer land at a
 *      dirty boundary, full stop.
 *   2. `isQuiescent()` -- SOFT requirement. False until at least
 *      `QUIESCENCE_MS` has passed since the last fed chunk. This reduces
 *      but does not eliminate "mode 2": a paint landing inside a Claude
 *      ESC7...ESC8 save/restore pair that spans a quiet gap between
 *      chunks -- closing that fully would require a full VT state model
 *      of the child (a mini-multiplexer for one status row), which is
 *      disproportionate; it is an accepted residual (see #932's
 *      discussion). `QUIESCENCE_MS` is measured from a real capture, not
 *      guessed -- see the constant's own doc.
 *
 * Deliberately NOT a VT emulator: no cursor position, no character
 * rendition, no semantic state of any kind is tracked -- only "am I
 * currently inside one of Claude's own escape sequences," the one
 * question a caller needs answered before writing to the shared fd.
 *
 * Bonus signal: `observe()` also reports when a chunk completes a BARE
 * `ESC[r` (DECSTBM full-screen scroll-region reset, confirmed present in
 * the 2.1.220 `claude` binary) so a caller can force an immediate repaint
 * rather than leaving row `N` unprotected until the next scheduled tick --
 * see `StatusBar.notifyScrollRegionReset`.
 */

/** Scanner state machine positions. */
type ScanState =
  | 'ground'
  | 'escape' // saw ESC (0x1b); haven't seen the next byte yet
  | 'csi' // ESC [ ... collecting params/intermediates, awaiting a final byte (0x40-0x7E)
  | 'string' // ESC ] | ESC P | ESC X | ESC ^ | ESC _ ... (OSC/DCS/SOS/PM/APC), awaiting ST or BEL
  | 'string-esc'; // inside a 'string' sequence, just saw ESC -- checking for the ST-closing '\'

/**
 * #932: PTY output quiescence window, in ms. Measured from a real capture
 * of the `claude` 2.1.220 binary's own PTY chunk timing, via Bun's native
 * `Bun.spawn({ terminal })` API -- the exact mechanism `PTYSession` uses in
 * production (packages/daemon/src/pty/pty-session.ts) -- across six real
 * conversational turns (plain-text replies and tool-use turns: Read an
 * existing file, Edit it, list a directory). 372 inter-chunk gaps were
 * recorded; 364 landed inside an actively-streaming turn, the other 8 were
 * the idle gap between turns (waiting on the next API round-trip). The two
 * populations separated cleanly, with a ~10x gap between them:
 *   - active-burst gaps: p50 84.9ms, p90 122.4ms, p99 239.5ms, MAX 416.55ms
 *   - idle (between-turn) gaps: MIN 4099ms
 * 500ms sits ~20% above the highest active-burst gap actually observed (so
 * a routine, non-edge paint essentially never fires mid-burst -- the
 * intended effect), and more than 8x below the lowest idle gap observed
 * (so once Claude genuinely goes idle, quiescence is satisfied almost
 * immediately -- well inside status-bar.ts's HEARTBEAT_MS, which still
 * bounds the worst case regardless of this gate; see
 * StatusBar.render()'s doc for how the two interact). Full capture
 * methodology, raw histogram, and sample counts are recorded in the #932
 * PR body so the choice is auditable.
 */
export const QUIESCENCE_MS = 500;

/** Sequence-introducer bytes that start a "string" sequence (terminated by
 *  ST or BEL rather than a single CSI final byte): OSC (]), DCS (P), SOS
 *  (X), PM (^), APC (_). Treating all five identically is conservative for
 *  a boundary detector -- worst case it treats a chunk as "still open" a
 *  little longer than strictly necessary; it never does the reverse. */
const STRING_INTRODUCERS = new Set<number>([0x5d, 0x50, 0x58, 0x5e, 0x5f]); // ] P X ^ _

const ESC = 0x1b;
const CSI_INTRODUCER = 0x5b; // '['
const BEL = 0x07;
const ST_FINAL = 0x5c; // '\' -- completes ST (ESC \) when it follows ESC in a 'string' sequence
const DECSTBM_FINAL = 0x72; // 'r'

/** CSI final bytes are 0x40-0x7E (ECMA-48). */
function isCsiFinalByte(byte: number): boolean {
  return byte >= 0x40 && byte <= 0x7e;
}

/** CSI parameter bytes are 0x30-0x3F (digits, `;`, `<`, `=`, `>`, `?`). */
function isCsiParamByte(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x3f;
}

/** CSI intermediate bytes are 0x20-0x2F. */
function isCsiIntermediateByte(byte: number): boolean {
  return byte >= 0x20 && byte <= 0x2f;
}

export class PtyQuiescenceGate {
  private state: ScanState = 'ground';
  /** Parameter bytes seen so far in the current CSI sequence -- used only
   *  to recognize a BARE `ESC[r` (no parameters, DECSTBM's full-screen
   *  reset) as distinct from a parameterized region set like the bar's own
   *  `ESC[1;Nr` paint (see buildBarSequence). */
  private csiParamBytes = 0;
  private lastObservedAtMs: number | null = null;
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  /**
   * Feed one PTY chunk actually forwarded to the terminal this gate
   * guards. Must be called, in order, for every such chunk -- the scanner
   * has no other way to observe the stream. Returns true iff this chunk
   * completed a bare `ESC[r` (DECSTBM full-screen scroll-region reset):
   * the caller should treat that as an immediate-repaint trigger (see
   * `StatusBar.notifyScrollRegionReset`).
   */
  observe(data: Uint8Array): boolean {
    this.lastObservedAtMs = this.now();
    let sawScrollRegionReset = false;
    for (let i = 0; i < data.length; i++) {
      // biome-ignore lint/style/noNonNullAssertion: bounds checked by loop condition
      const byte = data[i]!;
      switch (this.state) {
        case 'ground':
          if (byte === ESC) this.state = 'escape';
          break;
        case 'escape':
          if (byte === CSI_INTRODUCER) {
            this.state = 'csi';
            this.csiParamBytes = 0;
          } else if (STRING_INTRODUCERS.has(byte)) {
            this.state = 'string';
          } else {
            // Any other byte completes a two-byte escape sequence (ESC 7,
            // ESC 8, ESC c, ESC =, ESC >, ...) -- back to ground.
            this.state = 'ground';
          }
          break;
        case 'csi':
          if (isCsiFinalByte(byte)) {
            if (byte === DECSTBM_FINAL && this.csiParamBytes === 0) {
              sawScrollRegionReset = true;
            }
            this.state = 'ground';
          } else if (isCsiParamByte(byte)) {
            this.csiParamBytes++;
          } else if (!isCsiIntermediateByte(byte)) {
            // A byte that is not param/intermediate/final should not occur
            // inside a well-formed CSI sequence. Rather than risk the
            // scanner getting stuck reporting "dirty" forever on
            // malformed input (which would silently disable every future
            // paint), fail toward recovery: a fresh ESC restarts scanning,
            // anything else is treated as having ended the sequence.
            this.state = byte === ESC ? 'escape' : 'ground';
          }
          break;
        case 'string':
          if (byte === BEL) this.state = 'ground';
          else if (byte === ESC) this.state = 'string-esc';
          break;
        case 'string-esc':
          if (byte === ST_FINAL) this.state = 'ground';
          else if (byte !== ESC) this.state = 'string';
          // else: another ESC -- keep checking the next byte for ST_FINAL
          break;
      }
    }
    return sawScrollRegionReset;
  }

  /** Hard gate: true iff the stream is NOT currently inside an
   *  unterminated Claude escape sequence -- see this module's doc for why
   *  a write must never proceed while this is false. */
  isBoundaryClean(): boolean {
    return this.state === 'ground';
  }

  /** Soft gate: true iff at least `QUIESCENCE_MS` has passed since the
   *  last observed chunk, or none has ever been observed (fail toward
   *  paintable -- a fresh gate with no PTY history yet must not block the
   *  bar's very first paint). */
  isQuiescent(): boolean {
    return this.lastObservedAtMs === null || this.now() - this.lastObservedAtMs >= QUIESCENCE_MS;
  }
}
