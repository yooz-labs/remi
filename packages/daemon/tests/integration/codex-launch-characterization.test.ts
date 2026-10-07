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
  QuestionMessage,
  QuestionResolvedMessage,
  ReplayBatchMessage,
  SessionUpdateMessage,
  TranscriptContentMessage,
  TranscriptLoadCompleteMessage,
} from '@remi/shared/protocol.ts';
import {
  PROMPT_WAITING_ERROR_CODE,
  createAnswer,
  createAuqAnswer,
  createCancelQuestion,
  createRegisterDeviceToken,
  createTranscriptLoadRequest,
  createUserInput,
  serialize,
} from '@remi/shared/protocol.ts';
import { formatQuestionBanner } from '../../src/cli/attach-client.ts';
import { olderRemiNotice } from '../../src/harness/codex/codex-session.ts';
import { IDENTITY_SHIM_MIN_VERSION } from '../../src/session/legacy-writers.ts';
import {
  type Json,
  agentMessageItem,
  commandApprovalRequest,
  fileChangeRequest,
  itemCompletedFrame,
  itemsListPage,
  realItem,
  threadStartedFrame,
  threadStatusFrame,
  turnCompletedFrame,
  turnError,
  userMessageItem,
} from '../helpers/codex-threads.ts';
import { FakeAppServer } from '../helpers/fake-app-server.ts';
import { hasUnsafeText } from '../helpers/unsafe-text.ts';
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

