/**
 * TypeScript types for Claude Code hook event payloads.
 *
 * Claude Code HTTP hooks POST JSON to a configured URL when events fire.
 * These types are extracted from the installed Claude Code 2.1.220 binary
 * (`strings` + a handful of targeted regex pulls over the minified bundle),
 * cross-checked against code.claude.com/docs/en/hooks where the docs cover
 * the same ground. The binary wins on any disagreement (ADR 0006 disavows
 * cc-ref; it is not consulted here). Full extraction methodology, the
 * response-schema side of the contract, and the blocking-semantics analysis
 * live in `docs/claude-code-hook-contract.md` (#886) — read that first if
 * you are about to add a field here from a hunch rather than a capture.
 */

/** Fields present in all hook event payloads. Source: the common payload
 *  builder in the 2.1.220 binary (`function Kf(e,t,r){...return{session_id:n,
 *  transcript_path:nP(n),cwd:xt(),prompt_id:gAt()??void 0,permission_mode:e,
 *  agent_id:r?.agentId,agent_type:o,effort:a}}`, `o=r?.agentType??eB()`)
 *  plus code.claude.com/docs/en/hooks "Common input fields", which lists the
 *  same set independently (#886). */
export interface HookCommonInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  /** Values observed: 'default' | 'plan' | 'acceptEdits' | 'auto' | 'dontAsk' |
   *  'bypassPermissions' (binary enum `Iet`, confirmed by the docs page's
   *  permission_mode description, #886). Left as an open string because this
   *  file doesn't need to reject a future 7th mode to stay useful. */
  permission_mode: string;
  hook_event_name: HookEventName;
  /** Set ONLY on events originating from a subagent (background Task/Agent).
   *  Main-agent events have this absent. Confirmed via REMI_HOOK_DEBUG capture
   *  2026-04-16: subagent PermissionRequest/PreToolUse/PostToolUse/SubagentStart
   *  /SubagentStop carry agent_id, main events do not. This is the reliable
   *  discriminator to prevent subagent PermissionRequests from being misrouted
   *  through auto-approve into main's PTY. */
  agent_id?: string;
  /** Subagent type identifier (e.g. "general-purpose", "feature-dev:code-architect").
   *  Only present when agent_id is set. code.claude.com/docs/en/hooks agrees
   *  ("And for subagents: agent_id, agent_type") even though the raw builder
   *  computes this unconditionally (`r?.agentType??eB()`, defaulting to a
   *  session-scoped "main thread agent type" that reads as unset outside
   *  agent-team sessions) — kept empirical rather than re-derived from the
   *  builder shape alone; needs a live capture to fully resolve (#886 part 2). */
  agent_type?: string;
  /** UUID identifying the current user turn (binary: `prompt_id:gAt()??void 0`,
   *  i.e. `Mt.promptId`). Per the docs page, absent until the first user input
   *  and requires Claude Code >= 2.1.196 — this file's version stamp (2.1.220)
   *  postdates that, but older installs will not send it. remi does not
   *  currently read this field anywhere; it is the turn-scoped correlation key
   *  Q9 (#885) wants for authoritative UserPromptSubmit-based routing. */
  prompt_id?: string;
  /** Reasoning-effort override active for this turn, when the model in use
   *  supports effort levels (binary: `effort:a` where
   *  `a=i&&r?.getAppState&&FI(i)?{level:y9(i,s)}:void 0`; confirmed
   *  independently by the docs page's "effort — Object with a level field").
   *  `level` is drawn from the same set the model-info schema calls
   *  `supportedEffortLevels` ("low"|"medium"|"high"|"xhigh"|"max") but that
   *  mapping wasn't traced far enough to assert as a closed union here. */
  effort?: { level: string };
}

// --- Original 5 events ---

export interface PreToolUseHookInput extends HookCommonInput {
  hook_event_name: 'PreToolUse';
  tool_name: string;
  tool_input: Record<string, unknown>;
  /** Unique ID for this tool invocation. Claude Code sends this so Pre/PostToolUse
   *  pairs can be matched even when calls nest (e.g. Task inside another Task). */
  tool_use_id?: string;
}

