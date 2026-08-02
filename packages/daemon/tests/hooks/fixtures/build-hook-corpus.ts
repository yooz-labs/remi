/**
 * Builds `hook-corpus.jsonl` (this directory), the fixture corpus
 * `contract-drift.test.ts` validates against `hook-types.ts` (#886 part 2).
 *
 * Run manually, NOT part of `bun test`:
 *   bun run packages/daemon/tests/hooks/fixtures/build-hook-corpus.ts \
 *     [--input ~/.remi/hook-diag.jsonl] [--output <path>]
 *
 * WHY this exists: `~/.remi/hook-diag.jsonl` (written by `hook-server.ts`'s
 * `REMI_HOOK_DEBUG=1` diagnostic dump) is real Claude Code hook traffic --
 * absolute paths across private repos (`cwd`, `transcript_path`), full file
 * contents inside `tool_input` for Write/Edit, arbitrary Bash command lines,
 * full tool output in `tool_response`, verbatim assistant prose in
 * `last_assistant_message`. This repo is PUBLIC. None of that can be
 * committed. This script redacts it before anything is written to a
 * tracked file.
 *
 * REDACTION IS AN ALLOWLIST, NEVER A DENYLIST (see AGENTS.md "Verify before
 * you describe" -- the whole point is that a field Claude Code adds in a
 * future version cannot leak by default just because nobody thought to deny
 * it). Only the exact top-level paths in VERBATIM_PATHS survive with their
 * real value; every other leaf, at any depth, becomes a type-preserving
 * placeholder (`<redacted:str:LEN>` / `0` / `false`) that keeps the JSON
 * shape so the drift test can still check field PRESENCE. `effort.level` is
 * the one nested exception, addressed by its own dotted path -- allowlist
 * matching is by exact path, not bare key name, specifically so a `reason`
 * or `source` key buried inside an arbitrary `tool_input` blob (e.g. a Bash
 * command's JSON argument) is never accidentally treated as the top-level
 * `reason`/`source` field and let through.
 *
 * Identifiers (session_id, prompt_id, agent_id, tool_use_id, elicitation_id)
 * are PSEUDONYMIZED, not redacted to a placeholder and not kept verbatim: a
 * stable per-run mapping from real value to a synthetic value of the same
 * shape, so cross-event correlation (same real session_id -> same fake
 * session_id) survives without exposing the real id. The mapping is a plain
 * monotonic counter fed through a deterministic mixing function -- not a
 * hash of the real value -- specifically so a fake id can never be reversed
 * back toward the real one even in principle.
 *
 * DOWN-SAMPLING: PreToolUse/PostToolUse dwarf every other event type (roughly
 * 5,300 of ~5,400 raw records at last count) and are the two Claude Code
 * fires most identically shaped -- almost all the variance is `tool_name`.
 * Every OTHER registered event type is kept in full (rare enough, and after
 * redaction small enough, that down-sampling would only cost coverage for no
 * size benefit). PreToolUse/PostToolUse are grouped by
 * (event, tool_name, sorted top-level key set) -- the key set captures
 * whether an event carries the subagent fields (agent_id/agent_type) or not
 * -- and up to PER_GROUP_CAP records are kept per group in original file
 * order (one exemplar plus a modest tail), so every distinct payload shape
 * this corpus has actually observed survives at least once.
 *
 * SCOPE: this script (and the corpus it produces) can only ever cover events
 * Claude Code actually sent, which is gated by
 * `REMI_REGISTERED_HOOK_EVENTS` -- remi registers only the events it
 * consumes (#203 design), so Claude Code has no URL to POST anything else
 * to. `UserPromptSubmit`, `MessageDisplay`, `TaskCreated`/`TaskCompleted`/
 * `TeammateIdle`, etc. are structurally uncapturable until their own
 * registration lands; their absence here is not evidence about their shape.
 * `PermissionDenied`/`Elicitation`/`ElicitationResult` were registered by
 * #926, after most of this corpus was captured, so they have zero fixtures
 * despite being registered -- see `EVENTS_WITHOUT_FIXTURES` in
 * `contract-spec.ts`.
 *
 * `SessionStart` WAS registered too (at the time this corpus was first
 * built) and STILL had zero fixtures, for a different and more interesting
 * reason: the installed Claude Code binary
 * (`~/.local/share/claude/versions/2.1.220`) explicitly discards
 * `http`-type hook registrations for `SessionStart`/`Setup` before dispatch.
 * The relevant minified source (found via the same `rg -a -o -P` extraction
 * method `docs/claude-code-hook-contract.md` uses, anchored on the
 * recognizable log string):
 *
 *   D=r==="SessionStart"||r==="Setup"?I.filter((x)=>{if(x.hook.type==="http")
 *   return w(`Skipping HTTP hook ${x.hook.url} — HTTP hooks are not
 *   supported for ${r}`),!1;return!0}):I;
 *
 * `hook-config-manager.ts:19` (`HookEntry.type: 'http'`) shows remi registers
 * EXCLUSIVELY via `http`-type hooks -- there is no code path that registers
 * `command`/`prompt`/`agent`-type hooks. So remi's SessionStart registration
 * was filtered out by Claude Code itself on every single session, silently
 * (the skip is logged only at Claude Code's own internal verbose level, which
 * remi has no visibility into) -- not a race with the hook server binding
 * (confirmed by reading `cli.ts`: `hookServer.start()` and
 * `hookConfigManager.install()` both complete, in that order, strictly
 * before the `claude` process is spawned), not a REMI_HOOK_DEBUG logging
 * gap (that write happens unconditionally at the top of `handleRequest`,
 * before dispatch, so it would catch a SessionStart POST if one ever
 * arrived). Filed as #930; remi unregistered `SessionStart` in response (same
 * issue) rather than build a `command`-type hook to recover it -- see
 * `docs/claude-code-hook-contract.md`'s "Corpus status" section for the
 * current state. `Setup` was never registered by remi at all, so its absence
 * needs no separate explanation.
 *
 * TEST CONTAMINATION HAZARD, discovered building this corpus: that same
 * "unconditional write" is exactly what makes `~/.remi/hook-diag.jsonl`
 * unsafe to treat as pure Claude Code traffic. `hook-server.test.ts` and
 * friends construct a REAL `HookServer` and POST real HTTP requests at it
 * (`session_id: 'test-session'`, `cwd: '/tmp/project'`,
 * `transcript_path: '/tmp/test.jsonl'`, etc.) to exercise `handleRequest` --
 * and `handleRequest` cannot distinguish a test's POST from Claude Code's,
 * so with `REMI_HOOK_DEBUG=1` set in the shell (as this repo's own `AGENTS.md`
 * / project memory tells you to do to build this exact corpus), running
 * `bun test packages/daemon/tests/hooks/` appends synthetic, FABRICATED
 * records to the same file real captures live in -- including a handful of
 * `SessionStart`/`UserPromptSubmit`/`UnknownEvent` rows that would otherwise
 * look like exactly the kind of surprising-but-real finding this corpus
 * exists to catch.
 *
 * FIX (#934): every diag line now carries a `_provenance` field
 * (`'live' | 'test'`, stamped by `src/debug/provenance.ts` at write time) --
 * data, not a path convention. `isSyntheticRecord` below filters PRIMARILY on
 * that field. `looksLikeTestFixture`'s `/tmp`-rooted `cwd`/`transcript_path`
 * signature is kept ONLY as a FALLBACK for records written before this field
 * existed (any `~/.remi/hook-diag.jsonl` captured with a pre-#934 daemon or
 * test run) -- it is not the mechanism anymore, just a bridge for historical
 * data, and it stays inert (never even consulted) once a file is entirely
 * `_provenance`-stamped. Do not read its continued presence here as "the
 * path heuristic is still how this works."
 *
 * ## `--mode structure-preserving` (#992)
 *
 * Everything above describes the DEFAULT mode (`--mode redact`, also the
 * default when `--mode` is omitted entirely) -- UNCHANGED by #992.
 * `corpus-replay.test.ts` replays the checked-in `hook-corpus.jsonl`, which
 * this default mode produced, and nothing about #992 may alter that file or
 * the logic that built it.
 *
 * `--mode structure-preserving` is a SEPARATE, additive mode for a different
 * consumer: `packages/daemon/tests/auto-approve/guard-chain-replay.test.ts`
 * needs to replay real `Bash` commands through `enforceDenyFloor` /
 * `enforceAuthorityBoundary` / `classifyRisk`, and those functions read
 * shell STRUCTURE (binary name, subcommands, flags, `&&`/`||`/`;`/`|`,
 * redirections, substitutions, quoting) out of `tool_input.command` -- the
 * exact content the default mode's blanket `<redacted:str:N>` placeholder
 * destroys. See the "Structure-preserving pseudonymization" section below
 * (near `pseudonymizeIdentities`) for what this mode does instead, and
 * `guard-chain-replay.test.ts`'s own header for why its output is never
 * committed.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// --- CLI args -------------------------------------------------------------

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

const INPUT_PATH = expandHome(argValue('--input') ?? '~/.remi/hook-diag.jsonl');

/**
 * `redact` (default, and what an omitted `--mode` also means) is the
 * ORIGINAL behavior -- untouched by #992. `structure-preserving` is the new,
 * additive mode; see the module doc's "`--mode structure-preserving`"
 * section.
 */
