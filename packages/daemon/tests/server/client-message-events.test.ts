/**
 * Tests for the single client-to-daemon per-message event declaration
 * (#900, C7 of epic #883): `ClientMessageEventArgs`, the generic key list
 * that drives it, and the two forwarders (`pickClientMessageEvents`,
 * `bindConnectionId`) that replaced 13 hand-written per-event closures each
 * in `websocket-adapter.ts` and `websocket-server.ts`.
 *
 * `GOLDEN_KEYS` below is a hand-transcribed copy of the 13 event names,
 * deliberately NOT imported from `CLIENT_MESSAGE_EVENT_KEYS` -- the same
 * reason `protocol-registry.test.ts`'s `GOLDEN_TYPES` isn't derived from
 * `MESSAGE_DIRECTION`: a test that reads its expectation from the thing it's
 * checking can't fail when that thing is wrong.
 */
import { describe, expect, test } from 'bun:test';
import type { UUID } from '@remi/shared';
import { generateId } from '@remi/shared';
import {
  CLIENT_MESSAGE_EVENT_KEYS,
  type ClientMessageEventsWithConnectionId,
  bindConnectionId,
  pickClientMessageEvents,
} from '../../src/server/client-message-events.ts';

/** Hand-transcribed, verbatim, from the pre-#900 `ConnectionEvents` /
 *  `ServerEvents` / `AdapterEvents` per-message field names. */
const GOLDEN_KEYS = [
  'onUserInput',
  'onAnswer',
  'onBulletExpandRequest',
  'onSessionListRequest',
  'onTranscriptLoadRequest',
  'onCreateSessionRequest',
  'onTerminalResize',
  'onKillSessionRequest',
  'onResumeSessionRequest',
  'onSessionHistoryRequest',
  'onDetachSession',
  'onRegisterDeviceToken',
  'onUnregisterDeviceToken',
];

describe('CLIENT_MESSAGE_EVENT_KEYS', () => {
  test('has exactly 13 entries with no duplicates', () => {
    expect(CLIENT_MESSAGE_EVENT_KEYS.length).toBe(13);
    expect(new Set(CLIENT_MESSAGE_EVENT_KEYS).size).toBe(13);
  });

  test('is exactly the golden key set, no more, no fewer', () => {
    const actual: string[] = [...CLIENT_MESSAGE_EVENT_KEYS].sort();
    expect(actual).toEqual([...GOLDEN_KEYS].sort());
  });
});

describe('pickClientMessageEvents', () => {
  test('forwards every present client-message-event key unchanged', () => {
    const onUserInput = () => {};
    const onAnswer = () => {};
    const source: Partial<ClientMessageEventsWithConnectionId> = { onUserInput, onAnswer };

    const result = pickClientMessageEvents(source);

    expect(result.onUserInput).toBe(onUserInput);
    expect(result.onAnswer).toBe(onAnswer);
  });

  test('omits keys the source never set', () => {
    const result = pickClientMessageEvents({ onUserInput: () => {} });

    expect(Object.keys(result)).toEqual(['onUserInput']);
    for (const key of CLIENT_MESSAGE_EVENT_KEYS) {
      if (key !== 'onUserInput') {
        expect(result[key]).toBeUndefined();
      }
    }
  });

  test('does not leak non-client-message-event keys from the source', () => {
    // `source` stands in for a `Partial<ServerEvents>`, which also carries
    // onStart/onClientConnect/onError -- keys `AdapterEvents` doesn't share
    // the same signature for. A naive `{ ...source }` would carry them
    // through with the wrong shape; `pickClientMessageEvents` must not.
    const source = {
      onUserInput: () => {},
      onStart: (_port: number) => {},
      onClientConnect: () => {},
      onError: (_err: Error) => {},
    } as unknown as Partial<ClientMessageEventsWithConnectionId>;

    const result = pickClientMessageEvents(source);

    expect(Object.keys(result).sort()).toEqual(['onUserInput']);
  });

  test('round-trips every one of the 13 keys with connectionId-prefixed args intact', () => {
    for (const key of CLIENT_MESSAGE_EVENT_KEYS) {
      const calls: unknown[][] = [];
      const source: Partial<ClientMessageEventsWithConnectionId> = {
        [key]: (...args: unknown[]) => {
          calls.push(args);
        },
      } as Partial<ClientMessageEventsWithConnectionId>;

      const result = pickClientMessageEvents(source);
      const handler = result[key];
      expect(handler).toBeDefined();

      const connId = generateId();
      const sentinel = `sentinel-${key}`;
      // biome-ignore lint/suspicious/noExplicitAny: exercising the forwarder generically across all 13 differently-shaped handlers.
      (handler as any)(connId, sentinel);

      expect(calls).toEqual([[connId, sentinel]]);
    }
  });
});

describe('bindConnectionId', () => {
  test('prepends connectionId and forwards the rest of the args unchanged', () => {
    const calls: unknown[][] = [];
    const sink: Partial<ClientMessageEventsWithConnectionId> = {
      onUserInput: (...args: unknown[]) => {
        calls.push(args);
      },
    } as Partial<ClientMessageEventsWithConnectionId>;

    const connId = generateId();
    const bound = bindConnectionId(connId, sink);
    bound.onUserInput?.('session-1' as UUID, 'hello', true, undefined, undefined);

    expect(calls).toEqual([[connId, 'session-1', 'hello', true, undefined, undefined]]);
  });

  test('omits keys the sink never set', () => {
    const connId = generateId();
    const bound = bindConnectionId(connId, { onAnswer: () => {} });

    expect(Object.keys(bound)).toEqual(['onAnswer']);
    for (const key of CLIENT_MESSAGE_EVENT_KEYS) {
      if (key !== 'onAnswer') {
        expect(bound[key]).toBeUndefined();
      }
    }
  });

  test('binds every one of the 13 keys to the SAME connectionId', () => {
    for (const key of CLIENT_MESSAGE_EVENT_KEYS) {
      const calls: unknown[][] = [];
      const sink: Partial<ClientMessageEventsWithConnectionId> = {
        [key]: (...args: unknown[]) => {
          calls.push(args);
        },
      } as Partial<ClientMessageEventsWithConnectionId>;

      const connId = generateId();
      const bound = bindConnectionId(connId, sink);
      const handler = bound[key];
      expect(handler).toBeDefined();

      const sentinel = `sentinel-${key}`;
      // biome-ignore lint/suspicious/noExplicitAny: exercising the binder generically across all 13 differently-shaped handlers.
      (handler as any)(sentinel);

      expect(calls).toEqual([[connId, sentinel]]);
    }
  });

  test('two different connections never cross-contaminate the bound id', () => {
    const calls: Array<{ connId: UUID; sessionId: string }> = [];
    const sink: Partial<ClientMessageEventsWithConnectionId> = {
      onTerminalResize: (connId, cols, _rows) => {
        calls.push({ connId, sessionId: String(cols) });
      },
    };

    const connA = generateId();
    const connB = generateId();
    const boundA = bindConnectionId(connA, sink);
    const boundB = bindConnectionId(connB, sink);

    boundA.onTerminalResize?.(80, 24);
    boundB.onTerminalResize?.(100, 40);

    expect(calls).toEqual([
      { connId: connA, sessionId: '80' },
      { connId: connB, sessionId: '100' },
    ]);
  });
});
