import { afterAll, expect, test } from 'bun:test';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  TARGET,
  caseMultiset,
  discoverTests,
  parseCases,
  partitionTests,
  prepareSuite,
  runSuite,
  snapshotSources,
  validateOwnership,
  validateTargetContract,
} from '../../../../scripts/ci/run-bun-test-batches';
import { runChild } from '../../../../scripts/ci/run-bun-test-with-diagnostics';
const root = path.resolve(import.meta.dir, '../../../..');
const homes: string[] = [];
function fixture(): string {
  const home = mkdtempSync(path.join(tmpdir(), 'remi-ci-discovery-'));
  homes.push(home);
  copyFileSync(path.join(root, 'bunfig.toml'), path.join(home, 'bunfig.toml'));
  for (const file of [
    'packages/daemon/tests/debug/test-harness-marker.ts',
    'packages/daemon/tests/unset-remi-home.ts',
  ]) {
    mkdirSync(path.dirname(path.join(home, file)), { recursive: true });
    copyFileSync(path.join(root, file), path.join(home, file));
  }
  return home;
}
function source(home: string, file: string, text: string): void {
  mkdirSync(path.dirname(path.join(home, file)), { recursive: true });
  writeFileSync(path.join(home, file), text);
}
function output() {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') };
}
async function actual(home: string, files: string[]) {
  const out = output();
  const err = output();
  const report = path.join(home, `report-${crypto.randomUUID()}.xml`);
  const result = await runChild(
    [
      process.execPath,
      '--no-env-file',
      '--no-install',
      'test',
      ...files.map((file) => `./${file}`),
      '--reporter=junit',
      `--reporter-outfile=${report}`,
    ],
    {
      cwd: home,
      stdout: out.stream,
      stderr: err.stream,
      timeoutMs: 10_000,
      env: { ...process.env, CI_TEST_OWNER_TOKEN: 'owned-control' },
    },
  );
  return {
    ...result,
    raw: out.text() + err.text(),
    junit: readFileSync(report, 'utf8'),
    parsed: parseCases(
      readFileSync(report, 'utf8'),
      files.includes('.') ? discoverTests(home) : files,
    ),
  };
}
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

test('discovery equals actual Bun headers across suffixes/extensions, hidden files and excluded directories', async () => {
  const home = fixture();
  for (const suffix of ['.test', '_test', '.spec', '_spec'])
    for (const ext of ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts']) {
      const file = `nested/case${suffix}.${ext}`;
      source(
        home,
        file,
        `import {test,expect} from 'bun:test';test(${JSON.stringify(file)},()=>expect(1).toBe(1));\n`,
      );
    }
  source(
    home,
    '.hidden.test.ts',
    "import {test,expect} from 'bun:test';test('hidden-file',()=>expect(1).toBe(1));\n",
  );
  for (const file of ['.hidden/no.test.ts', 'node_modules/no.test.ts', 'nested/.hidden/no.test.ts'])
    source(home, file, "throw Error('excluded test ran');\n");
  source(home, 'ordinary.ts', "throw Error('non-test ran');\n");
  const expected = discoverTests(home);
  const run = await actual(home, ['.']);
  expect(run.exitCode).toBe(0);
  expect([...run.testFiles].sort()).toEqual([...expected].sort());
  // File attribution is actually supplied by Bun, never inferred from bare titles.
  expect(run.parsed.cases).toHaveLength(expected.length);
  expect(run.parsed.assertions).toBe(expected.length);
});

test('partition includes target once and every other file exactly once', () => {
  expect(partitionTests(['other.test.ts', TARGET])).toEqual([[TARGET], ['other.test.ts']]);
  for (const files of [[], [TARGET], [TARGET, TARGET], ['other.test.ts']])
    expect(() => partitionTests(files)).toThrow();
});

