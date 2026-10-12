/** Real Remi subprocess early dispatch only; no Claude/Codex invocation or LLM acceptance. */
import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const cli = path.resolve(import.meta.dir, '../../src/cli.ts');
const cases = [
  { args: ['--resume', 'missing'], code: 2, text: "--resume is remi's flag for Claude" },
  {
    args: ['claude', '--host', '127.0.0.1', '--resume', 'missing'],
    code: 2,
    text: 'put it after --',
  },
  {
    args: ['--host', '127.0.0.1', '--resume', 'missing'],
    code: 2,
    text: 'for Codex put the resume after --',
  },
  { args: ['claude', '--harness', 'codex'], code: 1, text: 'conflicts with the claude subcommand' },
  { args: ['codex', '--harness', 'claude'], code: 1, text: 'conflicts with the codex subcommand' },
  { args: ['claude', '--host', '127.0.0.1', 'loose'], code: 2, text: 'not sent: loose' },
  { args: ['serve', '--harness', 'codex'], code: 2, text: 'The hub hosts no session of its own' },
  { args: ['claude', '--help'], code: 0, text: 'overriding [harness] default' },
  { args: ['config'], code: 0, text: 'default = "codex"' },
] as const;

async function run(args: readonly string[], config: string) {
  const home = fs.mkdtempSync(path.join(tmpdir(), 'remi-default-harness-'));
  try {
    fs.writeFileSync(path.join(home, 'config.toml'), config, { mode: 0o600 });
    const child = Bun.spawn([process.execPath, '--no-env-file', cli, ...args], {
      cwd: home,
      env: { ...process.env, REMI_HOME: home },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, text: stdout + stderr };
    } finally {
      clearTimeout(timer);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

for (const scenario of cases) {
  test(`real CLI configured Codex early dispatch: ${scenario.args.join(' ')}`, async () => {
    const result = await run(scenario.args, '[harness]\ndefault = "codex"\n');
    expect(result.code).toBe(scenario.code);
    expect(result.text).toContain(scenario.text);
  });
}

test('real CLI refuses invalid config before any session launch', async () => {
  const result = await run([], '[harness]\ndefault = "opencode"\n');
  expect(result.code).toBe(1);
  expect(result.text).toContain('Invalid harness.default');
});

test('explicit Claude directory dispatch still runs before a harness launch', async () => {
  const owned = fs.mkdtempSync(path.join(tmpdir(), 'remi-default-harness-dir-'));
  try {
    const missing = path.join(owned, 'absent');
    const result = await run(['claude', '--dir', missing], '[harness]\ndefault = "codex"\n');
    expect(result.code).toBe(1);
    expect(result.text).toContain(missing);
    expect(result.text).not.toContain('Codex');
  } finally {
    fs.rmSync(owned, { recursive: true, force: true });
  }
});

test('real CLI management status ignores configured Codex', async () => {
  const result = await run(['status'], '[harness]\ndefault = "codex"\n');
  expect([0, 1]).toContain(result.code);
  expect(result.text).not.toContain('Codex');
  expect(result.text).not.toContain('takes no --harness');
});
