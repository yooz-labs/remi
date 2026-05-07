import { describe, expect, test } from 'bun:test';
import { resolvePushAnswerTarget } from '../../src/lib/push-answer-resolver';

const session = (id: string, connectionId: string | null = null) => ({ id, connectionId });
const conn = (
  connectionId: string,
  url: string,
  status:
    | 'connected'
    | 'connecting'
    | 'authenticating'
    | 'reconnecting'
    | 'disconnected'
    | 'error',
) => ({ connectionId, url, status }) as const;

describe('resolvePushAnswerTarget (#278)', () => {
  test('live connection — answer goes straight through', () => {
    expect(
      resolvePushAnswerTarget({
        sessionId: 's1',
        sessions: [session('s1', 'c1')],
        connections: [conn('c1', 'ws://daemon-a/ws', 'connected')],
        storedUrls: [],
      }),
    ).toEqual({ kind: 'live', connectionId: 'c1', url: 'ws://daemon-a/ws' });
  });

  test('multi-daemon: routes to the connection that owns the session, not just any live one', () => {
    // Two attached daemons; the question came from daemon B. The answer
    // must NOT go to daemon A's WebSocket.
    expect(
      resolvePushAnswerTarget({
        sessionId: 's2',
        sessions: [session('s1', 'c-A'), session('s2', 'c-B')],
        connections: [
          conn('c-A', 'ws://daemon-a/ws', 'connected'),
          conn('c-B', 'ws://daemon-b/ws', 'connected'),
        ],
        storedUrls: [],
      }),
    ).toEqual({ kind: 'live', connectionId: 'c-B', url: 'ws://daemon-b/ws' });
  });

  test('connection known but down — reconnect to its URL', () => {
    expect(
      resolvePushAnswerTarget({
        sessionId: 's1',
        sessions: [session('s1', 'c1')],
        connections: [conn('c1', 'ws://daemon-a/ws', 'disconnected')],
        storedUrls: ['ws://daemon-z/ws'],
      }),
    ).toEqual({ kind: 'reconnect', url: 'ws://daemon-a/ws' });
  });

  test('connection in-flight — caller should poll the existing attempt instead of starting another', () => {
    // The auto-reconnect-on-mount may already be reaching the same URL; the
    // resolver picks that connection so the caller does not race a new one.
    expect(
      resolvePushAnswerTarget({
        sessionId: 's1',
        sessions: [session('s1', 'c1')],
        connections: [
          conn('c1', 'ws://daemon-a/ws', 'disconnected'),
          conn('c2', 'ws://daemon-a/ws', 'connecting'),
        ],
        storedUrls: [],
      }),
    ).toEqual({ kind: 'pending', connectionId: 'c2', url: 'ws://daemon-a/ws' });
  });

  test('cold start: no session in memory — fall back to first localStorage URL', () => {
    // App was suspended; lock-screen tap brought it back; sessions list is
    // empty until reconnect. localStorage holds the URLs we were attached to.
    expect(
      resolvePushAnswerTarget({
        sessionId: 's-unknown',
        sessions: [],
        connections: [],
        storedUrls: ['ws://daemon-a/ws', 'ws://daemon-b/ws'],
      }),
    ).toEqual({ kind: 'reconnect', url: 'ws://daemon-a/ws' });
  });

  test('cold start: localStorage url already mid-connect — reuse the in-flight attempt', () => {
    expect(
      resolvePushAnswerTarget({
        sessionId: 's-unknown',
        sessions: [],
        connections: [conn('c-boot', 'ws://daemon-a/ws', 'authenticating')],
        storedUrls: ['ws://daemon-a/ws'],
      }),
    ).toEqual({ kind: 'pending', connectionId: 'c-boot', url: 'ws://daemon-a/ws' });
  });

  test('unreachable: nothing live, nothing stored — caller surfaces a "open the app" notification', () => {
    expect(
      resolvePushAnswerTarget({
        sessionId: 's-unknown',
        sessions: [],
        connections: [],
        storedUrls: [],
      }),
    ).toEqual({ kind: 'unreachable' });
  });

  test('session has connectionId but no matching connection record — fall through to cold-start path', () => {
    // The session list says we were attached, but the connection got pruned.
    // Without a URL to reconnect to and no localStorage, we are stuck.
    expect(
      resolvePushAnswerTarget({
        sessionId: 's1',
        sessions: [session('s1', 'c-stale')],
        connections: [],
        storedUrls: [],
      }),
    ).toEqual({ kind: 'unreachable' });
  });

  test('session has connectionId but no matching record — uses storedUrls fallback', () => {
    expect(
      resolvePushAnswerTarget({
        sessionId: 's1',
        sessions: [session('s1', 'c-stale')],
        connections: [],
        storedUrls: ['ws://daemon-a/ws'],
      }),
    ).toEqual({ kind: 'reconnect', url: 'ws://daemon-a/ws' });
  });

  describe('cold-start sessionUrlMap (PR #389 fix)', () => {
    test('sessionUrlMap[sessionId] wins over storedUrls[0] for the right daemon', () => {
      // Multi-daemon user wakes from suspend with a push answer for s2 (last
      // seen on daemon-b). Without the per-session map, we would route to
      // storedUrls[0] (daemon-a) and silently answer the wrong session.
      expect(
        resolvePushAnswerTarget({
          sessionId: 's2',
          sessions: [],
          connections: [],
          storedUrls: ['ws://daemon-a/ws', 'ws://daemon-b/ws'],
          sessionUrlMap: { s2: 'ws://daemon-b/ws' },
        }),
      ).toEqual({ kind: 'reconnect', url: 'ws://daemon-b/ws' });
    });

    test('sessionUrlMap entry mid-connect — reuses the in-flight attempt', () => {
      expect(
        resolvePushAnswerTarget({
          sessionId: 's2',
          sessions: [],
          connections: [conn('c-boot', 'ws://daemon-b/ws', 'connecting')],
          storedUrls: ['ws://daemon-a/ws', 'ws://daemon-b/ws'],
          sessionUrlMap: { s2: 'ws://daemon-b/ws' },
        }),
      ).toEqual({ kind: 'pending', connectionId: 'c-boot', url: 'ws://daemon-b/ws' });
    });

    test('sessionUrlMap missing the requested sessionId — falls back to storedUrls[0]', () => {
      // s-other was never paired; the map has nothing useful so the legacy
      // cold-start fallback applies.
      expect(
        resolvePushAnswerTarget({
          sessionId: 's-other',
          sessions: [],
          connections: [],
          storedUrls: ['ws://daemon-a/ws'],
          sessionUrlMap: { s2: 'ws://daemon-b/ws' },
        }),
      ).toEqual({ kind: 'reconnect', url: 'ws://daemon-a/ws' });
    });

    test('sessionUrlMap entry not in storedUrls — still reconnects (daemon de-paired but session known)', () => {
      // The user removed daemon-b from their stored list but a push answer for
      // a session it served just arrived. Use the mapped URL anyway: declining
      // would silently misroute to daemon-a. The ensuing reconnect may fail;
      // that is preferable to delivering to the wrong daemon.
      expect(
        resolvePushAnswerTarget({
          sessionId: 's2',
          sessions: [],
          connections: [],
          storedUrls: ['ws://daemon-a/ws'],
          sessionUrlMap: { s2: 'ws://daemon-b/ws' },
        }),
      ).toEqual({ kind: 'reconnect', url: 'ws://daemon-b/ws' });
    });

    test('omitting sessionUrlMap behaves like the legacy cold-start path', () => {
      // Backwards-compat: callers that have not yet adopted the map should
      // see exactly the previous behavior.
      expect(
        resolvePushAnswerTarget({
          sessionId: 's-unknown',
          sessions: [],
          connections: [],
          storedUrls: ['ws://daemon-a/ws'],
        }),
      ).toEqual({ kind: 'reconnect', url: 'ws://daemon-a/ws' });
    });
  });
});
