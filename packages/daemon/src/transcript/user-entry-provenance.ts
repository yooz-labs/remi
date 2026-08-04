/**
 * User-envelope provenance — is a transcript "user"-role entry something the
 * human actually typed, or something Claude Code (or a subagent) put in that
 * role instead?
 *
 * This is a TRANSCRIPT concern, not an auto-approve one: `UserEntry`
 * (`types.ts`) is structurally identical whether a human typed it or Claude
 * Code injected it — same `role: "user"`, same `content: string`. This
 * module is what makes the two distinguishable at all, and it is consumed by
 * every layer that has its own reason to care:
 *
 *  - `transcript-message-bridge.ts`'s `handleUserEntry` — must not render an
 *    injected entry as a message the human sent (#936).
 *  - `transcript-discovery.ts` — must not surface an injected entry as a
 *    session-list preview (#936).
 *  - `auto-approve/authority.ts`'s `extractUserEntryText` — must not let an
 *    injected entry (especially a subagent's own words) become "authority"
 *    the auto-approve prompt trusts as the human's own instruction (#893).
 *
 * That last consumer is a POLICY layer built on top of this one, not the
 * other way round — import direction matters here specifically because a
 * change to (or removal of) the auto-approve module must never be able to
 * break transcript ingestion. Originally this lived inside `authority.ts`
 * and was imported backwards into the transcript module for #936; moved
 * here on review (same day) once that inversion was noticed.
 *
 * Measured across real transcripts under `~/.claude/projects/...` (#893
 * issue thread; corrected after an audit caught a first-pass miscount), a
 * `role: "user"` entry is NOT reliably human-typed:
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
 *    and carries no top-level `text` block. No flag needed — every consumer
 *    above filters to `text`-typed blocks only.
 * 2. **The `isMeta: true` cohort** (agent messages, local-command-caveat,
 *    scheduled tasks, system-reminders) IS structurally separable — Claude
 *    Code stamps every one of these `isMeta: true` at the entry's top level
 *    (`types.ts`). This is the important one to get right: an
 *    `<agent-message>` entry is a SUBAGENT's own words in a user envelope —
 *    filtering ONLY on `role === "user"` + `typeof content === "string"`
 *    would let a subagent's report render as the human's own chat message,
 *    or worse, write its own auto-approve authority. Every consumer checks
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
 * the other only until it doesn't) is why `isMeta` is the PRIMARY
 * discriminator at every call site, with this denylist as a residual /
 * defense-in-depth layer on top — never the reverse.
 */

/**
 * Wrapper-tag prefixes that mark a transcript "user"-role STRING entry as
 * something other than genuine human-typed text, for the residual cohort
 * that does NOT carry `isMeta` (confirmed: 0 of 36 `<command-name>` and 0 of
 * 34 `<local-command-stdout>` sampled entries do — see the module doc). A
 * DENYLIST — see the module doc for why that is an accepted, explicitly-named
 * risk here rather than an oversight. `<local-command-caveat>` and
 * `<system-reminder>` are ALSO listed here for defense in depth even though
 * both were observed carrying `isMeta: true` in the sampled data (each call
 * site's `isMeta` check already excludes them) — belt and suspenders in case
 * a future Claude Code version stops stamping the flag on one of them.
 *
 * `'Another Claude session sent a message:'` is a DIFFERENT shape than the
 * rest of this list: the real captured samples (module doc) put a
 * human-readable preamble sentence BEFORE the `<agent-message from="...">`
 * tag, so the entry does not start with a tag at all — a plain prefix match
 * against `<agent-message` would miss it. This entry matters MORE than the
 * others on `auto-approve/authority.ts`'s PRIMARY (hook) path specifically:
 * `UserPromptSubmitHookInput` (`hook-types.ts`) carries no `isMeta` field at
 * all — that flag exists only on transcript entries — so if a cross-session
 * agent message is EVER delivered through `UserPromptSubmit.prompt`
 * (unconfirmed; same epistemic status as the `!`-bash-mode question, #938),
 * this literal-sentence prefix is the ONLY defense available on that path.
 * On every other call site here it is pure redundancy on top of the
 * `isMeta` check.
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
 *  Consumed by `transcript-message-bridge.ts` and `transcript-discovery.ts`
 *  (#936) — DISPLAY surfaces, where the right failure direction is OPEN: an
 *  unrecognized wrapper renders as a chat message, which is noise. Dropping a
 *  message the human really typed would be worse.
 *
 *  NOT sufficient for the authority path — use `isNonHumanForAuthority` there.
 *  See its doc for the measured reason. */
export function isWrappedNonHumanText(text: string): boolean {
  const trimmed = text.trimStart();
  return NON_HUMAN_WRAPPER_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/**
 * Does the text OPEN with a markup tag (`<task-notification>`,
 * `<agent-message from="...">`, `<bash-input>`)? Shape-based, so it catches
 * wrappers this file has never heard of.
 *
 * Requires a letter-initial tag name so an arithmetic or prose `<` (`<5 min`,
 * `a < b`) is not mistaken for markup.
 */
function startsWithMarkupTag(text: string): boolean {
  return /^<[a-zA-Z][a-zA-Z0-9_-]*(\s|\/?>)/.test(text.trimStart());
}

/**
 * True if a user-role string must NOT be treated as the human's own words for
 * AUTHORITY purposes (#982). Strictly wider than `isWrappedNonHumanText`.
 *
 * ## Why the authority path needs its own, stricter predicate
 *
 * The two paths have OPPOSITE failure directions, exactly like allow vs deny
 * matching (ADR 0010). A display surface that wrongly drops text hides the
 * user's own message — bad. An authority surface that wrongly ACCEPTS text
 * lets a machine speak as the user into a permission decision — worse. So
 * display keeps the denylist and fails open; authority adds a shape rule and
 * fails CLOSED.
 *
 * ## The measurement that forced this (#982)
 *
 * `UserPromptSubmit` is authority's PRIMARY source, and `authority.ts`'s
 * premise was that Claude Code puts only the human's keystrokes there. Over a
 * live capture window (`~/.remi/hook-diag.jsonl`, 2026-07-31..08-02), of 206
 * prompts carrying text, **72 (35%) were machine-generated**: 69
 * `<task-notification>` and 3 `<agent-message>`. Every one PASSED
 * `isWrappedNonHumanText`, so all 72 were being recorded as the human's turns.
 *
 * Note the module doc above already flagged a cross-session agent message on
 * this path as possible but "unconfirmed". The 3 `<agent-message>` captures
 * confirm it.
 *
 * ## Why shape, not a wider denylist
 *
 * The denylist fails open by design (see the module doc), and #982 is three
 * proofs of that in one sample. Adding the three observed tags fixes today and
 * not tomorrow — the next wrapper Claude Code introduces is undiscoverable by
 * construction. A shape rule makes an UNKNOWN wrapper fail closed, which is the
 * only direction that survives a contract that keeps growing.
 *
 * Measured cost on the same 208-prompt corpus: **zero**. No human-typed prompt
 * began with `<` at all, tag-shaped or otherwise. The theoretical cost is a
 * human opening a message with a markup-looking tag, who loses that turn from
 * the authority window — a nuisance, and the safe direction.
 */
export function isNonHumanForAuthority(text: string): boolean {
  return isWrappedNonHumanText(text) || startsWithMarkupTag(text);
}
