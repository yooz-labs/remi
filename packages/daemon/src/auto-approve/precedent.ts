/**
 * Precedent — a per-session, in-memory record of operations a HUMAN actually
 * answered, keyed on answer PROVENANCE (#976 prerequisite, ADR 0015
 * "Amendment, 2026-08-02").
 *
 * WIRED as of #976, in both directions, and the two are placed differently on
 * purpose (`auto-approve-service.ts`):
 *
 *   - **approve, PRE-model, 0ms** — an exact match authorizes a repeat, bounded
 *     by `matrixDecision` (so `critical` still never approves and `high`
 *     approves only on the non-text witness a precedent carries). Pre-model
 *     because a repeat should cost nothing, and because a 0ms verdict never
 *     loses the prompt-lifetime race (#998). Gated on
 *     `auto_approve.session_precedent`.
 *   - **deny, POST-model, approve-only** — a broad match downgrades a model
 *     approve to escalate, exactly like `enforceDenyFloor` /
 *     `enforceRiskCeiling` / `enforceAuthorityBoundary` next to it. NOT gated
 *     on that flag: turning off "reuse my yes" must not also discard "I
 *     already said no."
 *
 * The decision path receives a `PrecedentReader` (below), never the store, so
 * the single-writer property this module's whole provenance argument rests on
 * is structural rather than a convention anyone has to remember.
 *
 * ## Why provenance, not "the prompt was answered"
 *
 * ADR 0015's amendment allows a HIGH authorization grade (`explicit`,
 * `scoped`) to decide a verdict, but only when it was "established by...a
 * human ANSWER to a question remi presented (card or client), code-verified
 * session precedent, or the user's own `config.toml`" — never by text alone,
 * because text is exactly the channel an injection can reach. This module is
 * that "code-verified session precedent" source, and the whole point is
 * moot if a MACHINE-typed answer could feed it: that would launder the
 * gate's own model verdicts into human precedent and then authorize future
 * approvals from them — a self-licensing loop (ADR 0015, "Obligations this
 * creates").
 *
 * `record()` below is therefore called from exactly ONE place:
 * `handleAnswer` in `cli/handlers/input-events.ts`. That function is where
 * EVERY client-claimed answer converges, regardless of transport — verified
 * by tracing every caller of `events.onAnswer` / `events.onAnswerRelay`
 * (2026-08-02, this module's own PR):
 *
 *   - WebSocket `answer` message: `server/connection.ts:497` `handleAnswer`
 *     -> `:512` `this.events.onAnswer?.(...)` -> wired in `cli.ts` to
 *     `inputHandlers.onAnswer` -> `input-events.ts:789` -> `handleAnswer`.
 *   - HTTP `POST /answer` (lock-screen relay, lands on a cold WebSocket):
 *     `server/websocket-server.ts:451` `handleAnswerRelay` -> `:545`
 *     `this.events.onAnswerRelay(...)` -> wired in `cli.ts:2042` to
 *     `inputHandlers.relayAnswer` -> `input-events.ts:816` -> `handleAnswer`.
 *   - Signaling relay adapter: `remote/relay-adapter.ts:571`
 *     `this.events.onAnswer?.(...)`.
 *   - Telegram bot: `adapters/telegram-adapter.ts:889`
 *     `this.events.onAnswer?.(...)`.
 *
 * A HUMAN answer that never goes through `handleAnswer` at all is also never
 * recorded: `onUserInput` (`input-events.ts`) writes raw attach-client
 * keystrokes and free-form terminal input straight to the PTY, with no
 * `Question` and no classification step. So a human who answers a rendered
 * prompt by typing directly in the terminal, instead of tapping a card or
 * using a client's answer affordance, gets no precedent recorded for that
 * answer. This is the safe direction (a missed precedent, not a false one)
 * and matches ADR 0015's amendment scoping explicit/scoped authority to "a
 * human ANSWER to a question remi presented (**card or client**...)" — do
 * not read this gap as a bug; it is this module's stated scope.
 *
 * The MACHINE path — an auto-approve verdict typed into a RENDERED subagent
 * prompt under ADR 0004 — does not go through any of those. It is
 * `AutoApproveGate.arbitrateParkedRender` (`auto-approve-gate.ts:1837`) ->
 * `answerRenderedParked` (`:1973`) -> `inject` (`:2159`) ->
 * `session.pty.submitInput` (`pty/pty-session.ts:247`) directly. That is the
 * SAME PTY-write method a human answer eventually reaches too (via
 * `handleAnswer`'s own `session.pty.submitInput` call), with NO actor
 * parameter on either side — so nothing observing PTY bytes, or the Claude
 * Code hook events that follow, can tell machine from human. Confirmed:
 * `inject` never calls `handleAnswer`, `onAnswer`, or any `events.onAnswer*`
 * hook, and its success path (`markHandled`, `auto-approve-gate.ts:1720`)
 * fires only `tracker.onAutoApproveHandled` + the `onHandled` cue — never
 * `onResolved` / `question_resolved` (that broadcast is fired by
 * `handleAnswer`'s own `finally` block and, separately, by the gate's OWN
 * held/superseded cleanup paths below — never by `inject`). A grep across
 * `packages/daemon/src` for every call site of `handleAnswer` / `.onAnswer` /
 * `relayAnswer` turned up only the four client-facing surfaces above; nothing
 * in `auto-approve/*.ts` calls any of them.
 *
 * The gate's two other resolution paths that could plausibly stand in for a
 * "the question got answered somehow" signal both resolve to `'passthrough'`
 * and never fabricate approve/deny, so neither is a precedent source either:
 * `failOpenHeld` (`auto-approve-gate.ts:1085`, a hold timing out unconfirmed)
 * and `resolveSupersededQuestion` (`:2353`, an externally-resolved or
 * duplicate escalation) both call `releaseHeld(..., 'passthrough', ...)` —
 * "we cannot know what the user actually decided, so 'no decision from us'
 * is the only safe response" (the latter's own doc comment).
 *
 * This is a STRUCTURAL property, not a convention: `record()` is not exported
 * from `auto-approve/index.ts` (deliberately, per this PR's scope) and the
 * ONLY module that imports `PrecedentStore` to call `.record()` is
 * `input-events.ts`. It would break if a future change routed an
 * auto-answered verdict through `handleAnswer` itself (e.g. "for consistency,
 * let's have the gate call the same answer path a human uses") — that is
 * exactly the self-licensing loop ADR 0015 warns about, and it would not be
 * visible from this file alone. Anyone doing that must re-derive provenance
 * some other way (an explicit actor tag threaded through `handleAnswer`,
 * checked before `record()` runs) rather than relying on today's structural
 * separation.
 *
 * ## The allow/deny asymmetry (ADR 0010)
 *
 * Precedent MATCHING authorizes future work, so it is allow-shaped and must
 * be precise, mirroring `pattern-matcher.ts`'s `matchAllowPattern` /
 * `matchSubstringPattern` split for the identical reason: "An allow rule that
 * matches too much silently grants permission. A deny rule that matches too
 * little silently withholds a block." (ADR 0010). Concretely:
 *
 *   - `findApprovedPrecedent` requires an EXACT match (same tool, same
 *     whitespace-normalized signature). A command differing by one flag, one
 *     path, or an added redirection is a DIFFERENT operation and must not
 *     match — the failure this avoids is a stale approval silently covering
 *     a more dangerous variant of the same command family.
 *   - `findDeniedPrecedent` matches BROADLY (same tool, substring either
 *     direction). The failure this avoids is the mirror image: a denial that
 *     technically doesn't re-fire for a near-identical repeat of the exact
 *     thing the user just said no to.
 *
 * If precision on the approve side ever looks like it should loosen (fuzzy
 * matching, argument-shape matching, path-prefix matching), that needs a
 * measurement first — same discipline ADR 0015 imposed on authority grading —
 * not an inline judgment call. None is attempted here.
 *
 * ## Truncation (CRITICAL, found in independent review, 2026-08-02)
 *
 * `Question.text` — this module's ONLY source for a signature — is not the
 * raw command. `HookEventBridge.summarizeToolInput` (`hooks/hook-event-
 * bridge.ts:621` for Bash, `:647` for the generic path/url/description
 * fallback) truncates anything over 120 characters to exactly `117 chars +
 * "..."`. Left unhandled, two DIFFERENT commands sharing their first 117
 * characters collapse to the identical signature, so approving one
 * exact-matches the other — reachable in ordinary use in this very repo,
 * whose paths routinely exceed 120 characters, not just adversarially.
 * `isTruncatedSignature` below detects that shape; `record()` and both
 * match functions refuse it outright, in both directions. A missed
 * precedent (nothing is recorded/matched for a >120-character command) is
 * the safe direction; a false exact-match on a truncated signature is the
 * privilege-escalation direction this whole module exists to prevent.
 * **Precedent does not currently cover any command/path/url/description
 * over 120 characters** — a real, user-visible gap, not a theoretical one.
 * The proper long-term fix is threading the untruncated value through
 * `Question` and `buildPermissionQuestion` itself; that touches the shared
 * protocol type and is out of scope for this store, tracked as #990.
 *
 * ### Round 2 (independent review, 2026-08-02): the check was evadable
 *
 * The first fix (above) checked the truncation shape AFTER
 * `normalizeSignature` had already run. `normalizeSignature` collapses
 * whitespace RUNS (2+ consecutive whitespace characters) to one — and a
 * genuinely truncated 120-character detail containing such a run (a double
 * space, a tab next to a space, an indented line after a newline — ordinary
 * shell formatting, not even adversarial: an attacker who wants the
 * collision just adds a space) normalizes SHORTER than 120, so the
 * `=== 120` check silently missed it. Fixed by moving every truncation
 * check to run on the RAW, pre-normalization value: `record()` and both
 * match functions' query-side checks now check `isTruncatedSignature`
 * BEFORE calling `normalizeSignature`, not after. `parsePermissionQuestionText`
 * needed no change — it never normalized before checking in the first
 * place, verified empirically (not just by re-reading the code — see this
 * module's own test suite). See `isTruncatedSignature`'s doc for the full
 * argument, including why the check is also now a floor (`>=120`) rather
 * than an exact match, and why `record()`'s raw-value check — not the match
 * functions' stored-side check — is the authoritative boundary.
 */

