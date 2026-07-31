/**
 * Authority — the human's own typed turns, threaded into the auto-approve
 * prompt as a bounded-power context block (Q9, #893; plan Part 2 in
 * `.context/plan-eval-quality-and-question-lifecycle.md`).
 *
 * ## Two sources, one PRIMARY
 *
 * `UserPromptSubmit` (newly registered, hook-types.ts) hands the daemon the
 * human's typed input DIRECTLY — `prompt`, verbatim, no transcript parsing.
 * The DESIGN INTENT is that this makes the primary path structurally safe:
 * no `<local-command-stdout>`-shaped hazard, because Claude Code should only
 * ever put the human's own keystrokes in this field.
 *
 * **That premise is UNVERIFIED, not confirmed** — tracked as #938. It is
 * specifically the `!`-bash-mode question: does a `!`-prefixed command's
 * `UserPromptSubmit.prompt` carry the literal typed text, or the command's
 * OUTPUT (the same shape the transcript's `<local-command-stdout>` entries
 * show)? Nobody has captured this live yet. Because the premise is
 * unverified, `hook-bridge-setup.ts`'s `UserPromptSubmit` listener also runs
 * `isWrappedNonHumanText` (below) over `input.prompt` before recording it —
 * DEFENSE IN DEPTH, not confirmation. If the premise holds, that check is a
 * permanent no-op costing one substring scan on a human-paced event. If the
 * premise is wrong, it is the thing that catches the wrapped-string shape of
 * the failure (though NOT an output shape with no wrapper tag at all, which
 * would need #938's answer to even know exists). Do not read the presence of
 * that filter as evidence the premise was checked.
 *
 * `AuthorityStore` below is the primary source itself — a per-session,
 * in-memory ring buffer fed by the hook listener in `hook-bridge-setup.ts`.
 *
 * The transcript JSONL is the FALLBACK, load-bearing for a session the
 * daemon attached to mid-conversation (a resume): its prior turns exist only
 * in the transcript, because `UserPromptSubmit` never fired for them. Measured
 * across real transcripts under `~/.claude/projects/...` (#893 issue thread;
 * corrected after an audit caught a first-pass miscount), a `role: "user"`
 * entry is NOT reliably a human-typed prompt:
 *
 *   | shape                                              | count |
 *   |------------------------------------------------------|-------|
 *   | content: [ {type: tool_result} ]                     | 5,518 |
 *   | content: <string>, isMeta absent -> genuinely typed  |   703 |
 *   | content: <string>, isMeta: true                      |    88 |
 *   | content: <string> starting <command-name>            |    36 |
 *   | content: <string> starting <local-command-stdout>    |    34 |
 *
 * The `isMeta: true` row breaks down as: 47 "Another Claude session sent a
 * message: <agent-message from=\"...\">..." (a SUBAGENT's own authored text,
 * delivered in a plain "user"-role string entry), 35 `<local-command-caveat>`
 * notices, 5 scheduled/heartbeat task prompts, and 2 `<system-reminder>`.
 *
 * TWO SEPARATE MECHANISMS handle this, because ONE discriminator does not
 * cover both hazards:
 *
 * 1. **`tool_result`** is excluded structurally by shape: it is array-shaped
 *    and carries no top-level `text` block (`extractUserEntryText` below,
 *    mirroring `transcript-message-bridge.ts`'s `extractTextContent`). No
 *    flag needed.
 * 2. **The `isMeta: true` cohort** (agent messages, local-command-caveat,
 *    scheduled tasks, system-reminders) IS structurally separable — Claude
 *    Code stamps every one of these `isMeta: true` at the entry's top level
 *    (`transcript/types.ts`). This is the important one to get right: an
 *    `<agent-message>` entry is a SUBAGENT's own words in a user envelope —
 *    filtering ONLY on `role === "user"` + `typeof content === "string"`
 *    would let a subagent write its own authority, a more direct injection
 *    than anything requiring human action. `extractUserEntryText` checks
 *    `entry.isMeta` FIRST, before any content-shape logic, specifically so
 *    this cohort can never slip through by content shape alone.
 * 3. **`<command-name>` and `<local-command-stdout>`** (confirmed: 0 of 36
 *    and 0 of 34 sampled entries carry `isMeta`) are NOT structurally
 *    separable from a genuine prompt at all — same role, same type
 *    (`string`), same shape, no flag. Only the textual wrapper distinguishes
 *    them. `isWrappedNonHumanText` below is a DENYLIST for exactly this
 *    residual case, and denylists fail open: a wrapper tag Claude Code adds
 *    tomorrow sails straight through until someone notices and adds it here.
 *    Whether `<local-command-stdout>` is reachable via a `!`-prefixed bash-
 *    mode command specifically is UNCONFIRMED — the only two samples actually
 *    inspected for this issue ("Goodbye!", "Set model to Fable 5...") are
 *    slash-command output (`/exit`, `/model`), not `!` bash-mode; the general
 *    hazard (this content is Claude-influenceable, not necessarily
 *    human-authored) stands on the samples themselves regardless of exactly
 *    which channel produces it.
 *
 * That asymmetry (isMeta catches one cohort structurally, a denylist catches
 * the other only until it doesn't) is precisely why the hook is the PRIMARY
 * source and this filter only guards the fallback path — see
 * `resolveAuthority`.
 *
 * ## The trust boundary
 *
 * Authority (from EITHER source) may only LOWER escalation for an operation
 * already low/moderate risk under the default guidelines. It must NEVER
 * override the DENY FLOOR and NEVER turn a catastrophic operation into an
 * approve. `enforceAuthorityBoundary` is the CODE-level backstop for that
 * rule — deliberately blind to the model's own reasoning, so it cannot be
 * argued out of the constraint by adversarial authority text ("the user said
 * always approve rm -rf /"). It re-checks the SAME catastrophic patterns the
 * prompt's DENY FLOOR names, in plain TypeScript, after the LLM has already
 * decided, and downgrades a surprising approve to escalate rather than
 * silently trusting the model to have honored the prompt-level instruction.
 */

