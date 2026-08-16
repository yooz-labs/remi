/**
 * Phase 1 approval-rate report library (epic #1057, closes #992's
 * replay-harness request).
 *
 * Importable pieces shared by `run-approval-rate-report.ts` (a standalone
 * CLI) and `approval-rate.test.ts` (a `bun:test` suite). Deliberately no
 * `bun:test` import anywhere in this file: the CLI runs it as a plain
 * script via `bun run-approval-rate-report.ts`, not through the test
 * runner, and this keeps the two consumers importing the exact same code
 * path rather than the CLI re-deriving anything.
 *
 * Five independent units, each documented at its own definition below:
 *
 *   - `loadCorpusRecords` -- JSONL -> `PermissionRequest` records. Same
 *     shape as `guard-chain-replay.test.ts`'s local loader, generalized to
 *     take a path so it also reads a raw `~/.remi/hook-diag.jsonl`.
 *   - `replayDeterministic` -- runs the real, exported
 *     `AutoApproveService.evaluateDeterministic` (#1024) over a record set,
 *     tallying coverage and banding the residue that would reach the LLM.
 *   - `classifyMiss` -- report-only shell-shape classifier for a Bash
 *     command that missed deterministic coverage. Never imported by `src/`
 *     -- see its own doc for why.
 *   - `parseDecisionLog` -- parses `auto-approve-service.ts`'s own `logFn`
 *     output (the exact templates it writes, read from source, not
 *     reimplemented logic) into verdict/band/layer counts and latencies.
 *   - `percentile` -- nearest-rank (ceil) percentile over a latency sample,
 *     shared so both the CLI and this file's own tests exercise the exact
 *     same rank math.
 *
 * NO MOCKS (repo rule): every unit here either calls a real exported
 * function (`evaluateDeterministic`, `classifyRisk`, `maskQuotedSpans`,
 * `findRedirectClauses`, `splitCompoundParts`) or parses real text a real
 * function produced. Nothing in this file reimplements decision logic.
 */

import * as fs from 'node:fs';
import { AutoApproveService } from '../../src/auto-approve/auto-approve-service.ts';
import type { DecidingLayer, RiskBand } from '../../src/auto-approve/risk-bands.ts';
import { classifyRisk } from '../../src/auto-approve/risk-bands.ts';
import {
  findRedirectClauses,
  maskQuotedSpans,
  splitCompoundParts,
} from '../../src/auto-approve/shell-safety.ts';
import type { AutoApproveConfig } from '../../src/auto-approve/types.ts';

// ---------------------------------------------------------------------------
// (a) Corpus loader
// ---------------------------------------------------------------------------

/** One `PermissionRequest` record, reduced to what `evaluateDeterministic`
 *  and `classifyRisk` read. `index` is the record's line number in the
 *  source file (0-based), kept for traceability from a report row back to
 *  the exact line that produced it. */
export interface CorpusRecord {
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly agentType: string | undefined;
  readonly index: number;
}

/**
 * Reads a JSONL hook-event capture and keeps only `PermissionRequest`
 * records carrying a string `tool_name` and an object `tool_input` -- the
 * two fields `evaluateDeterministic` reads. Malformed lines (bad JSON, wrong
 * shape, a different `hook_event_name`) are skipped silently rather than
 * thrown on: both the structure-preserving fixture
 * (`fixtures/.local-command-corpus.jsonl`, gitignored -- a developer could
 * regenerate it mid-edit) and a raw `~/.remi/hook-diag.jsonl` (real Claude
 * Code traffic, carrying every OTHER registered hook event type too) are
 * locally-generated data outside this repo's control, and one corrupt or
 * unrelated line must not fail the whole replay.
 *
 * Mirrors `guard-chain-replay.test.ts`'s `loadLocalCorpusReplayRecords`
 * (that file's :385-408) -- same filter, same skip-on-malformed posture,
 * generalized to take a path (that file's version is hardcoded to the one
 * fixture) and to carry `agent_type` through (ADR 0025 per-agent-type
 * policy needs it; the guard chain this mirrors does not).
 *
 * `eventName` defaults to `PermissionRequest` -- the population that actually
 * asked remi for a decision, the one #996 measured. It exists because
 * hook-diag capture is gated on `REMI_HOOK_DEBUG=1` (hook-server.ts) and a
 * machine's capture window may hold no PermissionRequest at all (this repo's
 * dev machine: 142 events, zero of them). `PreToolUse` records carry the same
 * `tool_name`/`tool_input` and can stand in as a PROXY corpus, with a caveat
 * the CLI prints: PreToolUse fires for every tool call, including ones Claude
 * Code's own settings allowlist approved without ever asking remi, so
 * coverage measured on it is not the same population as #996's.
 */
