/**
 * The workspace fields of `create_session_request` and `create_session_response` (#1236,
 * ADR 0036), as the shipping factories build them.
 */

import { describe, expect, test } from 'bun:test';
import { createCreateSessionRequest, createCreateSessionResponse } from '../src/protocol.ts';
import type { UUID } from '../src/types.ts';

describe('workspaces on the wire (#1236)', () => {
  test('a request carries the workspace it is given, and none otherwise', () => {
    const workspace = { repository: '/r', worktree: { branch: 'b', base: 'main' } };
    expect(createCreateSessionRequest('/r', { workspace }).workspace).toEqual(workspace);
    expect('workspace' in createCreateSessionRequest('/r')).toBe(false);
  });

  test('a response carries the workspace it is given, and none otherwise', () => {
    const workspace = {
      repository: '/r',
      directory: '/remi-worktrees/r-b',
      worktree: { branch: 'b', base: 'abc' },
    };
    const id = '00000000-0000-4000-8000-000000000000' as UUID;
    expect(
      createCreateSessionResponse(true, id, id, undefined, 1, undefined, workspace).workspace,
    ).toEqual(workspace);
    expect('workspace' in createCreateSessionResponse(true, id, id, undefined, 1)).toBe(false);
  });
});