import { summarizeToolInput } from '../hooks/tool-summary.ts';

/** One human-classified answer to a permission-shaped question. */
export interface PrecedentRecord {
  /**
   * The tool this operation was for (`Bash`, `Read`, `Write`, ...). Kept
   * separate from `signature` (rather than requiring every caller to re-split
   * it back out) so a consumer can filter/log by tool without re-parsing, and
   * so an exact-match comparison can short-circuit on tool identity before
   * touching the (usually longer) signature string.
   */
  readonly toolName: string;
  /**
   * The whitespace-normalized operation text this precedent applies to —
   * `<toolName>: <command/path/pattern/...>` for a tool with a summarizable
   * argument, or just `<toolName>` when there was none. This is the actual
   * match key; see `normalizeSignature` for exactly what normalization does
   * and does not do.
   */
  readonly signature: string;
  /** What the human decided for this exact operation. */
  readonly decision: 'approved' | 'denied';
  /**
   * `Date.now()` at record time. Not consulted by the matchers below (no
   * expiry logic exists yet), but a consumer that wants to bound precedent by
   * recency, or simply explain "approved 4 minutes ago" in a log line, needs
   * it captured at the point of truth rather than reconstructed later.
   */
  readonly recordedAt: number;
}

/**
 * Result of a precedent match: enough for a caller to log WHY it matched,
 * not just that it did.
 */
