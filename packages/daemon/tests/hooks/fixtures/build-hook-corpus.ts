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
const OUTPUT_PATH = expandHome(
  argValue('--output') ?? path.join(import.meta.dir, 'hook-corpus.jsonl'),
);

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
