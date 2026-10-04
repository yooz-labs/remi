/**
 * Black-box check of what a Codex daemon puts on the wire (#1179, Phase 5 of the
 * Codex epic #1175): the harness and its session id on `hello_ack`, the session
 * list and every `question`, with `claudeSessionId` omitted.
 *
 * It spawns the REAL `cli.ts --daemon --harness codex` in an isolated `$HOME`
 * with a fake `codex` first on a PATH of fakes plus `/usr/bin:/bin` only, a
 * `FakeAppServer` for the shared app-server (a real WebSocket server replaying
 * redacted spike frames), and a real WebSocket client. The test plays the Codex
 * TUI by emitting the real `thread/started` frame, and the approval is the real
 * command-approval frame of the spike. Everything asserted is read off the socket.
 *
 * The identity is null on the first `hello_ack` (the thread is not known until
 * Codex reports it) and nothing depends on it: the answer below carries no
 * `claudeSessionId` and is addressed by `questionId` alone.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import type {
  HelloAckMessage,
  ProtocolMessage,
  QuestionMessage,
  SessionListResponseMessage,
} from '@remi/shared/protocol.ts';
import { createAnswer, createSessionListRequest, serialize } from '@remi/shared/protocol.ts';
import { commandApprovalRequest, threadStartedFrame } from '../helpers/codex-threads.ts';
import { collect, installFakeAgents } from '../helpers/fake-agent-clis.ts';
import { FakeAppServer } from '../helpers/fake-app-server.ts';
import {
  cleanupHub,
  connectAndHello,
  makeIsolatedDirs,
  pollUntil,
  spawnDaemon,
} from './hub-test-utils.ts';

interface Running {
  proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  home: string;
  work: string;
  port: number;
  server: FakeAppServer;
  output: { text: string };
}

const running: Running[] = [];

afterEach(async () => {
  for (const r of running.splice(0)) {
    await cleanupHub({ proc: r.proc, home: r.home, work: r.work, port: r.port });
    await r.server.stop();
  }
});

async function startCodexDaemon(): Promise<Running> {
  const { home, work } = makeIsolatedDirs();
  const agents = installFakeAgents(home, { codex: true });
  const server = FakeAppServer.start();
  const spawned = await spawnDaemon(home, work, { ...agents.env, CODEX_HOME: server.codexHome }, [
    '--harness',
    'codex',
  ]);
  const output = { text: '' };
  collect(spawned.proc.stdout, output);
  collect(spawned.proc.stderr, output);
  const r: Running = { ...spawned, home, work, server, output };
  running.push(r);
  await pollUntil(
    () => {
      if (r.proc.exitCode !== null) throw new Error(`Daemon exited early (${r.proc.exitCode})`);
      const id = r.server.clientIds()[0];
      return id !== undefined && r.server.framesFrom(id).some((f) => f['method'] === 'initialized');
    },
    20000,
    'the daemon to initialize against the fake app-server',
  );
  return r;
}

const isAck = (m: ProtocolMessage): m is HelloAckMessage => m.type === 'hello_ack';
const isQuestion = (m: ProtocolMessage): m is QuestionMessage => m.type === 'question';

describe('a Codex daemon on the wire (#1179)', () => {
  test('hello_ack names the harness with a null session id until the thread is learned, then carries it; claudeSessionId is never sent', async () => {
    const r = await startCodexDaemon();
    const early = await connectAndHello(r.port);
    try {
      const ack = early.received.find(isAck);
      expect(ack?.harness).toBe('codex');
      expect(ack?.harnessSessionId).toBeNull();
      expect('claudeSessionId' in (ack as object)).toBe(false);
      // Only the fake `codex` is on this PATH.
      expect(ack?.harnesses).toEqual(['codex']);
    } finally {
      early.ws.close();
    }

    // The TUI's own thread: a user thread in this directory, created just now.
    const tuiId = crypto.randomUUID();
    r.server.emit(
      threadStartedFrame('tui', {
        id: tuiId,
        cwd: fs.realpathSync(r.work),
        createdAtSec: Math.floor(Date.now() / 1000),
      }),
      { broadcast: true },
    );
    r.server.createRollout(tuiId);
    await pollUntil(
      () => r.output.text.includes(`attached to thread ${tuiId.slice(-8)}`),
      10000,
      'the attach',
    );

    const later = await connectAndHello(r.port);
    try {
      const ack = later.received.find(isAck);
      expect(ack?.harness).toBe('codex');
      expect(ack?.harnessSessionId).toBe(tuiId);
      expect('claudeSessionId' in (ack as object)).toBe(false);
    } finally {
      later.ws.close();
    }
  }, 60000);

  test('the session list, a live approval and its re-send carry the thread id; the phone answers it by questionId alone', async () => {
    const r = await startCodexDaemon();
    const tuiId = crypto.randomUUID();
    r.server.emit(
      threadStartedFrame('tui', {
        id: tuiId,
        cwd: fs.realpathSync(r.work),
        createdAtSec: Math.floor(Date.now() / 1000),
      }),
      { broadcast: true },
    );
    r.server.createRollout(tuiId);
    await pollUntil(
      () => r.output.text.includes(`attached to thread ${tuiId.slice(-8)}`),
      10000,
      'the attach',
    );

    const first = await connectAndHello(r.port);
    let second: Awaited<ReturnType<typeof connectAndHello>> | null = null;
    try {
      const sessionId = (first.received.find(isAck) as HelloAckMessage).sessionId as string;

      first.ws.send(serialize(createSessionListRequest(false)));
      await pollUntil(
        () => first.received.some((m) => m.type === 'session_list_response'),
        8000,
        'the session list',
      );
      const list = first.received.find(
        (m): m is SessionListResponseMessage => m.type === 'session_list_response',
      );
      const entry = list?.sessions[0];
      expect(entry?.harness).toBe('codex');
      expect(entry?.harnessSessionId).toBe(tuiId);
      // A Codex session has no Claude id and no transcript file to name.
      expect(entry).not.toHaveProperty('claudeSessionId');
      expect(entry).not.toHaveProperty('transcriptPath');

      const requestId = r.server.request(
        commandApprovalRequest(tuiId, 'touch wire-marker', { cwd: fs.realpathSync(r.work) }),
        tuiId,
      );
      await pollUntil(() => first.received.some(isQuestion), 10000, 'the approval card');
      second = await connectAndHello(r.port);
      const reconnected = second;
      await pollUntil(() => reconnected.received.some(isQuestion), 10000, 'the re-sent card');
      for (const message of [first.received.find(isQuestion), second.received.find(isQuestion)]) {
        expect(message?.harness).toBe('codex');
        expect(message?.harnessSessionId).toBe(tuiId);
        expect(message).not.toHaveProperty('claudeSessionId');
      }

      // The answer names no Claude session (there is none) and is addressed by questionId.
      const card = (first.received.find(isQuestion) as QuestionMessage).question;
      first.ws.send(serialize(createAnswer(sessionId, card.id, 'Yes')));
      await pollUntil(
        () => !r.server.isPending(tuiId, requestId),
        8000,
        'the app-server request to be answered',
      );
    } finally {
      first.ws.close();
      second?.ws.close();
    }
  }, 60000);
});