export interface PrecedentMatch {
  readonly decision: 'approved' | 'denied';
  /** The STORED signature that matched (not the query signature) — for an
   *  exact match this equals the query; for a substring match it may be a
   *  shorter or longer string than the query, and seeing which is often the
   *  useful part of the log line. */
  readonly matchedSignature: string;
  /** `'exact'` for an approval match, `'substring'` for a denial match — the
   *  asymmetry made visible at the call site, not just in this module's doc. */
  readonly matchKind: 'exact' | 'substring';
  readonly recordedAt: number;
}

/** Cap on stored records per session. Sized independently of
 *  `AuthorityStore`'s `MAX_AUTHORITY_ENTRIES` (20): that cap bounds how much
 *  raw text gets injected into an LLM prompt (a latency/context-budget
 *  concern), while precedent is compared programmatically and never enters a
 *  prompt, so its only cost is memory. 100 is generous enough to cover a
 *  long session's distinct approved/denied operations without unbounded
 *  growth. */
const MAX_PRECEDENT_ENTRIES = 100;

/**
 * Collapse whitespace runs (including newlines) to a single space and trim.
 * This is the ONLY normalization performed — no stripping of flags, paths,
 * arguments, or redirections, per ADR 0010's precision requirement for an
 * allow-shaped match. Whitespace collapsing is the one transformation the
 * task spec calls out as provably safe; it is also the only one applied
 * anywhere else in this codebase for comparable purposes (see
 * `tool-question.ts`'s `cleanText`).
 *
 * Known residual imprecision, noted rather than hidden (AGENTS.md "Verify
 * before you describe"): if a command's semantics depend on the EXACT amount
 * of internal whitespace inside a quoted argument (rare, but not provably
 * impossible), collapsing could theoretically equate two distinct commands.
 * No case in this codebase's test suite exercises that; if one is ever
 * found, it argues for a stricter normalizer, not for abandoning collapsing
 * entirely (the alternative — no collapsing at all — reintroduces spurious
 * MISSES from incidental whitespace, which is the safe-but-annoying
 * direction rather than the dangerous one).
 */