let turnCounter = 0;
/** A `turn/completed` frame with a turn id of its own (Codex's are unique; a session drops a repeat of one). */
function turnCompletedFrameWithId(
  threadId: string,
  over: Parameters<typeof turnCompletedFrame>[1] = {},
): Json {
  turnCounter += 1;
  return turnCompletedFrame(threadId, { turnId: `e2e-turn-${turnCounter}`, ...over });
}

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
 *
 * The files are written one after another, `pid` after the others and `stdin` after `pid`, and
 * `waitForFakeCodex` waits for both of those two. A shell redirect creates its file empty and fills
 * it as it runs, so a test that read a file the moment it existed could see half of it; here
 * `pid` and `stdin` existing means the files before them are whole, and the first test below pins
 * the order (#1204 round 2, Q1).
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

/** `cli.ts --daemon --harness codex`, with the fake `codex` and a fake app-server; `extraArgs` follow `--harness codex`. */
async function startDaemon(
  extraArgs: readonly string[] = [],
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<Running> {
  const { home, work } = makeIsolatedDirs();
  const { fakeDir, env } = makeFakes(home);
  const server = FakeAppServer.start();
  const overrides = { ...env, CODEX_HOME: server.codexHome, ...extraEnv };
  const spawned = await spawnDaemon(home, work, overrides, ['--harness', 'codex', ...extraArgs]);
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

describe('the fake codex records in an order the waits rely on (Q1)', () => {
  test('argv, the environment files and cwd come before pid, and pid before stdin', () => {
    const at = (name: string) => FAKE_CODEX.indexOf(`"$d/${name}"`);
    const order = ['argv', 'remi_port', 'alt_screen', 'codex_home', 'env', 'cwd', 'pid', 'stdin'];
    expect(order.map(at).every((index) => index >= 0)).toBe(true);
    expect(order.map(at)).toEqual([...order.map(at)].sort((a, b) => a - b));
  });
});

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
  test("the codex child does not inherit remi's secrets (#1249)", async () => {
    // The daemon is started with them in its environment (`--no-telegram` keeps the token from
    // reaching Telegram); the fake codex prints its whole environment.
    const secrets = {
      REMI_PASSPHRASE: 'passphrase-sentinel-1249',
      REMI_PUSH_SECRET: 'push-secret-sentinel-1249',
      TELEGRAM_BOT_TOKEN: 'bot-token-sentinel-1249',
    };
    const r = await startDaemon([], secrets);
    await waitForFakeCodex(r);

    const childEnv = read(path.join(r.fakeDir, 'env'));
    // The control: the rest of the daemon's environment arrives.
    expect(childEnv).toContain(`CODEX_HOME=${r.server.codexHome}`);
    for (const value of Object.values(secrets)) expect(childEnv).not.toContain(value);
  });

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
        () => r.output.text.includes(`attached to thread ${tuiId.slice(-8)}`),
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
      expect(r.output.text).not.toContain(helperId.slice(-8));
      expect(r.output.text).not.toContain(strayId.slice(-8));
      for (const id of brokenIds) expect(r.output.text).not.toContain(id.slice(-8));
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
      () => r.output.text.includes(`attached to thread ${tuiId.slice(-8)}`),
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

  test('remi codex --host asks the remote daemon instead of launching codex here: with none listening it exits 1 and starts nothing (#1179)', async () => {
    const r = await startWrapper(['--host', '127.0.0.1']);
    const code = await Promise.race([r.proc.exited, Bun.sleep(20000).then(() => 'timeout')]);
    expect(code).toBe(1);
    expect(r.output.text).toContain('127.0.0.1');
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

  test("a Claude launch that fails after boot keeps its own path: Codex's stderr message is not added to it (W7)", async () => {
    // Same failure as above (no such command on the PATH), for `remi` itself. Before the W7 fix
    // this exited 1 with nothing but the auth banner on stderr, and the fix is Codex's alone.
    const r = await startWrapper([], null, { withCodex: false });
    const code = await Promise.race([r.proc.exited, Bun.sleep(20000).then(() => 'timeout')]);
    expect(code).toBe(1);
    expect(r.output.text).not.toContain('Failed to create session');
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
    expect(r.output.text).toContain(`Ambiguous codex session ID ${thread.slice(-8)}`);
    expect(fileExists(r, 'pid')).toBe(false);
  }, 40000);

  test('a refused argument is refused before the interactive directory picker, with exit 2 (W20)', async () => {
    // A store with one recent directory, so --recent would reach the picker (which reads a
    // terminal this test does not have).
    const r = await startWrapper(['--recent', '-c', 'model=x'], 'codex', {
      seed: (home) => {
        fs.mkdirSync(path.join(home, '.remi'), { recursive: true });
        fs.writeFileSync(
          path.join(home, '.remi', 'sessions.json'),
          JSON.stringify({
            version: 1,
            sessions: [
              {
                remiSessionId: crypto.randomUUID(),
                claudeSessionId: crypto.randomUUID(),
                projectPath: home,
                port: 19000,
                pid: null,
                startedAt: new Date().toISOString(),
                exitedAt: new Date().toISOString(),
                exitCode: 0,
              },
            ],
          }),
        );
      },
    });
    const code = await Promise.race([r.proc.exited, Bun.sleep(20000).then(() => 'timeout')]);
    expect(code).toBe(2);
    expect(r.output.text).toContain('-c');
    expect(fileExists(r, 'pid')).toBe(false);
  }, 40000);
});

/**
 * Approvals (#1178, Phase 4 of the Codex epic #1175), written against the plan's Phase 4
 * section before `CodexDecisions` existed. The whole daemon is real (`cli.ts --daemon --harness
 * codex`, the real input handlers, a real websocket client sending the real messages); the
 * fake `codex` counts every byte on its stdin; the fake app-server is the Codex peer.
 *
 * "Types nothing" is only a claim when the real message was sent and a positive control shows
 * the counter can move: every group below ends with the raw `q` that DOES arrive.
 */
describe('remi codex approvals (daemon, black-box characterization, #1178)', () => {
  interface Attached {
    r: Running;
    client: number;
    tuiId: string;
    ws: WebSocket;
    received: ProtocolMessage[];
    sessionId: string;
  }

  /** A daemon whose session is attached to the TUI thread, and a phone connected to it. */
  async function attachedDaemon(): Promise<Attached> {
    const r = await startDaemon();
    await waitForFakeCodex(r);
    const client = await waitForAppServerClient(r);
    const tuiId = crypto.randomUUID();
    r.server.emit(
      threadStartedFrame('tui', {
        id: tuiId,
        cwd: fs.realpathSync(r.work),
        createdAtSec: Math.floor(Date.now() / 1000),
      }),
      { broadcast: true },
    );
    r.server.createRollout(tuiId);
    await pollUntil(
      () => r.output.text.includes(`attached to thread ${tuiId.slice(-8)}`),
      10000,
      'the attach',
    );
    const { ws, received } = await connectAndHello(r.port);
    const sessionId = (
      received.find((m): m is HelloAckMessage => m.type === 'hello_ack') as HelloAckMessage
    ).sessionId as string;
    return { r, client, tuiId, ws, received, sessionId };
  }

  /** A command approval of the TUI thread, running in the session's own directory (as Codex's would). */
  const commandRequest = (a: Attached, command: string, over: Record<string, unknown> = {}) =>
    commandApprovalRequest(a.tuiId, command, { cwd: fs.realpathSync(a.r.work), ...over });
  const cards = (received: ProtocolMessage[]): QuestionMessage[] =>
    received.filter((m): m is QuestionMessage => m.type === 'question');
  const refusals = (received: ProtocolMessage[]): ErrorMessage[] =>
    received.filter((m): m is ErrorMessage => m.type === 'error');
  const resolvedCards = (received: ProtocolMessage[]): QuestionResolvedMessage[] =>
    received.filter((m): m is QuestionResolvedMessage => m.type === 'question_resolved');
  const stdinBytes = (r: Running): number => fs.statSync(path.join(r.fakeDir, 'stdin')).size;

  /**
   * The positive control for every "typed nothing" claim: a person's raw keystroke does reach the
   * child, so a count of zero before it means nothing was typed, not that the counter is stuck
   * (and a late write would show up as more than the one byte).
   */
  async function rawControl(a: Attached): Promise<void> {
    a.ws.send(serialize(createUserInput(a.sessionId, 'q', true)));
    await pollUntil(() => stdinBytes(a.r) === 1, 8000, 'the raw control byte to reach codex');
    expect(read(path.join(a.r.fakeDir, 'stdin'))).toBe('q');
  }

  /** What the daemon's own connection answered to the app-server's server requests. */
  function answersSent(r: Running, client: number): Json[] {
    return r.server.framesFrom(client).filter((f) => f['method'] === undefined && 'id' in f);
  }

  /** Send `message`, and wait for the daemon's `code` refusal that follows it. */
  async function refusedWith(a: Attached, message: ProtocolMessage, code: string): Promise<void> {
    const before = refusals(a.received).filter((e) => e.code === code).length;
    a.ws.send(serialize(message));
    await pollUntil(
      () => refusals(a.received).filter((e) => e.code === code).length > before,
      8000,
      `a ${code} refusal`,
    );
  }

  test('the card reaches the phone stamped held; every answer variant is refused and types nothing; Yes answers through the app-server, clears the card, and still types nothing', async () => {
    const a = await attachedDaemon();
    try {
      const requestId = a.r.server.request(commandRequest(a, 'touch e2e-marker'), a.tuiId);
      await pollUntil(() => cards(a.received).length === 1, 10000, 'the approval card');
      const card = (cards(a.received)[0] as QuestionMessage).question;
      expect(card.held).toBe(true);
      expect(card.text).toBe('Allow Codex to run: touch e2e-marker');
      expect(card.options.map((o) => [o.label, o.value])).toEqual([
        ['Yes', 'accept'],
        ['No', 'cancel'],
      ]);
      expect(card.terminalOnly).toBeUndefined();
      expect(cards(a.received)[0]?.claudeSessionId).toBeUndefined();

      // Every way of answering that is not one of the card's options is refused, and nothing
      // is typed: free text, a structured answer, an answer to a question that is not there.
      await refusedWith(a, createAnswer(a.sessionId, card.id, 'approve it please'), 'STALE_ANSWER');
      await refusedWith(
        a,
        createAuqAnswer(a.sessionId, card.id, [{ questionIndex: 0, optionIndices: [0] }]),
        'STALE_ANSWER',
      );
      await refusedWith(a, createAnswer(a.sessionId, crypto.randomUUID(), 'Yes'), 'STALE_ANSWER');
      // Typed chat is refused with the code the web client reads.
      await refusedWith(
        a,
        createUserInput(a.sessionId, 'typed chat text', false),
        PROMPT_WAITING_ERROR_CODE,
      );
      // The refusals left the card and the request where they were.
      expect(a.r.server.isPending(a.tuiId, requestId)).toBe(true);
      expect(answersSent(a.r, a.client)).toEqual([]);
      expect(resolvedCards(a.received)).toEqual([]);
      expect(stdinBytes(a.r)).toBe(0);

      // Yes (the lock screen sends the label): the app-server gets exactly `accept`.
      a.ws.send(serialize(createAnswer(a.sessionId, card.id, 'Yes')));
      await pollUntil(() => answersSent(a.r, a.client).length === 1, 8000, 'the answer frame');
      expect(answersSent(a.r, a.client)[0]).toStrictEqual({
        jsonrpc: '2.0',
        id: requestId,
        result: { decision: 'accept' },
      });
      await pollUntil(
        () => resolvedCards(a.received).some((m) => m.questionId === card.id),
        8000,
        'question_resolved for the card',
      );
      expect(resolvedCards(a.received).find((m) => m.questionId === card.id)?.reason).toBe(
        'answered',
      );
      expect(a.r.server.isPending(a.tuiId, requestId)).toBe(false);
      expect(stdinBytes(a.r)).toBe(0);

      // The card carries the command, because the person must see it; the daemon's log does not.
      expect(a.r.output.text).not.toContain('e2e-marker');
      expect(a.r.output.text).not.toContain(a.tuiId);

      await rawControl(a);
    } finally {
      a.ws.close();
    }
  }, 90000);

  test('the TUI answering first clears the card on the phone, and a late phone answer gets STALE_ANSWER and sends nothing', async () => {
    const a = await attachedDaemon();
    try {
      const requestId = a.r.server.request(commandRequest(a, 'touch tui-first'), a.tuiId);
      await pollUntil(() => cards(a.received).length === 1, 10000, 'the approval card');
      const card = (cards(a.received)[0] as QuestionMessage).question;

      a.r.server.resolve(a.tuiId, requestId);
      await pollUntil(
        () => resolvedCards(a.received).some((m) => m.questionId === card.id),
        8000,
        'question_resolved after the TUI answered',
      );
      expect(resolvedCards(a.received).find((m) => m.questionId === card.id)?.reason).toBe(
        'cancelled',
      );

      // The phone tapped a moment too late: the real handler refuses, naming the card.
      const before = refusals(a.received).length;
      a.ws.send(serialize(createAnswer(a.sessionId, card.id, 'Yes')));
      await pollUntil(() => refusals(a.received).length > before, 8000, 'the late refusal');
      const refusal = refusals(a.received).at(-1) as ErrorMessage;
      expect(refusal.code).toBe('STALE_ANSWER');
      expect(refusal.details?.['questionId']).toBe(card.id);

      expect(answersSent(a.r, a.client)).toEqual([]);
      expect(stdinBytes(a.r)).toBe(0);
      await rawControl(a);
    } finally {
      a.ws.close();
    }
  }, 60000);

  test("the registry's cap-eviction warning, reached by a flood of cards nobody pins, names no card text (#1178)", async () => {
    const a = await attachedDaemon();
    try {
      // Nine file-change cards at once: they are terminalOnly, so nothing pins them, and the
      // registry's cap of eight evicts the oldest and warns. That warning must not carry the text.
      for (let i = 0; i < 9; i++) {
        a.r.server.request(fileChangeRequest(a.tuiId, `e2e-flood-${i}`), a.tuiId);
      }
      await pollUntil(() => cards(a.received).length === 9, 10000, 'nine cards');
      await pollUntil(
        () => a.r.output.text.includes('pending-question cap (8) exceeded; evicted oldest'),
        8000,
        'the eviction warning',
      );
      expect(a.r.output.text).toContain('chars=');
      expect(a.r.output.text).not.toContain('e2e-flood');
      expect(stdinBytes(a.r)).toBe(0);
      await rawControl(a);
    } finally {
      a.ws.close();
    }
  }, 60000);

  test('a hostile command reaches every client escaped: no terminal sequence, no bidi control, and the attach banner shows it as text (S5)', async () => {
    const a = await attachedDaemon();
    try {
      const code = (...codes: number[]): string => String.fromCodePoint(...codes);
      // A clipboard write, a line overwrite, a report query, a bidi override, a zero-width space
      // and a Tags-block character.
      const hostile = `echo ok${code(0x1b)}]52;c;QUJD${code(0x07)} ${code(0x1b)}[2K${code(0x0d)}${code(0x1b)}[6n ${code(0x202e)}fdp.exe${code(0x200b)}${code(0xe0041)}`;
      a.r.server.request(commandRequest(a, hostile), a.tuiId);
      await pollUntil(() => cards(a.received).length === 1, 10000, 'the hostile card');
      const card = (cards(a.received)[0] as QuestionMessage).question;
      const shown = [card.text, card.detail ?? ''].join('');
      expect(hasUnsafeText(shown), 'an unsafe character on the wire').toBe(false);
      expect(card.text).toContain(
        '\\u001B]52;c;QUJD\\u0007 \\u001B[2K\\u000D\\u001B[6n \\u202Efdp.exe\\u200B\\u{E0041}',
      );
      // The attach client's banner of that very card writes only its own escape sequences.
      const banner = formatQuestionBanner(card);
      expect(banner.match(/\x1b/g)?.length).toBe(7);
      expect(banner).not.toContain(code(0x07));
      expect(banner).not.toContain(code(0x202e));
      await rawControl(a);
    } finally {
      a.ws.close();
    }
  }, 60000);

  test('a pending card leaves a fixed label in the live-sessions file, never the command or the question text (S2)', async () => {
    const a = await attachedDaemon();
    try {
      const secret = 'sk-live-do-not-write-this-to-disk';
      a.r.server.request(
        commandRequest(a, `curl -H "Authorization: Bearer ${secret}" https://example.test`),
        a.tuiId,
      );
      a.r.server.request(
        {
          method: 'item/tool/requestUserInput',
          params: {
            threadId: a.tuiId,
            questions: [
              {
                id: 'q1',
                header: secret,
                question: `Use ${secret}?`,
                options: [{ label: secret }],
              },
            ],
          },
        },
        a.tuiId,
      );
      await pollUntil(() => cards(a.received).length === 2, 10000, 'both cards');
      const liveDir = path.join(a.r.home, '.remi', 'live-sessions');
      const files = (): string[] =>
        fs.existsSync(liveDir)
          ? fs.readdirSync(liveDir).map((f) => read(path.join(liveDir, f)))
          : [];
      // The registry file mirrors the pending cards (their ids and labels) as they come and go.
      await pollUntil(
        () => files().some((text) => text.includes('Permission: Codex command')),
        10000,
        'the pending labels in the live-sessions file',
      );
      const text = files().join('\n');
      expect(text).toContain('Codex asks for approval');
      expect(text).not.toContain(secret);
      expect(text).not.toContain('curl');
      // The cards themselves, for the phone, do carry the text: the person must see it.
      expect(JSON.stringify(cards(a.received).map((m) => m.question.text))).toContain(secret);
      await rawControl(a);
    } finally {
      a.ws.close();
    }
  }, 60000);

  test('remi unstick (SIGUSR2) dismisses an open card on every client, answers nothing and types nothing', async () => {
    const a = await attachedDaemon();
    try {
      const requestId = a.r.server.request(commandRequest(a, 'touch unstick-marker'), a.tuiId);
      await pollUntil(() => cards(a.received).length === 1, 10000, 'the approval card');
      const card = (cards(a.received)[0] as QuestionMessage).question;
      process.kill(a.r.proc.pid, 'SIGUSR2');
      await pollUntil(
        () => resolvedCards(a.received).some((m) => m.questionId === card.id),
        8000,
        'question_resolved after the unstick',
      );
      expect(resolvedCards(a.received).find((m) => m.questionId === card.id)?.reason).toBe(
        'cancelled',
      );
      expect(a.r.output.text).toContain('Force-released 1 session(s): 1 card(s) resolved');
      // The request is still pending for the TUI; remi answered nothing and typed nothing.
      expect(a.r.server.isPending(a.tuiId, requestId)).toBe(true);
      expect(answersSent(a.r, a.client)).toEqual([]);
      expect(stdinBytes(a.r)).toBe(0);
      await rawControl(a);
    } finally {
      a.ws.close();
    }
  }, 60000);

  test("a card only the terminal can answer refuses every answer, Cancel only clears it, and neither answers the request nor types an Esc; another thread's request makes no card", async () => {
    const a = await attachedDaemon();
    try {
      // Another Codex thread's request reaches this very connection (the server can address any
      // frame to it). It must never become a card, and never be answered. Frames on one connection
      // arrive in order, so the card below proves this one was already handled.
      const strangerId = 9001;
      a.r.server.emitTo(a.client, {
        id: strangerId,
        ...commandApprovalRequest(crypto.randomUUID(), 'touch another-thread'),
      });

      const requestId = a.r.server.request(fileChangeRequest(a.tuiId, 'e2e file change'), a.tuiId);
      await pollUntil(() => cards(a.received).length >= 1, 10000, 'the file-change card');
      expect(cards(a.received)).toHaveLength(1);
      const card = (cards(a.received)[0] as QuestionMessage).question;
      expect(card.text).toContain('e2e file change');
      expect(card.terminalOnly).toBe(true);
      expect(card.options).toEqual([]);

      await refusedWith(a, createAnswer(a.sessionId, card.id, 'Yes'), 'STALE_ANSWER');
      await refusedWith(a, createAnswer(a.sessionId, card.id, 'free text'), 'STALE_ANSWER');
      await refusedWith(
        a,
        createAuqAnswer(a.sessionId, card.id, [{ questionIndex: 0, optionIndices: [0] }]),
        'STALE_ANSWER',
      );
      expect(a.r.server.isPending(a.tuiId, requestId)).toBe(true);

      // Cancel dismisses the card for every client; it answers nothing and types nothing.
      a.ws.send(serialize(createCancelQuestion(a.sessionId, card.id)));
      await pollUntil(
        () => resolvedCards(a.received).some((m) => m.questionId === card.id),
        8000,
        'question_resolved after Cancel',
      );
      expect(a.r.server.isPending(a.tuiId, requestId)).toBe(true);
      expect(answersSent(a.r, a.client)).toEqual([]);
      expect(stdinBytes(a.r)).toBe(0);
      expect(a.r.output.text).not.toContain('touch another-thread');
      expect(a.r.output.text).not.toContain('e2e file change');

      await rawControl(a);
    } finally {
      a.ws.close();
    }
  }, 90000);
});

describe('remi codex turns and chat (daemon, black-box characterization, #1180)', () => {
  /** What the daemon POSTed to the push endpoint, in order. */
  interface Push {
    token?: string;
    title?: string;
    body?: string;
    kind?: string;
    questionId?: string;
    dismiss?: boolean;
    sessionId?: string;
    /** The `Authorization` header the daemon sent (`Bearer <push secret>`), if any. */
    authorization?: string | undefined;
  }

  interface Attached {
    r: Running;
    tuiId: string;
    ws: WebSocket;
    received: ProtocolMessage[];
    sessionId: string;
    pushes: Push[];
  }

  const stubs: Array<{ stop: (closeActiveConnections?: boolean) => Promise<void> }> = [];
  afterEach(async () => {
    for (const stub of stubs.splice(0)) await stub.stop(true);
  });

  /**
   * A daemon whose session is attached to the TUI's thread, whose push endpoint is a local HTTP
   * stand-in that records what it is sent, and a phone connected to it with a device registered.
   */
  async function attachedDaemon(
    opts: {
      pushSecret?: string;
      failPushes?: () => boolean;
      /** Answers `thread/items/list`, registered before the attach, so the catch-up at the attach reads it. */
      list?: (params: unknown) => unknown;
    } = {},
  ): Promise<Attached> {
    const pushes: Push[] = [];
    const stub = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (req) => {
        if (new URL(req.url).pathname === '/push') {
          const body = (await req.json()) as Push;
          pushes.push({ ...body, authorization: req.headers.get('authorization') ?? undefined });
          if (opts.failPushes?.() === true) return new Response('refused', { status: 500 });
        }
        return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
      },
    });
    stubs.push(stub);
    const r = await startDaemon([
      '--signaling-url',
      `http://127.0.0.1:${stub.port}`,
      ...(opts.pushSecret === undefined ? [] : ['--push-secret', opts.pushSecret]),
    ]);
    if (opts.list !== undefined) r.server.onRequest('thread/items/list', opts.list);
    await waitForFakeCodex(r);
    await waitForAppServerClient(r);
    const tuiId = crypto.randomUUID();
    r.server.emit(
      threadStartedFrame('tui', {
        id: tuiId,
        cwd: fs.realpathSync(r.work),
        createdAtSec: Math.floor(Date.now() / 1000),
      }),
      { broadcast: true },
    );
    r.server.createRollout(tuiId);
    await pollUntil(
      () => r.output.text.includes(`attached to thread ${tuiId.slice(-8)}`),
      10000,
      'the attach',
    );
    // The catch-up read goes out at the attach; a test that answers `thread/items/list` itself
    // registers its handler only after that request, so it never counts as the test's own.
    await pollUntil(
      () => r.server.received.some((f) => f.frame['method'] === 'thread/items/list'),
      10000,
      'the catch-up read',
    );
    const { ws, received } = await connectAndHello(r.port);
    const sessionId = (
      received.find((m): m is HelloAckMessage => m.type === 'hello_ack') as HelloAckMessage
    ).sessionId as string;
    ws.send(serialize(createRegisterDeviceToken('e2e-device-token', 'ios')));
    await pollUntil(
      () => r.output.text.includes('Device token registered'),
      10000,
      'the device token to register',
    );
    return { r, tuiId, ws, received, sessionId, pushes };
  }

  /** The entry ids of every transcript_content a client received, live or inside a replay batch. */
  const entryIds = (received: ProtocolMessage[]): string[] =>
    received
      .flatMap((m) => (m.type === 'replay_batch' ? (m as ReplayBatchMessage).messages : [m]))
      .filter((m): m is TranscriptContentMessage => m.type === 'transcript_content')
      .map((m) => m.entryUuid);
  const pushed = (a: Attached, kind: string): Push[] => a.pushes.filter((p) => p.kind === kind);
  const transcripts = (received: ProtocolMessage[]): TranscriptContentMessage[] =>
    received.filter((m): m is TranscriptContentMessage => m.type === 'transcript_content');

  test('a finished turn becomes a push through the daemon’s sink: long ones push, short ones do not, a failure says Codex stopped, and an interrupted turn clears it', async () => {
    const a = await attachedDaemon({ pushSecret: 'e2e-push-secret' });
    try {
      // A short turn first (the real frame's 5.5 seconds is under the 60-second default), then one
      // just over it (61 s, so a minimum scaled by two or a boundary off by one fails): frames reach
      // the daemon in order, so the one push proves the short one was seen.
      a.r.server.emit(turnCompletedFrameWithId(a.tuiId), { threadId: a.tuiId });
      a.r.server.emit(
        turnCompletedFrameWithId(a.tuiId, {
          durationMs: 61_000,
          items: [agentMessageItem('m-long', 'E2E-ANSWER-TEXT', 'final_answer')],
        }),
        { threadId: a.tuiId },
      );
      await pollUntil(
        () => pushed(a, 'turn_complete').length >= 1,
        10000,
        'the turn_complete push',
      );

      expect(pushed(a, 'turn_complete')).toHaveLength(1);
      const done = pushed(a, 'turn_complete')[0] as Push;
      expect(done.token).toBe('e2e-device-token');
      expect(done.title?.endsWith(': turn complete')).toBe(true);
      // Titled with the session's own name (host:directory), not the fallback "Agent".
      expect(done.title).toContain(`:${path.basename(fs.realpathSync(a.r.work))}`);
      expect(done.title?.startsWith('Agent')).toBe(false);
      expect(done.body).toBe('E2E-ANSWER-TEXT');
      // The daemon's push secret goes with the push, as a bearer token, for both classes.
      expect(done.authorization).toBe('Bearer e2e-push-secret');
      // The sink logs what it pushed (the title only, never the answer).
      expect(a.r.output.text).toContain(`[TurnComplete] ${done.title}`);
      // Dismiss-only, like Claude's: nothing to answer, no card.
      expect(done.questionId).toBeUndefined();

      // A failed turn: "Codex stopped", the code, Codex's own words, one collapse key per session.
      a.r.server.emit(
        turnCompletedFrameWithId(a.tuiId, {
          status: 'failed',
          items: [],
          error: turnError('E2E-LIMIT-TEXT', 'usageLimitExceeded'),
        }),
        { threadId: a.tuiId },
      );
      await pollUntil(() => pushed(a, 'turn_failed').length >= 1, 10000, 'the turn_failed push');
      const failed = pushed(a, 'turn_failed')[0] as Push;
      expect(failed.title?.endsWith(': Codex stopped')).toBe(true);
      expect(failed.body).toBe('Usage limit reached. E2E-LIMIT-TEXT');
      expect(failed.questionId).toBe(`turn-failed-${a.sessionId}`);
      expect(failed.authorization).toBe('Bearer e2e-push-secret');

      // An interrupted turn clears the notice with a quiet dismissal on the same key, and pushes nothing else.
      a.r.server.emit(turnCompletedFrameWithId(a.tuiId, { status: 'interrupted', items: [] }), {
        threadId: a.tuiId,
      });
      await pollUntil(() => pushed(a, 'dismiss').length >= 1, 10000, 'the dismissal');
      const cleared = pushed(a, 'dismiss')[0] as Push;
      expect(cleared.questionId).toBe(`turn-failed-${a.sessionId}`);
      expect(cleared.dismiss).toBe(true);
      expect(a.pushes.map((p) => p.kind)).toEqual(['turn_complete', 'turn_failed', 'dismiss']);

      // What a turn said is in the push the person asked for, never in the daemon's log.
      expect(a.r.output.text).not.toContain('E2E-ANSWER-TEXT');
      expect(a.r.output.text).not.toContain('E2E-LIMIT-TEXT');
      expect(a.r.output.text).not.toContain(a.tuiId);
    } finally {
      a.ws.close();
    }
  }, 90000);

  test('a push the endpoint refuses is reported in the daemon log and does not stop the next one', async () => {
    let refuse = true;
    const a = await attachedDaemon({ failPushes: () => refuse });
    try {
      a.r.server.emit(turnCompletedFrameWithId(a.tuiId, { durationMs: 61_000 }), {
        threadId: a.tuiId,
      });
      await pollUntil(
        () => a.r.output.text.includes('[TurnComplete] push failed'),
        10000,
        'the push failure to be logged',
      );

      refuse = false;
      a.r.server.emit(turnCompletedFrameWithId(a.tuiId, { durationMs: 62_000 }), {
        threadId: a.tuiId,
      });
      await pollUntil(() => a.pushes.length >= 2, 10000, 'the next push');
      expect(a.pushes.map((p) => p.kind)).toEqual(['turn_complete', 'turn_complete']);
    } finally {
      a.ws.close();
    }
  }, 90000);

  test('another window’s turn and a subagent’s are not this session’s: no push', async () => {
    const a = await attachedDaemon();
    try {
      a.r.server.emit(turnCompletedFrameWithId(crypto.randomUUID(), { durationMs: 61_000 }), {
        broadcast: true,
      });
      a.r.server.emit(turnCompletedFrameWithId(a.tuiId, { durationMs: 62_000 }), {
        threadId: a.tuiId,
      });
      await pollUntil(() => a.pushes.length >= 1, 10000, 'the push of the session’s own turn');

      expect(a.pushes.map((p) => p.kind)).toEqual(['turn_complete']);
    } finally {
      a.ws.close();
    }
  }, 90000);

  test('a transcript load request is answered from the app-server: the history oldest first, a page at a time, then the load completes', async () => {
    const a = await attachedDaemon();
    try {
      const requested: Json[] = [];
      a.r.server.onRequest('thread/items/list', (params) => {
        requested.push(params as Json);
        const cursor = (params as { cursor?: string }).cursor;
        return cursor === undefined
          ? itemsListPage(
              [
                { item: userMessageItem('e2e-u1', 'E2E-FIRST-PROMPT') },
                { item: realItem('commandExecution', { aggregatedOutput: 'E2E-OUTPUT' }) },
              ],
              'page-2',
            )
          : itemsListPage(
              [
                { item: agentMessageItem('e2e-a1', 'E2E-ANSWER', 'final_answer') },
                { item: { type: 'reasoning', id: 'e2e-r1', summary: ['hmm'], content: [] } },
              ],
              null,
            );
      });
      const before = a.received.length;

      a.ws.send(serialize(createTranscriptLoadRequest(a.sessionId)));
      await pollUntil(
        () => a.received.some((m) => m.type === 'transcript_load_complete'),
        10000,
        'the load to complete',
      );

      const fresh = a.received.slice(before);
      const entries = transcripts(fresh);
      expect(entries.map((m) => [m.entryUuid, m.role])).toEqual([
        ['e2e-u1', 'user'],
        ['exec-00000000-0000-7000-8000-000000000004', 'assistant'],
        ['e2e-a1', 'assistant'],
      ]);
      expect(entries[0]?.content).toBe('E2E-FIRST-PROMPT');
      expect(entries[1]?.tools).toEqual(['shell']);
      expect(entries[2]?.content).toBe('E2E-ANSWER');
      // History goes to the one who asked and then completes with the count and the session id.
      const complete = fresh.find(
        (m): m is TranscriptLoadCompleteMessage => m.type === 'transcript_load_complete',
      ) as TranscriptLoadCompleteMessage;
      expect(complete.messageCount).toBe(3);
      expect(complete.sessionId).toBe(a.sessionId);
      expect(fresh.map((m) => m.type).slice(-1)).toEqual(['transcript_load_complete']);
      expect(requested).toEqual([
        { threadId: a.tuiId, sortDirection: 'asc', limit: 100 },
        { threadId: a.tuiId, sortDirection: 'asc', limit: 100, cursor: 'page-2' },
      ]);
      expect(a.r.output.text).not.toContain('E2E-FIRST-PROMPT');
      expect(a.r.output.text).not.toContain('E2E-OUTPUT');
    } finally {
      a.ws.close();
    }
  }, 90000);

  test('the first prompt of a thread reaches a phone that connects after it: remi caught the thread up when it attached', async () => {
    const a = await attachedDaemon({
      list: () =>
        itemsListPage(
          [
            { item: userMessageItem('e2e-first-prompt', 'E2E-FIRST-PROMPT') },
            { item: agentMessageItem('e2e-answer', 'E2E-ANSWER', 'final_answer') },
          ],
          null,
        ),
    });
    let late: { ws: WebSocket; received: ProtocolMessage[] } | undefined;
    try {
      // Both phones connect after the attach: the daemon sent the catch-up and recorded it for replay.
      await pollUntil(
        () => entryIds(a.received).includes('e2e-first-prompt'),
        10000,
        'the caught-up first prompt',
      );
      late = await connectAndHello(a.r.port);
      await pollUntil(
        () => entryIds(late?.received ?? []).includes('e2e-first-prompt'),
        10000,
        'the replay of the first prompt to the late phone',
      );

      expect(entryIds(late.received)).toEqual(['e2e-first-prompt', 'e2e-answer']);
      expect(a.r.output.text).not.toContain('E2E-FIRST-PROMPT');
    } finally {
      late?.ws.close();
      a.ws.close();
    }
  }, 90000);

  test('a history that cannot be read is a LOAD_FAILED error, never a complete load', async () => {
    const a = await attachedDaemon();
    try {
      a.r.server.onRequest('thread/items/list', () => {
        throw { code: -32603, message: 'E2E-SERVER-TEXT' };
      });
      const before = a.received.length;

      a.ws.send(serialize(createTranscriptLoadRequest(a.sessionId)));
      await pollUntil(
        () => a.received.slice(before).some((m) => m.type === 'error'),
        10000,
        'the error',
      );

      const failure = a.received.slice(before).find((m): m is ErrorMessage => m.type === 'error');
      expect(failure?.code).toBe('LOAD_FAILED');
      expect(failure?.message).not.toContain('E2E-SERVER-TEXT');
      expect(a.received.slice(before).some((m) => m.type === 'transcript_load_complete')).toBe(
        false,
      );
    } finally {
      a.ws.close();
    }
  }, 90000);

  test('an item that completes on the thread reaches the phone as transcript_content, and typed chat is still refused and typed nowhere', async () => {
    const a = await attachedDaemon();
    try {
      a.r.server.emit(
        itemCompletedFrame(a.tuiId, agentMessageItem('e2e-live', 'E2E-LIVE-TEXT', 'final_answer')),
        { threadId: a.tuiId },
      );
      await pollUntil(() => transcripts(a.received).length >= 1, 10000, 'the live message');

      const live = transcripts(a.received)[0] as TranscriptContentMessage;
      expect(live.entryUuid).toBe('e2e-live');
      expect(live.role).toBe('assistant');
      expect(live.content).toBe('E2E-LIVE-TEXT');
      expect(live.sessionId).toBe(a.sessionId);
      expect(a.r.output.text).not.toContain('E2E-LIVE-TEXT');

      // Phase 6 gives Codex a chat to READ; typing into it stays refused with the code the web
      // client reads, and nothing reaches codex's stdin.
      a.ws.send(serialize(createUserInput(a.sessionId, 'typed chat text', false)));
      await pollUntil(
        () =>
          a.received.some(
            (m) => m.type === 'error' && (m as ErrorMessage).code === PROMPT_WAITING_ERROR_CODE,
          ),
        10000,
        'the PROMPT_WAITING refusal',
      );
      expect(fs.statSync(path.join(a.r.fakeDir, 'stdin')).size).toBe(0);
    } finally {
      a.ws.close();
    }
  }, 90000);
});
