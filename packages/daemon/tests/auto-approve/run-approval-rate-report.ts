#!/usr/bin/env bun
/**
 * Phase 1 approval-rate report (epic #1057, closes #992): how much of a real
 * `PermissionRequest` corpus the DETERMINISTIC layers (`allow`/`deny`/
 * `approve_groups`/`deny_groups`, #1024's `evaluateDeterministic`) already
 * decide with no LLM call, what shape the misses have, and -- given a live
 * `remi.log` -- how the LLM path itself is actually behaving. Not a
 * `bun:test` file; run directly with `bun run`.
 *
 * Usage:
 *   bun packages/daemon/tests/auto-approve/run-approval-rate-report.ts \
 *     [--input <path>] [--config <path>] [--level strict|balanced|trusted] \
 *     [--log <path>] [--unique] [--json]
 *
 * Flags:
 *   --input <path>   JSONL corpus to replay (`loadCorpusRecords`). Default:
 *                     fixtures/.local-command-corpus.jsonl next to this
 *                     script (gitignored, developer-generated -- see
 *                     `build-hook-corpus.ts --mode structure-preserving`).
 *   --config <path>  `config.toml` to load `[auto_approve]` from. Default:
 *                     `~/.remi/config.toml` (same default `loadConfig` uses).
 *   --level <name>   Overrides the resolved config's `approve_groups` with
 *                     `groupsForLevel(<name>)` -- lets one config be swept
 *                     across all three strictness presets without editing it.
 *   --log <path>     A `remi.log` (or any text carrying `[AutoApprove ...]`
 *                     lines) to additionally run through `parseDecisionLog`.
 *                     Omitted: the log section is skipped entirely.
 *   --unique         Dedupe `Bash` records by exact command string before
 *                     replay (`replayDeterministic`'s own option).
 *   --json           Print one JSON object instead of tables. The table and
 *                     JSON renderers consume the exact same computed
 *                     `Report`, so the two can never disagree with each
 *                     other about a number.
 *
 * Exits non-zero only on a real error (input file missing, config/log
 * unreadable, invalid `--level`) -- an empty-but-present corpus is not an
 * error and reports as all-zero.
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
  replayDeterministic,
} from './approval-rate.ts';

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

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
  readonly rawRecordCount: number;
  readonly effectiveRecordCount: number;
  readonly unique: boolean;
  readonly configPath: string;
  readonly configFound: boolean;
  readonly resolvedLevel: AutoApproveLevel;
  readonly resolvedApproveGroups: readonly string[];
  readonly logPath: string | undefined;
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
  readonly unparsed: number;
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

const MISS_BUCKETS: readonly MissBucket[] = [
  'heredoc',
  'redirection',
  'pipeline',
  'chained',
  'single',
];

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

/** Nearest-rank percentile (ceil, not floor): for a 2-sample array, `p50`
 *  lands on the lower value and `p95` on the upper one, matching what a
 *  reader expects a median of two samples to mean. A floor-based index
 *  instead picks the UPPER value for `p50` at every even small `n` --
 *  technically a valid discrete-percentile convention, but confusing in a
 *  report meant to be read directly. */
function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? null;
}

const LOG_VERDICTS: readonly LogVerdict[] = ['approve', 'deny', 'escalate', 'cancelled', 'error'];

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
    unparsed: tally.unparsed,
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
  for (const bucket of MISS_BUCKETS) {
    const stats = report.misses.buckets[bucket];
    const bandStr = RISK_BANDS.map((band) => `${band}=${stats.byBand[band]}`).join(' ');
    console.log(`  ${bucket.padEnd(11)} ${String(stats.count).padStart(5)}   ${bandStr}`);
  }
  console.log(
    `  ${'unclassifiable'.padEnd(11)} ${String(report.misses.unclassifiable).padStart(5)}   (non-Bash, or no string command)`,
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
      `  lines: ${log.totalLines}   unparsed: ${log.unparsed}   fast-path: ${log.fastPathCount}   llm-path: ${log.llmPathCount}   queue-timeout: ${log.queueTimeoutCount}   risk-ceiling: ${log.riskCeilingCount}`,
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

  const rawRecords = loadCorpusRecords(inputPath);
  const recordsByIndex = new Map(rawRecords.map((r) => [r.index, r] as const));
  const { config, configFound } = resolveAutoApproveConfig();

  const replay = replayDeterministic(rawRecords, config, { unique: uniqueFlag });

  let log: LogReport | undefined;
  if (logPath !== undefined) {
    const text = fs.readFileSync(logPath, 'utf8');
    log = buildLogReport(text);
  }

  const report: Report = {
    provenance: {
      date: new Date().toISOString(),
      inputPath,
      rawRecordCount: rawRecords.length,
      effectiveRecordCount: replay.tally.total,
      unique: uniqueFlag,
      configPath,
      configFound,
      resolvedLevel: config.level,
      resolvedApproveGroups: config.approve_groups,
      logPath,
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