const MODE: 'redact' | 'structure-preserving' =
  argValue('--mode') === 'structure-preserving' ? 'structure-preserving' : 'redact';

/**
 * The structure-preserving default lands in `tests/auto-approve/fixtures/`
 * (a DIFFERENT directory from this file, gitignored, see `.gitignore`) --
 * deliberately not alongside `hook-corpus.jsonl`, so nothing about a normal
 * `redact`-mode run's file listing changes.
 */
const DEFAULT_OUTPUT_PATH =
  MODE === 'structure-preserving'
    ? path.join(
        import.meta.dir,
        '..',
        '..',
        'auto-approve',
        'fixtures',
        '.local-command-corpus.jsonl',
      )
    : path.join(import.meta.dir, 'hook-corpus.jsonl');

const OUTPUT_PATH = expandHome(argValue('--output') ?? DEFAULT_OUTPUT_PATH);

// --- Test-fixture contamination filter --------------------------------------

/**
 * FALLBACK ONLY (#934) -- true for a record that LOOKS like a synthetic test
 * payload by path convention, not real Claude Code traffic. See the "TEST
 * CONTAMINATION HAZARD" / "FIX (#934)" module doc notes above: this is no
 * longer the primary detection mechanism, `isSyntheticRecord` below is. Kept
 * for records captured before `_provenance` existed. Every hooks-test dummy
 * `cwd`/`transcript_path` in this repo is `/tmp`-rooted or the fixed
 * `/Users/dev/my-project` sentinel (`grep -rn "cwd:\|transcript_path:"
 * packages/daemon/tests/hooks/*.ts`); no real capture has ever had either.
 */
export function looksLikeTestFixture(record: Record<string, unknown>): boolean {
  const cwd = record['cwd'];
  const transcriptPath = record['transcript_path'];
  if (typeof cwd === 'string' && (cwd.startsWith('/tmp') || cwd === '/Users/dev/my-project')) {
    return true;
  }
  if (typeof transcriptPath === 'string' && transcriptPath.startsWith('/tmp')) {
    return true;
  }
  return false;
}

/**
 * True for a record this build should drop as synthetic (#934). Checks the
 * `_provenance` field FIRST -- data, not convention. Only when a record has
 * NO `_provenance` at all (written by a daemon/test predating this field)
 * does this fall back to `looksLikeTestFixture`'s path heuristic; a record
 * that explicitly says `_provenance: 'live'` is trusted and never re-checked
 * against the fallback, so a real capture that happens to run from a `/tmp`
 * cwd (unusual, but not impossible) is not misclassified now that a real
 * field exists to ask instead of guessing from the path.
 */
export function isSyntheticRecord(record: Record<string, unknown>): boolean {
  const provenance = record['_provenance'];
  if (provenance === 'test') return true;
  if (provenance === 'live') return false;
  return looksLikeTestFixture(record);
}

// --- Redaction allowlist ----------------------------------------------------

/**
 * Exact top-level paths whose real value survives verbatim. Everything else
 * is redacted, at every depth -- see the module doc comment above.
 *
 * `_ts` is remi's OWN addition (the capture timestamp `hook-server.ts`
 * stamps on each line), not Claude-Code-sourced content -- carries no path,
 * content, or identifier information, so it's added here (beyond the task's
 * suggested list) for chronological realism in the fixtures.
 *
 * `agent_type` was on this list; removed. It's a real `hook-types.ts`
 * contract field (a low-cardinality string in principle), but the actual
 * corpus's 22 distinct real values include issue-numbered subagent names
 * from real PR-review fanout runs (e.g. `review-198`, `review-420-code`) --
 * real workflow metadata, possibly naming private-repo issue numbers. The
 * drift test only asserts field PRESENCE, never a literal value (confirmed:
 * `grep -n agent_type contract-drift.test.ts contract-spec.ts` shows it used
 * only as a field-name string), so redacting the value costs nothing.
 */
const VERBATIM_PATHS = new Set<string>([
  'hook_event_name',
  'tool_name',
  'notification_type',
  'reason',
  'permission_mode',
  'stop_hook_active',
  'duration_ms',
  'is_interrupt',
  'trigger',
  'source',
  '_ts',
]);

/**
 * `trigger` and `source` are only ever sent by event types this corpus has
 * zero fixtures for today (Setup/PreCompact/PostCompact/ConfigChange/
 * DirectoryAdded/SessionStart -- none registered today; SessionStart WAS
 * registered but never dispatched before #930 unregistered it, see the
 * module doc comment). Kept in the allowlist anyway, inert on this data, so
 * a future corpus rebuild (once one of those events is registered) doesn't
 * need this script re-reviewed.
 */
const VERBATIM_NESTED_PATHS = new Set<string>(['effort.level']);

