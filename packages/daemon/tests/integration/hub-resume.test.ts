/**
 * Black-box check of `resume_session_request` against a REAL hub (#1129, which replaced the
 * refusal #1124 put there).
 *
 * `remi serve` is a session-less supervisor and must NEVER run Claude in its own process: a
 * `resume_session_request` used to reach the shared resume handler, which called
 * `createNewSession(..., ['--resume', id])` inside the hub, and when that Claude exited the hub
 * exited 0 and the LaunchAgent did not restart it. So a resume through the hub starts a CHILD
 * session daemon with `--resume <id>`, the way a create request starts one, and answers with the
 * child's port.
 *
 * It spawns the real `cli.ts serve` in an isolated `$HOME` with a fake `claude` first on a PATH of
 * fakes (it records the argv, cwd and pid it was started with), seeds a stored session, and sends
 * the request the shipping factory builds over a real WebSocket. Everything asserted is what came
 * back over the socket or what the CHILD's agent saw. The client here is a raw WebSocket, not the
 * shipping web client, so per ADR 0014 this is a one-sided test: how the web UI follows a session
 * on another port is tested where that code is (`packages/web`).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  HelloAckMessage,
  ProtocolMessage,
  ResumeSessionResponseMessage,
} from '@remi/shared/protocol.ts';
import { createResumeSessionRequest, serialize } from '@remi/shared/protocol.ts';
import { DEFAULT_CONFIG } from '../../src/config/config.ts';
import { SessionStore } from '../../src/session/session-store.ts';
import {
  type FakeAgents,
  collect,
  installFakeAgents,
  waitForRecordedArgv,
} from '../helpers/fake-agent-clis.ts';
import { reserveRange } from '../session/port-test-helpers.ts';
import {
  type HubHandle,
  cleanupHub,
  connectAndHello,
  makeIsolatedDirs,
  pollUntil,
  spawnHub,
} from './hub-test-utils.ts';

const CLAUDE_ID = '3f9c2a1e-0000-4000-8000-000000000042';
const HELD_TEXT = 'That Claude session is already open in a live remi session on the host.';

interface Running {
  hub: HubHandle;
  agents: FakeAgents;
  log: { text: string };
  /** The stored session's project directory: not the hub's own directory. */
  project: string;
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
          // A bad file with pid 0 or 1 would signal a process group or init.
          if (Number.isInteger(entry.pid) && entry.pid > 1) process.kill(entry.pid, 'SIGKILL');
        } catch {
          // already gone, or not a child of this test
        }
      }
    }
    fs.writeFileSync(path.join(r.agents.claudeDir, 'release'), '');
    await cleanupHub(r.hub);
    fs.rmSync(r.project, { recursive: true, force: true });
  }
  for (const s of sleepers.splice(0)) s.kill('SIGKILL');
});

async function startHub(): Promise<Running> {
  const dirs = makeIsolatedDirs();
  const agents = installFakeAgents(dirs.home, { claude: true });
  // A random probed range, as the create-session test does: the hub takes its first port and its
  // children take the rest.
  const port = await reserveRange(20, 50, DEFAULT_CONFIG.daemon.bind);
  const hub = await spawnHub(dirs, { ...agents.env, REMI_PORT: String(port) }, undefined, port);
  const project = fs.mkdtempSync(path.join(dirs.home, 'stored-project-'));
  const r = { hub, agents, log: { text: '' }, project };
  collect(hub.proc.stdout as ReadableStream<Uint8Array>, r.log);
  collect(hub.proc.stderr as ReadableStream<Uint8Array>, r.log);
  running.push(r);
  return r;
}

/** A stored Claude session in the hub's home; with `live`, one whose recorded process is running. */
function seedSession(r: Running, options: { live?: boolean } = {}): string {
  const remiSessionId = crypto.randomUUID();
  let pid: number | null = null;
  if (options.live === true) {
    const holder = Bun.spawn(['sleep', '60']);
    sleepers.push(holder);
    pid = holder.pid;
  }
  new SessionStore(path.join(r.hub.home, '.remi', 'sessions.json')).save({
    remiSessionId,
    claudeSessionId: CLAUDE_ID,
    projectPath: r.project,
    port: 19999,
    pid,
    startedAt: new Date().toISOString(),
    exitedAt: pid === null ? new Date().toISOString() : null,
    exitCode: pid === null ? 0 : null,
  });
  return remiSessionId;
}

interface Asked {
  response: ResumeSessionResponseMessage;
  received: ProtocolMessage[];
}

/** Connect, send one resume request built by the shipping factory, and wait for its response. */
async function ask(r: Running, sessionId: string): Promise<Asked> {
  const { ws, received } = await connectAndHello(r.hub.port);
  try {
    const request = createResumeSessionRequest(sessionId);
    ws.send(serialize(request));
    const isResponse = (m: ProtocolMessage): m is ResumeSessionResponseMessage =>
      m.type === 'resume_session_response' && m.requestId === request.id;
    await pollUntil(() => received.some(isResponse), 20000, 'the resume_session_response');
    return { response: received.find(isResponse) as ResumeSessionResponseMessage, received };
  } finally {
    ws.close();
  }
}

