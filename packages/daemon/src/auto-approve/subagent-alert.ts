/**
 * SubagentAlerter — after-the-fact notification for destructive tool calls made
 * by a background agent (#807).
 *
 * ## Why this exists
 *
 * A call the session's own Claude allow rules permit runs without a prompt:
 * Claude fires no `PermissionRequest` for it, for a background subagent, a
 * foreground subagent and the main agent alike (measured on Claude Code
 * 2.1.287, ADR 0031). Nothing reaches a phone for it, so that silent branch
 * is where a destructive background command disappears. It is not
 * hypothetical on a permissive allowlist: a settings file carrying
 * `Bash(bash:*)` allows `bash -c "rm -rf ~"` outright.
 *
 * ## How it is fed (#1155)
 *
 * The hook bridge feeds it every subagent tool call it admits
 * (`hook-bridge-setup.ts`), since only the tool hooks see the silent branch:
 *   - an agent-tagged `PreToolUse` whose call matches a pattern is
 *     remembered (`noteToolStarted`);
 *   - a `PermissionRequest` for that call (it prompted: a terminal session
 *     shows the dialog and pushes its "answer at the terminal" notice, a
 *     daemon or hub session holds an answerable card) or a `PermissionDenied`
 *     (it did not run) forgets it (`notePrompted`);
 *   - its `PostToolUse` or `PostToolUseFailure` (it ran, never having
 *     prompted) returns the alert to deliver (`noteToolFinished`), subject to
 *     the rate limit below;
 *   - the agent's `SubagentStop` forgets its calls (`noteAgentStopped`).
 * So one tool call produces at most one artifact on the phone: the prompt's
 * notice or card when it prompted (the actionable one), the alert when it
 * did not. The price is timing: the alert arrives when the call finishes,
 * the first moment remi knows Claude ran it without asking, so a
 * long-running command's alert comes at its end. Delivering at `PreToolUse`
 * instead could not know whether a prompt (about 10 ms later) or an
 * auto-mode classifier denial would follow, and would claim "was allowed to
 * run" for calls that were then asked about or refused.
 *
 * Before #1155 it was fed from the gate's subagent `PermissionRequest`
 * passthrough, which is exactly the event the silent branch never fires: it
 * alerted only for calls that prompted (a duplicate of their notice) and
 * never for the allowlisted calls it documents.
 *
 * ## What this deliberately is NOT
 *
 * It does not gate anything. The command RUNS. This is an alert, chosen over a
 * blocking hold by owner decision (2026-07-24): holding a subagent's hook
 * stalls that agent until answered, which on a session running a fleet of
 * parallel agents risks wedging real work. The
 * trade is explicit — this closes the VISIBILITY gap (you find out at once
 * instead of never) and not the INTERDICTION gap.
 *
 * Consequently the push carries no `category` and no `options`, exactly like
 * `ForeignSessionEscalator.pushInformational`: iOS renders action buttons only
 * for the three registered categories (REMI_YN / REMI_YNA / REMI_MULTI, see
 * `AppDelegate.swift`), so a push with neither is a plain dismiss-only banner.
 * Nothing is answerable, so nothing routes an answer back into a PTY — the
 * failure mode that module doc calls the evil twin of #538.
 *
 * It is likewise NOT routed through `sessionRegistry.addQuestion`: a Question
 * in the store is a thing awaiting an answer, and would become a phantom card
 * (#798/#799) with no resolution path.
 *
 * ## Rate limiting is load-bearing, not polish
 *
 * Alert patterns are matched as substrings, and useful patterns are broad
 * (`curl`, `ssh`). A session driving many concurrent agents fires these
 * constantly against benign traffic — a review agent pulling from the GitHub
 * API hits `curl` on every call. Unthrottled this becomes a push storm that
 * trains the user to ignore the banner, which costs more safety than it buys.
 * So identical (pattern, command) pairs collapse within a window, and the
 * tracking map is bounded.
 */

import { stableToolInputKey } from './tool-input-key.ts';

/**
 * The first alert pattern this call matches, or `null`.
 *
 * Deliberately BROAD, the way the deleted auto-approve deny list matched (it
 * shared this exact rule until #1125 removed that list): an alert that misses
 * is worse than one that over-fires, and the rate limit below absorbs the
 * over-firing.
 *
 * - `Bash`: a plain substring search over `command`.
 * - Any other tool: a substring search over its `command` field when it
 *   carries one (#1020: a command-executing tool under another name must not
 *   slip past), then an exact match on the bare tool name.
 */
export function matchAlertPattern(
  toolName: string,
  toolInput: Record<string, unknown>,
  patterns: readonly string[],
): string | null {
  if (patterns.length === 0) return null;
  const command = toolInput['command'];
  if (typeof command === 'string' && command.length > 0) {
    for (const pattern of patterns) {
      if (pattern.length > 0 && command.includes(pattern)) return pattern;
    }
  }
  if (toolName === 'Bash') return null;
  for (const pattern of patterns) {
    if (pattern === toolName) return pattern;
  }
  return null;
}