test('actual Bun reporter C0 titles retain reported bytes and separate hook assertion accounting', async () => {
  const home = fixture();
  const file = 'reporter.test.ts';
  source(
    home,
    file,
    `import {beforeAll,afterAll,expect,test} from 'bun:test';
import {writeSync} from 'node:fs';
const note=(stage:string)=>writeSync(2,'[ci-reporter-hook] '+stage+'\\n');
beforeAll(()=>{note('beforeAll');expect(1).toBe(1)});
afterAll(()=>{note('afterAll');expect(1).toBe(1)});
test(${JSON.stringify('C0 \0\x07\x1b end')},()=>{note('body');expect(1).toBe(1)});\n`,
  );
  const run = await actual(home, [file]);
  expect(run.exitCode).toBe(0);
  expect(run.cleanupVerified).toBe(true);
  expect(run.parsed.cases).toHaveLength(1);
  expect(run.parsed.assertions).toBe(1);
  const witnesses = [...run.raw.matchAll(/^\[ci-reporter-hook\] (\w+)$/gm)].map(
    (match) => match[1],
  );
  expect(witnesses).toEqual(['beforeAll', 'body', 'afterAll']);
  const rawExpectCalls = run.raw.match(/^\s*(\d+) expect\(\) calls$/m)?.[1];
  console.log(
    `[ci-reporter-regression] ${JSON.stringify({
      runtime: Bun.revision,
      rawExpectCalls: rawExpectCalls === undefined ? null : Number(rawExpectCalls),
      caseAssertions: run.parsed.assertions,
      witnesses,
    })}`,
  );
  const reported = run.junit.match(/<testcase name="([^"]*)"/)?.[1];
  expect(reported).toBeDefined();
  if (reported === undefined) throw new Error('Missing actual reporter title');
  const decoded = reported
    .replaceAll('&#0;', '\0')
    .replaceAll('&#7;', '\x07')
    .replaceAll('&#27;', '\x1b');
  expect(run.parsed.cases[0]?.name).toBe(decoded);
  if (Bun.revision === 'af24e281ebacd6ac77c0f14b4206599cf4ae1c9f') {
    expect(reported).toContain('&#0;');
    for (const byte of ['\0', '\x07', '\x1b']) expect(decoded).toContain(byte);
  }
  for (const entity of [
    '&#-1;',
    '&#1114112;',
    '&#55296;',
    '&#xDFFF;',
    '&#xGG;',
    '&unknown;',
    '&#0',
  ]) {
    expect(() =>
      parseCases(run.junit.replace(`name="${reported}"`, `name="${entity}"`), [file]),
    ).toThrow();
  }
});

test('unknown configuration and source links cannot silently shrink discovery', () => {
  const home = fixture();
  source(home, 'known.test.ts', '');
  symlinkSync('/private/tmp', path.join(home, 'outside'));
  expect(() => discoverTests(home)).toThrow('symlink');
  rmSync(path.join(home, 'outside'));
  writeFileSync(path.join(home, 'bunfig.toml'), '[test]\npathIgnorePatterns=["**"]\n');
  expect(() => discoverTests(home)).toThrow();
});

test('actual computed target imports fail ownership despite misleading same-title JUnit attribution', async () => {
  const home = fixture();
  source(
    home,
    'target.test.ts',
    "import {writeSync} from 'node:fs';import {test,expect} from 'bun:test';writeSync(2,'\\n[ci-target-module-owner] '+JSON.stringify({pid:process.pid,url:import.meta.url,token:process.env.CI_TEST_OWNER_TOKEN??null})+'\\n');test('same-title',()=>expect(1).toBe(1));\n",
  );
  source(
    home,
    'rest.test.ts',
    "import {test,expect} from 'bun:test';process.stderr.write=()=>true;const fs=await import('node:fs');fs.writeSync(2,'partial-line');await import('./'+['target','test','ts'].join('.'));test('same-title',()=>expect(2).toBe(2));\n",
  );
  const isolated = await actual(home, ['target.test.ts']);
  validateOwnership(
    isolated.ownerLines,
    1,
    isolated.pid,
    'owned-control',
    new URL(`file://${home}/target.test.ts`).href,
  );
  const rest = await actual(home, ['rest.test.ts']);
  expect(rest.exitCode).toBe(0);
  expect(rest.ownerLines).toHaveLength(1);
  expect(() =>
    validateOwnership(
      rest.ownerLines,
      0,
      rest.pid,
      'owned-control',
      new URL(`file://${home}/target.test.ts`).href,
    ),
  ).toThrow();
  expect(rest.parsed.cases.map((row) => row.file)).toEqual(['rest.test.ts', 'rest.test.ts']);
});

