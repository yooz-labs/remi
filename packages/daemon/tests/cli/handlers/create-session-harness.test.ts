/**
 * What a create request may ask of a harness (#1179): `checkHarnessRequest`, and
 * the handler that spawns the child it describes.
 *
 * Real allowlists (`validateClaudeRemoteArgs`, `validateCodexRemoteArgs`), a real
 * `HarnessRegistry` over a real PATH (executables in a temp directory, and
 * `process.env.PATH` pointed at it and restored), and the handler's own injection
 * points for the port probe and the spawn, which record what the handler asked
 * for and nothing more. The launch refusal (the older-daemon gate and the held-thread
 * check) is a closure here; the real ones are exercised against a real hub in
 * `integration/hub-create-session.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProtocolMessage, UUID } from '@remi/shared';
import {
  checkHarnessRequest,
  createCreateSessionHandlers,
} from '../../../src/cli/handlers/create-session-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
import { validateClaudeRemoteArgs } from '../../../src/harness/claude-args.ts';
import { validateCodexRemoteArgs } from '../../../src/harness/codex/codex-args.ts';
import { HarnessRegistry } from '../../../src/harness/registry.ts';
import { SessionRegistryFile } from '../../../src/session/session-registry-file.ts';

const CID = 'conn0000-0000-0000-0000-000000000000' as UUID;
const REQ = 'req00000-0000-0000-0000-000000000000' as UUID;
const THREAD = '01950000-0000-7000-8000-0000000000aa';
const THREAD_FOR_CLAUDE = '3f9c2a1e-0000-4000-8000-000000000042';
/** A launch refusal: what the client is told, and the host-local detail only the log gets (G8). */
const GATE = {
  client: 'An older remi is running on the host (test client text)',
  detail: 'older remi pid 4321 recorded in /home/someone/.remi/live-sessions/x.json (test detail)',
};
const SPAWNED = { sessionId: '55555555-5555-4555-8555-555555555555', port: 20003 };
/** The headless notice is built from the new session's id and port, which only a spawn knows (G11). */
const noticeFor = (session: { sessionId: string; port: number }): string =>
  `started without a terminal; attach with ${session.port}/${session.sessionId.slice(0, 8)} (test notice text)`;

