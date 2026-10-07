/**
 * Black-box pin of what a Claude daemon puts on the wire (#1179, Phase 5 of the
 * Codex epic #1175): `hello_ack`, `session_list_response` and `question` are
 * the old messages plus the added identity fields, and nothing else changed.
 *
 * It spawns the REAL `cli.ts --daemon` in an isolated `$HOME`, with an
 * executable fake `claude` first on a PATH of fakes plus `/usr/bin:/bin` only
 * (a stand-in login shell reports that same PATH, so no real `claude` or
 * `codex` can resolve), and talks to it with a real WebSocket client. The
 * question is a real held `PermissionRequest` posted to the daemon's hook port,
 * as Claude Code posts it. Every assertion reads the bytes that came over the
 * socket, so it holds for any implementation.
 *
 * Each message is checked twice: stripped of the added fields it has exactly
 * the keys it had before Phase 5 (`LEGACY_*`), and the added fields are what the
 * dual-emit rule says (#1165 A): for Claude `harnessSessionId` equals
 * `claudeSessionId`.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  HelloAckMessage,
  ProtocolMessage,
  QuestionMessage,
  SessionListResponseMessage,
} from '@remi/shared/protocol.ts';
import {
  createResumeSessionRequest,
  createSessionListRequest,
  serialize,
} from '@remi/shared/protocol.ts';
import {
  cleanupHub,
  connectAndHello,
  makeIsolatedDirs,
  pollUntil,
  spawnDaemon,
} from './hub-test-utils.ts';

/** The keys of each message before Phase 5. */
const LEGACY_HELLO_ACK = [
  'attachState',
  'claudeSessionId',
  'daemonVersion',
  'id',
  'isResume',
  'nextBulletId',
  'replayCount',
  'serverVersion',
  'sessionId',
  'timestamp',
  'transcriptPath',
  'type',
];
const LEGACY_QUESTION = ['claudeSessionId', 'id', 'question', 'sessionId', 'timestamp', 'type'];
/** `lastMessage` and `model` are present only when the session has them. */
const LEGACY_LISTED_REQUIRED = [
  'canAttach',
  'canResume',
  'claudeSessionId',
  'createdAt',
  'lastActivity',
  'messageCount',
  'name',
  'projectPath',
  'sessionId',
  'source',
  'status',
  'transcriptPath',
];
const LEGACY_LISTED_OPTIONAL = ['lastMessage', 'model', 'wsPort', 'daemonHost'];

const FAKE_CLAUDE = `#!/bin/sh
project="$HOME/.claude/projects/$(pwd -P | sed 's#/#-#g')"
mkdir -p "$project"
: > "$project/$2.jsonl"
i=0
while [ ! -e "$FAKE_CLAUDE_DIR/release" ] && [ $i -lt 600 ]; do
  sleep 0.1
  i=$((i + 1))
done
`;
const FAKE_SHELL = '#!/bin/sh\necho "$PATH"\n';

interface Running {
  proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  home: string;
  work: string;
  port: number;
  hookPort: number;
  claudeSessionId: string;
}

let started: Promise<Running> | null = null;

async function daemon(): Promise<Running> {
  started ??= (async () => {
    const { home, work } = makeIsolatedDirs();
    const fakeDir = path.join(home, 'fake-claude');
    const fakeBin = path.join(home, 'fake-bin');
    fs.mkdirSync(fakeDir, { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, 'claude'), FAKE_CLAUDE);
    fs.chmodSync(path.join(fakeBin, 'claude'), 0o755);
    fs.writeFileSync(path.join(fakeBin, 'sh-path'), FAKE_SHELL);
    fs.chmodSync(path.join(fakeBin, 'sh-path'), 0o755);
    const spawned = await spawnDaemon(home, work, {
      PATH: `${fakeBin}:/usr/bin:/bin`,
      SHELL: path.join(fakeBin, 'sh-path'),
      FAKE_CLAUDE_DIR: fakeDir,
    });
    const liveDir = path.join(home, '.remi', 'live-sessions');
    let hookPort = 0;
    await pollUntil(
      () => {
        if (spawned.proc.exitCode !== null) throw new Error('Daemon exited early');
        try {
          const file = fs.readdirSync(liveDir).find((f) => f.endsWith('.json'));
          if (!file) return false;
          const entry = JSON.parse(fs.readFileSync(path.join(liveDir, file), 'utf-8')) as {
            hookPort: number;
            claudeChildPid?: number;
          };
          hookPort = entry.hookPort;
          return entry.claudeChildPid !== undefined;
        } catch {
          return false;
        }
      },
      20000,
      'the daemon to start its fake claude',
    );
    const stored = JSON.parse(
      fs.readFileSync(path.join(home, '.remi', 'sessions.json'), 'utf-8'),
    ) as { sessions: Array<{ claudeSessionId: string }> };
    return {
      ...spawned,
      home,
      work,
      hookPort,
      claudeSessionId: (stored.sessions[0] as { claudeSessionId: string }).claudeSessionId,
    };
  })();
  return started;
}

afterAll(async () => {
  if (!started) return;
  const d = await started;
  await cleanupHub({ proc: d.proc, home: d.home, work: d.work, port: d.port });
});

function without(message: object, added: readonly string[]): string[] {
  return Object.keys(message)
    .filter((key) => !added.includes(key))
    .sort();
}