test('converse imported same-title registration changes the exact MULTISET, not normalized titles', async () => {
  const home = fixture();
  const body = "import {test,expect} from 'bun:test';test('same-title',()=>expect(1).toBe(1));\n";
  source(home, 'target.test.ts', body);
  source(home, 'rest.test.ts', body);
  const baseline = await actual(home, ['target.test.ts']);
  source(home, 'target.test.ts', `import './rest.test.ts';\n${body}`);
  const converse = await actual(home, ['target.test.ts']);
  expect(caseMultiset(baseline.parsed.cases)).not.toEqual(caseMultiset(converse.parsed.cases));
  expect(converse.parsed.cases).toHaveLength(2);
  expect(converse.parsed.cases[0]).toEqual(converse.parsed.cases[1]);
});

test('the manually reviewed target/helper pins and case multiset cannot drift or regenerate', () => {
  const contract = JSON.parse(
    readFileSync(path.join(root, 'scripts/ci/remote-new-client-contract.json'), 'utf8'),
  );
  validateTargetContract(contract, root, {
    cases: contract.cases,
    assertions: contract.assertions,
  });
  expect(() =>
    validateTargetContract({ ...contract, cases: [...contract.cases, contract.cases[0]] }, root, {
      cases: contract.cases,
      assertions: contract.assertions,
    }),
  ).toThrow('multiset');
  const altered = structuredClone(contract);
  altered.sourcePins[TARGET].sha256 = '0'.repeat(64);
  expect(() =>
    validateTargetContract(altered, root, {
      cases: contract.cases,
      assertions: contract.assertions,
    }),
  ).toThrow('contract changed');
});

test('missing/duplicate/malformed/foreign ownership evidence fails closed', () => {
  const row = { pid: process.pid, token: 'owned', url: 'file:///owned/target.test.ts' };
  const line = `[ci-target-module-owner] ${JSON.stringify(row)}`;
  for (const lines of [
    [],
    [line, line],
    ['[ci-target-module-owner] nope'],
    [line.replace('owned', 'wrong')],
    [line.replace(String(process.pid), '999999')],
  ])
    expect(() => validateOwnership(lines, 1, process.pid, 'owned', row.url)).toThrow();
});