/** Suppress a repeat alert for the same (pattern, command) within this window.
 *  Long enough to collapse an agent's retry loop over one command; short
 *  enough that the same destructive command an hour later still tells you. */
const ALERT_WINDOW_MS = 5 * 60_000;

/** Cap on tracked (pattern, command) keys. A long session with many distinct
 *  matched commands must not grow this without bound; the oldest entries are
 *  evicted first (they are the ones whose window has most likely lapsed). */
const MAX_TRACKED_KEYS = 256;

/** One subagent tool call as a tool hook reports it (#1155). */
export interface SubagentToolCall {
  /** The call's `tool_use_id`; a `PermissionRequest` carries none. */
  readonly toolUseId: string | undefined;
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly agentId: string | undefined;
  /** The agent's type, when the hook carried one. */
  readonly agentType?: string | undefined;
}

/** The `SubagentToolCall` a tool hook's input describes. */
export function subagentCall(input: {
  readonly tool_name: string;
  readonly tool_input: Record<string, unknown>;
  readonly tool_use_id?: string | undefined;
  readonly agent_id?: string | undefined;
  readonly agent_type?: string | undefined;
}): SubagentToolCall {
  return {
    toolUseId: input.tool_use_id,
    toolName: input.tool_name,
    toolInput: input.tool_input,
    agentId: input.agent_id,
    agentType: input.agent_type,
  };
}

/** What the hook bridge needs to drive the alerts (#1155): the daemon-wide
 *  alerter and the delivery of an alert it returns (a log line and a
 *  `subagent_alert` push, in `cli.ts`). */
export interface SubagentAlertSink {
  readonly alerter: SubagentAlerter;
  readonly deliver: (alert: SubagentAlert) => void;
}

/** Cap on remembered calls that have not finished. A call whose finish never
 *  arrives (its session died mid-call) must not pin memory; the oldest are
 *  dropped first, which only loses an alert for a call that never ended. */
const MAX_PENDING_CALLS = 256;

/** The call identity used to pair a call's hooks when one carries no
 *  `tool_use_id`: its agent, tool and input. */
function callSignature(call: SubagentToolCall): string {
  return `${call.agentId ?? ''}\u0000${call.toolName}\u0000${stableToolInputKey(call.toolInput)}`;
}

/**
 * What the alerter keeps of a remembered call: only what its alert and its
 * pairing need, never the whole tool input (a `Write`'s file content, a long
 * heredoc). `command` is the input's `command` string, when it has one: the
 * only field the patterns and the alert read (`matchAlertPattern`, `check`).
 */
interface PendingCall {
  readonly toolName: string;
  readonly command: string | undefined;
  readonly agentId: string | undefined;
  readonly agentType: string | undefined;
  /** `callSignature` of the call, computed once at its start. */
  readonly signature: string;
}

/** What a matched alert reports to its sink. */
export interface SubagentAlert {
  /** The alert pattern that matched. */
  readonly pattern: string;
  /** Tool that was invoked (Bash, Write, ...). */
  readonly toolName: string;
  /** For Bash, the command string; otherwise the tool name. Already truncated
   *  for display — never assume it is the complete command. */
  readonly detail: string;
  /** The background agent's id, when the hook carried one. */
  readonly agentId: string | undefined;
  /** The agent's type (e.g. 'general-purpose'), when the hook carried one. */
  readonly agentType: string | undefined;
}

/** How much of a matched command to carry into the notification. A push body
 *  is truncated by the OS anyway, and the whole point is recognition, not a
 *  full audit record (the daemon log keeps that). */
const DETAIL_MAX = 160;

export interface SubagentAlerterDeps {
  /** Clock override for tests. Defaults to Date.now. */
  readonly nowMs?: () => number;
}

export class SubagentAlerter {
  /** (pattern, command) key -> epoch-ms of the last alert fired for it. */
  private readonly lastAlerted = new Map<string, number>();

  /** Matching calls started and not yet finished, prompted or stopped, by
   *  `tool_use_id` (or `callSignature` when the hook carried none), oldest
   *  first (#1155). */
  private readonly pendingCalls = new Map<string, PendingCall>();

  constructor(
    private readonly patterns: readonly string[],
    private readonly deps: SubagentAlerterDeps = {},
  ) {}

