/**
 * Black-box check of `create_session_request` with a harness and arguments
 * (#1179, Phase 5 of the Codex epic #1175), against a REAL hub.
 *
 * It spawns the real `cli.ts serve` in an isolated `$HOME` with fake `claude`
 * and `codex` executables first on a PATH of fakes plus `/usr/bin:/bin` only
 * (the runtime under test is linked in as `bun`), a `FakeAppServer` for Codex's
 * shared app-server, and a real WebSocket client that sends the request the
 * shipping factory builds. The hub spawns real child daemons, whose fake agents
 * record the argv they were started with, so everything asserted is what the
 * CHILD's agent saw, or what came back over the socket.
 *
 * Not covered here, because it needs a real Codex: what one does at an Update or Trust modal
 * when nothing dismisses it. LV-4 (live, Codex 0.160.0) showed a session created this way
 * reaching its prompt headless, but no modal appeared in any launch.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HarnessId } from '@remi/shared';
import type {
  CreateSessionResponseMessage,
  HelloAckMessage,
  ProtocolMessage,
} from '@remi/shared/protocol.ts';
import { createCreateSessionRequest, serialize } from '@remi/shared/protocol.ts';
import { DEFAULT_CONFIG } from '../../src/config/config.ts';
import { SessionStore } from '../../src/session/session-store.ts';
import {
  type FakeAgents,
  collect,
  installFakeAgents,
  waitForRecordedArgv,
} from '../helpers/fake-agent-clis.ts';
import { FakeAppServer } from '../helpers/fake-app-server.ts';
import { type StampedBuild, copyBuild } from '../helpers/stamped-build.ts';
import { reserveRange } from '../session/port-test-helpers.ts';
import {
  CLI_TS,
  type HubHandle,
  cleanupHub,
  connectAndHello,
  isolatedEnv,
  makeIsolatedDirs,
  pollUntil,
  spawnHub,
} from './hub-test-utils.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Running {
  hub: HubHandle;
  agents: FakeAgents;
  server: FakeAppServer;
  /** What the hub wrote to stdout and stderr since it was ready: its log, in daemon mode. */
  log: { text: string };
}
const running: Running[] = [];
const sleepers: Array<Bun.Subprocess> = [];
const builds: StampedBuild[] = [];

afterEach(async () => {
  for (const r of running.splice(0)) {
    // The hub's children are detached: end them (and their fake agents) before the sandbox goes.
    const liveDir = path.join(r.hub.home, '.remi', 'live-sessions');
    if (fs.existsSync(liveDir)) {
      for (const file of fs.readdirSync(liveDir)) {
        try {
          const entry = JSON.parse(fs.readFileSync(path.join(liveDir, file), 'utf-8')) as {
            pid: number;
          };
          process.kill(entry.pid, 'SIGKILL');
        } catch {
          // already gone, or not a child of this test
        }
      }
    }
    for (const dir of [r.agents.codexDir, r.agents.claudeDir]) {
      fs.writeFileSync(path.join(dir, 'release'), '');
    }
    await cleanupHub(r.hub);
    await r.server.stop();
  }
  for (const s of sleepers.splice(0)) s.kill('SIGKILL');
  for (const b of builds.splice(0)) b.remove();
});

async function startHub(
  which: { codex?: boolean; claude?: boolean },
  cliPath?: string,
): Promise<Running> {
  const dirs = makeIsolatedDirs();
  let server: FakeAppServer | undefined;
  try {
    const agents = installFakeAgents(dirs.home, which);
    server = FakeAppServer.start();
    // A random probed port, not the lowest free one from 19200 that every test process is given (P11).
    // The hub's children probe from `base_port` (which `REMI_PORT` sets) over the next 20 ports, and
    // the default base, 18765, is shared by every hub on the machine and by real sessions: so the
    // whole run of 20 is reserved, the hub takes its first port, and its children take the rest.
    const port = await reserveRange(20, 50, DEFAULT_CONFIG.daemon.bind);
    const hub = await spawnHub(
      dirs,
      { ...agents.env, CODEX_HOME: server.codexHome, REMI_PORT: String(port) },
      cliPath,
      port,
    );
    const r = { hub, agents, server, log: { text: '' } };
    collect(hub.proc.stdout as ReadableStream<Uint8Array>, r.log);
    collect(hub.proc.stderr as ReadableStream<Uint8Array>, r.log);
    running.push(r);
    return r;
  } catch (error) {
    // Nothing is on `running` yet, so the `afterEach` would never see these (Q2).
    await server?.stop();
    fs.rmSync(dirs.home, { recursive: true, force: true });
    fs.rmSync(dirs.work, { recursive: true, force: true });
    throw error;
  }
}

interface Asked {
  ack: HelloAckMessage;
  response: CreateSessionResponseMessage;
}