export interface PostToolUseHookInput extends HookCommonInput {
  hook_event_name: 'PostToolUse';
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: unknown;
  tool_use_id?: string;
  /** Binary: `duration_ms:l` on the PostToolUse builder. How long the tool
   *  call took, in milliseconds (#886). */
  duration_ms?: number;
}

export interface NotificationHookInput extends HookCommonInput {
  hook_event_name: 'Notification';
  message: string;
  title?: string;
  /**
   * Binary confirms `notification_type` is drawn from a wider set than this
   * file tracked before #886. A dedicated docs-table resource inside the
   * 2.1.220 binary (tab-separated `path:"notification_type",values:[...]`)
   * lists exactly these 8: permission_prompt, idle_prompt, auth_success,
   * elicitation_dialog, elicitation_complete, elicitation_response,
   * agent_needs_input, agent_completed. Widened to that full 8 here — the
   * original 4 are unchanged so existing `=== 'permission_prompt'` etc.
   * comparisons (hook-event-bridge.ts) keep typechecking.
   *
   * NOT included: `computer_use_enter`/`computer_use_exit`/`push_notification`/
   * `worker_permission_prompt`/`chrome_permission_prompt`/
   * `workflow_permission_prompt`, which also appear as literal
   * `notificationType:"..."` call-site values elsewhere in the binary. These
   * look like they belong to a different internal notification subsystem
   * (Chrome-extension bridge, desktop notifications) rather than the
   * Notification hook specifically, but that boundary was not traced far
   * enough to assert either way. Open question for the #886 part 2 capture.
   */
  notification_type:
    | 'permission_prompt'
    | 'idle_prompt'
    | 'auth_success'
    | 'elicitation_dialog'
    | 'elicitation_complete'
    | 'elicitation_response'
    | 'agent_needs_input'
    | 'agent_completed';
}

export interface StopHookInput extends HookCommonInput {
  hook_event_name: 'Stop';
  stop_hook_active: boolean;
  /** Binary: `last_assistant_message:p` on the shared Stop/SubagentStop
   *  builder. The final assistant turn text before Claude stopped (#886). */
  last_assistant_message?: string;
  /**
   * Binary: a conditional spread `...f` where
   * `f=i?{background_tasks:cip(i.taskRegistry.all()),session_crons:uip()}:void 0`
   * on the SAME builder that produces both Stop and SubagentStop. Present
   * when a tool-use context is available at fire time.
   *
   * NOTE: issue #886's known-drift list named this field `session_tasks`;
   * the binary shows `background_tasks` + `session_crons` instead — this is
   * one of the places the issue's own exploration guessed wrong (see the PR
   * description). Left loosely typed since `cip`/`uip`'s per-item shape
   * wasn't traced.
   */
  background_tasks?: unknown[];
  session_crons?: unknown;
}

export interface SessionStartHookInput extends HookCommonInput {
  hook_event_name: 'SessionStart';
  /** Documented values at time of writing: 'startup' | 'resume' | 'clear' |
   *  'compact'. Typed as an open optional string because Claude Code rotates
   *  session_id through flows that emit other source values (or omit the
   *  field entirely), and restart detection downstream is source-agnostic. */
  source?: string;
  /** code.claude.com/docs/en/hooks: "Only SessionStart hooks can receive a
   *  model field, and it is not guaranteed to be present" — was typed
   *  required here; corrected to optional (#886). */
  model?: string;
  /** Binary: `agent_type:n` on the SessionStart builder — distinct from (and
   *  in addition to) the common `agent_type` field; not yet disambiguated
   *  against it (#886). */
  agent_type?: string;
  /** Binary: `session_title:r??fv(t!==void 0?SA(t):kt())` — always resolves
   *  to a string in practice (falls back to a derived title), but kept
   *  optional pending a live capture (#886). */
  session_title?: string;
}

// --- 20 new events (pre-#886) ---

