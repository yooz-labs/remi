import { AutoApproveService } from '../../src/auto-approve/auto-approve-service.ts';
import type { AutoApproveConfig } from '../../src/auto-approve/types.ts';
import {
  PERMISSION_BANK,
  buildPermissionBankToolInput,
  summarizePermissionBank,
} from './permission-bank.ts';
import type { PermissionBankCase } from './permission-bank.ts';

/**
 * Opt-in local-model replay for the curated permission bank.
 *
 * This streams cases and verdicts to stdout as they settle. The production
 * client currently consumes one bounded JSON completion per review; this
 * runner therefore streams the replay, not model tokens. No bank command is
 * executed.
 */

function env(name: string): string | undefined {
  return process.env[name];
}

function parsePositiveInt(name: string, fallback: number): number {
  const value = Number.parseInt(env(name) ?? '', 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function isLoopbackUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

function selectCases(): readonly PermissionBankCase[] {
  const source = env('BANK_SOURCE');
  const category = env('BANK_CATEGORY');
  const authority = env('BANK_AUTHORITY');
  const ids = new Set(
    (env('BANK_IDS') ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
  const filtered = PERMISSION_BANK.filter((sample) => {
    if (source !== undefined && sample.source !== source) return false;
    if (category !== undefined && sample.category !== category) return false;
    if (authority !== undefined && sample.authorityKind !== authority) return false;
    if (ids.size > 0 && !ids.has(sample.id)) return false;
    return true;
  });
  const limit = parsePositiveInt('BANK_LIMIT', 24);
  // An explicit ID list is a reproducibility request: never silently drop a
  // valid case because the ordinary smoke limit is 24. Use BANK_LIMIT=0 for
  // an unfiltered full-bank replay, or the category/source filters for a
  // bounded slice.
  if (ids.size > 0 || limit === 0) return filtered;

  const hasFilter = source !== undefined || category !== undefined || authority !== undefined;
  if (hasFilter) return filtered.slice(0, limit);

  // Keep the default smoke run representative. The bank is ordered for
  // readable provenance, so a plain prefix would exercise only the first
  // safe family and miss the fail-closed categories.
  const byCategory = new Map<string, PermissionBankCase[]>();
  for (const sample of filtered) {
    const cases = byCategory.get(sample.category) ?? [];
    cases.push(sample);
    byCategory.set(sample.category, cases);
  }
  const selected: PermissionBankCase[] = [];
  const categories = [...byCategory.keys()];
  for (let offset = 0; selected.length < limit; offset++) {
    let added = false;
    for (const categoryName of categories) {
      const sample = byCategory.get(categoryName)?.[offset];
      if (sample === undefined) continue;
      selected.push(sample);
      added = true;
      if (selected.length === limit) break;
    }
    if (!added) break;
  }
  return selected;
}

function missingRequestedIds(): readonly string[] {
  const requested = (env('BANK_IDS') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  return requested.filter((id) => !PERMISSION_BANK.some((sample) => sample.id === id));
}

function makeConfig(provider: string, baseUrl: string, model: string): AutoApproveConfig {
  return {
    enabled: true,
    provider,
    model,
    api_key: env('BANK_API_KEY') ?? '',
    base_url: baseUrl,
    timeout: parsePositiveInt('BANK_TIMEOUT_SECONDS', 45),
    log_decisions: true,
    residual_action: 'escalate',
    risk_review: 'verified',
    allow: [],
    deny: [],
    subagent_alert: [],
    approve_groups: [],
    level: 'strict',
    deny_groups: [],
    instructions: '',
    multichoice: 'skip',
    multichoice_model: '',
    escalate_model: '',
    escalate_timeout: 0,
    queue_timeout: 240,
    cache_idle: 0,
    keep_alive: 0,
    engine: 'owned',
    engine_path: '',
    model_cache: '',
    disable_thinking: env('BANK_ENABLE_THINKING') !== '1',
    always_escalate_tools: [],
    session_precedent: false,
    hold_timeout: 0,
    push_hold_timeout: 0,
    delivery_confirm_timeout: 0,
    hold_unconfirmed_timeout: 0,
  };
}

function evaluateSample(service: AutoApproveService, sample: PermissionBankCase) {
  return service.evaluate(
    'Bash',
    buildPermissionBankToolInput(sample),
    sample.context.sessionId,
    undefined,
    undefined,
    undefined,
    sample.context.sessionId,
    false,
    sample.authority,
    undefined,
    undefined,
    sample.context.workingDirectory,
  );
}

if (env('BANK_LIVE') !== '1') {
  console.error('Refusing live permission-bank replay without BANK_LIVE=1.');
  console.error(
    'Example: BANK_LIVE=1 BANK_PROVIDER=llamacpp BANK_LIMIT=24 bun run packages/daemon/tests/auto-approve/run-permission-bank.ts',
  );
  process.exitCode = 2;
} else {
  const provider = env('BANK_PROVIDER') ?? 'llamacpp';
  const baseUrl = env('BANK_BASE_URL') ?? 'http://127.0.0.1:19924/v1';
  const providerUrl =
    provider.startsWith('http://') || provider.startsWith('https://') ? provider : baseUrl;
  if (!isLoopbackUrl(providerUrl)) {
    console.error('Permission-bank replay only accepts a loopback local-model endpoint.');
    process.exitCode = 2;
  } else {
    const model = env('BANK_MODEL') ?? 'YoozLabs/Qwen3.5-4B-qat-GGUF:Q4_0';
    const cases = selectCases();
    const bankSummary = summarizePermissionBank(cases);
    const missingIds = missingRequestedIds();
    if (missingIds.length > 0) {
      console.error(`Unknown permission-bank IDs: ${missingIds.join(', ')}`);
      process.exitCode = 2;
    } else if (cases.length === 0) {
      console.error('No permission-bank cases matched the selected filters.');
      process.exitCode = 2;
    } else {
      let activeLogs: string[] = [];
      // `llamacpp` is a named provider whose production resolver normally
      // pins the reserved port. A caller-supplied loopback URL is deliberate
      // here so an SSH tunnel or isolated fixture can be replayed safely.
      const configProvider = provider === 'yooz' ? provider : providerUrl;
      const service = new AutoApproveService(makeConfig(configProvider, baseUrl, model), (line) => {
        activeLogs.push(line);
      });
      let failures = 0;
      const categoryTotals = new Map<string, { total: number; passed: number }>();

      console.log(
        `Permission-bank replay: ${bankSummary.total} cases (no bank command execution; local model only)`,
      );
      console.log(
        `Expected: approve=${bankSummary.expectedApprovals} escalate=${bankSummary.expectedEscalations} proof_pass=${bankSummary.proofPasses} proof_reject=${bankSummary.proofRejections}`,
      );

      for (const [index, sample] of cases.entries()) {
        activeLogs = [];
        console.log(
          `[${index + 1}/${cases.length}] ${sample.id} source=${sample.source} category=${sample.category} authority=${sample.authorityKind}`,
        );
        console.log(
          `  session=${sample.context.sessionId} path=${sample.context.workingDirectory} repo=${sample.context.repository} branch=${sample.context.branch}`,
        );
        console.log(`  command=${JSON.stringify(sample.command)}`);

        const started = Date.now();
        const result = await evaluateSample(service, sample);
        const elapsedMs = Date.now() - started;
        const reviewerCalls = activeLogs.filter(
          (line) => line.includes('VERIFIED INTENT') || line.includes('VERIFIED REVIEW'),
        ).length;
        const passed =
          result.decision === sample.expected.decision &&
          reviewerCalls === sample.expected.modelCalls;
        if (!passed) failures++;
        const category = categoryTotals.get(sample.category) ?? { total: 0, passed: 0 };
        category.total++;
        if (passed) category.passed++;
        categoryTotals.set(sample.category, category);

        console.log(
          `  ${passed ? 'PASS' : 'FAIL'} decision=${result.decision} expected=${sample.expected.decision} reviewer_calls=${reviewerCalls} expected_calls=${sample.expected.modelCalls} elapsed_ms=${elapsedMs}`,
        );
        console.log(`  reason=${result.reasoning.replaceAll('\n', ' ')}`);
        for (const line of activeLogs.filter((entry) => entry.includes('VERIFIED'))) {
          console.log(`  telemetry=${line}`);
        }
      }

      console.log('\nReplay summary:');
      for (const [category, totals] of categoryTotals) {
        console.log(`  ${category}: ${totals.passed}/${totals.total} pass`);
      }
      console.log(`  overall: ${cases.length - failures}/${cases.length} pass`);
      process.exitCode = failures === 0 ? 0 : 1;
    }
  }
}
