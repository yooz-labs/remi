import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import {
  type LineCoverage,
  type SourceSnapshot,
  lineSummary,
  parseLineCoverage,
  serializeLineCoverage,
  sourceIdentity,
  unionLineCoverage,
} from './merge-bun-line-coverage';
import { runChild } from './run-bun-test-with-diagnostics';

export const TARGET = 'packages/daemon/tests/cli/remote-new-client.test.ts';
export const OWNER_PREFIX = '[ci-target-module-owner] ';
export const CONTROLLER_MS = 22 * 60_000;
const CLEANUP_MS = 10_000;
export function laneDeadlineMs(index: number, elapsedMs: number): number {
  requireValue(index === 0 || index === 1 || index === 2, 'Unknown test lane');
  requireValue(Number.isFinite(elapsedMs) && elapsedMs >= 0, 'Invalid elapsed time');
  const remaining = CONTROLLER_MS - elapsedMs - CLEANUP_MS;
  // Each isolated worker keeps its existing cap. Local sequential runs also
  // share the controller remainder, always reserving time for owned cleanup.
  const deadline = Math.min(index === 0 ? 300_000 : 1_200_000, remaining);
  requireValue(deadline > 0, 'Controller deadline exhausted');
  return deadline;
}
const EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts']);
const SUFFIX = /(?:\.test|_test|\.spec|_spec)$/;
export type CaseRecord = {
  file: string;
  suite: string;
  name: string;
  status: string;
  assertions: number;
};
type TestContract = {
  runtime: string;
  target: string;
  sourcePins: Record<string, { sha256: string; mode: number }>;
  cases: CaseRecord[];
  assertions: number;
};

function requireValue(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function compare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}
function json(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

/** Mirror the pinned Bun Scanner default, not Git's tracked-file list. */
export function discoverTests(root: string): string[] {
  requireValue(realpathSync(root) === root, 'Noncanonical discovery root');
  const config = Bun.TOML.parse(readFileSync(path.join(root, 'bunfig.toml'), 'utf8')) as Record<
    string,
    unknown
  >;
  requireValue(
    Object.keys(config).every((key) => key === 'test'),
    'Unsupported root Bun configuration',
  );
  const settings = config['test'];
  requireValue(
    settings && typeof settings === 'object' && !Array.isArray(settings),
    'Missing test configuration',
  );
  requireValue(
    Object.keys(settings).every((key) => key === 'preload'),
    'Unsupported discovery/coverage settings',
  );
  requireValue(
    JSON.stringify((settings as Record<string, unknown>)['preload']) ===
      JSON.stringify([
        './packages/daemon/tests/debug/test-harness-marker.ts',
        './packages/daemon/tests/unset-remi-home.ts',
      ]),
    'Root preloads changed',
  );
  const files: string[] = [];
  function walk(directory: string): void {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      const lower = item.name.toLowerCase();
      // Bun ignores these directory trees. Do not follow hidden/node_modules aliases.
      if (item.isDirectory() && (lower.startsWith('.') || lower === 'node_modules')) continue;
      if (
        item.isSymbolicLink() &&
        (lower.startsWith('.') || lower === 'node_modules') &&
        statSync(file).isDirectory()
      )
        continue;
      requireValue(!item.isSymbolicLink(), 'Undeclared source symlink during discovery');
      if (item.isDirectory()) walk(file);
      else {
        requireValue(item.isFile(), 'Nonregular discovery input');
        const extension = path.extname(lower);
        if (EXTENSIONS.has(extension) && SUFFIX.test(lower.slice(0, -extension.length))) {
          requireValue(realpathSync(file) === file, 'Noncanonical discovered test');
          files.push(path.relative(root, file).split(path.sep).join('/'));
        }
      }
    }
  }
  walk(root);
  requireValue(
    files.length > 0 && new Set(files).size === files.length,
    'Empty/duplicate test manifest',
  );
  return files.sort(compare);
}

export function partitionTests(files: string[]): string[][] {
  requireValue(
    files.filter((file) => file === TARGET).length === 1,
    'Exact target must occur once',
  );
  const rest = files.filter((file) => file !== TARGET);
  requireValue(rest.length > 0 && new Set(files).size === files.length, 'Invalid test partition');
  // Keep the pinned target isolated. Each other file belongs to exactly one
  // sorted shared-cache cohort; no test-selection flags can shrink the suite.
  return [
    [TARGET],
    rest.filter((file) => file.startsWith('packages/daemon/')),
    rest.filter((file) => !file.startsWith('packages/daemon/')),
  ].filter((lane) => lane.length > 0);
}

