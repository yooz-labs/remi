/** Attachment/routing checks construct the shipping controller; real relay/App checks are separate. */
import { afterEach, expect, test } from 'bun:test';
import {
  type BrowserLinkReceiverRequest,
  type DiscoverableSession,
  type HelloAckMessage,
  type ProtocolMessage,
  createError,
  createHelloAck,
  createKillSessionRequest,
  createKillSessionResponse,
  createSessionListResponse,
  createSessionRotated,
  deserialize,
  generateId,
  now,
  serialize,
} from '@remi/shared';
import { type RelayBrowserIdentity, RelayBrowserLinks } from '../../src/lib/relay-browser-links';

const owned: RelayBrowserLinks[] = [];
afterEach(() => {
  for (const controller of owned.splice(0)) controller.dispose();
});
const envelope = () => ({ id: generateId(), timestamp: now() });
function fixture() {
  let identity: RelayBrowserIdentity | null = {
    connection: {},
    generation: {},
    identityRevision: 1,
    identityKey: 'owned-public-key',
  };
  const sent: BrowserLinkReceiverRequest[] = [];
  const controller = new RelayBrowserLinks(
    {
      context: () => identity,
      send: (request) => {
        sent.push(request);
        return true;
      },
    },
    () => {},
  );
  owned.push(controller);
  const bindings = new Map<string, string>();
  const hello = (sessionId: string, overrides: Partial<HelloAckMessage> = {}) => {
    const binding = bindings.get(sessionId) ?? generateId();
    bindings.set(sessionId, binding);
    controller.receive({
      ...createHelloAck('fixture', sessionId, {
        capabilities: ['browser_links'],
        attachState: 'attached',
        binding: {
          identity: { harness: 'claude', harnessSessionId: binding },
          transcriptPath: null,
        },
      }),
      ...overrides,
    });
  };
  const receive = (message: ProtocolMessage) => {
    const actual = deserialize(serialize(message));
    expect(actual).not.toBeNull();
    if (!actual) throw new Error('Invalid control frame');
    return controller.receive(actual);
  };
  const phase = (sessionId: string) =>
    controller.states.find((s) => s.sessionId === sessionId)?.state.phase ?? 'unavailable';
  const candidates = (sessionId: string) =>
    controller.states.find((s) => s.sessionId === sessionId)?.state.candidates ?? [];
  const select = (sessionId: string) => {
    hello(sessionId);
    controller.receiveHere(sessionId);
    const request = sent.at(-1);
    if (!request || request.sessionId !== sessionId) throw new Error('Selection was not sent');
    const leaseId = generateId();
    receive({
      ...envelope(),
      type: 'browser_link_receiver_result',
      sessionId,
      requestId: request.id,
      seq: request.seq,
      outcome: 'selected',
      leaseId,
    });
    expect(phase(sessionId)).toBe('receiving');
    return { request, leaseId };
  };
  const candidate = (sessionId: string, leaseId: string, binding = bindings.get(sessionId)) => {
    if (!binding) throw new Error('No owned binding');
    const message = {
      ...envelope(),
      type: 'browser_link_candidate' as const,
      sessionId,
      binding: { harness: 'claude' as const, harnessSessionId: binding },
      leaseId,
      url: `https://example.test/${generateId()}`,
      lifetimeMs: 120000 as const,
    };
    receive(message);
    return message;
  };
  const list = (sessionId: string, changes: Partial<DiscoverableSession> = {}) =>
    receive(
      createSessionListResponse(
        [
          {
            sessionId,
            projectPath: '/owned',
            source: 'daemon',
            status: 'idle',
            lastActivity: now(),
            messageCount: 0,
            canAttach: true,
            canResume: false,
            harness: 'claude',
            harnessSessionId: bindings.get(sessionId),
            ...changes,
          },
        ],
        generateId(),
      ),
    );
  return {
    controller,
    sent,
    hello,
    receive,
    select,
    candidate,
    phase,
    candidates,
    list,
    identity: () => identity,
    setIdentity: (value: RelayBrowserIdentity | null) => {
      identity = value;
    },
  };
}

