import { describe, expect, test } from 'bun:test';
import { PtyQuiescenceGate, QUIESCENCE_MS } from '../../src/cli/pty-quiescence-gate.ts';

function bytes(...parts: (string | number[])[]): Uint8Array {
  const chunks: number[] = [];
  for (const part of parts) {
    if (typeof part === 'string') {
      for (let i = 0; i < part.length; i++) chunks.push(part.charCodeAt(i));
    } else {
      chunks.push(...part);
    }
  }
  return new Uint8Array(chunks);
}

const ESC = 0x1b;

describe('PtyQuiescenceGate.isBoundaryClean', () => {
  test('a fresh gate with no observed chunks is clean', () => {
    const gate = new PtyQuiescenceGate();
    expect(gate.isBoundaryClean()).toBe(true);
  });

  test('plain text with no escape sequences stays clean', () => {
    const gate = new PtyQuiescenceGate();
    gate.observe(bytes('hello world\r\n'));
    expect(gate.isBoundaryClean()).toBe(true);
  });

  test('a complete CSI sequence in one chunk is clean afterward', () => {
    const gate = new PtyQuiescenceGate();
    gate.observe(bytes([ESC], '[31m'));
    expect(gate.isBoundaryClean()).toBe(true);
  });

  test('a CSI sequence split across two chunks is dirty until the final byte arrives', () => {
    const gate = new PtyQuiescenceGate();
    gate.observe(bytes([ESC], '[3'));
    expect(gate.isBoundaryClean()).toBe(false);
    gate.observe(bytes('1m'));
    expect(gate.isBoundaryClean()).toBe(true);
  });

  test('a CSI sequence split right after the introducer is dirty until the final byte arrives', () => {
    const gate = new PtyQuiescenceGate();
    gate.observe(bytes([ESC], '['));
    expect(gate.isBoundaryClean()).toBe(false);
    gate.observe(bytes('31m'));
    expect(gate.isBoundaryClean()).toBe(true);
  });

  test('a two-byte escape sequence (e.g. DECSC / DECRC) is clean immediately after its one byte', () => {
    const gate = new PtyQuiescenceGate();
    gate.observe(bytes([ESC], '7')); // DECSC
    expect(gate.isBoundaryClean()).toBe(true);
    gate.observe(bytes([ESC], '8')); // DECRC
    expect(gate.isBoundaryClean()).toBe(true);
  });

  test('a bare ESC leaves the boundary dirty until the next byte resolves it', () => {
    const gate = new PtyQuiescenceGate();
    gate.observe(bytes([ESC]));
    expect(gate.isBoundaryClean()).toBe(false);
    gate.observe(bytes('7'));
    expect(gate.isBoundaryClean()).toBe(true);
  });

  test('an OSC sequence terminated by BEL in one chunk is clean afterward', () => {
    const gate = new PtyQuiescenceGate();
    gate.observe(bytes([ESC], ']0;title', [0x07]));
    expect(gate.isBoundaryClean()).toBe(true);
  });

  test('an OSC sequence split before the BEL terminator is dirty until it arrives', () => {
    const gate = new PtyQuiescenceGate();
    gate.observe(bytes([ESC], ']0;title'));
    expect(gate.isBoundaryClean()).toBe(false);
    gate.observe(bytes([0x07]));
    expect(gate.isBoundaryClean()).toBe(true);
  });

  test('an OSC sequence terminated by ST (ESC \\) is clean afterward, including split across chunks', () => {
    const gate = new PtyQuiescenceGate();
    gate.observe(bytes([ESC], ']0;title'));
    expect(gate.isBoundaryClean()).toBe(false);
    gate.observe(bytes([ESC]));
    expect(gate.isBoundaryClean()).toBe(false); // still dirty: could be ST or a literal ESC in the payload
    gate.observe(bytes('\\'));
    expect(gate.isBoundaryClean()).toBe(true);
  });

  test('a stray ESC inside an OSC string that is not followed by backslash resumes the string, not ground', () => {
    const gate = new PtyQuiescenceGate();
    gate.observe(bytes([ESC], ']0;t'));
    gate.observe(bytes([ESC])); // could be starting ST...
    gate.observe(bytes('x')); // ...but it wasn't -- back to consuming the OSC body
    expect(gate.isBoundaryClean()).toBe(false); // OSC is still open
    gate.observe(bytes([0x07]));
    expect(gate.isBoundaryClean()).toBe(true);
  });

  test('DCS/SOS/PM/APC introducers are treated as string sequences too', () => {
    for (const introducer of ['P', 'X', '^', '_']) {
      const gate = new PtyQuiescenceGate();
      gate.observe(bytes([ESC], introducer, 'payload'));
      expect(gate.isBoundaryClean()).toBe(false);
      gate.observe(bytes([0x07]));
      expect(gate.isBoundaryClean()).toBe(true);
    }
  });

  test('an out-of-range byte inside a CSI sequence recovers to ground rather than sticking dirty forever', () => {
    const gate = new PtyQuiescenceGate();
    // 0x01 (SOH) is not a valid CSI param/intermediate/final byte.
    gate.observe(bytes([ESC], '[', [0x01]));
    expect(gate.isBoundaryClean()).toBe(true);
  });

  test('an ESC inside a CSI sequence restarts scanning from escape rather than sticking dirty', () => {
    const gate = new PtyQuiescenceGate();
    gate.observe(bytes([ESC], '[3', [ESC], '7'));
    // The abandoned CSI never got a final byte, but the ESC 7 that interrupted
    // it is a complete two-byte sequence, so the boundary is clean again.
    expect(gate.isBoundaryClean()).toBe(true);
  });

  test('consecutive independent sequences across many small chunks all resolve clean', () => {
    const gate = new PtyQuiescenceGate();
    const fullSequence = '\x1b[2K\x1b[7m hi \x1b[0m\x1b7\x1b8';
    for (const ch of fullSequence) {
      gate.observe(bytes(ch));
    }
    expect(gate.isBoundaryClean()).toBe(true);
  });
});