/** Git is source identity evidence only. Discovery above includes untracked tests too. */
export function snapshotSources(root: string, tests: string[]): SourceSnapshot {
  const result = Bun.spawnSync(
    ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  requireValue(result.exitCode === 0, 'Cannot inventory candidate source');
  const encoded = result.stdout.toString('utf8');
  requireValue(encoded.endsWith('\0'), 'Malformed Git source inventory');
  const names = [
    ...new Set([
      ...encoded
        .slice(0, -1)
        .split('\0')
        .filter(
          (name) =>
            name !== 'test-batches-output.txt' &&
            name !== 'test-output.txt' &&
            !name.startsWith('coverage/test-lanes/'),
        ),
      ...tests,
    ]),
  ].sort(compare);
  // Only the Git-tracked public ROOT template is an exception. Never read real env files.
  const example = Bun.spawnSync(['git', 'ls-files', '--stage', '-z', '--', '.env.example'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const trackedPublicExample =
    example.exitCode === 0 &&
    /^100644 [0-9a-f]{40} 0\t\.env\.example\0$/.test(example.stdout.toString('utf8'));
  const snapshot: SourceSnapshot = {};
  for (const name of names) {
    requireValue(
      name &&
        !path.isAbsolute(name) &&
        !name.split('/').some((part) => part === '..' || part === '.' || part === ''),
      'Unsafe source path',
    );
    requireValue(
      !name.split('/').some((part) => part === '.env' || part.startsWith('.env.')) ||
        (name === '.env.example' && trackedPublicExample),
      'Secret file cannot enter source evidence',
    );
    const file = path.join(root, name);
    const info = lstatSync(file);
    requireValue(info.isFile() && realpathSync(file) === file, 'Nonregular candidate source');
    // Some tracked binary fixtures are not coverage sources, but still pin their bytes.
    const bytes = readFileSync(file);
    snapshot[name] = {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      mode: info.mode & 0o777,
      lines: bytes.toString('utf8').split('\n').length,
    };
  }
  return snapshot;
}

function decode(value: string): string {
  requireValue(
    !/&(?!(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);)/.test(value),
    'Malformed XML entity',
  );
  return value.replace(/&([^;]+);/g, (_whole, entity: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(named, entity)) return named[entity] ?? '';
    requireValue(/^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(entity), 'Unsupported XML entity');
    const code = entity.startsWith('#x')
      ? Number.parseInt(entity.slice(2), 16)
      : Number(entity.slice(1));
    requireValue(
      // Bun 1.3.11's reporter emits numeric NUL in test titles; retain its reported bytes.
      code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff),
      'Invalid XML scalar',
    );
    return String.fromCodePoint(code);
  });
}
function attributes(source: string): Record<string, string> {
  const result: Record<string, string> = {};
  let remaining = source;
  while (remaining.trim()) {
    const match = /^\s+([A-Za-z][A-Za-z0-9_-]*)="([^"<>]*)"/.exec(remaining);
    requireValue(
      match?.[1] && match[2] !== undefined && !Object.hasOwn(result, match[1]),
      'Malformed/duplicate XML attribute',
    );
    result[match[1]] = decode(match[2]);
    remaining = remaining.slice(match[0].length);
  }
  return result;
}
function number(value: string | undefined): number {
  requireValue(
    value !== undefined && /^(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value)),
    'Invalid JUnit count',
  );
  return Number(value);
}
export function caseMultiset(cases: CaseRecord[]): string[] {
  return cases.map((row) => JSON.stringify(row)).sort(compare);
}