describe('a Claude daemon on the wire (#1179)', () => {
  test('hello_ack keeps every field it had', async () => {
    const d = await daemon();
    const { ws, received } = await connectAndHello(d.port);
    try {
      const ack = received.find((m): m is HelloAckMessage => m.type === 'hello_ack');
      if (!ack) throw new Error('no hello_ack');
      expect(
        without(ack, [
          'harness',
          'harnessSessionId',
          'harnesses',
          'protocolVersion',
          'capabilities',
        ]),
      ).toEqual(LEGACY_HELLO_ACK);
      expect(ack.claudeSessionId).toBe(d.claudeSessionId);
    } finally {
      ws.close();
    }
  }, 40000);

  test('hello_ack adds the harness, its session id (the Claude id) and the available harnesses', async () => {
    const d = await daemon();
    const { ws, received } = await connectAndHello(d.port);
    try {
      const ack = received.find((m): m is HelloAckMessage => m.type === 'hello_ack');
      expect(ack?.harness).toBe('claude');
      expect(ack?.harnessSessionId).toBe(d.claudeSessionId);
      expect(ack?.harnessSessionId).toBe(ack?.claudeSessionId);
      // Only the fake `claude` is on this PATH; opencode has no adapter in this build.
      expect(ack?.harnesses).toEqual(['claude']);
    } finally {
      ws.close();
    }
  }, 40000);

  test('hello_ack names the protocol version and the capabilities, none yet (#1237)', async () => {
    const d = await daemon();
    const { ws, received } = await connectAndHello(d.port);
    try {
      const ack = received.find((m): m is HelloAckMessage => m.type === 'hello_ack');
      expect(ack?.protocolVersion).toBe(1);
      expect(ack?.capabilities).toEqual([]);
    } finally {
      ws.close();
    }
  }, 40000);

  test('the session list entry keeps every field it had and adds the identity', async () => {
    const d = await daemon();
    const { ws, received } = await connectAndHello(d.port);
    try {
      ws.send(serialize(createSessionListRequest(false)));
      await pollUntil(
        () => received.some((m) => m.type === 'session_list_response'),
        8000,
        'the session list',
      );
      const list = received.find(
        (m): m is SessionListResponseMessage => m.type === 'session_list_response',
      );
      const entry = list?.sessions[0];
      if (!entry) throw new Error('no listed session');
      const keys = without(entry, ['harness', 'harnessSessionId']);
      expect(keys.filter((k) => !LEGACY_LISTED_OPTIONAL.includes(k))).toEqual(
        [...LEGACY_LISTED_REQUIRED].sort(),
      );
      expect(entry.claudeSessionId).toBe(d.claudeSessionId);
      expect(entry.harness).toBe('claude');
      expect(entry.harnessSessionId).toBe(d.claudeSessionId);
    } finally {
      ws.close();
    }
  }, 40000);

  test('a live question and its re-send to a later client keep their fields and add the identity', async () => {
    const d = await daemon();
    const first = await connectAndHello(d.port);
    let second: Awaited<ReturnType<typeof connectAndHello>> | null = null;
    // Claude Code POSTs a PermissionRequest to the hook port and waits for the daemon's answer.
    void fetch(`http://127.0.0.1:${d.hookPort}/hooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hook_event_name: 'PermissionRequest',
        session_id: d.claudeSessionId,
        cwd: fs.realpathSync(d.work),
        permission_mode: 'default',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        permission_suggestions: [],
      }),
    }).catch(() => {});
    try {
      const isQuestion = (m: ProtocolMessage): m is QuestionMessage => m.type === 'question';
      await pollUntil(() => first.received.some(isQuestion), 8000, 'the live question');
      second = await connectAndHello(d.port);
      const reconnected = second;
      await pollUntil(() => reconnected.received.some(isQuestion), 8000, 'the re-sent question');
      for (const message of [first.received.find(isQuestion), second.received.find(isQuestion)]) {
        if (!message) throw new Error('no question');
        expect(without(message, ['harness', 'harnessSessionId'])).toEqual(LEGACY_QUESTION);
        expect(message.claudeSessionId).toBe(d.claudeSessionId);
        expect(message.harness).toBe('claude');
        expect(message.harnessSessionId).toBe(d.claudeSessionId);
      }
    } finally {
      first.ws.close();
      second?.ws.close();
    }
  }, 40000);
  test("the daemon's live-sessions entry names no harness, as before (a Claude entry is byte-compatible with an older remi's)", async () => {
    const d = await daemon();
    const liveDir = path.join(d.home, '.remi', 'live-sessions');
    const file = fs.readdirSync(liveDir).find((f) => f.endsWith('.json')) as string;
    const entry = JSON.parse(fs.readFileSync(path.join(liveDir, file), 'utf-8')) as object;
    expect('harness' in entry).toBe(false);
  }, 40000);
  test('the ack of a resume of its own session names the harnesses too, and no binding', async () => {
    const d = await daemon();
    const { ws, received } = await connectAndHello(d.port);
    try {
      const sessionId = (
        received.find((m): m is HelloAckMessage => m.type === 'hello_ack') as HelloAckMessage
      ).sessionId as string;
      const acksBefore = received.filter((m) => m.type === 'hello_ack').length;
      ws.send(serialize(createResumeSessionRequest(sessionId)));
      await pollUntil(
        () => received.filter((m) => m.type === 'hello_ack').length > acksBefore,
        8000,
        'the ack of the resume',
      );
      const ack = received.filter((m): m is HelloAckMessage => m.type === 'hello_ack').at(-1);
      expect(ack?.harnesses).toEqual(['claude']);
      // A resume ack has never named a binding; naming an identity there would be a guess.
      expect(ack).not.toHaveProperty('claudeSessionId');
      expect(ack).not.toHaveProperty('harness');
    } finally {
      ws.close();
    }
  }, 40000);
});
