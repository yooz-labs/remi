/**
 * Behavioral pins (#1223): a session's pushed cards are dismissed when it
 * really closes, and the dismissals reach the phone before the daemon exits.
 *
 * `SessionRegistry.closeSession` clears the session before it announces the
 * close, so nothing could look the session's cards up to dismiss them; and a
 * daemon whose agent exits closes its session and exits within milliseconds,
 * before a push in flight leaves. Both left the card on the lock screen.
 *
 * Same black-box setup as `session-notifier-registration.test.ts`: the REAL
 * `cli.ts --daemon` with a fake `claude`, a local signaling server recording
 * `POST /push`, a device token over the real WebSocket, then the fake `claude`
 * exits (a real close, not `remi unstick`).
 */

import { afterEach, describe, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type ProtocolMessage,
  createRegisterDeviceToken,
  serialize,
} from '@remi/shared/protocol.ts';
import { DEFAULT_CONFIG } from '../../src/config/config.ts';
import { reserveRange } from '../session/port-test-helpers.ts';
import {
  CLI_TS,
  cleanupHub,
  connectAndHello,
  isolatedEnv,
  makeIsolatedDirs,
  pollUntil,
} from './hub-test-utils.ts';

interface PushBody {
  token?: string;
  questionId?: string;
  kind?: string;
}

/** A `claude` that stays up until the test releases it (60 s at most). */
const FAKE_CLAUDE = `#!/bin/sh
i=0
while [ ! -e "$FAKE_CLAUDE_DIR/release" ] && [ $i -lt 600 ]; do
  sleep 0.1
  i=$((i + 1))
done
`;

const TOKEN = 'a'.repeat(64);
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

interface Running {
  /** Every POST /push the signaling stand-in received, in order (refused ones too). */
  pushes: PushBody[];
  output: { text: string };
  hookPort: number;
  claudeSessionId: string;
  work: string;
  fakeDir: string;
  ws: WebSocket;
  received: ProtocolMessage[];
}

/**
 * The real daemon with a fake claude and one phone whose device token is
 * registered. `respond` decides each push's HTTP status (default 200).
 */