import type { ContentBlock, UserEntry } from '../transcript/types.ts';
import { matchSubstringPattern } from './pattern-matcher.ts';

/** Hard caps so a very long session's authority block cannot balloon the
 *  prompt (latency, and a bigger haystack for the model to get lost in).
 *  Per the plan: "start with raw + cap, add summarization only if measurement
 *  demands it." */
const MAX_AUTHORITY_ENTRIES = 20;
const MAX_AUTHORITY_CHARS = 4000;

/** Join separator between individual recorded/extracted turns. */
const TURN_SEPARATOR = '\n---\n';

/** Keep the MOST RECENT text when over the char cap — the latest turn is the
 *  most decision-relevant one, and truncating from the front preserves it. */
function capAuthorityText(text: string, maxChars: number = MAX_AUTHORITY_CHARS): string {
  if (text.length <= maxChars) return text;
  return `...${text.slice(text.length - maxChars)}`;
}

/**
 * Per-session, in-memory PRIMARY authority store, fed by the `UserPromptSubmit`
 * hook listener. `record` is an array push + occasional shift — cheap enough
 * to call from the listener itself (hook-types.ts:660 policy: a registered
 * listener must be a map lookup or a cheap store, nothing heavier, since
 * `HookServer.dispatch` runs it synchronously before Claude Code's blocked
 * hook response).
 */
export class AuthorityStore {
  private readonly prompts: string[] = [];

  constructor(private readonly maxEntries: number = MAX_AUTHORITY_ENTRIES) {}

  /** Record one human-typed turn, verbatim from `UserPromptSubmitHookInput.prompt`. */
  record(prompt: string): void {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    this.prompts.push(trimmed);
    if (this.prompts.length > this.maxEntries) this.prompts.shift();
  }

  /** True once at least one turn has been recorded this session. Used by
   *  `resolveAuthority` to decide primary-vs-fallback. */
  get hasEntries(): boolean {
    return this.prompts.length > 0;
  }

  /** Capped, newline-joined summary of the recorded turns, most-recent-last. */
  summary(): string {
    return capAuthorityText(this.prompts.join(TURN_SEPARATOR));
  }

  /** Drop every recorded turn (session rotation — /clear, /resume, /compact's
   *  restart case — must not let a PRIOR conversation's authority leak into a
   *  fresh one). */
  clear(): void {
    this.prompts.length = 0;
  }
}