const IDENTIFIER_PATHS = new Set<string>([
  'session_id',
  'prompt_id',
  'agent_id',
  'tool_use_id',
  'elicitation_id',
]);

// --- Deterministic, non-reversible id pseudonymization ---------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let mixCounter = 0;

/** One deterministic 32-bit mix step, seeded ONLY by a monotonic counter --
 *  never by the real value -- so a fake id cannot be reverse-derived from
 *  the real one even in principle. */
function nextMix(): number {
  mixCounter += 1;
  let x = mixCounter;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = (x ^ (x >>> 16)) >>> 0;
  return x;
}

function fakeAlnumString(len: number): string {
  let out = '';
  while (out.length < len) {
    out += nextMix().toString(36);
  }
  return out.slice(0, len);
}

function fakeHexString(len: number): string {
  let out = '';
  while (out.length < len) {
    out += nextMix().toString(16).padStart(8, '0');
  }
  return out.slice(0, len);
}

function fakeUuid(): string {
  const hex = fakeHexString(32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Replaces every maximal run of alnum characters with a same-length fake
 * alnum run, leaving separators (-, _) in place -- preserves shape (length,
 * separator positions) for an id format this script doesn't specifically
 * recognize (e.g. `agent_id`'s `a<type>-<hex16>` shape, or a future
 * `elicitation_id`).
 */
function fakeShapePreserving(real: string): string {
  return real.replace(/[0-9a-zA-Z]+/g, (run) => fakeAlnumString(run.length));
}

function generateFakeId(real: string): string {
  if (UUID_RE.test(real)) return fakeUuid();
  if (real.startsWith('toolu_')) return `toolu_${fakeAlnumString(real.length - 'toolu_'.length)}`;
  return fakeShapePreserving(real);
}

/** field path -> (real value -> fake value). Stable for the lifetime of one
 *  script run, which is what "correlation survives within the corpus"
 *  requires -- the corpus is rebuilt wholesale each run, so cross-run
 *  stability is not needed (and deliberately not attempted: a hash-based
 *  cross-run-stable mapping would tie the fake value to the real one,
 *  reintroducing exactly the reversibility this design avoids). */
const idMaps = new Map<string, Map<string, string>>();

function pseudonymize(fieldPath: string, real: string): string {
  let perField = idMaps.get(fieldPath);
  if (!perField) {
    perField = new Map<string, string>();
    idMaps.set(fieldPath, perField);
  }
  const existing = perField.get(real);
  if (existing !== undefined) return existing;
  const fake = generateFakeId(real);
  perField.set(real, fake);
  return fake;
}

// --- Structure-preserving pseudonymization (`--mode structure-preserving`, #992) ----
//
// Scope: ONLY `tool_input.command` / `file_path` / `path` / `url` -- see
// `COMMAND_LIKE_PATHS` below, consulted from `redactValue`. Every other
// field, in EITHER mode, still gets the blanket type-preserving placeholder
// from `redactValue`'s default branch, so this section cannot widen what
// leaves this script unredacted beyond those four fields.
//
// Two passes, always in this order, over each of the four fields' raw
// string value:
//
//   1. `detectCredential` -- a REFUSAL check, not a redaction. If it matches,
//      the caller (`main`) drops the WHOLE record; this module never tries
//      to scrub-and-keep a credential-bearing value (see its own doc for
//      why: a partial scrub is a claim about completeness this script has
//      no way to back up).
//   2. `pseudonymizeIdentities` -- runs ONLY on a value that passed (1).
//      Replaces identity-bearing substrings (home directory, usernames,
//      hostnames, IPs, email addresses) with consistently-mapped fakes,
//      leaving every other character -- binary name, subcommand, flags,
//      `&&`/`||`/`;`/`|`, redirections, `$()`/backtick/`<()` substitutions,
//      quoting -- untouched. This is deliberately NOT a shell parser (same
//      posture as `deny-floor.ts`/`risk-bands.ts`, whose whole reason for
//      existing is to read this untouched text): it pattern-matches
//      identity SHAPES in the raw string rather than tokenizing first, so a
//      shape hidden behind quoting/substitution/variable expansion will not
//      be found. That is an honest limit, not a gap this script tries to
//      paper over -- see `guard-chain-replay.test.ts`'s header for the same
//      point made about the guards this corpus feeds.

/** Exact `tool_input.<key>` paths this mode treats specially. Everything
 *  else in `tool_input` (and the rest of the record) is unaffected by this
 *  section -- it still gets `redactValue`'s ordinary placeholder. */
const COMMAND_LIKE_PATHS = new Set<string>([
  'tool_input.command',
  'tool_input.file_path',
  'tool_input.path',
  'tool_input.url',
]);

/** The four `tool_input` keys `COMMAND_LIKE_PATHS` names, as bare keys --
 *  used by `main()` to pre-scan a record for a credential BEFORE deciding
 *  whether to keep it at all (a decision `redactValue`, which only sees one
 *  value at a time and returns a redacted value rather than a keep/drop
 *  verdict, cannot make by itself). */
const COMMAND_LIKE_KEYS = ['command', 'file_path', 'path', 'url'] as const;

export function collectCommandLikeValues(record: Record<string, unknown>): string[] {
  const toolInput = record['tool_input'];
  if (typeof toolInput !== 'object' || toolInput === null || Array.isArray(toolInput)) return [];
  const out: string[] = [];
  for (const key of COMMAND_LIKE_KEYS) {
    const value = (toolInput as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.length > 0) out.push(value);
  }
  return out;
}

/**
 * Joins a value the way the SHELL joins it before credential scanning
 * (PR #995 review finding 1). Two distinct multi-line shapes both split a
 * token across what this file's character-class-based rules see as two
 * separate, individually-too-short runs -- neither half of
 * `AIzaSyD9tSrykjUwHmk` + `3POiF5EpBLDXKrmnIA` (19 and 18 chars against
 * `hasHighEntropySecret`'s 20-char floor) trips anything alone, and no
 * named rule's character class includes `\` or a raw newline, so the
 * uncollapsed string lets the whole secret through unmatched:
 *
 * 1. **Backslash-newline line continuation** -- `\` immediately followed by
 *    a newline is an everyday idiom for a long `curl`/`git`/`aws`
 *    invocation, and the shell removes BOTH characters and joins the two
 *    lines with nothing in between (no space is inserted). Confirmed
 *    against this exact repo's own real capture: this is ordinary traffic,
 *    not a contrived construction.
 * 2. **A literal (non-backslash) newline preserved inside a double-quoted
 *    string**, or between the lines of a heredoc body -- the shell does
 *    NOT strip these; they become part of the argument verbatim. They are
 *    rarer in practice (an operator would need to have actually embedded a
 *    raw line break inside a credential value, not just wrapped a long
 *    line with `\`), but they split a token the identical way, through the
 *    identical mechanism (a `\n` no character class here matches), so this
 *    function does not try to tell the two shapes apart.
 *
 * The fix is one normalization, not two special cases: for DETECTION
 * purposes only, every `\r?\n` -- with or without a preceding backslash --
 * is deleted outright (never replaced with a space), which reproduces case 1
 * exactly and closes case 2 by the same stroke, including a heredoc body
 * (which is just several such joins in a row -- there is no heredoc-specific
 * handling because none is needed once newlines themselves are gone). This
 * can only make matching MORE likely to fire, never less (ADR 0010's err-
 * broad-in-the-safe-direction posture, same as every other choice in this
 * file) -- it never runs on the value actually written to the corpus, only
 * on the throwaway copy `detectCredential`/`hasHighEntropySecret` scan.
 */
function joinForCredentialScan(text: string): string {
  return text.replace(/\\?\r?\n/g, '');
}

/**
 * Shannon entropy in bits/char. Used only by `hasHighEntropySecret` below,
 * as one signal among several (length + charset diversity + this), never
 * alone -- see that function's doc for why.
 */
function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Deliberately EXCLUDES `/` and `.` even though both are valid base64/JWT
 * characters (`/` in standard base64; `.` between a JWT's three segments).
 * Measured against 45,111 real captured records (#992): including them made
 * `[A-Za-z0-9+/_.=-]{20,}` greedily swallow an entire multi-segment file
 * PATH as one "token" (`/` never breaks the match), and a real project path
 * mixing case and containing any digit anywhere (a version number, a port, a
 * dated filename -- not rare) then reads as high-entropy across its full
 * length. That inflated the drop rate to 29% of all real records, almost
 * all `file_path`/`path` values with no secret in them at all -- the
 * opposite of this backstop's job. Dropping `/`/`.` from the candidate
 * class costs coverage only on a secret that specifically embeds one of
 * those two characters AND has no other detectable shape (no recognized
 * prefix, no assignment form) -- narrower than losing a third of the corpus
 * to ordinary paths.
 */
const HIGH_ENTROPY_CANDIDATE_RE = /[A-Za-z0-9+_=-]{20,}/g;
const HIGH_ENTROPY_MIN_BITS_PER_CHAR = 3.5;

/**
 * Backstop for a secret that matches none of the named prefixes/assignment
 * shapes below: any 20+ char run of base64/token-alphabet characters that
 * mixes upper, lower AND digit (all three) AND has near-random-looking
 * character distribution.
 *
 * The "all three" requirement is load-bearing, not incidental: a git commit
 * SHA or a UUID is ALSO a long, high-entropy-looking run (hex is only 16
 * symbols, but a real hash's digits look close to uniformly random over
 * them), and neither is a secret. Both are lowercase-hex-plus-digit --
 * exactly TWO of the three categories -- so requiring all three excludes
 * them structurally rather than by naming "looks like a hash" as a special
 * case. A typical generated secret (API key, JWT, base64-encoded key
 * material) mixes case and digits and clears this bar; this is a heuristic
 * backstop for the unnamed case, not the primary defense -- the named
 * prefix/assignment rules below are.
 */
export function hasHighEntropySecret(text: string): boolean {
  const candidates = joinForCredentialScan(text).match(HIGH_ENTROPY_CANDIDATE_RE) ?? [];
  for (const token of candidates) {
    const hasLower = /[a-z]/.test(token);
    const hasUpper = /[A-Z]/.test(token);
    const hasDigit = /[0-9]/.test(token);
    if (!(hasLower && hasUpper && hasDigit)) continue;
    if (shannonEntropy(token) >= HIGH_ENTROPY_MIN_BITS_PER_CHAR) return true;
  }
  return false;
}

interface CredentialRule {
  readonly label: string;
  readonly test: (s: string) => boolean;
}

/**
 * Refusal patterns (#992's "refuses, does not scrub-and-keep" requirement).
 * A hit on ANY rule means `main()` drops the whole record -- this list only
 * needs to decide "credential-shaped: yes/no", never to extract or preserve
 * the value.
 *
 * The `password|token|api_key` assignment rule is deliberately broad enough
 * to also drop `TOKEN=$GITHUB_TOKEN` (a variable REFERENCE, not an embedded
 * secret) -- same ADR 0010 "err broad in the safe direction" posture this
 * codebase already applies to deny-shaped matching elsewhere
 * (`deny-floor.ts`, `risk-bands.ts`): a false-positive drop here costs one
 * fewer corpus record; a false-negative keeps a real secret in a PUBLIC
 * repo's potential future commit. Not symmetric, and not meant to be.
 */
const CREDENTIAL_RULES: readonly CredentialRule[] = [
  { label: 'bearer token', test: (s) => /\bBearer\s+[A-Za-z0-9\-_.=]{8,}/i.test(s) },
  { label: 'sk- prefixed key', test: (s) => /\bsk-[A-Za-z0-9_-]{10,}/.test(s) },
  { label: 'ghp_/gho_ prefixed token', test: (s) => /\bgh[po]_[A-Za-z0-9]{20,}/.test(s) },
  { label: 'AKIA prefixed AWS key', test: (s) => /\bAKIA[0-9A-Z]{16}\b/.test(s) },
  { label: 'PEM private key block', test: (s) => /-----BEGIN[ A-Z]*PRIVATE KEY-----/.test(s) },
  {
    label: 'password/token/api_key assignment',
    test: (s) =>
      /\b(password|passwd|token|api[_-]?key|secret)\s*[:=]\s*['"]?[^\s'";,]{4,}/i.test(s),
  },
  { label: 'high-entropy string', test: hasHighEntropySecret },
];

/**
 * Returns the label of the first matching credential rule, or null. Order
 * is the order `CREDENTIAL_RULES` is checked in; only the FIRST match is
 * reported (a value tripping two rules is still one dropped record).
 *
 * Normalizes with `joinForCredentialScan` ONCE, up front, so EVERY rule
 * (not only `hasHighEntropySecret`) sees the joined text -- a named prefix
 * (`sk-...`) or an assignment (`api_key=...`) can be split by the identical
 * continuation/embedded-newline mechanism `hasHighEntropySecret`'s own doc
 * describes, and none of those rules' character classes include `\`/`\n`
 * either. `hasHighEntropySecret` also normalizes internally (its own doc),
 * so this is a second, harmless pass over already-joined text for that one
 * rule -- defense in depth for a caller that reaches it directly.
 */
export function detectCredential(text: string): string | null {
  const joined = joinForCredentialScan(text);
  for (const rule of CREDENTIAL_RULES) {
    if (rule.test(joined)) return rule.label;
  }
  return null;
}

/** RFC 5737 TEST-NET-3 (`203.0.113.0/24`) -- reserved for documentation
 *  use, so a pseudonymized IP can never collide with a real routable
 *  address. Wraps within the /24 (254 usable host addresses) via `nextMix`,
 *  which is already the same non-reversible counter-seeded generator the
 *  id pseudonymizer above uses. */
function fakeIpAddress(): string {
  const n = nextMix() % 254;
  return `203.0.113.${n + 1}`;
}

/** RFC 3849 (`2001:db8::/32`) -- the IPv6 analogue of the IPv4 choice
 *  above, ALSO reserved specifically for documentation use. `nextMix()` is a
 *  32-bit value (up to 8 hex digits); `.slice(0, 4)` keeps the final group a
 *  SYNTACTICALLY VALID single IPv6 group (max 4 hex digits) rather than an
 *  8-digit run no real address would ever have -- deliberately distinct
 *  from what a leaked-plaintext concatenation bug would look like (PR #995
 *  review finding 2 found exactly that shape once, from a different bug in
 *  `USER_AT_HOST_RE`; keeping this generator's own output unambiguously
 *  well-formed means a future regression of that kind is visually obvious
 *  again, not masked by this function already producing over-long groups). */
function fakeIpv6Address(): string {
  return `2001:db8::${nextMix().toString(16).slice(0, 4)}`;
}

/** category -> (real value -> fake value), separate from `idMaps` above
 *  (different key shape: category name, not a hook-contract field path) but
 *  the same "stable for one script run, never hash-derived" design. */
const identityMaps = new Map<string, Map<string, string>>();

function pseudonymizeIdentity(category: string, real: string, generate: () => string): string {
  let perCategory = identityMaps.get(category);
  if (!perCategory) {
    perCategory = new Map<string, string>();
    identityMaps.set(category, perCategory);
  }
  const existing = perCategory.get(real);
  if (existing !== undefined) return existing;
  const fake = generate();
  perCategory.set(real, fake);
  return fake;
}

/**
 * `/Users/<name>` or `/home/<name>` -- the macOS/Linux home-directory
 * shape. Only the name segment is replaced; the rest of the path (and the
 * `/Users/`/`/home/` prefix itself) is left alone, which is exactly the
 * "preserve structure" requirement for a path argument.
 *
 * HONEST LIMIT (PR #995 review finding 4, not fixed): a PERCENT-ENCODED
 * home directory -- `%2FUsers%2Fjdoe%2Fsecret.txt`, the shape a pasted
 * callback/redirect URL query parameter carries -- leaks the username
 * whole. `%2F` is not literal `/`, so none of `HOME_DIR_RE`,
 * `SLUG_HOME_DIR_RE`, or `TILDE_USER_RE` recognize it, and this function
 * does not URL-decode first. That fix was deliberately NOT attempted here:
 * blanket-decoding `%2F` before scanning would also decode it inside a
 * URL PATH SEGMENT where it is not a separator at all (a filename that
 * itself legitimately contains an encoded slash), which changes what the
 * corpus's `url` field actually represents rather than just redacting
 * within it -- a correctness risk judged worse than leaving this real but
 * lower-likelihood shape undecoded. Same posture as the multi-line-split
 * credential case in `joinForCredentialScan`'s own doc: a limit stated
 * plainly, not silently absorbed.
 */
const HOME_DIR_RE = /\/(Users|home)\/([A-Za-z0-9._-]+)/g;

/**
 * `-Users-<name>-` or `-home-<name>-` -- the SLASH-FLATTENED project-slug
 * shape Claude Code itself uses for scratch/session directories (this
 * session's own scratchpad path is exactly this shape:
 * `/private/tmp/claude-<pid>/-Users-<name>-Documents-git-...`, found by
 * running this tool against real captured data (#992) and grepping the
 * output for the real username -- it survived `HOME_DIR_RE` above, which
 * requires an actual `/` on both sides and never matches a hyphen-joined
 * slug). The lookahead (not a consuming match) on the trailing `-` leaves it
 * in place for whatever segment follows.
 *
 * Genuinely ambiguous when the real username OR the segment immediately
 * after it contains a hyphen of its own -- collapsing `/` to `-` is lossy,
 * so there is no way to know from the flattened text alone where the
 * username run is supposed to end. This takes the maximal non-hyphen run,
 * the common case (typical macOS/Linux usernames are plain alnum), and
 * states the ambiguity here rather than silently getting it wrong on an
 * unstated edge case.
 */
const SLUG_HOME_DIR_RE = /-(Users|home)-([A-Za-z0-9._]+)(?=-)/g;

/** `~name` (tilde-prefixed username, e.g. `~deploy/bin`). Deliberately
 *  requires a letter immediately after `~` so bare `~` and `~/relative/path`
 *  (which name the CURRENT user only implicitly, carrying no separate
 *  identity to redact) are left untouched. */
const TILDE_USER_RE = /~([A-Za-z][A-Za-z0-9._-]*)/g;

/**
 * IPv6 address shape, as a raw pattern-source FRAGMENT (not a compiled
 * `RegExp`) shared by every IPv6-matching regex below -- a single source of
 * truth, so three separate hand-copies cannot drift the way #536-class bugs
 * happen. Every group is non-capturing (`(?:...)`) specifically so this
 * fragment can be embedded inside a LARGER pattern (`USER_AT_HOST_RE`)
 * without shifting that pattern's own capture-group indices.
 *
 * A well-established, RFC 4291-shaped pattern covering the full 8-group
 * form, every length of `::`-compression, and the all-compressed `::`/`::1`
 * forms. NOT a full validator: it does not reject an out-of-range hex group
 * (there are none -- 1-4 hex digits is always in range), does not handle a
 * zone-ID suffix (`%eth0`), and does not specifically recognize an
 * IPv4-mapped tail (`::ffff:192.0.2.1`) as anything other than an unmatched
 * trailing fragment. Those are edge cases this capture tool does not need
 * to be perfect on -- "not a shell parser" (module doc) applies here too.
 *
 * Measured to NOT false-positive on: a MAC address (needs an internal `::`,
 * which a single-colon-separated MAC address never has), an `HH:MM:SS`
 * timestamp (same reason -- three single-colon-separated groups match no
 * alternative here), or a `sha256:<hex>` digest reference (one colon, no
 * `::`, and `sha256`'s letters are not all valid hex digits so the match
 * cannot even start there).
 *
 * TRAP FOR ANY FUTURE EMBEDDING (found the hard way, `USER_AT_HOST_RE`
 * below): the alternatives are ordered so an EARLIER one can match a
 * genuine PREFIX of what a LATER one would match on the same input (e.g.
 * `2001:db8::1` -- the second alternative alone already matches
 * `2001:db8::`, stopping short of the trailing `1`). A JS regex engine
 * takes the first alternative that lets the REST of the overall pattern
 * succeed, not the longest one, so this fragment MUST be followed by
 * something that only succeeds once the hex/colon run is fully consumed --
 * a trailing `\b` is NOT enough (`:` before a following hex digit already
 * satisfies `\b`, non-word to word). Every embedding below either follows
 * this fragment with `(?![0-9a-fA-F:])` directly, or (`BARE_IPV6_RE`)
 * wraps it in that same lookaround on both sides. Do not embed this
 * fragment anywhere new without the identical trailing lookaround.
 */
const IPV6_PATTERN_SOURCE =
  '(?:' +
  '(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|' +
  '(?:[0-9a-fA-F]{1,4}:){1,7}:|' +
  '(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|' +
  '(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}|' +
  '(?:[0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}|' +
  '(?:[0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}|' +
  '(?:[0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}|' +
  '[0-9a-fA-F]{1,4}:(?:(?::[0-9a-fA-F]{1,4}){1,6})|' +
  ':(?:(?::[0-9a-fA-F]{1,4}){1,7}|:)' +
  ')';

/**
 * `local@host` -- covers both an email address and an SSH/git-style
 * `user@host` remote target with ONE pattern, since they are the same
 * shape. The host alternation accepts a dotted domain ending in a 2+ letter
 * label (`example.com`, `prod.internal`), a literal IPv4 dotted-quad, or a
 * literal IPv6 address (PR #995 review finding 2 -- `ssh jdoe@2001:db8::1`
 * previously matched NONE of the alternatives, so the whole `local@host`
 * pair fell through untouched and the USERNAME leaked too, not only the
 * host; see the module's real-data verification notes in
 * `guard-chain-replay.test.ts` for the measured before/after). The dotted
 * domain alternative specifically avoids matching an npm/bun/pip
 * `package@1.2.3` version pin, whose "host" is a bare numeric semver with
 * no letter-ending label and (usually) only 3 numeric parts.
 *
 * The IPv6 alternative carries its OWN trailing `(?![0-9a-fA-F:])` --
 * discovered as a second, distinct bug while fixing finding 2, not by
 * inspection: `IPV6_PATTERN_SOURCE`'s second alternative
 * (`(?:hex:){1,7}:`, "some groups then a bare `::`") is tried BEFORE the
 * alternative that also consumes a trailing group, and for `2001:db8::1`
 * it matches just `2001:db8::` and stops -- the shared outer `\b` right
 * after it is ALREADY satisfied there (`:` is non-word, `1` is word, so
 * that IS a boundary), so the engine never backtracks into a longer
 * alternative, and the real trailing `1` was left BEHIND as unmatched
 * plaintext, concatenated onto whatever the replacement produced (measured:
 * `dmw8@2001:db8::66a792981` -- a fake address with a 9-hex-digit final
 * group, `1` character too many, immediately gave this away as a
 * concatenation, not a clean generated value). `\b` cannot detect this
 * because it only asks about word/non-word ADJACENCY, not "does an IPv6
 * character continue on the other side" -- exactly the same distinction
 * `BARE_IPV6_RE` below already had to make for its OWN boundaries, and got
 * right the first time because a negative lookaround was the obvious tool
 * there. Applying the identical lookaround to the alternative here forces
 * the engine to keep backtracking into longer alternatives until the match
 * actually ends where the hex/colon run ends, which is what "boundary"
 * needs to mean for this charset.
 */
const USER_AT_HOST_RE = new RegExp(
  `\\b([A-Za-z0-9._%+-]+)@((?:[A-Za-z0-9-]+\\.)+[A-Za-z]{2,}|(?:\\d{1,3}\\.){3}\\d{1,3}|${IPV6_PATTERN_SOURCE}(?![0-9a-fA-F:]))\\b`,
  'g',
);

const IPV4_SHAPE_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV6_SHAPE_RE = new RegExp(`^${IPV6_PATTERN_SOURCE}$`);

/** A bare IPv4 dotted-quad not already consumed by `USER_AT_HOST_RE` above
 *  (that pass runs first). */
const BARE_IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

/**
 * A bare IPv6 address, bracketed (`[2001:db8::1]`, the required URL-host
 * shape when a port follows -- `http://[2001:db8::1]:8080/x`) or not
 * (`ping 2001:db8::1`). Deliberately does NOT use `\b` for its boundary the
 * way `BARE_IPV4_RE` does: an address ending in `::` (a valid, if unusual,
 * compressed form) ends on a non-word `:` character, and `\b` requires a
 * word-char/non-word-char transition -- right after such an address, the
 * NEXT real character is typically ALSO non-word (a space, a quote), so no
 * such transition exists and `\b` would silently fail to anchor there. A
 * negative lookaround against the IPv6 charset itself (`[0-9a-fA-F:]`) has
 * no such assumption: it only asks "is the character on this side part of
 * an IPv6 address," which is true regardless of whether that character is a
 * hex digit or a colon. This same construction is what lets this ONE
 * pattern also cover the bracketed URL-host shape without a second, separate
 * regex: `[` and `]` are not in the IPv6 charset, so they already satisfy
 * the boundary on their own, and a trailing `:<port>` sits entirely outside
 * the match (after the closing `]`), never at risk of being swept in. */
const BARE_IPV6_RE = new RegExp(`(?<![0-9a-fA-F:])${IPV6_PATTERN_SOURCE}(?![0-9a-fA-F:])`, 'g');

/** The CAPTURING machine's own hostname (`os.hostname()`), matched
 *  case-insensitively as a whole word wherever it appears verbatim. This is
 *  the only hostname this script can recognize without a `user@` or URL
 *  anchor -- an arbitrary bare remote alias (`ssh build-box-3 uptime`) is
 *  not structurally distinguishable from any other command word, and this
 *  script does not attempt to guess. Stated plainly rather than left for a
 *  reader to discover missing (AGENTS.md "Verify before you describe").
 *  Lazily compiled (not a module-level `RegExp` literal) so importing this
 *  file for its pure functions (`build-hook-corpus.test.ts` does exactly
 *  that) never calls `os.hostname()` as a side effect of module load. */
let cachedHostnameRe: RegExp | null = null;
function hostnameRegex(): RegExp {
  if (cachedHostnameRe === null) {
    const escaped = os.hostname().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    cachedHostnameRe = new RegExp(`\\b${escaped}\\b`, 'gi');
  }
  return cachedHostnameRe;
}

/**
 * Pseudonymize identity-bearing substrings in one command-like field's raw
 * text. Caller (`redactValue`) guarantees the credential check already ran
 * and passed -- this function only transforms, never refuses.
 *
 * Passes run in a fixed order (home dir -> slug-shaped home dir -> tilde
 * user -> user@host/email (IPv4 or IPv6 host) -> bare IPv4 -> bare IPv6 ->
 * capturing machine's own hostname). A later pass CAN observe a fake value
 * an earlier pass already produced (e.g. `USER_AT_HOST_RE`'s IPv4/IPv6 host
 * alternatives, once fake, still LOOK like their own shape to
 * `BARE_IPV4_RE`/`BARE_IPV6_RE`) and re-map it through its own category.
 * That is harmless, not a bug: `pseudonymizeIdentity` is a pure function of
 * its (category, value) pair, so re-mapping an already-fake value still
 * lands on the same final fake value for the same real input every time --
 * determinism (#992's "same input maps to the same output" requirement)
 * survives the layering.
 */
export function pseudonymizeIdentities(text: string): string {
  let out = text;

  out = out.replace(HOME_DIR_RE, (_match, kind: string, user: string) => {
    const fake = pseudonymizeIdentity('username', user, () => fakeShapePreserving(user));
    return `/${kind}/${fake}`;
  });

  out = out.replace(SLUG_HOME_DIR_RE, (_match, kind: string, user: string) => {
    const fake = pseudonymizeIdentity('username', user, () => fakeShapePreserving(user));
    return `-${kind}-${fake}`;
  });

  out = out.replace(TILDE_USER_RE, (_match, user: string) => {
    const fake = pseudonymizeIdentity('username', user, () => fakeShapePreserving(user));
    return `~${fake}`;
  });

  out = out.replace(USER_AT_HOST_RE, (_match, local: string, host: string) => {
    const fakeLocal = pseudonymizeIdentity('username', local, () => fakeShapePreserving(local));
    const fakeHost = IPV4_SHAPE_RE.test(host)
      ? pseudonymizeIdentity('ip', host, fakeIpAddress)
      : IPV6_SHAPE_RE.test(host)
        ? pseudonymizeIdentity('ip6', host, fakeIpv6Address)
        : pseudonymizeIdentity('host', host, () => fakeShapePreserving(host));
    return `${fakeLocal}@${fakeHost}`;
  });

  out = out.replace(BARE_IPV4_RE, (match) => pseudonymizeIdentity('ip', match, fakeIpAddress));

  out = out.replace(BARE_IPV6_RE, (match) => pseudonymizeIdentity('ip6', match, fakeIpv6Address));

  out = out.replace(hostnameRegex(), (match) =>
    pseudonymizeIdentity('hostname', match, () => fakeShapePreserving(match)),
  );

  return out;
}

// --- Content-keyed maps: the key axis ---------------------------------------

/**
 * The allowlist above only ever checked VALUES. `redactValue`'s object
 * branch iterated `Object.entries(value)` and redacted each `nested` value
 * while copying `key` straight through, unchecked -- so a map keyed by free
 * text leaks that text as a JSON object key, in full, regardless of what the
 * allowlist says about values.
 *
 * This bit the corpus for real: `AskUserQuestion`'s `tool_input`/
 * `tool_response` carry `answers` and `annotations`, both maps keyed by the
 * LITERAL question string (`{"<the question text>": "<the answer>"}`), not
 * a fixed schema field name. Found by an independent audit that scanned the
 * committed bytes for any object key outside this exact shape; the smoking
 * gun was that the SAME text appeared twice in one record -- correctly
 * redacted as the `question` field's value (`<redacted:str:95>`), and
 * verbatim as an `answers`/`annotations` key one line later.
 *
 * `KEY_SHAPE_RE` is the durable fix: any object whose keys don't all look
 * identifier-shaped is treated as content-keyed and converted to an array of
 * `{key, value}` pairs with the key ALSO redacted (to a same-length
 * placeholder, matching the value convention), rather than kept as a
 * property name. Converted to an array, not a redacted-key object, so two
 * real keys of different lengths never collide into the same placeholder
 * key and silently overwrite each other (a JS object cannot hold two equal
 * keys; an array of pairs has no such limit). This is a general path -- ANY
 * future field shaped like `answers`/`annotations` is caught by the same
 * check, not a second special case naming `AskUserQuestion` specifically.
 */
const KEY_SHAPE_RE = /^[A-Za-z0-9_.-]{1,40}$/;

function isSafeKeyShape(key: string): boolean {
  return KEY_SHAPE_RE.test(key);
}

function isContentKeyedObject(entries: [string, unknown][]): boolean {
  // ANY key failing the shape check flips the WHOLE object into the
  // {key,value}-array form -- neighboring ordinary-looking keys in a
  // content-keyed map (e.g. a coincidentally short question) are not
  // trusted just because they happen to pass the regex.
  return entries.some(([key]) => !isSafeKeyShape(key));
}

function redactContentKeyedObject(
  entries: [string, unknown][],
  pathSoFar: string,
): Array<{ key: string; value: unknown }> {
  return entries.map(([key, nested]) => ({
    key: `<redacted:str:${key.length}>`,
    // The key itself is no longer a stable schema path (it WAS the content),
    // so nested redaction continues from the parent path, not a path that
    // embeds the free-text key.
    value: redactValue(nested, pathSoFar),
  }));
}

// --- Recursive, type-preserving redaction -----------------------------------

function redactValue(value: unknown, pathSoFar: string): unknown {
  if (VERBATIM_PATHS.has(pathSoFar) || VERBATIM_NESTED_PATHS.has(pathSoFar)) {
    return value;
  }
  // `--mode structure-preserving` only (#992): by the time this is reached
  // for a KEPT record, `main()` has already run `detectCredential` over
  // every one of these four fields and dropped the WHOLE record if any
  // matched -- so this call only ever pseudonymizes, never a value that
  // still carries a credential. In default (`redact`) mode, `MODE` is never
  // `structure-preserving`, so this branch is dead code and behavior is
  // byte-for-byte the original.
  if (
    MODE === 'structure-preserving' &&
    COMMAND_LIKE_PATHS.has(pathSoFar) &&
    typeof value === 'string'
  ) {
    return pseudonymizeIdentities(value);
  }
  if (IDENTIFIER_PATHS.has(pathSoFar) && typeof value === 'string') {
    return pseudonymize(pathSoFar, value);
  }
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, pathSoFar));
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (isContentKeyedObject(entries)) {
      return redactContentKeyedObject(entries, pathSoFar);
    }
    const out: Record<string, unknown> = {};
    for (const [key, nested] of entries) {
      const nestedPath = pathSoFar === '' ? key : `${pathSoFar}.${key}`;
      out[key] = redactValue(nested, nestedPath);
    }
    return out;
  }
  if (typeof value === 'string') return `<redacted:str:${value.length}>`;
  if (typeof value === 'number') return 0;
  if (typeof value === 'boolean') return false;
  return '<redacted:unknown>';
}

/**
 * Build-time gate (not just the logic above): recursively walks a REDACTED
 * record and throws if any object key anywhere doesn't match
 * `KEY_SHAPE_RE`. This is the durable half of the fix -- it converts "the
 * redaction logic above is correct" from an assumption into something that
 * fails the build loudly the moment it's wrong, for this field or any future
 * one shaped like it. Runs over every kept record before anything is
 * written, so a violation blocks the file from being produced at all.
 */
function assertAllKeysSafe(value: unknown, pathSoFar: string): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertAllKeysSafe(item, `${pathSoFar}[${i}]`));
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (!isSafeKeyShape(key)) {
      throw new Error(
        `Unsafe object key at ${pathSoFar || '<root>'}: "${key}" (length ${key.length}) does not match the identifier-shaped allowlist ${KEY_SHAPE_RE}. This means free text leaked into an object key (e.g. a content-keyed map like AskUserQuestion's answers/annotations) that redactValue's content-keyed-object handling did not catch. Fix redactValue -- do not hand-edit the corpus, the script is the source of truth.`,
      );
    }
    assertAllKeysSafe(nested, pathSoFar === '' ? key : `${pathSoFar}.${key}`);
  }
}