export function loadCorpusRecords(
  filePath: string,
  eventName = 'PermissionRequest',
): CorpusRecord[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n');
  const records: CorpusRecord[] = [];
  // Unparsable (corrupt JSON) lines are dropped, but tallied and surfaced: a
  // silently-shrunk denominator would report a rate over FEWER records than
  // the operator believes, and that rate is what gates whether
  // `residual_action = "deny"` is safe to enable (~95%+). Non-matching-event
  // lines are NOT counted here -- the corpus legitimately holds many event
  // types, so those are expected, not corruption. (Epic-wide review, 2026-08-16.)
  let unparsable = 0;
  lines.forEach((line, i) => {
    if (line.trim().length === 0) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      unparsable += 1;
      return;
    }
    if (parsed['hook_event_name'] !== eventName) return;
    const toolName = parsed['tool_name'];
    const toolInput = parsed['tool_input'];
    if (typeof toolName !== 'string') return;
    if (typeof toolInput !== 'object' || toolInput === null || Array.isArray(toolInput)) return;
    const agentTypeRaw = parsed['agent_type'];
    records.push({
      toolName,
      toolInput: toolInput as Record<string, unknown>,
      agentType: typeof agentTypeRaw === 'string' ? agentTypeRaw : undefined,
      index: i,
    });
  });
  if (unparsable > 0) {
    console.warn(
      `[approval-rate] skipped ${unparsable} unparsable line(s) of ${lines.length} in ${filePath} — the reported rate is over ${records.length} matched records, a smaller denominator than the file's line count.`,
    );
  }
  return records;
}

// ---------------------------------------------------------------------------
// (b) Deterministic replay
// ---------------------------------------------------------------------------

/** Per-record outcome of a deterministic replay. `source`/`reasoning` are
 *  `undefined` for the `null` (residual) case; `band` is set ONLY for that
 *  case -- an approve/deny-covered verdict never needed `classifyRisk` to
 *  decide anything, so banding it would imply a risk assessment this report
 *  never actually asked for. */
export interface ReplayRecordResult {
  readonly index: number;
  readonly toolName: string;
  readonly decision: 'approve' | 'deny-covered' | null;
  readonly source: 'allow' | 'group' | 'deny-pattern' | 'deny-group' | undefined;
  readonly reasoning: string | undefined;
  readonly band: RiskBand | undefined;
}

interface ReplayToolTally {
  total: number;
  approve: number;
  denyCovered: number;
  residual: number;
}

export interface ReplayTally {
  readonly total: number;
  readonly approve: number;
  readonly approveBySource: { readonly allow: number; readonly group: number };
  /** Matched the user's own `deny`/`deny_groups`. A no-LLM outcome ONLY for
   *  MAIN-context traffic -- `evaluate()` returns `deny` immediately at 0ms
   *  for those. For an agent-tagged record it is NOT: the gate's hook-time
   *  path (ADR 0004) short-circuits before the LLM only on a deterministic
   *  APPROVE, and a config-level deny for an agent-tagged request instead
   *  PARKS for render-time arbitration, which may still reach the LLM if the
   *  prompt renders. So "deny-covered" does not mean "decided with no LLM
   *  call" for every record this tally counts it against -- only for the
   *  ones with no `agentType`. */
  readonly denyCovered: number;
  readonly denyCoveredBySource: { readonly pattern: number; readonly group: number };
  /** Nothing deterministic decided it -- what would reach the LLM in a live
   *  `evaluate()` call. */
  readonly residual: number;
  readonly residualByBand: Record<RiskBand, number>;
  readonly perTool: Readonly<Record<string, Readonly<ReplayToolTally>>>;
}

export interface ReplayResult {
  readonly tally: ReplayTally;
  readonly records: readonly ReplayRecordResult[];
}

export interface ReplayOptions {
  /** Dedupe `Bash` records by exact `tool_input.command` string before
   *  replay (the CLI's `--unique`). Only `Bash` is deduped -- every other
   *  tool's `tool_input` shape is tool-specific, and the dominant source of
   *  near-duplicate volume in a real capture is the same shell command run
   *  repeatedly within one session. First occurrence (corpus order) of each
   *  distinct command wins; every other record, and every non-Bash record,
   *  passes through unchanged. */
  readonly unique?: boolean;
}

