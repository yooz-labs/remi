/**
 * Black-box characterization of how a Claude `Stop` hook becomes a push (#1180, Phase 6).
 *
 * Phase 6 moved the turn timer and the "turn complete" push behind a shared sink
 * (`notifications/turn-events.ts`) that Claude's `Stop` hook and Codex's `turn/completed` both end
 * in. The unit tests build the parts one at a time; this drives the whole Claude path the way a
 * Claude session does, so a wrong hand-off in `cli.ts` (the session filter, the timer, the
 * primary session id, the push secret, the minimum) shows up as an observable change.
 *
 * It spawns the REAL `cli.ts --daemon` in an isolated $HOME with a real executable fake `claude`
 * first on PATH (nothing mocked), a local HTTP stand-in for the signaling Worker's `/push`
 * endpoint that records what it is sent, and a phone (a WebSocket client) with a device
 * registered. The hooks are POSTed to the hook port as Claude's own hook scripts do. Every
 * assertion reads what the daemon sent to the endpoint or wrote to its log, so it holds for any
 * implementation of the hand-off. It passed unchanged on the code before Phase 6.
 *
 * Time: `turn_complete_min_seconds` is 0.3 here, and a "long" turn waits 450 ms between its
 * `UserPromptSubmit` and its `Stop`. A timer is never early, so a long turn is long however busy
 * the machine is; the minimum is small enough that a minimum scaled by two (0.6 s) is not passed.
 * "Nothing was pushed" is read after a positive turn whose push has arrived and a short settle.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HelloAckMessage } from '@remi/shared/protocol.ts';
import { createRegisterDeviceToken, serialize } from '@remi/shared/protocol.ts';
import {
  type HubHandle,
  cleanupHub,
  connectAndHello,
  makeIsolatedDirs,
  pollUntil,
  spawnDaemon,
} from './hub-test-utils.ts';

const PUSH_SECRET = 'claude-stop-push-secret';
const MIN_SECONDS = 0.3;
/** Longer than the minimum, shorter than twice it. */
const LONG_TURN_MS = 450;
/** How long a push that should not come is waited for, after the one that should. */
const SETTLE_MS = 250;

/**
 * A fake `claude` that records its argv and pid, writes the (empty) transcript Claude would write
 * for its `--session-id`, then waits until `release` exists (60 s at most, so a failed run cannot
 * leave it looping) and exits 0.
 */
const FAKE_CLAUDE = `#!/bin/sh
d="$FAKE_CLAUDE_DIR"
printf '%s' "$*" > "$d/argv"
echo $$ > "$d/pid"
project="$HOME/.claude/projects/$(pwd -P | sed 's#/#-#g')"
mkdir -p "$project"
: > "$project/$2.jsonl"
i=0
while [ ! -e "$d/release" ] && [ $i -lt 600 ]; do
  sleep 0.1
  i=$((i + 1))
done
`;

interface Push {
  kind?: string;
  title?: string;
  body?: string;
  authorization?: string | undefined;
}

interface Running extends HubHandle {
  output: { text: string };
}

const running: Running[] = [];
const stubs: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
  for (const stub of stubs.splice(0)) stub.stop(true);
  for (const daemon of running.splice(0)) await cleanupHub(daemon);
});

