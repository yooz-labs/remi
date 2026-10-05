/**
 * The neutral PTY spawn parameters (#1176 item 5): `launch` (`command` and `childEnv`) and
 * `outputSink` on `createPtySessionForSession`.
 *
 * Every case drives a genuine PTY child (a small executable script on PATH,
 * the pattern of `pty-session-setup.test.ts`), so what is asserted is what the
 * child process actually received, not what the factory was handed. The first
 * test is the zero-change claim for Claude: with none of the new parameters,
 * the spawn is `claude <extraArgs>` with `REMI_PORT` and the inline-renderer
 * variable, exactly as before.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { UUID } from '@remi/shared';
import type { MessageAPI } from '../../../src/api/message-api.ts';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
import {
  CLAUDE_INLINE_RENDERER_ENV,
  type PtyLaunch,
  type PtyOutputSink,
  type PtySessionSetupArgs,
  createPtySessionForSession,
} from '../../../src/cli/session-phases/pty-session-setup.ts';
import { SessionRegistryFile } from '../../../src/session/session-registry-file.ts';
import { SessionRegistry } from '../../../src/session/session-registry.ts';
import { SessionStore } from '../../../src/session/session-store.ts';

/** A sink that does nothing, for the runs that do not look at the output. */
const NOOP_SINK: PtyOutputSink = { process: () => {}, flush: () => {} };

const SID = 'b1b2b3b4-e5f6-4890-8bcd-ef0123456789' as UUID;
const fakeMessageAPI = {
  handleMessage: () => {},
  handleQuestion: () => {},
  handleStatusChange: () => {},
  reset: () => {},
} as unknown as MessageAPI;

/**
 * A command that records its name, argv, `REMI_PORT`, the inline-renderer
 * variable and `PROBE` into `$OUT/<name>.*`, prints `child-output`, then waits
 * a second before it exits. The wait is not decoration: a child that exits at
 * once, with output nobody has read yet, can deadlock Bun's terminal teardown
 * under concurrent test processes, and `bun test` then never returns.
 */
function fakeCommand(name: string, outDir: string): string {
  return `#!/bin/sh
d="${outDir}"
printf '%s' "$*" > "$d/${name}.argv"
printf '%s' "\${REMI_PORT-UNSET}" > "$d/${name}.remi_port"
printf '%s' "\${${CLAUDE_INLINE_RENDERER_ENV}-UNSET}" > "$d/${name}.renderer"
printf '%s' "\${PROBE-UNSET}" > "$d/${name}.probe"
echo "child-output"
: > "$d/${name}.done"
sleep 1
`;
}