// #932 review finding 1: `isBoundaryClean()` is a HARD gate with no
// exceptions (status-bar.ts's render() checks it before onset/resumed/
// heartbeat), so a scanner state reachable only via its well-formed
// terminator is a liveness bug -- if that terminator never arrives, the bar
// stops painting for the rest of the session, silently (nothing throws).
// These reproduce the exact class of input that latched the scanner before
// the fix, and prove recovery.
describe('PtyQuiescenceGate — never-latch safety net', () => {
  test('an unterminated OSC introducer followed by many chunks of normal output eventually recovers to clean', () => {
    // Direct reproduction of the review finding: one unterminated ESC ]
    // introducer, then 1000 chunks of entirely normal output -- plain
    // text, complete CSI sequences, DECSC/DECRC pairs -- none containing
    // BEL or ESC \. Before the fix, isBoundaryClean() stayed false through
    // all 1000 chunks.
    const gate = new PtyQuiescenceGate();
    gate.observe(bytes([ESC], ']')); // unterminated OSC introducer
    expect(gate.isBoundaryClean()).toBe(false);

    const normalChunks = [
      'hello world, this is normal output ',
      '\x1b[32mgreen text\x1b[0m ',
      '\x1b7\x1b8 ', // DECSC/DECRC pair
      'more plain text without any BEL or ST terminator ',
    ];
    let recovered = false;
    for (let i = 0; i < 1000; i++) {
      gate.observe(bytes(normalChunks[i % normalChunks.length] as string));
      if (gate.isBoundaryClean()) {
        recovered = true;
        break;
      }
    }
    expect(recovered).toBe(true);
    // And the gate keeps working normally afterward -- not just "clean
    // once," but genuinely recovered, not wedged in some other state.
    expect(gate.observe(bytes([ESC], '[31m'))).toBe(false);
    expect(gate.isBoundaryClean()).toBe(true);
  });

  test('a stray C0 control other than BEL/ESC inside a string sequence aborts it back to ground', () => {
    const gate = new PtyQuiescenceGate();
    gate.observe(bytes([ESC], ']0;some title'));
    expect(gate.isBoundaryClean()).toBe(false);
    gate.observe(bytes([0x0a])); // a stray LF -- never a valid OSC byte
    expect(gate.isBoundaryClean()).toBe(true);
  });

  test('a stray C0 control aborts DCS/SOS/PM/APC string sequences too', () => {
    for (const introducer of ['P', 'X', '^', '_']) {
      const gate = new PtyQuiescenceGate();
      gate.observe(bytes([ESC], introducer, 'payload'));
      expect(gate.isBoundaryClean()).toBe(false);
      gate.observe(bytes([0x18])); // CAN
      expect(gate.isBoundaryClean()).toBe(true);
    }
  });

  test('a stray C0 control inside string-esc (after an ESC that was not ST) also recovers', () => {
    const gate = new PtyQuiescenceGate();
    gate.observe(bytes([ESC], ']0;t', [ESC])); // ESC that might be starting ST
    expect(gate.isBoundaryClean()).toBe(false);
    gate.observe(bytes([0x0a])); // LF instead of '\' -- abort, not resume
    expect(gate.isBoundaryClean()).toBe(true);
  });

  test('a legitimate OSC well under the length cap is unaffected', () => {
    const gate = new PtyQuiescenceGate();
    gate.observe(bytes([ESC], ']0;a normal window title', [0x07]));
    expect(gate.isBoundaryClean()).toBe(true);
  });

  test('an OSC sequence that never terminates recovers once the length cap is exceeded', () => {
    const gate = new PtyQuiescenceGate();
    gate.observe(bytes([ESC], ']52;c;')); // OSC 52 clipboard introducer
    expect(gate.isBoundaryClean()).toBe(false);
    // Feed printable, non-control bytes only (a plausible base64 payload
    // stand-in) well past any realistic OSC 52 payload, with no BEL/ST.
    const payloadChunk = 'A'.repeat(1000);
    let recovered = false;
    for (let i = 0; i < 20; i++) {
      gate.observe(bytes(payloadChunk));
      if (gate.isBoundaryClean()) {
        recovered = true;
        break;
      }
    }
    expect(recovered).toBe(true);
  });

  test('a CSI sequence that never reaches a final byte eventually recovers (defense in depth)', () => {
    // CSI already has malformed-byte recovery for a byte outside its
    // grammar; this covers the narrower case of a long run of otherwise-
    // valid param bytes (e.g. corrupted/binary passthrough) that never
    // reaches a final byte in 0x40-0x7E.
    const gate = new PtyQuiescenceGate();
    gate.observe(bytes([ESC], '['));
    expect(gate.isBoundaryClean()).toBe(false);
    const paramRun = '0123456789;'.repeat(100); // all valid CSI param bytes
    let recovered = false;
    for (let i = 0; i < 10; i++) {
      gate.observe(bytes(paramRun));
      if (gate.isBoundaryClean()) {
        recovered = true;
        break;
      }
    }
    expect(recovered).toBe(true);
  });

  test('a legitimate short CSI sequence is unaffected by the run cap', () => {
    const gate = new PtyQuiescenceGate();
    expect(gate.observe(bytes([ESC], '[38;2;255;100;50m'))).toBe(false); // 24-bit color SGR
    expect(gate.isBoundaryClean()).toBe(true);
  });
});

