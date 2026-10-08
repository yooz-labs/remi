/**
 * `startSession`: the part of a create request that starts a child session daemon and says how it
 * went, without sending anything (#1129). A create request answers with it, and so does a resume
 * through a hub, which starts the same child with Claude's `--resume`.
 *
 * Real allowlist (`validateClaudeRemoteArgs`) and a real `HarnessRegistry` over a real PATH; the
 * handler's own injection points for the port probe and the spawn record what it asked for.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProtocolMessage, UUID } from '@remi/shared';
import { createCreateSessionHandlers } from '../../../src/cli/handlers/create-session-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
import { validateClaudeRemoteArgs } from '../../../src/harness/claude-args.ts';
import { HarnessRegistry } from '../../../src/harness/registry.ts';
import { SessionRegistryFile } from '../../../src/session/session-registry-file.ts';

const CID = 'conn0000-0000-0000-0000-000000000000' as UUID;
const REQ = 'req00000-0000-0000-0000-000000000000' as UUID;
const CLAUDE_ID = '3f9c2a1e-0000-4000-8000-000000000042';
const CHILD = '55555555-5555-4555-8555-555555555555';

describe('startSession (#1129)', () => {
  let dir: string;
  let savedPath: string | undefined;
  let sent: ProtocolMessage[];
  let spawns: Array<{ port: number; directory: string | undefined; extraArgs: string[] }>;
  let spawnError: Error | null;
  let claudeRefusal: { client: string; detail: string } | null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-start-session-'));
    savedPath = process.env['PATH'];
    fs.writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\n');
    fs.chmodSync(path.join(dir, 'claude'), 0o755);
    process.env['PATH'] = dir;
    sent = [];
    spawns = [];
    spawnError = null;
    claudeRefusal = null;
    configureLogger({ writeLog: () => {} });
  });

  afterEach(() => {
    __resetLoggerForTests();
    process.env['PATH'] = savedPath ?? '';
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const handlers = (options: { port?: number | null } = {}) =>
    createCreateSessionHandlers({
      harnesses: new HarnessRegistry({
        claude: {
          command: 'claude',
          validateRemoteArgs: validateClaudeRemoteArgs,
          launchRefusal: () => claudeRefusal,
        },
      }),
      liveSessionsRegistry: new SessionRegistryFile(dir),
      spawningPorts: new Set(),
      basePort: 20000,
      portRange: 10,
      bindHost: '127.0.0.1',
      inheritedArgs: () => ['--auth', '--bind', '127.0.0.1'],
      send: (_connectionId, message) => {
        sent.push(message);
        return true;
      },
      findAvailableTcpPort: async () => (options.port === undefined ? 20005 : options.port),
      spawnDaemon: async (port, directory, extraArgs) => {
        if (spawnError !== null) throw spawnError;
        spawns.push({ port, directory, extraArgs });
        return { sessionId: CHILD, port, pid: 4242 };
      },
    });

  test('starts the child with the arguments it is given and says which session and port, sending nothing', async () => {
    const outcome = await handlers().startSession(dir, { args: ['--resume', CLAUDE_ID] });

    expect(outcome).toEqual({ ok: true, sessionId: CHILD, port: 20005 });
    expect(spawns).toEqual([
      {
        port: 20005,
        directory: dir,
        extraArgs: ['--auth', '--bind', '127.0.0.1', '--', '--resume', CLAUDE_ID],
      },
    ]);
    expect(sent).toEqual([]);
  });

  test('a request the allowlist refuses starts nothing and says why', async () => {
    const outcome = await handlers().startSession(dir, {
      args: ['--dangerously-skip-permissions'],
    });

    expect(outcome.ok).toBe(false);
    expect(spawns).toEqual([]);
    expect(sent).toEqual([]);
  });

  test("a session a live remi session already holds is refused with the launch check's client text", async () => {
    claudeRefusal = {
      client: 'That Claude session is already open in a live remi session on the host',
      detail: 'pid 1',
    };

    const outcome = await handlers().startSession(dir, { args: ['--resume', CLAUDE_ID] });

    expect(outcome).toEqual({
      ok: false,
      error: 'That Claude session is already open in a live remi session on the host',
    });
    expect(spawns).toEqual([]);
  });

  test('a directory that is not acceptable starts nothing', async () => {
    const outcome = await handlers().startSession('--no-auth', { args: ['--resume', CLAUDE_ID] });

    expect(outcome.ok).toBe(false);
    expect(spawns).toEqual([]);
  });

  test('no free port is a refusal that names the range', async () => {
    const outcome = await handlers({ port: null }).startSession(dir, undefined);

    expect(outcome.ok).toBe(false);
    expect((outcome as { error: string }).error).toContain('20000-20009');
  });

  test('a spawn that fails is the generic text, never the cause', async () => {
    spawnError = new Error('spawn /home/someone/bin/remi ENOENT');

    const outcome = await handlers().startSession(dir, undefined);

    expect(outcome).toEqual({
      ok: false,
      error: "The session could not be started on the host; the host's remi log has the reason.",
    });
  });

  test('a create request answers with the same outcome', async () => {
    await handlers().onCreateSessionRequest(CID, dir, REQ, { args: ['--resume', CLAUDE_ID] });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'create_session_response',
      success: true,
      requestId: REQ,
      sessionId: CHILD,
      port: 20005,
    });
  });
});