/**
 * One entry in `permission_suggestions`. Strings are the legacy binary-label
 * shape (e.g. Edit's `["Yes", "Always", "No"]`).
 *
 * Objects are a "permission update entry" — the SAME shape Claude Code's own
 * permission-update API uses, discriminated by `type`. Confirmed directly
 * against the 2.1.220 binary's zod schema (`vlt=Se(()=>tc.discriminatedUnion(
 * "type",[...]))`, #886), not just the docs:
 *   - `{type:"addRules", rules:[{toolName, ruleContent?}], behavior:"allow"|
 *     "deny"|"ask", destination}` — add a rule; only `behavior:"allow"` is a
 *     "yes"-shaped suggestion the daemon can render as a one-tap option.
 *   - `{type:"replaceRules"|"removeRules", ...same shape}` — narrows/resets
 *     rules; never a "yes" variant, always skipped.
 *   - `{type:"setMode", mode, destination}` — switch permission mode (e.g.
 *     "plan", "acceptEdits").
 *   - `{type:"addDirectories"|"removeDirectories", directories:[...],
 *     destination}` — grant/revoke directory access; only `addDirectories`
 *     is a "yes" variant.
 *   - `destination` is `"session" | "localSettings" | "projectSettings" |
 *     "userSettings" | "cliArg"` on every variant (binary enum `hor`; the
 *     5th value, `cliArg`, was missing from this comment until #886).
 *
 * `optionsFromSuggestions` (hook-event-bridge.ts) is the single place that
 * interprets this union into option labels; an answer that picks a
 * suggestion-derived option round-trips the ORIGINAL entry back to Claude
 * Code as `hookSpecificOutput.decision.updatedPermissions` (real "Yes,
 * always", #718) — per the docs, "a hook can echo one of the
 * permission_suggestions it received as its own updatedPermissions output,
 * which is equivalent to the user selecting that 'always allow' option in
 * the dialog." The wider shape is open: callers must treat unknown `type`
 * values as opaque and skip them rather than guess.
 */
export type PermissionSuggestion = string | { type: string; [k: string]: unknown };

/** Fired when a permission dialog is about to show */
export interface PermissionRequestHookInput extends HookCommonInput {
  hook_event_name: 'PermissionRequest';
  tool_name: string;
  tool_input: Record<string, unknown>;
  permission_suggestions?: PermissionSuggestion[];
  /**
   * Cheap future-proofing (#673): NOT sent by Claude Code today. Verified
   * directly against the installed 2.1.220 binary (#886): the PermissionRequest
   * hook-input builder constructs exactly
   * `{...Kf(o,void 0,n),hook_event_name:"PermissionRequest",tool_name:e,
   * tool_input:r,permission_suggestions:i}` — no `tool_use_id` key anywhere in
   * it, unlike PreToolUse/PostToolUse/PostToolUseFailure/PermissionDenied,
   * which all do carry one. (Previously this comment cited cc-ref, a
   * disavowed third-party reimplementation — ADR 0006 — for the same
   * conclusion; the conclusion was right, the citation wasn't.) Declared as
   * an optional passthrough field so that if a future Claude Code version
   * adds it, the external-resolution correlation in AutoApproveGate can
   * prefer an exact id match over the tool_name+tool_input signature
   * fallback with zero further plumbing.
   */
  tool_use_id?: string;
}

/** Fired after a tool call fails */
export interface PostToolUseFailureHookInput extends HookCommonInput {
  hook_event_name: 'PostToolUseFailure';
  tool_name: string;
  tool_input: Record<string, unknown>;
  error: string;
  /** Binary: PostToolUseFailure builder also carries `tool_use_id`,
   *  `is_interrupt`, `duration_ms` alongside `error` (#886). */
  tool_use_id?: string;
  is_interrupt?: boolean;
  duration_ms?: number;
}

/** Fired when the user submits a prompt */
export interface UserPromptSubmitHookInput extends HookCommonInput {
  hook_event_name: 'UserPromptSubmit';
  /** Binary: `hook_event_name:"UserPromptSubmit",prompt:e,...!1,
   *  session_title:fv(kt())` — the human's typed input, handed to the hook
   *  directly. This is the PRIMARY authority source Q9 (#893) uses in place of
   *  transcript-JSONL filtering (see `auto-approve/authority.ts`); registered
   *  in `REMI_REGISTERED_HOOK_EVENTS` and consumed by the listener in
   *  `hook-bridge-setup.ts`. Was typed as an empty event body before #886;
   *  the `...!1` spread in the minified source looks like a build-time-folded
   *  conditional (spreading `false` is a no-op in JS), not a real extra
   *  field. */
  prompt: string;
  session_title: string;
}

