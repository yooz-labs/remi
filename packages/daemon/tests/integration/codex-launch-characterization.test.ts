/**
 * Black-box characterization of `remi codex`: launch, identity and status
 * (#1177, Phase 3 of the Codex epic #1175). Written against the plan's Phase 3
 * section before any implementation, in the shape of
 * `launch-characterization.test.ts` (Claude).
 *
 * It spawns the REAL `cli.ts` in an isolated `$HOME` (`isolatedEnv` also drops
 * `REMI_HOME`), with an executable fake `codex` first on a PATH of fakes plus
 * `/usr/bin:/bin` only, so no real `claude` or `codex` can ever resolve (a
 * stand-in login shell reports that same PATH). The fake `codex` is a real
 * process: it records its argv, cwd, selected environment and pid, and counts
 * every byte that reaches its stdin. `CODEX_HOME` points at a `FakeAppServer`
 * (a real WebSocket server on a unix socket, behind a symlink, replaying
 * redacted spike frames), and the test plays the Codex TUI by emitting the
 * real `thread/started` and `thread/status/changed` frames with its own thread
 * ids, the session's cwd and a fresh creation time.
 *
 * Everything asserted is read off what that process, the daemon or the fake
 * server saw on disk or on the wire, so it holds for any implementation of the
 * launch. The live check against the owner's Codex (LV-2) is NOT part of this
 * file.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  ErrorMessage,
  HelloAckMessage,
  ProtocolMessage,
  SessionUpdateMessage,
} from '@remi/shared/protocol.ts';
import { PROMPT_WAITING_ERROR_CODE, createUserInput, serialize } from '@remi/shared/protocol.ts';
import { olderRemiNotice } from '../../src/harness/codex/codex-session.ts';
import { IDENTITY_SHIM_MIN_VERSION } from '../../src/session/legacy-writers.ts';
import { type Json, threadStartedFrame, threadStatusFrame } from '../helpers/codex-threads.ts';
import { FakeAppServer } from '../helpers/fake-app-server.ts';
import { reserveRange } from '../session/port-test-helpers.ts';
import {
  CLI_TS,
  cleanupHub,
  connectAndHello,
  isolatedEnv,
  makeIsolatedDirs,
  pollUntil,
  spawnDaemon,
} from './hub-test-utils.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Running {
  proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  home: string;
  work: string;
  port: number;
  /** Where the fake `codex` records what it saw; `release` ends it. */
  fakeDir: string;
  server: FakeAppServer;
  /** Everything the process has written to stdout and stderr so far. */
  output: { text: string };
  /** The overrides the daemon was started with, to rebuild its environment (`startDaemon` only). */
  env?: Record<string, string>;
}

const running: Running[] = [];
const sleepers: Array<Bun.Subprocess> = [];

afterEach(async () => {
  for (const r of running.splice(0)) {
    await cleanupHub({ proc: r.proc, home: r.home, work: r.work, port: r.port });
    await r.server.stop();
  }
  for (const s of sleepers.splice(0)) s.kill('SIGKILL');
});

/**
 * A fake `codex`: records one argument per line, its cwd, the environment
 * variables the launch must or must not set, and its pid; counts every byte on
 * its stdin (raw mode, no echo, so a lone byte is seen at once) into `stdin`;
 * then waits until `release` exists (60 s at most, so a failed run cannot leave
 * it looping) and exits 0.
 */
const FAKE_CODEX = `#!/bin/sh
d="$FAKE_CODEX_DIR"
for a in "$@"; do printf '%s\\n' "$a"; done > "$d/argv"
printf '%s' "$REMI_PORT" > "$d/remi_port"
printf '%s' "$CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN" > "$d/alt_screen"
printf '%s' "$CODEX_HOME" > "$d/codex_home"
env > "$d/env"
pwd -P > "$d/cwd"
echo $$ > "$d/pid"
exec 3<&0
stty raw -echo <&3 2>/dev/null
: > "$d/stdin"
cat <&3 >> "$d/stdin" &
reader=$!
i=0
while [ ! -e "$d/release" ] && [ $i -lt 600 ]; do
  sleep 0.1
  i=$((i + 1))
done
kill $reader 2>/dev/null
`;