test('discovery and incomplete child hellos never establish browser authority', () => {
  const f = fixture();
  const id = generateId();
  f.list(id);
  f.controller.receiveHere(id);
  expect(f.sent).toHaveLength(0);
  for (const invalid of [
    { attachState: 'queued' as const },
    { capabilities: [] },
    { protocolVersion: 2 },
    { harness: 'codex' as const },
    { harnessSessionId: null, claudeSessionId: null },
  ]) {
    f.hello(id, invalid);
    f.controller.receiveHere(id);
    expect(f.phase(id)).toBe('unavailable');
    expect(f.sent).toHaveLength(0);
  }
  f.hello(id);
  expect(f.phase(id)).toBe('ready');
  expect(f.sent).toHaveLength(0);
});

test('two child sessions retain separate leases and refuse foreign candidates', () => {
  const f = fixture();
  const a = generateId();
  const b = generateId();
  const first = f.select(a);
  const second = f.select(b);
  f.candidate(a, second.leaseId);
  expect(f.candidates(a)).toHaveLength(0);
  f.candidate(a, first.leaseId, generateId());
  expect(f.candidates(a)).toHaveLength(0);
  f.candidate(a, first.leaseId);
  f.candidate(b, second.leaseId);
  expect(f.candidates(a)).toHaveLength(1);
  expect(f.candidates(b)).toHaveLength(1);
  expect(f.sent.map((r) => r.seq)).toEqual([1, 1]);
});

test('fresh hello retires old URLs and pending results but retains consumed sequence', () => {
  const f = fixture();
  const id = generateId();
  const first = f.select(id);
  f.candidate(id, first.leaseId);
  expect(f.candidates(id)).toHaveLength(1);
  f.hello(id);
  expect(f.phase(id)).toBe('ready');
  expect(f.candidates(id)).toHaveLength(0);
  f.receive({
    ...envelope(),
    type: 'browser_link_receiver_result',
    sessionId: id,
    requestId: first.request.id,
    seq: 1,
    outcome: 'selected',
    leaseId: first.leaseId,
  });
  expect(f.phase(id)).toBe('ready');
  f.controller.receiveHere(id);
  expect(f.sent.at(-1)?.seq).toBe(2);
});

test('a list can invalidate a binding but cannot restore it', () => {
  const f = fixture();
  const id = generateId();
  const selected = f.select(id);
  f.candidate(id, selected.leaseId);
  f.list(id, { harnessSessionId: generateId() });
  expect(f.phase(id)).toBe('unavailable');
  expect(f.candidates(id)).toHaveLength(0);
  f.list(id);
  expect(f.phase(id)).toBe('unavailable');
  f.hello(id);
  f.controller.receiveHere(id);
  expect(f.sent.at(-1)?.seq).toBe(2);
});

test('identity and channel loss clear URLs; new generation needs a new explicit selection', () => {
  const f = fixture();
  const id = generateId();
  const selected = f.select(id);
  f.candidate(id, selected.leaseId);
  const old = f.identity();
  if (!old) throw new Error('No fixture identity');
  f.setIdentity({ ...old, identityRevision: 2 });
  expect(f.phase(id)).toBe('unavailable');
  expect(f.candidates(id)).toHaveLength(0);
  f.setIdentity(null);
  f.controller.disconnect();
  f.setIdentity({ ...old, generation: {} });
  f.hello(id);
  expect(f.phase(id)).toBe('ready');
  expect(f.sent).toHaveLength(1);
  f.controller.receiveHere(id);
  expect(f.sent.at(-1)?.seq).toBe(1);
});

test('observed identity loss cannot recover an attachment without a fresh child hello', () => {
  const f = fixture();
  const id = generateId();
  const selected = f.select(id);
  f.candidate(id, selected.leaseId);
  const old = f.identity();
  f.setIdentity(null);
  expect(f.phase(id)).toBe('unavailable');
  f.setIdentity(old);
  expect(f.phase(id)).toBe('unavailable');
  f.candidate(id, selected.leaseId);
  expect(f.candidates(id)).toHaveLength(0);
  f.hello(id);
  expect(f.phase(id)).toBe('ready');
  expect(f.sent).toHaveLength(1);
  f.controller.receiveHere(id);
  expect(f.sent.at(-1)?.seq).toBe(2);
});