function emptyBandCounts(): Record<RiskBand, number> {
  return { low: 0, moderate: 0, high: 0, critical: 0 };
}

function ensureToolTally(
  perTool: Record<string, ReplayToolTally>,
  toolName: string,
): ReplayToolTally {
  const existing = perTool[toolName];
  if (existing) return existing;
  const created: ReplayToolTally = { total: 0, approve: 0, denyCovered: 0, residual: 0 };
  perTool[toolName] = created;
  return created;
}

/**
 * Replays `records` through `AutoApproveService.evaluateDeterministic`
 * (#1024) only -- no LLM, no engine, no precedent, no queue. Constructs a
 * fresh, engine-free service (the constructor's optional third `engineHost`
 * param, #818, is left `undefined`; nothing this function calls ever reads
 * it), so the tally reflects EXACTLY the same allow/deny/group logic a live
 * daemon's hook-time and `evaluate()` paths share -- the real exported
 * method, never a reimplementation.
 *
 * For each record: `approve` and `deny-covered` are tallied as returned,
 * split by source (the user's own `allow`/`deny` list vs. a curated
 * `approve_groups`/`deny_groups` match -- read off the reasoning string's
 * own prefix, the same distinguishing text `evaluateDeterministic` already
 * produces, per its own doc's "reasoning strings ARE currently
 * distinguishable" note in `types.ts`). `null` (nothing deterministic
 * decided it -- would reach the LLM in a live `evaluate()` call) is
 * additionally banded with `classifyRisk`, so the residual's RISK, not just
 * its size, is visible.
 *
 * See `ReplayTally.denyCovered`'s own doc for why a `deny-covered` verdict
 * is a no-LLM outcome for MAIN-context traffic only -- an agent-tagged
 * record hitting the same config deny instead parks for render-time
 * arbitration (ADR 0004) and may still reach the LLM.
 */
export function replayDeterministic(
  records: readonly CorpusRecord[],
  config: AutoApproveConfig,
  opts?: ReplayOptions,
): ReplayResult {
  const service = new AutoApproveService(config, () => {});

  let effective: readonly CorpusRecord[] = records;
  if (opts?.unique) {
    const seenCommands = new Set<string>();
    effective = records.filter((record) => {
      if (record.toolName !== 'Bash') return true;
      const command = record.toolInput['command'];
      if (typeof command !== 'string') return true;
      if (seenCommands.has(command)) return false;
      seenCommands.add(command);
      return true;
    });
  }

  const perTool: Record<string, ReplayToolTally> = {};
  const results: ReplayRecordResult[] = [];
  let approve = 0;
  let approveAllow = 0;
  let approveGroup = 0;
  let denyCovered = 0;
  let denyPattern = 0;
  let denyGroup = 0;
  let residual = 0;
  const residualByBand = emptyBandCounts();

  for (const record of effective) {
    const toolTally = ensureToolTally(perTool, record.toolName);
    toolTally.total += 1;

    const verdict = service.evaluateDeterministic(
      record.toolName,
      record.toolInput,
      record.agentType,
    );

    if (verdict === null) {
      residual += 1;
      toolTally.residual += 1;
      const band = classifyRisk(record.toolName, record.toolInput);
      residualByBand[band] += 1;
      results.push({
        index: record.index,
        toolName: record.toolName,
        decision: null,
        source: undefined,
        reasoning: undefined,
        band,
      });
      continue;
    }

    if (verdict.decision === 'approve') {
      approve += 1;
      toolTally.approve += 1;
      const source: 'allow' | 'group' = verdict.reasoning.startsWith('allow-matched')
        ? 'allow'
        : 'group';
      if (source === 'allow') approveAllow += 1;
      else approveGroup += 1;
      results.push({
        index: record.index,
        toolName: record.toolName,
        decision: 'approve',
        source,
        reasoning: verdict.reasoning,
        band: undefined,
      });
      continue;
    }

    denyCovered += 1;
    toolTally.denyCovered += 1;
    const source: 'deny-pattern' | 'deny-group' = verdict.reasoning.startsWith(
      'deny-matched pattern',
    )
      ? 'deny-pattern'
      : 'deny-group';
    if (source === 'deny-pattern') denyPattern += 1;
    else denyGroup += 1;
    results.push({
      index: record.index,
      toolName: record.toolName,
      decision: 'deny-covered',
      source,
      reasoning: verdict.reasoning,
      band: undefined,
    });
  }

  return {
    tally: {
      total: effective.length,
      approve,
      approveBySource: { allow: approveAllow, group: approveGroup },
      denyCovered,
      denyCoveredBySource: { pattern: denyPattern, group: denyGroup },
      residual,
      residualByBand,
      perTool,
    },
    records: results,
  };
}

