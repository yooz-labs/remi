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
import type { HarnessId, ProtocolMessage, UUID } from '@remi/shared';
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
  /** The port the daemon says it started the session on; absent is the daemon's own. */
  let spawnedPort: number | undefined;
  /** When set, fields that overwrite the daemon's success response as it goes on the wire (a daemon may send anything). */
  let rawAnswer: Record<string, unknown> | undefined;
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
          if (rawAnswer !== undefined) {
            adapter.sendRaw(connectionId, {
              ...createCreateSessionResponse(true, requestId, SESSION, undefined, port),
              ...rawAnswer,
            } as unknown as ProtocolMessage);
            return;
          }
          adapter.sendRaw(
            connectionId,
            failure !== undefined
              ? createCreateSessionResponse(false, requestId, undefined, failure)
              : createCreateSessionResponse(
                  true,
                  requestId,
                  SESSION,
                  undefined,
                  spawnedPort ?? port,
                  notice,
                ),
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
    spawnedPort = undefined;
    rawAnswer = undefined;
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

  test.each([
    [
      'a session id with a terminal sequence',
      { sessionId: '55\u001b[2K5555-5555-4555-8555-555555555555' },
    ],
    ['a session id that is not a UUID', { sessionId: 'fixture-session-id' }],
    ['a session id that is not a string', { sessionId: 5 }],
    ['a port that is a string', { port: '1234' }],
    ['a port with a terminal sequence', { port: '1\u001b[2K' }],
    ['a port of zero', { port: 0 }],
    ['a port above 65535', { port: 70000 }],
    ['a fractional port', { port: 12.5 }],
  ])(
    'an answer with %s is refused, so nothing the daemon chose reaches the screen or the attach (G10)',
    async (_name, fields) => {
      offered = ['codex'];
      rawAnswer = fields;
      const message = await create('codex').catch((error: Error) => error.message);
      expect(message).toBe(
        'Failed to create session: the daemon sent an answer this client cannot read',
      );
    },
  );

  test('a port the daemon leaves out is the one the client asked, and a plain UUID and port pass', async () => {
    offered = ['codex'];
    expect(await create('codex')).toEqual({ sessionId: SESSION, port });
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
            return { exitCode: 7, reason: 'detached' as const };
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
      expect(result.exitCode).toBe(7);
    });

    test('the printed condition is escaped too', async () => {
      offered = ['codex'];
      notice = 'bad\u001b[2Ktext\nsecond line';
      const { lines } = await run('codex');
      expect(lines).toContain('bad\\u001B[2Ktext');
      expect(lines.join('\n')).not.toContain('\u001b');
    });

    test('it attaches to the port the daemon started the session on, and says so', async () => {
      offered = ['claude'];
      spawnedPort = port + 1;
      const { lines, attached } = await run('claude');
      expect(lines).toContain(`New daemon spawned on port ${port + 1}`);
      expect(attached).toEqual([{ host: 'localhost', port: port + 1, sessionId: SESSION }]);
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
