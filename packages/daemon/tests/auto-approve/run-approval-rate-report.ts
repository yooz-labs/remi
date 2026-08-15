#!/usr/bin/env bun
/**
 * Phase 1 approval-rate report (epic #1057, closes #992): how much of a real
 * `PermissionRequest` corpus the DETERMINISTIC layers (`allow`/`deny`/
 * `approve_groups`/`deny_groups`, #1024's `evaluateDeterministic`) already
 * decide with no LLM call -- for MAIN-context traffic. A `deny-covered`
 * record whose deterministic verdict came from a config `deny`/`deny_groups`
 * match is NOT decided with no LLM call when it is agent-tagged: the gate's
 * hook-time path (ADR 0004) short-circuits before the LLM only on a
 * deterministic APPROVE, and a config-level deny for an agent-tagged request
 * instead parks for render-time arbitration, which may still reach the LLM.
 * This report also shows what shape the misses have, and -- given a live
 * `remi.log` -- how the LLM path itself is actually behaving. Not a
 * `bun:test` file; run directly with `bun run`.
 *
 * Usage:
 *   bun packages/daemon/tests/auto-approve/run-approval-rate-report.ts \
 *     [--input <path>] [--event <name>] [--config <path>] \
 *     [--level strict|balanced|trusted] [--log <path>] [--unique] [--json]
 *
 * Flags:
 *   --input <path>   JSONL corpus to replay (`loadCorpusRecords`). Default:
 *                     fixtures/.local-command-corpus.jsonl next to this
 *                     script (gitignored, developer-generated -- see
 *                     `build-hook-corpus.ts --mode structure-preserving`).
 *   --config <path>  `config.toml` to load `[auto_approve]` from. Default:
 *                     `~/.remi/config.toml` (same default `loadConfig` uses).
 *   --level <name>   Overrides the resolved config's TOP-LEVEL `approve_groups`
 *                     with `groupsForLevel(<name>)` -- lets one config be swept
 *                     across all three strictness presets without editing it.
 *                     Does NOT touch `[auto_approve.agents.*]` sections: those
 *                     REPLACE `approve_groups` for a matched `agent_type`
 *                     (ADR 0025), so an agent-tagged record in the corpus is
 *                     still decided by its own section's groups and ignores
 *                     this sweep.
 *   --event <name>   Hook event to replay from the corpus. Default:
 *                     `PermissionRequest` (the population that asked remi --
 *                     what #996 measured). `PreToolUse` is a usable PROXY on
 *                     a machine whose `REMI_HOOK_DEBUG=1` capture window
 *                     holds no PermissionRequest, but it is a different
 *                     population (it includes calls Claude Code's own
 *                     allowlist approved without asking remi); the header
 *                     carries a caveat line whenever this is non-default.
 *   --log <path>     A `remi.log` (or any text carrying `[AutoApprove ...]`
 *                     lines) to additionally run through `parseDecisionLog`.
 *                     Omitted: the log section is skipped entirely.
 *   --unique         Dedupe `Bash` records by exact command string before
 *                     replay (`replayDeterministic`'s own option).
 *   --json           Print one JSON object instead of tables. The table and
 *                     JSON renderers consume the exact same computed
 *                     `Report`, so the two can never disagree with each
 *                     other about a number. `provenance.caveat` carries the
 *                     same PreToolUse-population caveat the table prints,
 *                     whenever `--event` is non-default.
 *
 * Known flags: --input --event --config --level --log --unique --json. Any
 * other `--`-prefixed token, or a value that itself starts with `--` (the
 * `--input --json` typo, where `--json` would silently become `--input`'s
 * value), is rejected before anything runs.
 *
 * Exits non-zero only on a real error (input file missing, config/log
 * unreadable, invalid `--level`, unknown flag, flag missing its value) --
 * an empty-but-present corpus is not an error and reports as all-zero.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { errorToString } from '@remi/shared';
import {
  AUTO_APPROVE_LEVELS,
  groupsForLevel,
  isAutoApproveLevel,
} from '../../src/auto-approve/levels.ts';
import type { AutoApproveLevel } from '../../src/auto-approve/levels.ts';
import { RISK_BANDS } from '../../src/auto-approve/risk-bands.ts';
import type { RiskBand } from '../../src/auto-approve/risk-bands.ts';
import type { AutoApproveConfig } from '../../src/auto-approve/types.ts';
import { CONFIG_PATH, applyEnvOverrides, loadConfig } from '../../src/config/config.ts';
import {
  type CorpusRecord,
  type LogVerdict,
  type MissBucket,
  type ReplayResult,
  type ReplayTally,
  classifyMiss,
  loadCorpusRecords,
  parseDecisionLog,
  percentile,
  replayDeterministic,
} from './approval-rate.ts';

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

/** Every flag this CLI understands. A `--`-prefixed token outside this set
 *  is a typo, not a silent no-op -- rejected up front rather than parsed as
 *  (say) `--input`'s value or ignored entirely. */