/** Read the actual pinned Bun JUnit schema; never infer imported source ownership. */
export function parseCases(
  text: string,
  expectedFiles: string[],
): { cases: CaseRecord[]; assertions: number } {
  requireValue(
    text.startsWith('<?xml version="1.0" encoding="UTF-8"?>'),
    'Unexpected JUnit declaration',
  );
  const stack: string[] = [];
  const cases: CaseRecord[] = [];
  let current: CaseRecord | null = null;
  let totals: Record<string, string> | null = null;
  let offset = text.indexOf('?>') + 2;
  for (const token of text.slice(offset).matchAll(/<[^>]*>/g)) {
    const index = (token.index ?? 0) + text.indexOf('?>') + 2;
    requireValue(!text.slice(offset, index).trim(), 'Unexpected JUnit text');
    const raw = token[0];
    const match = /^<(\/?)([a-z]+)([\s\S]*?)(\/?)>$/.exec(raw);
    requireValue(match?.[2] && match[3] !== undefined, 'Unknown JUnit syntax');
    const name = match[2];
    const closing = match[1] === '/';
    const selfClosing = match[4] === '/';
    requireValue(
      [
        'testsuites',
        'testsuite',
        'testcase',
        'failure',
        'skipped',
        'properties',
        'property',
      ].includes(name),
      'Unknown JUnit element',
    );
    if (closing) {
      requireValue(!selfClosing && !match[3].trim() && stack.pop() === name, 'Unbalanced JUnit');
      if (name === 'testcase') {
        requireValue(current, 'Missing testcase');
        cases.push(current);
        current = null;
      }
    } else {
      const attrs = attributes(match[3]);
      const parents: Record<string, string[]> = {
        testsuites: [],
        testsuite: ['testsuites', 'testsuite'],
        testcase: ['testsuite'],
        properties: ['testsuite'],
        property: ['properties'],
        failure: ['testcase'],
        skipped: ['testcase'],
      };
      if (name !== 'testsuites')
        requireValue(parents[name]?.includes(stack.at(-1) ?? ''), 'Invalid JUnit parent');
      if (name === 'testsuites') {
        requireValue(totals === null && stack.length === 0 && !selfClosing, 'Duplicate JUnit root');
        totals = attrs;
      } else requireValue(stack.length > 0, 'JUnit element outside root');
      if (name === 'testcase') {
        requireValue(
          current === null &&
            attrs['file'] &&
            expectedFiles.includes(attrs['file']) &&
            attrs['classname'] !== undefined &&
            attrs['name'] !== undefined,
          'Foreign/unattributed testcase',
        );
        current = {
          file: attrs['file'],
          suite: attrs['classname'],
          name: attrs['name'],
          status: 'pass',
          assertions: number(attrs['assertions']),
        };
        if (selfClosing) {
          cases.push(current);
          current = null;
        }
      }
      if (name === 'failure' || name === 'skipped') {
        requireValue(
          current !== null && current.status === 'pass',
          'Unbound/duplicate case disposition',
        );
        current.status = name === 'failure' ? 'fail' : 'skip';
      }
      if (!selfClosing) stack.push(name);
    }
    offset = index + raw.length;
  }
  requireValue(
    !text.slice(offset).trim() && stack.length === 0 && totals !== null && current === null,
    'Incomplete JUnit',
  );
  const assertions = cases.reduce((sum, row) => sum + row.assertions, 0);
  requireValue(
    number(totals['tests']) === cases.length &&
      number(totals['assertions']) === assertions &&
      number(totals['failures']) === cases.filter((row) => row.status === 'fail').length &&
      number(totals['skipped']) === cases.filter((row) => row.status === 'skip').length,
    'JUnit totals disagree',
  );
  requireValue(cases.length > 0, 'No actual cases');
  return { cases, assertions };
}

export function validateOwnership(
  lines: string[],
  expected: 0 | 1,
  pid: number,
  token: string,
  targetURL: string,
): void {
  requireValue(lines.length === expected, 'Target module loaded in wrong lane or more than once');
  for (const line of lines) {
    requireValue(line.startsWith(OWNER_PREFIX), 'Malformed ownership prefix');
    const row: unknown = JSON.parse(line.slice(OWNER_PREFIX.length));
    requireValue(
      row && typeof row === 'object' && !Array.isArray(row),
      'Malformed ownership record',
    );
    const value = row as Record<string, unknown>;
    requireValue(
      Object.keys(value).sort().join(',') === 'pid,token,url' &&
        value['pid'] === pid &&
        value['token'] === token &&
        value['url'] === targetURL,
      'Ownership correlation mismatch',
    );
  }
}

export function validateTargetContract(
  contract: TestContract,
  root: string,
  actual: { cases: CaseRecord[]; assertions: number },
): void {
  requireValue(
    contract.target === TARGET && contract.runtime === Bun.revision,
    'Target/runtime contract differs',
  );
  for (const [name, expected] of Object.entries(contract.sourcePins)) {
    const observed = sourceIdentity(path.join(root, name));
    requireValue(
      observed.sha256 === expected.sha256 && observed.mode === expected.mode,
      `Target test/helper contract changed: ${name}`,
    );
  }
  requireValue(
    contract.assertions === actual.assertions &&
      JSON.stringify(caseMultiset(contract.cases)) === JSON.stringify(caseMultiset(actual.cases)),
    'Target case multiset/assertions changed',
  );
}