describe('create requests naming a harness (#1179)', () => {
  let dir: string;
  let savedPath: string | undefined;
  let gate: { client: string; detail: string } | null;
  let gateCalls: number;
  let gateSaw: unknown[];
  let claudeGate: { client: string; detail: string } | null;
  let claudeSaw: unknown[];
  let logged: string[];
  let sent: ProtocolMessage[];
  let probes: number;
  let spawns: Array<{ port: number; directory: string | undefined; extraArgs: string[] }>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-create-harness-'));
    savedPath = process.env['PATH'];
    for (const name of ['claude', 'codex']) {
      fs.writeFileSync(path.join(dir, name), '#!/bin/sh\n');
      fs.chmodSync(path.join(dir, name), 0o755);
    }
    process.env['PATH'] = dir;
    gate = null;
    gateCalls = 0;
    gateSaw = [];
    claudeGate = null;
    claudeSaw = [];
    logged = [];
    sent = [];
    probes = 0;
    spawns = [];
    configureLogger({ writeLog: (line: string) => logged.push(line) });
  });

  afterEach(() => {
    __resetLoggerForTests();
    process.env['PATH'] = savedPath ?? '';
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const registry = () =>
    new HarnessRegistry({
      claude: {
        command: 'claude',
        validateRemoteArgs: validateClaudeRemoteArgs,
        launchRefusal: (checked) => {
          claudeSaw.push(checked);
          return claudeGate;
        },
      },
      codex: {
        command: 'codex',
        validateRemoteArgs: validateCodexRemoteArgs,
        headlessNotice: noticeFor,
        launchRefusal: (checked) => {
          gateCalls += 1;
          gateSaw.push(checked);
          return gate;
        },
      },
    });

  const spawnArgs = (extra: Parameters<typeof checkHarnessRequest>[1]): string[] => {
    const result = checkHarnessRequest(registry(), extra);
    if (!result.ok) throw new Error(`refused: ${result.error}`);
    return result.spawnArgs;
  };
  const refusal = (extra: Parameters<typeof checkHarnessRequest>[1]): string => {
    const result = checkHarnessRequest(registry(), extra);
    if (result.ok) throw new Error(`accepted: ${JSON.stringify(result.spawnArgs)}`);
    return result.error;
  };

  describe('checkHarnessRequest', () => {
    test('a plain request appends nothing', () => {
      expect(spawnArgs(undefined)).toEqual([]);
      expect(spawnArgs({})).toEqual([]);
      expect(gateCalls).toBe(0);
    });

    test('--harness first, then -- and the arguments, last', () => {
      expect(
        spawnArgs({ harness: 'codex', args: ['-m', 'some-model', '-a', 'untrusted'] }),
      ).toEqual(['--harness', 'codex', '--', '-m', 'some-model', '-a', 'untrusted']);
      expect(spawnArgs({ harness: 'codex', args: ['resume', THREAD] })).toEqual([
        '--harness',
        'codex',
        '--',
        'resume',
        THREAD,
      ]);
    });

    test('a named harness with no arguments appends no --', () => {
      expect(spawnArgs({ harness: 'codex' })).toEqual(['--harness', 'codex']);
      expect(spawnArgs({ harness: 'claude', args: [] })).toEqual(['--harness', 'claude']);
    });

    test("arguments with no harness are Claude's, behind a --, with no --harness", () => {
      expect(spawnArgs({ args: ['--model', 'opus'] })).toEqual(['--', '--model', 'opus']);
      expect(spawnArgs({ args: [] })).toEqual([]);
    });

    test('a harness that is not one of the named ids is refused', () => {
      for (const harness of ['gpt', '', 'Claude', 5, null, ['claude'], {}, true]) {
        expect(refusal({ harness })).toContain('Unknown harness');
      }
    });

    test('a harness with no adapter in this build is refused', () => {
      expect(refusal({ harness: 'opencode' })).toContain('no opencode adapter');
    });

    test('a harness whose command is not on PATH is refused by name, even if its adapter exists', () => {
      fs.rmSync(path.join(dir, 'codex'));
      const text = refusal({ harness: 'codex' });
      expect(text).toContain('codex is not available');
      expect(text).toContain('nothing was started');
      // Claude, still installed, is not affected, and a request that names none is not held to it.
      expect(spawnArgs({ harness: 'claude' })).toEqual(['--harness', 'claude']);
      fs.rmSync(path.join(dir, 'claude'));
      expect(refusal({ harness: 'claude' })).toContain('claude is not available');
      expect(spawnArgs({ args: ['--model', 'opus'] })).toEqual(['--', '--model', 'opus']);
    });

    test('each harness is held to its own allowlist, and a remi flag is on neither', () => {
      refusal({ harness: 'claude', args: ['-m', 'x'] });
      refusal({ harness: 'codex', args: ['--resume', THREAD] });
      refusal({ harness: 'codex', args: ['--no-auth'] });
      refusal({ harness: 'claude', args: ['--no-auth'] });
      refusal({ harness: 'codex', args: ['-m', 'x', '--bind', '0.0.0.0'] });
      refusal({ args: ['--daemon'] });
      refusal({ harness: 'codex', args: '-m x' });
      refusal({ harness: 'codex', args: { length: 0 } });
    });

    test('a launch refusal gives the client its short text, after the arguments pass', () => {
      gate = GATE;
      expect(refusal({ harness: 'codex', args: ['-m', 'x'] })).toBe(GATE.client);
      expect(gateCalls).toBe(1);
      // A request the arguments already refuse never reaches the gate.
      refusal({ harness: 'codex', args: ['-c', 'x=y'] });
      expect(gateCalls).toBe(1);
      // Claude has no such gate, and neither does a request that names no harness.
      expect(spawnArgs({ harness: 'claude' })).toEqual(['--harness', 'claude']);
      expect(spawnArgs(undefined)).toEqual([]);
      expect(gateCalls).toBe(1);
    });

    test('the notice of a harness that starts headless is built from the new session, and only for that harness (G11)', () => {
      const codex = checkHarnessRequest(registry(), { harness: 'codex' });
      expect(codex.ok && codex.noticeFor?.(SPAWNED)).toBe(noticeFor(SPAWNED));
      const claude = checkHarnessRequest(registry(), { harness: 'claude' });
      expect(claude.ok && 'noticeFor' in claude).toBe(false);
      const plain = checkHarnessRequest(registry(), undefined);
      expect(plain.ok && 'noticeFor' in plain).toBe(false);
    });

    test('a launch refusal sees the validated arguments and the thread a resume names, lowercased (H2)', () => {
      spawnArgs({ harness: 'codex', args: ['-m', 'x', 'resume', THREAD.toUpperCase()] });
      spawnArgs({ harness: 'codex', args: ['-m', 'x'] });
      expect(gateSaw).toEqual([
        { args: ['-m', 'x', 'resume', THREAD], resumeThreadId: THREAD },
        { args: ['-m', 'x'], resumeThreadId: null },
      ]);
    });

    test("a Claude resume reaches Claude's launch check with the validated arguments and the session it names, lowercased, whether or not a harness is named (P10)", () => {
      const UPPER = '3F9C2A1E-0000-4000-8000-000000000042';
      const lower = UPPER.toLowerCase();
      spawnArgs({ harness: 'claude', args: ['--resume', UPPER] });
      spawnArgs({ args: ['-r', UPPER, '--model', 'opus'] });
      spawnArgs({ harness: 'claude' });
      expect(claudeSaw).toEqual([
        { args: ['--resume', lower], resumeThreadId: lower },
        { args: ['-r', lower, '--model', 'opus'], resumeThreadId: lower },
        { args: [], resumeThreadId: null },
      ]);
      // A plain request, with no harness and no arguments, is the old spawn and is not checked.
      spawnArgs(undefined);
      expect(claudeSaw).toHaveLength(3);
    });

    test("Claude's launch refusal is the client's text, after the arguments pass, and carries its detail for the log (P10)", () => {
      claudeGate = {
        client: 'That Claude session is open (test text)',
        detail: 'holder 12345678 (test detail)',
      };
      const refused = checkHarnessRequest(registry(), { args: ['--resume', THREAD_FOR_CLAUDE] });
      expect(refused).toEqual({
        ok: false,
        error: 'That Claude session is open (test text)',
        detail: 'holder 12345678 (test detail)',
      });
    });

    test('a clear launch check lets the request through', () => {
      gate = null;
      expect(spawnArgs({ harness: 'codex' })).toEqual(['--harness', 'codex']);
      expect(gateCalls).toBe(1);
    });
  });

  describe('the handler', () => {
    function handlers(over: Partial<Parameters<typeof createCreateSessionHandlers>[0]> = {}) {
      return createCreateSessionHandlers({
        harnesses: registry(),
        liveSessionsRegistry: new SessionRegistryFile(path.join(dir, 'live')),
        spawningPorts: new Set(),
        basePort: 20000,
        portRange: 10,
        bindHost: '127.0.0.1',
        inheritedArgs: () => ['--no-auth', '--no-relay', '--bind', '127.0.0.1'],
        send: (_connectionId, message) => {
          sent.push(message);
          return true;
        },
        findAvailableTcpPort: async () => {
          probes += 1;
          return 20003;
        },
        spawnDaemon: async (port, directory, extraArgs) => {
          spawns.push({ port, directory, extraArgs });
          return { sessionId: '55555555-5555-4555-8555-555555555555', port, pid: 4242 };
        },
        ...over,
      });
    }
    const response = () =>
      sent[0] as {
        type: string;
        success: boolean;
        error?: string;
        requestId: UUID;
        notice?: string;
      };

    test('spawns with the inherited flags, then --harness, then -- and the arguments, last', async () => {
      await handlers().onCreateSessionRequest(CID, '/tmp/project', REQ, {
        harness: 'codex',
        args: ['-m', 'some-model'],
      });
      expect(response().success).toBe(true);
      expect(spawns).toHaveLength(1);
      const extra = spawns[0]?.extraArgs as string[];
      expect(extra).toEqual([
        '--no-auth',
        '--no-relay',
        '--bind',
        '127.0.0.1',
        '--harness',
        'codex',
        '--',
        '-m',
        'some-model',
      ]);
      // Nothing a remote client sent can come before `--`, so none can be read as a remi flag.
      expect(extra.indexOf('--harness')).toBeLessThan(extra.indexOf('--'));
      expect(extra.indexOf('--')).toBe(extra.lastIndexOf('--'));
    });

    test('the success of a harness that starts headless carries its notice, Claude and a refusal carry none', async () => {
      await handlers().onCreateSessionRequest(CID, '/tmp/project', REQ, { harness: 'codex' });
      expect(response().success).toBe(true);
      // Built from the session the spawn returned, which is what lets it name `remi attach` exactly.
      expect(response().notice).toBe(noticeFor(SPAWNED));

      sent = [];
      await handlers().onCreateSessionRequest(CID, '/tmp/project', REQ, { harness: 'claude' });
      expect(response().success).toBe(true);
      expect('notice' in response()).toBe(false);

      sent = [];
      await handlers().onCreateSessionRequest(CID, '/tmp/project', REQ, {
        harness: 'codex',
        args: ['--no-auth'],
      });
      expect(response().success).toBe(false);
      expect('notice' in response()).toBe(false);
    });

    test('a refused request answers once, probes no port and spawns nothing', async () => {
      await handlers().onCreateSessionRequest(CID, '/tmp/project', REQ, {
        harness: 'codex',
        args: ['--no-auth'],
      });
      expect(sent).toHaveLength(1);
      expect(response().type).toBe('create_session_response');
      expect(response().success).toBe(false);
      expect(response().requestId).toBe(REQ);
      expect(response().error).toContain('not allowed');
      expect(probes).toBe(0);
      expect(spawns).toEqual([]);
    });

    test('an unavailable harness and a launch refusal refuse the same way, and the client never sees the detail (G8)', async () => {
      fs.rmSync(path.join(dir, 'codex'));
      await handlers().onCreateSessionRequest(CID, '/tmp/project', REQ, { harness: 'codex' });
      expect(response().error).toContain('codex is not available');

      sent = [];
      fs.writeFileSync(path.join(dir, 'codex'), '#!/bin/sh\n');
      fs.chmodSync(path.join(dir, 'codex'), 0o755);
      gate = GATE;
      await handlers().onCreateSessionRequest(CID, '/tmp/project', REQ, { harness: 'codex' });
      expect(response().error).toBe(GATE.client);
      expect(JSON.stringify(sent)).not.toContain('4321');
      expect(JSON.stringify(sent)).not.toContain('/home/someone');
      // The host's log has the whole detail.
      expect(logged.some((line) => line.includes(GATE.detail))).toBe(true);
      expect(probes).toBe(0);
      expect(spawns).toEqual([]);
    });

    test('a resume of a thread a live session holds is refused before a port is probed or anything is spawned (H2)', async () => {
      gate = { client: `Codex thread ${THREAD} is already open (test text)`, detail: 'held' };
      await handlers().onCreateSessionRequest(CID, '/tmp/project', REQ, {
        harness: 'codex',
        args: ['resume', THREAD],
      });
      expect(response().success).toBe(false);
      expect(response().error).toContain('already open');
      expect(probes).toBe(0);
      expect(spawns).toEqual([]);
    });

    test.each([
      ['a hyphen-led value a child would re-parse as a flag', '--no-auth'],
      ['a single hyphen', '-x'],
      ['a hyphen after leading white space, which the handler trims', '  --no-auth'],
      ['a NUL byte', '/tmp/a\0b'],
      ['a newline', '/tmp/a\nb'],
      ['a carriage return', '/tmp/a\rb'],
      ['a terminal escape sequence', '/tmp/a\u001b[2Kb'],
      ['a bell', '/tmp/a\u0007b'],
      ['a tab', '/tmp/a\tb'],
      ['a delete character', '/tmp/a\u007fb'],
      ['a C1 control (the single-character CSI)', '/tmp/a\u009b2Kb'],
      ['a C1 control (next line)', '/tmp/a\u0085b'],
      ['the last C0 control (the unit separator)', '/tmp/a\u001fb'],
      ['the last C1 control', '/tmp/a\u009fb'],
      ['a number', 5],
      ['an object', { toString: () => '/tmp' }],
      ['an array', ['/tmp']],
      ['null', null],
      ['a boolean', true],
    ])(
      'a directory that is %s is refused for every request, before a port is probed (G7)',
      async (_name, directory) => {
        for (const extra of [
          undefined,
          { harness: 'codex' as const },
          { harness: 'claude' as const },
        ]) {
          sent = [];
          await handlers().onCreateSessionRequest(CID, directory as string, REQ, extra);
          expect(response().success, JSON.stringify(extra)).toBe(false);
          expect(response().error).toContain('Invalid directory');
          // The refusal names no part of the value it refused.
          expect(response().error).not.toContain('no-auth');
        }
        expect(probes).toBe(0);
        expect(spawns).toEqual([]);
        expect(gateCalls).toBe(0);
      },
    );

    test.each([
      ['no directory', undefined],
      ['an empty one, which means home', ''],
      ['white space, which means home', '   '],
      ['an absolute path', '/tmp/project'],
      ['a hyphen inside a name', '/tmp/my-project/-x'],
      ['a home-relative path', '~/project'],
      ['non-ASCII letters', '/tmp/projet-\u00e9t\u00e9'],
      ['a space in a name', '/tmp/my project'],
      ['the character just above the C1 controls (a no-break space)', '/tmp/a\u00a0b'],
    ])('a directory that is %s is accepted (G7)', async (_name, directory) => {
      await handlers().onCreateSessionRequest(CID, directory, REQ);
      expect(response().success).toBe(true);
      expect(spawns).toHaveLength(1);
    });

    test('a spawn that fails answers with a short text only, and the log has the failure (G8)', async () => {
      const failing = createCreateSessionHandlers({
        harnesses: registry(),
        liveSessionsRegistry: new SessionRegistryFile(path.join(dir, 'live')),
        spawningPorts: new Set(),
        basePort: 20000,
        portRange: 10,
        bindHost: '127.0.0.1',
        inheritedArgs: () => [],
        send: (_connectionId, message) => {
          sent.push(message);
          return true;
        },
        findAvailableTcpPort: async () => 20003,
        spawnDaemon: async () => {
          throw new Error(
            'Daemon process exited unexpectedly. Check logs: /home/someone/.remi/daemon.log',
          );
        },
      });
      await failing.onCreateSessionRequest(CID, '/tmp/project', REQ);
      expect(response().success).toBe(false);
      expect(response().error).toContain('could not be started');
      expect(response().error).not.toContain('/home/someone');
      expect(response().error).not.toContain('exited unexpectedly');
      expect(logged.some((line) => line.includes('/home/someone/.remi/daemon.log'))).toBe(true);
    });

    test('a directory the handler accepts is logged escaped: a bidi override and a zero-width space are written out (P3)', async () => {
      await handlers().onCreateSessionRequest(CID, '/tmp/a\u202eb\u200bc', REQ);
      expect(response().success).toBe(true);
      const line = logged.find((l) => l.includes('Spawning new daemon')) ?? '';
      expect(line).toContain('/tmp/a\\u202Eb\\u200Bc');
      expect(line).not.toMatch(/[\u200b-\u200f\u202a-\u202e]/);
    });

    test('a failure that carries the directory is logged escaped too, and the client still reads the short text (P3)', async () => {
      await handlers({
        spawnDaemon: async () => {
          throw new Error('cannot start in /tmp/a\u202eb');
        },
      }).onCreateSessionRequest(CID, '/tmp/a\u202eb', REQ);
      expect(response().success).toBe(false);
      expect(response().error).toContain('could not be started');
      const line = logged.find((l) => l.includes('Failed to spawn daemon')) ?? '';
      expect(line).toContain('/tmp/a\\u202Eb');
      expect(line).not.toMatch(/[\u202a-\u202e]/);
    });

    test('a refusal is logged with its reason, and the arguments in it are shown escaped', async () => {
      await handlers().onCreateSessionRequest(CID, '/tmp/project', REQ, {
        harness: 'codex',
        args: ['\u001b]52;c;x\u0007\u202e'],
      });
      expect(response().success).toBe(false);
      const line = logged.find((l) => l.includes('refused')) ?? '';
      expect(line).toContain('not allowed');
      // No raw ESC, BEL or right-to-left override reaches the host's log.
      expect(line).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e]/);
    });

    test('the response and the notice name the port the spawn reported, not the one probed', async () => {
      await handlers({
        spawnDaemon: async () => ({ sessionId: SPAWNED.sessionId, port: 20009, pid: 4242 }),
      }).onCreateSessionRequest(CID, '/tmp/project', REQ, { harness: 'codex' });
      expect((response() as { port?: number }).port).toBe(20009);
      expect(response().notice).toBe(noticeFor({ sessionId: SPAWNED.sessionId, port: 20009 }));
    });

    test('a plain request spawns exactly as it did before, with only the inherited flags', async () => {
      await handlers().onCreateSessionRequest(CID, '/tmp/project', REQ);
      expect(response().success).toBe(true);
      expect(spawns[0]?.extraArgs).toEqual(['--no-auth', '--no-relay', '--bind', '127.0.0.1']);
    });
  });
});