// ---------------------------------------------------------------------------
// (c) Miss classifier
// ---------------------------------------------------------------------------

export type MissBucket = 'heredoc' | 'redirection' | 'pipeline' | 'chained' | 'single';

/**
 * True if `masked` (already run through `maskQuotedSpans`, so a quoted `<<`
 * cannot trip this) contains a real heredoc operator (`<<` or the indented
 * `<<-`).
 *
 * Deliberately excludes `<<<`, the here-string operator -- a DIFFERENT
 * construct (reads one word/expansion, not a multi-line body), by masking
 * every run of 3+ `<` to underscores BEFORE testing for `<<`. A plain
 * substring scan for `"<<"` cannot make this distinction on its own, since
 * `<<<` literally contains `<<` as its first two characters. `<<<` (and the
 * rarer `<<<<`) therefore falls through `classifyMiss` to the
 * pipeline/chained/single buckets below, exactly like any other non-heredoc
 * command -- there is no dedicated "here-string" bucket, per the plan this
 * classifier implements.
 */
function hasHeredocOperator(masked: string): boolean {
  const withoutHereStrings = masked.replace(/<{3,}/g, (run) => '_'.repeat(run.length));
  return /<<-?/.test(withoutHereStrings);
}

/**
 * Buckets a Bash command that missed deterministic coverage (the `null`
 * residue `replayDeterministic` bands by risk) by the shell SHAPE
 * responsible, so the CLI's miss table can show "these misses are heredocs,
 * these are pipelines" instead of one undifferentiated pile.
 *
 * Precedence, checked in this order: heredoc > redirection > pipeline >
 * chained > single. A command matching more than one shape (`cat >> f
 * <<'EOF'` is both a `>>` redirect AND a heredoc) reports the EARLIEST
 * bucket that applies, so a heredoc-with-redirect is never miscounted as a
 * plain redirection.
 *
 * `maskQuotedSpans` runs once, up front, and both the heredoc check and the
 * redirect-clause check read the masked text -- a quoted `"<<"` or `"> file"`
 * inside prose (a commit message, a `--body` argument) is not shell syntax
 * and must not count as either.
 *
 * The `redirection` bucket only catches `>`/`>>` output redirects:
 * `findRedirectClauses`'s `REDIRECT_CLAUSE_RE` has no `<` input-redirect
 * detector (`shell-safety.ts` was never asked for one), so a bare `cmd <
 * file.txt` that is not a heredoc falls through to chained/single, not
 * this bucket. Narrower than the plan's "redirection" name might suggest;
 * stated here rather than left for a reader to discover missing.
 *
 * The gap above is under-matching; this classifier also OVER-matches, in
 * three verified ways -- all report-only mislabels, not decision-path bugs:
 *
 *   - `REDIRECT_CLAUSE_RE` (`\d*>>?\s*&?\S+`) has no lookbehind, so it
 *     matches the `->` in `make build -> dist` as a redirect onto `dist`;
 *     that `>` is the second character of an arrow, not shell syntax.
 *   - `hasHeredocOperator` matches `<<` wherever it appears, so
 *     `$((1 << 3))` (a plain arithmetic left shift) grades `heredoc`, not
 *     `single`.
 *   - When `maskQuotedSpans` fails closed on an unterminated quote (its own
 *     doc: "a quote that never closes ... returns the segment UNCHANGED"),
 *     the raw, unmasked text is what both checks above scan --
 *     `echo 'unterminated << here` (no closing `'`) grades `heredoc` off the
 *     literal `<<` inside what was meant to be a quoted string.
 *
 * All three are acceptable precisely because this classifier is
 * REPORT-ONLY: err-broad here costs a mislabeled report row, never a wrong
 * permission decision. Never imported by `src/` -- `permission-groups.ts` and
 * `shell-safety.ts` already decide coverage; this classifier exists purely
 * to explain, after the fact, WHY a command missed it, and folding an
 * explanatory classification into the decision path is exactly the kind of
 * drift ADR 0015/0017 warn about for the shared catastrophic-pattern list.
 */
