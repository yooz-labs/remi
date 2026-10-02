/**
 * Black-box characterization of how a session daemon launches Claude (#1164).
 *
 * `createNewSession` in `cli.ts` is about to be moved behind the harness seam
 * with zero behavior change, and no existing test drives it end to end: the
 * unit tests build its parts one at a time. This spawns the REAL `cli.ts
 * --daemon` in an isolated $HOME (`isolatedEnv` also drops `REMI_HOME`), with
 * a real executable fake `claude` first on PATH (a real process, nothing
 * mocked) that records its argv, selected environment, working directory and
 * pid, then waits. Every assertion below reads what that process or the daemon left on
 * disk or on the wire, so it holds for any implementation of the launch.
 *
 * Written and passed against the unmodified source BEFORE the extraction, and
 * kept passing after it. It pins the things a move could silently break: the
 * argv (`--session-id <uuid> -n remi:<port>`), the child environment, the
 * binding persisted before spawn, the child pid recorded in live-sessions, the
 * hook registration in the working directory, the `hello_ack` binding, the
 * daemon exiting when Claude exits (#641), and the hooks being removed on
 * SIGTERM.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HelloAckMessage, ProtocolMessage } from '@remi/shared/protocol.ts';
import {
  cleanupHub,
  connectAndHello,
  findTestPort,
  makeIsolatedDirs,
  pollUntil,
  spawnDaemon,
} from './hub-test-utils.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface RunningDaemon {
  proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  home: string;
  work: string;
  port: number;
  /** Where the fake `claude` records what it saw; `release` ends it. */
  fakeDir: string;
}

const running: RunningDaemon[] = [];

afterEach(async () => {
  for (const d of running.splice(0)) {
    await cleanupHub({ proc: d.proc, home: d.home, work: d.work, port: d.port });
  }
});

/**
 * A fake `claude` that records `$*`, `$REMI_PORT`,
 * `$CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN`, its cwd and its pid, then waits
 * until `release` exists (60 s at most, so a failed run cannot leave it
 * looping) and exits 0.
 */
const FAKE_CLAUDE = `#!/bin/sh
d="$FAKE_CLAUDE_DIR"
printf '%s' "$*" > "$d/argv"
printf '%s' "$REMI_PORT" > "$d/remi_port"
printf '%s' "$CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN" > "$d/alt_screen"
pwd -P > "$d/cwd"
echo $$ > "$d/pid"
i=0
while [ ! -e "$d/release" ] && [ $i -lt 600 ]; do
  sleep 0.1
  i=$((i + 1))
done
`;

function read(file: string): string {
  return fs.readFileSync(file, 'utf-8').trim();
}