/** The actual production pre-lane source/contract preparation; no lane is launched here. */
export function prepareSuite(root: string) {
  const files = discoverTests(root);
  const lanes = partitionTests(files);
  const before = snapshotSources(root, files);
  const contract = JSON.parse(
    readFileSync(path.join(root, 'scripts/ci/remote-new-client-contract.json'), 'utf8'),
  ) as TestContract;
  // Source drift is refused BEFORE any worker body, not repaired or regenerated in CI.
  requireValue(
    contract.target === TARGET && contract.runtime === Bun.revision,
    'Unsupported target contract',
  );
  for (const [name, expected] of Object.entries(contract.sourcePins)) {
    const actual = before[name];
    requireValue(
      actual && actual.sha256 === expected.sha256 && actual.mode === expected.mode,
      'Target source/helper pin mismatch',
    );
  }
  requireValue(
    Object.keys(contract.sourcePins).sort().join(',') ===
      [
        TARGET,
        'packages/daemon/tests/integration/hub-test-utils.ts',
        'packages/daemon/tests/session/port-test-helpers.ts',
      ]
        .sort()
        .join(','),
    'Target helper pin set differs',
  );
  return { files, lanes, before, contract };
}

export async function runSuite(
  root: string,
  output: string,
  summary: string,
  streams: { stdout?: Writable; stderr?: Writable } = {},
  workerIndex?: number,
): Promise<void> {
  requireValue(
    !existsSync(output) && !existsSync(summary),
    'Refusing existing run evidence/summary',
  );
  const started = performance.now();
  const { files, lanes, before, contract } = prepareSuite(root);
  requireValue(
    workerIndex === undefined ||
      (Number.isInteger(workerIndex) && workerIndex >= 0 && workerIndex < lanes.length),
    'Invalid worker index',
  );
  for (const origin of [
    root,
    path.join(root, 'packages/daemon/src'),
    path.join(root, 'packages/web/tests/lib'),
  ]) {
    requireValue(
      realpathSync(Bun.resolveSync('@remi/shared', origin)) ===
        path.join(root, 'packages/shared/src/index.ts'),
      'Noncanonical workspace alias',
    );
  }
  mkdirSync(path.dirname(output), { recursive: true });
  mkdirSync(output, { recursive: false });
  const token = randomUUID();
  const evidence = new Map<
    number,
    {
      lane: string;
      exit: number;
      files: string[];
      cases: CaseRecord[];
      assertions: number;
      contractFailure: string | null;
      cleanupVerified: boolean;
    }
  >();
  const reports = new Map<number, LineCoverage>();
  const orderedEvidence = () => [...evidence].sort(([a], [b]) => a - b).map(([, value]) => value);
  json(path.join(output, 'manifest.json'), {
    files,
    lanes,
    before,
    runtime: Bun.revision,
    token,
    workerIndex: workerIndex ?? null,
    machineBootId:
      process.platform === 'linux'
        ? readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
        : null,
    scope:
      'isolated target and daemon/other shared-cache cohorts; concurrent workers require separate runner machines; cross-worker cache interactions and hidden nested child imports are not attested',
  });
  let failed = false;
  try {
    async function runLane(index: number, lane: string[]): Promise<void> {
      const elapsedMs = performance.now() - started;
      const deadline = laneDeadlineMs(index, elapsedMs);
      const name = index === 0 ? 'target' : `rest-${index}`;
      const laneOutput = path.join(output, name);
      mkdirSync(laneOutput);
      json(path.join(laneOutput, 'budget.json'), {
        controllerMs: CONTROLLER_MS,
        cleanupReserveMs: CLEANUP_MS,
        elapsedMs,
        deadlineMs: deadline,
      });
      // Real home-based state (daemon.pid, trust files, install probes) must
      // never be shared by concurrent workers or touch the invoking user's home.
      const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'remi-ci-home-')));
      json(path.join(laneOutput, 'worker.json'), { index, name, home, files: lane });
      const reportFile = path.join(laneOutput, 'junit.xml');
      const argv = [
        process.execPath,
        'test',
        ...lane.map((file) => `./${file}`),
        '--coverage',
        '--coverage-reporter=lcov',
        '--coverage-dir',
        laneOutput,
        '--reporter=junit',
        `--reporter-outfile=${reportFile}`,
      ];
      console.log(
        `[ci-test-lane] ${JSON.stringify({ index, files: lane.length, deadlineMs: Math.floor(deadline) })}`,
      );
      const result = await runChild(argv, {
        ...streams,
        timeoutMs: deadline,
        captureLoggingStages:
          index === 1 && lane.includes('packages/daemon/tests/cli/log-file.test.ts'),
        env: { ...process.env, HOME: home, CI_TEST_OWNER_TOKEN: token },
        cwd: root,
      });
      requireValue(result.cleanupVerified, 'Owned process cleanup is unproved');
      requireValue(
        JSON.stringify([...result.testFiles].sort(compare)) ===
          JSON.stringify([...lane].sort(compare)),
        'Actual file headers differ from partition',
      );
      validateOwnership(
        result.ownerLines,
        index === 0 ? 1 : 0,
        result.pid,
        token,
        pathToFileURL(path.join(root, TARGET)).href,
      );
      const actual = parseCases(readFileSync(reportFile, 'utf8'), lane);
      let contractFailure: string | null = null;
      if (index === 0) {
        try {
          validateTargetContract(contract, root, actual);
        } catch (error) {
          contractFailure = error instanceof Error ? error.message : String(error);
        }
      }
      evidence.set(index, {
        lane: name,
        contractFailure,
        cleanupVerified: result.cleanupVerified,
        exit: result.exitCode,
        files: result.testFiles,
        ...actual,
      });
      json(path.join(laneOutput, 'actual.json'), evidence.get(index));
      failed ||=
        contractFailure !== null ||
        result.exitCode !== 0 ||
        actual.cases.some((row) => row.status === 'fail');
      reports.set(
        index,
        parseLineCoverage(readFileSync(path.join(laneOutput, 'lcov.info'), 'utf8'), root, before),
      );
      // runChild proves the whole owned process group was reaped before this
      // deletion. On an unproved/throwing exit, retain worker.json and its home.
      rmSync(home, { recursive: true });
    }
    // Local complete runs are sequential: HOME does not isolate TCP ports.
    // CI runs one exact worker per fresh GitHub-hosted VM, then aggregates all.
    for (const [index, lane] of lanes.entries())
      if (workerIndex === undefined || workerIndex === index) await runLane(index, lane);
    requireValue(
      JSON.stringify(discoverTests(root)) === JSON.stringify(files) &&
        JSON.stringify(snapshotSources(root, files)) === JSON.stringify(before),
      'Source/discovery changed during execution',
    );
    requireValue(!failed, 'One or more test lanes failed');
    if (workerIndex !== undefined) {
      requireValue(evidence.size === 1 && reports.size === 1, 'Incomplete worker evidence');
      json(path.join(output, 'worker-success.json'), {
        workerIndex,
        runtime: Bun.revision,
        elapsedMs: performance.now() - started,
      });
      return; // A worker alone MUST NOT publish a threshold summary.
    }
    requireValue(
      evidence.size === lanes.length && reports.size === lanes.length,
      'Incomplete worker evidence',
    );
    const merged = unionLineCoverage(
      [...reports].sort(([a], [b]) => a - b).map(([, value]) => value),
    );
    json(path.join(output, 'line-union.json'), merged);
    writeFileSync(path.join(output, 'lcov.info'), serializeLineCoverage(merged), { flag: 'wx' });
    json(path.join(output, 'success.json'), {
      files: files.length,
      cases: orderedEvidence().flatMap((row) => row.cases),
      assertions: orderedEvidence().reduce((sum, row) => sum + row.assertions, 0),
      runtime: Bun.revision,
      elapsedMs: performance.now() - started,
      functionBranchAggregate: 'unavailable',
    });
    requireValue(
      performance.now() - started < CONTROLLER_MS,
      'Controller deadline exceeded before summary',
    );
    // Only this validated row is threshold input. Raw child output has a DIFFERENT tee file.
    const temporary = path.join(output, 'threshold-summary.txt');
    writeFileSync(temporary, lineSummary(merged), { flag: 'wx' });
    linkSync(temporary, summary);
    unlinkSync(temporary);
  } catch (error) {
    json(path.join(output, 'failure.json'), {
      error: error instanceof Error ? error.message : String(error),
      evidence: orderedEvidence(),
      elapsedMs: performance.now() - started,
      unvalidated: lanes.filter((_, index) => !evidence.has(index)),
      thresholdRowWritten: existsSync(summary),
    });
    throw error;
  }
}