/** Fired when instructions are loaded */
export interface InstructionsLoadedHookInput extends HookCommonInput {
  hook_event_name: 'InstructionsLoaded';
  /**
   * Binary: `{...Kf(void 0),hook_event_name:"InstructionsLoaded",file_path:e,
   * memory_type:t,load_reason:r,globs:o,trigger_file_path:i,
   * parent_file_path:s}` (#886) — there is no `source` field at all. The
   * pre-#886 type (`source: string`) never matched anything Claude Code
   * actually sends; nothing in this repo reads `.source` off this type, so
   * the rename is a pure correction, not a behavior change.
   */
  file_path: string;
  memory_type: string;
  load_reason: string;
  globs?: unknown;
  trigger_file_path?: string;
  parent_file_path?: string;
}

/** Fired when a subagent starts */
export interface SubagentStartHookInput extends HookCommonInput {
  hook_event_name: 'SubagentStart';
  agent_type: string;
}

/** Fired when a subagent stops */
export interface SubagentStopHookInput extends HookCommonInput {
  hook_event_name: 'SubagentStop';
  agent_type: string;
  /** Binary: SubagentStop shares its builder with Stop (same `f`/`p`
   *  locals); see StopHookInput for the background_tasks/session_crons
   *  provenance note (#886). */
  agent_transcript_path?: string;
  last_assistant_message?: string;
  background_tasks?: unknown[];
  session_crons?: unknown;
}

/** Fired when a task completes */
export interface TaskCompletedHookInput extends HookCommonInput {
  hook_event_name: 'TaskCompleted';
  /** Binary: `{...Kf(i),hook_event_name:"TaskCompleted",task_id:e,
   *  task_subject:t,task_description:r,teammate_name:n,team_name:o}` (#886).
   *  Was typed as an empty event body before this. */
  task_id: string;
  task_subject: string;
  task_description: string;
  teammate_name: string;
  team_name: string;
}

/** Fired when the stop hook itself fails */
export interface StopFailureHookInput extends HookCommonInput {
  hook_event_name: 'StopFailure';
  /**
   * Binary: `{...Kf(void 0,void 0,t),hook_event_name:"StopFailure",
   * error:s,error_details:e.errorDetails,last_assistant_message:i}` where
   * `s=e.error??"unknown"` (#886) — there is no `error_type` field. `error`
   * is kept alongside the pre-existing (wrong) `error_type` rather than
   * replacing it, because `error_type` is read at runtime
   * (hook-event-bridge.ts:509, `Session stop failed (${input.error_type})`)
   * and by several test fixtures; removing it here would be a type change
   * with a real behavior consequence (a user-facing message going from
   * "undefined" to something else), which is out of scope for this PR. Filed
   * as #905: `hook-event-bridge.ts` reads a field Claude Code never sends, so
   * that retry prompt has shown "(undefined)" since it was written.
   */
  error_type: string;
  error?: string;
  error_details?: unknown;
  last_assistant_message?: string;
}

/** Fired when a teammate agent becomes idle */
export interface TeammateIdleHookInput extends HookCommonInput {
  hook_event_name: 'TeammateIdle';
  /** Binary: `{...Kf(r),hook_event_name:"TeammateIdle",teammate_name:e,
   *  team_name:t}` (#886). Was typed as an empty event body before this. */
  teammate_name: string;
  team_name: string;
}

/** Fired when configuration changes */
export interface ConfigChangeHookInput extends HookCommonInput {
  hook_event_name: 'ConfigChange';
  /**
   * Binary: `{...Kf(void 0),hook_event_name:"ConfigChange",source:e,
   * file_path:t}` (#886) — there is no `config_type` field; renamed to match.
   * Nothing in this repo reads `.config_type` off this type (ConfigChange
   * isn't in REMI_REGISTERED_HOOK_EVENTS and no dynamic listener uses it
   * either), so this rename has no runtime consumers to break.
   */
  source: string;
  file_path: string;
}

