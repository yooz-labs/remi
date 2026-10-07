/**
 * The protocol version and capabilities on `hello_ack` (#1237, ADR 0035): every
 * ack carries them, and `hubSupport` says whether a machine can do what a client
 * needs, and which side to update when it cannot.
 */

import { describe, expect, test } from 'bun:test';
import { PROTOCOL_CAPABILITIES, PROTOCOL_VERSION, hubSupport } from '../src/protocol-version.ts';
import { createHelloAck } from '../src/protocol.ts';

describe('every hello_ack names its protocol version and capabilities (#1237)', () => {
  test('createHelloAck stamps the protocol version itself', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(createHelloAck('1.0.0', null).protocolVersion).toBe(PROTOCOL_VERSION);
    expect(createHelloAck('1.0.0', null, { capabilities: ['x'] }).protocolVersion).toBe(1);
  });

  test('an ack lists the capabilities it is given, and none when given none', () => {
    expect(createHelloAck('1.0.0', null).capabilities).toEqual([]);
    expect(createHelloAck('1.0.0', null, { capabilities: ['a', 'b'] }).capabilities).toEqual([
      'a',
      'b',
    ]);
  });

  test('the registry starts empty: what predates #1237 is the baseline of version 1', () => {
    expect(Object.keys(PROTOCOL_CAPABILITIES)).toEqual([]);
  });
});

describe('hubSupport (#1237)', () => {
  const current = { protocolVersion: 1, capabilities: [], daemonVersion: '0.7.17' };
  const legacy = { daemonVersion: '0.7.16' };

  test('a current machine supports a client that needs nothing more', () => {
    expect(hubSupport(current)).toEqual({ supported: true });
  });

  test('an older machine (no protocol version) supports a client that needs no capability', () => {
    expect(hubSupport(legacy)).toEqual({ supported: true });
    expect(hubSupport({})).toEqual({ supported: true });
  });

  test('an older machine cannot have a capability, and the message says to update it', () => {
    expect(hubSupport(legacy, ['example.feature'])).toEqual({
      supported: false,
      reason: 'capabilities',
      missing: ['example.feature'],
      message: "This machine's remi (0.7.16) cannot example.feature. Update remi on that machine.",
    });
  });

  test('a capability the machine lists is supported; one it does not list is named', () => {
    const ack = { ...current, capabilities: ['a', 'c'] };
    expect(hubSupport(ack, ['a', 'c'])).toEqual({ supported: true });
    const result = hubSupport(ack, ['a', 'b', 'b', 'd']);
    expect(result).toMatchObject({ supported: false, reason: 'capabilities', missing: ['b', 'd'] });
    expect(result.supported === false && result.message).toBe(
      "This machine's remi (0.7.17) cannot b; d. Update remi on that machine.",
    );
  });

  test('names the client does not know are ignored, so a newer daemon cannot break it', () => {
    expect(hubSupport({ ...current, capabilities: ['from.the.future', 7, null] })).toEqual({
      supported: true,
    });
  });

  test('a capabilities field that is not a list counts as none', () => {
    for (const capabilities of ['a', { a: true }, null, 3]) {
      expect(hubSupport({ ...current, capabilities }, ['a'])).toMatchObject({
        supported: false,
        missing: ['a'],
      });
    }
  });

  test('a capability name is looked up as the registry own key, never an inherited one', () => {
    const result = hubSupport(current, ['constructor', 'toString']);
    expect(result.supported === false && result.message).toBe(
      "This machine's remi (0.7.17) cannot constructor; toString. Update remi on that machine.",
    );
  });

  test('a newer protocol version is refused, and the app is the side to update', () => {
    expect(hubSupport({ ...current, protocolVersion: 2 })).toEqual({
      supported: false,
      reason: 'protocol-version',
      missing: [],
      message:
        "This machine's remi (0.7.17) speaks protocol version 2, and this app speaks version 1. Update this app.",
    });
  });

  test('an older protocol version is refused, and the machine is the side to update', () => {
    expect(hubSupport(current, [], 2)).toEqual({
      supported: false,
      reason: 'protocol-version',
      missing: [],
      message:
        "This machine's remi (0.7.17) speaks protocol version 1, and this app speaks version 2. Update remi on that machine.",
    });
  });

  test('an ack without a version is version 1: a client on another version refuses it (#1269 review)', () => {
    expect(hubSupport(legacy, [], 2)).toEqual({
      supported: false,
      reason: 'protocol-version',
      missing: [],
      message:
        "This machine's remi (0.7.16) speaks protocol version 1, and this app speaks version 2. Update remi on that machine and restart it.",
    });
    expect(hubSupport(legacy, [], 1)).toEqual({ supported: true });
  });

  test('a version that is not a positive integer is refused as unreadable', () => {
    for (const protocolVersion of ['1', 0, -1, 1.5, Number.NaN, null, true, [1]]) {
      expect(hubSupport({ ...current, protocolVersion })).toEqual({
        supported: false,
        reason: 'protocol-version',
        missing: [],
        message:
          "This machine's remi (0.7.17) sent a protocol version this app cannot read. Update remi on that machine and this app.",
      });
    }
  });

  test('the version check comes before the capabilities', () => {
    expect(hubSupport({ protocolVersion: 2 }, ['a'])).toMatchObject({ reason: 'protocol-version' });
  });

  describe('the daemon version in a message', () => {
    const message = (daemonVersion: unknown) => {
      const result = hubSupport({ daemonVersion }, ['a']);
      return result.supported ? '' : result.message;
    };

    test('is left out when absent, empty or not text', () => {
      for (const daemonVersion of [undefined, '', 7, null]) {
        expect(message(daemonVersion)).toBe(
          "This machine's remi cannot a. Update remi on that machine.",
        );
      }
    });

    test('is escaped, newline and tab included: the daemon chose it, and a message is one line', () => {
      expect(message('0.7.17‮evil\n')).toBe(
        "This machine's remi (0.7.17\\u202Eevil\\u000A) cannot a. Update remi on that machine.",
      );
      expect(message('0.7\t17')).toBe(
        "This machine's remi (0.7\\u000917) cannot a. Update remi on that machine.",
      );
    });

    test('is cut at 40 code points, before escaping, never inside a surrogate pair', () => {
      const long = `${'9'.repeat(39)}\u{1F600}tail`;
      expect(message(long)).toBe(
        `This machine's remi (${'9'.repeat(39)}\u{1F600}...) cannot a. Update remi on that machine.`,
      );
      expect(message('8'.repeat(40))).toBe(
        `This machine's remi (${'8'.repeat(40)}) cannot a. Update remi on that machine.`,
      );
    });
  });
});
