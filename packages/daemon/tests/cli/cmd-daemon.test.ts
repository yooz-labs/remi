import { describe, expect, test } from 'bun:test';
import { buildStartDaemonArgs } from '../../src/cli/cmd-daemon.ts';

describe('buildStartDaemonArgs', () => {
  test('returns an empty list for an empty options object', () => {
    expect(buildStartDaemonArgs({})).toEqual([]);
  });

  test('maps --bind when bindHost is provided', () => {
    expect(buildStartDaemonArgs({ bindHost: '0.0.0.0' })).toEqual(['--bind', '0.0.0.0']);
  });

  test('distinguishes auth true from auth false from auth undefined', () => {
    expect(buildStartDaemonArgs({ auth: true })).toEqual(['--auth']);
    expect(buildStartDaemonArgs({ auth: false })).toEqual(['--no-auth']);
    expect(buildStartDaemonArgs({})).toEqual([]);
  });

  test('adds the flag for each truthy boolean option', () => {
    expect(
      buildStartDaemonArgs({
        noMdns: true,
        noRelay: true,
        noTelegram: true,
        permanentCode: true,
      }),
    ).toEqual(['--no-mdns', '--no-relay', '--no-telegram', '--permanent-code']);
  });

  test('omits flags for falsy boolean options', () => {
    expect(
      buildStartDaemonArgs({
        noMdns: false,
        noRelay: false,
        noTelegram: false,
        permanentCode: false,
      }),
    ).toEqual([]);
  });

  test('maps signalingUrl and pushSecret', () => {
    expect(
      buildStartDaemonArgs({
        signalingUrl: 'wss://example.test/connect',
        pushSecret: 'shhh',
      }),
    ).toEqual(['--signaling-url', 'wss://example.test/connect', '--push-secret', 'shhh']);
  });

  test('stringifies orphanTimeout when present', () => {
    expect(buildStartDaemonArgs({ orphanTimeout: 300 })).toEqual(['--orphan-timeout', '300']);
  });

  test('accepts orphanTimeout of 0 (distinct from undefined)', () => {
    // `if (orphanTimeout !== undefined)` preserves the semantics of disabling
    // the orphan timer via 0; an `if (orphanTimeout)` bug would silently drop it.
    expect(buildStartDaemonArgs({ orphanTimeout: 0 })).toEqual(['--orphan-timeout', '0']);
  });

  test('emits flags in a stable order matching the old inline block', () => {
    const args = buildStartDaemonArgs({
      bindHost: '1.2.3.4',
      auth: true,
      noMdns: true,
      noRelay: true,
      noTelegram: true,
      permanentCode: true,
      signalingUrl: 'wss://x',
      pushSecret: 's',
      orphanTimeout: 60,
    });
    expect(args).toEqual([
      '--bind',
      '1.2.3.4',
      '--auth',
      '--no-mdns',
      '--no-relay',
      '--no-telegram',
      '--permanent-code',
      '--signaling-url',
      'wss://x',
      '--push-secret',
      's',
      '--orphan-timeout',
      '60',
    ]);
  });
});