/** Fired when a git worktree is created */
export interface WorktreeCreateHookInput extends HookCommonInput {
  hook_event_name: 'WorktreeCreate';
  /** Binary: `{...Kf(void 0),hook_event_name:"WorktreeCreate",name:e}` (#886).
   *  Note the RESPONSE schema for this event requires the hook to echo back
   *  an absolute `worktreePath` (see docs/claude-code-hook-contract.md) —
   *  the input's `name` is the worktree's short name, not its path. */
  name: string;
}

/** Fired when a git worktree is removed */
export interface WorktreeRemoveHookInput extends HookCommonInput {
  hook_event_name: 'WorktreeRemove';
  /** Binary: `{...Kf(void 0),hook_event_name:"WorktreeRemove",
   *  worktree_path:e}` (#886). */
  worktree_path: string;
}

/** Fired before context compaction */
export interface PreCompactHookInput extends HookCommonInput {
  hook_event_name: 'PreCompact';
  /** Binary: `{...Kf(void 0),hook_event_name:"PreCompact",trigger:e.trigger,
   *  custom_instructions:e.customInstructions}` (#886) — was typed as
   *  `source`; Claude Code sends `trigger` (values include "manual"|"auto"
   *  per the docs matcher table). Renamed, not left as an alias, since
   *  nothing in this repo reads `.source` off PreCompactHookInput either. */
  trigger: string;
  custom_instructions?: string;
}

/** Fired after context compaction */
export interface PostCompactHookInput extends HookCommonInput {
  hook_event_name: 'PostCompact';
  /** Binary: `{...Kf(void 0),hook_event_name:"PostCompact",trigger:e.trigger,
   *  compact_summary:e.compactSummary}` (#886) — same `source` -> `trigger`
   *  correction as PreCompact. */
  trigger: string;
  compact_summary?: string;
}

/** Fired when an MCP server requests input via elicitation */
export interface ElicitationHookInput extends HookCommonInput {
  hook_event_name: 'Elicitation';
  mcp_server_name: string;
  /** Binary: `{...Kf(n),hook_event_name:"Elicitation",mcp_server_name:e,
   *  message:t,mode:s,url:a,elicitation_id:l,requested_schema:r}` (#886) —
   *  every field beyond mcp_server_name was previously untyped. */
  message?: string;
  mode?: string;
  url?: string;
  elicitation_id?: string;
  requested_schema?: unknown;
}

/** Fired after an elicitation result is collected */
export interface ElicitationResultHookInput extends HookCommonInput {
  hook_event_name: 'ElicitationResult';
  mcp_server_name: string;
  /** Binary: `{...Kf(n),hook_event_name:"ElicitationResult",
   *  mcp_server_name:e,elicitation_id:a,mode:s,action:t,content:r}` (#886). */
  elicitation_id?: string;
  mode?: string;
  action?: string;
  content?: unknown;
}

/** Fired when the session ends */
export interface SessionEndHookInput extends HookCommonInput {
  hook_event_name: 'SessionEnd';
  reason: string;
}

// --- 9 events added in #886 (present in the 2.1.220 binary; the pre-#886
// HOOK_EVENT_NAMES list only knew 22 of the 31 that actually exist) ---

/** Fired once at session setup, before SessionStart proper. */
export interface SetupHookInput extends HookCommonInput {
  hook_event_name: 'Setup';
  /** Binary: `{...Kf(void 0),hook_event_name:"Setup",trigger:e}` (#886). */
  trigger: string;
}

/** Fired when a slash command / skill invocation expands into its prompt. */
export interface UserPromptExpansionHookInput extends HookCommonInput {
  hook_event_name: 'UserPromptExpansion';
  /** Binary: `{...Kf(i),hook_event_name:"UserPromptExpansion",
   *  expansion_type:e,command_name:t,command_args:r,command_source:n,
   *  prompt:o}` (#886). */
  expansion_type: string;
  command_name: string;
  command_args?: unknown;
  command_source?: string;
  prompt: string;
}

