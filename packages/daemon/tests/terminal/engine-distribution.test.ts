/** Constructs the installed model and verifies the generated distribution, not a replacement engine. */
import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Terminal } from '@xterm/headless';
import { headlessPackageRoot } from '../../../../scripts/terminal-engine/source';
import { BoundedScreen } from '../../src/terminal/screen';

test('installed and published engines preserve actual colored buffer behavior', async () => {
  const module = await import(
    pathToFileURL(join(headlessPackageRoot(), 'lib-headless/xterm-headless.js')).href
  );
  const Published = module.Terminal as typeof Terminal;
  expect(Published).not.toBe(Terminal);
  const options = {
    cols: 20,
    rows: 4,
    scrollback: 0,
    allowProposedApi: true,
    disableStdin: true,
    logLevel: 'off' as const,
  };
  const original = new Published(options);
  const installed = new Terminal(options);
  const state = (terminal: Terminal) =>
    [terminal.buffer.normal, terminal.buffer.alternate].map((buffer) => ({
      cursor: [buffer.cursorX, buffer.cursorY],
      lines: Array.from({ length: buffer.length }, (_, row) => {
        const line = buffer.getLine(row);
        assert(line);
        return {
          text: line.translateToString(false),
          wrapped: line.isWrapped,
          cells: Array.from({ length: line.length }, (_, column) => {
            const cell = line.getCell(column);
            assert(cell);
            return {
              chars: cell.getChars(),
              width: cell.getWidth(),
              fg: Reflect.get(cell, 'fg'),
              bg: Reflect.get(cell, 'bg'),
              extended: Reflect.get(cell, 'extended'),
            };
          }),
        };
      }),
    }));
  try {
    for (const text of [
      'ABCDE\rxy',
      '\x1b[31;44;1mcolor\x1b[0m',
      '\r\x1b[@\x1b[2P',
      '\x1b[HA界e\u0301B\x1b[38;2;10;20;30mRGB\x1b[0m',
      '\x1b[?1049h\x1b[H\x1b[48;5;8malternate\x1b[0m',
      '\x1b[?1049l\x1b[2;1H\x1b[4:3munderlined\x1b[0m',
      '\x1b[1"qprotected\x1b[0"q\x1b[?2J',
      '\r\n1\r\n2\r\n3\r\n4\r\n5',
    ]) {
      await Promise.all(
        [original, installed].map(
          (terminal) => new Promise<void>((done) => terminal.write(text, done)),
        ),
      );
      expect(state(installed)).toEqual(state(original));
    }
    for (const [columns, rows] of [
      [10, 6],
      [30, 3],
      [20, 4],
    ] as const) {
      original.resize(columns, rows);
      installed.resize(columns, rows);
      expect(state(installed)).toEqual(state(original));
    }
  } finally {
    original.dispose();
    installed.dispose();
  }
});

test('the installed engine stays within the monochrome backing-store budget', async () => {
  const model = new BoundedScreen(240, 60);
  try {
    expect(
      model.observe(
        new TextEncoder().encode('normal\x1b[?1049h\x1b[H\x1b[38;5;8malternate\x1b[0m'),
      ),
    ).toBe(true);
    await model.whenIdle();
    expect(model.snapshot()?.lines[0]).toBe('alternate');
    const terminal = Reflect.get(model, 'terminal');
    let bytes = 0;
    let lines = 0;
    for (const buffer of [terminal.buffer.normal, terminal.buffer.alternate]) {
      for (let row = 0; row < buffer.length; row++) {
        const line = Reflect.get(buffer.getLine(row), '_line');
        for (const key of ['_data', '_fg', '_bg']) bytes += Reflect.get(line, key)?.byteLength ?? 0;
        lines++;
      }
    }
    expect(lines).toBe(120);
    expect(bytes).toBeLessThanOrEqual(115200);
  } finally {
    model.retire();
    await model.whenIdle();
  }
});

test('the installed derived engine reproduces from pinned source and patch', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'remi-engine-reproduce-')));
  const root = resolve(import.meta.dir, '../../../..');
  const child = Bun.spawn(
    [process.execPath, '--no-env-file', 'scripts/terminal-engine/build.ts', '--check'],
    {
      cwd: root,
      env: {
        HOME: home,
        REMI_HOME: join(home, 'state'),
        TMPDIR: home,
        LANG: 'en_US.UTF-8',
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 7000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    assert.equal(code, 0, (stdout + stderr).slice(-4000));
    expect(stdout).toContain('Terminal engine reproduction passed');
    expect(stderr).toBe('');
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null) child.kill('SIGKILL');
    await child.exited;
    rmSync(home, { recursive: true, force: true });
  }
}, 10000);