export function classifyMiss(command: string): MissBucket {
  const masked = maskQuotedSpans(command);
  if (hasHeredocOperator(masked)) return 'heredoc';
  if (findRedirectClauses(masked).length > 0) return 'redirection';
  const parts = splitCompoundParts(command);
  if (parts.some((part) => part.joiner === '|')) return 'pipeline';
  if (parts.some((part) => part.joiner !== null)) return 'chained';
  return 'single';
}

// ---------------------------------------------------------------------------
// (d) remi.log decision parser
// ---------------------------------------------------------------------------

export type LogVerdict = 'approve' | 'deny' | 'escalate' | 'cancelled' | 'error';

/** One parsed (or unrecognized) decision line. `matched: false` carries
 *  every other field `undefined` -- `parseDecisionLog` then either ignores
 *  the line or counts it under `autoApproveNonDecision` (see that doc). */
export interface ParsedLogLine {
  readonly raw: string;
  readonly matched: boolean;
  readonly tag: string | undefined;
  readonly toolName: string | undefined;
  readonly verdict: LogVerdict | undefined;
  readonly durationMs: number | undefined;
  readonly band: RiskBand | undefined;
  readonly authorityPresent: boolean | undefined;
  readonly decidedBy: DecidingLayer | undefined;
  readonly reasoning: string | undefined;
  /** True for every shape that never produced a model verdict. The
   *  deterministic DENIED/approve lines, the pre-LLM PRECEDENT shortcut, and
   *  the always-escalate design/multichoice/index-mismatch/queue-timeout
   *  lines are genuinely pre-LLM: no `chatCompletion` call was ever made.
   *  CANCELLED and ERROR are also `fastPath: true` but are NOT pre-LLM --
   *  both are logged from the `catch` block AFTER a real LLM dispatch
   *  (CANCELLED aborts an in-flight `chatCompletion`; ERROR is dominated by
   *  the 30s LLM timeout) -- they simply never got a parsed verdict back.
   *  False only for the post-LLM line (the one carrying the `[band=...]`
   *  bracket `formatMatrixContext` produces) -- every earlier `return` in
   *  `evaluate()` logs its own line first and never reaches that call. */
  readonly fastPath: boolean;
  /** Reasoning contains "eval queue wait exceeded" -- `evaluate()`'s
   *  `acquireSlot` timeout path (#551). */
  readonly queueTimeout: boolean;
}

/**
 * The post-LLM line `auto-approve-service.ts` logs after every real model
 * round trip (and after the authority/risk-ceiling/counterfactual guards
 * that run on its result): `[AutoApprove <tag>] [DENIED ]<Tool>: <verdict>
 * (<N>ms) [band=<band> authority=yes|no[ decided_by=<layer>]] - <reasoning>`.
 * `decided_by` is optional (older logs predate #1040); the whole bracket is
 * ALSO optional here only so this one regex can double as the fast-path
 * shapes below that share its "verdict (Nms) - reasoning" tail but never
 * carry a bracket at all (deterministic approve, pre-LLM PRECEDENT,
 * every always-escalate variant, the queue-timeout escalate).
 */
const FAMILY2_RE =
  /^\[AutoApprove(?: (?<tag>[^\]]+))?\] (?:(?<tag2>DENIED|PRECEDENT) )?(?<tool>\S+): (?<verdict>approve|deny|escalate) \((?<duration>\d+)ms\)(?: \[band=(?<band>low|moderate|high|critical) authority=(?<authority>yes|no)(?: decided_by=(?<decidedBy>[a-z_]+))?\])? - (?<reasoning>.*)$/;

/**
 * The fast-path shapes with NO verdict word and NO ` - ` separator: the
 * deterministic DENIED line, CANCELLED, and ERROR. Each reads
 * `[AutoApprove <tag>] TAG <Tool>: <reasoning> (<N>ms)`, where `TAG` alone
 * (not a captured verdict word) says what happened.
 */
const FAMILY1_RE =
  /^\[AutoApprove(?: (?<tag>[^\]]+))?\] (?<tag2>DENIED|CANCELLED|ERROR) (?<tool>\S+): (?<reasoning>.+) \((?<duration>\d+)ms\)$/;