/** Fired when a permission classifier denies a tool call outright (no prompt
 *  render). Unregistered in remi today (#885 epic context: "a classifier-
 *  denied permission currently leaves a pending card with no resolution
 *  signal"). */
export interface PermissionDeniedHookInput extends HookCommonInput {
  hook_event_name: 'PermissionDenied';
  /** Binary: `{...Kf(i,void 0,o),hook_event_name:"PermissionDenied",
   *  tool_name:e,tool_input:r,tool_use_id:t,reason:n}` (#886). Unlike
   *  PermissionRequest, this one DOES carry tool_use_id. */
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id?: string;
  reason?: string;
}

/** Fired for a batch of tool calls post-execution (parallel tool calls). */
export interface PostToolBatchHookInput extends HookCommonInput {
  hook_event_name: 'PostToolBatch';
  /** Binary: `{...Kf(n,void 0,r),hook_event_name:"PostToolBatch",
   *  tool_calls:e}` (#886). Per-item shape of `tool_calls` wasn't traced. */
  tool_calls: unknown[];
}

/** Fired per streamed-message-delta while a message is being displayed. The
 *  response schema for this one can literally replace what's shown on
 *  screen (`displayContent`) — see docs/claude-code-hook-contract.md. */
export interface MessageDisplayHookInput extends HookCommonInput {
  hook_event_name: 'MessageDisplay';
  /** Binary: `{...Kf(void 0),hook_event_name:"MessageDisplay",
   *  turn_id:e.turnId,message_id:e.messageId,index:e.index,final:e.final,
   *  delta:e.delta}` (#886). */
  turn_id: string;
  message_id: string;
  index: number;
  final?: boolean;
  delta?: string;
}

/** Fired when the working directory changes mid-session. */
export interface CwdChangedHookInput extends HookCommonInput {
  hook_event_name: 'CwdChanged';
  /** Binary: `{...Kf(void 0),hook_event_name:"CwdChanged",old_cwd:e,
   *  new_cwd:t}` (#886). */
  old_cwd: string;
  new_cwd: string;
}

/** Fired when a watched file changes (see SessionStart/CwdChanged/FileChanged
 *  response schemas' `watchPaths`, docs/claude-code-hook-contract.md). */
export interface FileChangedHookInput extends HookCommonInput {
  hook_event_name: 'FileChanged';
  /** Binary: `{...Kf(void 0),hook_event_name:"FileChanged",file_path:e,
   *  event:t}` (#886). */
  file_path: string;
  event: string;
}

/** Fired when a directory is added to the allowed-directories set. NOT
 *  documented on code.claude.com/docs/en/hooks as of this writing (verified
 *  by direct page search, #886) — present in the binary only. */
export interface DirectoryAddedHookInput extends HookCommonInput {
  hook_event_name: 'DirectoryAdded';
  /** Binary: `{...Kf(void 0),hook_event_name:"DirectoryAdded",directory:e,
   *  source:t}` (#886). */
  directory: string;
  source?: string;
}

/** Fired when a teammate/task is created (Agent-Teams). Sibling of
 *  TaskCompleted; same field set. */
export interface TaskCreatedHookInput extends HookCommonInput {
  hook_event_name: 'TaskCreated';
  /** Binary: `{...Kf(i),hook_event_name:"TaskCreated",task_id:e,
   *  task_subject:t,task_description:r,teammate_name:n,team_name:o}` (#886). */
  task_id: string;
  task_subject: string;
  task_description: string;
  teammate_name: string;
  team_name: string;
}

/** Discriminated union of all hook event inputs */
export type HookInput =
  | PreToolUseHookInput
  | PostToolUseHookInput
  | NotificationHookInput
  | StopHookInput
  | SessionStartHookInput
  | PermissionRequestHookInput
  | PostToolUseFailureHookInput
  | UserPromptSubmitHookInput
  | InstructionsLoadedHookInput
  | SubagentStartHookInput
  | SubagentStopHookInput
  | TaskCompletedHookInput
  | StopFailureHookInput
  | TeammateIdleHookInput
  | ConfigChangeHookInput
  | WorktreeCreateHookInput
  | WorktreeRemoveHookInput
  | PreCompactHookInput
  | PostCompactHookInput
  | ElicitationHookInput
  | ElicitationResultHookInput
  | SessionEndHookInput
  | SetupHookInput
  | UserPromptExpansionHookInput
  | PermissionDeniedHookInput
  | PostToolBatchHookInput
  | MessageDisplayHookInput
  | CwdChangedHookInput
  | FileChangedHookInput
  | DirectoryAddedHookInput
  | TaskCreatedHookInput;

