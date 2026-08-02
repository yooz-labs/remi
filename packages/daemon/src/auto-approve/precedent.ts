/**
 * Precedent — a per-session, in-memory record of operations a HUMAN actually
 * answered, keyed on answer PROVENANCE (#976 prerequisite, ADR 0015
 * "Amendment, 2026-08-02"). ADDITIVE ONLY: this module records data and
 * exposes a pure matcher; nothing in the decision path consumes it yet. A
 * later change wires a consumer in (`enforceAuthorityBoundary`-style, after
 * the model, never before it).
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
 */

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
 * as to classifying the answer.
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

  return { toolName, signature: action };
}

/**
 * Exact-match approval lookup (ADR 0010: allow-shaped, must be precise).
 * Iterates most-recent-first so a hit surfaces the freshest precedent.
 * Pure: operates over a plain array, no I/O, safe to call on every eval once
 * a consumer exists. Normalizes BOTH the query signature and each stored
 * record's own signature before comparing — `PrecedentStore.record` already
 * normalizes what it stores, but this function must not silently rely on
 * that: a `PrecedentRecord[]` built directly (a test, a future caller that
 * bypasses the store) is exactly as comparable as one built through it.
 */
export function findApprovedPrecedent(
  records: readonly PrecedentRecord[],
  toolName: string,
  signature: string,
): PrecedentMatch | null {
  const target = normalizeSignature(signature);
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (!record) continue;
    if (record.decision !== 'approved') continue;
    if (record.toolName !== toolName) continue;
    const storedSignature = normalizeSignature(record.signature);
    if (storedSignature !== target) continue;
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
 */
export function findDeniedPrecedent(
  records: readonly PrecedentRecord[],
  toolName: string,
  signature: string,
): PrecedentMatch | null {
  const target = normalizeSignature(signature);
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (!record) continue;
    if (record.decision !== 'denied') continue;
    if (record.toolName !== toolName) continue;
    const storedSignature = normalizeSignature(record.signature);
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
 * NOT wired to any consumer by this change. `matchApproved` / `matchDenied`
 * exist so a later PR can call them without reaching into `records` directly
 * (kept private), and so this module's own tests can exercise the matchers
 * through the same surface a real consumer would use.
 */
export class PrecedentStore {
  private readonly records: PrecedentRecord[] = [];

  constructor(private readonly maxEntries: number = MAX_PRECEDENT_ENTRIES) {}

  /**
   * Record one human-classified answer. `toolName` and `signature` are
   * expected pre-extracted (e.g. via `parsePermissionQuestionText`) — this
   * method only normalizes and stores, it does not parse. A blank tool name
   * or signature (after normalization) is refused rather than stored as a
   * useless entry that could still occupy a cap slot.
   */
  record(toolName: string, signature: string, decision: 'approved' | 'denied'): void {
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
