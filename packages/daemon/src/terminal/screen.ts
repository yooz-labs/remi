import { Terminal } from '@xterm/headless';

export const SCREEN_LIMITS = {
  columns: 240,
  rows: 60,
  stateBytes: 1024 * 1024,
  queuedBytes: 65536,
  queuedOperations: 8,
  sliceBytes: 2048,
  controlBytes: 128,
  ignoredOscBytes: 16384,
  combiningBytes: 2048,
  cellBytes: 64,
  textBytes: 32768,
  frameBytes: 65536,
  parseDeadlineMs: 250,
  minimumWorkCells: 16384,
} as const;

export interface ScreenSnapshot {
  readonly columns: number;
  readonly rows: number;
  readonly lines: readonly string[];
  readonly cursor: { readonly row: number; readonly column: number } | null;
}

type Operation =
  | { readonly kind: 'output'; readonly bytes: Uint8Array }
  | { readonly kind: 'resize'; readonly columns: number; readonly rows: number };
type ScanMode = 'text' | 'escape' | 'csi' | 'charset' | 'osc-code' | 'osc' | 'osc-escape';
const safeOsc = new Set([
  '0',
  '1',
  '2',
  '4',
  '7',
  '8',
  '9',
  '10',
  '11',
  '12',
  '52',
  '104',
  '133',
  '633',
  '777',
]);
// Covers the pinned Unicode-6 zero-width table, including Hangul V/T jamo.
// Charge cumulatively: overwritten combined strings may remain in private line maps.
const joining = /[\p{Mark}\p{Cf}\u06de\u1160-\u11ff]/u;
const misleading = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

function conceals(parameters: string): boolean {
  // Mixed colon/semicolon color forms consume parameters differently in xterm.
  // Retire rather than risk discarding an attribute that conceals source text.
  if (!/^[0-9;]*$/u.test(parameters)) return true;
  const fields = parameters.split(';');
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index] ?? '';
    const code = Number(field);
    if (code === 8) return true;
    if ([38, 48, 58].includes(code)) {
      // An RGB/palette component equal to 8 is not SGR conceal.
      const mode = fields[index + 1];
      if (mode === '5') index += 2;
      else if (mode === '2') index += 4;
    }
  }
  return false;
}

/** Bounded read-only screen primitive (#1608): no PTY input, transport or domain authority. */
export class BoundedScreen {
  private terminal: Terminal | undefined;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private readonly queue: Operation[] = [];
  private queuedBytes = 0;
  private queuedOperations = 0;
  private running = false;
  private idle: Promise<void> = Promise.resolve();
  private finishWrite: ((ok: boolean) => void) | undefined;
  private scanMode: ScanMode = 'text';
  private control = '';
  private oscBytes = 0;
  private combiningBytes = 0;
  private cursorVisible = true;
  private synchronizedOutput = false;
  private refusal: string | undefined;
  private cachedSnapshot: ScreenSnapshot | undefined;

  constructor(columns: number, rows: number) {
    if (!this.validSize(columns, rows)) {
      this.refusal = 'unsupported_screen';
      return;
    }
    this.terminal = new Terminal({
      cols: columns,
      rows,
      scrollback: 0,
      allowProposedApi: true,
      disableStdin: true,
      logLevel: 'off',
    });
    if (this.terminal.unicode.activeVersion !== '6') this.retire('unsupported_screen');
    // Deliberately no onData/onBinary/title/link/clipboard sink or process reference.
  }

  get available(): boolean {
    return this.terminal !== undefined;
  }

  get reason(): string | undefined {
    return this.refusal;
  }

  get pending(): Readonly<{ bytes: number; operations: number }> {
    return { bytes: this.queuedBytes, operations: this.queuedOperations };
  }