/** Valid hook event names. 31 total, matching the full set present in the
 *  installed Claude Code 2.1.220 binary (#886) — the 22 above this line
 *  predate #886; the 9 below it were added there (`Setup`,
 *  `UserPromptExpansion`, `PermissionDenied`, `PostToolBatch`,
 *  `MessageDisplay`, `CwdChanged`, `FileChanged`, `DirectoryAdded`,
 *  `TaskCreated`). This is a type-level completeness fix only: adding a name
 *  here does NOT register it (see REMI_REGISTERED_HOOK_EVENTS below, which is
 *  unchanged by #886 — every registration is a synchronous HTTP roundtrip
 *  that gates Claude Code, #203). */
export const HOOK_EVENT_NAMES = [
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SessionStart',
  'PermissionRequest',
  'PostToolUseFailure',
  'UserPromptSubmit',
  'InstructionsLoaded',
  'SubagentStart',
  'SubagentStop',
  'TaskCompleted',
  'StopFailure',
  'TeammateIdle',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'PreCompact',
  'PostCompact',
  'Elicitation',
  'ElicitationResult',
  'SessionEnd',
  'Setup',
  'UserPromptExpansion',
  'PermissionDenied',
  'PostToolBatch',
  'MessageDisplay',
  'CwdChanged',
  'FileChanged',
  'DirectoryAdded',
  'TaskCreated',
] as const;

export type HookEventName = (typeof HOOK_EVENT_NAMES)[number];