/** Connect, send one create request built by the shipping factory, and wait for its response. */
async function ask(
  r: Running,
  options: { harness?: unknown; args?: unknown; directory?: unknown } = {},
): Promise<Asked> {
  const { ws, received } = await connectAndHello(r.hub.port);
  try {
    const directory = 'directory' in options ? options.directory : r.hub.work;
    const request = createCreateSessionRequest(directory as string | undefined, {
      harness: options.harness as HarnessId | undefined,
      args: options.args as readonly string[] | undefined,
    });
    ws.send(serialize(request));
    const isResponse = (m: ProtocolMessage): m is CreateSessionResponseMessage =>
      m.type === 'create_session_response' && m.requestId === request.id;
    await pollUntil(() => received.some(isResponse), 20000, 'the create_session_response');
    return {
      ack: received.find((m): m is HelloAckMessage => m.type === 'hello_ack') as HelloAckMessage,
      response: received.find(isResponse) as CreateSessionResponseMessage,
    };
  } finally {
    ws.close();
  }
}

/** The hub's note on what a success does not say (#1179); read as data, whatever the type says. */
function noticeOf(response: object): unknown {
  return (response as { notice?: unknown }).notice;
}

function childEntries(r: Running): Array<{ pid: number; sessionId: string }> {
  const liveDir = path.join(r.hub.home, '.remi', 'live-sessions');
  if (!fs.existsSync(liveDir)) return [];
  return fs
    .readdirSync(liveDir)
    .map((f) => JSON.parse(fs.readFileSync(path.join(liveDir, f), 'utf-8')))
    .filter((e) => typeof e.pid === 'number');
}

/** The fake records whole or not at all, so the file existing is the whole list (P11). */
const waitForArgv = (dir: string): Promise<string[]> => waitForRecordedArgv(dir);

/**
 * What a failure needs to explain itself: the hub's own output and the children's log (the hub
 * starts them detached, with their output in `daemon.log` under the isolated home), each cut to its
 * last 1500 characters.
 */
function logTails(r: Running): string {
  const childLog = path.join(r.hub.home, '.remi', 'daemon.log');
  const child = fs.existsSync(childLog) ? fs.readFileSync(childLog, 'utf-8') : '(no child log)';
  return `hub log tail:\n${r.log.text.slice(-1500)}\nchild log tail:\n${child.slice(-1500)}`;
}

/** The message for an assertion on a `create_session_response`: the response itself, and the logs. */
const why = (r: Running, response: object): string =>
  `response: ${JSON.stringify(response)}\n${logTails(r)}`;

/**
 * Wait for the fake agent a CLI asked the hub for. A CLI that exits first (the hub said no) ends the
 * wait at once instead of after the 20 s timeout, and the error says what it and the hub printed.
 */
async function waitForArgvOf(
  r: Running,
  dir: string,
  cli: { proc: Bun.Subprocess; output: { text: string } },
): Promise<string[]> {
  try {
    return await waitForRecordedArgv(dir, { stillRunning: () => cli.proc.exitCode === null });
  } catch (error) {
    throw new Error(
      `${(error as Error).message}\ncli exit ${cli.proc.exitCode}, its output:\n${cli.output.text.slice(-1500)}\n${logTails(r)}`,
    );
  }
}