describe('createPtySessionForSession: launch (command, childEnv) and outputSink', () => {
  let tmpDir: string;
  let outDir: string;
  let sessionRegistry: SessionRegistry;
  let savedEnv: Record<string, string | undefined>;
  let exitCodes: number[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-pty-params-'));
    outDir = path.join(tmpDir, 'out');
    const bin = path.join(tmpDir, 'bin');
    fs.mkdirSync(outDir, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    for (const name of ['claude', 'fakecodex']) {
      fs.writeFileSync(path.join(bin, name), fakeCommand(name, outDir));
      fs.chmodSync(path.join(bin, name), 0o755);
    }
    sessionRegistry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    // REMI_PORT is set in the environment of any shell already inside a remi
    // session (including a developer's), so it is cleared: the child must get
    // it from the factory or not at all.
    savedEnv = {
      PATH: process.env['PATH'],
      REMI_PORT: process.env['REMI_PORT'],
      [CLAUDE_INLINE_RENDERER_ENV]: process.env[CLAUDE_INLINE_RENDERER_ENV],
      PROBE: process.env['PROBE'],
    };
    // Only the fakes and the system directories: if the launch ever resolves a
    // different command than the test expects, it cannot find a developer's
    // real `claude` or `codex` (a test must never start those).
    process.env['PATH'] = `${bin}:/usr/bin:/bin`;
    for (const key of ['REMI_PORT', CLAUDE_INLINE_RENDERER_ENV, 'PROBE']) {
      Reflect.deleteProperty(process.env, key);
    }
    exitCodes = [];
    configureLogger({ writeLog: () => {} });
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    __resetLoggerForTests();
    await sessionRegistry.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Spawn with the given overrides and wait until the child ran and the exit handler finished. */
  async function run(
    outputSink: PtyOutputSink,
    overrides: Partial<PtySessionSetupArgs>,
    marker: string,
  ): Promise<void> {
    const pty = createPtySessionForSession(
      {
        sessionRegistry,
        sessionStore: new SessionStore(path.join(tmpDir, 'sessions.json')),
        liveSessionsRegistry: new SessionRegistryFile(path.join(tmpDir, 'live-sessions')),
        outputSink,
        wsPort: 9999,
        sendMessage: () => {},
        cleanup: async () => {},
        exitProcess: (code) => exitCodes.push(code),
      },
      {
        sessionId: SID,
        workingDirectory: tmpDir,
        extraArgs: ['--flag', 'value'],
        passThrough: false,
        ...overrides,
      },
    );
    sessionRegistry.registerSession(SID, tmpDir, pty, fakeMessageAPI);
    await pty.start();
    const deadline = Date.now() + 5000;
    while (
      Date.now() < deadline &&
      !(fs.existsSync(path.join(outDir, marker)) && exitCodes.length > 0)
    ) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(fs.existsSync(path.join(outDir, marker))).toBe(true);
    expect(exitCodes).toEqual([0]);
  }

  const seen = (file: string) => fs.readFileSync(path.join(outDir, file), 'utf8');

  /** A sink that records what it is fed, in order. */
  function recordingSink(): PtyOutputSink & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      process: (text) => calls.push(`process:${text.trim()}`),
      flush: () => calls.push('flush'),
    };
  }

  test('with none of the new parameters it is the Claude launch: claude, its args, REMI_PORT and the inline renderer', async () => {
    await run(NOOP_SINK, {}, 'claude.done');

    expect(seen('claude.argv')).toBe('--flag value');
    expect(seen('claude.remi_port')).toBe('9999');
    expect(seen('claude.renderer')).toBe('1');
    expect(fs.existsSync(path.join(outDir, 'fakecodex.done'))).toBe(false);
  });

  test('a launch spawns its command instead of claude', async () => {
    await run(NOOP_SINK, { launch: { command: 'fakecodex', childEnv: {} } }, 'fakecodex.done');

    expect(seen('fakecodex.argv')).toBe('--flag value');
    expect(fs.existsSync(path.join(outDir, 'claude.done'))).toBe(false);
  });

  test('an empty childEnv adds nothing: no REMI_PORT, no inline-renderer variable', async () => {
    await run(NOOP_SINK, { launch: { command: 'fakecodex', childEnv: {} } }, 'fakecodex.done');

    expect(seen('fakecodex.remi_port')).toBe('UNSET');
    expect(seen('fakecodex.renderer')).toBe('UNSET');
  });

  test('childEnv reaches the child verbatim, and replaces the Claude defaults', async () => {
    await run(
      NOOP_SINK,
      { launch: { command: 'fakecodex', childEnv: { PROBE: 'from-child-env' } } },
      'fakecodex.done',
    );

    expect(seen('fakecodex.probe')).toBe('from-child-env');
    expect(seen('fakecodex.remi_port')).toBe('UNSET');
    expect(seen('fakecodex.renderer')).toBe('UNSET');
  });

  test('the child output sink gets the child data, then one flush when it exits', async () => {
    const sink = recordingSink();

    await run(sink, { launch: { command: 'fakecodex', childEnv: {} } }, 'fakecodex.done');

    expect(sink.calls.some((c) => c === 'process:child-output')).toBe(true);
    expect(sink.calls.filter((c) => c === 'flush')).toHaveLength(1);
    expect(sink.calls.at(-1)).toBe('flush');
  });

  test('a sink that does nothing still lets the exit path run', async () => {
    await run(NOOP_SINK, { launch: { command: 'fakecodex', childEnv: {} } }, 'fakecodex.done');

    // run() asserts the exit handler reached exitProcess; the session is closed.
    expect(sessionRegistry.getSession(SID)).toBeUndefined();
  });
  describe('a launch must carry its own environment', () => {
    function build(launch: unknown): ReturnType<typeof createPtySessionForSession> {
      return createPtySessionForSession(
        {
          sessionRegistry,
          sessionStore: new SessionStore(path.join(tmpDir, 'sessions.json')),
          liveSessionsRegistry: new SessionRegistryFile(path.join(tmpDir, 'live-sessions')),
          outputSink: NOOP_SINK,
          wsPort: 9999,
          sendMessage: () => {},
          cleanup: async () => {},
          exitProcess: () => {},
        },
        {
          sessionId: SID,
          workingDirectory: tmpDir,
          extraArgs: [],
          passThrough: false,
          launch: launch as PtyLaunch,
        },
      );
    }

    test('a command with no childEnv is a type error', () => {
      const args: PtySessionSetupArgs = {
        sessionId: SID,
        workingDirectory: tmpDir,
        extraArgs: [],
        passThrough: false,
        // @ts-expect-error `childEnv` is required whenever `command` is given
        launch: { command: 'fakecodex' },
      };
      expect(args.launch?.command).toBe('fakecodex');
    });

    test("and, for a caller the types do not reach, a thrown error, never Claude's environment", () => {
      expect(() => build({ command: 'fakecodex' })).toThrow(
        'launch needs both a command and a childEnv',
      );
      expect(() => build({ command: 'fakecodex', childEnv: undefined })).toThrow(
        'launch needs both',
      );
      expect(() => build({ command: 'fakecodex', childEnv: null })).toThrow('launch needs both');
      expect(() => build({ childEnv: {} })).toThrow('launch needs both');
      expect(() => build({ command: '', childEnv: {} })).toThrow('launch needs both');
      expect(() => build({ command: 5, childEnv: {} })).toThrow('launch needs both');
    });

    test('a complete launch, and no launch at all, are both accepted', () => {
      expect(() => build({ command: 'fakecodex', childEnv: {} })).not.toThrow();
      expect(() => build(undefined)).not.toThrow();
    });
  });
});
