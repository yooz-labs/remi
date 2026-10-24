import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PTYSession } from '../../src/pty/pty-session.ts';
import type { PTYReadObserver, TerminalSize } from '../../src/pty/pty-session.ts';
import {
  type BorrowedTerminalFrame,
  TerminalCaptureHost,
} from '../../src/terminal/capture-host.ts';
import { TerminalReservations } from '../../src/terminal/reservations.ts';
import { BoundedScreen } from '../../src/terminal/screen.ts';

const wait = (milliseconds: number) => new Promise((r) => setTimeout(r, milliseconds));
async function until(condition: () => boolean, timeout = 3000): Promise<void> {
  const end = performance.now() + timeout;
  while (!condition()) {
    if (performance.now() >= end) throw new Error('Owned terminal capture condition absent');
    await wait(5);
  }
}
const ledgerRows = (home: string): unknown[] =>
  (
    JSON.parse(fs.readFileSync(join(home, 'terminal-view', 'reservations.json'), 'utf8')) as {
      records: unknown[];
    }
  ).records;

async function fixture(
  run: (f: ReturnType<typeof owned>) => Promise<void>,
  initial = 'FIRST\x1b[6n',
  size: TerminalSize = { cols: 20, rows: 4 },
) {
  const f = owned(initial, size);
  const failures: unknown[] = [];
  try {
    await run(f);
  } catch (error) {
    failures.push(error);
  }
  try {
    await f.pty.close(1000);
  } catch (error) {
    failures.push(error);
  }
  try {
    await f.host.closeAll();
  } catch (error) {
    failures.push(error);
  }
  try {
    if (f.pty.childPid !== null) {
      expect(f.pty.isRunning).toBe(false);
      let absent = false;
      try {
        process.kill(f.pty.childPid, 0);
      } catch (error) {
        absent = (error as NodeJS.ErrnoException).code === 'ESRCH';
      }
      expect(absent).toBe(true);
    }
  } catch (error) {
    failures.push(error);
  }
  if (failures.length) {
    console.error('Owned terminal capture evidence retained', f.home);
    if (failures.length === 1) throw failures[0];
    throw new AggregateError(failures, 'Owned capture failed');
  }
  fs.rmSync(f.home, { recursive: true, force: true });
}
function owned(initial: string, size: TerminalSize) {
  const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'remi-terminal-capture-')));
  const prefix = join(home, 'child');
  const output: string[] = [];
  const errors: Error[] = [];
  let exits = 0;
  let sequence = 0;
  const pty = new PTYSession(
    {
      command: process.execPath,
      args: [
        '--no-env-file',
        resolve(import.meta.dir, '../helpers/terminal-output-child.ts'),
        '--owned-output-child',
        prefix,
        initial,
      ],
      cwd: home,
      env: { HOME: home },
      size,
    },
    {
      onData: (text) => output.push(text),
      onError: (error) => errors.push(error),
      onExit: () => {
        exits++;
      },
    },
  );
  const host = new TerminalCaptureHost(home);
  const sessionId = randomUUID();
  return {
    home,
    prefix,
    pty,
    host,
    sessionId,
    output,
    errors,
    exits: () => exits,
    ready: async () => {
      await until(() => fs.existsSync(`${prefix}.ready`));
      const result = JSON.parse(fs.readFileSync(`${prefix}.ready`, 'utf8')) as {
        pid: number;
        size: number[];
      };
      const pid = pty.childPid;
      if (pid === null) throw new Error('Owned terminal child PID absent');
      expect(result.pid).toBe(pid);
      expect(result.size).toEqual([size.cols, size.rows]);
    },
    command: async (kind: 'output' | 'size', text = '') => {
      sequence++;
      fs.writeFileSync(
        `${prefix}.next`,
        JSON.stringify({ sequence, kind, output: Buffer.from(text).toString('base64') }),
      );
      fs.renameSync(`${prefix}.next`, `${prefix}.command`);
      let result: { sequence: number; size: number[] } | undefined;
      await until(() => {
        if (!fs.existsSync(`${prefix}.ack`)) return false;
        result = JSON.parse(fs.readFileSync(`${prefix}.ack`, 'utf8')) as {
          sequence: number;
          size: number[];
        };
        return result.sequence === sequence;
      });
      return result;
    },
    inputReceipt: () =>
      JSON.parse(fs.readFileSync(`${prefix}.input`, 'utf8')) as { inputBytes: number; pid: number },
  };
}

