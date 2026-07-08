/**
 * Unit tests for the hub client census (#650): peer classification and the
 * emit-on-change semantics behind the `hub_status` broadcast. Deps are plain
 * closures capturing real message arrays — dependency injection, no mocks.
 */

import { describe, expect, test } from 'bun:test';
import type { HubStatusMessage, ProtocolMessage, UUID } from '@remi/shared';
import type { AdapterMetadata } from '../../src/adapters/index.ts';
import { HubClientTracker, classifyClient } from '../../src/cli/hub-client-tracker.ts';

function wsMeta(peerAddress: string | null, mode?: 'query' | 'attach'): AdapterMetadata {
  return {
    adapterType: 'websocket',
    platformData: { kind: 'websocket', peerAddress, ...(mode !== undefined && { mode }) },
  };
}

describe('classifyClient (#650)', () => {
  test('loopback websocket peers are local', () => {
    expect(classifyClient(wsMeta('127.0.0.1'))).toBe('local');
    expect(classifyClient(wsMeta('127.0.0.53'))).toBe('local');
    expect(classifyClient(wsMeta('::1'))).toBe('local');
    expect(classifyClient(wsMeta('::ffff:127.0.0.1'))).toBe('local');
  });

  test('non-loopback and unknown websocket peers are remote (fail-visible)', () => {
    expect(classifyClient(wsMeta('192.168.1.5'))).toBe('remote');
    expect(classifyClient(wsMeta('fe80::1%en0'))).toBe('remote');
    expect(classifyClient(wsMeta(null))).toBe('remote');
  });

  test('query-mode clients are excluded even on loopback', () => {
    expect(classifyClient(wsMeta('127.0.0.1', 'query'))).toBe('excluded');
  });

  test('relay clients are remote by definition; telegram never counts', () => {
    expect(
      classifyClient({ adapterType: 'relay', platformData: { kind: 'relay', code: 'abc' } }),
    ).toBe('remote');
    expect(
      classifyClient({
        adapterType: 'telegram',
        platformData: { kind: 'telegram', chatId: 1, topicId: 1 },
      }),
    ).toBe('excluded');
    expect(classifyClient({ adapterType: 'websocket' })).toBe('excluded');
  });
});

describe('HubClientTracker (#650)', () => {
  function makeTracker(initialSessions = 0) {
    const sent: Array<{ connectionId: UUID; message: ProtocolMessage }> = [];
    const broadcasts: ProtocolMessage[] = [];
    let sessions = initialSessions;
    const tracker = new HubClientTracker({
      send: (connectionId, message) => sent.push({ connectionId, message }),
      broadcast: (message) => broadcasts.push(message),
      getSessions: () => sessions,
      hubVersion: '9.9.9-test',
    });
    const setSessions = (n: number): void => {
      sessions = n;
    };
    return { tracker, sent, broadcasts, setSessions };
  }

  const asStatus = (m: ProtocolMessage): HubStatusMessage => m as HubStatusMessage;

  test('connect sends the initial frame to that connection and broadcasts the change', () => {
    const { tracker, sent, broadcasts } = makeTracker();
    tracker.onConnect('c1' as UUID, wsMeta('127.0.0.1'));

    expect(sent).toHaveLength(1);
    expect(sent[0]?.connectionId).toBe('c1');
    const initial = asStatus(sent[0]!.message);
    expect(initial.type).toBe('hub_status');
    expect(initial.localClients).toBe(1);
    expect(initial.remoteClients).toBe(0);
    expect(initial.hubVersion).toBe('9.9.9-test');

    expect(broadcasts).toHaveLength(1);
    expect(asStatus(broadcasts[0]!).localClients).toBe(1);
  });

  test('a query client gets the frame but never changes the counts', () => {
    const { tracker, sent, broadcasts } = makeTracker();
    tracker.onConnect('c1' as UUID, wsMeta('127.0.0.1'));
    broadcasts.length = 0;

    tracker.onConnect('q1' as UUID, wsMeta('127.0.0.1', 'query'));
    expect(sent).toHaveLength(2); // initial frame still delivered
    expect(asStatus(sent[1]!.message).localClients).toBe(1);
    expect(broadcasts).toHaveLength(0); // counts unchanged -> no broadcast
  });

  test('disconnect broadcasts the decrement; unknown ids are no-ops', () => {
    const { tracker, broadcasts } = makeTracker();
    tracker.onConnect('c1' as UUID, wsMeta('10.0.0.7'));
    broadcasts.length = 0;

    tracker.onDisconnect('never-seen' as UUID);
    expect(broadcasts).toHaveLength(0);

    tracker.onDisconnect('c1' as UUID);
    expect(broadcasts).toHaveLength(1);
    expect(asStatus(broadcasts[0]!).remoteClients).toBe(0);
  });

  test('refresh broadcasts only when the session census changed', () => {
    const { tracker, broadcasts, setSessions } = makeTracker(1);
    tracker.onConnect('c1' as UUID, wsMeta('127.0.0.1'));
    broadcasts.length = 0;

    tracker.refresh();
    expect(broadcasts).toHaveLength(0); // nothing changed

    setSessions(2);
    tracker.refresh();
    expect(broadcasts).toHaveLength(1);
    expect(asStatus(broadcasts[0]!).sessions).toBe(2);
  });
});
