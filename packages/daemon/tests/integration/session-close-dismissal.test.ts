/**
 * Behavioral pin (#1223): a pushed card is dismissed when its session really
 * closes. `SessionRegistry.closeSession` clears the session before it announces
 * the close, so the gate's teardown (`cancelStale('session_closed')`) found no
 * registered card and broadcast no dismissal: the card stayed on the lock
 * screen until its hold deadline (up to 3540 s for a daemon session).
 *
 * Same black-box setup as `session-notifier-registration.test.ts`: the REAL
 * `cli.ts --daemon` with a fake `claude`, a local signaling server recording
 * `POST /push`, a device token over the real WebSocket and a real held
 * PermissionRequest; then the fake `claude` exits (a real close, not
 * `remi unstick`).
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

describe('a real session close dismisses its pushed cards (#1223)', () => {
  test('the fake claude exits while a prompt is held: the card is dismissed on the lock screen and in the app', async () => {
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
          // Only the fake and the system directories, and a login shell that
          // reports exactly that PATH (the daemon merges its login shell's
          // PATH into its own): a test never starts a real `claude`.
          PATH: `${fakeBin}:/usr/bin:/bin`,
          SHELL: fakeShell,
          FAKE_CLAUDE_DIR: fakeDir,
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
      await pollUntil(
        () => output.text.includes('Device token registered'),
        8000,
        'the device token to be registered',
      );

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
      })
        .then((r) => r.text())
        // The session's end cuts the held request (Claude would see the same).
        .catch(() => 'closed');
      await pollUntil(
        () => received.some((m) => m.type === 'question'),
        8000,
        'the held prompt to reach the client as a question',
      );
      const questionId = (
        received.find((m) => m.type === 'question') as { question: { id: string } } | undefined
      )?.question.id;
      expect(questionId).toBeDefined();
      // The card was pushed to the phone.
      await pollUntil(
        () => pushes.some((p) => p.questionId === questionId && p.kind === 'question'),
        8000,
        'the held prompt to be pushed',
      );

      // A REAL close: the fake claude exits, the PTY exit closes the session.
      fs.writeFileSync(path.join(fakeDir, 'release'), '');
      await pollUntil(() => output.text.includes('Session closed:'), 10000, 'the session to close');

      // The pushed card is dismissed on the lock screen (#1223): a quiet push
      // on the card's own id. Before the fix the gate found the registry
      // already empty and sent nothing.
      await pollUntil(
        () => pushes.some((p) => p.questionId === questionId && p.kind === 'dismiss'),
        8000,
        'the dismissal of the pushed card',
      );
      // And the client got the in-app resolution too.
      expect(
        received.some(
          (m) =>
            m.type === 'question_resolved' &&
            (m as { questionId?: string }).questionId === questionId,
        ),
      ).toBe(true);
      await response;
    } finally {
      ws.close();
    }
  }, 60000);
});