test('detach clears the lease while a successful own stop stays authoritative across hellos', () => {
  const f = fixture();
  const id = generateId();
  const selected = f.select(id);
  f.candidate(id, selected.leaseId);
  f.receive({ ...envelope(), type: 'detach_session_ack', sessionId: id, success: true });
  expect(f.phase(id)).toBe('unavailable');
  expect(f.candidates(id)).toHaveLength(0);
  f.hello(id);
  f.controller.receiveHere(id);
  expect(f.sent.at(-1)?.seq).toBe(2);
  const kill = createKillSessionRequest(id);
  f.controller.beforeSend(kill);
  f.hello(id);
  f.receive(createKillSessionResponse(true, kill.id));
  f.hello(id);
  expect(f.phase(id)).toBe('unavailable');
  expect(f.candidates(id)).toHaveLength(0);
});

test('saturated own-stop correlation retires every affected session without evicting ownership', () => {
  const f = fixture();
  const ids = Array.from({ length: 10 }, () => generateId());
  for (const id of ids) f.select(id);
  for (const id of ids.slice(0, 9)) f.controller.beforeSend(createKillSessionRequest(id));
  for (const id of ids.slice(0, 9)) {
    f.hello(id);
    expect(f.phase(id)).toBe('unavailable');
  }
  expect(f.phase(ids[9] ?? '')).toBe('receiving');
});

test('an unscoped legacy session-ended notice clears URLs without guessing a session', () => {
  const f = fixture();
  const a = generateId();
  const b = generateId();
  const first = f.select(a);
  const second = f.select(b);
  f.candidate(a, first.leaseId);
  f.candidate(b, second.leaseId);
  f.receive(createError('SESSION_ENDED', 'Session ended by request'));
  expect(f.phase(a)).toBe('unavailable');
  expect(f.phase(b)).toBe('unavailable');
  expect(f.candidates(a)).toHaveLength(0);
  expect(f.candidates(b)).toHaveLength(0);
  f.hello(b);
  expect(f.phase(b)).toBe('ready');
  expect(f.sent).toHaveLength(2);
  f.controller.receiveHere(b);
  expect(f.sent.at(-1)?.seq).toBe(2);
});

test('bounded child records do not evict a consumed sequence to admit another session', () => {
  const f = fixture();
  const first = generateId();
  f.select(first);
  for (let i = 1; i < 64; i++) f.hello(generateId());
  const extra = generateId();
  f.hello(extra);
  expect(f.phase(extra)).toBe('unavailable');
  expect(f.controller.states).toHaveLength(64);
  f.hello(first);
  f.controller.receiveHere(first);
  expect(f.sent.at(-1)?.seq).toBe(2);
});

test('a fresh channel reclaims bounded records and saturated-stop tombstones', () => {
  const f = fixture();
  const ids = Array.from({ length: 64 }, () => generateId());
  for (const id of ids) f.hello(id);
  for (const id of ids.slice(0, 9)) f.controller.beforeSend(createKillSessionRequest(id));
  const saturated = ids[0]!;
  f.hello(saturated);
  expect(f.phase(saturated)).toBe('unavailable');
  f.controller.disconnect();
  f.hello(saturated);
  expect(f.phase(saturated)).toBe('unavailable');
  const old = f.identity();
  if (!old) throw new Error('No fixture identity');
  f.setIdentity({ ...old, generation: {} });
  const fresh = generateId();
  f.hello(fresh);
  expect(f.phase(fresh)).toBe('ready');
  expect(f.controller.states).toHaveLength(1);
  f.hello(saturated);
  expect(f.phase(saturated)).toBe('ready');
  expect(f.sent).toHaveLength(0);
  f.controller.receiveHere(saturated);
  expect(f.sent.at(-1)?.seq).toBe(1);
});

test('authoritative rotation retires only its session until a fresh child hello', () => {
  const f = fixture();
  const a = generateId(),
    b = generateId();
  const first = f.select(a),
    second = f.select(b);
  f.candidate(a, first.leaseId);
  f.candidate(b, second.leaseId);
  f.receive(createSessionRotated(a, generateId(), '/owned/new-transcript.jsonl'));
  expect(f.phase(a)).toBe('unavailable');
  expect(f.candidates(a)).toHaveLength(0);
  expect(f.phase(b)).toBe('receiving');
  expect(f.candidates(b)).toHaveLength(1);
  f.controller.receiveHere(a);
  expect(f.sent).toHaveLength(2);
  f.hello(a);
  f.controller.receiveHere(a);
  expect(f.sent.at(-1)?.seq).toBe(2);
});