describe('startHub when the hub cannot start (Q2)', () => {
  // The isolated directories and the fake app-server were made before `spawnHub` ran, and a throw
  // left both behind (nothing had been pushed on `running` yet). The temp directory is a fresh
  // short one under /tmp, so the fake server's socket directory (which falls back to /tmp when
  // TMPDIR is long) lands in it too and one listing sees everything the test made.
  // The directory outlives each test's own cleanup (a hub's `afterEach` removes its home), so it is
  // made once and removed at the end.
  let root: string;
  let savedTmp: string | undefined;

  beforeAll(() => {
    root = fs.mkdtempSync('/tmp/remi-startfail-');
  });

  beforeEach(() => {
    savedTmp = process.env['TMPDIR'];
    process.env['TMPDIR'] = root;
  });

  afterEach(() => {
    if (savedTmp === undefined) Reflect.deleteProperty(process.env, 'TMPDIR');
    else process.env['TMPDIR'] = savedTmp;
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('a hub that exits at once leaves no directory and no fake app-server behind', async () => {
    const before = fs.readdirSync(root);
    await expect(startHub({ codex: true }, '/nonexistent/cli.ts')).rejects.toThrow(
      'Hub exited early',
    );
    expect(fs.readdirSync(root)).toEqual(before);
  }, 60000);

  test('the control: a hub that starts does leave its home, its work directory and the fake server until the test cleans up', async () => {
    await startHub({ codex: true });
    expect(
      fs
        .readdirSync(root)
        .map((name) => name.replace(/[A-Za-z0-9]{6}$/, ''))
        .sort(),
    ).toEqual(['remi-fake-codex-', 'remi-hub-home-', 'remi-hub-work-']);
  }, 60000);
});

describe('a hub creating a session for a harness (#1179)', () => {
  test('the session-less ack lists the harnesses that are installed, so a client can tell an older hub', async () => {
    const both = await startHub({ codex: true, claude: true });
    const { ws, received } = await connectAndHello(both.hub.port);
    ws.close();
    const ack = received.find((m): m is HelloAckMessage => m.type === 'hello_ack');
    expect(ack?.sessionId).toBeNull();
    expect(ack?.harnesses).toEqual(['claude', 'codex']);
    // A hub hosts no session, so it names no harness of its own (G9).
    expect(ack).not.toHaveProperty('harness');

    const claudeOnly = await startHub({ claude: true });
    const second = await connectAndHello(claudeOnly.hub.port);
    second.ws.close();
    expect(
      second.received.find((m): m is HelloAckMessage => m.type === 'hello_ack')?.harnesses,
    ).toEqual(['claude']);
  }, 60000);

  test('a Codex request starts a Codex session with the validated arguments, headless', async () => {
    const r = await startHub({ codex: true });
    const { response } = await ask(r, { harness: 'codex', args: ['-m', 'fixture-model'] });
    expect(response.success, why(r, response)).toBe(true);
    expect(response.sessionId).toMatch(UUID_RE);
    expect(response.port).toBeGreaterThan(0);
    // The child's port is probed from the range this test reserved (the hub's own port and the 19
    // above it), not from 18765, which every hub on the machine and the owner's own sessions share.
    expect(response.port).toBeGreaterThan(r.hub.port);
    expect(response.port).toBeLessThan(r.hub.port + 20);
    // The hub cannot know that Codex reached its prompt: it says so, and what to do.
    expect(noticeOf(response)).toContain('remi attach');
    expect(noticeOf(response)).toContain('Update or Trust');
    // The first line is the condition; the second the remedy, naming THIS session by the address
    // `remi attach` accepts (a bare `remi attach` takes the newest session, which may be another).
    const [headline, remedy, ...rest] = (noticeOf(response) as string).split('\n');
    expect(rest).toEqual([]);
    expect(headline).toContain('without a terminal');
    expect(headline).toContain('Update or Trust prompt');
    expect(headline).toContain('already have exited');
    expect(headline).not.toContain('remi attach');
    expect(remedy).toContain(
      `\`remi attach <host>:${response.port}/${(response.sessionId as string).slice(0, 8)}\``,
    );
    expect(remedy).toContain('not been checked against a real Codex');
    // `remi attach <host>:<port>` reaches the daemon only from a machine that can reach that port: not
    // through a single-port SSH tunnel or the relay (P9).
    expect(remedy).toContain('from a machine that can reach that port');
    // Nothing host-local: no home directory, no pid.
    expect(noticeOf(response)).not.toContain(r.hub.home);
    expect(noticeOf(response)).not.toContain(r.hub.work);

    // The child daemon launched `codex --no-alt-screen <the validated arguments>`.
    expect(await waitForArgv(r.agents.codexDir)).toEqual([
      '--no-alt-screen',
      '-m',
      'fixture-model',
    ]);
    // And it is a Codex session: its record names the harness and has no Claude id.
    await pollUntil(
      () => fs.existsSync(path.join(r.hub.home, '.remi', 'sessions.json')),
      10000,
      'the child to record its session',
    );
    const stored = JSON.parse(
      fs.readFileSync(path.join(r.hub.home, '.remi', 'sessions.json'), 'utf-8'),
    ) as { sessions: Array<{ harness?: string; claudeSessionId: string | null }> };
    expect(stored.sessions).toHaveLength(1);
    expect(stored.sessions[0]?.harness).toBe('codex');
    expect(stored.sessions[0]?.claudeSessionId).toBeNull();
    // Nothing of Claude's ran.
    expect(fs.existsSync(path.join(r.agents.claudeDir, 'argv'))).toBe(false);
  }, 90000);

  test("a Claude request with a model starts Claude with it, beside remi's own launch flags", async () => {
    const r = await startHub({ claude: true });
    const { response } = await ask(r, { harness: 'claude', args: ['--model', 'opus'] });
    expect(response.success, why(r, response)).toBe(true);
    expect('notice' in response).toBe(false);
    const argv = await waitForArgv(r.agents.claudeDir);
    // The model the request named, and remi's own `--session-id <uuid> -n remi:<port>`.
    expect(argv.slice(0, 2)).toEqual(['--model', 'opus']);
    expect(argv.slice(2, 3)).toEqual(['--session-id']);
    expect(argv[3]).toMatch(UUID_RE);
    expect(argv[4]).toBe('-n');
    expect(argv).toHaveLength(6);
  }, 90000);

  test('a request that names no harness and brings no arguments is the Claude launch it always was', async () => {
    const r = await startHub({ claude: true, codex: true });
    const { response } = await ask(r);
    expect(response.success, why(r, response)).toBe(true);
    expect('notice' in response).toBe(false);
    const argv = await waitForArgv(r.agents.claudeDir);
    expect(argv).toHaveLength(4);
    expect(argv[0]).toBe('--session-id');
    expect(argv[2]).toBe('-n');
    expect(fs.existsSync(path.join(r.agents.codexDir, 'argv'))).toBe(false);
  }, 90000);

  test('a harness that is not installed is refused, and nothing is spawned', async () => {
    const r = await startHub({ claude: true });
    const { response } = await ask(r, { harness: 'codex' });
    expect(response.success, why(r, response)).toBe(false);
    expect(response.error).toContain('codex');
    expect(response.sessionId).toBeUndefined();
    expect('notice' in response).toBe(false);
    // The refusal is sent before any spawn could happen, so absence now is absence for good.
    expect(childEntries(r)).toEqual([]);
    expect(fs.existsSync(path.join(r.agents.codexDir, 'argv'))).toBe(false);
  }, 60000);

  test.each([
    ['an unknown harness', { harness: 'gpt' }],
    ['a harness that is not a string', { harness: 5 }],
    ['an adapter-less harness', { harness: 'opencode' }],
    ['a Codex flag that is not on the list', { harness: 'codex', args: ['-c', 'x=y'] }],
    ['a remi flag among Codex arguments', { harness: 'codex', args: ['--no-auth'] }],
    ['Codex arguments that are not an array', { harness: 'codex', args: '-m x' }],
    [
      'a Claude flag that is not on the list',
      { harness: 'claude', args: ['--dangerously-skip-permissions'] },
    ],
    ['arguments for the default harness that are not on its list', { args: ['--settings', 'x'] }],
    ['too many arguments', { harness: 'claude', args: Array.from({ length: 17 }, () => '-c') }],
  ])(
    '%s is refused and nothing is spawned',
    async (_name, options) => {
      const r = await startHub({ claude: true, codex: true });
      const { response } = await ask(r, options);
      expect(response.success, why(r, response)).toBe(false);
      expect(typeof response.error).toBe('string');
      expect(childEntries(r)).toEqual([]);
      expect(fs.existsSync(path.join(r.agents.codexDir, 'argv'))).toBe(false);
      expect(fs.existsSync(path.join(r.agents.claudeDir, 'argv'))).toBe(false);
    },
    60000,
  );

  test.each([['untrusted'], ['on-request'], ['never']])(
    'a Codex request with -a %s is refused with its reason, and nothing is spawned (LV-4)',
    async (value) => {
      // Codex 0.160.0 rejects `-a untrusted` with exit 2, which used to kill the child: a remote
      // request carries no -a at all, because no value of it can be shown to tighten the host.
      const r = await startHub({ claude: true, codex: true });
      const { response } = await ask(r, { harness: 'codex', args: ['-m', 'x', '-a', value] });
      expect(response.success, why(r, response)).toBe(false);
      expect(response.error).toContain('-a/--ask-for-approval is not allowed');
      expect(response.error).toContain('may only tighten');
      expect(response.sessionId).toBeUndefined();
      expect(childEntries(r)).toEqual([]);
      expect(fs.existsSync(path.join(r.agents.codexDir, 'argv'))).toBe(false);
    },
    60000,
  );

  test('a live remi older than the identity shim refuses a Codex request, with its text, and still serves Claude', async () => {
    const r = await startHub({ claude: true, codex: true });
    // A live process whose live-sessions entry says it is a remi from before the shim.
    const sleeper = Bun.spawn(['sleep', '60']);
    sleepers.push(sleeper);
    const liveDir = path.join(r.hub.home, '.remi', 'live-sessions');
    fs.mkdirSync(liveDir, { recursive: true });
    fs.writeFileSync(
      path.join(liveDir, 'legacy-session.json'),
      JSON.stringify({
        sessionId: 'legacy-session',
        pid: sleeper.pid,
        wsPort: 19999,
        hookPort: 0,
        projectPath: r.hub.work,
        name: 'legacy',
        // A record is believed to be that process's only if it is not older than the process
        // (a recycled pid's stale record is ignored): a real daemon registers after it starts.
        startedAt: new Date(Date.now() + 2000).toISOString(),
        version: '0.7.15',
      }),
    );

    const refused = await ask(r, { harness: 'codex' });
    expect(refused.response.success).toBe(false);
    const error = refused.response.error as string;
    expect(error).toContain('older remi');
    // The client is told what is refused and the next step, never a pid, a path, or a command
    // that ends the host's sessions (G8): those are in the hub's log, which is the host's.
    expect(error).not.toContain(String(sleeper.pid));
    expect(error).not.toContain(r.hub.home);
    expect(error).not.toContain('remi stop');
    await pollUntil(
      () => r.log.text.includes(`pid ${sleeper.pid}`) && r.log.text.includes('legacy-session.json'),
      10000,
      "the hub's log to name the older remi",
    );
    expect(fs.existsSync(path.join(r.agents.codexDir, 'argv'))).toBe(false);

    // The gate is about Codex records: a Claude request is not held up by it.
    const claude = await ask(r, { harness: 'claude' });
    expect(claude.response.success).toBe(true);
  }, 90000);

  test('a resume of a thread a live session holds is refused before anything is spawned, with a generic client text (H2, P4)', async () => {
    const r = await startHub({ claude: true, codex: true });
    const THREAD = '01950000-0000-7000-8000-0000000000aa';
    const holder = Bun.spawn(['sleep', '60']);
    sleepers.push(holder);
    const remiSessionId = crypto.randomUUID();
    new SessionStore(path.join(r.hub.home, '.remi', 'sessions.json')).save({
      remiSessionId,
      claudeSessionId: null,
      harness: 'codex',
      harnessSessionId: THREAD,
      projectPath: r.hub.work,
      port: 19999,
      pid: holder.pid,
      startedAt: new Date().toISOString(),
      exitedAt: null,
      exitCode: null,
    });

    const { response } = await ask(r, { harness: 'codex', args: ['resume', THREAD.toUpperCase()] });

    expect(response.success, why(r, response)).toBe(false);
    const id8 = remiSessionId.slice(0, 8);
    // The client is told that the thread is open, and nothing about the session that holds it:
    // not its id, not its port, not the thread it asked about (P4).
    expect(response.error).toBe(
      'That Codex thread is already open in a live remi session on the host.',
    );
    // The refusal precedes the spawn, so absence now is absence for good.
    expect(childEntries(r)).toEqual([]);
    expect(fs.existsSync(path.join(r.agents.codexDir, 'argv'))).toBe(false);
    // The hub's log has the holder and its port, and the last eight characters of the thread, never the whole id.
    await pollUntil(
      () => r.log.text.includes(`remi session ${id8} (port 19999)`),
      10000,
      "the hub's log to name the holder",
    );
    expect(r.log.text).toContain(THREAD.slice(-8));
    expect(r.log.text).not.toContain(THREAD);
  }, 90000);

  describe('a session store that holds two active records of one thread (P4, P10)', () => {
    // `list()` refuses to choose between them. Written as raw JSON: `save()` would not allow it.
    const THREAD = '01950000-0000-7000-8000-0000000000aa';
    function writeAmbiguousStore(r: Running) {
      const holder = Bun.spawn(['sleep', '60']);
      sleepers.push(holder);
      const record = () => ({
        remiSessionId: crypto.randomUUID(),
        claudeSessionId: null,
        harness: 'codex',
        harnessSessionId: THREAD,
        projectPath: r.hub.work,
        port: 19999,
        pid: holder.pid,
        startedAt: new Date().toISOString(),
        exitedAt: null,
        exitCode: null,
      });
      fs.mkdirSync(path.join(r.hub.home, '.remi'), { recursive: true });
      fs.writeFileSync(
        path.join(r.hub.home, '.remi', 'sessions.json'),
        JSON.stringify({ version: 1, sessions: [record(), record()] }),
      );
    }

    test('a Codex resume of that thread is refused with its own generic text, and the log names the thread by its last eight characters', async () => {
      const r = await startHub({ claude: true, codex: true });
      writeAmbiguousStore(r);
      const { response } = await ask(r, { harness: 'codex', args: ['resume', THREAD] });
      expect(response.success, why(r, response)).toBe(false);
      expect(response.error).toBe(
        "That Codex thread cannot be resumed from here: the host's records of it are ambiguous.",
      );
      expect(childEntries(r)).toEqual([]);
      await pollUntil(
        () => r.log.text.includes('more than one active record of it'),
        10000,
        "the hub's log to say why",
      );
      expect(r.log.text).toContain(THREAD.slice(-8));
      expect(r.log.text).not.toContain(THREAD);
    }, 90000);

    test('a Claude resume fails closed: the store cannot be read, so nothing is spawned and the client reads the opaque text', async () => {
      const r = await startHub({ claude: true, codex: true });
      writeAmbiguousStore(r);
      const { response } = await ask(r, {
        harness: 'claude',
        args: ['--resume', '3f9c2a1e-0000-4000-8000-000000000042'],
      });
      expect(response.success, why(r, response)).toBe(false);
      expect(response.error).toContain('could not be started');
      expect(childEntries(r)).toEqual([]);
      expect(fs.existsSync(path.join(r.agents.claudeDir, 'argv'))).toBe(false);
    }, 90000);
  });

  describe('a resume of a Claude session a live session holds (P10)', () => {
    const CLAUDE_ID = '3f9c2a1e-0000-4000-8000-000000000042';
    const GENERIC = 'That Claude session is already open in a live remi session on the host.';

    async function holdClaudeSession(r: Running, over: { exited?: boolean } = {}) {
      const holder = Bun.spawn(['sleep', '60']);
      sleepers.push(holder);
      const remiSessionId = crypto.randomUUID();
      new SessionStore(path.join(r.hub.home, '.remi', 'sessions.json')).save({
        remiSessionId,
        claudeSessionId: CLAUDE_ID,
        projectPath: r.hub.work,
        port: 19999,
        pid: over.exited ? null : holder.pid,
        startedAt: new Date().toISOString(),
        exitedAt: over.exited ? new Date().toISOString() : null,
        exitCode: over.exited ? 0 : null,
      });
      return remiSessionId;
    }

    test.each([
      ['a named harness', { harness: 'claude', args: ['--resume', CLAUDE_ID.toUpperCase()] }],
      ['no harness named', { args: ['-r', CLAUDE_ID, '--model', 'opus'] }],
    ])(
      'with %s is refused before anything is spawned, with a generic client text',
      async (_name, options) => {
        const r = await startHub({ claude: true, codex: true });
        const remiSessionId = await holdClaudeSession(r);
        const { response } = await ask(r, options);
        expect(response.success, why(r, response)).toBe(false);
        expect(response.error).toBe(GENERIC);
        expect(childEntries(r)).toEqual([]);
        expect(fs.existsSync(path.join(r.agents.claudeDir, 'argv'))).toBe(false);
        await pollUntil(
          () => r.log.text.includes(`remi session ${remiSessionId.slice(0, 8)} (port 19999)`),
          10000,
          "the hub's log to name the holder",
        );
      },
      90000,
    );

    test('a Claude request that resumes nothing is not held up by a live session that has no id yet', async () => {
      const r = await startHub({ claude: true, codex: true });
      const holder = Bun.spawn(['sleep', '60']);
      sleepers.push(holder);
      // A session that has only just started: Claude's id is not learned yet.
      new SessionStore(path.join(r.hub.home, '.remi', 'sessions.json')).save({
        remiSessionId: crypto.randomUUID(),
        claudeSessionId: null,
        projectPath: r.hub.work,
        port: 19999,
        pid: holder.pid,
        startedAt: new Date().toISOString(),
        exitedAt: null,
        exitCode: null,
      });
      for (const options of [{ harness: 'claude' }, { args: ['--model', 'opus'] }]) {
        const { response } = await ask(r, options);
        expect(response.success, response.error).toBe(true);
      }
    }, 90000);

    test('a resume of a session nobody holds, or only history holds, is spawned', async () => {
      const r = await startHub({ claude: true, codex: true });
      await holdClaudeSession(r, { exited: true });
      const { response } = await ask(r, { harness: 'claude', args: ['--resume', CLAUDE_ID] });
      expect(response.success, response.error).toBe(true);
      expect((await waitForArgv(r.agents.claudeDir)).slice(0, 2)).toEqual(['--resume', CLAUDE_ID]);
    }, 90000);
  });

  test.each([
    ['a hyphen-led directory a child would re-parse as a remi flag', '--no-auth'],
    ['a directory with a NUL byte', '/tmp/a\u0000b'],
    ['a directory with a newline', '/tmp/a\nb'],
    ['a directory with a terminal escape sequence', '/tmp/a\u001b[2Kb'],
    ['a directory with a C1 control', '/tmp/a\u009b2Kb'],
    ['a directory that is not a string', 5],
    ['a null directory', null],
  ])(
    '%s is refused for a plain and a Codex request, and nothing is spawned (G7)',
    async (_name, directory) => {
      const r = await startHub({ claude: true, codex: true });
      for (const options of [{}, { harness: 'codex' }]) {
        const { response } = await ask(r, { ...options, directory });
        expect(response.success, why(r, response)).toBe(false);
        expect(response.error).toContain('Invalid directory');
      }
      expect(childEntries(r)).toEqual([]);
      expect(fs.existsSync(path.join(r.agents.codexDir, 'argv'))).toBe(false);
      expect(fs.existsSync(path.join(r.agents.claudeDir, 'argv'))).toBe(false);
    },
    90000,
  );

  describe('a hub of a PR-stamped build (#1204 round 2, P1)', () => {
    // `bump-version.sh set 0.7.16-p1204.1` is what AGENTS.md recommends for LV-4's build: its
    // version does not parse, so the gate used to read every session of it as an older remi.
    const STAMP = '0.7.16-p1204.1';

    async function stampedHub() {
      const build = copyBuild(STAMP);
      builds.push(build);
      return startHub({ claude: true, codex: true }, build.cliPath);
    }

    const childVersions = (r: Running) => {
      const liveDir = path.join(r.hub.home, '.remi', 'live-sessions');
      return fs
        .readdirSync(liveDir)
        .map(
          (f) =>
            JSON.parse(fs.readFileSync(path.join(liveDir, f), 'utf-8')) as { version?: string },
        )
        .map((e) => e.version);
    };

    test('two Claude sessions of the same build do not stop a Codex create', async () => {
      const r = await stampedHub();
      expect((await ask(r, { harness: 'claude' })).response.success).toBe(true);
      expect((await ask(r)).response.success).toBe(true);
      // The sessions really are of the unparsable build: that is what the gate must not refuse.
      expect(childVersions(r)).toEqual([STAMP, STAMP]);

      const codex = await ask(r, { harness: 'codex' });
      expect(codex.response.error).toBeUndefined();
      expect(codex.response.success).toBe(true);
      expect(await waitForArgv(r.agents.codexDir)).toEqual(['--no-alt-screen']);
      // The Codex child's own gate saw its siblings and its parent hub, all of the same build.
      expect(childVersions(r)).toEqual([STAMP, STAMP, STAMP]);
    }, 180000);

    test('a live remi of ANOTHER unparsable build is still an older remi', async () => {
      const r = await stampedHub();
      const sleeper = Bun.spawn(['sleep', '60']);
      sleepers.push(sleeper);
      const liveDir = path.join(r.hub.home, '.remi', 'live-sessions');
      fs.mkdirSync(liveDir, { recursive: true });
      fs.writeFileSync(
        path.join(liveDir, 'other-build.json'),
        JSON.stringify({
          sessionId: 'other-build',
          pid: sleeper.pid,
          wsPort: 19998,
          hookPort: 0,
          projectPath: r.hub.work,
          name: 'other',
          startedAt: new Date(Date.now() + 2000).toISOString(),
          version: '0.7.16-p9999.1',
        }),
      );
      const refused = await ask(r, { harness: 'codex' });
      expect(refused.response.success).toBe(false);
      expect(refused.response.error).toContain('older remi');
      expect(fs.existsSync(path.join(r.agents.codexDir, 'argv'))).toBe(false);
    }, 90000);
  });
});

/** `cli.ts <args>` as a client of the hub, with no terminal. The caller ends it. */
function runCli(r: Running, args: readonly string[]) {
  const proc = Bun.spawn([process.execPath, CLI_TS, ...args], {
    cwd: r.hub.work,
    env: isolatedEnv(r.hub.home, { ...r.agents.env, CODEX_HOME: r.server.codexHome }),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  sleepers.push(proc);
  const output = { text: '' };
  const stderr = { text: '' };
  // A stream has one reader: stderr is split so it can be read both with stdout and apart.
  const [errForOutput, errApart] = proc.stderr.tee();
  collect(proc.stdout, output);
  collect(errForOutput, output);
  collect(errApart, stderr);
  return { proc, output, stderr };
}

describe('the CLI creating a session on a hub (#1179)', () => {
  test('a CLI that exits before the agent starts ends the wait at once, and the error says what it and the hub printed', async () => {
    const r = await startHub({ codex: true });
    const proc = Bun.spawn(['sh', '-c', 'echo refused by the hub; exit 3'], { stdout: 'pipe' });
    sleepers.push(proc);
    const output = { text: '' };
    collect(proc.stdout, output);
    // The children's log is where the hub's detached children write: put a line in it.
    fs.mkdirSync(path.join(r.hub.home, '.remi'), { recursive: true });
    fs.writeFileSync(path.join(r.hub.home, '.remi', 'daemon.log'), 'earlier\nchild said hello\n');
    await proc.exited;
    await pollUntil(() => output.text.includes('refused by the hub'), 5000, 'the CLI output');
    const started = Date.now();
    const error = await waitForArgvOf(r, r.agents.codexDir, { proc, output }).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('exited early');
    expect(message).toContain('cli exit 3');
    expect(message).toContain('refused by the hub');
    expect(message).toContain('hub log tail');
    expect(message).toContain('child log tail');
    expect(message).toContain('child said hello');
    // Not the 20 s the wait takes when nothing says the CLI is gone.
    expect(Date.now() - started).toBeLessThan(5000);
    // And the message of a response assertion carries the response and both log tails.
    const explained = why(r, { success: false, error: 'no way' });
    expect(explained).toContain('"error":"no way"');
    expect(explained).toContain('hub log tail');
    expect(explained).toContain('child log tail');
    expect(explained).toContain('child said hello');
  }, 60000);

  test('remi codex --host starts a Codex session there with the arguments after --', async () => {
    const r = await startHub({ codex: true });
    const cli = runCli(r, [
      'codex',
      '--host',
      'localhost',
      '--port',
      String(r.hub.port),
      '--dir',
      r.hub.work,
      '--',
      '-m',
      'some-model',
    ]);
    const { output, stderr } = cli;
    expect(await waitForArgvOf(r, r.agents.codexDir, cli)).toEqual([
      '--no-alt-screen',
      '-m',
      'some-model',
    ]);
    // What the hub said about readiness reaches the person at the CLI: the condition only. The CLI
    // attaches itself, so the remedy (`remi attach`, which the notice's second line names) is
    // already being done and is not repeated (G11).
    await pollUntil(
      () => output.text.includes('Update or Trust prompt'),
      10000,
      'the notice on stderr',
    );
    expect(output.text).not.toContain('remi attach');
    // Progress and the notice go to stderr: stdout belongs to the attached terminal.
    expect(stderr.text).toContain('Update or Trust prompt');
    expect(stderr.text).toContain('Creating session on localhost');
  }, 90000);

  test.each([
    ['Codex flags with no -- before them', ['codex', '-s', 'read-only']],
    ['a Codex resume with no --', ['codex', 'resume', '01950000-0000-7000-8000-0000000000aa']],
    ['Claude flags with no -- before them', ['new', '--model', 'sonnet']],
  ])(
    '%s are refused by the CLI with exit 2, and nothing is sent (G2)',
    async (_name, words) => {
      const r = await startHub({ claude: true, codex: true });
      const { proc, output } = runCli(r, [
        ...words,
        '--host',
        'localhost',
        '--port',
        String(r.hub.port),
        '--dir',
        r.hub.work,
      ]);
      expect(await proc.exited).toBe(2);
      expect(output.text).toContain('go after `--`');
      // Each loose word is named, so the person sees what was not sent.
      for (const word of words.slice(1)) expect(output.text).toContain(word);
      expect(output.text).not.toContain('Creating session');
      expect(r.log.text).not.toContain('Create session request');
      expect(childEntries(r)).toEqual([]);
      expect(fs.existsSync(path.join(r.agents.codexDir, 'argv'))).toBe(false);
      expect(fs.existsSync(path.join(r.agents.claudeDir, 'argv'))).toBe(false);
    },
    60000,
  );

  test.each([
    ['new', ['new'], 'put it after --: -- --resume <uuid>'],
    ['no subcommand', [], 'put it after --: -- --resume <uuid>'],
    ['codex', ['codex'], '-- resume <thread id>'],
  ])(
    '--resume with --host (%s) is refused with exit 2 before any lookup or request, and says where it goes (P5)',
    async (_name, words, hint) => {
      const r = await startHub({ claude: true, codex: true });
      const { proc, output } = runCli(r, [
        ...words,
        '--host',
        'localhost',
        '--port',
        String(r.hub.port),
        '--resume',
        '3f9c2a1e-0000-4000-8000-000000000042',
      ]);
      expect(await proc.exited).toBe(2);
      expect(output.text).toContain('--resume is not sent to a remote host');
      expect(output.text).toContain(hint);
      // Not the local store lookup `--resume` used to start (and a silent fresh remote session when a
      // local session held the id), and nothing reached the hub.
      expect(output.text).not.toContain('Session not found');
      expect(r.log.text).not.toContain('Create session request');
      expect(childEntries(r)).toEqual([]);
    },
    60000,
  );

  test('the same resume after -- is sent to the hub, which spawns Claude with it', async () => {
    const r = await startHub({ claude: true });
    const cli = runCli(r, [
      'new',
      '--host',
      'localhost',
      '--port',
      String(r.hub.port),
      '--dir',
      r.hub.work,
      '--',
      '--resume',
      '3f9c2a1e-0000-4000-8000-000000000042',
    ]);
    expect((await waitForArgvOf(r, r.agents.claudeDir, cli)).slice(0, 2)).toEqual([
      '--resume',
      '3f9c2a1e-0000-4000-8000-000000000042',
    ]);
  }, 90000);

  test('remi new --host --harness codex is the same request', async () => {
    const r = await startHub({ codex: true });
    const cli = runCli(r, [
      'new',
      '--host',
      'localhost',
      '--port',
      String(r.hub.port),
      '--dir',
      r.hub.work,
      '--harness',
      'codex',
    ]);
    expect(await waitForArgvOf(r, r.agents.codexDir, cli)).toEqual(['--no-alt-screen']);
  }, 90000);

  test('a hub that does not offer the harness is told so by the client, which starts nothing', async () => {
    const r = await startHub({ claude: true });
    const { proc, output } = runCli(r, [
      'codex',
      '--host',
      'localhost',
      '--port',
      String(r.hub.port),
      '--dir',
      r.hub.work,
    ]);
    expect(await proc.exited).toBe(1);
    expect(output.text).toContain('does not offer codex');
    expect(childEntries(r)).toEqual([]);
    expect(fs.existsSync(path.join(r.agents.codexDir, 'argv'))).toBe(false);
  }, 60000);
});