function normalizeSignature(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Length `summarizeToolInput` (`hooks/tool-summary.ts`, since #976; it lived
 *  as a private method on `HookEventBridge` before that) produces when it
 *  truncates: 117 kept characters + this 3-character marker = 120 total,
 *  always, TODAY. `isTruncatedSignature` treats this as a floor, not an exact
 *  match — see its own doc for why.
 *
 *  Corrected while moving that function (AGENTS.md rule 3): this comment used
 *  to say Bash AND "the generic path/url/description fallback" truncate, which
 *  reads as though every summarized value is capped. Only TWO branches
 *  truncate — Bash's `command`, and the generic last-resort loop. The
 *  Read/Write/Edit `file_path`, the Glob/Grep `pattern` and the fetch `url`
 *  branches all return their value verbatim at any length. That is the SAFE
 *  direction for precedent (a full value is precisely matchable; nothing
 *  collides), but the old wording would have led someone auditing the
 *  truncation hole to believe a case was covered that this function never
 *  touches. */
const TRUNCATED_DETAIL_LENGTH = 120;
const TRUNCATION_MARKER = '...';

/**
 * True when `signature` carries the shape `summarizeToolInput` produces for
 * a truncated value — see "Truncation" in this module's doc for why this
 * matters (CRITICAL, found in review). Extracts the "detail" portion the
 * same way `parsePermissionQuestionText` does (everything after the first
 * `': '`, or the whole string when there is no colon — a bare tool name like
 * `Allow Read` is never truncated, only its argument is) and checks it
 * against the truncated shape.
 *
 * ## MUST be called on the RAW, pre-normalization value
 *
 * (Round 2, found in independent review, 2026-08-02.) `normalizeSignature`
 * collapses whitespace RUNS (2+ consecutive whitespace characters — a double
 * space, a tab next to a space, a newline followed by indentation) to a
 * single character. A genuinely truncated 120-character detail that happens
 * to contain such a run — ordinary shell formatting (aligned arguments,
 * indented heredocs/multi-line commands), not even adversarial — normalizes
 * SHORTER than 120 and this function then misses it entirely if called on
 * the normalized string. `parsePermissionQuestionText` was already correct
 * (it never normalizes before calling this); `record()` and both match
 * functions' QUERY-side checks previously called this on the NORMALIZED
 * value and are fixed in this same change to call it on the raw parameter
 * first. A STORED `PrecedentRecord.signature` cannot be un-normalized after
 * the fact (`record()` only ever stores the normalized form) — which is
 * exactly why `record()`'s raw-value check is the AUTHORITATIVE boundary
 * (a truncated raw value, whitespace-run or not, can never enter the store
 * once that check is correct) and the match functions' stored-side check is
 * a redundant, best-effort layer, not the reverse.
 *
 * ## Floor (`>=`), not exact match (`===`)
 *
 * `summarizeToolInput` produces EXACTLY 117+3 today, so `===` would be
 * precise for the current mechanism. `>=` is chosen instead: if that
 * constant ever drifts (the kept-character count changes), an exact-match
 * check would silently stop catching the new shape with no test failure to
 * flag it, reopening the truncation-collision vulnerability this function
 * exists to close. A floor keeps catching it. The cost is symmetrical with
 * the heuristic already accepted below (a longer genuine value that happens
 * to end in the marker is also refused) — both failure directions land on
 * "missed precedent," the safe one, never "false match."
 *
 * This is a heuristic, not a certainty: a genuine, untruncated value that
 * happens to be at least 120 characters and end in `...` (e.g. a command
 * that legitimately prints `"loading..."`) would also match and be refused.
 * That false positive costs a missed precedent — the safe direction, not
 * the dangerous one — so no attempt is made to distinguish it from a real
 * truncation; the alternative (treating it as untruncated) risks the exact
 * false-match this function exists to prevent.
 *
 * ## No `': '` separator: the whole signature is the detail
 *
 * (Found in independent review, 2026-08-02.) `<toolName>: <detail>` is a
 * convention of this file's own caller (`parsePermissionQuestionText`
 * always emits either that shape or a bare `<toolName>` with no detail at
 * all) — it is NOT something this function is entitled to assume about
 * every caller. `record()` is a public method on an exported class; a
 * future caller (the risk x authorization matrix this store is a
 * prerequisite for) could hand it a signature with no colon that is
 * nonetheless a raw, truncated value. Treating "no colon" as "therefore
 * short and safe" — the previous behavior, which fell through to an empty
 * `detail` and so could never be flagged truncated — is a guard that fails
 * OPEN on a shape it does not recognize, exactly the pattern this module
 * exists to avoid. When there is no separator, the WHOLE signature is
 * checked as the detail instead: a bare 120+ character value ending in the
 * marker is still caught, and an ordinary short bare value (a real tool
 * name) is unaffected, since it is nowhere near the length floor.
 */
function isTruncatedSignature(signature: string): boolean {
  const colonIndex = signature.indexOf(': ');
  const detail = colonIndex === -1 ? signature : signature.slice(colonIndex + 2);
  return detail.length >= TRUNCATED_DETAIL_LENGTH && detail.endsWith(TRUNCATION_MARKER);
}

/**
 * Parse the `Question.text` shape `HookEventBridge.buildPermissionQuestion`
 * deterministically produces for a plain (non-question-bearing-tool)
 * permission request:
 *
 *   - main agent, with a summarizable argument: `Allow <tool>: <detail>`
 *   - main agent, no summarizable argument:     `Allow <tool>`
 *   - subagent, with a summarizable argument:   `<agent_type> · <tool>: <detail>`
 *   - subagent, no summarizable argument:       `<agent_type> · <tool>`
 *
 * Returns null for anything else, INCLUDING the question-bearing-tool shape
 * (ExitPlanMode / AskUserQuestion via `extractToolQuestion`, e.g. "Plan ready
 * for review...") — deliberately not handled here, because those questions'
 * options are always PICKS (`isYes`/`isNo` both false by construction in
 * `tool-question.ts`'s `pickOption`), so `mapAnswerToDecision` in
 * `input-events.ts` already returns null for every answer to one before this
 * parser is ever called. This function does not need to (and does not try
 * to) defend against a shape its only caller cannot reach.
 *
 * Pure and total: never throws, never guesses. A caller unsure what it got
 * back gets `null`, not a best-effort partial parse — "record only the cases
 * you can classify with confidence" applies to parsing the text just as much
 * as to classifying the answer. This INCLUDES a truncated `action` (see
 * `isTruncatedSignature`, and "Truncation" in this module's doc): a
 * truncated value cannot be a precise signature, so it is refused here at
 * the source, before `handleAnswer` ever has something to hand `record()`.
 */
export function parsePermissionQuestionText(
  text: string,
): { readonly toolName: string; readonly signature: string } | null {
  const ALLOW_PREFIX = 'Allow ';
  const AGENT_SEPARATOR = ' · ';

  let action: string;
  if (text.startsWith(ALLOW_PREFIX)) {
    action = text.slice(ALLOW_PREFIX.length);
  } else {
    const sepIndex = text.indexOf(AGENT_SEPARATOR);
    if (sepIndex === -1) return null;
    action = text.slice(sepIndex + AGENT_SEPARATOR.length);
  }
  if (!action) return null;

  const colonIndex = action.indexOf(': ');
  const toolName = (colonIndex === -1 ? action : action.slice(0, colonIndex)).trim();
  if (!toolName) return null;

  if (isTruncatedSignature(action)) return null;

  return { toolName, signature: action };
}

/**
 * Build the signature for an operation being CONSULTED (#976), from the raw
 * `(toolName, toolInput)` the gate has at decision time — before any
 * `Question` exists to parse.
 *
 * This is the mirror of `parsePermissionQuestionText`, which is the RECORD
 * side, and the two must produce byte-identical strings for the same operation
 * or an exact match silently never fires. That failure is invisible: precedent
 * just never matches, which is indistinguishable from "the user has not
 * approved this before."
 *
 * The identity is structural, not careful: both sides bottom out in
 * `summarizeToolInput` (`hooks/tool-summary.ts`), which is why that function
 * was lifted out of `HookEventBridge` in this same change. Record side parses
 * `Allow <tool>: <detail>` off a question BUILT from it; this side composes
 * `<tool>: <detail>` from it directly. A second implementation here is the
 * exact defect shape this module's area has produced repeatedly.
 *
 * Returns the bare tool name when there is no summarizable argument, matching
 * `buildPermissionQuestion`'s own `Allow <tool>` shape.
 *
 * No truncation check here: `findApprovedPrecedent` / `findDeniedPrecedent`
 * both refuse a truncated QUERY on the raw value (`isTruncatedSignature`), and
 * doing it in two places invites the two checks to disagree.
 */
export function signatureForOperation(
  toolName: string,
  toolInput: Record<string, unknown>,
): string {
  const detail = summarizeToolInput(toolName, toolInput);
  return detail === null ? toolName : `${toolName}: ${detail}`;
}

/**
 * Tools whose signature is the WHOLE operation, and which may therefore have a
 * past approval reused (#976). Everything else is evaluated normally, every
 * time.
 *
 * ## Why an allowlist and not "every tool"
 *
 * `signatureForOperation` is built from `summarizeToolInput`, whose job is to
 * produce ONE readable line for a lock-screen card. For most tools that line
 * names the TARGET and drops the PAYLOAD — which is fine for display and
 * catastrophic for authorization.
 *
 * Found in review of this PR's first draft, and measured against the real
 * functions rather than reasoned about:
 *
 *     Write {file_path: '~/.ssh/authorized_keys', content: <benign>}
 *     Write {file_path: '~/.ssh/authorized_keys', content: <attacker>}
 *     -> signatures IDENTICAL, matchApproved returns an EXACT hit,
 *        band=high grade=explicit witness=yes -> approve, at 0ms
 *
 * So one approved write to a path authorized every later write to that path,
 * with any content at all. `high` is precisely the band whose justification is
 * "a precedent carries the non-text witness text cannot supply" — and the
 * witness was real; the SIGNATURE was not. ADR 0010's "an allow rule that
 * matches too much silently grants permission" was defeated a layer below the
 * matcher, so the matcher's exactness guaranteed nothing.
 *
 * Per tool, why it is or is not here:
 *
 * | tool | summary | complete? |
 * |---|---|---|
 * | `Bash` | the full command | **yes** — the command IS the operation |
 * | `Read` | `file_path` | **yes** — a read has no payload; `offset`/`limit` narrow it, never widen it |
 * | `Write`/`Edit` | `file_path` only | no — `content` / `new_string` decide what actually happens |
 * | `Glob`/`Grep` | `pattern` only | no — the `path` it runs under is dropped, so `Grep: TODO` in a repo and in `/etc` are one signature |
 * | fetch/web | `url` | no — `prompt` is dropped, and the fetch is a network egress whose repeat deserves asking |
 * | anything else | first matching field | no — the generic fallback is incomplete BY CONSTRUCTION |
 *
 * Fails closed: an unrecognized tool is not eligible. A new tool added to
 * `summarizeToolInput` gets no precedent until someone decides its summary is
 * a complete identity, which is the direction that costs a question rather
 * than a compromise.
 *
 * ## The deny direction deliberately ignores this
 *
 * `findDeniedPrecedent` is a STOP rule (ADR 0010), so a content-blind
 * signature makes it match MORE, not less: a denied `Write` to a path flags
 * every later write to it. That is the safe direction and the intended one, so
 * the deny consult does not consult this list.
 */
const PRECEDENT_ELIGIBLE_TOOLS: ReadonlySet<string> = new Set(['bash', 'terminal', 'read']);

/**
 * May a past approval of `toolName` authorize a repeat? See
 * `PRECEDENT_ELIGIBLE_TOOLS` for the rule and the measured failure that
 * produced it.
 *
 * Case-insensitive, matching `summarizeToolInput`'s own dispatch, so a tool
 * spelled `bash` does not slip past a check written for `Bash`.
 */
export function precedentMayAuthorize(toolName: string): boolean {
  return PRECEDENT_ELIGIBLE_TOOLS.has(toolName.toLowerCase());
}

/**
 * Read-only view of a `PrecedentStore` (#976).
 *
 * The decision path receives THIS, never the store, so `handleAnswer` remains
 * the single writer BY CONSTRUCTION rather than by convention. That matters
 * more than it reads: ADR 0015's whole provenance argument collapses if the
 * gate can record its own verdicts, because the gate TYPES approvals into
 * rendered subagent prompts under ADR 0004 — a self-licensing loop where
 * machine approvals become "human precedent" that authorizes future machine
 * approvals. Handing out a reader makes that unrepresentable at the type level
 * instead of relying on nobody calling `record`.
 */
export interface PrecedentReader {
  matchApproved(toolName: string, signature: string): PrecedentMatch | null;
  matchDenied(toolName: string, signature: string): PrecedentMatch | null;
}

/**
 * Exact-match approval lookup (ADR 0010: allow-shaped, must be precise).
 * Iterates most-recent-first and returns based on the FRESHEST record for
 * this exact (tool, signature) pair, regardless of ITS decision — not the
 * freshest APPROVED one. That distinction is the point: if the human denied
 * the identical operation more recently than they approved it, the denial
 * wins and this returns null. Without that check, a stale approval could
 * silently outlive an explicit later "no" for the same exact thing (found
 * in independent review, 2026-08-02) — the freshest human decision must
 * govern, full stop.
 *
 * Also refuses outright — returns null immediately — when the QUERY
 * signature is truncated (`isTruncatedSignature`, checked on the RAW query
 * BEFORE normalization — see that function's doc, round 2, review
 * 2026-08-02), and skips any STORED record whose (already-normalized)
 * signature looks truncated, as if it were not there at all.
 *
 * Revised understanding (round 2): the query-side check here is NOT
 * redundant with the stored-side check, unlike what round 1 of this PR
 * claimed. The two checks now run on DIFFERENT representations — the query
 * on its raw form, a stored record on its only available (normalized) form
 * — so a raw-truncated query whose NORMALIZED form happens to coincide
 * with a real, unrelated, legitimately-stored (non-truncated) signature is
 * a genuine exact-match collision the stored-side check cannot see (the
 * stored record is not itself truncated-shaped). Refusing on the raw query
 * closes that too. Proven with a dedicated test (`precedent.test.ts`,
 * "a raw-truncated query does not coincidentally exact-match..."). The
 * OLD claim was true only because round 1 checked both sides
 * post-normalization, making a match possible only when the stored side
 * ALSO happened to look truncated post-normalization — that symmetry no
 * longer holds now that the query check moved to the raw value.
 *
 * `record()` refuses to store a truncated RAW signature (also fixed in
 * round 2 to check before normalizing), so in practice no stored record
 * should ever be truncated-shaped; the stored-side check here remains
 * defense in depth for a `PrecedentRecord[]` built directly (a test, a
 * future caller bypassing the store).
 *
 * Pure: operates over a plain array, no I/O, safe to call on every eval once
 * a consumer exists. Normalizes the query signature (AFTER the raw
 * truncation check) and each stored record's own signature before
 * comparing — `PrecedentStore.record` already normalizes what it stores,
 * but this function must not silently rely on that: a `PrecedentRecord[]`
 * built directly is exactly as comparable as one built through it.
 */
export function findApprovedPrecedent(
  records: readonly PrecedentRecord[],
  toolName: string,
  signature: string,
): PrecedentMatch | null {
  if (isTruncatedSignature(signature)) return null;
  const target = normalizeSignature(signature);
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (!record) continue;
    if (record.toolName !== toolName) continue;
    const storedSignature = normalizeSignature(record.signature);
    if (isTruncatedSignature(storedSignature)) continue;
    if (storedSignature !== target) continue;
    // First hit while scanning newest-first: the FRESHEST record for this
    // exact (tool, signature) pair. If the human's most recent word on it
    // was a denial (or anything other than an approval), that supersedes
    // any older approval -- there is nothing further back worth checking.
    if (record.decision !== 'approved') return null;
    return {
      decision: 'approved',
      matchedSignature: storedSignature,
      matchKind: 'exact',
      recordedAt: record.recordedAt,
    };
  }
  return null;
}

