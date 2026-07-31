/**
 * Runtime mirror of `packages/daemon/src/hooks/hook-types.ts`'s
 * field-presence contract, used by `contract-drift.test.ts` to validate the
 * checked-in fixture corpus (`hook-corpus.jsonl`) against the TYPES —
 * something TypeScript's own compiler cannot do, since interfaces vanish at
 * runtime (#886 part 2).
 *
 * KEEP THIS IN SYNC BY HAND with `hook-types.ts`. A `hook-types.ts` edit
 * that touches a spec'd event's fields and isn't mirrored here makes the
 * drift test silently stop checking the changed field, not fail loudly —
 * so treat any such edit as also touching this file.
 *
 * SCOPE: only the 14 events in `REMI_REGISTERED_HOOK_EVENTS` are spec'd
 * below. Every other one of the 31 names in `HOOK_EVENT_NAMES` is
 * structurally uncapturable in `~/.remi/hook-diag.jsonl` — Claude Code only
 * POSTs a hook Claude Code has a configured URL for, and remi registers
 * (writes a hook entry for) only the events it consumes (#203 design). An
 * event having NO spec entry here is not a gap in this file; it is a
 * statement that this corpus can never contain one. The reverse also
 * matters: an event HAVING a spec entry is not a claim that fixtures exist
 * for it today — see `EVENTS_WITHOUT_FIXTURES`. This corpus grows with the
 * epic (each future Q that registers a new event adds fixture coverage for
 * it); it does not precede the epic, and its silence about an unregistered
 * or not-yet-captured event is not evidence about that event's shape.
 */

import type { RemiRegisteredHookEvent } from '../../../src/hooks/hook-types.ts';

export interface EventSpec {
  /** Event-specific fields (beyond the common ones below) that
   *  `hook-types.ts` declares non-optional. */
  required: readonly string[];
  /** Event-specific fields `hook-types.ts` declares optional. */
  optional: readonly string[];
  /**
   * Fields in `required` (event-specific OR common) that `hook-types.ts`
   * types as non-optional, but that real captures show Claude Code never
   * actually sends for THIS event — an already-filed, already-cited
   * exception, not a fresh drift finding to silently tolerate. Every entry
   * here must cite an issue, and `contract-drift.test.ts` asserts these
   * fields are in fact ALWAYS absent (so if Claude Code ever starts sending
   * one, that assertion — not the presence check — is what fails, which is
   * itself useful news).
   */
  knownAbsentRequired?: readonly string[];
  /**
   * Fields real captures show Claude Code DOES send for this event, that
   * `hook-types.ts` does not declare at all — an already-filed, already-cited
   * exception to the "every captured field is known to the types" check.
   * Adding a field here without filing an issue defeats the point of this
   * spec; see #929 for the only entries that currently exist.
   */
  extraKnownFields?: readonly string[];
}

/** `HookCommonInput` fields `hook-types.ts` declares non-optional. */
export const COMMON_REQUIRED = [
  'session_id',
  'transcript_path',
  'cwd',
  'hook_event_name',
  'permission_mode',
] as const;

/** `HookCommonInput` fields `hook-types.ts` declares optional. */
export const COMMON_OPTIONAL = ['agent_id', 'agent_type', 'prompt_id', 'effort'] as const;

/**
 * `_ts` is remi's OWN addition (`hook-server.ts`'s `REMI_HOOK_DEBUG` capture
 * timestamp) — never part of Claude Code's hook payload, so it is not a
 * `hook-types.ts` field at all and is excluded from every check below by
 * name, not modeled as common/optional.
 */
export const REMI_OWN_FIELDS = ['_ts'] as const;

export const EVENT_SPECS: Record<RemiRegisteredHookEvent, EventSpec> = {
  PreToolUse: {
    required: ['tool_name', 'tool_input'],
    optional: ['tool_use_id'],
  },
  PostToolUse: {
    required: ['tool_name', 'tool_input', 'tool_response'],
    optional: ['tool_use_id', 'duration_ms'],
  },
  PostToolUseFailure: {
    required: ['tool_name', 'tool_input', 'error'],
    optional: ['tool_use_id', 'is_interrupt', 'duration_ms'],
  },
  Notification: {
    required: ['message', 'notification_type'],
    optional: ['title'],
    // #929: permission_mode/effort are shared-builder parameters, not
    // universal fields — Notification's call site never passes one.
    knownAbsentRequired: ['permission_mode'],
  },
  Stop: {
    required: ['stop_hook_active'],
    optional: ['last_assistant_message', 'background_tasks', 'session_crons'],
  },
  SessionStart: {
    required: [],
    optional: ['source', 'model', 'agent_type', 'session_title'],
  },
  PermissionRequest: {
    required: ['tool_name', 'tool_input'],
    optional: ['permission_suggestions', 'tool_use_id'],
  },
  SubagentStart: {
    required: ['agent_type'],
    optional: [],
    knownAbsentRequired: ['permission_mode'], // #929
  },
  SubagentStop: {
    required: ['agent_type'],
    optional: [
      'agent_transcript_path',
      'last_assistant_message',
      'background_tasks',
      'session_crons',
    ],
    // #929: stop_hook_active IS sent (SubagentStop shares its builder with
    // Stop) but was never added to SubagentStopHookInput.
    extraKnownFields: ['stop_hook_active'],
  },
  SessionEnd: {
    required: ['reason'],
    optional: [],
    knownAbsentRequired: ['permission_mode'], // #929
  },
  StopFailure: {
    required: ['error_type'],
    optional: ['error', 'error_details', 'last_assistant_message'],
    // #929 (permission_mode) + #905 (error_type: hook-types.ts keeps this
    // required on purpose, as a live marker of the bug hook-event-bridge.ts
    // still has — see #905 for why fixing hook-types.ts here is deferred).
    knownAbsentRequired: ['permission_mode', 'error_type'],
  },
  PermissionDenied: {
    required: ['tool_name', 'tool_input'],
    optional: ['tool_use_id', 'reason'],
  },
  Elicitation: {
    required: ['mcp_server_name'],
    optional: ['message', 'mode', 'url', 'elicitation_id', 'requested_schema'],
  },
  ElicitationResult: {
    required: ['mcp_server_name'],
    optional: ['elicitation_id', 'mode', 'action', 'content'],
  },
};

/**
 * Registered event names with ZERO fixtures in `hook-corpus.jsonl` as of
 * this corpus build, and why — so `contract-drift.test.ts` can assert their
 * absence is EXPECTED (and stay useful if that ever changes) rather than
 * silently never iterating them. See `build-hook-corpus.ts`'s header for the
 * full investigation behind the `SessionStart` row.
 */
export const EVENTS_WITHOUT_FIXTURES: Partial<Record<RemiRegisteredHookEvent, string>> = {
  SessionStart:
    'registered, but the installed Claude Code 2.1.220 binary discards ' +
    'http-type hook registrations for SessionStart/Setup before dispatch ' +
    '— confirmed directly against the binary; see #930.',
  PermissionDenied: 'registered by #926, after most of this corpus was captured.',
  Elicitation: 'registered by #926, after most of this corpus was captured.',
  ElicitationResult: 'registered by #926, after most of this corpus was captured.',
};