function suiteFixture(fail: boolean): string {
  const home = fixture();
  source(home, '.gitignore', 'node_modules\ncoverage/test-lanes/\ntest-output.txt\n');
  source(
    home,
    TARGET,
    "import {writeSync} from 'node:fs';import {test,expect} from 'bun:test';writeSync(2,'\\n[ci-target-module-owner] '+JSON.stringify({pid:process.pid,url:import.meta.url,token:process.env.CI_TEST_OWNER_TOKEN??null})+'\\n');test('owned target',()=>expect(1).toBe(1));\n",
  );
  source(
    home,
    'rest.test.ts',
    `import {test,expect} from 'bun:test';test('owned rest',()=>expect(${fail ? '2' : '1'}).toBe(1));\n`,
  );
  for (const file of [
    'packages/daemon/tests/integration/hub-test-utils.ts',
    'packages/daemon/tests/session/port-test-helpers.ts',
  ])
    source(home, file, 'export {};\n');
  source(
    home,
    'packages/shared/package.json',
    '{"name":"@remi/shared","exports":"./src/index.ts"}\n',
  );
  source(home, 'packages/shared/src/index.ts', 'export {};\n');
  mkdirSync(path.join(home, 'node_modules/@remi'), { recursive: true });
  symlinkSync('../../packages/shared', path.join(home, 'node_modules/@remi/shared'));
  mkdirSync(path.join(home, 'packages/daemon/src'), { recursive: true });
  mkdirSync(path.join(home, 'packages/web/tests/lib'), { recursive: true });
  const names = [
    TARGET,
    'packages/daemon/tests/integration/hub-test-utils.ts',
    'packages/daemon/tests/session/port-test-helpers.ts',
  ];
  const pins = Object.fromEntries(
    names.map((name) => {
      const bytes = readFileSync(path.join(home, name));
      return [
        name,
        { sha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex'), mode: 0o644 },
      ];
    }),
  );
  source(
    home,
    'scripts/ci/remote-new-client-contract.json',
    JSON.stringify({
      runtime: Bun.revision,
      target: TARGET,
      sourcePins: pins,
      cases: [{ file: TARGET, suite: '', name: 'owned target', status: 'pass', assertions: 1 }],
      assertions: 1,
    }),
  );
  for (const args of [
    ['init', '-q'],
    ['add', '.'],
  ]) {
    const result = Bun.spawnSync(['git', ...args], { cwd: home, stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) throw new Error('Owned Git fixture setup failed');
  }
  return home;
}

test('actual two-process controller publishes ONLY a complete validated summary, preserving manifest and source evidence', async () => {
  const home = suiteFixture(false);
  const out = output();
  const err = output();
  const directory = path.join(home, 'coverage/test-lanes');
  const summary = path.join(home, 'test-output.txt');
  await runSuite(home, directory, summary, { stdout: out.stream, stderr: err.stream });
  expect(readFileSync(summary, 'utf8')).toMatch(/^All files \| N\/A \| [0-9]+\.[0-9]{2} \|\n$/);
  const evidence = JSON.parse(readFileSync(path.join(directory, 'success.json'), 'utf8'));
  expect(evidence.files).toBe(2);
  expect(evidence.cases).toHaveLength(2);
  expect(evidence.assertions).toBe(2);
  await expect(runSuite(home, directory, summary)).rejects.toThrow();
});

test('actual failing rest assertion leaves NO threshold input and retains failure evidence', async () => {
  const home = suiteFixture(true);
  const out = output();
  const err = output();
  const directory = path.join(home, 'coverage/test-lanes');
  const summary = path.join(home, 'test-output.txt');
  await expect(
    runSuite(home, directory, summary, { stdout: out.stream, stderr: err.stream }),
  ).rejects.toThrow('lanes failed');
  expect(() => readFileSync(summary)).toThrow();
  const failure = JSON.parse(readFileSync(path.join(directory, 'failure.json'), 'utf8'));
  expect(failure.thresholdRowWritten).toBe(false);
  expect(failure.evidence).toHaveLength(2);
  expect(failure.evidence[1].exit).not.toBe(0);
  expect(failure.evidence[1].cases[0].status).toBe('fail');
});

test('new, removed and source-mode/discovery changes remain visible, not silently omitted', () => {
  const home = suiteFixture(false);
  const before = discoverTests(home);
  const snapshot = snapshotSources(home, before);
  source(home, 'new_spec.mjs', "import {test} from 'bun:test';test('new',()=>{});\n");
  expect(discoverTests(home)).not.toEqual(before);
  expect(snapshotSources(home, discoverTests(home))).not.toEqual(snapshot);
  const retained = readFileSync(path.join(home, 'rest.test.ts'));
  rmSync(path.join(home, 'rest.test.ts'));
  expect(discoverTests(home)).not.toContain('rest.test.ts');
  expect(() => snapshotSources(home, discoverTests(home))).toThrow();
  writeFileSync(path.join(home, 'rest.test.ts'), retained);
  chmodSync(path.join(home, TARGET), 0o600);
  expect(snapshotSources(home, discoverTests(home))[TARGET]?.mode).toBe(0o600);
  expect(snapshotSources(home, discoverTests(home))[TARGET]?.mode).not.toBe(snapshot[TARGET]?.mode);
});

test('the actual checkout reaches production pre-lane preparation with its tracked public env template', () => {
  const prepared = prepareSuite(root);
  expect(prepared.files).toContain(TARGET);
  expect(prepared.before['.env.example']?.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(prepared.lanes[0]).toEqual([TARGET]);
  expect(prepared.lanes[1].length + 1).toBe(prepared.files.length);
});

test('only a tracked canonical root public example is readable; real/nested/untracked env paths refuse', () => {
  const home = suiteFixture(false);
  const priorManifest = discoverTests(home);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], { cwd: home, stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) throw new Error('Owned Git env-path control failed');
  };
  git('config', 'core.excludesFile', '/dev/null');
  source(home, '.env.example', '# public example only\n');
  expect(() => snapshotSources(home, discoverTests(home))).toThrow('Secret file');
  git('add', '--', '.env.example');
  expect(snapshotSources(home, discoverTests(home))['.env.example']?.sha256).toMatch(
    /^[0-9a-f]{64}$/,
  );
  for (const name of ['.env.private', 'nested/.env.example']) {
    source(home, name, '');
    chmodSync(path.join(home, name), 0);
    expect(() => snapshotSources(home, discoverTests(home))).toThrow('Secret file');
    rmSync(path.join(home, name));
  }
  rmSync(path.join(home, '.env.example'));
  symlinkSync('/dev/null', path.join(home, '.env.example'));
  expect(() => snapshotSources(home, priorManifest)).toThrow('Nonregular');
});