const KNOWN_FLAGS: ReadonlySet<string> = new Set([
  '--input',
  '--event',
  '--config',
  '--level',
  '--log',
  '--unique',
  '--json',
]);

/** Flags that consume the next argv token as a value. `--unique`/`--json`
 *  are bare switches and are deliberately excluded. */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--input',
  '--event',
  '--config',
  '--level',
  '--log',
]);

/**
 * Rejects an unknown `--`-prefixed token, and rejects a value-flag's value
 * when that value itself starts with `--` -- the `--input --json` typo,
 * where `argValue('--input')` would otherwise silently return the STRING
 * `"--json"` and leave `--json` unset. Runs over the raw argv before any
 * flag is read, so every flag below can trust its own value already passed
 * this check.
 */
function validateArgv(argv: readonly string[]): void {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined || !token.startsWith('--')) continue;
    if (!KNOWN_FLAGS.has(token)) {
      console.error(
        `[approval-rate] Unknown flag "${token}". Valid flags: ${[...KNOWN_FLAGS].join(' ')}`,
      );
      process.exit(1);
    }
    if (VALUE_FLAGS.has(token)) {
      const value = argv[i + 1];
      if (value?.startsWith('--')) {
        console.error(
          `[approval-rate] "${token}" expects a value but got flag-like "${value}" -- missing the actual value?`,
        );
        process.exit(1);
      }
    }
  }
}

validateArgv(process.argv.slice(2));

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

const DEFAULT_INPUT_PATH = path.join(import.meta.dir, 'fixtures', '.local-command-corpus.jsonl');

const inputPath = expandHome(argValue('--input') ?? DEFAULT_INPUT_PATH);
const eventName = argValue('--event') ?? 'PermissionRequest';
const configPath = expandHome(argValue('--config') ?? CONFIG_PATH);
const logPathArg = argValue('--log');
const logPath = logPathArg !== undefined ? expandHome(logPathArg) : undefined;
const uniqueFlag = process.argv.includes('--unique');
const jsonFlag = process.argv.includes('--json');

const levelArg = argValue('--level');
if (levelArg !== undefined && !isAutoApproveLevel(levelArg)) {
  console.error(
    `[approval-rate] Invalid --level "${levelArg}". Valid levels: ${AUTO_APPROVE_LEVELS.join(', ')}`,
  );
  process.exit(1);
}
const levelOverride: AutoApproveLevel | undefined = levelArg as AutoApproveLevel | undefined;

// ---------------------------------------------------------------------------
// Report shape -- built once, consumed by BOTH the JSON and table renderers
// so the two can never disagree about a number.
// ---------------------------------------------------------------------------

