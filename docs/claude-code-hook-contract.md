# Claude Code hook contract reference

**Version-stamped: Claude Code 2.1.220, extracted 2026-07-28.** This is a
snapshot, not a promise — see "Version sensitivity" below for how fast this
contract has already moved, and re-extract before trusting it against a
different Claude Code version.

Written for #886 (Q1 of epic #885). Produces the reference doc and the
`hook-types.ts` drift fixes; the capture corpus (#886's second deliverable)
is explicitly **not** included here — see "What's pending" at the bottom.

## The rule this document follows

**Binary and live captures are ground truth. The published docs page
(code.claude.com/docs/en/hooks) is the map, not the territory — useful,
frequently accurate, and demonstrably behind the binary in specific,
checkable ways (it omits `permission_suggestions` entirely, and it does not
mention the `DirectoryAdded` event at all — both confirmed below).
`cc-ref` (`github.com/ultraworkers/claw-code`, a third-party Rust parity
reimplementation) is not evidence for anything in this document and is not
cited anywhere in it — see ADR 0006.**

Every claim below is tagged with how it was established:

| Tag | Meaning |
|---|---|
| **[B]** | Extracted directly from the installed Claude Code binary (`/Users/yahya/.local/share/claude/versions/2.1.220`) — either its embedded zod validation schemas (for response shapes and hook config) or its hook-input builder functions (for payload shapes). Highest confidence: this is the code that actually runs. |
| **[D]** | From code.claude.com/docs/en/hooks. Used where it corroborates [B] (noted inline) or where [B] extraction wasn't attempted/possible. Treated as secondary per the rule above — where [B] and [D] disagreed, this document says so explicitly and keeps [B]. |
| **[R]** | remi's own field notes: things learned from `REMI_HOOK_DEBUG` captures on real sessions (dated), or from remi's own runtime behavior/logging (e.g. observed hook-fire counts). Empirical but scoped to remi's own historical sessions, not a fresh capture for this document — see "What's pending." |

### Extraction method (so this is reproducible against a future version)

The installed binary is a single ~257 MB esbuild bundle containing readable
(if minified) JavaScript source, including embedded zod (`E.object(...)`,
`tc.object(...)`) schema definitions with human-readable `.describe(...)`
strings — these describe fields more precisely than the binary needed to,
which is presumably why they exist: internal documentation-generation tooling
reads the same schemas. Two extraction passes:

```bash
# 1. Every hook-input object-literal construction site (finds all 31 events
#    and their payload fields in one pass):
rg -a -o -P 'hook_event_name:"[A-Za-z]+"[^}]{0,260}' <binary>

# 2. The response-schema zod union (hookSpecificOutput per event) and the
#    hook CONFIG schema (http/command/prompt/agent types), via ripgrep's
#    dotall mode anchored on a known symbol and read until the containing
#    expression closes:
rg -a -o -P '(?s)hookSpecificOutput:E\.union\(\[E\.object\(\{hookEventName:E\.literal\("PreToolUse"\).*?\]\)\.optional\(\)\}\)\),wlt=Se' <binary>
```

`strings` alone under-extracts: it breaks a "string" at any non-printable
byte, which chops long minified lines into short fragments. `rg -a` (treat
binary as text) with a `(?s)`-flagged PCRE anchored on a recognizable
substring pulls the full surrounding expression instead.

---

## Common fields

Present on every hook input. Source: the shared payload builder in the
binary, `function Kf(e,t,r){...}`, called at every one of the 31
`hook_event_name:"..."` construction sites via `{...Kf(...), hook_event_name:
"X", ...event-specific fields}` **[B]**. Independently corroborated by the
docs page's own "Common input fields" list **[D]**, which matches field-for-field.

| Field | Type | Notes |
|---|---|---|
| `session_id` | `string` | **[B][D]** |
| `transcript_path` | `string` | **[B][D]** — derived from `session_id` (`nP(session_id)` in the binary) |
| `cwd` | `string` | **[B][D]** |
| `permission_mode` | `string` | **[B][D]** Observed enum: `default \| plan \| acceptEdits \| auto \| dontAsk \| bypassPermissions` (binary zod enum `Iet`, matches the docs page's own description of the field). |
| `hook_event_name` | `string` | **[B][D]** discriminant |
| `agent_id` | `string \| undefined` | **[B][D][R]** Present only on subagent/team events. remi's own `REMI_HOOK_DEBUG` capture (2026-04-16) is the empirical confirmation cited in `hook-types.ts`; matches the docs page's "for subagents: agent_id, agent_type." |
| `agent_type` | `string \| undefined` | **[B][D][R]** Same as `agent_id` per remi's capture and the docs page. Worth flagging: the binary's *builder* computes this unconditionally (`o=r?.agentType??eB()`, where `eB()` reads a session-scoped "main thread agent type" default) rather than gating it on `agent_id` being set — so structurally the field is always attempted, and it is almost certainly `undefined` (dropped by `JSON.stringify`) outside agent-team sessions, which is consistent with remi's empirical finding rather than contradicting it. Not fully resolved without a live agent-teams capture — see "What's pending." |
| `prompt_id` | `string \| undefined` | **[B][D]** — **remi does not currently capture this field anywhere** (`grep -c prompt_id packages/daemon/src/hooks/hook-types.ts` was 0 before this PR). Binary: `prompt_id:gAt()??void 0` (i.e. `Mt.promptId`). Docs page: "UUID identifying the user prompt... Absent until the first user input. Requires Claude Code v2.1.196 or later" — so this is itself a recent addition, and any Claude Code install older than 2.1.196 will never send it. This is the turn-scoped correlation key epic #885 wants for Q9 (authoritative `UserPromptSubmit`-based routing) in place of the current Stop-sweep heuristics. |
| `effort` | `{ level: string } \| undefined` | **[B][D]** Reasoning-effort override active for the turn, when the model supports effort levels. Binary: `effort:a` where `a=i&&r?.getAppState&&FI(i)?{level:y9(i,s)}:void 0`. Docs page independently lists "effort — Object with a level field." Not something remi's known-drift list named going in; found by reading the builder function directly. |

---

## Blocking semantics — the most important section

**Every hook Claude Code fires to remi's `http` transport is a synchronous
HTTP roundtrip that Claude Code blocks on, bounded by the hook's configured
timeout, regardless of whether the response can change anything.** That
splits into two independent axes, and conflating them is the mistake to avoid
when deciding what to register:

### Axis 1: transport cost — always paid, for every registered event

Verified directly against the binary's hook-config zod schema **[B]**. There
are **four** hook transport types, not just the two remi's own code
(`hook-config-manager.ts`) knows about:

| Type | Fields (exact, from the zod schema) | Has `async`/`asyncRewake`? |
|---|---|---|
| `http` | `type, url, if, timeout, headers, allowedEnvVars, statusMessage, once` | **No** |
| `command` | `type, command, args, if, shell, timeout, statusMessage, once, async, asyncRewake, rewakeMessage, rewakeSummary` | **Yes** |
| `prompt` | `type, prompt, if, timeout, model, continueOnBlock` | No |
| `agent` | `type, prompt, if, timeout, model, ...` (not fully enumerated) | No |

`async`/`asyncRewake` ("If true, hook runs in background without blocking" /
"...and wakes the model on exit code 2") exist **only** on the `command`
type, confirmed by the exact field list above and independently by the docs
page ("The `async` field is only defined for command hooks... HTTP hooks
have only these fields: `type`, `if`, `timeout`, `statusMessage`, `url`,
`headers`, and `allowedEnvVars`. No async support.") **[D]**.

remi registers exclusively via `type: 'http'` (`hook-config-manager.ts`), and
uses only `url` and `timeout` of the seven fields available to it (no `if`
matcher, no `headers`/`allowedEnvVars`, no `statusMessage`, no `once`). One
schema nuance worth flagging: the binary's zod object for `http` *does*
accept a `once` field without validation error, but the docs page states
`once` is "only honored for hooks declared in skill frontmatter; ignored in
settings files and agent frontmatter" **[D]** — remi writes to
`.claude/settings.local.json`, so `once` would be schema-legal but
functionally inert for remi even if it started sending it. Schema tolerance
and runtime effect are not the same thing; this document tries to be
specific about which claim it's making in each row.

**The practical consequence for remi: there is no way to register an HTTP
hook that observes an event "for free."** Every event added to
`REMI_REGISTERED_HOOK_EVENTS` makes Claude Code wait on remi's daemon before
it can proceed with that action — a stale or slow daemon can make Claude Code
unable to submit a prompt, create a worktree, or finish a session, purely
because a hook nobody needed a decision from is still gating the action
(#203). This is why `HOOK_EVENT_NAMES` (31, type-complete as of this PR) and
`REMI_REGISTERED_HOOK_EVENTS` (11 when this document landed; **14 since #889**
added `PermissionDenied`, `Elicitation` and `ElicitationResult`) are and must
stay two different lists.

### Axis 2: semantic power — varies from zero to full override, per event

Whether the hook's JSON response actually changes anything is a **separate**
question from whether Claude Code waited for it. Source: the response zod
schema, `Uzg=Se(()=>E.object({continue, suppressOutput, stopReason, decision,
reason, systemMessage, terminalSequence, hookSpecificOutput}))` **[B]** — every
hook response is validated against this shape (or, for `command` hooks only,
the alternate `{async:true, asyncTimeout}` shape that defers the real
response).

The **generic envelope** — `continue`, `suppressOutput`, `stopReason`,
`decision` (`"approve"|"block"`), `reason`, `systemMessage`, `terminalSequence`
— applies to every event that gets dispatched to a resolver at all. Beyond
that, `hookSpecificOutput` is a zod union of **20** per-event object shapes
(not 31 — see the table below); sending `hookSpecificOutput` for an event
outside that union of 20 would fail Claude Code's own response validation.

| Semantic power | Events | What the response can do |
|---|---|---|
| **Full override** | `PreToolUse` | `permissionDecision` (allow/deny/ask/defer), `permissionDecisionReason`, `updatedInput` (rewrite the tool call), `additionalContext` |
| **Full override** | `PermissionRequest` | `decision: {behavior:"allow", updatedInput?, updatedPermissions?}` or `{behavior:"deny", message?, interrupt?}` — this is Model B (ADR 0002/0003): the entire synchronous verdict channel remi uses today |
| **Rewrite results** | `PostToolUse` | `updatedToolOutput`, `updatedMCPToolOutput` (rewrite what the model sees), `additionalContext` |
| **Rewrite content** | `MessageDisplay` | `displayContent` — literally replaces a streamed message delta on screen |
| **Steer the turn** | `UserPromptSubmit` | `additionalContext`, `sessionTitle`, `suppressOriginalPrompt`, plus the generic `decision:"block"` to reject the prompt outright |
| **Steer the turn** | `SessionStart` | `additionalContext`, `initialUserMessage`, `sessionTitle`, `watchPaths`, `reloadSkills` |
| **Resolve MCP dialog** | `Elicitation`, `ElicitationResult` | `action` (`accept\|decline\|cancel`), `content` — can programmatically answer or override an MCP elicitation |
| **Retry signal** | `PermissionDenied` | `retry: boolean` |
| **Watch registration** | `CwdChanged`, `FileChanged` | `watchPaths` |
| **Required echo** | `WorktreeCreate` | `worktreePath` is **required** (not optional) in this one's response object — a hook handling this event must supply the created worktree's absolute path |
| **Context only** | `UserPromptExpansion`, `Setup`, `SubagentStart`, `PostToolUseFailure`, `PostToolBatch`, `Stop`, `SubagentStop`, `Notification` | `additionalContext` only, beyond the generic envelope |
| **Generic envelope only — no event-specific power at all** | `PreCompact`, `PostCompact`, `ConfigChange`, `DirectoryAdded`, `InstructionsLoaded`, `SessionEnd`, `StopFailure`, `TaskCreated`, `TaskCompleted`, `TeammateIdle`, `WorktreeRemove` | Sending `hookSpecificOutput` for any of these 11 events fails validation — nothing beyond `continue`/`decision`/`systemMessage`/`reason`/`terminalSequence` is honored |

**Reading this table correctly:** a hook registered for, say, `SessionEnd`
still costs a full synchronous roundtrip (axis 1) even though its response
can do nothing but append a system message or block the generic decision
(axis 2, bottom row). Cost is uniform; power is not. This is the analysis
epic #885 asked this document to make explicit before Q4/Q7 decide what else
to register — a genuinely powerful new capability (e.g. `PermissionDenied`'s
`retry`, or `Elicitation`'s programmatic resolution) is a different cost/benefit
case than an event whose response can only leave a comment.

---

## Full event catalog

31 events total in the 2.1.220 binary, confirmed by counting distinct
`hook_event_name:"..."` construction sites **[B]**. remi's `HOOK_EVENT_NAMES`
tracked 22 before this PR; the 9 missing (`Setup`, `UserPromptExpansion`,
`PermissionDenied`, `PostToolBatch`, `MessageDisplay`, `CwdChanged`,
`FileChanged`, `DirectoryAdded`, `TaskCreated`) are added by this PR at the
type level only (not registered — see the blocking-semantics section). Of
those, `PermissionDenied` has since been registered too (#889), along with
`Elicitation`/`ElicitationResult`, which were already typed; the **Reg.**
column below is the current list, not this PR's.

Legend: **Reg.** = in `REMI_REGISTERED_HOOK_EVENTS` today. **Resp.** = has a
dedicated `hookSpecificOutput` response schema (see the semantic-power table
above for what it does).

| Event | Reg. | Input fields beyond common | Resp. | Evidence |
|---|:-:|---|:-:|---|
| `PreToolUse` | Y | `tool_name, tool_input, tool_use_id?` | Y | [B] matches remi's pre-existing type |
| `PostToolUse` | Y | `tool_name, tool_input, tool_response, tool_use_id?, duration_ms` | Y | [B] `duration_ms` was missing (named in #886) |
| `PostToolUseFailure` | Y | `tool_name, tool_input, error, tool_use_id?, is_interrupt?, duration_ms?` | Y (context only) | [B] 3 input fields were missing (named in #886) |
| `PostToolBatch` | — | `tool_calls: unknown[]` | Y | [B] new type this PR; per-item shape not traced |
| `PermissionDenied` | Y (#889) | `tool_name, tool_input, tool_use_id?, reason?` | Y (`retry`) | [B] new type this PR; unlike `PermissionRequest`, DOES carry `tool_use_id` |
| `PermissionRequest` | Y | `tool_name, tool_input, permission_suggestions?` — **no `tool_use_id`** | Y (full decision) | [B] confirms the "no tool_use_id" conclusion in `hook-types.ts` was correct; only its citation (cc-ref) was wrong |
| `UserPromptExpansion` | — | `expansion_type, command_name, command_args?, command_source?, prompt` | Y (context only) | [B] new type this PR |
| `PreCompact` | — | `trigger, custom_instructions?` | — | [B] was typed `source`; binary sends `trigger`. Named in #886 |
| `PostCompact` | — | `trigger, compact_summary?` | — | [B] same `source`→`trigger` correction; `compact_summary` named in #886 |
| `ConfigChange` | — | `source, file_path` | — | [B] was typed `config_type: string`, which **does not exist** in the binary at all — see "Renames, not additions" below |
| `DirectoryAdded` | — | `directory, source?` | — | [B] new type this PR. **Not documented on code.claude.com/docs/en/hooks** — confirmed by direct page search, see "Version sensitivity" |
| `Elicitation` | Y (#889) | `mcp_server_name, message?, mode?, url?, elicitation_id?, requested_schema?` | Y | [B] only `mcp_server_name` was typed before this PR |
| `ElicitationResult` | Y (#889) | `mcp_server_name, elicitation_id?, mode?, action?, content?` | Y | [B] same |
| `CwdChanged` | — | `old_cwd, new_cwd` | Y (`watchPaths`) | [B] new type this PR |
| `FileChanged` | — | `file_path, event` | Y (`watchPaths`) | [B] new type this PR |
| `InstructionsLoaded` | — | `file_path, memory_type, load_reason, globs?, trigger_file_path?, parent_file_path?` | — | [B] was typed `source: string`, which **does not exist** in the binary at all |
| `MessageDisplay` | — | `turn_id, message_id, index, final?, delta?` | Y (`displayContent`, can replace on-screen text) | [B] new type this PR |
| `Notification` | Y | `message, title?, notification_type` (8-value enum, widened this PR — see below) | Y (context only) | [B][D] |
| `SessionStart` | Y | `source?, model?, agent_type?, session_title?` | Y | [B][D] `model` was wrongly required; docs explicitly say "not guaranteed to be present." `agent_type`/`session_title` were untyped |
| `Setup` | — | `trigger` | Y (context only) | [B] new type this PR |
| `SubagentStart` | Y | `agent_type` | Y (context only) | [B] matches pre-existing type |
| `SessionEnd` | Y | `reason` | — | [B] matches pre-existing type |
| `StopFailure` | Y | `error_type` (kept, but see below), `error?, error_details?, last_assistant_message?` | — | [B] `error_type` **does not exist** in the binary; see "A real bug this verification found" |
| `SubagentStop` | Y | `agent_type, agent_transcript_path?, last_assistant_message?, background_tasks?, session_crons?` | Y (context only) | [B] shares its builder with `Stop`; see below |
| `Stop` | Y | `stop_hook_active, last_assistant_message?, background_tasks?, session_crons?` | Y (context only) | [B] issue #886 named this field `session_tasks`; binary shows `background_tasks` + `session_crons` instead — the issue's exploration guessed wrong here |
| `TeammateIdle` | — | `teammate_name, team_name` | — | [B] was an empty event body |
| `TaskCreated` | — | `task_id, task_subject, task_description, teammate_name, team_name` | — | [B] new type this PR |
| `TaskCompleted` | — | `task_id, task_subject, task_description, teammate_name, team_name` | — | [B] was an empty event body |
| `UserPromptSubmit` | — | `prompt, session_title` | Y | [B][D] this is Q9's proposed authority source — the human's typed input, direct from Claude Code, no transcript parsing |
| `WorktreeCreate` | — | `name` | Y (`worktreePath` **required**) | [B] new field this PR |
| `WorktreeRemove` | — | `worktree_path` | — | [B] new field this PR |

### Renames, not additions: `ConfigChange` and `InstructionsLoaded`

Two of the pre-existing types didn't just lack fields — the field they *did*
have doesn't exist in the binary at all:

- `ConfigChangeHookInput` was typed `config_type: string`. The binary's
  builder sends `{source, file_path}`; there is no `config_type` key
  anywhere. Checked for consumers before changing this (`grep -rn
  "config_type\b" packages/`): the only occurrence in the whole repo was the
  type definition itself. Nothing reads it, so this rename has no runtime
  effect.
- `InstructionsLoadedHookInput` was typed `source: string`. The binary sends
  `{file_path, memory_type, load_reason, globs?, trigger_file_path?,
  parent_file_path?}` — again, no `source` key. Same check, same result:
  zero consumers.

Both are corrected in this PR as straight renames (old field removed, real
fields added), not additive shims, because leaving the wrong field present
would misrepresent the contract for no benefit — nothing in this repo relies
on the old name.

### A real bug this verification found: `StopFailure.error_type`

`StopFailureHookInput` was typed `error_type: string`, and
`hook-event-bridge.ts:509` builds a user-facing retry prompt from it:
`` `Session stop failed (${input.error_type}). Retry?` ``. The binary's
StopFailure builder sends `{error, error_details, last_assistant_message}` —
**no `error_type` field exists.** On every real `StopFailure` event,
`input.error_type` is `undefined`, so that prompt has read **"Session stop
failed (undefined). Retry?"** since it was written.

This is a real, previously-unknown production bug, not a documentation gap —
but fixing `hook-event-bridge.ts` to read `input.error` instead is a runtime
behavior change, which is explicitly out of scope for this PR (see "Critical
constraint" in the PR description). `hook_types.ts` now carries the real
fields (`error`, `error_details?`, `last_assistant_message?`) alongside the
legacy `error_type` (kept, unremoved, specifically so this PR doesn't also
have to touch the three existing test fixtures that construct `{error_type:
'timeout'}` payloads). Filed as **#905** with the fix and the fixture updates
it needs; referenced from the type definition.

### `Stop` / `SubagentStop`: `background_tasks` + `session_crons`, not `session_tasks`

Issue #886's own known-drift list named the extra `Stop`/`SubagentStop` field
`session_tasks`. The binary shows the actual shared builder constructs a
conditional spread `...f` where `f = i ? {background_tasks:
cip(i.taskRegistry.all()), session_crons: uip()} : void 0` — two fields, and
neither is spelled the way the issue guessed. This is flagged explicitly
because the issue was written from exploration rather than extraction, and
this document's whole purpose is to stop propagating exactly that kind of
plausible-but-wrong field name forward.

### `Notification.notification_type`: widened from 4 to 8 values

The pre-existing type had `'permission_prompt' | 'idle_prompt' |
'auth_success' | 'elicitation_dialog'`. The binary contains a dedicated
tab-separated documentation-table resource (`path:"notification_type",
values:[...]`) listing exactly 8 values: the original 4 plus
`elicitation_complete`, `elicitation_response`, `agent_needs_input`,
`agent_completed`. Widened to all 8 (additive, so existing `===
'permission_prompt'` comparisons in `hook-event-bridge.ts` keep typechecking
unchanged).

Left **out**: `computer_use_enter`, `computer_use_exit`, `push_notification`,
`worker_permission_prompt`, `chrome_permission_prompt`,
`workflow_permission_prompt` — these also appear as literal
`notificationType:"..."` call-site values elsewhere in the binary, but they
read as belonging to a different internal subsystem (a Chrome-extension
bridge / desktop-notification path) rather than the `Notification` hook
specifically. Not confident enough to assert either way from static
extraction alone — an open question for the capture corpus.

---

## Version sensitivity

This contract will drift, and has already drifted once inside the versions
that matter to remi:

- **`permission_suggestions` changed shape around Claude Code 2.0.54** — from
  plain string labels (Edit's `["Yes","Always","No"]`) to a structured array
  of typed "permission update entries" (`addRules`, `addDirectories`,
  `setMode`, `removeRules`, `replaceRules`, `removeDirectories`). remi's
  `PermissionSuggestion` type already models both shapes (#718); this
  document's binary extraction of the `vlt` zod schema **[B]** confirms that
  comment is accurate, and adds the one destination value it was missing
  (`cliArg`, alongside `session`/`localSettings`/`projectSettings`/`userSettings`).
- **`prompt_id` requires Claude Code >= 2.1.196** per the docs page **[D]** —
  itself a recent addition, not something present since hooks shipped. An
  install even a handful of versions behind 2.1.220 may not send it at all;
  code consuming it needs to treat its absence as normal, not an error.
- **The event set grows between versions, and remi's own knowledge of it has
  lagged twice now.** `cc-ref` (disavowed, ADR 0006) modeled 3 of 25+ events
  at the time it was in use. remi's own pre-#886 `HOOK_EVENT_NAMES` knew 22.
  The installed 2.1.220 binary has 31. Nothing about this trend suggests 31
  is final.
- **The docs page lags the binary, in more than the already-known
  `permission_suggestions` gap.** Verified directly for this document: the
  string `"DirectoryAdded"` does not appear anywhere on
  code.claude.com/docs/en/hooks (confirmed via a direct, targeted page
  search, not an oversight in this document's own reading) even though the
  event is live in the binary with its own input builder. Treat an event's
  absence from the docs page as evidence of nothing — check the binary.
- **`agent_type` on the common-fields envelope has a resolved-vs-structural
  tension** noted in the common-fields table above: the builder computes it
  unconditionally, but remi's own capture says it correlates with `agent_id`
  presence in practice. Both can be true (default-undefined outside
  agent-team sessions), but this needs a live capture to close out, not
  another reading of the minified builder.

---

## Layering: hooks are upstream of, and orthogonal to, relay encryption

The hook path and the relay-encryption path do not intersect. Verified for
this document:

```
$ grep -rn "relay-crypto\|encryptRelay\|sessionKeys" packages/daemon/src/hooks/
(no output)
```

`HookServer` (`packages/daemon/src/hooks/hook-server.ts`) is a **loopback-only
HTTP listener** (`hostname: '127.0.0.1'` by default) that Claude Code's own
`http`-type hook POSTs directly to on the same machine — it never touches the
WebSocket transport, the signaling relay, or any of the relay's encryption
machinery (ADR 0009: encryption is scoped to the relay; direct connections,
including this loopback path, carry none by design, not by omission). The
server's own doc comment underscores this is a real attack surface in its own
right (#535: any local process, including a browser page, can POST a forged
hook body to it — mitigated by an `Origin`-header refusal, not by scoping).
The point for this document: a decision made in the hook layer (what remi
registers, what it answers) has zero bearing on relay transport security, and
vice versa — they are two separate trust boundaries that happen to both sit
in front of the same daemon.

---

## What's pending: the capture corpus (#886 part 2)

**Not included in this PR, and not fabricated to look included.** #886's
second deliverable is a scrubbed fixture corpus built from a week of real
Claude Code sessions run with `REMI_HOOK_DEBUG=1` (and `REMI_QUESTION_TRACE=1`
for the question-lifecycle side), checked into the repo, that a drift test
would validate this document's types against on every future Claude Code
upgrade. That requires running the owner's real daily sessions over
real work for about a week — it is not something producible inside this PR,
and guessing at what such a capture would show would be exactly the kind of
unverified claim ADR 0011 exists to prevent.

Concretely still open:

- No drift test exists. `hook-types.ts`'s new/corrected fields are verified
  against static extraction from the 2.1.220 binary, which is strong evidence
  for *shape* but cannot observe *runtime frequency*, *ordering*, or
  *version-to-version stability* the way a capture corpus would.
- The `agent_type` common-field tension (structural-vs-empirical, above) needs
  a live agent-teams capture to resolve.
- The `Notification.notification_type` values left out (Chrome-bridge /
  desktop-notification-looking ones) need a capture to confirm whether any of
  them can actually arrive via the `Notification` hook.
- The sequential-tool-permission-hook-dispatch assumption
  (`auto-approve-gate.ts`'s duplicate-re-request cancellation) is **explicitly
  unverified** — see the PR description's "What I could NOT verify"
  section. This is the #885 epic's named experiment and needs a live,
  targeted capture (fire two identical-signature `PermissionRequest`s and
  observe dispatch order), not the general-purpose corpus above.

Until the corpus exists, treat every **[B]**-tagged claim in this document as
"true of the 2.1.220 binary's static shape," not "observed live," and
re-verify anything load-bearing before building on it across a Claude Code
version boundary.