const FAMILY1_VERDICT: Readonly<Record<string, LogVerdict>> = {
  DENIED: 'deny',
  CANCELLED: 'cancelled',
  ERROR: 'error',
};

function unmatchedLine(raw: string): ParsedLogLine {
  return {
    raw,
    matched: false,
    tag: undefined,
    toolName: undefined,
    verdict: undefined,
    durationMs: undefined,
    band: undefined,
    authorityPresent: undefined,
    decidedBy: undefined,
    reasoning: undefined,
    fastPath: false,
    queueTimeout: false,
  };
}

/**
 * Parses one line of `auto-approve-service.ts`'s `logFn` output. Templates
 * read from source (this file's module doc), not guessed. Never throws on
 * an unrecognized line -- returns `{matched: false, ...}` instead; what
 * `parseDecisionLog` does with a non-match depends on whether the line is
 * `[AutoApprove`-tagged at all (see its doc).
 */
function parseLine(raw: string): ParsedLogLine {
  const m2 = FAMILY2_RE.exec(raw);
  if (m2?.groups) {
    const g = m2.groups;
    const verdict = g['verdict'] as LogVerdict | undefined;
    const band = g['band'] as RiskBand | undefined;
    const decidedBy = g['decidedBy'] as DecidingLayer | undefined;
    const reasoning = g['reasoning'];
    return {
      raw,
      matched: true,
      tag: g['tag'],
      toolName: g['tool'],
      verdict,
      durationMs: g['duration'] !== undefined ? Number(g['duration']) : undefined,
      band,
      authorityPresent: g['authority'] === undefined ? undefined : g['authority'] === 'yes',
      decidedBy,
      reasoning,
      fastPath: band === undefined,
      queueTimeout: reasoning?.includes('eval queue wait exceeded') ?? false,
    };
  }

  const m1 = FAMILY1_RE.exec(raw);
  if (m1?.groups) {
    const g = m1.groups;
    const verdict = FAMILY1_VERDICT[g['tag2'] ?? ''];
    return {
      raw,
      matched: true,
      tag: g['tag'],
      toolName: g['tool'],
      verdict,
      durationMs: g['duration'] !== undefined ? Number(g['duration']) : undefined,
      band: undefined,
      authorityPresent: undefined,
      decidedBy: undefined,
      reasoning: g['reasoning'],
      fastPath: true,
      queueTimeout: false,
    };
  }

  return unmatchedLine(raw);
}

export interface DecisionLogTally {
  readonly totalLines: number;
  /**
   * `[AutoApprove`-tagged lines that matched no DECISION shape. Two
   * deliberate populations land here BY DESIGN, plus one known gap in the
   * current format:
   *
   * - Lifecycle lines, logged by `auto-approve-gate.ts` (NOT the service):
   *   `Externally resolved`, `Parked subagent prompt`, `Releasing N held
   *   hook(s)`, `Held hook ... resolved`.
   * - Seven guard/sideband lines the SERVICE emits unconditionally --
   *   proportional to decision volume, never gated on `log_decisions`:
   *   DENY FLOOR (auto-approve-service.ts:1102), TRUST BOUNDARY (:1129),
   *   RISK CEILING (:1165), PRECEDENT approve->escalate (:1205), the two
   *   COUNTERFACTUAL shapes (:1258 overridden, :1278 check-failed), and the
   *   PRECEDENT band-refusal fall-through (:883). Each of these fires
   *   ALONGSIDE, never instead of, the :1295 post-LLM matrix line that
   *   carries the actual decision -- dropping them here is what prevents
   *   double-counting a single verdict as two.
   * - KNOWN CURRENT-FORMAT EXCLUSION: with `multichoice = 'evaluate'`
   *   (default `'skip'`, config.ts:454) a post-LLM `pick` verdict is logged
   *   through the same :1295 call and carries the same `[band=...]`
   *   bracket as approve/deny/escalate, but `FAMILY2_RE`'s verdict group
   *   only matches `approve|deny|escalate`, so a real `pick` decision lands
   *   here too, not in `byVerdict`.
   *
   * A decision line from a future log format also lands here, so a sudden
   * jump in this count against a similar decision count is the drift
   * signal. Lines with no `[AutoApprove` tag at all (the rest of the
   * daemon's log) are ignored entirely: counting them as "unparsed" made a
   * healthy report read as 98% parser failure (28489 of 28921 on the first
   * real run).
   */
  readonly autoApproveNonDecision: number;
  readonly fastPathCount: number;
  readonly llmPathCount: number;
  readonly byVerdict: Readonly<Record<LogVerdict, number>>;
  /** key: `${verdict}|${band ?? 'none'}|${decidedBy ?? 'none'}` -> count. */
  readonly byVerdictBandDecidedBy: Readonly<Record<string, number>>;
  readonly latenciesByVerdict: Readonly<Record<LogVerdict, readonly number[]>>;
  readonly queueTimeoutCount: number;
  readonly riskCeilingCount: number;
}

