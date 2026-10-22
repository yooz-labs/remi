import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bundledPackages } from '../../../../scripts/third-party-notices';
import { BoundedScreen, SCREEN_LIMITS } from '../../src/terminal/screen';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
async function write(model: BoundedScreen, text: string): Promise<void> {
  expect(model.observe(encode(text))).toBe(true);
  await model.whenIdle();
}

describe('bounded read-only terminal screen (#1608)', () => {
  test('owns queued bytes, applies redraws and exposes one immutable current snapshot', async () => {
    const model = new BoundedScreen(20, 4);
    try {
      const original = encode('ABCDE\r\x1b[2Kowned');
      expect(model.observe(original)).toBe(true);
      original.fill(88);
      await model.whenIdle();
      const snapshot = model.snapshot();
      expect(snapshot?.lines[0]).toBe('owned');
      expect(snapshot?.cursor).toEqual({ row: 0, column: 5 });
      expect(model.snapshot()).toBe(snapshot);
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot?.lines)).toBe(true);
      await write(model, '\x1b[?1049h\x1b[Halternate');
      expect(model.snapshot()?.lines[0]).toBe('alternate');
      await write(model, '\x1b[?1049l');
      expect(model.snapshot()?.lines[0]).toBe('owned');
      expect(model.snapshot()).not.toBe(snapshot);
    } finally {
      model.retire();
    }
  });

  test('supports split UTF-8, cursor restore, and complete synchronized draws', async () => {
    const model = new BoundedScreen(20, 4);
    try {
      for (const byte of encode('界e\u0301')) {
        expect(model.observe(new Uint8Array([byte]))).toBe(true);
        await model.whenIdle();
      }
      expect(model.snapshot()?.lines[0]).toBe('界e\u0301');
      expect(model.snapshot()?.cursor?.column).toBe(3);
      await write(model, '\x1b[2K\rabc\x1b[sXX\x1b[uZ');
      expect(model.snapshot()?.lines[0]).toBe('abcZX');
      await write(model, '\x1b[?2026h\rnew');
      expect(model.snapshot()).toBeNull();
      await write(model, '\x1b[?2026l\x1b[?25l');
      expect(model.snapshot()?.lines[0]).toBe('newZX');
      expect(model.snapshot()?.cursor).toBeNull();
    } finally {
      model.retire();
    }
  });

  test('bounds queued bytes and operations before copying, including in-flight input', async () => {
    const model = new BoundedScreen(240, 60);
    for (let index = 0; index < 8; index++) {
      expect(model.observe(encode('x'.repeat(8192)))).toBe(true);
    }
    expect(model.pending).toEqual({ bytes: 65536, operations: 8 });
    expect(model.observe(encode('x'))).toBe(false);
    await model.whenIdle();
    expect(model.reason).toBe('backpressure');
    expect(model.pending).toEqual({ bytes: 0, operations: 0 });
    expect(model.snapshot()).toBeNull();
  });

  test('drains output admitted immediately after a synchronous resize', async () => {
    const model = new BoundedScreen(20, 4);
    try {
      expect(model.resize(30, 6)).toBe(true);
      expect(model.observe(encode('new'))).toBe(true);
      await model.whenIdle();
      expect(model.pending).toEqual({ bytes: 0, operations: 0 });
      expect(model.snapshot()?.lines[0]).toBe('new');
    } finally {
      model.retire();
    }
  });

  test('normalizes cursor and synchronized-output modes consistently', async () => {
    const model = new BoundedScreen(20, 4);
    try {
      await write(model, 'old\x1b[?025l');
      expect(model.snapshot()?.cursor).toBeNull();
      await write(model, '\x1b[?02026h\rnew');
      expect(model.snapshot()).toBeNull();
      await write(model, '\x1b[?02026l\x1b[?025h');
      expect(model.snapshot()?.lines[0]).toBe('new');
      expect(model.snapshot()?.cursor).toEqual({ row: 0, column: 3 });
    } finally {
      model.retire();
    }
  });

  test.each([
    ['concealed content', '\x1b[8mhidden'],
    ['ambiguous color that enables concealment', '\x1b[38;2;0:0;8mhidden'],
    ['repeated combined cells', `e\u0301\x1b[239b\r${'X'.repeat(240)}`],
    ['graphics', '\x1bPqgraphic\x1b\\'],
    ['OSC graphics', '\x1b]1337;File=owned\x07'],
    ['cancelled OSC', '\x1b]0;title\x18visible'],
    ['malformed OSC terminator', '\x1b]0;title\x1b[Hvisible'],
    ['oversized control', `\x1b[${'1;'.repeat(80)}H`],
    ['oversized repeat parameter', '\x1b[241b'],
    ['repeated alternate-mode work', `\x1b[?${'1049;'.repeat(8)}1049h`],
    ['amplified full-screen clears', '\x1b[2J'.repeat(64)],
    ['oversized metadata', `\x1b]0;${'a'.repeat(16385)}\x07`],
    ['oversized cell', `e${'\u0301'.repeat(32)}`],
    ['cumulative joining input', 'e\u0301'.repeat(SCREEN_LIMITS.combiningBytes / 2 + 1)],
    ['visible text quota', '\ue000'.repeat(12000)],
    ['misleading display control', '\u202eowned'],
  ])('retires the observer for %s without returning a partial screen', async (_name, text) => {
    const model = new BoundedScreen(240, 60);
    model.observe(encode(text));
    await model.whenIdle();
    expect(model.available).toBe(false);
    expect(model.snapshot()).toBeNull();
    expect(model.observe(encode('new input'))).toBe(false);
  });

  test('discards bounded clipboard/link/title metadata and ordinary attributes', async () => {
    const model = new BoundedScreen(40, 4);
    try {
      await write(model, '\x1b]52;c;YWJj\x07\x1b]8;;https://owned.invalid\x1b\\');
      await write(model, '\x1b[38;5;8ma\x1b[38;2;0;0;8mb\x1b[0m');
      expect(model.snapshot()?.lines[0]).toBe('ab');
    } finally {
      model.retire();
    }
  });

  test('rejects invalid geometry and malformed UTF-8, and resolves retirement while parsing', async () => {
    // The pinned emulator clamps one column to two; do not misreport that screen.
    expect(new BoundedScreen(1, 1).available).toBe(false);
    expect(new BoundedScreen(241, 60).available).toBe(false);
    const malformed = new BoundedScreen(40, 4);
    malformed.observe(new Uint8Array([0xc0, 0xaf]));
    await malformed.whenIdle();
    expect(malformed.snapshot()).toBeNull();
    const active = new BoundedScreen(240, 60);
    active.observe(encode('x'.repeat(65536)));
    active.retire();
    await active.whenIdle();
    expect(active.pending).toEqual({ bytes: 0, operations: 0 });
    expect(active.snapshot()).toBeNull();
  });

  test('a bundle of the actual screen includes the exact pinned upstream license', async () => {
    const root = resolve(import.meta.dir, '../../../..');
    const packages = await bundledPackages('packages/daemon/src/terminal/screen.ts', root);
    const xterm = packages.find((entry) => entry.name === '@xterm/headless');
    expect(xterm?.version).toBe('6.0.0');
    expect(xterm?.licenseText).toBe(
      readFileSync(resolve(root, 'node_modules/@xterm/headless/LICENSE'), 'utf8').trim(),
    );
  });
});