function childEntries(r: Running): Array<{ pid: number; wsPort: number; sessionId: string }> {
  const liveDir = path.join(r.hub.home, '.remi', 'live-sessions');
  if (!fs.existsSync(liveDir)) return [];
  return fs
    .readdirSync(liveDir)
    .map((f) => JSON.parse(fs.readFileSync(path.join(liveDir, f), 'utf-8')))
    .filter((e) => typeof e.pid === 'number');
}

/** The pids above `pid`, nearest first, read with `ps` (at most 8 levels). */
function ancestorsOf(pid: number): number[] {
  const chain: number[] = [];
  let current = pid;
  for (let i = 0; i < 8; i++) {
    const out = Bun.spawnSync(['ps', '-o', 'ppid=', '-p', String(current)])
      .stdout.toString()
      .trim();
    const parent = Number(out);
    if (!Number.isInteger(parent) || parent <= 1) break;
    chain.push(parent);
    current = parent;
  }
  return chain;
}

const why = (r: Running, response: object): string =>
  `response: ${JSON.stringify(response)}\nhub log tail:\n${r.log.text.slice(-1500)}`;

describe('remi serve resume (integration, #1129)', () => {
  test("a resume starts a child session daemon whose Claude receives --resume, and answers with the child's port", async () => {
    const r = await startHub();
    const remiSessionId = seedSession(r);

    const { response, received } = await ask(r, remiSessionId);

    expect(response.success, why(r, response)).toBe(true);
    expect(response.port, why(r, response)).toBeGreaterThan(0);
    expect(response.port).not.toBe(r.hub.port);
    expect(response.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(response.errorCode).toBeUndefined();

    // The child's Claude was started with the resume, in the stored project directory.
    const argv = await waitForRecordedArgv(r.agents.claudeDir);
    expect(argv.slice(0, 2)).toEqual(['--resume', CLAUDE_ID]);
    const cwd = fs.readFileSync(path.join(r.agents.claudeDir, 'cwd'), 'utf-8').trim();
    expect(cwd).toBe(fs.realpathSync(r.project));

    // The session is a registered child daemon on the port the response named, not the hub.
    const entries = childEntries(r);
    const child = entries.find((e) => e.wsPort === response.port);
    expect(child, why(r, response)).toBeDefined();
    expect(child?.sessionId).toBe(response.sessionId as string);
    expect(child?.pid).not.toBe(r.hub.proc.pid);
    // The Claude the fake recorded runs under that child daemon: the child's pid is among its
    // ancestors, so it was the child that started it (the hub only started the child).
    const claudePid = Number(fs.readFileSync(path.join(r.agents.claudeDir, 'pid'), 'utf-8').trim());
    expect(ancestorsOf(claudePid), why(r, response)).toContain(child?.pid as number);

    // The contract the web client's follow relies on: the child's connection says hello for the
    // session the response named.
    const direct = await connectAndHello(response.port as number);
    try {
      const ack = direct.received.find((m): m is HelloAckMessage => m.type === 'hello_ack');
      expect(ack?.sessionId).toBe(response.sessionId as string);
    } finally {
      direct.ws.close();
    }

    // The hub attached nobody to a session it does not own: only the session-less ack came.
    expect(
      received.filter((m): m is HelloAckMessage => m.type === 'hello_ack').map((m) => m.sessionId),
    ).toEqual([null]);
    expect(r.hub.proc.exitCode).toBeNull();
    // The hub never wrote Claude's hook configuration into its own directory.
    expect(fs.existsSync(path.join(r.hub.work, '.claude'))).toBe(false);
  }, 90000);

  test('a Claude session id resumes the same way as the remi id', async () => {
    const r = await startHub();
    seedSession(r);

    const { response } = await ask(r, CLAUDE_ID);

    expect(response.success, why(r, response)).toBe(true);
    expect((await waitForRecordedArgv(r.agents.claudeDir)).slice(0, 2)).toEqual([
      '--resume',
      CLAUDE_ID,
    ]);
  }, 90000);

  test('a session a live remi session already holds is refused with a generic text, and nothing is started', async () => {
    const r = await startHub();
    const remiSessionId = seedSession(r, { live: true });

    const { response } = await ask(r, remiSessionId);

    expect(response.success, why(r, response)).toBe(false);
    expect(response.error).toBe(HELD_TEXT);
    expect(response.port).toBeUndefined();
    expect(childEntries(r)).toEqual([]);
    expect(fs.existsSync(path.join(r.agents.claudeDir, 'argv'))).toBe(false);
  }, 90000);

  test('an unknown session is refused and the hub stays up', async () => {
    const r = await startHub();

    const { response } = await ask(r, crypto.randomUUID());

    expect(response.success).toBe(false);
    expect(response.error).toContain('not found');
    expect(response.port).toBeUndefined();
    expect(childEntries(r)).toEqual([]);
    expect(r.hub.proc.exitCode).toBeNull();
  }, 90000);
});
