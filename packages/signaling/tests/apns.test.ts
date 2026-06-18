/**
 * Tests for the APNS request builder (#575, P4a).
 *
 * `buildApnsRequest` is a pure function (URL + headers + JSON body), so the
 * payload shape is asserted directly — no network, no mocks. These cover the
 * P4a additions: `content-available: 1` pre-wake and the `apns-collapse-id`
 * header keyed by questionId, while confirming the interactive alert stays
 * well-formed.
 */

import { describe, expect, test } from 'bun:test';
import { buildApnsRequest } from '../src/apns.ts';

const BASE = {
  token: 'device-token-abc',
  title: 'remi-phase4 needs input',
  body: 'Allow Bash: git push',
  bundleId: 'live.yooz.remi',
};

function parseBody(body: string): {
  aps: {
    alert?: { title?: string; body?: string };
    sound?: string;
    badge?: number;
    'content-available'?: number;
    category?: string;
  };
  [key: string]: unknown;
} {
  return JSON.parse(body);
}

describe('buildApnsRequest (#575 P4a)', () => {
  test('includes content-available: 1 for background pre-wake', () => {
    const req = buildApnsRequest(BASE, 'jwt-token');
    const payload = parseBody(req.body);
    expect(payload.aps['content-available']).toBe(1);
  });

  test('keeps the interactive alert well-formed alongside content-available', () => {
    const req = buildApnsRequest({ ...BASE, category: 'REMI_YNA' }, 'jwt-token');
    const payload = parseBody(req.body);
    expect(payload.aps.alert?.title).toBe(BASE.title);
    expect(payload.aps.alert?.body).toBe(BASE.body);
    expect(payload.aps.sound).toBe('default');
    expect(payload.aps.badge).toBe(1);
    expect(payload.aps.category).toBe('REMI_YNA');
    // content-available coexists with the alert (not a silent push).
    expect(payload.aps['content-available']).toBe(1);
  });

  test('sets apns-collapse-id header from the collapseId (questionId)', () => {
    const req = buildApnsRequest({ ...BASE, collapseId: 'question-uuid-1234' }, 'jwt-token');
    expect(req.headers['apns-collapse-id']).toBe('question-uuid-1234');
  });

  test('omits apns-collapse-id when no collapseId is provided', () => {
    const req = buildApnsRequest(BASE, 'jwt-token');
    expect(req.headers['apns-collapse-id']).toBeUndefined();
  });

  test('truncates a collapseId longer than 64 bytes (APNS limit)', () => {
    const longId = 'x'.repeat(100);
    const req = buildApnsRequest({ ...BASE, collapseId: longId }, 'jwt-token');
    expect(req.headers['apns-collapse-id']).toHaveLength(64);
  });

  test('carries custom data fields (sessionId / opt_N) as siblings to aps', () => {
    const req = buildApnsRequest(
      { ...BASE, data: { sessionId: 's1', questionId: 'q1', opt_0: 'Yes', opt_1: 'No' } },
      'jwt-token',
    );
    const payload = parseBody(req.body);
    expect(payload['sessionId']).toBe('s1');
    expect(payload['opt_0']).toBe('Yes');
    expect(payload['opt_1']).toBe('No');
    // Custom data does not clobber the aps dictionary.
    expect(payload.aps['content-available']).toBe(1);
  });

  test('throws if custom data tries to override the reserved aps key', () => {
    expect(() => buildApnsRequest({ ...BASE, data: { aps: 'malicious' } }, 'jwt-token')).toThrow(
      'reserved key "aps"',
    );
  });

  test('uses the production APNS host by default and sandbox when requested', () => {
    expect(buildApnsRequest(BASE, 'jwt').url).toContain('api.push.apple.com');
    expect(buildApnsRequest({ ...BASE, sandbox: true }, 'jwt').url).toContain(
      'api.sandbox.push.apple.com',
    );
  });

  test('always sets the standard APNS headers', () => {
    const req = buildApnsRequest(BASE, 'jwt-xyz');
    expect(req.headers['authorization']).toBe('bearer jwt-xyz');
    expect(req.headers['apns-topic']).toBe('live.yooz.remi');
    expect(req.headers['apns-push-type']).toBe('alert');
    expect(req.headers['apns-priority']).toBe('10');
  });
});