async function startDaemon(): Promise<RunningDaemon> {
  const { home, work } = makeIsolatedDirs();
  const fakeDir = path.join(home, 'fake-claude');
  const fakeBin = path.join(home, 'fake-bin');
  fs.mkdirSync(fakeDir, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  const fakeClaude = path.join(fakeBin, 'claude');
  fs.writeFileSync(fakeClaude, FAKE_CLAUDE);
  fs.chmodSync(fakeClaude, 0o755);

  const port = await findTestPort();
  const proc = spawnDaemon(home, work, port, {
    PATH: `${fakeBin}:${process.env['PATH'] ?? ''}`,
    FAKE_CLAUDE_DIR: fakeDir,
  });
  const daemon: RunningDaemon = { proc, home, work, port, fakeDir };
  running.push(daemon);

  // `claudeChildPid` is written once the PTY is up: the last step of
  // createNewSession, so everything else below is already in place.
  await pollUntil(
    () => {
      if (proc.exitCode !== null) throw new Error(`Daemon exited early (${proc.exitCode})`);
      const entry = liveEntry(daemon);
      return entry?.claudeChildPid !== undefined && fs.existsSync(path.join(fakeDir, 'pid'));
    },
    20000,
    'live-sessions claudeChildPid and the fake claude to start',
  );
  return daemon;
}

interface LiveEntry {
  sessionId: string;
  pid: number;
  wsPort: number;
  hookPort: number;
  projectPath: string;
  claudeChildPid?: number;
  claudeChildExited?: boolean;
}

function liveEntry(d: RunningDaemon): LiveEntry | null {
  const dir = path.join(d.home, '.remi', 'live-sessions');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  if (files.length !== 1) return null;
  try {
    return JSON.parse(read(path.join(dir, files[0] as string))) as LiveEntry;
  } catch {
    return null;
  }
}

interface StoredRecord {
  remiSessionId: string;
  claudeSessionId: string;
  projectPath: string;
  port: number;
  pid: number | null;
  startedAt: string;
  exitedAt: string | null;
  exitCode: number | null;
}

function storedSessions(d: RunningDaemon): StoredRecord[] {
  const file = path.join(d.home, '.remi', 'sessions.json');
  return (JSON.parse(read(file)) as { sessions: StoredRecord[] }).sessions;
}

function helloAck(received: ProtocolMessage[]): HelloAckMessage {
  const ack = received.find((m): m is HelloAckMessage => m.type === 'hello_ack');
  if (!ack) throw new Error('no hello_ack received');
  return ack;
}

describe('daemon launch of Claude (black-box characterization, #1164)', () => {
  test('spawns claude with the bound session id and wires the session around it', async () => {
    const d = await startDaemon();
    const entry = liveEntry(d);
    if (!entry) throw new Error('no live-sessions entry');

    // argv: `--session-id <uuid> -n remi:<port>`, nothing else.
    const argv = read(path.join(d.fakeDir, 'argv'));
    const match = /^--session-id (\S+) -n remi:(\d+)$/.exec(argv);
    expect(match).not.toBeNull();
    const argvSessionId = match?.[1] as string;
    expect(argvSessionId).toMatch(UUID_RE);
    expect(Number(match?.[2])).toBe(d.port);

    // The child's environment and working directory.
    expect(read(path.join(d.fakeDir, 'remi_port'))).toBe(String(d.port));
    expect(read(path.join(d.fakeDir, 'alt_screen'))).toBe('1');
    expect(read(path.join(d.fakeDir, 'cwd'))).toBe(fs.realpathSync(d.work));

    // sessions.json: exactly one record, bound to the argv uuid, still live.
    const stored = storedSessions(d);
    expect(stored).toHaveLength(1);
    const record = stored[0] as StoredRecord;
    expect(record.claudeSessionId).toBe(argvSessionId);
    expect(record.remiSessionId).toBe(entry.sessionId);
    expect(record.exitedAt).toBeNull();
    expect(record.exitCode).toBeNull();
    expect(record.port).toBe(d.port);
    expect(record.pid).toBe(d.proc.pid);
    expect(record.projectPath).toBe(fs.realpathSync(d.work));

    // live-sessions: this daemon, with the spawned child's real pid.
    expect(entry.pid).toBe(d.proc.pid);
    expect(entry.wsPort).toBe(d.port);
    expect(entry.hookPort).toBeGreaterThan(0);
    expect(entry.claudeChildPid).toBe(Number(read(path.join(d.fakeDir, 'pid'))));

    // The hook URL for THIS daemon's hook port is registered in the working
    // directory's settings.local.json.
    const settingsPath = path.join(d.work, '.claude', 'settings.local.json');
    const settings = fs.readFileSync(settingsPath, 'utf-8');
    expect(settings).toContain(`http://127.0.0.1:${entry.hookPort}/hooks`);

    // hello_ack carries the same binding, and the transcript path derived
    // from it.
    const { ws, received } = await connectAndHello(d.port);
    try {
      const ack = helloAck(received);
      expect(ack.sessionId).toBe(entry.sessionId);
      expect(ack.claudeSessionId).toBe(argvSessionId);
      expect(ack.transcriptPath).toEndWith(`/${argvSessionId}.jsonl`);
    } finally {
      ws.close();
    }

    // SIGTERM: the daemon shuts down and takes its hook registration with it.
    d.proc.kill('SIGTERM');
    await d.proc.exited;
    const after = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf-8') : '';
    expect(after).not.toContain(`http://127.0.0.1:${entry.hookPort}`);
  }, 40000);

  test('the daemon exits once claude exits, and the session is marked exited (#641)', async () => {
    const d = await startDaemon();
    const before = storedSessions(d);
    expect(before).toHaveLength(1);
    expect((before[0] as StoredRecord).exitedAt).toBeNull();

    fs.writeFileSync(path.join(d.fakeDir, 'release'), '');
    const code = await Promise.race([
      d.proc.exited,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 15000)),
    ]);
    expect(code).toBe(0);

    const after = storedSessions(d);
    expect(after).toHaveLength(1);
    const record = after[0] as StoredRecord;
    expect(record.claudeSessionId).toBe((before[0] as StoredRecord).claudeSessionId);
    expect(record.exitedAt).not.toBeNull();
    expect(record.exitCode).toBe(0);
  }, 40000);
});
