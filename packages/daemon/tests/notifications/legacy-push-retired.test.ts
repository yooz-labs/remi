/**
 * On a relay-paired machine the secure activation latch retires the plaintext sender for good
 * (#1200). That refusal is the machine's expected state, so the informational senders built on
 * the REAL `sendPushTrigger` report no failure for it, as the dispatcher already does; a real
 * failure (a refused request) is still reported.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UUID } from '@remi/shared';
import type { DeviceTokenEntry } from '../../src/cli/handlers/trivial-events.ts';
import { pushHarnessDenied } from '../../src/notifications/harness-denied.ts';
import { sendPushTrigger } from '../../src/notifications/push-client.ts';
import { createTurnEventSink } from '../../src/notifications/turn-events.ts';

const SID = 's0000000-0000-0000-0000-000000000000' as UUID;
const TOKEN = 'PRIVATE_TOKEN_SENTINEL';

let directory: string;
let server: ReturnType<typeof Bun.serve>;
let requests: number;
let status: number;
let errors: unknown[];
const tokens = (): DeviceTokenEntry[] => [
  { token: TOKEN, platform: 'ios', registeredAt: 1, connectionId: SID },
];
const settle = () => Bun.sleep(150);

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'remi-legacy-retired-'));
  chmodSync(directory, 0o700);
  requests = 0;
  status = 200;
  errors = [];
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      requests++;
      return new Response('{}', { status });
    },
  });
});
afterEach(async () => {
  await server.stop(true);
  rmSync(directory, { recursive: true, force: true });
});
function latch(): void {
  writeFileSync(
    join(directory, 'secure_push_activation.json'),
    JSON.stringify({ version: 1, activated: true }),
    { mode: 0o600 },
  );
}
function harnessDenied(): number {
  return pushHarnessDenied(
    {
      deviceTokens: tokens(),
      sessionId: SID,
      signalingUrl: server.url.origin,
      legacyEnabled: true,
      pushSecret: 'owned-secret',
      authorityDirectory: directory,
      sessionName: 'demo',
      send: sendPushTrigger,
      onError: (err) => errors.push(err),
    },
    { tool_name: 'Bash', tool_input: { command: 'ls' }, reason: 'blocked' },
  );
}
function turnCompleted(): void {
  createTurnEventSink({
    config: () => ({ onTurnComplete: true, turnCompleteMinSeconds: 0 }),
    deviceTokens: tokens,
    sessionName: () => 'demo',
    notifiers: new Map(),
    signalingUrl: () => server.url.origin,
    pushSecret: () => 'owned-secret',
    legacyPolicy: () => ({ legacyEnabled: true, authorityDirectory: directory }),
    send: sendPushTrigger,
    log: () => {},
    onError: (err) => errors.push(err),
  }).turnCompleted({
    sessionId: SID,
    elapsedMs: 120_000,
    lastAssistantMessage: 'done',
    reentry: false,
  });
}

describe('a retired plaintext channel is not a push failure (#1200)', () => {
  test('harness_denied on a latched machine sends nothing and reports no error', async () => {
    latch();
    expect(harnessDenied()).toBe(1);
    await settle();
    expect(requests).toBe(0);
    expect(errors, 'The latch is the expected state of a relay-paired machine').toEqual([]);
  });

  test('turn_complete on a latched machine sends nothing and reports no error', async () => {
    latch();
    turnCompleted();
    await settle();
    expect(requests).toBe(0);
    expect(errors).toEqual([]);
  });

  test('a refused legacy request is still reported', async () => {
    status = 400;
    expect(harnessDenied()).toBe(1);
    turnCompleted();
    await settle();
    expect(requests).toBe(2);
    expect(errors).toHaveLength(2);
  });
});
