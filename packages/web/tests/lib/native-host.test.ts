/**
 * Native-shell hub handoff merge decision (#649): connect to the injected
 * hub URL only when the restored connections do not already cover it
 * (host-spelling aliases collapse through the injected toConnectionId).
 */

import { describe, expect, test } from 'bun:test';
import { nativeHubUrlToConnect } from '../../src/lib/native-host';

/** Simple id: host:port with localhost/127.0.0.1 collapsed, path ignored. */
function toId(url: string): string {
  const u = new URL(url.replace(/^ws/, 'http'));
  const host = u.hostname === 'localhost' ? '127.0.0.1' : u.hostname;
  return `${host}:${u.port}`;
}

describe('nativeHubUrlToConnect (#649)', () => {
  test('connects when the hub is not among restored connections', () => {
    expect(
      nativeHubUrlToConnect(
        ['ws://127.0.0.1:18766/ws'],
        { platform: 'macos-menubar', hubUrl: 'ws://127.0.0.1:18765/ws' },
        toId,
      ),
    ).toBe('ws://127.0.0.1:18765/ws');
  });

  test('no-op when already restored, including alias spellings', () => {
    expect(
      nativeHubUrlToConnect(
        ['ws://localhost:18765/ws'],
        { platform: 'macos-menubar', hubUrl: 'ws://127.0.0.1:18765/ws' },
        toId,
      ),
    ).toBeNull();
  });

  test('no-op outside the native shell or before discovery', () => {
    expect(nativeHubUrlToConnect([], undefined, toId)).toBeNull();
    expect(
      nativeHubUrlToConnect([], { platform: 'macos-menubar', hubUrl: null }, toId),
    ).toBeNull();
  });

  test('empty restored list still connects', () => {
    expect(
      nativeHubUrlToConnect(
        [],
        { platform: 'macos-menubar', hubUrl: 'ws://127.0.0.1:18770/ws' },
        toId,
      ),
    ).toBe('ws://127.0.0.1:18770/ws');
  });
});