async function take(
  f: ReturnType<typeof owned>,
  firstLine: string,
): Promise<BorrowedTerminalFrame> {
  const accepted: BorrowedTerminalFrame[] = [];
  await until(() => {
    const frame = f.host.contextFor(f.sessionId)?.borrow();
    if (!frame) return false;
    if (frame.snapshot.lines[0] === firstLine) {
      accepted.push(frame);
      return true;
    }
    frame.release();
    return false;
  });
  const frame = accepted[0];
  if (!frame) throw new Error('Owned terminal frame absent');
  return frame;
}

test('actual launch capture, redraw/alternate/Unicode/native resize and zero input', async () => {
  await fixture(async (f) => {
    expect(await f.host.prepare(f.sessionId, f.pty)).toBe(true);
    expect(f.host.contextFor(f.sessionId)).toBeNull();
    await f.pty.start();
    await f.ready();
    const first = await take(f, 'FIRST');
    expect(first.snapshot.columns).toBe(20);
    expect(first.snapshot.rows).toBe(4);
    const context = f.host.contextFor(f.sessionId);
    expect(context?.borrow()).toBeNull();
    first.release();
    first.release();
    await f.command('output', '\x1b[2J\x1b[HABCDE\rxy');
    const redraw = await take(f, 'xyCDE');
    expect(redraw.revision).toBeGreaterThan(first.revision);
    redraw.release();
    await f.command('output', '\x1b[?1049h\x1b[Halt');
    (await take(f, 'alt')).release();
    await f.command('output', '\x1b[?1049l');
    (await take(f, 'xyCDE')).release();
    await f.command('output', '\x1b[2J\x1b[HA界e\u0301B');
    (await take(f, 'A界e\u0301B')).release();
    f.pty.resize({ cols: 30, rows: 6 });
    expect((await f.command('size'))?.size).toEqual([30, 6]);
    const resized = await take(f, 'A界e\u0301B');
    expect([resized.snapshot.columns, resized.snapshot.rows]).toEqual([30, 6]);
    expect(resized.snapshot.cursor).toEqual({ row: 0, column: 5 });
    expect(Object.isFrozen(resized.snapshot)).toBe(true);
    await f.pty.close(1000);
    await until(() => !context?.available);
    expect(context?.borrow()).toBeNull();
    expect(ledgerRows(f.home)).toHaveLength(1); // Borrow still owns its model charge after exit.
    resized.release();
    await until(() => ledgerRows(f.home).length === 0);
    expect(f.inputReceipt().inputBytes).toBe(0);
    expect(f.errors).toEqual([]);
    expect(f.output.join('')).toContain('FIRST');
    expect(f.output.join('')).toContain('A界e\u0301B');
    expect(f.exits()).toBe(1);
  });
});

test('a predating PTY has no fabricated launch capture', async () => {
  await fixture(async (f) => {
    await f.pty.start();
    await f.ready();
    expect(await f.host.prepare(f.sessionId, f.pty)).toBe(false);
    expect(f.host.contextFor(f.sessionId)).toBeNull();
    expect(fs.existsSync(join(f.home, 'terminal-view'))).toBe(false);
    await f.pty.close(1000);
    expect(f.inputReceipt().inputBytes).toBe(0);
  });
});

test('fragmented native maximum-text output keeps a complete bounded viewport', async () => {
  await fixture(
    async (f) => {
      expect(await f.host.prepare(f.sessionId, f.pty)).toBe(true);
      await f.pty.start();
      await f.ready();
      (await take(f, 'FIRST')).release();
      const text = '\ue000'.repeat(3968) + 'é'.repeat(10432);
      expect(Buffer.byteLength(text)).toBe(32768);
      await f.command('output', `\x1b[2J\x1b[H${text}`);
      await until(() => {
        const context = f.host.contextFor(f.sessionId);
        expect(context, 'maximum native text retains capture').not.toBeNull();
        const frame = context?.borrow();
        if (!frame) return false;
        const size = frame.snapshot.lines.reduce((sum, line) => sum + Buffer.byteLength(line), 0);
        frame.release();
        return size === 32768;
      });
      await f.pty.close(1000);
      expect(f.inputReceipt().inputBytes).toBe(0);
    },
    'FIRST',
    { cols: 240, rows: 60 },
  );
});

test('unsupported initial geometry remains unavailable after later local resize', async () => {
  await fixture(
    async (f) => {
      expect(await f.host.prepare(f.sessionId, f.pty)).toBe(true);
      await f.pty.start();
      await f.ready();
      expect(f.host.contextFor(f.sessionId)).toBeNull();
      f.pty.resize({ cols: 20, rows: 4 });
      await f.command('output', '\x1b[2J\x1b[Hlater');
      expect(f.host.contextFor(f.sessionId)).toBeNull();
      await until(() => ledgerRows(f.home).length === 0);
      expect(f.output.join('')).toContain('FIRST');
      await f.pty.close(1000);
      expect(f.inputReceipt().inputBytes).toBe(0);
    },
    'FIRST',
    { cols: 20, rows: 61 },
  );
});