/**
 * Wrapper-tag prefixes that mark a transcript "user"-role STRING entry as
 * something other than genuine human-typed text, for the residual cohort
 * that does NOT carry `isMeta` (confirmed: 0 of 36 `<command-name>` and 0 of
 * 34 `<local-command-stdout>` sampled entries do — see the module doc). A
 * DENYLIST — see the module doc for why that is an accepted, explicitly-named
 * risk here rather than an oversight. `<local-command-caveat>` and
 * `<system-reminder>` are ALSO listed here for defense in depth even though
 * both were observed carrying `isMeta: true` in the sampled data (the
 * `isMeta` check below already excludes them) — belt and suspenders in case
 * a future Claude Code version stops stamping the flag on one of them.
 *
 * `'Another Claude session sent a message:'` is a DIFFERENT shape than the
 * rest of this list: the real captured samples (module doc) put a
 * human-readable preamble sentence BEFORE the `<agent-message from="...">`
 * tag, so the entry does not start with a tag at all — a plain prefix match
 * against `<agent-message` would miss it. This entry matters MORE than the
 * others on the PRIMARY (hook) path specifically: `UserPromptSubmitHookInput`
 * (`hook-types.ts`) carries no `isMeta` field at all — that flag exists only
 * on transcript entries — so if a cross-session agent message is EVER
 * delivered through `UserPromptSubmit.prompt` (unconfirmed; same epistemic
 * status as the `!`-bash-mode question, #938), this literal-sentence prefix
 * is the ONLY defense available on that path. On the transcript fallback it
 * is pure redundancy on top of the `isMeta` check.
 */
const NON_HUMAN_WRAPPER_PREFIXES: readonly string[] = [
  '<command-name>',
  '<command-message>',
  '<local-command-stdout>',
  '<local-command-caveat>',
  '<system-reminder>',
  'Another Claude session sent a message:',
];

/** True if a user-role string entry is a wrapped non-human artifact (slash
 *  command echo, `!`-command output, injected reminder) rather than something
 *  the human actually typed.
 *
 *  Also imported directly by `transcript/transcript-message-bridge.ts` and
 *  `transcript/transcript-discovery.ts` (#936) — the same display-provenance
 *  hazard applies to what renders as a user chat bubble and what surfaces as
 *  a session-list preview, not just to the auto-approve authority block.
 *  Import from here rather than redefining the list elsewhere, so all three
 *  call sites can never drift into different denylists. */