interface ProvenanceInfo {
  readonly date: string;
  readonly inputPath: string;
  readonly eventName: string;
  readonly rawRecordCount: number;
  readonly effectiveRecordCount: number;
  readonly unique: boolean;
  readonly configPath: string;
  readonly configFound: boolean;
  readonly resolvedLevel: AutoApproveLevel;
  readonly resolvedApproveGroups: readonly string[];
  /** From the resolved config's `auto_approve.log_decisions` (default
   *  `true`, config.ts:415). A `false` value means the (d) log section's
   *  post-LLM matrix line, deterministic-approve line, and multichoice-skip
   *  escalate line were never written, so `llmPathCount` reads 0 by
   *  construction rather than by an empty log. */
  readonly logDecisions: boolean;
  readonly logPath: string | undefined;
  /** Set whenever `eventName !== 'PermissionRequest'`: the PreToolUse-proxy
   *  population caveat, verbatim -- the same text the table renderer prints,
   *  carried here so `--json` consumers see it too. */
  readonly caveat: string | undefined;
}

interface ToolCoverage {
  readonly total: number;
  readonly approve: number;
  readonly denyCovered: number;
  readonly residual: number;
  readonly coveragePct: number;
}

interface CoverageReport {
  readonly total: number;
  readonly approve: number;
  readonly approveBySource: { readonly allow: number; readonly group: number };
  readonly denyCovered: number;
  readonly denyCoveredBySource: { readonly pattern: number; readonly group: number };
  readonly residual: number;
  readonly coveragePct: number;
  readonly perTool: Readonly<Record<string, ToolCoverage>>;
}

interface MissBucketStats {
  readonly count: number;
  readonly byBand: Readonly<Record<RiskBand, number>>;
}

interface MissReport {
  readonly buckets: Readonly<Record<MissBucket, MissBucketStats>>;
  /** Residual records `classifyMiss` cannot bucket: not `Bash`, or a `Bash`
   *  record with no string `command`. */
  readonly unclassifiable: number;
}

interface BandReport {
  readonly total: number;
  readonly byBand: Readonly<Record<RiskBand, number>>;
}

interface LatencyStats {
  readonly count: number;
  readonly p50: number | null;
  readonly p95: number | null;
}

interface LogReport {
  readonly totalLines: number;
  readonly autoApproveNonDecision: number;
  readonly fastPathCount: number;
  readonly llmPathCount: number;
  readonly byVerdict: Readonly<Record<LogVerdict, number>>;
  readonly byVerdictBandDecidedBy: Readonly<Record<string, number>>;
  readonly latencyByVerdict: Readonly<Record<LogVerdict, LatencyStats>>;
  readonly queueTimeoutCount: number;
  readonly riskCeilingCount: number;
}

interface Report {
  readonly provenance: ProvenanceInfo;
  readonly coverage: CoverageReport;
  readonly misses: MissReport;
  readonly residualBand: BandReport;
  readonly log: LogReport | undefined;
}

// ---------------------------------------------------------------------------
// Report builders
// ---------------------------------------------------------------------------

function emptyBandCounts(): Record<RiskBand, number> {
  return { low: 0, moderate: 0, high: 0, critical: 0 };
}

function pctOf(n: number, total: number): number {
  return total === 0 ? 0 : (n / total) * 100;
}

function buildCoverageReport(tally: ReplayTally): CoverageReport {
  const perTool: Record<string, ToolCoverage> = {};
  for (const [tool, t] of Object.entries(tally.perTool)) {
    perTool[tool] = {
      total: t.total,
      approve: t.approve,
      denyCovered: t.denyCovered,
      residual: t.residual,
      coveragePct: pctOf(t.approve + t.denyCovered, t.total),
    };
  }
  return {
    total: tally.total,
    approve: tally.approve,
    approveBySource: tally.approveBySource,
    denyCovered: tally.denyCovered,
    denyCoveredBySource: tally.denyCoveredBySource,
    residual: tally.residual,
    coveragePct: pctOf(tally.approve + tally.denyCovered, tally.total),
    perTool,
  };
}