test('unsupported output retires capture while original PTY output continues', async () => {
  await fixture(async (f) => {
    expect(await f.host.prepare(f.sessionId, f.pty)).toBe(true);
    await f.pty.start();
    await f.ready();
    (await take(f, 'FIRST')).release();
    await f.command('output', '\x1bPqowned unsupported\x1b\\AFTER');
    await until(() => f.host.contextFor(f.sessionId) === null);
    await until(() => f.output.join('').includes('AFTER'));
    await until(() => ledgerRows(f.home).length === 0);
    await f.pty.close(1000);
    expect(f.inputReceipt().inputBytes).toBe(0);
  });
});

test('full home budget disables optional capture and preserves agent output', async () => {
  await fixture(async (f) => {
    const ledger = TerminalReservations.open(f.home);
    const reservations = Array.from({ length: 32 }, () => ledger.reserveModel(randomUUID()));
    expect(await f.host.prepare(f.sessionId, f.pty)).toBe(false);
    await f.pty.start();
    await f.ready();
    expect(f.host.contextFor(f.sessionId)).toBeNull();
    await until(() => f.output.join('').includes('FIRST'));
    expect(ledgerRows(f.home)).toHaveLength(32);
    await f.pty.close(1000);
    expect(f.inputReceipt().inputBytes).toBe(0);
    for (const reservation of reservations) ledger.release(reservation);
  });
});

