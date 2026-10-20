/**
 * Behavioral pin: a real held prompt reaches the session's registered
 * dispatcher (#1165 E, #1176 item 6).
 *
 * `sessionNotifiers` is the daemon's per-session APNS dispatcher registry. The
 * hook bridge's `pushTerminalNotice` closure reads `sessionNotifiers.get(sid)`
 * when a held prompt is handed back to the terminal, so a notice reaches a
 * phone only if the dispatcher was registered before that decision. This runs
 * the REAL `cli.ts --daemon` with a fake `claude` and a local signaling server
 * that records `POST /push`, registers a device token over the real WebSocket,
 * holds a real PermissionRequest, and releases it with `remi unstick`
 * (SIGUSR2), which pushes the "handed back to the terminal" notice through
 * `sessionNotifiers.get(sid)`.
 *
 * It holds for any implementation of the registration, so it passed against
 * the unmodified source (the Claude launch registers the dispatcher) and must
 * keep passing once the shell does.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRegisterDeviceToken, serialize } from '@remi/shared/protocol.ts';
import { DEFAULT_CONFIG } from '../../src/config/config.ts';
import { reserveRange } from '../session/port-test-helpers.ts';
import {
  CLI_TS,
  cleanupHub,
  connectAndHello,
  isolatedEnv,
  makeIsolatedDirs,
  pollUntil,
  waitForRegisteredDeviceToken,
} from './hub-test-utils.ts';

interface PushBody {
  token?: string;
  title?: string;
  body?: string;
  questionId?: string;
  kind?: string;
}

/** A `claude` that stays up until the test is torn down (60 s at most). */
const FAKE_CLAUDE = `#!/bin/sh
i=0
while [ ! -e "$FAKE_CLAUDE_DIR/release" ] && [ $i -lt 600 ]; do
  sleep 0.1
  i=$((i + 1))
done
`;

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

describe('a held prompt reaches the dispatcher registered for its session (#1176 pin)', () => {
  test('remi unstick on a live hold pushes the terminal notice through sessionNotifiers', async () => {
    // A local stand-in for the signaling Worker: records every POST /push.
    const pushes: PushBody[] = [];
    const signaling = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        if (req.method === 'POST' && new URL(req.url).pathname === '/push') {
          pushes.push((await req.json()) as PushBody);
        }
        return Response.json({ ok: true });
      },
    });
    cleanup.push(async () => {
      await signaling.stop(true);
    });

    const { home, work } = makeIsolatedDirs();
    fs.mkdirSync(path.join(home, '.remi'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.remi', 'config.toml'),
      '[notifications]\nlegacy_push_enabled = true\n',
    );
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
        '--push-secret',
        'session-notifier-test-secret',
      ],
      {
        cwd: work,
        env: isolatedEnv(home, {
          CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '',
          // Only the fake and the system directories, and a login shell that
          // reports exactly that PATH (the daemon merges its login shell's
          // PATH into its own): a test never starts a real `claude`.
          PATH: `${fakeBin}:/usr/bin:/bin`,
          SHELL: fakeShell,
          FAKE_CLAUDE_DIR: fakeDir,
          REMI_HOME: path.join(home, '.remi'),
        }),
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    cleanup.push(() => cleanupHub({ proc, home, work, port }));
    const output = { text: '' };
    for (const stream of [proc.stdout, proc.stderr]) {
      const decoder = new TextDecoder();
      void (async () => {
        for await (const chunk of stream) output.text += decoder.decode(chunk, { stream: true });
      })().catch(() => {});
    }

    // The session is registered once its entry carries the hook port.
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

    // A phone registers its device token over the real WebSocket.
    const { ws, received } = await connectAndHello(port);
    try {
      const token = 'a'.repeat(64);
      ws.send(serialize(createRegisterDeviceToken(token, 'ios')));
      await waitForRegisteredDeviceToken(home, token, 8000);

      // Claude Code POSTs a PermissionRequest and waits: the daemon holds it.
      const response = fetch(`http://127.0.0.1:${hookPort}/hooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hook_event_name: 'PermissionRequest',
          session_id: claudeSessionId,
          cwd: fs.realpathSync(work),
          permission_mode: 'default',
          tool_name: 'Bash',
          tool_input: { command: 'ls' },
          permission_suggestions: [],
        }),
      }).then((r) => r.text());
      await pollUntil(
        () => received.some((m) => m.type === 'question'),
        8000,
        'the held prompt to reach the client as a question',
      );
      const before = pushes.length;

      // `remi unstick` hands the live hold back to the terminal, which pushes
      // a notice through this session's dispatcher in `sessionNotifiers`.
      process.kill(proc.pid, 'SIGUSR2');
      await pollUntil(
        () => pushes.slice(before).some((p) => p.questionId?.startsWith('notice-')),
        8000,
        'the terminal notice to reach the signaling server',
      );
      expect(JSON.parse(await response)).toEqual({});
      const notice = pushes.slice(before).find((p) => p.questionId?.startsWith('notice-'));
      expect(notice?.kind).toBe('question');
      expect(notice?.token).toBe('a'.repeat(64));
      // A daemon session has no terminal of its own, so the notice names `remi attach`.
      expect(notice?.title).toContain('answer with remi attach');
    } finally {
      ws.close();
    }
  }, 60000);
});