/**
 * Broad substring denial lookup (ADR 0010: a stop rule should over-reach
 * rather than under-reach). Matches either direction — the stored signature
 * contains the query, or the query contains the stored signature — so a
 * denial of a shorter command still flags a longer variant that embeds it,
 * and vice versa. Same tool required in both directions; unlike the
 * user-authored deny/`subagent_alert` patterns elsewhere in this codebase,
 * this is matching one FULL recorded operation against another, not a short
 * hand-written pattern against a full command, so requiring tool identity
 * does not narrow it the way it narrows nothing here — it is the one
 * dimension that should never be fuzzy even on the broad side.
 *
 * Unlike `findApprovedPrecedent`, this does NOT special-case a newer
 * approval superseding an older denial of the identical signature: deny
 * matching is intentionally broad (a stop rule should over-reach), so
 * continuing to flag a since-approved exact repeat is the same "safer to
 * over-trigger" bias ADR 0010 already applies everywhere else on this side —
 * it costs an extra LLM evaluation or escalation for a future consumer, not
 * a wrongly-granted approval. Not requested by review; noted here so a
 * future reader does not read the asymmetry as an oversight.
 *
 * Same truncation refusal as `findApprovedPrecedent`, same round-2 fix — the
 * check runs on the RAW query, BEFORE normalization (`isTruncatedSignature`'s
 * doc) — see there and "Truncation" in this module's doc. The query-side
 * check here is independently load-bearing for its OWN reason, distinct from
 * `findApprovedPrecedent`'s: because matching is a BROAD substring in both
 * directions, a truncated (120-char) query can legitimately CONTAIN a short,
 * genuinely stored, non-truncated denial signature somewhere inside its
 * opaque truncated portion — the truncation hides whether that embedded text
 * is really what the human is doing now, or an unrelated coincidence.
 * Refusing the query outright avoids matching (or failing to match) on data
 * this function cannot verify. Proven with a dedicated test
 * (`precedent.test.ts`, "a truncated QUERY does not broadly match...").
 */