/** A login shell that reports the PATH it is given, so `resolveShellPath` adds nothing. */
const FAKE_SHELL = '#!/bin/sh\necho "$PATH"\n';

function read(file: string): string {
  return fs.readFileSync(file, 'utf-8');
}

/** Collect a process stream into `sink` as it is written. */
function collect(stream: ReadableStream<Uint8Array>, sink: { text: string }): void {
  const decoder = new TextDecoder();
  void (async () => {
    for await (const chunk of stream) sink.text += decoder.decode(chunk, { stream: true });
  })().catch(() => {});
}

function makeFakes(
  home: string,
  withCodex = true,
): { fakeDir: string; env: Record<string, string> } {
  const fakeDir = path.join(home, 'fake-codex');
  const fakeBin = path.join(home, 'fake-bin');
  fs.mkdirSync(fakeDir, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  if (withCodex) {
    fs.writeFileSync(path.join(fakeBin, 'codex'), FAKE_CODEX);
    fs.chmodSync(path.join(fakeBin, 'codex'), 0o755);
  }
  const shell = path.join(fakeBin, 'sh-path');
  fs.writeFileSync(shell, FAKE_SHELL);
  fs.chmodSync(shell, 0o755);
  return {
    fakeDir,
    env: { PATH: `${fakeBin}:/usr/bin:/bin`, SHELL: shell, FAKE_CODEX_DIR: fakeDir },
  };
}

/** `cli.ts --daemon --harness codex`, with the fake `codex` and a fake app-server. */
async function startDaemon(): Promise<Running> {
  const { home, work } = makeIsolatedDirs();
  const { fakeDir, env } = makeFakes(home);
  const server = FakeAppServer.start();
  const overrides = { ...env, CODEX_HOME: server.codexHome };
  const spawned = await spawnDaemon(home, work, overrides, ['--harness', 'codex']);
  const output = { text: '' };
  collect(spawned.proc.stdout, output);
  collect(spawned.proc.stderr, output);
  const r: Running = { ...spawned, home, work, fakeDir, server, output, env: overrides };
  running.push(r);
  return r;
}

/** `cli.ts codex <args>` as a wrapper (no terminal: stdin is closed and stdout is a pipe). */
/** `cli.ts <subcommand> <args>` as a wrapper; `subcommand` is `codex` unless a test needs another. */
async function startWrapper(
  args: readonly string[],
  subcommand: string | null = 'codex',
  opts: { seed?: (home: string) => void; withCodex?: boolean } = {},
): Promise<Running> {
  const { home, work } = makeIsolatedDirs();
  const { fakeDir, env } = makeFakes(home, opts.withCodex ?? true);
  opts.seed?.(home);
  const server = FakeAppServer.start();
  const port = await reserveRange(1, 50, '127.0.0.1');
  const proc = Bun.spawn(
    [
      process.execPath,
      CLI_TS,
      ...(subcommand === null ? [] : [subcommand]),
      '--port',
      String(port),
      '--no-relay',
      '--no-telegram',
      '--no-mdns',
      '--no-auth',
      ...args,
    ],
    {
      cwd: work,
      env: isolatedEnv(home, { ...env, CODEX_HOME: server.codexHome }),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const output = { text: '' };
  collect(proc.stdout, output);
  collect(proc.stderr, output);
  const r: Running = { proc, home, work, port, fakeDir, server, output };
  running.push(r);
  return r;
}

function fileExists(r: Running, name: string): boolean {
  return fs.existsSync(path.join(r.fakeDir, name));
}

async function waitForFakeCodex(r: Running): Promise<void> {
  await pollUntil(
    () => {
      if (r.proc.exitCode !== null) throw new Error(`Process exited early (${r.proc.exitCode})`);
      return fileExists(r, 'pid') && fileExists(r, 'stdin');
    },
    20000,
    'the fake codex to start',
  );
}

/** The one client of the fake app-server, once it has finished its handshake. */
async function waitForAppServerClient(r: Running): Promise<number> {
  await pollUntil(
    () => {
      const id = r.server.clientIds()[0];
      return id !== undefined && r.server.framesFrom(id).some((f) => f['method'] === 'initialized');
    },
    20000,
    'the daemon to initialize against the fake app-server',
  );
  return r.server.clientIds()[0] as number;
}

interface StoredRecord {
  remiSessionId: string;
  claudeSessionId: string | null;
  harness?: string;
  harnessSessionId?: string | null;
  projectPath: string;
  port: number;
  pid: number | null;
  exitedAt: string | null;
  exitCode: number | null;
}

function storedSessions(r: Running): StoredRecord[] {
  const file = path.join(r.home, '.remi', 'sessions.json');
  if (!fs.existsSync(file)) return [];
  return (JSON.parse(read(file)) as { sessions: StoredRecord[] }).sessions;
}

function onlyRecord(r: Running): StoredRecord {
  const sessions = storedSessions(r);
  expect(sessions).toHaveLength(1);
  return sessions[0] as StoredRecord;
}

function statusesSeen(received: ProtocolMessage[]): string[] {
  return received
    .filter((m): m is SessionUpdateMessage => m.type === 'session_update')
    .map((m) => m.session.status);
}

function resumeFrames(r: Running, client: number): Json[] {
  return r.server.framesFrom(client).filter((f) => f['method'] === 'thread/resume');
}

describe('remi codex launch (daemon, black-box characterization, #1177)', () => {
  test('spawns codex --no-alt-screen, records an identity-less codex record, and writes nothing for Claude', async () => {
    const r = await startDaemon();
    await waitForFakeCodex(r);

    // argv is exactly `--no-alt-screen`; no override flag, no session id.
    expect(read(path.join(r.fakeDir, 'argv'))).toBe('--no-alt-screen\n');
    // The child's environment is the daemon's: CODEX_HOME passes through, and nothing of
    // Claude's (REMI_PORT, the inline-renderer variable) is added.
    expect(read(path.join(r.fakeDir, 'codex_home')).trim()).toBe(r.server.codexHome);
    expect(read(path.join(r.fakeDir, 'remi_port'))).toBe('');
    expect(read(path.join(r.fakeDir, 'alt_screen'))).toBe('');
    expect(read(path.join(r.fakeDir, 'cwd')).trim()).toBe(fs.realpathSync(r.work));

    // The whole environment: the daemon's own, plus exactly what the PTY layer sets for every
    // launch, Claude's too (FORCE_COLOR=1, and TERM, which keeps the daemon's own or defaults),
    // and nothing else (W14).
    const childEnv = new Map<string, string>();
    for (const line of read(path.join(r.fakeDir, 'env')).split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(line.slice(0, eq))) {
        childEnv.set(line.slice(0, eq), line.slice(eq + 1));
      }
    }
    const parentEnv = isolatedEnv(r.home, {
      CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '',
      ...(r.env as Record<string, string>),
    });
    // What `sh` itself sets for its script, not remi.
    const shellOwn = new Set(['_', 'PWD', 'OLDPWD', 'SHLVL']);
    const ptyLayer = ['FORCE_COLOR', 'TERM'];
    const added = [...childEnv.keys()].filter((k) => !(k in parentEnv) && !shellOwn.has(k)).sort();
    expect(added).toEqual(ptyLayer.filter((k) => !(k in parentEnv)).sort());
    const changed = [...childEnv]
      .filter(([k, v]) => k in parentEnv && parentEnv[k] !== v && !shellOwn.has(k))
      .map(([k]) => k);
    expect(changed.filter((k) => !ptyLayer.includes(k))).toEqual([]);
    expect(childEnv.get('FORCE_COLOR')).toBe('1');
    expect(childEnv.get('TERM')).toBe(parentEnv['TERM'] ?? 'xterm-256color');
    expect(childEnv.get('CODEX_HOME')).toBe(r.server.codexHome);

    // sessions.json: one record that names its harness and has no Claude id.
    await pollUntil(() => storedSessions(r).length === 1, 5000, 'the stored record');
    const record = onlyRecord(r);
    expect(record.harness).toBe('codex');
    expect(record.claudeSessionId).toBeNull();
    expect(record.harnessSessionId ?? null).toBeNull();
    expect(record.exitedAt).toBeNull();
    expect(record.port).toBe(r.port);
    expect(record.pid).toBe(r.proc.pid);
    expect(record.projectPath).toBe(fs.realpathSync(r.work));

    // live-sessions: this daemon, with the spawned child's pid.
    const liveDir = path.join(r.home, '.remi', 'live-sessions');
    await pollUntil(
      () =>
        fs.existsSync(liveDir) &&
        fs
          .readdirSync(liveDir)
          .some((f) => read(path.join(liveDir, f)).includes('"claudeChildPid"')),
      10000,
      'live-sessions claudeChildPid',
    );
    const entry = JSON.parse(read(path.join(liveDir, fs.readdirSync(liveDir)[0] as string))) as {
      pid: number;
      claudeChildPid: number;
    };
    expect(entry.pid).toBe(r.proc.pid);
    expect(entry.claudeChildPid).toBe(Number(read(path.join(r.fakeDir, 'pid')).trim()));

    // Nothing Claude-specific was installed: no hook registration in the working
    // directory, no status line script, no change to the user's Claude settings.
    expect(fs.existsSync(path.join(r.work, '.claude', 'settings.local.json'))).toBe(false);
    expect(fs.existsSync(path.join(r.home, '.claude', 'settings.json'))).toBe(false);
    expect(fs.existsSync(path.join(r.home, '.remi', 'statusline.sh'))).toBe(false);
    expect(r.output.text).not.toContain('Hook server');
    // The launch says once what it cannot protect: an older remi writing sessions.json later.
    expect(r.output.text).toContain(olderRemiNotice());

    // hello_ack: a session with no Claude id.
    const { ws, received } = await connectAndHello(r.port);
    try {
      const ack = received.find((m): m is HelloAckMessage => m.type === 'hello_ack');
      expect(ack?.sessionId).toMatch(UUID_RE);
      expect(ack?.claudeSessionId ?? null).toBeNull();
    } finally {
      ws.close();
    }
  }, 40000);

  test('identity: the TUI thread binds; the title helper and another directory do not; the attach frame is exact and retried; the status maps', async () => {
    const r = await startDaemon();
    await waitForFakeCodex(r);
    const client = await waitForAppServerClient(r);
    const { ws, received } = await connectAndHello(r.port);
    try {
      const cwd = fs.realpathSync(r.work);
      const nowSec = () => Math.floor(Date.now() / 1000);
      const tuiId = crypto.randomUUID();
      const helperId = crypto.randomUUID();
      const strayId = crypto.randomUUID();

      // A user thread in a different directory (another Codex window on this machine) is not ours.
      r.server.emit(
        threadStartedFrame('tui', {
          id: strayId,
          cwd: fs.realpathSync(r.home),
          createdAtSec: nowSec(),
        }),
        { broadcast: true },
      );
      // Threads in this very directory that each break one rule of being the TUI's own: an
      // ephemeral one, one from another source, one with no environment.
      const oneRuleBroken: Array<(thread: Json) => void> = [
        (thread) => {
          thread['ephemeral'] = true;
        },
        (thread) => {
          thread['threadSource'] = 'thread_title';
        },
        (thread) => {
          thread['environments'] = [];
        },
      ];
      const brokenIds = oneRuleBroken.map(() => crypto.randomUUID());
      oneRuleBroken.forEach((tweak, i) => {
        r.server.emit(
          threadStartedFrame(
            'tui',
            { id: brokenIds[i] as string, cwd, createdAtSec: nowSec() },
            tweak,
          ),
          { broadcast: true },
        );
      });
      // The TUI's own thread: a user thread in this directory, created just now.
      r.server.emit(threadStartedFrame('tui', { id: tuiId, cwd, createdAtSec: nowSec() }), {
        broadcast: true,
      });

      await pollUntil(
        () => onlyRecord(r).harnessSessionId === tuiId,
        10000,
        'sessions.json to gain the TUI thread id',
      );
      expect(onlyRecord(r).harness).toBe('codex');
      expect(onlyRecord(r).claudeSessionId).toBeNull();

      // The first attach is exactly `thread/resume {threadId, excludeTurns: true}`, no overrides.
      await pollUntil(() => resumeFrames(r, client).length >= 1, 10000, 'the first thread/resume');
      expect((resumeFrames(r, client)[0] as Json)['params']).toStrictEqual({
        threadId: tuiId,
        excludeTurns: true,
      });

      // The title helper (ephemeral, `thread_title`, no environments) appears in the same
      // directory a moment later: it must not rotate the binding.
      r.server.emit(threadStartedFrame('title', { id: helperId, cwd, createdAtSec: nowSec() }), {
        broadcast: true,
      });
      r.server.emit(threadStatusFrame(helperId, { type: 'active', activeFlags: [] }), {
        broadcast: true,
      });

      // The app-server has no rollout yet (-32600): the attach is retried, always with
      // the same exact frame, until the rollout exists.
      await pollUntil(() => resumeFrames(r, client).length >= 2, 10000, 'a retried thread/resume');
      // Before the attach the only status reported is the TUI thread's own `idle`, from its
      // thread/started frame: the helper's `active` (and the stray thread's) changed nothing.
      expect(statusesSeen(received)).toEqual(['idle']);
      r.server.createRollout(tuiId);
      await pollUntil(
        () => r.output.text.includes(`attached to thread ${tuiId.slice(0, 8)}`),
        10000,
        'the attach to succeed after the rollout exists',
      );
      for (const frame of resumeFrames(r, client)) {
        expect(frame['params']).toStrictEqual({ threadId: tuiId, excludeTurns: true });
      }
      // Attached: no more retries.
      const attachedCount = resumeFrames(r, client).length;
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(resumeFrames(r, client)).toHaveLength(attachedCount);

      // Status is the tracked thread's: waiting on approval is `waiting`, active is `thinking`,
      // idle is `idle`; the helper's `active` above changed nothing.
      r.server.emit(
        threadStatusFrame(tuiId, { type: 'active', activeFlags: ['waitingOnApproval'] }),
        {
          broadcast: true,
        },
      );
      await pollUntil(() => statusesSeen(received).includes('waiting'), 5000, 'status waiting');
      r.server.emit(threadStatusFrame(tuiId, { type: 'active', activeFlags: [] }), {
        broadcast: true,
      });
      await pollUntil(
        () =>
          statusesSeen(received).lastIndexOf('thinking') >
          statusesSeen(received).indexOf('waiting'),
        5000,
        'status thinking after waiting',
      );
      r.server.emit(threadStatusFrame(tuiId, { type: 'idle' }), { broadcast: true });
      await pollUntil(
        () =>
          statusesSeen(received).lastIndexOf('idle') > statusesSeen(received).indexOf('waiting'),
        5000,
        'status idle after waiting',
      );
      // Identity never moved off the TUI thread.
      expect(onlyRecord(r).harnessSessionId).toBe(tuiId);

      // Thread ids are logged truncated, and other threads' frames are never logged.
      expect(r.output.text).not.toContain(tuiId);
      expect(r.output.text).not.toContain(helperId.slice(0, 8));
      expect(r.output.text).not.toContain(strayId.slice(0, 8));
      for (const id of brokenIds) expect(r.output.text).not.toContain(id.slice(0, 8));
    } finally {
      ws.close();
    }
  }, 60000);

  test('phone chat is refused and typed nowhere, naming its bubble; raw input still reaches codex (#1177)', async () => {
    const r = await startDaemon();
    await waitForFakeCodex(r);
    const { ws, received } = await connectAndHello(r.port);
    try {
      const sessionId = (
        received.find((m): m is HelloAckMessage => m.type === 'hello_ack') as HelloAckMessage
      ).sessionId as string;
      const messageId = crypto.randomUUID();
      ws.send(
        serialize(createUserInput(sessionId, 'typed chat text', false, undefined, messageId)),
      );
      await pollUntil(
        () =>
          received.some(
            (m): m is ErrorMessage =>
              m.type === 'error' &&
              m.code === PROMPT_WAITING_ERROR_CODE &&
              m.details?.['messageId'] === messageId,
          ),
        8000,
        'the PROMPT_WAITING refusal naming the bubble',
      );
      // Time for the daemon to type the text, the 50 ms pause and the Enter, were it going to.
      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(fs.statSync(path.join(r.fakeDir, 'stdin')).size).toBe(0);

      // A person's keystrokes (an attach client, the Escape button, /interrupt) are raw, and arrive.
      ws.send(serialize(createUserInput(sessionId, 'q', true)));
      await pollUntil(
        () => fs.statSync(path.join(r.fakeDir, 'stdin')).size === 1,
        8000,
        'the raw byte to reach codex',
      );
      expect(read(path.join(r.fakeDir, 'stdin'))).toBe('q');
    } finally {
      ws.close();
    }
  }, 60000);

  test('codex never receives a byte on stdin, and the daemon exits when codex exits (#641)', async () => {
    const r = await startDaemon();
    await waitForFakeCodex(r);
    const client = await waitForAppServerClient(r);
    const cwd = fs.realpathSync(r.work);
    const tuiId = crypto.randomUUID();
    r.server.emit(
      threadStartedFrame('tui', { id: tuiId, cwd, createdAtSec: Math.floor(Date.now() / 1000) }),
      { broadcast: true },
    );
    r.server.createRollout(tuiId);
    await pollUntil(
      () => r.output.text.includes(`attached to thread ${tuiId.slice(0, 8)}`),
      10000,
      'the attach',
    );
    r.server.emit(
      threadStatusFrame(tuiId, { type: 'active', activeFlags: ['waitingOnApproval'] }),
      {
        broadcast: true,
      },
    );
    await pollUntil(() => resumeFrames(r, client).length >= 1, 5000, 'an attach frame');
    // Give the daemon the time it would need to type something, were it going to.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(fs.statSync(path.join(r.fakeDir, 'stdin')).size).toBe(0);

    fs.writeFileSync(path.join(r.fakeDir, 'release'), '');
    const code = await Promise.race([
      r.proc.exited,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 15000)),
    ]);
    expect(code).toBe(0);

    // The exited record keeps its thread id, so `remi codex resume <id>` can find it again.
    const record = onlyRecord(r);
    expect(record.harness).toBe('codex');
    expect(record.harnessSessionId).toBe(tuiId);
    expect(record.exitedAt).not.toBeNull();
    expect(record.exitCode).toBe(0);
    expect(fs.statSync(path.join(r.fakeDir, 'stdin')).size).toBe(0);
  }, 60000);

  test('an older live remi makes it refuse with exit 1 before any record is written', async () => {
    const { home, work } = makeIsolatedDirs();
    const { fakeDir, env } = makeFakes(home);
    const server = FakeAppServer.start();

    // A live process that recorded no version, as a daemon from before the identity shim did.
    const sleeper = Bun.spawn(['/bin/sleep', '60'], { stdout: 'ignore', stderr: 'ignore' });
    sleepers.push(sleeper);
    const liveDir = path.join(home, '.remi', 'live-sessions');
    fs.mkdirSync(liveDir, { recursive: true });
    const legacyFile = path.join(liveDir, `${crypto.randomUUID()}.json`);
    fs.writeFileSync(
      legacyFile,
      JSON.stringify({
        sessionId: path.basename(legacyFile, '.json'),
        pid: sleeper.pid,
        wsPort: 18765,
        hookPort: 0,
        projectPath: work,
        name: 'legacy',
        startedAt: new Date().toISOString(),
      }),
    );

    const spawned = await spawnDaemon(home, work, { ...env, CODEX_HOME: server.codexHome }, [
      '--harness',
      'codex',
    ]);
    const output = { text: '' };
    collect(spawned.proc.stdout, output);
    collect(spawned.proc.stderr, output);
    const r: Running = { ...spawned, home, work, fakeDir, server, output };
    running.push(r);

    const code = await Promise.race([
      r.proc.exited,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 20000)),
    ]);
    expect(code).toBe(1);
    // The refusal names the writer's file and the version that has the shim, and what to run.
    expect(output.text).toContain(legacyFile);
    expect(output.text).toContain(IDENTITY_SHIM_MIN_VERSION);
    expect(output.text).toContain('remi stop --all');
    // No record, no child, no app-server connection.
    expect(storedSessions(r)).toEqual([]);
    expect(fileExists(r, 'pid')).toBe(false);
    expect(server.clientIds()).toEqual([]);
  }, 40000);
});