/** Every `MissBucket` union member, once, as an object literal -- TS rejects
 *  this literal if a member is missing OR a stray key is added, so a bucket
 *  added to the union in `approval-rate.ts` without a render entry here is a
 *  COMPILE error, not a silently missing table row. Keys are read back with
 *  `Object.keys`, which preserves this literal's insertion order, so it also
 *  fixes the render order in one place. */
const MISS_BUCKET_ORDER: Readonly<Record<MissBucket, true>> = {
  heredoc: true,
  redirection: true,
  pipeline: true,
  chained: true,
  single: true,
};
const MISS_BUCKETS = Object.keys(MISS_BUCKET_ORDER) as MissBucket[];

function buildMissReport(
  replay: ReplayResult,
  recordsByIndex: ReadonlyMap<number, CorpusRecord>,
): MissReport {
  const buckets: Record<MissBucket, { count: number; byBand: Record<RiskBand, number> }> = {
    heredoc: { count: 0, byBand: emptyBandCounts() },
    redirection: { count: 0, byBand: emptyBandCounts() },
    pipeline: { count: 0, byBand: emptyBandCounts() },
    chained: { count: 0, byBand: emptyBandCounts() },
    single: { count: 0, byBand: emptyBandCounts() },
  };
  let unclassifiable = 0;

  for (const record of replay.records) {
    if (record.decision !== null) continue;
    if (record.toolName !== 'Bash') {
      unclassifiable += 1;
      continue;
    }
    const original = recordsByIndex.get(record.index);
    const command = original?.toolInput['command'];
    if (typeof command !== 'string') {
      unclassifiable += 1;
      continue;
    }
    const bucket = classifyMiss(command);
    buckets[bucket].count += 1;
    if (record.band !== undefined) buckets[bucket].byBand[record.band] += 1;
  }

  return { buckets, unclassifiable };
}

function buildBandReport(tally: ReplayTally): BandReport {
  return { total: tally.residual, byBand: tally.residualByBand };
}

/** Every `LogVerdict` union member, once -- same exhaustiveness trick as
 *  `MISS_BUCKET_ORDER` above: a verdict added to the union without a render
 *  entry here is a compile error, not a silently missing row. */
const LOG_VERDICT_ORDER: Readonly<Record<LogVerdict, true>> = {
  approve: true,
  deny: true,
  escalate: true,
  cancelled: true,
  error: true,
};
const LOG_VERDICTS = Object.keys(LOG_VERDICT_ORDER) as LogVerdict[];

function buildLogReport(text: string): LogReport {
  const { tally } = parseDecisionLog(text);
  const latencyByVerdict: Record<LogVerdict, LatencyStats> = {
    approve: { count: 0, p50: null, p95: null },
    deny: { count: 0, p50: null, p95: null },
    escalate: { count: 0, p50: null, p95: null },
    cancelled: { count: 0, p50: null, p95: null },
    error: { count: 0, p50: null, p95: null },
  };
  for (const verdict of LOG_VERDICTS) {
    const values = tally.latenciesByVerdict[verdict];
    latencyByVerdict[verdict] = {
      count: values.length,
      p50: percentile(values, 50),
      p95: percentile(values, 95),
    };
  }
  return {
    totalLines: tally.totalLines,
    autoApproveNonDecision: tally.autoApproveNonDecision,
    fastPathCount: tally.fastPathCount,
    llmPathCount: tally.llmPathCount,
    byVerdict: tally.byVerdict,
    byVerdictBandDecidedBy: tally.byVerdictBandDecidedBy,
    latencyByVerdict,
    queueTimeoutCount: tally.queueTimeoutCount,
    riskCeilingCount: tally.riskCeilingCount,
  };
}

// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------

function pct(n: number): string {
  return `${n.toFixed(1)}%`;
}

function rule(): void {
  console.log('='.repeat(88));
}

