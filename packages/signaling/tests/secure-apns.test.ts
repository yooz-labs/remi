/** Actual v2 request builder; oversized typed input is a defense-in-depth pin, not valid ingress. */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { relayV2 as r } from '@remi/shared';
import { buildSecureApnsRequest } from '../src/apns.ts';

const vectors = JSON.parse(
  readFileSync(
    new URL('../../shared/tests/fixtures/relay-v2/push-vectors.json', import.meta.url),
    'utf8',
  ),
) as { cases: { submitJson: string }[] };
const first = vectors.cases[0];
if (!first) throw new Error('public synthetic push vector missing');
const submit = r.decodePushSubmit(first.submitJson);

test('largest canonical carrier framing fits actual4096 APNs JSON without unsigned actions', () => {
  const maximum = r.decodePushSubmit(
    r.encodePushSubmit({
      ...submit,
      sealed: r.b64u(new Uint8Array(2141)),
      revision: Number.MAX_SAFE_INTEGER,
      keyVersion: Number.MAX_SAFE_INTEGER,
    }),
  );
  const built = buildSecureApnsRequest(maximum, 'owned.jwt', 'owned.topic');
  expect(new TextEncoder().encode(built.body).length).toBeLessThanOrEqual(4096);
  const body = JSON.parse(built.body);
  expect(Object.keys(body).sort()).toEqual(['aps', 'remiPush']);
  expect(body.aps.category).toBe('');
  expect(body.remiPush.sealed).toBe(maximum.sealed);
  expect(body).not.toHaveProperty('opt_0');
});
test('actual builder refuses oversized final JSON for invalid typed caller input rather than truncating', () => {
  // The strict ingress decoder already refuses this sealed size. This independently pins the final boundary.
  expect(() =>
    buildSecureApnsRequest({ ...submit, sealed: 'A'.repeat(4096) }, 'owned.jwt', 'owned.topic'),
  ).toThrow('OVERSIZE');
});
test('actual dismiss builder remains quiet and selects only the signed APNs environment', () => {
  const built = buildSecureApnsRequest(
    { ...submit, kind: 'dismiss', environment: 'production' },
    'owned.jwt',
    'owned.topic',
  );
  expect(JSON.parse(built.body).aps).toEqual({ 'content-available': 1 });
  expect(built.headers['apns-push-type']).toBe('background');
  expect(built.headers['apns-priority']).toBe('5');
  expect(built.url).toBe(`https://api.push.apple.com/3/device/${submit.token}`);
});
