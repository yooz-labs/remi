/**
 * Golden-equality safety net for the protocol message registry (#895).
 *
 * `ProtocolMessage` and `isValidMessage`'s `validTypes` allowlist are being
 * changed from two independently hand-written 45-entry lists into values
 * derived from `Object.keys(MESSAGE_DIRECTION)`. If that derivation ever
 * drops a type — a typo, a bad merge, a copy/paste slip while adding a new
 * message — `deserialize()` silently returns `null` for it repo-wide, and
 * nothing fails loudly (the daemon logs `INVALID_MESSAGE` and moves on).
 *
 * `GOLDEN_TYPES` below is the exact 45-entry `validTypes` array as it stood
 * in `packages/shared/src/protocol.ts` (lines 1005-1051) before the registry
 * was introduced, copied by hand from that array. It is intentionally NOT
 * derived from anything else in this codebase, so it cannot silently drift
 * alongside a bug in the derivation it's meant to catch.
 */
import { describe, expect, test } from 'bun:test';
import { MESSAGE_DIRECTION } from '../src/protocol.ts';

/** The exact `validTypes` array from `isValidMessage`, pre-#895, verbatim. */
const GOLDEN_TYPES = [
  'hello',
  'hello_ack',
  'agent_output',
  'structured_agent_output',
  'user_input',
  'ack',
  'edit',
  'question',
  'answer',
  'session_update',
  'ping',
  'pong',
  'error',
  'replay_batch',
  'bullet_expand_request',
  'bullet_expand_response',
  'session_list_request',
  'session_list_response',
  'transcript_content',
  'transcript_load_request',
  'transcript_load_complete',
  'create_session_request',
  'create_session_response',
  'terminal_resize',
  'auth_challenge',
  'auth_response',
  'auth_result',
  'kill_session_request',
  'kill_session_response',
  'raw_pty_output',
  'session_history_request',
  'session_history_response',
  'resume_session_request',
  'resume_session_response',
  'detach_session',
  'detach_session_ack',
  'register_device_token',
  'unregister_device_token',
  'daemon_update_available',
  'hub_status',
  'session_rotated',
  'session_views',
  'question_resolved',
  'remi_status',
  'question_snapshot',
] as const;

describe('protocol registry golden equality (#895)', () => {
  test('GOLDEN_TYPES has exactly 45 entries with no duplicates', () => {
    expect(GOLDEN_TYPES.length).toBe(45);
    expect(new Set(GOLDEN_TYPES).size).toBe(45);
  });

  test('MESSAGE_DIRECTION keys are exactly the golden 45 types, no more, no fewer', () => {
    const registryTypes = Object.keys(MESSAGE_DIRECTION).sort();
    const golden = [...GOLDEN_TYPES].sort();
    expect(registryTypes).toEqual(golden);
  });

  test('every MESSAGE_DIRECTION value is a real direction tag', () => {
    for (const [type, direction] of Object.entries(MESSAGE_DIRECTION)) {
      expect(['c2d', 'd2c', 'both']).toContain(direction);
      expect(GOLDEN_TYPES).toContain(type as (typeof GOLDEN_TYPES)[number]);
    }
  });

  /**
   * Types the daemon's inbound switch has a REAL accepting case for.
   *
   * Hand-transcribed from `packages/daemon/src/server/connection.ts`'s
   * `handleMessage` switch — deliberately not imported, for the same reason
   * `GOLDEN_TYPES` is not derived: a list generated from the thing it checks
   * cannot catch that thing being wrong.
   *
   * The rule this pins: a tag is derived from DISPATCH SITES, not from who
   * constructs the message. `ack` is the case that forced the distinction —
   * only the daemon builds one, but the router accepts one arriving from a
   * client, so it is 'both'. Tagging it 'd2c' would make this table disagree
   * with the daemon's own router once C6 (#899) uses it to gate inbound
   * traffic, and the symptom would be a legitimate message rejected as
   * UNKNOWN_MESSAGE.
   */
  const INBOUND_ROUTED = [
    'hello',
    'user_input',
    'answer',
    'bullet_expand_request',
    'session_list_request',
    'transcript_load_request',
    'create_session_request',
    'terminal_resize',
    'auth_response',
    'kill_session_request',
    'resume_session_request',
    'detach_session',
    'register_device_token',
    'unregister_device_token',
    'session_history_request',
    'ping',
    'pong',
    'ack',
  ] as const;

  test('every inbound-routed type is tagged c2d or both, never d2c', () => {
    for (const type of INBOUND_ROUTED) {
      const direction = MESSAGE_DIRECTION[type];
      expect({ type, direction }).toEqual({
        type,
        direction: direction === 'both' ? 'both' : 'c2d',
      });
    }
  });
});
