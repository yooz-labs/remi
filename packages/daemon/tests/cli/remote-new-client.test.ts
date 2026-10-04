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
import { createCreateSessionResponse, createError, createHelloAck } from '@remi/shared';
import { WebSocketAdapter } from '../../src/adapters/websocket-adapter.ts';
import { createRemoteSession, runRemoteNew } from '../../src/cli/remote-new-client.ts';
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
  /** When set the daemon refuses the request with this text, as a failed `create_session_response`. */
  let failure: string | undefined;
  /** When set the daemon answers the request with a protocol `error` message of this text instead. */
  let protocolError: string | undefined;
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
          if (protocolError !== undefined) {
            adapter.sendRaw(connectionId, createError('SOME_CODE', protocolError));
            return;
          }
          adapter.sendRaw(
            connectionId,
            failure !== undefined
              ? createCreateSessionResponse(false, requestId, undefined, failure)
              : createCreateSessionResponse(true, requestId, SESSION, undefined, port, notice),
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
    failure = undefined;
    protocolError = undefined;
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

  test('text the daemon supplies is shown escaped: a failure, a protocol error and a notice cannot act on the terminal (G10)', async () => {
    offered = ['codex'];
    // ESC (a terminal sequence) and U+202E (a right-to-left override) are what the daemon could send.
    const hostile = 'x\u001b[2K\u001b]52;c;eA==\u0007y\u202ez';
    const shown = 'x\\u001B[2K\\u001B]52;c;eA==\\u0007y\\u202Ez';

    failure = hostile;
    const refused = await create('codex').catch((error: Error) => error.message);
    expect(refused).toBe(`Failed to create session: ${shown}`);

    failure = undefined;
    protocolError = hostile;
    const errored = await create('codex').catch((error: Error) => error.message);
    expect(errored).toBe(`Daemon error: ${shown}`);

    protocolError = undefined;
    notice = hostile;
    expect((await create('codex')).notice).toBe(shown);
  });

  describe('runRemoteNew prints what the hub said, then attaches (G11)', () => {
    const NOTICE_TEXT = [
      'Codex was started without a terminal; it may be waiting at an Update or Trust prompt.',
      'If it does not respond, `remi attach <host>:1234/55555555` shows it.',
    ].join('\n');

    async function run(harness: HarnessId | undefined) {
      const lines: string[] = [];
      const attached: unknown[] = [];
      const result = await runRemoteNew(
        { host: 'localhost', port, directory: '/work/project', timeout: 5000, harness },
        {
          attach: async (options) => {
            attached.push(options);
            return { exitCode: 7 };
          },
          err: (line) => lines.push(line),
        },
      );
      return { lines, attached, result };
    }

    test('the CLI is the attach, so it prints the condition only, not the remedy it is already doing', async () => {
      offered = ['codex'];
      notice = NOTICE_TEXT;
      const { lines, attached, result } = await run('codex');
      expect(lines).toEqual([
        `Creating session on localhost:${port}...`,
        'Session created: 55555555',
        'Codex was started without a terminal; it may be waiting at an Update or Trust prompt.',
        'Attaching...',
      ]);
      expect(lines.join('\n')).not.toContain('remi attach');
      expect(attached).toEqual([{ host: 'localhost', port, sessionId: SESSION }]);
      expect(result).toEqual({ exitCode: 7 });
    });

    test('the printed condition is escaped too', async () => {
      offered = ['codex'];
      notice = 'bad\u001b[2Ktext\nsecond line';
      const { lines } = await run('codex');
      expect(lines).toContain('bad\\u001B[2Ktext');
      expect(lines.join('\n')).not.toContain('\u001b');
    });

    test('no notice, nothing extra is printed', async () => {
      offered = ['claude'];
      const { lines } = await run('claude');
      expect(lines).toEqual([
        `Creating session on localhost:${port}...`,
        'Session created: 55555555',
        'Attaching...',
      ]);
    });
  });
});
