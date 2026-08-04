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
 * `isWrappedNonHumanText` (`transcript/user-entry-provenance.ts`, imported
 * below) over `input.prompt` before recording it — DEFENSE IN DEPTH, not
 * confirmation. If the premise holds, that check is a permanent no-op
 * costing one substring scan on a human-paced event. If the premise is
 * wrong, it is the thing that catches the wrapped-string shape of the
 * failure (though NOT an output shape with no wrapper tag at all, which
 * would need #938's answer to even know exists). Do not read the presence of
 * that filter as evidence the premise was checked.
 *
 * `AuthorityStore` below is the primary source itself — a per-session,
 * in-memory ring buffer fed by the hook listener in `hook-bridge-setup.ts`.
 *
 * The transcript JSONL is the FALLBACK, load-bearing for a session the
 * daemon attached to mid-conversation (a resume): its prior turns exist only
 * in the transcript, because `UserPromptSubmit` never fired for them.
 * `extractUserEntryText` below is what makes that fallback safe — a
 * transcript `role: "user"` entry is NOT reliably a human-typed prompt. The
 * measured breakdown, and the two-mechanism `isMeta` + `isWrappedNonHumanText`
 * design that handles it, now live in `transcript/user-entry-provenance.ts`'s
 * module doc — the single source of truth, since the same provenance
 * question also applies to what `transcript-message-bridge.ts` renders as a
 * chat message and what `transcript-discovery.ts` shows as a session-list
 * preview (#936). That asymmetry (isMeta catches one cohort structurally, a
 * denylist catches the other only until it doesn't) is precisely why the
 * hook is the PRIMARY source and this filter only guards the fallback path —
 * see `resolveAuthority`.
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
import { isNonHumanForAuthority } from '../transcript/user-entry-provenance.ts';
import { matchesCatastrophicPattern as matchCatastrophic } from './deny-floor.ts';

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
 * `isWrappedNonHumanText` used to be defined here; moved to
 * `transcript/user-entry-provenance.ts` (#936 review) because it is
 * fundamentally a transcript user-envelope provenance concern — consumed by
 * `transcript-message-bridge.ts` and `transcript-discovery.ts` too, neither
 * of which should depend on the auto-approve policy layer to get it.
 * Re-exported here (rather than just imported) so existing consumers of
 * `auto-approve/index.ts` are unaffected. See that module's doc for the
 * full denylist rationale and the measured breakdown behind it.
 */
export {
  isNonHumanForAuthority,
  isWrappedNonHumanText,
} from '../transcript/user-entry-provenance.ts';

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
 *    `isMeta` does not cover — see `transcript/user-entry-provenance.ts`'s
 *    `NON_HUMAN_WRAPPER_PREFIXES`); otherwise it is exactly what a human
 *    typed.
 */
export function extractUserEntryText(entry: UserEntry): string | null {
  if (entry.isMeta === true) return null;
  const content = entry.message.content;
  if (typeof content === 'string') {
    const trimmed = content.trim();
    if (!trimmed) return null;
    // #982: authority-scoped predicate — fails CLOSED on any unknown
    // markup wrapper, unlike the display denylist.
    if (isNonHumanForAuthority(trimmed)) return null;
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
 * `CATASTROPHIC_PATTERNS` and `matchesCatastrophicPattern` used to be defined
 * here; moved to `deny-floor.ts` (#953) because the DENY FLOOR is not an
 * authority concern and TWO guards now share the list — one for each direction
 * across it (`enforceAuthorityBoundary` below stops authority talking the model
 * INTO a catastrophic approve; `enforceDenyFloor` stops the model denying
 * things the floor never covered). Same reasoning as #936's move of
 * `isWrappedNonHumanText`. Re-exported here so existing consumers of
 * `auto-approve/index.ts` and this module are unaffected.
 */
export { matchesCatastrophicPattern } from './deny-floor.ts';

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
  const matched = matchCatastrophic(toolName, toolInput);
  if (matched === null) {
    return { decision, overridden: false };
  }
  return { decision: 'escalate', overridden: true, matchedPattern: matched };
}
