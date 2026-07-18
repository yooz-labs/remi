/**
 * Unit tests for the hub client census (#650): peer classification and the
 * emit-on-change semantics behind the `hub_status` broadcast. Deps are plain
 * closures capturing real message arrays — dependency injection, no mocks.
 */

import { describe, expect, test } from 'bun:test';
import type { HubPendingQuestion, HubStatusMessage, ProtocolMessage, UUID } from '@remi/shared';
import type { AdapterMetadata } from '../../src/adapters/index.ts';
import { HubClientTracker, classifyClient } from '../../src/cli/hub-client-tracker.ts';
import type { HubQuestionCensus } from '../../src/cli/hub-question-census.ts';

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

function makeQuestion(overrides: Partial<HubPendingQuestion> = {}): HubPendingQuestion {
  return {
    id: 'q-1',
    sessionId: 's-1',
    sessionName: 'host:project/main',
    label: 'Permission: Bash',
    createdAt: '2026-07-17T00:00:00.000Z',
    ...overrides,
  };
}

describe('HubClientTracker (#650, #786/#787)', () => {
  function makeTracker(initialSessions = 0, initialQuestions: HubPendingQuestion[] = []) {
    const sent: Array<{ connectionId: UUID; message: ProtocolMessage }> = [];
    const broadcasts: ProtocolMessage[] = [];
    let census: HubQuestionCensus = { sessions: initialSessions, questions: initialQuestions };
    const tracker = new HubClientTracker({
      send: (connectionId, message) => sent.push({ connectionId, message }),
      broadcast: (message) => broadcasts.push(message),
      getCensus: () => census,
      hubVersion: '9.9.9-test',
    });
    const setSessions = (n: number): void => {
      census = { ...census, sessions: n };
    };
    const setQuestions = (questions: HubPendingQuestion[]): void => {
      census = { ...census, questions };
    };
    return { tracker, sent, broadcasts, setSessions, setQuestions };
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

    expect(tracker.counts()).toEqual({
      localClients: 2,
      remoteClients: 1,
      sessions: 0,
      pendingQuestions: 0,
      questions: [],
    });
    const last = asStatus(broadcasts.at(-1) as ProtocolMessage);
    expect(last.localClients).toBe(2);
    expect(last.remoteClients).toBe(1);

    tracker.onDisconnect('l1' as UUID);
    expect(tracker.counts()).toEqual({
      localClients: 1,
      remoteClients: 1,
      sessions: 0,
      pendingQuestions: 0,
      questions: [],
    });
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

  test('cold start seeds the pending-question census too (no spurious first broadcast)', () => {
    const q = makeQuestion();
    const { tracker, broadcasts, sent } = makeTracker(1, [q]);
    tracker.onConnect('q1' as UUID, wsMeta('127.0.0.1', 'query'));
    expect(broadcasts).toHaveLength(0);
    const frame = asStatus(sent[0]!.message);
    expect(frame.pendingQuestions).toBe(1);
    expect(frame.questions).toEqual([q]);
  });

  test('refresh broadcasts a NEW question even when counts are unchanged', () => {
    const { tracker, broadcasts, setQuestions } = makeTracker(1, []);
    tracker.onConnect('c1' as UUID, wsMeta('127.0.0.1'));
    broadcasts.length = 0;

    setQuestions([makeQuestion({ id: 'q-new' })]);
    tracker.refresh();
    expect(broadcasts).toHaveLength(1);
    const frame = asStatus(broadcasts[0]!);
    expect(frame.pendingQuestions).toBe(1);
    expect(frame.questions).toEqual([makeQuestion({ id: 'q-new' })]);
  });

  test('refresh broadcasts when a question is answered (count drops to 0)', () => {
    const q = makeQuestion();
    const { tracker, broadcasts, setQuestions } = makeTracker(1, [q]);
    tracker.onConnect('c1' as UUID, wsMeta('127.0.0.1'));
    broadcasts.length = 0;

    setQuestions([]);
    tracker.refresh();
    expect(broadcasts).toHaveLength(1);
    expect(asStatus(broadcasts[0]!).pendingQuestions).toBe(0);
  });

  test('refresh broadcasts when the SET changes but the SIZE does not', () => {
    // One answered, a different one arrives in the same beat: pure count
    // comparison would miss this (both censuses have length 1).
    const { tracker, broadcasts, setQuestions } = makeTracker(1, [makeQuestion({ id: 'q-old' })]);
    tracker.onConnect('c1' as UUID, wsMeta('127.0.0.1'));
    broadcasts.length = 0;

    setQuestions([makeQuestion({ id: 'q-different' })]);
    tracker.refresh();
    expect(broadcasts).toHaveLength(1);
    expect(asStatus(broadcasts[0]!).questions?.[0]?.id).toBe('q-different');
  });

  test('refresh does NOT broadcast when the question set is unchanged, just reordered', () => {
    const a = makeQuestion({ id: 'q-a' });
    const b = makeQuestion({ id: 'q-b' });
    const { tracker, broadcasts, setQuestions } = makeTracker(1, [a, b]);
    tracker.onConnect('c1' as UUID, wsMeta('127.0.0.1'));
    broadcasts.length = 0;

    setQuestions([b, a]); // same ids, different order
    tracker.refresh();
    expect(broadcasts).toHaveLength(0);
  });
});