export function isWrappedNonHumanText(text: string): boolean {
  const trimmed = text.trimStart();
  return NON_HUMAN_WRAPPER_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/**
 * Extract genuine human-typed text from one transcript user entry, or null
 * when there is none. Checks, in order:
 *
 * 1. `entry.isMeta === true` -> excluded UNCONDITIONALLY, before any content
 *    inspection. This is the structural discriminator for the cohort content
 *    shape cannot distinguish at all: a cross-session `<agent-message
 *    from="...">` (a SUBAGENT's own authored text in a "user"-role string —
 *    the highest-value case to exclude, since filtering only on
 *    `role === "user"` + `typeof content === "string"` would let a subagent
 *    write its own authority), `<local-command-caveat>` notices, scheduled/
 *    heartbeat task prompts, and `<system-reminder>`s. See the module doc's
 *    measured breakdown.
 * 2. Array content -> only top-level `text` blocks count, mirroring
 *    `transcript-message-bridge.ts`'s `extractTextContent` — a `tool_result`
 *    block (Claude's own tool output riding a user envelope) is never
 *    text-typed and so is dropped by construction, not by an extra check.
 * 3. String content -> excluded when wrapper-tagged (the RESIDUAL cohort
 *    `isMeta` does not cover — see `NON_HUMAN_WRAPPER_PREFIXES`); otherwise
 *    it is exactly what a human typed.
 */
export function extractUserEntryText(entry: UserEntry): string | null {
  if (entry.isMeta === true) return null;
  const content = entry.message.content;
  if (typeof content === 'string') {
    const trimmed = content.trim();
    if (!trimmed) return null;
    if (isWrappedNonHumanText(trimmed)) return null;
    return trimmed;
  }
  const text = content
    .filter((block): block is ContentBlock & { type: 'text' } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
  return text ? text : null;
}

/**
 * Build an authority summary from transcript user entries — the FALLBACK
 * source (#893). Filters to genuine human-typed text (see
 * `extractUserEntryText`), keeps the most recent `maxEntries`, and caps total
 * length the same way `AuthorityStore.summary()` does.
 */
export function buildAuthorityFromTranscript(
  entries: readonly UserEntry[],
  maxEntries: number = MAX_AUTHORITY_ENTRIES,
): string {
  const texts: string[] = [];
  for (const entry of entries) {
    const text = extractUserEntryText(entry);
    if (text !== null) texts.push(text);
  }
  const recent = texts.slice(-maxEntries);
  return capAuthorityText(recent.join(TURN_SEPARATOR));
}

/**
 * Resolve the authority text for one evaluation: prefer the live
 * `UserPromptSubmit`-fed store; fall back to the transcript ONLY when the
 * store has recorded nothing yet (a resumed session whose prior turns predate
 * this daemon's `UserPromptSubmit` registration, so the hook never fired for
 * them). Once the store has ANY entries it is used exclusively — the two
 * sources are not merged, matching the issue's "primary source" /
 * "hardened fallback" framing rather than a blend.
 *
 * `getUserEntries` is called lazily (only when the store is empty) so a
 * live session with hook data never pays for a transcript read.
 */
export function resolveAuthority(
  store: AuthorityStore,
  getUserEntries: () => readonly UserEntry[],
): string {
  if (store.hasEntries) return store.summary();
  return buildAuthorityFromTranscript(getUserEntries());
}

/**
 * Catastrophic-operation patterns, mirroring the DENY FLOOR bullets in
 * `prompt-builder.ts`'s SYSTEM_PROMPT_BODY. Independent of user config: the
 * `deny`/`deny_groups` lists default to EMPTY (`config.ts`), so without this,
 * "the DENY FLOOR" is enforced ONLY by asking the LLM nicely — exactly the
 * mechanism a poisoned authority block could try to talk around. This list
 * covers only the crisply substring-matchable subset (the exfiltration bullet
 * needs real judgment and is deliberately NOT here) — a second, narrower
 * denylist, same caveat as `NON_HUMAN_WRAPPER_PREFIXES` above: it is defense
 * in depth on top of the prompt instruction, not a replacement for it.
 */
const CATASTROPHIC_PATTERNS: readonly string[] = [
  'rm -rf /',
  'sudo rm',
  'rm -rf /etc',
  'rm -rf /usr',
  'rm -rf /System',
  '| sh',
  '| bash',
  'chmod 777',
];

/** True if this tool call matches a hardcoded catastrophic pattern. Exported
 *  for tests; `enforceAuthorityBoundary` is the real call site. */
export function matchesCatastrophicPattern(
  toolName: string,
  toolInput: Record<string, unknown>,
): string | null {
  return matchSubstringPattern(toolName, toolInput, CATASTROPHIC_PATTERNS);
}

export interface AuthorityBoundaryResult {
  readonly decision: 'approve' | 'deny' | 'escalate';
  /** True when this call downgraded the decision. */
  readonly overridden: boolean;
  readonly matchedPattern?: string;
}

/**
 * The trust boundary itself (#893). Called AFTER the LLM has produced its
 * verdict, with no visibility into (and so no way to be swayed by) its
 * reasoning text. Only ever downgrades `approve` -> `escalate`, and only when
 * BOTH an authority block was present in this eval's prompt AND the operation
 * matches a hardcoded catastrophic pattern. Never touches `deny` (already the
 * safe direction) or `escalate` (already not approved). Never produces `deny`
 * itself — escalating lets the human answer directly, matching this
 * codebase's existing "deny is rare" philosophy (`prompt-builder.ts`) rather
 * than silently blocking on a pattern match that could be a false positive.
 *
 * Scoped to authority-influenced evals ONLY (`authorityPresent`): a
 * non-authority eval's DENY FLOOR is unchanged by #893, exactly as it was
 * before this issue — extending this backstop to every eval is a reasonable
 * future hardening, not part of this issue's scope.
 */
export function enforceAuthorityBoundary(
  toolName: string,
  toolInput: Record<string, unknown>,
  decision: 'approve' | 'deny' | 'escalate',
  authorityPresent: boolean,
): AuthorityBoundaryResult {
  if (!authorityPresent || decision !== 'approve') {
    return { decision, overridden: false };
  }
  const matched = matchesCatastrophicPattern(toolName, toolInput);
  if (matched === null) {
    return { decision, overridden: false };
  }
  return { decision: 'escalate', overridden: true, matchedPattern: matched };
}