function printReport(report: Report): void {
  console.log('');
  rule();
  console.log('  Phase 1 approval-rate report (#992 / #1057)');
  rule();
  console.log(`  date:              ${report.provenance.date}`);
  console.log(`  input:             ${report.provenance.inputPath}`);
  console.log(`  event:             ${report.provenance.eventName}`);
  if (report.provenance.caveat !== undefined) {
    console.log(`                     CAVEAT: ${report.provenance.caveat}`);
  }
  console.log(
    `  records:           ${report.provenance.rawRecordCount} raw, ${report.provenance.effectiveRecordCount} replayed${report.provenance.unique ? ' (--unique)' : ''}`,
  );
  console.log(
    `  config:            ${report.provenance.configPath}${report.provenance.configFound ? '' : ' (not found; built-in defaults)'}`,
  );
  console.log(`  level:             ${report.provenance.resolvedLevel}`);
  console.log(
    `  approve_groups:    ${report.provenance.resolvedApproveGroups.length > 0 ? report.provenance.resolvedApproveGroups.join(', ') : '(none)'}`,
  );
  console.log(`  log_decisions:     ${report.provenance.logDecisions}`);
  if (report.provenance.logPath !== undefined) {
    console.log(`  log:               ${report.provenance.logPath}`);
  }
  rule();

  console.log('\n(a) Deterministic coverage\n');
  const c = report.coverage;
  console.log(
    `  TOTAL   ${String(c.total).padStart(6)}   approve ${String(c.approve).padStart(5)} (allow ${c.approveBySource.allow}, group ${c.approveBySource.group})   deny-covered ${String(c.denyCovered).padStart(4)} (pattern ${c.denyCoveredBySource.pattern}, group ${c.denyCoveredBySource.group})   residual ${String(c.residual).padStart(5)}   coverage ${pct(c.coveragePct)}`,
  );
  console.log('');
  const toolNames = Object.keys(c.perTool).sort();
  const toolNameWidth = Math.max(4, ...toolNames.map((t) => t.length));
  for (const tool of toolNames) {
    const t = c.perTool[tool];
    if (!t) continue;
    console.log(
      `  ${tool.padEnd(toolNameWidth)}  total ${String(t.total).padStart(5)}  approve ${String(t.approve).padStart(5)}  deny-covered ${String(t.denyCovered).padStart(4)}  residual ${String(t.residual).padStart(5)}  coverage ${pct(t.coveragePct)}`,
    );
  }

  console.log('\n(b) Miss classification (residual Bash commands, by shape)\n');
  // Widest label decides the column, not a hardcoded guess -- 'unclassifiable'
  // (14 chars) is longer than every MissBucket name, so a fixed width sized
  // to the buckets alone broke alignment on that row.
  const bucketLabelWidth = Math.max(...MISS_BUCKETS.map((b) => b.length), 'unclassifiable'.length);
  for (const bucket of MISS_BUCKETS) {
    const stats = report.misses.buckets[bucket];
    const bandStr = RISK_BANDS.map((band) => `${band}=${stats.byBand[band]}`).join(' ');
    console.log(
      `  ${bucket.padEnd(bucketLabelWidth)} ${String(stats.count).padStart(5)}   ${bandStr}`,
    );
  }
  console.log(
    `  ${'unclassifiable'.padEnd(bucketLabelWidth)} ${String(report.misses.unclassifiable).padStart(5)}   (non-Bash, or no string command)`,
  );

  console.log('\n(c) Band distribution of the LLM-bound residue\n');
  for (const band of RISK_BANDS) {
    const n = report.residualBand.byBand[band];
    console.log(
      `  ${band.padEnd(9)} ${String(n).padStart(5)}   ${pct(pctOf(n, report.residualBand.total))}`,
    );
  }

  if (report.log !== undefined) {
    const log = report.log;
    console.log('\n(d) Live decision log\n');
    console.log(
      `  lines: ${log.totalLines}   aa-non-decision: ${log.autoApproveNonDecision}   fast-path: ${log.fastPathCount}   llm-path: ${log.llmPathCount}   queue-timeout: ${log.queueTimeoutCount}   risk-ceiling: ${log.riskCeilingCount}`,
    );
    console.log('\n  verdict rates:\n');
    for (const verdict of LOG_VERDICTS) {
      const n = log.byVerdict[verdict];
      const lat = log.latencyByVerdict[verdict];
      console.log(
        `  ${verdict.padEnd(10)} ${String(n).padStart(5)}   p50 ${String(lat.p50 ?? '-').padStart(6)}ms   p95 ${String(lat.p95 ?? '-').padStart(6)}ms   (n=${lat.count})`,
      );
    }
    console.log('\n  verdict x band x decided_by:\n');
    for (const [key, n] of Object.entries(log.byVerdictBandDecidedBy).sort()) {
      console.log(`  ${key.padEnd(40)} ${String(n).padStart(5)}`);
    }
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function resolveAutoApproveConfig(): { config: AutoApproveConfig; configFound: boolean } {
  const configFound = fs.existsSync(configPath);
  const loaded = applyEnvOverrides(loadConfig(configPath));
  if (levelOverride === undefined) {
    return { config: loaded.auto_approve, configFound };
  }
  return {
    config: {
      ...loaded.auto_approve,
      level: levelOverride,
      approve_groups: groupsForLevel(levelOverride),
    },
    configFound,
  };
}

function main(): void {
  if (!fs.existsSync(inputPath)) {
    console.error(
      `[approval-rate] No corpus at ${inputPath}. Generate one with:\n  bun run packages/daemon/tests/hooks/fixtures/build-hook-corpus.ts --mode structure-preserving [--input ~/.remi/hook-diag.jsonl]\nor pass --input pointing at an existing JSONL capture.`,
    );
    process.exit(1);
  }

  const rawRecords = loadCorpusRecords(inputPath, eventName);
  const recordsByIndex = new Map(rawRecords.map((r) => [r.index, r] as const));
  const { config, configFound } = resolveAutoApproveConfig();

  const replay = replayDeterministic(rawRecords, config, { unique: uniqueFlag });

  let log: LogReport | undefined;
  if (logPath !== undefined) {
    const text = fs.readFileSync(logPath, 'utf8');
    const builtLog = buildLogReport(text);
    log = builtLog;
    // Diagnostic, independent of --json: a `false` log_decisions on the
    // source machine makes the post-LLM matrix line (and the deterministic-
    // approve / multichoice-skip lines) never get written at all, so
    // llmPathCount reads 0 even though real verdicts were logged. Printed to
    // stderr so it never lands inside piped/parsed --json stdout.
    const totalVerdicts = LOG_VERDICTS.reduce(
      (sum, verdict) => sum + builtLog.byVerdict[verdict],
      0,
    );
    if (builtLog.llmPathCount === 0 && totalVerdicts > 0) {
      console.error(
        `[approval-rate] WARNING: llm-path is 0 while byVerdict totals ${totalVerdicts} > 0 -- likely log_decisions = false on the machine that wrote this log, gating out the post-LLM matrix line (see provenance.log_decisions).`,
      );
    }
  }

  const report: Report = {
    provenance: {
      date: new Date().toISOString(),
      inputPath,
      eventName,
      rawRecordCount: rawRecords.length,
      effectiveRecordCount: replay.tally.total,
      unique: uniqueFlag,
      configPath,
      configFound,
      resolvedLevel: config.level,
      resolvedApproveGroups: config.approve_groups,
      logDecisions: config.log_decisions,
      logPath,
      caveat:
        eventName !== 'PermissionRequest'
          ? 'not the asked-remi population #996 measured -- includes calls approved without a PermissionRequest.'
          : undefined,
    },
    coverage: buildCoverageReport(replay.tally),
    misses: buildMissReport(replay, recordsByIndex),
    residualBand: buildBandReport(replay.tally),
    log,
  };

  if (jsonFlag) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  printReport(report);
}

try {
  main();
} catch (err) {
  console.error(`[approval-rate] ${errorToString(err)}`);
  process.exit(1);
}