describe('remi codex launch (wrapper and refusals, #1177)', () => {
  test('remi codex resume <uuid> runs codex --no-alt-screen resume <uuid> and attaches on ready', async () => {
    const threadId = crypto.randomUUID();
    const r = await startWrapper(['resume', threadId]);
    await waitForFakeCodex(r);

    expect(read(path.join(r.fakeDir, 'argv'))).toBe(`--no-alt-screen\nresume\n${threadId}\n`);
    // The record names the thread from the start; no thread/started is needed.
    await pollUntil(() => storedSessions(r).length === 1, 5000, 'the stored record');
    const record = onlyRecord(r);
    expect(record.harness).toBe('codex');
    expect(record.claudeSessionId).toBeNull();
    expect(record.harnessSessionId).toBe(threadId);

    const client = await waitForAppServerClient(r);
    r.server.createRollout(threadId);
    await pollUntil(() => resumeFrames(r, client).length >= 1, 10000, 'thread/resume on ready');
    expect((resumeFrames(r, client)[0] as Json)['params']).toStrictEqual({
      threadId,
      excludeTurns: true,
    });
    expect(fs.existsSync(path.join(r.work, '.claude', 'settings.local.json'))).toBe(false);

    fs.writeFileSync(path.join(r.fakeDir, 'release'), '');
    expect(await Promise.race([r.proc.exited, Bun.sleep(15000).then(() => 'timeout')])).toBe(0);
    expect(fs.statSync(path.join(r.fakeDir, 'stdin')).size).toBe(0);
  }, 60000);

  test('a flag remi codex does not allow exits 2 before anything starts', async () => {
    const r = await startWrapper(['-c', 'model=x']);
    const code = await Promise.race([r.proc.exited, Bun.sleep(20000).then(() => 'timeout')]);
    expect(code).toBe(2);
    expect(r.output.text).toContain('-c');
    expect(storedSessions(r)).toEqual([]);
    expect(fileExists(r, 'pid')).toBe(false);
  }, 40000);

  test('remi codex --host is refused until the wire carries a harness', async () => {
    const r = await startWrapper(['--host', '127.0.0.1']);
    const code = await Promise.race([r.proc.exited, Bun.sleep(20000).then(() => 'timeout')]);
    expect(code).toBe(2);
    expect(r.output.text).toContain('--host');
    expect(storedSessions(r)).toEqual([]);
    expect(fileExists(r, 'pid')).toBe(false);
  }, 40000);

  test("--resume is remi's Claude flag: remi codex --resume points at remi codex resume and exits 2", async () => {
    const r = await startWrapper(['--resume']);
    const code = await Promise.race([r.proc.exited, Bun.sleep(20000).then(() => 'timeout')]);
    expect(code).toBe(2);
    expect(r.output.text).toContain('remi codex resume <thread id>');
    expect(storedSessions(r)).toEqual([]);
    expect(fileExists(r, 'pid')).toBe(false);
  }, 40000);

  test('a harness this build has no adapter for, and the hub with a harness, exit 2 before anything starts', async () => {
    const opencode = await startWrapper(['--harness', 'opencode'], null);
    const hub = await startWrapper(['--harness', 'codex'], 'serve');
    for (const r of [opencode, hub]) {
      expect(await Promise.race([r.proc.exited, Bun.sleep(20000).then(() => 'timeout')])).toBe(2);
      expect(storedSessions(r)).toEqual([]);
      expect(fileExists(r, 'pid')).toBe(false);
    }
    expect(opencode.output.text).toContain('no opencode adapter');
    expect(hub.output.text).toContain('hub hosts no session');
  }, 60000);

  test("the words after the user's own -- are prompt text even when they look like flags", async () => {
    const r = await startWrapper(['--', '-x', '--port', '1']);
    await waitForFakeCodex(r);
    expect(read(path.join(r.fakeDir, 'argv'))).toBe('--no-alt-screen\n--\n-x\n--port\n1\n');
    fs.writeFileSync(path.join(r.fakeDir, 'release'), '');
    expect(await Promise.race([r.proc.exited, Bun.sleep(15000).then(() => 'timeout')])).toBe(0);
  }, 40000);

  test('a prompt word that names a remi subcommand is still a prompt: remi codex status', async () => {
    const r = await startWrapper(['status']);
    await waitForFakeCodex(r);
    expect(read(path.join(r.fakeDir, 'argv'))).toBe('--no-alt-screen\n--\nstatus\n');
    fs.writeFileSync(path.join(r.fakeDir, 'release'), '');
    expect(await Promise.race([r.proc.exited, Bun.sleep(15000).then(() => 'timeout')])).toBe(0);
  }, 40000);

  test('a launch that fails after boot says why on stderr and exits 1: no codex on the PATH (W7)', async () => {
    const r = await startWrapper([], 'codex', { withCodex: false });
    const code = await Promise.race([r.proc.exited, Bun.sleep(20000).then(() => 'timeout')]);
    expect(code).toBe(1);
    // In wrapper mode the console goes to the log, so this text reached stderr by another way.
    expect(r.output.text).toContain('Failed to create session');
    expect(r.output.text).toContain('codex');
  }, 40000);

  test('a store that already holds one thread twice is refused on stderr with exit 1, after boot (W7)', async () => {
    const sleeper = Bun.spawn(['/bin/sleep', '60'], { stdout: 'ignore', stderr: 'ignore' });
    sleepers.push(sleeper);
    const thread = crypto.randomUUID();
    const r = await startWrapper([], 'codex', {
      seed: (home) => {
        fs.mkdirSync(path.join(home, '.remi'), { recursive: true });
        const row = () => ({
          remiSessionId: crypto.randomUUID(),
          claudeSessionId: null,
          harness: 'codex',
          harnessSessionId: thread,
          projectPath: '/work/elsewhere',
          port: 19000,
          pid: sleeper.pid,
          startedAt: new Date().toISOString(),
          exitedAt: null,
          exitCode: null,
        });
        fs.writeFileSync(
          path.join(home, '.remi', 'sessions.json'),
          JSON.stringify({ version: 1, sessions: [row(), row()] }),
        );
      },
    });
    const code = await Promise.race([r.proc.exited, Bun.sleep(20000).then(() => 'timeout')]);
    expect(code).toBe(1);
    expect(r.output.text).toContain(`Ambiguous codex session ID ${thread.slice(0, 8)}`);
    expect(fileExists(r, 'pid')).toBe(false);
  }, 40000);
});