test('failed native spawn retires its already reserved model', async () => {
  const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'remi-capture-spawn-')));
  const host = new TerminalCaptureHost(home);
  const id = randomUUID();
  const pty = new PTYSession({ command: join(home, 'absent-command'), cwd: home });
  try {
    expect(await host.prepare(id, pty)).toBe(true);
    await expect(pty.start()).rejects.toThrow();
    expect(host.contextFor(id)).toBeNull();
    await until(() => ledgerRows(home).length === 0);
    expect(pty.childPid).toBeNull();
  } finally {
    await host.closeAll();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('closing an unstarted PTY retires its preparation', async () => {
  await fixture(async (f) => {
    expect(await f.host.prepare(f.sessionId, f.pty)).toBe(true);
    await f.pty.close();
    expect(f.host.contextFor(f.sessionId)).toBeNull();
    await until(() => ledgerRows(f.home).length === 0);
    expect(f.pty.childPid).toBeNull();
  });
});

test('a disposed launch observer cannot be replaced before spawn', async () => {
  await fixture(async (f) => {
    const observer: PTYReadObserver = {
      starting() {},
      output() {},
      resized() {},
      ended() {},
      unavailable() {},
    };
    const handle = f.pty.observeFromLaunch(observer);
    expect(handle).not.toBeNull();
    handle?.dispose();
    expect(handle?.active).toBe(false);
    expect(f.pty.observeFromLaunch(observer)).toBeNull();
    expect(await f.host.prepare(f.sessionId, f.pty)).toBe(false);
    await until(() => ledgerRows(f.home).length === 0);
    await f.pty.start();
    await f.ready();
    await f.pty.close(1000);
    expect(f.inputReceipt().inputBytes).toBe(0);
  });
});

test('lost quota metadata permits no further borrowed frame or fabricated accounting', async () => {
  await fixture(async (f) => {
    expect(await f.host.prepare(f.sessionId, f.pty)).toBe(true);
    await f.pty.start();
    await f.ready();
    (await take(f, 'FIRST')).release();
    const context = f.host.contextFor(f.sessionId);
    fs.unlinkSync(join(f.home, 'terminal-view', 'reservations.json'));
    expect(context?.borrow()).toBeNull();
    expect(f.host.contextFor(f.sessionId)).toBeNull();
    await f.command('output', 'AFTER');
    await until(() => f.output.join('').includes('AFTER'));
    expect(await f.host.closeAll()).toBe(false);
    expect(() => TerminalReservations.open(f.home)).toThrow();
    await f.pty.close(1000);
    expect(f.inputReceipt().inputBytes).toBe(0);
  });
});

test('shutdown preserves a borrowed model charge and leaves the agent running', async () => {
  await fixture(async (f) => {
    expect(await f.host.prepare(f.sessionId, f.pty)).toBe(true);
    await f.pty.start();
    await f.ready();
    const frame = await take(f, 'FIRST');
    expect(await f.host.closeAll()).toBe(false);
    expect(ledgerRows(f.home)).toHaveLength(1);
    expect(f.pty.isRunning).toBe(true);
    await f.command('output', 'AFTER');
    await until(() => f.output.join('').includes('AFTER'));
    frame.release();
    expect(await f.host.closeAll()).toBe(true);
    expect(ledgerRows(f.home)).toHaveLength(0);
    await f.pty.close(1000);
    expect(f.inputReceipt().inputBytes).toBe(0);
  });
});

test('buffered source bytes precede a successful local geometry change', async () => {
  await fixture(
    async (f) => {
      // Cursor commands reach the emulator; attributes are deliberately filtered out.
      const prefix = '\x1b[1G'.repeat(204);
      const marker = '\x1b[1;200HOLD-CELL';
      const reference = new BoundedScreen(240, 60);
      for (const text of ['FIRST\x1b[6n', prefix, marker]) {
        expect(reference.observe(new TextEncoder().encode(text))).toBe(true);
        await reference.whenIdle();
      }
      reference.resize(120, 60);
      await reference.whenIdle();
      const expected = reference.snapshot();
      if (!expected) throw new Error('Owned geometry reference is unavailable');
      expect(await f.host.prepare(f.sessionId, f.pty)).toBe(true);
      await f.pty.start();
      await f.ready();
      (await take(f, 'FIRST')).release();
      const record = (
        Reflect.get(f.host, 'captures') as Map<string, { screen: BoundedScreen; ingress: unknown }>
      ).get(f.sessionId);
      if (!record) throw new Error('Owned capture record absent');
      const emulator = Reflect.get(record.screen, 'terminal') as {
        write(data: string | Uint8Array, callback?: () => void): void;
      };
      const descriptor = Object.getOwnPropertyDescriptor(emulator, 'write');
      const original = emulator.write;
      const barrier: { release?: () => void; signal?: () => void } = {};
      const reached = new Promise<void>((resolve) => {
        barrier.signal = resolve;
      });
      let hold = true;
      emulator.write = (data, callback) =>
        original.call(emulator, data, () => {
          if (hold && callback) {
            hold = false;
            barrier.release = callback;
            barrier.signal?.();
          } else callback?.();
        });
      try {
        // Defer one real completion, not its output, to force a buffered byte/resize interleaving.
        await f.command('output', prefix);
        await reached;
        await f.command('output', marker);
        await until(() => record.ingress !== null);
        f.pty.resize({ cols: 120, rows: 60 });
        barrier.release?.();
        let observed = false;
        await until(() => {
          const frame = f.host.contextFor(f.sessionId)?.borrow();
          if (!frame) return false;
          expect(frame.snapshot, 'raw byte/local resize order').toEqual(expected);
          frame.release();
          observed = true;
          return true;
        });
        expect(observed).toBe(true);
      } finally {
        barrier.release?.();
        if (descriptor) Object.defineProperty(emulator, 'write', descriptor);
        else Reflect.deleteProperty(emulator, 'write');
        reference.retire();
      }
      await f.pty.close(1000);
      expect(f.inputReceipt().inputBytes).toBe(0);
    },
    'FIRST\x1b[6n',
    { cols: 240, rows: 60 },
  );
});

test.each(['starting', 'output', 'resized', 'ended'] as const)(
  'a throwing %s observer cannot interrupt the original PTY lifecycle',
  async (phase) => {
    await fixture(async (f) => {
      let unavailable = 0;
      const observer: PTYReadObserver = {
        starting() {},
        output() {},
        resized() {},
        ended() {},
        unavailable() {
          unavailable++;
          throw new Error('owned failure callback');
        },
      };
      observer[phase] = () => {
        throw new Error('owned observer failure');
      };
      const handle = f.pty.observeFromLaunch(observer);
      expect(handle).not.toBeNull();
      expect(f.pty.observeFromLaunch(observer)).toBeNull();
      await f.pty.start();
      await f.ready();
      await until(() => f.output.join('').includes('FIRST'));
      if (phase === 'resized') {
        f.pty.resize({ cols: 30, rows: 6 });
        expect((await f.command('size'))?.size).toEqual([30, 6]);
      }
      await f.pty.close(1000);
      expect(handle?.active).toBe(false);
      expect(unavailable).toBe(1);
      expect(f.errors).toEqual([]);
      expect(f.exits()).toBe(1);
      expect(f.inputReceipt().inputBytes).toBe(0);
    });
  },
);