describe('PtyQuiescenceGate.observe scroll-region-reset detection (ESC[r)', () => {
  test('a bare ESC[r in one chunk is reported', () => {
    const gate = new PtyQuiescenceGate();
    const sawReset = gate.observe(bytes([ESC], '[r'));
    expect(sawReset).toBe(true);
    expect(gate.isBoundaryClean()).toBe(true);
  });

  test('a bare ESC[r split across two chunks is reported only once complete', () => {
    const gate = new PtyQuiescenceGate();
    const first = gate.observe(bytes([ESC], '['));
    expect(first).toBe(false);
    expect(gate.isBoundaryClean()).toBe(false);
    const second = gate.observe(bytes('r'));
    expect(second).toBe(true);
    expect(gate.isBoundaryClean()).toBe(true);
  });

  test("a parameterized region set (the bar's own ESC[1;Nr) is NOT reported as a bare reset", () => {
    const gate = new PtyQuiescenceGate();
    const sawReset = gate.observe(bytes([ESC], '[1;39r'));
    expect(sawReset).toBe(false);
    expect(gate.isBoundaryClean()).toBe(true);
  });

  test('other CSI final bytes are never reported as a scroll-region reset', () => {
    const gate = new PtyQuiescenceGate();
    expect(gate.observe(bytes([ESC], '[2K'))).toBe(false); // erase line
    expect(gate.observe(bytes([ESC], '[7m'))).toBe(false); // reverse video
    expect(gate.observe(bytes([ESC], '[H'))).toBe(false); // cursor home
  });

  test('a bare ESC[r followed by more bytes in the same chunk still reports the reset', () => {
    const gate = new PtyQuiescenceGate();
    const sawReset = gate.observe(bytes([ESC], '[r', 'hello'));
    expect(sawReset).toBe(true);
  });

  test('multiple bare ESC[r occurrences in one chunk still report true (not miscounted)', () => {
    const gate = new PtyQuiescenceGate();
    const sawReset = gate.observe(bytes([ESC], '[r', [ESC], '[r'));
    expect(sawReset).toBe(true);
  });
});

describe('PtyQuiescenceGate.isQuiescent', () => {
  test('a fresh gate with no observed chunks is quiescent (fail toward paintable)', () => {
    const gate = new PtyQuiescenceGate();
    expect(gate.isQuiescent()).toBe(true);
  });

  test('is not quiescent immediately after a chunk, becomes quiescent once QUIESCENCE_MS has elapsed', () => {
    let nowMs = 1_000_000;
    const gate = new PtyQuiescenceGate(() => nowMs);
    gate.observe(bytes('hello'));
    expect(gate.isQuiescent()).toBe(false);
    nowMs += QUIESCENCE_MS - 1;
    expect(gate.isQuiescent()).toBe(false);
    nowMs += 1;
    expect(gate.isQuiescent()).toBe(true);
  });

  test('a later chunk resets the quiescence window from its own timestamp', () => {
    let nowMs = 1_000_000;
    const gate = new PtyQuiescenceGate(() => nowMs);
    gate.observe(bytes('a'));
    nowMs += QUIESCENCE_MS; // now quiescent
    expect(gate.isQuiescent()).toBe(true);
    gate.observe(bytes('b')); // resets the window
    expect(gate.isQuiescent()).toBe(false);
    nowMs += QUIESCENCE_MS - 1;
    expect(gate.isQuiescent()).toBe(false);
    nowMs += 1;
    expect(gate.isQuiescent()).toBe(true);
  });
});