async function startWithPhone(respond: (body: PushBody) => number = () => 200): Promise<Running> {
  const pushes: PushBody[] = [];
  const signaling = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      if (req.method === 'POST' && new URL(req.url).pathname === '/push') {
        const body = (await req.json()) as PushBody;
        pushes.push(body);
        const status = respond(body);
        return Response.json(status === 200 ? { ok: true } : { error: 'unavailable' }, { status });
      }
      return Response.json({ ok: true });
    },
  });
  cleanup.push(async () => {
    await signaling.stop(true);
  });

  const { home, work } = makeIsolatedDirs();
  const fakeDir = path.join(home, 'fake-claude');
  const fakeBin = path.join(home, 'fake-bin');
  fs.mkdirSync(fakeDir, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, 'claude'), FAKE_CLAUDE);
  fs.chmodSync(path.join(fakeBin, 'claude'), 0o755);
  const fakeShell = path.join(fakeBin, 'sh-path');
  fs.writeFileSync(fakeShell, '#!/bin/sh\necho "$PATH"\n');
  fs.chmodSync(fakeShell, 0o755);

  const port = await reserveRange(1, 50, DEFAULT_CONFIG.daemon.bind);
  const proc = Bun.spawn(
    [
      process.execPath,
      CLI_TS,
      '--daemon',
      '--port',
      String(port),
      '--no-relay',
      '--no-telegram',
      '--no-mdns',
      '--no-auth',
      '--signaling-url',
      `http://127.0.0.1:${signaling.port}`,
    ],
    {
      cwd: work,
      env: isolatedEnv(home, {
        CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '',
        PATH: `${fakeBin}:/usr/bin:/bin`,
        SHELL: fakeShell,
        FAKE_CLAUDE_DIR: fakeDir,
      }),
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  cleanup.push(async () => {
    // Release the fake claude so it never outlives the test.
    fs.writeFileSync(path.join(fakeDir, 'release'), '');
    await cleanupHub({ proc, home, work, port });
  });
  const output = { text: '' };
  for (const stream of [proc.stdout, proc.stderr]) {
    const decoder = new TextDecoder();
    void (async () => {
      for await (const chunk of stream) output.text += decoder.decode(chunk, { stream: true });
    })().catch(() => {});
  }

  const liveDir = path.join(home, '.remi', 'live-sessions');
  const liveEntry = (): { hookPort: number; claudeChildPid?: number } | null => {
    if (!fs.existsSync(liveDir)) return null;
    const files = fs.readdirSync(liveDir).filter((f) => f.endsWith('.json'));
    if (files.length !== 1) return null;
    try {
      return JSON.parse(fs.readFileSync(path.join(liveDir, files[0] as string), 'utf-8'));
    } catch {
      return null;
    }
  };
  await pollUntil(
    () => {
      if (proc.exitCode !== null) throw new Error(`Daemon exited early (${proc.exitCode})`);
      return liveEntry()?.claudeChildPid !== undefined;
    },
    20000,
    'the daemon to launch its session',
  );
  const hookPort = (liveEntry() as { hookPort: number }).hookPort;
  const stored = JSON.parse(
    fs.readFileSync(path.join(home, '.remi', 'sessions.json'), 'utf-8'),
  ) as { sessions: Array<{ claudeSessionId: string }> };
  const claudeSessionId = (stored.sessions[0] as { claudeSessionId: string }).claudeSessionId;

  const { ws, received } = await connectAndHello(port);
  cleanup.push(async () => {
    ws.close();
  });
  ws.send(serialize(createRegisterDeviceToken(TOKEN, 'ios')));
  await pollUntil(
    () => output.text.includes('Device token registered'),
    8000,
    'the device token to be registered',
  );
  return { pushes, output, hookPort, claudeSessionId, work, fakeDir, ws, received };
}

function postHook(r: Running, body: Record<string, unknown>): Promise<string> {
  return (
    fetch(`http://127.0.0.1:${r.hookPort}/hooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: r.claudeSessionId,
        cwd: fs.realpathSync(r.work),
        ...body,
      }),
    })
      .then((res) => res.text())
      // The session's end cuts a held request (Claude would see the same).
      .catch(() => 'closed')
  );
}

function heldPrompt(r: Running): Promise<string> {
  return postHook(r, {
    hook_event_name: 'PermissionRequest',
    permission_mode: 'default',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    permission_suggestions: [],
  });
}

async function pushedCardId(r: Running, kind = 'question'): Promise<string> {
  let id: string | undefined;
  await pollUntil(
    () => {
      id = r.pushes.find((p) => p.kind === kind && typeof p.questionId === 'string')?.questionId;
      return id !== undefined;
    },
    8000,
    'a card to be pushed',
  );
  return id as string;
}

/** A REAL close: the fake claude exits and the PTY exit closes the session. */
async function closeSession(r: Running): Promise<void> {
  fs.writeFileSync(path.join(r.fakeDir, 'release'), '');
  await pollUntil(() => r.output.text.includes('Session closed:'), 10000, 'the session to close');
}

const dismissals = (r: Running, id: string): PushBody[] =>
  r.pushes.filter((p) => p.questionId === id && p.kind === 'dismiss');

describe('a real session close dismisses its pushed cards (#1223)', () => {
  test('a held prompt: the card is dismissed on the lock screen and in the app', async () => {
    const r = await startWithPhone();
    const response = heldPrompt(r);
    const id = await pushedCardId(r);

    await closeSession(r);

    await pollUntil(() => dismissals(r, id).length > 0, 8000, 'the dismissal of the pushed card');
    await pollUntil(
      () =>
        r.received.some(
          (m) => m.type === 'question_resolved' && (m as { questionId?: string }).questionId === id,
        ),
      8000,
      'the in-app resolution of the card',
    );
    await response;
  }, 60000);

  test('the daemon waits for a slow dismissal before it exits: a retried delivery still lands', async () => {
    // The first dismissal is refused with a 503, so its delivery needs the
    // retry 400 ms later; a daemon that exited right after the close never
    // sent it.
    let refused = false;
    const r = await startWithPhone((body) => {
      if (body.kind === 'dismiss' && !refused) {
        refused = true;
        return 503;
      }
      return 200;
    });
    const response = heldPrompt(r);
    const id = await pushedCardId(r);

    await closeSession(r);

    await pollUntil(() => dismissals(r, id).length >= 2, 8000, 'the retried dismissal');
    await response;
  }, 60000);

  test('a card the permission relay does not track (an MCP elicitation) is dismissed too', async () => {
    const r = await startWithPhone();
    // A card that is not held is pushed only to a phone with no client
    // attached, so the phone's app goes to the background first.
    r.ws.close();
    await pollUntil(
      () => r.output.text.includes('Client disconnected'),
      8000,
      'the client to disconnect',
    );
    void postHook(r, {
      hook_event_name: 'Elicitation',
      mcp_server_name: 'weather-mcp',
      message: 'Which city?',
      mode: 'form',
      elicitation_id: 'elicit-1223',
      requested_schema: { type: 'object', properties: { city: { type: 'string' } } },
    });
    const id = await pushedCardId(r);

    await closeSession(r);

    await pollUntil(() => dismissals(r, id).length > 0, 8000, 'the dismissal of the pushed card');
  }, 60000);
});