export function findDeniedPrecedent(
  records: readonly PrecedentRecord[],
  toolName: string,
  signature: string,
): PrecedentMatch | null {
  if (isTruncatedSignature(signature)) return null;
  const target = normalizeSignature(signature);
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (!record) continue;
    if (record.decision !== 'denied') continue;
    if (record.toolName !== toolName) continue;
    const storedSignature = normalizeSignature(record.signature);
    if (isTruncatedSignature(storedSignature)) continue;
    if (!target.includes(storedSignature) && !storedSignature.includes(target)) continue;
    return {
      decision: 'denied',
      matchedSignature: storedSignature,
      matchKind: 'substring',
      recordedAt: record.recordedAt,
    };
  }
  return null;
}

/**
 * Per-session, in-memory precedent store. Cap-and-evict shape mirrors
 * `AuthorityStore` (`authority.ts`) deliberately — same "session rotation
 * must not leak into a fresh session" requirement, same array-push-and-shift
 * cheapness (`record` is called from a human-paced event, `handleAnswer`,
 * never from a hot path, but there is no reason to make it anything other
 * than cheap).
 *
 * WIRED as of #976. `matchApproved` / `matchDenied` are consumed by
 * `AutoApproveService.evaluate` — the first at 0ms before the model, the
 * second after it — through the read-only `PrecedentReader` above, never
 * through this class directly. `records` stays private so no consumer can
 * reach past the two matchers.
 *
 * (This comment said "NOT wired to any consumer by this change" until the
 * change that wired it. Corrected in the same PR, per AGENTS.md rule 3 — a
 * stale "nothing reads this" sitting above a class that now performs 0ms
 * auto-approvals is the exact shape of the documentation failure ADR 0011
 * exists for.)
 */
