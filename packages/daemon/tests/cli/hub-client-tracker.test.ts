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

  test('a counting connect delivers exactly once, via the broadcast', () => {
    const { tracker, sent, broadcasts } = makeTracker();
    tracker.onConnect('c1' as UUID, wsMeta('127.0.0.1'));

    // Single delivery (#744 review): the broadcast already reaches the
    // connecting client on every transport, so no direct send happens.
    expect(sent).toHaveLength(0);
    expect(broadcasts).toHaveLength(1);
    const frame = asStatus(broadcasts[0]!);
    expect(frame.type).toBe('hub_status');
    expect(frame.localClients).toBe(1);
    expect(frame.remoteClients).toBe(0);
    expect(frame.hubVersion).toBe('9.9.9-test');
  });

  test('a non-counting connect delivers exactly once, via the direct send', () => {
    const { tracker, sent, broadcasts } = makeTracker();
    tracker.onConnect('c1' as UUID, wsMeta('127.0.0.1'));
    broadcasts.length = 0;

    tracker.onConnect('q1' as UUID, wsMeta('127.0.0.1', 'query'));
    expect(sent).toHaveLength(1); // the query client's own frame only
    expect(sent[0]?.connectionId).toBe('q1');
    expect(asStatus(sent[0]!.message).localClients).toBe(1);
    expect(broadcasts).toHaveLength(0); // counts unchanged -> no broadcast
  });

  test('cold start: a first excluded connect does not force a broadcast', () => {
    // lastEmitted is seeded with the real census at construction; a null
    // sentinel here used to make the very first connect always broadcast.
    const { tracker, sent, broadcasts } = makeTracker();
    tracker.onConnect('q1' as UUID, wsMeta('127.0.0.1', 'query'));
    expect(broadcasts).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.connectionId).toBe('q1');
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

  test('simultaneous clients aggregate across classes', () => {
    const { tracker, broadcasts } = makeTracker();
    tracker.onConnect('l1' as UUID, wsMeta('127.0.0.1'));
    tracker.onConnect('l2' as UUID, wsMeta('::1'));
    tracker.onConnect('r1' as UUID, wsMeta('192.168.1.20'));
    tracker.onConnect('q1' as UUID, wsMeta('127.0.0.1', 'query'));

    expect(tracker.counts()).toEqual({ localClients: 2, remoteClients: 1, sessions: 0 });
    const last = asStatus(broadcasts.at(-1) as ProtocolMessage);
    expect(last.localClients).toBe(2);
    expect(last.remoteClients).toBe(1);

    tracker.onDisconnect('l1' as UUID);
    expect(tracker.counts()).toEqual({ localClients: 1, remoteClients: 1, sessions: 0 });
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
