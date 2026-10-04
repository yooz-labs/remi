/**
 * The shipping sender of `remi new --host` and `remi codex --host`
 * (`createRemoteSession`, #1179), against a real daemon `WebSocketAdapter`
 * over one real socket: both ends are the shipping classes (ADR 0014).
 *
 * The adapter's events stand in for the daemon's handlers (they send the
 * `hello_ack` and the `create_session_response`, as `cli.ts` does), so the test
 * controls what the daemon "offers" and records what it was asked. The relay
 * transport has no real client to drive (#881); its side of the same request is
 * in `relay-client-to-daemon-conformance.test.ts`, labeled as the seam test it is.
 *
 * The sender reads the local capability token from the remi state directory, so
 * `REMI_HOME` points at a temp directory for the test and is put back after.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { HarnessId, UUID } from '@remi/shared';
import { createCreateSessionResponse, createHelloAck } from '@remi/shared';
import { WebSocketAdapter } from '../../src/adapters/websocket-adapter.ts';
import { createRemoteSession } from '../../src/cli/remote-new-client.ts';
import type { CreateSessionExtra } from '../../src/server/client-message-events.ts';
import { reserveRange } from '../session/port-test-helpers.ts';

const SESSION = '55555555-5555-4555-8555-555555555555' as UUID;

describe('createRemoteSession sends a harness only to a daemon that offers it (#1179)', () => {
  let adapter: WebSocketAdapter;
  let port: number;
  let stateDir: string;
  let savedHome: string | undefined;
  /** What the daemon puts in its hello_ack; `undefined` is an older daemon, which has no such field. */
  let offered: readonly HarnessId[] | undefined;
  /** What the daemon says its success does not (#1179); undefined sends none. */
  let notice: string | undefined;
  let requests: Array<{ directory: string | undefined; extra: CreateSessionExtra | undefined }>;

  beforeAll(async () => {
    port = await reserveRange(1);
    adapter = new WebSocketAdapter(
      { port },
      {
        onConnect: (connectionId) => {
          adapter.sendRaw(
            connectionId,
            createHelloAck('1.0.0', null, offered === undefined ? {} : { harnesses: offered }),
          );
        },
        onCreateSessionRequest: (connectionId, directory, requestId, extra) => {
          requests.push({ directory, extra });
          adapter.sendRaw(
            connectionId,
            createCreateSessionResponse(true, requestId, SESSION, undefined, port, notice),
          );
        },
      },
    );
    await adapter.start();
  });

  afterAll(async () => {
    await adapter.stop();
  });

  beforeEach(() => {
    requests = [];
    offered = undefined;
    notice = undefined;
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-remote-new-'));
    savedHome = process.env['REMI_HOME'];
    process.env['REMI_HOME'] = stateDir;
  });

  afterEach(() => {
    if (savedHome === undefined) Reflect.deleteProperty(process.env, 'REMI_HOME');
    else process.env['REMI_HOME'] = savedHome;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  const create = (harness?: HarnessId, args: readonly string[] = []) =>
    createRemoteSession('localhost', port, '/work/project', 5000, harness, args);

  test('a Codex request with arguments reaches a daemon that lists codex, as the extra the handler reads', async () => {
    offered = ['claude', 'codex'];
    const result = await create('codex', ['-m', 'some-model']);
    expect(result).toEqual({ sessionId: SESSION, port });
    expect(requests).toEqual([
      {
        directory: '/work/project',
        extra: { harness: 'codex', args: ['-m', 'some-model'] },
      },
    ]);
  });

  test('a daemon that lists no harnesses (an older one) is never sent a harness: it would start Claude', async () => {
    offered = undefined;
    await expect(create('codex')).rejects.toThrow('does not offer codex');
    await expect(create('claude')).rejects.toThrow('does not offer claude');
    expect(requests).toEqual([]);
  });

  test('a daemon that lists other harnesses is not sent one it did not list', async () => {
    offered = ['claude'];
    await expect(create('codex', ['-m', 'x'])).rejects.toThrow('nothing was started');
    expect(requests).toEqual([]);
  });

  test("arguments with no harness are Claude's, and are not sent to a daemon that would drop them", async () => {
    offered = undefined;
    await expect(create(undefined, ['--continue'])).rejects.toThrow('does not offer claude');
    expect(requests).toEqual([]);

    offered = ['claude'];
    await create(undefined, ['--continue']);
    expect(requests).toEqual([
      { directory: '/work/project', extra: { harness: undefined, args: ['--continue'] } },
    ]);
  });

  test("the daemon's notice on a success comes back to the caller, and its absence stays absent", async () => {
    offered = ['codex'];
    notice = 'started without a terminal (test notice)';
    expect(await create('codex')).toEqual({ sessionId: SESSION, port, notice });
    notice = undefined;
    expect(await create('codex')).toEqual({ sessionId: SESSION, port });
  });

  test('a plain request is the one an older daemon already understands: no extra at all', async () => {
    offered = undefined;
    await create();
    expect(requests).toEqual([{ directory: '/work/project', extra: undefined }]);
  });
});