function redactRecord(record: Record<string, unknown>): Record<string, unknown> {
  const out = redactValue(record, '');
  if (typeof out !== 'object' || out === null || Array.isArray(out)) {
    throw new Error('redaction of a top-level record produced a non-object');
  }
  return out as Record<string, unknown>;
}

// --- Down-sampling -----------------------------------------------------------

/** Exemplar + a modest tail, per (event, tool_name, key-set) shape group. */
const PER_GROUP_CAP = 2;
const DOWNSAMPLED_EVENTS = new Set(['PreToolUse', 'PostToolUse']);

function shapeGroupKey(record: Record<string, unknown>): string {
  const event = String(record['hook_event_name']);
  const toolName = String(record['tool_name'] ?? '');
  const keys = Object.keys(record)
    .filter((k) => k !== '_ts')
    .sort()
    .join(',');
  return `${event}|${toolName}|${keys}`;
}

// --- Main ---------------------------------------------------------------------

interface Summary {
  totalLines: number;
  malformedLines: number;
  testFixtureLines: number;
  perEventRaw: Map<string, number>;
  perEventKept: Map<string, number>;
  /** `--mode structure-preserving` only; always 0 in default mode. */
  credentialDroppedLines: number;
  /** label (`CredentialRule.label`) -> count. Empty in default mode. */
  credentialDropReasons: Map<string, number>;
}