  /**
   * Match a subagent tool call against the alert patterns.
   *
   * Returns the alert to fire, or `null` when nothing matched or the same
   * (pattern, command) already alerted inside the window. Pure apart from the
   * rate-limit bookkeeping: the caller owns delivery, so a push failure cannot
   * be confused with "no match" and this stays trivially testable without a
   * network.
   */
  check(
    toolName: string,
    toolInput: Record<string, unknown>,
    agentId: string | undefined,
    agentType: string | undefined,
  ): SubagentAlert | null {
    const pattern = matchAlertPattern(toolName, toolInput, this.patterns);
    if (pattern === null) return null;

    const command = typeof toolInput['command'] === 'string' ? toolInput['command'] : toolName;
    const now = this.deps.nowMs?.() ?? Date.now();
    // Key on the FULL command, not the truncated detail: two different
    // commands sharing a 160-char prefix are different events and must both
    // alert.
    const key = `${pattern}\u0000${command}`;
    const last = this.lastAlerted.get(key);
    if (last !== undefined && now - last < ALERT_WINDOW_MS) return null;

    this.lastAlerted.set(key, now);
    this.evictIfOver();

    return {
      pattern,
      toolName,
      detail: command.length > DETAIL_MAX ? `${command.slice(0, DETAIL_MAX)}...` : command,
      agentId,
      agentType,
    };
  }

  /**
   * A subagent tool call started (its agent-tagged `PreToolUse`, #1155).
   * Remembered only when it matches a pattern; nothing is delivered yet,
   * since a prompt for it may follow.
   */
  noteToolStarted(call: SubagentToolCall): void {
    if (matchAlertPattern(call.toolName, call.toolInput, this.patterns) === null) return;
    const signature = callSignature(call);
    const key = call.toolUseId ?? signature;
    const command = call.toolInput['command'];
    this.pendingCalls.delete(key);
    this.pendingCalls.set(key, {
      toolName: call.toolName,
      command: typeof command === 'string' ? command : undefined,
      agentId: call.agentId,
      agentType: call.agentType,
      signature,
    });
    const over = this.pendingCalls.size - MAX_PENDING_CALLS;
    if (over > 0) {
      for (const oldest of [...this.pendingCalls.keys()].slice(0, over)) {
        this.pendingCalls.delete(oldest);
      }
    }
  }

  /**
   * The call prompted (`PermissionRequest`) or Claude refused it
   * (`PermissionDenied`): the human sees its prompt (a notice or a card), or
   * it did not run, so it never alerts (#1155). A `PermissionRequest`
   * carries no `tool_use_id`, so it forgets every remembered call of the same
   * agent, tool and input: an identical call would prompt the same way.
   */
  notePrompted(call: SubagentToolCall): void {
    if (call.toolUseId !== undefined) {
      this.pendingCalls.delete(call.toolUseId);
      return;
    }
    const signature = callSignature(call);
    for (const [key, pending] of [...this.pendingCalls]) {
      if (pending.signature === signature) this.pendingCalls.delete(key);
    }
  }

  /**
   * The call finished (`PostToolUse` or `PostToolUseFailure`) without ever
   * prompting: Claude ran it on its own allow rules. Returns the alert to
   * deliver, or null when the call was not remembered (no match, it
   * prompted) or the rate limit absorbs it (#1155).
   */
  noteToolFinished(call: SubagentToolCall): SubagentAlert | null {
    const key = call.toolUseId ?? callSignature(call);
    const pending = this.pendingCalls.get(key);
    if (pending === undefined) return null;
    this.pendingCalls.delete(key);
    // The patterns and the alert read only `command` from the input.
    const input = pending.command === undefined ? {} : { command: pending.command };
    return this.check(pending.toolName, input, pending.agentId, pending.agentType);
  }

  /** The agent stopped (`SubagentStop`): forget its unfinished calls. */
  noteAgentStopped(agentId: string): void {
    for (const [key, pending] of [...this.pendingCalls]) {
      if (pending.agentId === agentId) this.pendingCalls.delete(key);
    }
  }

  /** Drop the oldest entries once the map exceeds its cap. */
  private evictIfOver(): void {
    const over = this.lastAlerted.size - MAX_TRACKED_KEYS;
    if (over <= 0) return;
    const oldestFirst = [...this.lastAlerted.entries()].sort((a, b) => a[1] - b[1]);
    for (const [key] of oldestFirst.slice(0, over)) {
      this.lastAlerted.delete(key);
    }
  }

  /** Forget all rate-limit state and remembered calls. */
  reset(): void {
    this.lastAlerted.clear();
    this.pendingCalls.clear();
  }
}

/** Notification title for a matched alert. Kept short: iOS truncates hard. */
export function alertTitle(alert: SubagentAlert): string {
  const who = alert.agentType ?? 'Background agent';
  return `${who} ran a flagged command`;
}

/** Notification body. States plainly that the command already ran (it is
 *  delivered when the call finished, #1155), so the banner is never mistaken
 *  for a prompt awaiting an answer. */
export function alertBody(alert: SubagentAlert): string {
  return `Matched "${alert.pattern}" and was allowed to run: ${alert.detail}`;
}