export interface ParsedDecisionLog {
  readonly tally: DecisionLogTally;
  readonly lines: readonly ParsedLogLine[];
}

function emptyVerdictCounts(): Record<LogVerdict, number> {
  return { approve: 0, deny: 0, escalate: 0, cancelled: 0, error: 0 };
}

function emptyVerdictLatencies(): Record<LogVerdict, number[]> {
  return { approve: [], deny: [], escalate: [], cancelled: [], error: [] };
}

/**
 * Parses a `remi.log` (or any text carrying `[AutoApprove ...]` decision
 * lines mixed with other daemon output) into per-verdict/band/layer counts
 * and latency samples. Lines without an `[AutoApprove` tag are ignored;
 * tagged lines that match no decision shape are counted as
 * `autoApproveNonDecision` (see that field's doc for why the split exists).
 * No printing here -- this module's `percentile()` and the rendering that
 * consumes it are `run-approval-rate-report.ts`'s job.
 *
 * Gated on `log_decisions` (default `true`, config.ts:415): the post-LLM
 * matrix line (auto-approve-service.ts:1295), the deterministic-approve line
 * (:830), and the multichoice-skip escalate (:912) are each wrapped in
 * `if (this.logDecisions)` and simply do not exist in the log when that
 * setting is off. On a log captured from a `log_decisions = false` machine,
 * `llmPathCount` is exactly 0 and the verdict counts collapse to whatever
 * the unconditional guard/sideband lines (see `autoApproveNonDecision`'s
 * doc) and CANCELLED/ERROR contribute -- this parser has no way to
 * distinguish that from a machine that is genuinely quiet.
 */
export function parseDecisionLog(text: string): ParsedDecisionLog {
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  const parsedLines = lines.map(parseLine);

  const byVerdict = emptyVerdictCounts();
  const latenciesByVerdict = emptyVerdictLatencies();
  const byVerdictBandDecidedBy: Record<string, number> = {};
  let autoApproveNonDecision = 0;
  let fastPathCount = 0;
  let llmPathCount = 0;
  let queueTimeoutCount = 0;
  let riskCeilingCount = 0;

  for (const line of parsedLines) {
    if (!line.matched || line.verdict === undefined) {
      if (line.raw.includes('[AutoApprove')) autoApproveNonDecision += 1;
      continue;
    }
    byVerdict[line.verdict] += 1;
    if (line.durationMs !== undefined) {
      latenciesByVerdict[line.verdict].push(line.durationMs);
    }
    const key = `${line.verdict}|${line.band ?? 'none'}|${line.decidedBy ?? 'none'}`;
    byVerdictBandDecidedBy[key] = (byVerdictBandDecidedBy[key] ?? 0) + 1;
    if (line.fastPath) fastPathCount += 1;
    else llmPathCount += 1;
    if (line.queueTimeout) queueTimeoutCount += 1;
    if (line.decidedBy === 'risk_ceiling') riskCeilingCount += 1;
  }

  return {
    tally: {
      totalLines: parsedLines.length,
      autoApproveNonDecision,
      fastPathCount,
      llmPathCount,
      byVerdict,
      byVerdictBandDecidedBy,
      latenciesByVerdict,
      queueTimeoutCount,
      riskCeilingCount,
    },
    lines: parsedLines,
  };
}

// ---------------------------------------------------------------------------
// (e) percentile
// ---------------------------------------------------------------------------

/** Nearest-rank percentile (ceil, not floor): for a 2-sample array, `p50`
 *  lands on the lower value and `p95` on the upper one, matching what a
 *  reader expects a median of two samples to mean. A floor-based index
 *  instead picks the UPPER value for `p50` at every even small `n` --
 *  technically a valid discrete-percentile convention, but confusing in a
 *  report meant to be read directly. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? null;
}