/**
 * Subset of hook events that remi actually consumes — these are the only
 * events written into `.claude/settings.local.json` by HookConfigManager.
 *
 * The remaining HOOK_EVENT_NAMES entries (`WorktreeCreate`, `WorktreeRemove`,
 * etc.) are accepted by HookServer for forward compatibility, but registering
 * them in Claude Code's settings turns every such event into a synchronous
 * HTTP roundtrip that gates the underlying
 * Claude Code action. The most painful symptom: a stale (or just slow)
 * remi daemon makes Claude Code unable to create a worktree, even though
 * remi has no business gating that operation. See issue #203.
 *
 * Treat this list as the source of truth for "things remi cares about." If
 * you add a new typed handler in HookServer.dispatch or a dynamic listener
 * in setupHookBridge, also add the event name here so the registration
 * actually fires.
 *
 * Was UNCHANGED by #886: that issue added 9 names to HOOK_EVENT_NAMES for
 * type completeness (so HookServer/isValidHookEvent recognize them if Claude
 * Code sends one unprompted), which is not the same decision as opting remi
 * into paying for them on every turn. Registering PermissionDenied/
 * Elicitation was left as Q4's call to make, deliberately, not a side effect
 * of a documentation pass.
 *
 * Q4 (#889) makes that call for 3 of the 20 unregistered names:
 *   - `PermissionDenied`: a classifier-denied permission fires no tool call,
 *     so nothing else can prove a still-open escalation is resolved. Wired
 *     into the SAME external-resolution funnel PreToolUse/PostToolUse use
 *     (`AutoApproveGate.cancelExternallyResolved`).
 *
 *     It DOES carry a `tool_use_id`, unlike `PermissionRequest` — but that id
 *     buys nothing yet, and an earlier draft of this comment claimed it did
 *     ("taking advantage of its exact `tool_use_id`"). Matching is
 *     `tool_name` + `tool_input` + `agentId`; the id is consulted only when
 *     BOTH sides carry one (`findOpenQuestionMatching`,
 *     `auto-approve-gate.ts`). The registered side is built from the
 *     `PermissionRequest` that opened the escalation, and that event never
 *     sends a `tool_use_id` (see `PermissionRequestHookInput` above, read out
 *     of the binary), so `sig.toolUseId` is always `undefined` and the exact-id
 *     branch is unreachable from this path today. Passing the id through is
 *     forward-compatible dead weight, not a live disambiguator — worth stating
 *     precisely, because "it matches on an exact id" would read as stronger
 *     than the signature match it actually performs.
 *   - `Elicitation` / `ElicitationResult`: an MCP dialog previously arrived
 *     only as a PTY orphan (`hook-event-bridge.ts`'s `handleNotification`
 *     logs and ignores `notification_type === 'elicitation_dialog'`, and the
 *     dedicated `Elicitation` hook was never registered at all, so it never
 *     fired). `Elicitation` now builds an answerable, free-text `Question`
 *     card (`HookEventBridge.handleElicitation`); `ElicitationResult`
 *     resolves it by `elicitation_id` — an exact correlation key both events
 *     carry — the same "close the lingering-card gap" shape as
 *     `PermissionDenied` above. Both stay observe-only (#889): neither hook
 *     response encodes `action`/`content` to answer the MCP dialog
 *     programmatically; the user's own answer (if any) rides the existing
 *     generic PTY-inject path any non-held Question uses.
 * All three keep the existing `DEFAULT_HOOK_TIMEOUT` (5s, `hook-config-
 * manager.ts`) — `hookTimeoutFor` only special-cases `PermissionRequest`, and
 * none of these three needs a longer budget (no eval, no hold; #889's own
 * text said "~1s", which does not match this codebase's actual default —
 * see the PR for the measured per-event latency instead).
 *
 * Q9 (#893) registers a 4th: `UserPromptSubmit`. Unlike Q4's three, THIS one
 * fires once per HUMAN TURN rather than per tool call — far lower frequency
 * (a 2-day capture logged ~4,800 per-tool-call hook roundtrips against a
 * human-paced turn count several orders smaller), and it hands the daemon the
 * human's own typed `prompt` directly, which is the PRIMARY source
 * `auto-approve/authority.ts` uses to build the auto-approve prompt's
 * CONVERSATION CONTEXT block (replacing a transcript-JSONL scrape that cannot
 * structurally tell a genuine prompt apart from a `!`-command's captured
 * stdout — see that file's module doc). Its listener (`hook-bridge-setup.ts`)
 * is a single array push into a per-session ring buffer — cheaper than the Q4
 * three, not more expensive — and IT gets its own short timeout
 * (`hookTimeoutFor`, `hook-config-manager.ts`) rather than the flat 5s, since
 * #889's own text got that number wrong for its three (see above) and this
 * issue is not repeating the mistake.
 *
 * **A listener's own work is on Claude's critical path.** `HookServer.
 * handleRequest` (`hook-server.ts`) calls `this.dispatch(body)` and only THEN
 * returns the `{}` response, and `dispatch` invokes listeners synchronously —
 * so every millisecond an `.on()` handler spends is a millisecond Claude Code
 * sits blocked on the hook. There is no answer-first escape hatch to fall back
 * on. #889's own text asserted the opposite ("HookServer answers `{}` BEFORE
 * doing work"), which is why this is written down here rather than left as
 * folklore: every registration below is safe because each handler is a map
 * lookup, a signature compare, or (UserPromptSubmit) an array push — not
 * because responding is free. Anything heavier (an LLM call, a file read, a
 * network hop) must move off the listener — the way `PermissionRequest` does
 * with its hold/park design — before its event is added to this list.
 */
export const REMI_REGISTERED_HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SessionStart',
  'PermissionRequest',
  'PostToolUseFailure',
  'SubagentStart',
  'SubagentStop',
  'StopFailure',
  'SessionEnd',
  'PermissionDenied',
  'Elicitation',
  'ElicitationResult',
  'UserPromptSubmit',
] as const satisfies readonly HookEventName[];

export type RemiRegisteredHookEvent = (typeof REMI_REGISTERED_HOOK_EVENTS)[number];

/** Type guard for valid hook event names */
export function isValidHookEvent(name: string): name is HookEventName {
  return (HOOK_EVENT_NAMES as readonly string[]).includes(name);
}
