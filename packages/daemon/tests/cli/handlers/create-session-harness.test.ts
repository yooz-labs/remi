/**
 * What a create request may ask of a harness (#1179): `checkHarnessRequest`, and
 * the handler that spawns the child it describes.
 *
 * Real allowlists (`validateClaudeRemoteArgs`, `validateCodexRemoteArgs`), a real
 * `HarnessRegistry` over a real PATH (executables in a temp directory, and
 * `process.env.PATH` pointed at it and restored), and the handler's own injection
 * points for the port probe and the spawn, which record what the handler asked
 * for and nothing more. The older-daemon gate is a closure here; the real gate
 * (`findLegacyWriters`) is exercised against a real hub in
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
const GATE_TEXT = 'remi codex will not start: an older remi is running (test gate text)';

describe('create requests naming a harness (#1179)', () => {
  let dir: string;
  let savedPath: string | undefined;
  let gate: string | null;
  let gateCalls: number;
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
    sent = [];
    probes = 0;
    spawns = [];
    configureLogger({ writeLog: () => {} });
  });

  afterEach(() => {
    __resetLoggerForTests();
    process.env['PATH'] = savedPath ?? '';
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const registry = () =>
    new HarnessRegistry({
      claude: { command: 'claude', validateRemoteArgs: validateClaudeRemoteArgs },
      codex: {
        command: 'codex',
        validateRemoteArgs: validateCodexRemoteArgs,
        launchRefusal: () => {
          gateCalls += 1;
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
      expect(spawnArgs({ args: ['--continue'] })).toEqual(['--', '--continue']);
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
      expect(spawnArgs({ args: ['--continue'] })).toEqual(['--', '--continue']);
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

    test('the older-daemon gate refuses a Codex request with its own text, after the arguments pass', () => {
      gate = GATE_TEXT;
      expect(refusal({ harness: 'codex', args: ['-m', 'x'] })).toBe(GATE_TEXT);
      expect(gateCalls).toBe(1);
      // A request the arguments already refuse never reaches the gate.
      refusal({ harness: 'codex', args: ['-c', 'x=y'] });
      expect(gateCalls).toBe(1);
      // Claude has no such gate, and neither does a request that names no harness.
      expect(spawnArgs({ harness: 'claude' })).toEqual(['--harness', 'claude']);
      expect(spawnArgs(undefined)).toEqual([]);
      expect(gateCalls).toBe(1);
    });

    test('a clear gate lets the request through', () => {
      gate = null;
      expect(spawnArgs({ harness: 'codex' })).toEqual(['--harness', 'codex']);
      expect(gateCalls).toBe(1);
    });
  });

  describe('the handler', () => {
    function handlers() {
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
      });
    }
    const response = () =>
      sent[0] as { type: string; success: boolean; error?: string; requestId: UUID };

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

    test('an unavailable harness and the older-daemon gate refuse the same way', async () => {
      fs.rmSync(path.join(dir, 'codex'));
      await handlers().onCreateSessionRequest(CID, '/tmp/project', REQ, { harness: 'codex' });
      expect(response().error).toContain('codex is not available');

      sent = [];
      fs.writeFileSync(path.join(dir, 'codex'), '#!/bin/sh\n');
      fs.chmodSync(path.join(dir, 'codex'), 0o755);
      gate = GATE_TEXT;
      await handlers().onCreateSessionRequest(CID, '/tmp/project', REQ, { harness: 'codex' });
      expect(response().error).toBe(GATE_TEXT);
      expect(probes).toBe(0);
      expect(spawns).toEqual([]);
    });

    test('a plain request spawns exactly as it did before, with only the inherited flags', async () => {
      await handlers().onCreateSessionRequest(CID, '/tmp/project', REQ);
      expect(response().success).toBe(true);
      expect(spawns[0]?.extraArgs).toEqual(['--no-auth', '--no-relay', '--bind', '127.0.0.1']);
    });
  });
});
