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
 * Not covered here, because it needs the owner (LV-4): that a Codex session
 * created this way reaches its prompt headless, with no one to dismiss an
 * Update or Trust modal, against a real Codex.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HarnessId } from '@remi/shared';
import type {
  CreateSessionResponseMessage,
  HelloAckMessage,
  ProtocolMessage,
} from '@remi/shared/protocol.ts';
import { createCreateSessionRequest, serialize } from '@remi/shared/protocol.ts';
import { SessionStore } from '../../src/session/session-store.ts';
import {
  type FakeAgents,
  collect,
  installFakeAgents,
  recordedArgv,
} from '../helpers/fake-agent-clis.ts';
import { FakeAppServer } from '../helpers/fake-app-server.ts';
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
});

async function startHub(which: { codex?: boolean; claude?: boolean }): Promise<Running> {
  const dirs = makeIsolatedDirs();
  const agents = installFakeAgents(dirs.home, which);
  const server = FakeAppServer.start();
  const hub = await spawnHub(dirs, { ...agents.env, CODEX_HOME: server.codexHome });
  const r = { hub, agents, server, log: { text: '' } };
  collect(hub.proc.stdout as ReadableStream<Uint8Array>, r.log);
  collect(hub.proc.stderr as ReadableStream<Uint8Array>, r.log);
  running.push(r);
  return r;
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

async function waitForArgv(dir: string): Promise<string[]> {
  await pollUntil(() => fs.existsSync(path.join(dir, 'argv')), 20000, 'the fake agent to start');
  return recordedArgv(dir);
}

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
    expect(response.success).toBe(true);
    expect(response.sessionId).toMatch(UUID_RE);
    expect(response.port).toBeGreaterThan(0);
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
    expect(response.success).toBe(true);
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
    expect(response.success).toBe(true);
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
    expect(response.success).toBe(false);
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
      expect(response.success).toBe(false);
      expect(typeof response.error).toBe('string');
      expect(childEntries(r)).toEqual([]);
      expect(fs.existsSync(path.join(r.agents.codexDir, 'argv'))).toBe(false);
      expect(fs.existsSync(path.join(r.agents.claudeDir, 'argv'))).toBe(false);
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

  test('a resume of a thread a live session holds is refused before anything is spawned, naming that session (H2)', async () => {
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

    expect(response.success).toBe(false);
    const id8 = remiSessionId.slice(0, 8);
    const error = response.error as string;
    expect(error).toContain(`already open in remi session ${id8} (port 19999)`);
    expect(error).toContain(`\`remi attach <host>:19999/${id8}\``);
    expect(error).toContain(THREAD);
    expect(error).not.toContain(r.hub.home);
    expect(error).not.toContain(String(holder.pid));
    // The refusal precedes the spawn, so absence now is absence for good.
    expect(childEntries(r)).toEqual([]);
    expect(fs.existsSync(path.join(r.agents.codexDir, 'argv'))).toBe(false);
    // The log carries the last eight characters of the thread, never the whole id.
    expect(r.log.text).toContain(THREAD.slice(-8));
    expect(r.log.text).not.toContain(THREAD);
  }, 90000);

  test.each([
    ['a hyphen-led directory a child would re-parse as a remi flag', '--no-auth'],
    ['a directory with a NUL byte', '/tmp/a\u0000b'],
    ['a directory with a newline', '/tmp/a\nb'],
    ['a directory that is not a string', 5],
    ['a null directory', null],
  ])(
    '%s is refused for a plain and a Codex request, and nothing is spawned (G7)',
    async (_name, directory) => {
      const r = await startHub({ claude: true, codex: true });
      for (const options of [{}, { harness: 'codex' }]) {
        const { response } = await ask(r, { ...options, directory });
        expect(response.success).toBe(false);
        expect(response.error).toContain('Invalid directory');
      }
      expect(childEntries(r)).toEqual([]);
      expect(fs.existsSync(path.join(r.agents.codexDir, 'argv'))).toBe(false);
      expect(fs.existsSync(path.join(r.agents.claudeDir, 'argv'))).toBe(false);
    },
    90000,
  );

  test('a hub whose own version does not parse still starts its Codex child: the child does not count its parent hub as an older remi (H5)', async () => {
    const r = await startHub({ codex: true });
    const statusFile = path.join(r.hub.home, '.remi', 'daemon-status.json');
    const readStatus = () =>
      JSON.parse(fs.readFileSync(statusFile, 'utf-8')) as Record<string, unknown>;
    const { ws, received } = await connectAndHello(r.hub.port);
    try {
      // The hub rewrites its status file after a client connects (a 300 ms debounce), and not
      // again until something changes. Wait for that write, then put in the file the version a
      // PR-stamped build reports (`bump-version.sh set 0.7.16-p1204.1`, which AGENTS.md
      // recommends for test builds): it does not parse, so the gate reads it as older.
      await pollUntil(
        () => readStatus()['connections'] === 1,
        10000,
        "the hub's status file to count the client",
      );
      const staged = `${statusFile}.staged`;
      fs.writeFileSync(staged, JSON.stringify({ ...readStatus(), version: '0.7.16-p1204.1' }));
      fs.renameSync(staged, statusFile);

      const request = createCreateSessionRequest(r.hub.work, { harness: 'codex' });
      ws.send(serialize(request));
      const isResponse = (m: ProtocolMessage): m is CreateSessionResponseMessage =>
        m.type === 'create_session_response' && m.requestId === request.id;
      await pollUntil(() => received.some(isResponse), 30000, 'the create_session_response');
      const response = received.find(isResponse) as CreateSessionResponseMessage;

      // The hub's own gate skips the hub itself; the CHILD's gate must skip its parent too, or the
      // child exits in its preflight and the client sees only that the process exited.
      expect(response.success, response.error).toBe(true);
      expect(await waitForArgv(r.agents.codexDir)).toEqual(['--no-alt-screen']);
      // Validity of the test: the hub did not write its file again before the child read it.
      expect(readStatus()['version']).toBe('0.7.16-p1204.1');
    } finally {
      ws.close();
    }
  }, 90000);
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
  test('remi codex --host starts a Codex session there with the arguments after --', async () => {
    const r = await startHub({ codex: true });
    const { output, stderr } = runCli(r, [
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
    expect(await waitForArgv(r.agents.codexDir)).toEqual(['--no-alt-screen', '-m', 'some-model']);
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

  test('remi new --host --harness codex is the same request', async () => {
    const r = await startHub({ codex: true });
    runCli(r, [
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
    expect(await waitForArgv(r.agents.codexDir)).toEqual(['--no-alt-screen']);
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