function main(): void {
  if (!fs.existsSync(INPUT_PATH)) {
    console.error(`Input not found: ${INPUT_PATH}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(INPUT_PATH, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);

  const summary: Summary = {
    totalLines: lines.length,
    malformedLines: 0,
    testFixtureLines: 0,
    perEventRaw: new Map(),
    perEventKept: new Map(),
    credentialDroppedLines: 0,
    credentialDropReasons: new Map(),
  };

  const groupCounts = new Map<string, number>();
  const kept: Record<string, unknown>[] = [];

  for (const line of lines) {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      summary.malformedLines += 1;
      continue;
    }
    if (isSyntheticRecord(record)) {
      summary.testFixtureLines += 1;
      continue;
    }
    // `_provenance` is this build's own input-side filtering field, not part
    // of the Claude Code hook contract -- drop it before it reaches
    // `redactRecord`/`contract-drift.test.ts`, which validate the corpus
    // against `hook-types.ts`'s field set and know nothing about it. Every
    // record reaching here already passed the `isSyntheticRecord` check
    // above (kept as real), so dropping the field loses no information the
    // corpus needs.
    const { _provenance: _unusedProvenance, ...rest } = record;
    void _unusedProvenance;

    const event = String(rest['hook_event_name'] ?? '<missing>');
    summary.perEventRaw.set(event, (summary.perEventRaw.get(event) ?? 0) + 1);

    // `--mode structure-preserving` only (#992): a credential-shaped value in
    // ANY of the four command-like fields drops the WHOLE record -- counted
    // above in `perEventRaw` (it WAS real traffic), but never counted toward
    // down-sampling or `perEventKept`, and never reaches `redactRecord`. See
    // the "Structure-preserving pseudonymization" module section for why
    // this is a refusal (drop), not a scrub (keep-but-redact).
    if (MODE === 'structure-preserving') {
      let credentialLabel: string | null = null;
      for (const value of collectCommandLikeValues(rest)) {
        credentialLabel = detectCredential(value);
        if (credentialLabel !== null) break;
      }
      if (credentialLabel !== null) {
        summary.credentialDroppedLines += 1;
        summary.credentialDropReasons.set(
          credentialLabel,
          (summary.credentialDropReasons.get(credentialLabel) ?? 0) + 1,
        );
        continue;
      }
    }

    let keepThis = true;
    if (DOWNSAMPLED_EVENTS.has(event)) {
      const key = shapeGroupKey(rest);
      const count = groupCounts.get(key) ?? 0;
      keepThis = count < PER_GROUP_CAP;
      groupCounts.set(key, count + 1);
    }

    if (keepThis) {
      kept.push(rest);
      summary.perEventKept.set(event, (summary.perEventKept.get(event) ?? 0) + 1);
    }
  }

  const redacted = kept.map((record) => redactRecord(record));

  // Gate: validated BEFORE anything is written. A violation here aborts the
  // build with no output file, rather than writing a corpus that still
  // needs a human to notice the leak (see assertAllKeysSafe's doc comment).
  redacted.forEach((record, i) => assertAllKeysSafe(record, `record[${i}]`));

  const outLines = redacted.map((r) => JSON.stringify(r));
  fs.writeFileSync(OUTPUT_PATH, `${outLines.join('\n')}\n`);

  const outBytes = fs.statSync(OUTPUT_PATH).size;

  console.log(
    `Read ${summary.totalLines} lines from ${INPUT_PATH} (${summary.malformedLines} malformed, ${summary.testFixtureLines} synthetic test-fixture records, both skipped)`,
  );
  console.log('Raw counts by event:');
  for (const [event, n] of [...summary.perEventRaw.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${event}: ${n}`);
  }
  console.log('Kept (post-downsample) counts by event:');
  for (const [event, n] of [...summary.perEventKept.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${event}: ${n}`);
  }
  console.log(`Wrote ${redacted.length} redacted records (${outBytes} bytes) to ${OUTPUT_PATH}`);

  if (MODE === 'structure-preserving') {
    printStructurePreservingReviewReport(summary, redacted);
  }
}

/**
 * #992's "emits a review report to stdout" requirement: every distinct
 * command-like value that made it into the OUTPUT corpus (already
 * pseudonymized -- this reads the post-`redactRecord` records, not the raw
 * input), plus how many records were dropped and why, so the owner can
 * actually look at what this run produced before deciding whether any of it
 * is fit to ever be committed (a decision this script does not make -- see
 * the module doc and `guard-chain-replay.test.ts`'s header).
 */
function printStructurePreservingReviewReport(
  summary: Summary,
  redacted: readonly Record<string, unknown>[],
): void {
  console.log('');
  console.log('=== Structure-preserving capture: review report (#992) ===');
  console.log(`Records dropped for credential-like content: ${summary.credentialDroppedLines}`);
  for (const [label, n] of [...summary.credentialDropReasons.entries()].sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(`  ${label}: ${n}`);
  }

  const distinctCommands = new Set<string>();
  for (const record of redacted) {
    for (const value of collectCommandLikeValues(record)) {
      distinctCommands.add(value);
    }
  }
  console.log(`Distinct command-like values in the output corpus: ${distinctCommands.size}`);
  console.log('--- Review every line below before considering any subset for commit ---');
  for (const command of [...distinctCommands].sort()) {
    console.log(`  ${command}`);
  }
}

// Guarded (#934): this file is now also imported by
// `build-hook-corpus.test.ts` to unit-test `isSyntheticRecord`/
// `looksLikeTestFixture` directly (pure functions, no filesystem access) --
// an unguarded `main()` would run its real-filesystem side effects (reading
// `~/.remi/hook-diag.jsonl`, overwriting the checked-in `hook-corpus.jsonl`)
// on EVERY import, including from `bun test`. `import.meta.main` is true
// only when this file is the process entry point (`bun run
// build-hook-corpus.ts`), never when another module imports from it.
if (import.meta.main) {
  main();
}