/** Collect a daemon stream into `sink` as it is written. */
function collect(stream: ReadableStream<Uint8Array>, sink: { text: string }): void {
  const decoder = new TextDecoder();
  void (async () => {
    for await (const chunk of stream) sink.text += decoder.decode(chunk, { stream: true });
  })().catch(() => {});
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Session {
  daemon: Running;
  /** What the push endpoint was sent, in arrival order. */
  pushes: Push[];
  /** The hook port of the session, and the id Claude was started with (the hooks carry it). */
  hookPort: number;
  claudeSessionId: string;
  /** The name of the session's directory, which the push title carries. */
  workName: string;
  ws: WebSocket;
  submit(promptId: string, sessionId?: string): Promise<void>;
  stop(
    promptId: string,
    message: string,
    opts?: { reentry?: boolean; sessionId?: string },
  ): Promise<void>;
  /** A prompt, 450 ms of work, then a Stop with `message`: a turn longer than the minimum. */
  longTurn(promptId: string, message: string): Promise<void>;
}

async function startSession(): Promise<Session> {
  const { home, work } = makeIsolatedDirs();
  fs.mkdirSync(path.join(home, '.remi'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.remi', 'config.toml'),
    `[notifications]\nturn_complete_min_seconds = ${MIN_SECONDS}\n`,
  );
  const fakeDir = path.join(home, 'fake-claude');
  const fakeBin = path.join(home, 'fake-bin');
  fs.mkdirSync(fakeDir, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, 'claude'), FAKE_CLAUDE);
  fs.chmodSync(path.join(fakeBin, 'claude'), 0o755);

  const pushes: Push[] = [];
  const stub = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      if (new URL(req.url).pathname === '/push') {
        const body = (await req.json()) as Push;
        pushes.push({ ...body, authorization: req.headers.get('authorization') ?? undefined });
      }
      return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
    },
  });
  stubs.push(stub);

  const spawned = await spawnDaemon(
    home,
    work,
    { PATH: `${fakeBin}:${process.env['PATH'] ?? ''}`, FAKE_CLAUDE_DIR: fakeDir },
    ['--signaling-url', `http://127.0.0.1:${stub.port}`, '--push-secret', PUSH_SECRET],
  );
  const output = { text: '' };
  collect(spawned.proc.stdout, output);
  collect(spawned.proc.stderr, output);
  const daemon: Running = { ...spawned, home, work, output };
  running.push(daemon);

  const liveDir = path.join(home, '.remi', 'live-sessions');
  let hookPort = 0;
  await pollUntil(
    () => {
      if (spawned.proc.exitCode !== null)
        throw new Error(`Daemon exited early (${spawned.proc.exitCode})`);
      if (!fs.existsSync(liveDir) || !fs.existsSync(path.join(fakeDir, 'pid'))) return false;
      const files = fs.readdirSync(liveDir).filter((f) => f.endsWith('.json'));
      if (files.length !== 1) return false;
      try {
        const entry = JSON.parse(
          fs.readFileSync(path.join(liveDir, files[0] as string), 'utf8'),
        ) as {
          hookPort?: number;
        };
        hookPort = entry.hookPort ?? 0;
      } catch {
        return false;
      }
      return hookPort > 0;
    },
    20000,
    'the daemon and the fake claude to start',
  );
  const argv = fs.readFileSync(path.join(fakeDir, 'argv'), 'utf8').trim();
  const claudeSessionId = /^--session-id (\S+)/.exec(argv)?.[1];
  if (claudeSessionId === undefined) throw new Error(`no session id in argv: ${argv}`);

  const { ws, received } = await connectAndHello(spawned.port);
  if (!received.some((m): m is HelloAckMessage => m.type === 'hello_ack')) {
    throw new Error('no hello_ack received');
  }
  ws.send(serialize(createRegisterDeviceToken('claude-stop-device', 'ios')));
  await pollUntil(
    () => output.text.includes('Device token registered'),
    10000,
    'the device token to register',
  );

  const post = async (body: Record<string, unknown>): Promise<void> => {
    const response = await fetch(`http://127.0.0.1:${hookPort}/hooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cwd: fs.realpathSync(work),
        permission_mode: 'default',
        transcript_path: '/x.jsonl',
        ...body,
      }),
    });
    await response.text();
  };
  const session: Session = {
    daemon,
    pushes,
    hookPort,
    claudeSessionId,
    workName: path.basename(fs.realpathSync(work)),
    ws,
    submit: (promptId, sessionId = claudeSessionId) =>
      post({
        hook_event_name: 'UserPromptSubmit',
        session_id: sessionId,
        prompt_id: promptId,
        prompt: 'hi',
      }),
    stop: (promptId, message, opts = {}) =>
      post({
        hook_event_name: 'Stop',
        session_id: opts.sessionId ?? claudeSessionId,
        prompt_id: promptId,
        stop_hook_active: opts.reentry === true,
        last_assistant_message: message,
      }),
    longTurn: async (promptId, message) => {
      await session.submit(promptId);
      await sleep(LONG_TURN_MS);
      await session.stop(promptId, message);
    },
  };
  return session;
}

describe('a Claude Stop hook becomes a push through the daemon (black-box, #1180)', () => {
  test('a long turn of the session pushes turn_complete with the secret, the session name and its message; a sibling session’s Stop pushes nothing', async () => {
    const s = await startSession();
    try {
      // A sibling session's long turn first (another Claude in the same directory sends its
      // hooks to this port too): the daemon only reports the turns of its own session.
      await s.submit('p-sibling', 'sibling-session');
      await sleep(LONG_TURN_MS);
      await s.stop('p-sibling', 'SIBLING-ANSWER', { sessionId: 'sibling-session' });
      // Then the session's own.
      await s.longTurn('p-own', 'CLAUDE-ANSWER');
      await pollUntil(() => s.pushes.length >= 1, 10000, 'the turn_complete push');
      await sleep(SETTLE_MS);

      expect(s.pushes.map((p) => [p.kind, p.body])).toEqual([['turn_complete', 'CLAUDE-ANSWER']]);
      expect(s.pushes[0]?.authorization).toBe(`Bearer ${PUSH_SECRET}`);
      expect(s.pushes[0]?.title).toContain(`:${s.workName}`);
      expect(s.daemon.output.text).toContain('[TurnComplete]');
    } finally {
      s.ws.close();
    }
  }, 60000);

  test('a Stop that is a re-entry pushes nothing, and the later real Stop still measures the whole turn', async () => {
    const s = await startSession();
    try {
      await s.submit('p-turn');
      await sleep(LONG_TURN_MS);
      await s.stop('p-turn', 'REENTRY-TEXT', { reentry: true });
      await sleep(SETTLE_MS);
      expect(s.pushes).toEqual([]);

      await s.stop('p-turn', 'FINAL-AFTER-REENTRY');
      await pollUntil(() => s.pushes.length >= 1, 10000, 'the push of the real Stop');
      await sleep(SETTLE_MS);

      expect(s.pushes.map((p) => [p.kind, p.body])).toEqual([
        ['turn_complete', 'FINAL-AFTER-REENTRY'],
      ]);
    } finally {
      s.ws.close();
    }
  }, 60000);

  test('an empty message, a prompt the daemon never saw and a second Stop of a finished prompt push nothing', async () => {
    const s = await startSession();
    try {
      // An empty message: nothing to show.
      await s.submit('p-empty');
      await sleep(LONG_TURN_MS);
      await s.stop('p-empty', '');
      // A prompt id with no UserPromptSubmit: the elapsed time is unknown, which fails toward silence.
      await s.stop('p-never-seen', 'NEVER-SEEN');
      // A long turn that does push, then a second Stop of the same, finished prompt.
      await s.longTurn('p-done', 'DONE-ANSWER');
      await pollUntil(() => s.pushes.length >= 1, 10000, 'the push of the finished turn');
      await s.stop('p-done', 'AGAIN-AFTER-CLEAR');
      // A last positive turn, so what arrived before it has had its time to arrive.
      await s.longTurn('p-last', 'LAST-ANSWER');
      await pollUntil(() => s.pushes.length >= 2, 10000, 'the push of the last turn');
      await sleep(SETTLE_MS);

      expect(s.pushes.map((p) => p.body)).toEqual(['DONE-ANSWER', 'LAST-ANSWER']);
    } finally {
      s.ws.close();
    }
  }, 60000);
});