/** Accept only the complete same-source population of validated worker reports. */
export function aggregateWorkers(
  root: string,
  input: string,
  output: string,
  summary: string,
  requireIsolatedMachines = false,
): void {
  requireValue(!existsSync(output) && !existsSync(summary), 'Refusing existing aggregate evidence');
  const { files, lanes, before, contract } = prepareSuite(root);
  const names = lanes.map((_, index) => `worker-${index}`);
  requireValue(
    JSON.stringify(readdirSync(input).sort(compare)) === JSON.stringify(names),
    'Missing or unexpected test worker',
  );
  const reports: LineCoverage[] = [];
  const cases: CaseRecord[] = [];
  let assertions = 0;
  const machineBootIds = new Set<string>();
  for (const [index, lane] of lanes.entries()) {
    const directory = path.join(input, names[index] as string);
    const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
    if (requireIsolatedMachines) {
      requireValue(
        typeof manifest.machineBootId === 'string' &&
          /^[0-9a-f-]{36}$/.test(manifest.machineBootId) &&
          !machineBootIds.has(manifest.machineBootId),
        'Workers must run on distinct machines',
      );
      machineBootIds.add(manifest.machineBootId);
    }
    requireValue(
      manifest.workerIndex === index &&
        manifest.runtime === Bun.revision &&
        JSON.stringify(manifest.files) === JSON.stringify(files) &&
        JSON.stringify(manifest.lanes) === JSON.stringify(lanes) &&
        JSON.stringify(manifest.before) === JSON.stringify(before),
      'Worker source/discovery/runtime mismatch',
    );
    const success = JSON.parse(readFileSync(path.join(directory, 'worker-success.json'), 'utf8'));
    requireValue(
      success.workerIndex === index &&
        success.runtime === Bun.revision &&
        Number.isFinite(success.elapsedMs) &&
        success.elapsedMs >= 0 &&
        success.elapsedMs < CONTROLLER_MS,
      'Unvalidated test worker',
    );
    const name = index === 0 ? 'target' : `rest-${index}`;
    const laneDirectory = path.join(directory, name);
    const actual = JSON.parse(readFileSync(path.join(laneDirectory, 'actual.json'), 'utf8'));
    const parsed = parseCases(readFileSync(path.join(laneDirectory, 'junit.xml'), 'utf8'), lane);
    requireValue(
      actual.exit === 0 &&
        actual.cleanupVerified === true &&
        actual.contractFailure === null &&
        actual.lane === name &&
        Array.isArray(actual.files) &&
        JSON.stringify([...actual.files].sort(compare)) ===
          JSON.stringify([...lane].sort(compare)) &&
        JSON.stringify(actual.cases) === JSON.stringify(parsed.cases) &&
        actual.assertions === parsed.assertions &&
        parsed.cases.every((row) => row.status !== 'fail'),
      'Invalid worker case evidence',
    );
    if (index === 0) validateTargetContract(contract, root, parsed);
    reports.push(
      parseLineCoverage(readFileSync(path.join(laneDirectory, 'lcov.info'), 'utf8'), root, before),
    );
    cases.push(...parsed.cases);
    assertions += parsed.assertions;
  }
  requireValue(
    JSON.stringify(snapshotSources(root, files)) === JSON.stringify(before) &&
      JSON.stringify(discoverTests(root)) === JSON.stringify(files),
    'Aggregate source/discovery changed',
  );
  const merged = unionLineCoverage(reports);
  mkdirSync(output, { recursive: false });
  json(path.join(output, 'line-union.json'), merged);
  writeFileSync(path.join(output, 'lcov.info'), serializeLineCoverage(merged), { flag: 'wx' });
  json(path.join(output, 'success.json'), {
    files: files.length,
    cases,
    assertions,
    runtime: Bun.revision,
    workers: names.length,
  });
  const temporary = path.join(output, 'threshold-summary.txt');
  writeFileSync(temporary, lineSummary(merged), { flag: 'wx' });
  linkSync(temporary, summary);
  unlinkSync(temporary);
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    requireValue(
      args.length <= 1 &&
        (args.length === 0 || /^--worker=[0-2]$/.test(args[0] ?? '') || args[0] === '--aggregate'),
      'Unsupported test controller command',
    );
    if (args[0] === '--aggregate')
      aggregateWorkers(
        realpathSync(process.cwd()),
        path.resolve('coverage/test-workers'),
        path.resolve('coverage/test-aggregate'),
        path.resolve('test-output.txt'),
        true,
      );
    else
      await runSuite(
        realpathSync(process.cwd()),
        path.resolve('coverage/test-lanes'),
        path.resolve('test-output.txt'),
        {},
        args[0] === undefined ? undefined : Number(args[0].slice('--worker='.length)),
      );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
