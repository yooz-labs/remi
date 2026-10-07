/**
 * Black-box pins for who the daemon pushes to (#1258, #1254): the real
 * `cli.ts --daemon`, a fake claude, a recording signaling stand-in and device
 * tokens registered over the real WebSocket (`daemon-with-phone.ts`).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { heldPrompt, startWithPhone, stopAll } from './daemon-with-phone.ts';
import { pollUntil } from './hub-test-utils.ts';

afterEach(stopAll);

const MUTED = 'b'.repeat(64);
const WANTS = 'c'.repeat(64);
const STALE = 'd'.repeat(64);
const HOUR = 60 * 60 * 1000;

describe('the phone decides what it is pushed (#1258)', () => {
  test('a phone that muted questions gets no question push; one that did not, does', async () => {
    const r = await startWithPhone({
      register: [
        {
          token: MUTED,
          pushPrefs: {
            questions: false,
            turnComplete: true,
            harnessDenied: true,
            turnFailed: true,
          },
        },
        { token: WANTS },
      ],
    });
    // A held prompt is pushed by id at once, client attached or not.
    const response = heldPrompt(r);

    await pollUntil(
      () => r.pushes.some((p) => p.token === WANTS && p.kind === 'question'),
      8000,
      'the question push to the phone that wants it',
    );
    // Both fan-outs start together; give the muted one the same chance to arrive.
    await Bun.sleep(500);
    expect(r.pushes.filter((p) => p.token === MUTED && p.kind === 'question')).toEqual([]);
    void response;
  }, 60000);
});

describe('the push lease (#1254)', () => {
  test('a token whose phone has not been seen for longer than the lease is not pushed', async () => {
    const r = await startWithPhone({
      // Registered two days ago and never seen since; the default lease is 24 hours.
      seed: (remiDir) =>
        fs.writeFileSync(
          path.join(remiDir, 'device-tokens.json'),
          JSON.stringify({
            tokens: [
              {
                token: STALE,
                platform: 'ios',
                registeredAt: Date.now() - 48 * HOUR,
                connectionId: 'c0000000-0000-0000-0000-000000000000',
              },
            ],
            tombstones: [],
          }),
        ),
      register: [{ token: WANTS }],
    });
    const response = heldPrompt(r);

    await pollUntil(
      () => r.pushes.some((p) => p.token === WANTS && p.kind === 'question'),
      8000,
      'the question push to the phone that is connected',
    );
    await Bun.sleep(500);
    expect(r.pushes.filter((p) => p.token === STALE)).toEqual([]);
    void response;
  }, 60000);
});

describe('the lease is renewed while the phone stays connected (#1254)', () => {
  test('a phone connected for longer than the lease is still pushed', async () => {
    // A 7.2-second lease; the daemon renews a connected phone's lease well inside it.
    const r = await startWithPhone({
      seed: (remiDir) =>
        fs.writeFileSync(
          path.join(remiDir, 'config.toml'),
          '[notifications]\npush_lease_hours = 0.002\n',
        ),
      register: [{ token: WANTS }],
    });
    await Bun.sleep(10_000);

    const response = heldPrompt(r);

    await pollUntil(
      () => r.pushes.some((p) => p.token === WANTS && p.kind === 'question'),
      8000,
      'the question push to the phone that stayed connected',
    );
    void response;
  }, 60000);
});
