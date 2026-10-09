/**
 * `createSessionExtra` is what `connection.ts` hands the create handler, for a direct WebSocket
 * and for the relay hub's virtual connection alike (the v1 `relay-adapter.ts` is gone on the relay
 * epic), so a field it drops is dropped on every path: the workspace (#1236) is forwarded
 * with the harness and arguments (#1179), as the peer sent it, and a plain request still reads as
 * undefined.
 */

import { describe, expect, test } from 'bun:test';
import { createCreateSessionRequest } from '@remi/shared';
import { createSessionExtra } from '../../src/server/client-message-events.ts';

describe('createSessionExtra (#1179, #1236)', () => {
  test('a plain request has no extra', () => {
    expect(createSessionExtra(createCreateSessionRequest('/p'))).toBeUndefined();
  });

  test('a workspace is forwarded as sent, alone or with a harness and arguments', () => {
    const workspace = { repository: '/p', worktree: { branch: 'b' } };
    expect(createSessionExtra(createCreateSessionRequest('/p', { workspace }))).toEqual({
      harness: undefined,
      args: undefined,
      workspace,
    });
    expect(
      createSessionExtra(
        createCreateSessionRequest('/p', { harness: 'codex', args: ['-m', 'x'], workspace }),
      ),
    ).toEqual({ harness: 'codex', args: ['-m', 'x'], workspace });
  });

  test('a workspace that is not an object is still forwarded, for the handler to refuse', () => {
    const message = { ...createCreateSessionRequest('/p'), workspace: 'not-an-object' };
    expect(createSessionExtra(message as never)?.workspace).toBe('not-an-object');
  });
});
