import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '../../..');
const workflowPath = join(repoRoot, '.github/workflows/ci.yml');
const stepHeader = '      - name: Check coverage threshold\n        run: |\n';
const tempRoot = mkdtempSync(join(tmpdir(), 'remi-ci-coverage-threshold-'));

function coverageScript(): string {
  const workflow = readFileSync(workflowPath, 'utf8');
  const start = workflow.indexOf(stepHeader);
  expect(start).not.toBe(-1);

  const blockStart = start + stepHeader.length;
  const lines = workflow.slice(blockStart).split('\n');
  const scriptLines: string[] = [];
  for (const line of lines) {
    if (line.length > 0 && !line.startsWith('          ')) break;
    scriptLines.push(line.length > 0 ? line.slice(10) : '');
  }

  const workflowCommand = 'bun test --coverage 2>&1';
  expect(scriptLines.join('\n').split(workflowCommand)).toHaveLength(2);
  return scriptLines.join('\n').replace(workflowCommand, 'cat "$COVERAGE_FIXTURE"');
}

async function runThreshold(name: string, fixture: string | Buffer) {
  const fixturePath = join(tempRoot, `${name}.txt`);
  const scriptPath = join(tempRoot, `${name}.sh`);
  writeFileSync(fixturePath, fixture);
  writeFileSync(scriptPath, coverageScript());

  const child = Bun.spawn(['bash', '--noprofile', '--norc', '-e', scriptPath], {
    env: { ...process.env, COVERAGE_FIXTURE: fixturePath },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, output: `${stdout}${stderr}` };
}

beforeAll(() => {
  // The pipeline relies on the same standard shell tools used by the workflow.
  expect(Bun.which('bash')).toBeTruthy();
  expect(Bun.which('grep')).toBeTruthy();
  expect(Bun.which('sed')).toBeTruthy();
  expect(Bun.which('awk')).toBeTruthy();
  expect(Bun.which('bc')).toBeTruthy();
});

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('CI coverage threshold shell pipeline', () => {
  test('parses a valid coverage summary row after NUL and invalid UTF-8 diagnostics', async () => {
    const result = await runThreshold(
      'binary-diagnostic',
      Buffer.concat([
        Buffer.from([0x64, 0x69, 0x61, 0x67, 0x00, 0xff, 0x62, 0x79, 0x74, 0x65, 0x73, 0x0a]),
        Buffer.from('All files | 89.47 | 91.91 |\n'),
      ]),
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Line coverage: 91.91%');
  });

  test('strips ANSI color from the coverage summary row', async () => {
    const result = await runThreshold(
      'ansi-row',
      '\u001b[1mAll files\u001b[0m | 89.47 | \u001b[1m91.91\u001b[0m |\n',
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Line coverage: 91.91%');
  });

  test('refuses a missing coverage row', async () => {
    const result = await runThreshold('missing-row', 'No coverage summary\n');

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('Could not parse line coverage');
  });

  test('refuses a malformed line-coverage metric', async () => {
    const result = await runThreshold('malformed-metric', 'All files | 89.47 | nope |\n');

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('Could not parse line coverage');
  });

  test('refuses line coverage below 60 percent', async () => {
    const result = await runThreshold('below-threshold', 'All files | 70.00 | 59.99 |\n');

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('Coverage 59.99% is below 60% threshold');
  });
});
