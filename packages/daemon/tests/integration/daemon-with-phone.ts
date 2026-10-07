/**
 * The real daemon with a fake claude and a phone, for black-box push tests
 * (#1223, #1254, #1258): `cli.ts --daemon`, a fake `claude` that stays up until
 * released, a local signaling stand-in recording every `POST /push`, and device
 * tokens registered over the real WebSocket.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type ProtocolMessage,
  type PushPreferences,
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

export interface PushBody {
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

export const TOKEN = 'a'.repeat(64);
const cleanup: Array<() => Promise<void>> = [];

/** Every test file using this calls `afterEach(stopAll)`. */
export async function stopAll(): Promise<void> {
  for (const fn of cleanup.splice(0)) await fn();
}

export interface Running {
  /** Every POST /push the signaling stand-in received, in order (refused ones too). */
  pushes: PushBody[];
  output: { text: string };
  hookPort: number;
  claudeSessionId: string;
  work: string;
  home: string;
  fakeDir: string;
  ws: WebSocket;
  received: ProtocolMessage[];
}

export interface StartOptions {
  /** Each push's HTTP status (default 200). */
  respond?: (body: PushBody) => number;
  /** Files to write into the daemon's home before it starts (for example an old token store). */
  seed?: (remiDir: string) => void;
  /** The tokens the phone registers over the WebSocket, with their preferences (default: one, TOKEN). */
  register?: ReadonlyArray<{ token: string; pushPrefs?: PushPreferences }>;
}

/**
 * The real daemon with a fake claude and one phone that registers its device
 * token(s) over the real WebSocket.
 */
export async function startWithPhone(opts: StartOptions = {}): Promise<Running> {
  const respond = opts.respond ?? (() => 200);
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
  fs.mkdirSync(path.join(home, '.remi'), { recursive: true });
  opts.seed?.(path.join(home, '.remi'));
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
  // One phone per token, each on its own connection: a second token from the
  // same connection reads as an APNS token rotation and prunes the first (#585).
  const tokens = opts.register ?? [{ token: TOKEN }];
  for (const [i, { token, pushPrefs }] of tokens.entries()) {
    let socket = ws;
    if (i > 0) {
      const extra = await connectAndHello(port);
      cleanup.push(async () => {
        extra.ws.close();
      });
      socket = extra.ws;
    }
    socket.send(serialize(createRegisterDeviceToken(token, 'ios', pushPrefs)));
  }
  await pollUntil(
    () => output.text.split('Device token registered').length - 1 >= tokens.length,
    8000,
    'the device tokens to be registered',
  );
  return { pushes, output, hookPort, claudeSessionId, work, home, fakeDir, ws, received };
}

export function postHook(r: Running, body: Record<string, unknown>): Promise<string> {
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

export function heldPrompt(r: Running): Promise<string> {
  return postHook(r, {
    hook_event_name: 'PermissionRequest',
    permission_mode: 'default',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    permission_suggestions: [],
  });
}

export async function pushedCardId(r: Running, kind = 'question'): Promise<string> {
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
export async function closeSession(r: Running): Promise<void> {
  fs.writeFileSync(path.join(r.fakeDir, 'release'), '');
  await pollUntil(() => r.output.text.includes('Session closed:'), 10000, 'the session to close');
}

export const dismissals = (r: Running, id: string): PushBody[] =>
  r.pushes.filter((p) => p.questionId === id && p.kind === 'dismiss');