  observe(bytes: Uint8Array): boolean {
    if (!this.terminal) return false;
    if (!bytes.byteLength) return true;
    if (
      bytes.byteLength > SCREEN_LIMITS.queuedBytes - this.queuedBytes ||
      this.queuedOperations >= SCREEN_LIMITS.queuedOperations
    ) {
      this.retire('backpressure');
      return false;
    }
    this.queuedBytes += bytes.byteLength;
    this.queuedOperations++;
    this.cachedSnapshot = undefined;
    this.queue.push({ kind: 'output', bytes: new Uint8Array(bytes) });
    this.start();
    return true;
  }

  /** Geometry comes from the existing local PTY owner; this never resizes a PTY. */
  resize(columns: number, rows: number): boolean {
    if (!this.terminal) return false;
    if (!this.validSize(columns, rows) || this.queuedOperations >= SCREEN_LIMITS.queuedOperations) {
      this.retire('unsupported_screen');
      return false;
    }
    this.queuedOperations++;
    this.cachedSnapshot = undefined;
    this.queue.push({ kind: 'resize', columns, rows });
    this.start();
    return true;
  }

  whenIdle(): Promise<void> {
    return this.idle;
  }

  snapshot(): ScreenSnapshot | null {
    const terminal = this.terminal;
    if (!terminal || this.running || this.scanMode !== 'text' || this.synchronizedOutput)
      return null;
    if (this.cachedSnapshot) return this.cachedSnapshot;
    try {
      if (!this.validate(terminal)) return null;
      const active = terminal.buffer.active;
      const lines = Array.from({ length: terminal.rows }, (_, row) => {
        const line = active.getLine(active.viewportY + row);
        if (!line) throw new Error('missing row');
        return line.translateToString(true);
      });
      const result = {
        columns: terminal.cols,
        rows: terminal.rows,
        lines,
        cursor: this.cursorVisible
          ? { row: active.cursorY, column: Math.min(active.cursorX, terminal.cols - 1) }
          : null,
      };
      // Leave room for the later bounded wire envelope; this is not that wire codec.
      if (Buffer.byteLength(JSON.stringify(result)) > SCREEN_LIMITS.frameBytes - 1024) {
        this.retire('unsupported_screen');
        return null;
      }
      Object.freeze(result.lines);
      if (result.cursor) Object.freeze(result.cursor);
      this.cachedSnapshot = Object.freeze(result);
      return this.cachedSnapshot;
    } catch {
      this.retire('unsupported_screen');
      return null;
    }
  }

  retire(reason = 'closed'): void {
    if (this.refusal === undefined) this.refusal = reason;
    const terminal = this.terminal;
    this.terminal = undefined;
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.queuedOperations = 0;
    this.control = '';
    this.cachedSnapshot = undefined;
    this.finishWrite?.(false);
    this.finishWrite = undefined;
    terminal?.dispose();
  }

  private validSize(columns: number, rows: number): boolean {
    return (
      Number.isSafeInteger(columns) &&
      columns >= 2 &&
      columns <= SCREEN_LIMITS.columns &&
      Number.isSafeInteger(rows) &&
      rows > 0 &&
      rows <= SCREEN_LIMITS.rows
    );
  }

  private start(): void {
    if (this.running) return;
    this.running = true;
    this.idle = this.run();
  }

  private async run(): Promise<void> {
    try {
      // A resize can drain synchronously; include output admitted before its
      // promise continuation in the same idle barrier.
      do {
        await this.drain();
      } while (this.terminal && this.queue.length);
    } catch {
      this.retire('unsupported_screen');
    } finally {
      this.running = false;
    }
  }

