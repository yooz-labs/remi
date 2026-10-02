/**
 * End-to-end test for the hub resume guard (#1124).
 *
 * `remi serve` is a session-less supervisor and must NEVER run Claude in its
 * own process. A `resume_session_request` used to reach the shared resume
 * handler, which called `createNewSession(..., ['--resume', id])` inside the
 * hub; when that Claude exited the hub exited 0 and the LaunchAgent did not
 * restart it. Spawns the REAL cli.ts hub with an isolated $HOME and a fake
 * `claude` first on PATH that leaves a marker file if it is ever executed,
 * seeds a resumable stored session so the unguarded handler WOULD spawn it,
 * then asserts the hub refuses over the wire and stays up. No mocks.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createResumeSessionRequest, generateId, serialize } from '@remi/shared/protocol.ts';
import type { ProtocolMessage, ResumeSessionResponseMessage } from '@remi/shared/protocol.ts';
import { SessionStore } from '../../src/session/session-store.ts';
import {
  type HubHandle,
  cleanupHub,
  connectAndHello,
  makeIsolatedDirs,
  pollUntil,
  spawnHub,
} from './hub-test-utils.ts';

const hubs: HubHandle[] = [];

afterEach(async () => {
  for (const hub of hubs.splice(0)) {
    await cleanupHub(hub);
  }
});

const CLAUDE_SESSION_ID = '11111111-2222-4333-8444-555555555555';

function resumeResponse(received: ProtocolMessage[]): ResumeSessionResponseMessage | undefined {
  return received.find(
    (m): m is ResumeSessionResponseMessage => m.type === 'resume_session_response',
  );
}

describe('remi serve resume guard (integration, #1124)', () => {
  test('a resume request is refused with a typed error and never runs Claude in the hub', async () => {
    const dirs = makeIsolatedDirs();
    const marker = path.join(dirs.home, 'claude-ran.txt');
    const fakeBin = path.join(dirs.home, 'fake-bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    const fakeClaude = path.join(fakeBin, 'claude');
    fs.writeFileSync(fakeClaude, `#!/bin/sh\nprintf '%s\\n' "$*" > "${marker}"\nsleep 30\n`);
    fs.chmodSync(fakeClaude, 0o755);

    const hub = await spawnHub(dirs, { PATH: `${fakeBin}:${process.env['PATH'] ?? ''}` });
    hubs.push(hub);

    // A stored, resumable session whose project directory exists: with no
    // guard the shared handler resolves it and spawns `claude --resume <id>`
    // inside the hub process.
    const remiSessionId = generateId();
    new SessionStore(path.join(hub.home, '.remi', 'sessions.json')).save({
      remiSessionId,
      claudeSessionId: CLAUDE_SESSION_ID,
      projectPath: hub.work,
      port: 0,
      pid: null,
      startedAt: new Date().toISOString(),
      exitedAt: new Date().toISOString(),
      exitCode: 0,
    });

    const { ws, received } = await connectAndHello(hub.port);
    const request = createResumeSessionRequest(remiSessionId);
    ws.send(serialize(request));
    await pollUntil(() => resumeResponse(received) !== undefined, 8000, 'resume_session_response');

    const response = resumeResponse(received);
    expect(response?.success).toBe(false);
    expect(response?.requestId).toBe(request.id);
    expect(response?.sessionId).toBeUndefined();
    expect(response?.errorCode).toBe('UNSUPPORTED');
    expect(response?.error).toContain('hub');

    // Give an (unwanted) spawn time to show itself, then prove nothing ran.
    await new Promise((r) => setTimeout(r, 1000));
    expect(fs.existsSync(marker)).toBe(false);
    expect(hub.proc.exitCode).toBeNull();
    expect(fs.existsSync(path.join(hub.work, '.claude'))).toBe(false);
    const liveDir = path.join(hub.home, '.remi', 'live-sessions');
    expect(fs.existsSync(liveDir) ? fs.readdirSync(liveDir) : []).toEqual([]);

    // The hub is still serving: a second request is answered the same way.
    received.length = 0;
    ws.send(serialize(createResumeSessionRequest(CLAUDE_SESSION_ID)));
    await pollUntil(() => resumeResponse(received) !== undefined, 8000, 'second response');
    expect(resumeResponse(received)?.errorCode).toBe('UNSUPPORTED');
    expect(fs.existsSync(marker)).toBe(false);

    ws.close();
  }, 40000);
});
