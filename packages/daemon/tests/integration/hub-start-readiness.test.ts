/**
 * #1559: `remi start` must distinguish a hub that is still initializing from
 * one whose child has already refused startup. Tests use isolated homes and
 * real OS child processes; the fixture executable controls only child timing.
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CLI_TS, pollUntil } from './hub-test-utils.ts';

type Sandbox = { root: string; home: string; work: string; bin: string; tmp: string };
type CommandResult = { exitCode: number | null; stdout: string; stderr: string };

function createSandbox(): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-hub-start-readiness-'));
  const sandbox = {
    root,
    home: path.join(root, 'home'),
    work: path.join(root, 'work'),
    bin: path.join(root, 'bin'),
    tmp: path.join(root, 'tmp'),
  };
  for (const directory of [sandbox.home, sandbox.work, sandbox.bin, sandbox.tmp]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  return sandbox;
}

function isolatedEnv(sandbox: Sandbox): Record<string, string> {
  return {
    HOME: sandbox.home,
    PATH: [sandbox.bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
    TMPDIR: sandbox.tmp,
  };
}

async function runCommand(
  command: string[],
  sandbox: Sandbox,
  env: Record<string, string> = isolatedEnv(sandbox),
): Promise<CommandResult> {
  const child = Bun.spawn(command, {
    cwd: sandbox.work,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function installControlledRemi(sandbox: Sandbox): void {
  const executable = path.join(sandbox.bin, 'remi');
  fs.writeFileSync(
    executable,
    `#!/bin/sh
case "$4" in
  --fixture-mode=live)
    printf '%s\\n' "$$" > "$HOME/.remi/fixture.pid"
    exec /bin/sleep 30
    ;;
  --fixture-mode=foreign-signal)
    printf '%s\\n' "$$" > "$HOME/.remi/fixture.pid"
    printf '%s\\n' "$5" > "$HOME/.remi/daemon.pid"
    kill -TERM "$$"
    ;;
  *)
    exit 98
    ;;
esac
`,
    { mode: 0o700 },
  );
}

async function runControlledStart(
  sandbox: Sandbox,
  extraArgs: readonly string[],
): Promise<CommandResult> {
  const managerPath = path.resolve(import.meta.dir, '../../src/cli/daemon-manager.ts');
  const runner = [
    // Exercise startDaemon's real PATH fallback; only the spawned child is controlled.
    "process.argv[0] = 'hub-start-readiness-parent';",
    "process.argv[1] = 'hub-start-readiness-parent';",
    `const { startDaemon } = await import(${JSON.stringify(managerPath)});`,
    `await startDaemon({ port: 25001, bindHost: '127.0.0.1', extraArgs: ${JSON.stringify(extraArgs)} });`,
  ].join('\n');
  return runCommand([process.execPath, '-e', runner], sandbox);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopControlledChild(sandbox: Sandbox): Promise<void> {
  const fixturePidPath = path.join(sandbox.home, '.remi', 'fixture.pid');
  if (!fs.existsSync(fixturePidPath)) return;
  const pid = Number(fs.readFileSync(fixturePidPath, 'utf8').trim());
  if (!Number.isSafeInteger(pid) || pid < 1 || !isAlive(pid)) return;
  process.kill(pid, 'SIGTERM');
  try {
    await pollUntil(() => !isAlive(pid), 2_000, 'controlled start child to exit');
  } catch {
    // This is the test-owned fixture process, never a hub or session daemon.
    if (isAlive(pid)) process.kill(pid, 'SIGKILL');
  }
}

describe('remi start child readiness (#1559)', () => {
  test('returns failure when the real source child refuses the retired relay URL', async () => {
    const sandbox = createSandbox();
    try {
      fs.mkdirSync(path.join(sandbox.home, '.remi'), { recursive: true });
      fs.writeFileSync(
        path.join(sandbox.home, '.remi', 'config.toml'),
        '[network]\nrelay = true\nsignaling_url = "wss://remi-signaling.yooz.workers.dev/connect"\n',
      );

      const result = await runCommand([process.execPath, CLI_TS, 'start'], sandbox);
      const remiDir = path.join(sandbox.home, '.remi');
      const logFile = path.join(remiDir, 'daemon.log');

      expect(result.exitCode).toBe(1);
      expect(`${result.stdout}${result.stderr}`).not.toContain('Hub started');
      expect(result.stderr).toContain('Hub process exited unexpectedly');
      expect(result.stderr).toContain(logFile);
      expect(fs.readFileSync(logFile, 'utf8')).toContain(
        'The official /connect relay endpoint is retired.',
      );
      expect(fs.existsSync(path.join(remiDir, 'daemon.pid'))).toBe(false);
      expect(fs.existsSync(path.join(remiDir, 'daemon-status.json'))).toBe(false);
    } finally {
      fs.rmSync(sandbox.root, { recursive: true, force: true });
    }
  }, 10_000);

  test('leaves a live child without readiness running and reports initialization after 5s', async () => {
    const sandbox = createSandbox();
    installControlledRemi(sandbox);
    try {
      const result = await runControlledStart(sandbox, ['--fixture-mode=live']);
      const match = /Hub started \(PID (\d+)\) but did not report its port within 5s\./.exec(
        result.stdout,
      );
      const pid = Number(match?.[1]);

      expect(result.exitCode).toBe(0);
      expect(match).not.toBeNull();
      expect(result.stdout).toContain(
        'The hub may still be initializing. Check status with: remi status',
      );
      expect(result.stderr).not.toContain('Hub process exited unexpectedly');
      expect(pid).toBeGreaterThan(0);
      expect(fs.readFileSync(path.join(sandbox.home, '.remi', 'fixture.pid'), 'utf8').trim()).toBe(
        String(pid),
      );
      expect(isAlive(pid)).toBe(true);
      expect(fs.existsSync(path.join(sandbox.home, '.remi', 'daemon-status.json'))).toBe(false);
    } finally {
      await stopControlledChild(sandbox);
      fs.rmSync(sandbox.root, { recursive: true, force: true });
    }
  }, 10_000);

  test('fails on a signal exit and preserves a concurrently written foreign PID file', async () => {
    const sandbox = createSandbox();
    installControlledRemi(sandbox);
    try {
      const foreignPid = process.pid;
      const result = await runControlledStart(sandbox, [
        '--fixture-mode=foreign-signal',
        String(foreignPid),
      ]);
      const remiDir = path.join(sandbox.home, '.remi');
      const logFile = path.join(remiDir, 'daemon.log');

      expect(result.exitCode).toBe(1);
      expect(result.stdout).not.toContain('Hub started');
      expect(result.stderr).toContain('Hub process exited unexpectedly');
      expect(result.stderr).toContain(logFile);
      expect(fs.readFileSync(path.join(remiDir, 'fixture.pid'), 'utf8').trim()).not.toBe(
        String(foreignPid),
      );
      expect(fs.readFileSync(path.join(remiDir, 'daemon.pid'), 'utf8').trim()).toBe(
        String(foreignPid),
      );
      expect(isAlive(foreignPid)).toBe(true);
    } finally {
      await stopControlledChild(sandbox);
      fs.rmSync(sandbox.root, { recursive: true, force: true });
    }
  }, 10_000);
});