  private async drain(): Promise<void> {
    while (this.terminal && this.queue.length) {
      const operation = this.queue.shift();
      if (!operation) break;
      if (operation.kind === 'resize') {
        this.terminal.resize(operation.columns, operation.rows);
        if (!this.validate(this.terminal)) return;
      } else {
        for (
          let offset = 0;
          this.terminal && offset < operation.bytes.length;
          offset += SCREEN_LIMITS.sliceBytes
        ) {
          const end = Math.min(offset + SCREEN_LIMITS.sliceBytes, operation.bytes.length);
          const text = this.filter(
            this.decoder.decode(operation.bytes.subarray(offset, end), { stream: true }),
          );
          if (!this.terminal) return;
          if (text && !(await this.writeOne(this.terminal, text))) return;
          if (this.terminal && !this.validate(this.terminal)) return;
          await Bun.sleep(0);
        }
        if (!this.terminal) return;
        this.queuedBytes -= operation.bytes.length;
      }
      this.queuedOperations--;
    }
  }

  private writeOne(terminal: Terminal, text: string): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.finishWrite = undefined;
        resolve(ok);
      };
      const timer = setTimeout(() => {
        finish(false);
        this.retire('unsupported_screen');
      }, SCREEN_LIMITS.parseDeadlineMs);
      this.finishWrite = finish;
      terminal.write(text, () => finish(this.terminal === terminal));
    });
  }

  private filter(text: string): string {
    const output: string[] = [];
    const columns = this.terminal?.cols ?? 1;
    const rows = this.terminal?.rows ?? 1;
    const cells = columns * rows;
    let work = 0;
    const maximumWork = Math.max(SCREEN_LIMITS.minimumWorkCells, 4 * cells);
    for (const character of text) {
      if (work > maximumWork) return this.unsupported();
      const code = character.codePointAt(0);
      if (code === undefined) return this.unsupported();
      if (this.scanMode === 'osc' || this.scanMode === 'osc-escape') {
        this.oscBytes += Buffer.byteLength(character);
        if (this.oscBytes > SCREEN_LIMITS.ignoredOscBytes) return this.unsupported();
        if (this.scanMode === 'osc-escape' && character !== '\\') return this.unsupported();
        if (code === 7 || (this.scanMode === 'osc-escape' && character === '\\')) {
          this.scanMode = 'text';
        } else if (code === 27) this.scanMode = 'osc-escape';
        else if (code < 0x20) return this.unsupported();
        else this.scanMode = 'osc';
        continue;
      }
      if (this.scanMode === 'osc-code') {
        if (character === ';' && safeOsc.has(this.control)) {
          this.control = '';
          this.scanMode = 'osc';
          continue;
        }
        if (!/[0-9]/u.test(character) || this.control.length >= 4) return this.unsupported();
        this.control += character;
        continue;
      }
      if (this.scanMode === 'escape') {
        if (character === '[') {
          this.scanMode = 'csi';
          this.control += character;
        } else if (character === ']') {
          this.scanMode = 'osc-code';
          this.control = '';
          this.oscBytes = 0;
        } else if ('()*+#'.includes(character)) {
          this.scanMode = 'charset';
          this.control += character;
        } else if ('78cDEHM=>'.includes(character)) {
          output.push(this.control + character);
          work += character === 'c' ? 2 * cells : columns + rows;
          if (character === 'c') {
            this.cursorVisible = true;
            this.synchronizedOutput = false;
          }
          this.scanMode = 'text';
          this.control = '';
        } else return this.unsupported();
        continue;
      }
      if (this.scanMode === 'charset') {
        if (code < 0x30 || code > 0x7e) return this.unsupported();
        if (this.control === '\x1b#' ? character !== '8' : !'0AB'.includes(character)) {
          return this.unsupported();
        }
        work += this.control === '\x1b#' ? cells : 1;
        output.push(this.control + character);
        this.control = '';
        this.scanMode = 'text';
        continue;
      }
      if (this.scanMode === 'csi') {
        if (code < 0x20 || code > 0x7e || this.control.length >= SCREEN_LIMITS.controlBytes)
          return this.unsupported();
        this.control += character;
        if (code >= 0x40) {
          if (!'@ABCDEFGH IJKLMPSTXZ`abcde fghlmnpqrstu'.includes(character))
            return this.unsupported();
          if (character === 'h' || character === 'l') {
            const parameters = this.control.slice(2, -1);
            const modes = parameters.replace(/^\?/u, '').split(';').map(Number);
            const supported = parameters.startsWith('?')
              ? [
                  1, 6, 7, 12, 25, 45, 47, 66, 1000, 1002, 1003, 1004, 1005, 1006, 1015, 1047, 1048,
                  1049, 2004, 2026,
                ]
              : [4, 20];
            if (modes.some((mode) => !supported.includes(mode))) return this.unsupported();
            work += modes.reduce(
              (cost, mode) => cost + ([47, 1047, 1049].includes(mode) ? 2 * cells : 1),
              0,
            );
            if (parameters.startsWith('?') && modes.includes(25)) {
              this.cursorVisible = character === 'h';
            }
            if (parameters.startsWith('?') && modes.includes(2026)) {
              this.synchronizedOutput = character === 'h';
            }
          }
          // Conceal cannot be silently turned into visible text in a monochrome view.
          if (character === 'm' && conceals(this.control.slice(2, -1))) return this.unsupported();
          if (!'mncqthl'.includes(character)) {
            const parameters = this.control.slice(2, -1);
            if (character === 'p' && parameters === '!') {
              work += cells;
              this.cursorVisible = true;
              this.synchronizedOutput = false;
            } else {
              if (!/^[0-9;]*$/u.test(parameters)) return this.unsupported();
              const counts = parameters.split(';').map(Number);
              if (counts.some((count) => count > SCREEN_LIMITS.columns)) return this.unsupported();
              // REP can copy a combined cell into otherwise uncharged private
              // line-map entries. Conservatively refuse it after joining input.
              if (character === 'b' && this.combiningBytes) return this.unsupported();
              work += 'JLMST'.includes(character)
                ? cells
                : '@KP X'.includes(character)
                  ? columns
                  : character === 'b'
                    ? counts[0] || 1
                    : 1;
            }
          }
          // Discard attributes/replies/window metadata; cursor restore (`u`) still applies.
          if (!'mncqt'.includes(character)) output.push(this.control);
          this.control = '';
          this.scanMode = 'text';
        }
        continue;
      }
      if (code === 27) {
        this.scanMode = 'escape';
        this.control = character;
      } else if (code < 0x20) {
        if ([8, 9, 10, 11, 12, 13].includes(code)) {
          output.push(character);
          work += columns + rows;
        } else if (![0, 7].includes(code)) return this.unsupported();
      } else if ((code >= 0x7f && code <= 0x9f) || misleading.test(character) || code === 0x200d) {
        return this.unsupported();
      } else {
        work++;
        if (joining.test(character)) {
          this.combiningBytes += Buffer.byteLength(character);
          if (this.combiningBytes > SCREEN_LIMITS.combiningBytes) return this.unsupported();
        }
        output.push(character);
      }
    }
    if (work > maximumWork) return this.unsupported();
    return output.join('');
  }

  private unsupported(): '' {
    this.retire('unsupported_screen');
    return '';
  }

  private validate(terminal: Terminal): boolean {
    let cell = terminal.buffer.normal.getLine(0)?.getCell(0);
    if (!cell) return Boolean(this.unsupported());
    for (const buffer of [terminal.buffer.normal, terminal.buffer.alternate]) {
      if (buffer.length > terminal.rows) return Boolean(this.unsupported());
      let bytes = 0;
      for (let row = 0; row < buffer.length; row++) {
        const line = buffer.getLine(row);
        if (!line || line.length !== terminal.cols) return Boolean(this.unsupported());
        bytes += Buffer.byteLength(line.translateToString(true));
        if (bytes > SCREEN_LIMITS.textBytes) return Boolean(this.unsupported());
        for (let column = 0; column < terminal.cols; column++) {
          cell = line.getCell(column, cell);
          if (!cell || Buffer.byteLength(cell.getChars()) > SCREEN_LIMITS.cellBytes)
            return Boolean(this.unsupported());
        }
      }
    }
    return true;
  }
}