export class PrecedentStore {
  private readonly records: PrecedentRecord[] = [];

  constructor(private readonly maxEntries: number = MAX_PRECEDENT_ENTRIES) {}

  /**
   * Record one human-classified answer. `toolName` and `signature` are
   * expected pre-extracted (e.g. via `parsePermissionQuestionText`) — this
   * method only normalizes and stores, it does not parse. A blank tool name
   * or signature (after normalization), OR a truncated signature
   * (`isTruncatedSignature` — see "Truncation" in this module's doc,
   * CRITICAL, found in review), is refused rather than stored: the first is
   * a useless entry that could still occupy a cap slot, the second is a
   * signature this store cannot safely match precisely. `record()` checking
   * this too (not just `parsePermissionQuestionText`) is defense in depth
   * for any future caller that builds a signature some other way — and this
   * IS the authoritative truncation boundary for whatever is actually
   * stored: once this check is correct, no truncated raw signature can ever
   * reach `this.records`, so a stored record is never truncated in
   * practice (see `isTruncatedSignature`'s doc on why the match functions'
   * stored-side check is therefore redundant, not the reverse).
   *
   * The truncation check MUST run on the RAW `signature` parameter, BEFORE
   * `normalizeSignature` touches it (round 2, review 2026-08-02):
   * normalization collapses whitespace RUNS, which can shrink a genuinely
   * truncated 120-character detail below the threshold — ordinary shell
   * formatting (a double space, aligned arguments, an indented multi-line
   * command), not just an adversarial construction — and a check running
   * on the already-shrunk value would silently miss it.
   */
  record(toolName: string, signature: string, decision: 'approved' | 'denied'): void {
    if (isTruncatedSignature(signature)) return;
    const normalizedToolName = toolName.trim();
    const normalizedSignature = normalizeSignature(signature);
    if (!normalizedToolName || !normalizedSignature) return;
    this.records.push({
      toolName: normalizedToolName,
      signature: normalizedSignature,
      decision,
      recordedAt: Date.now(),
    });
    if (this.records.length > this.maxEntries) this.records.shift();
  }

  /** Number of currently-stored records. Test/debug convenience. */
  get size(): number {
    return this.records.length;
  }

  /** Precise, allow-shaped lookup — see `findApprovedPrecedent`. */
  matchApproved(toolName: string, signature: string): PrecedentMatch | null {
    return findApprovedPrecedent(this.records, toolName, signature);
  }

  /** Broad, deny-shaped lookup — see `findDeniedPrecedent`. */
  matchDenied(toolName: string, signature: string): PrecedentMatch | null {
    return findDeniedPrecedent(this.records, toolName, signature);
  }

  /** Drop every recorded precedent (session rotation — /clear, /resume,
   *  /compact's restart case — must not let a PRIOR conversation's precedent
   *  authorize or block anything in a fresh one). */
  clear(): void {
    this.records.length = 0;
  }
}
