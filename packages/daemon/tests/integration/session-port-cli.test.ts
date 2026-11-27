/** Real CLI and TCP listeners; a test-only barrier makes the bind race deterministic. */
import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_CONFIG } from '../../src/config/config.ts';
import { SessionRegistryFile } from '../../src/session/session-registry-file.ts';
import { collect, installFakeAgents } from '../helpers/fake-agent-clis.ts';
import { occupyPort, reserveRange } from '../session/port-test-helpers.ts';
import { CLI_TS, isolatedEnv, makeIsolatedDirs, pollUntil } from './hub-test-utils.ts';

// Preserve the actual implementations and call sites, inserting only observation and a
// handshake before the selected operation. The listener belongs to the parent test.
function instrumentCli(): string {
  const source = fs.readFileSync(CLI_TS, 'utf8');
  const probes =
    "import { probeDaemonSessionPort, probeWrapperSessionPort } from './cli/session-port-probes.ts';";
  const starter = "import { startSessionPort } from './cli/session-port-start.ts';";
  if (!source.includes(probes) || !source.includes(starter)) throw new Error('CLI imports changed');
  const instrumented = source
    .replace(
      probes,
      "import { probeDaemonSessionPort as realDaemonProbe, probeWrapperSessionPort as realWrapperProbe } from './cli/session-port-probes.ts';",
    )
    .replace(
      starter,
      "import { startSessionPort as realStartSessionPort } from './cli/session-port-start.ts';",
    );
  return `${instrumented}
async function barrier(kind: string, base: number) {
  const dir = process.env['REMI_TEST_BARRIER']!;
  require('node:fs').appendFileSync(dir + '/calls', JSON.stringify({ kind, base }) + '\\n');
  if (kind !== process.env['REMI_TEST_PAUSE']) return;
  require('node:fs').writeFileSync(dir + '/ready', '');
  const until = Date.now() + 10000;
  while (!require('node:fs').existsSync(dir + '/go')) {
    if (Date.now() > until) throw new Error('test barrier timed out');
    await Bun.sleep(20);
  }
}
async function probeDaemonSessionPort(...args: Parameters<typeof realDaemonProbe>) {
  await barrier('probe', args[4]);
  return realDaemonProbe(...args);
}
async function probeWrapperSessionPort(...args: Parameters<typeof realWrapperProbe>) {
  await barrier('probe', args[4]);
  return realWrapperProbe(...args);
}
async function startSessionPort(...args: Parameters<typeof realStartSessionPort>) {
  await barrier('start', args[2]);
  return realStartSessionPort(...args);
}
`;
}

test('CLI session probes and bind retries use the configured reservation', async () => {
  for (const daemon of [false, true]) {
    for (const pause of ['probe', 'start']) {
      const { home, work } = makeIsolatedDirs();
      const agents = installFakeAgents(home, { claude: true });
      const base = await reserveRange(22, 50, DEFAULT_CONFIG.daemon.bind);
      const remi = path.join(home, '.remi');
      const cli = path.join(path.dirname(CLI_TS), `cli-test-${crypto.randomUUID()}.ts`);
      fs.mkdirSync(remi);
      fs.writeFileSync(
        path.join(remi, 'config.toml'),
        `[daemon]\nbase_port = ${base}\nhub_auto_start = false\n[network]\nmdns = false\n`,
      );
      fs.writeFileSync(cli, instrumentCli());
      const env = isolatedEnv(home, {
        ...agents.env,
        REMI_TEST_BARRIER: home,
        REMI_TEST_PAUSE: pause,
      });
      const proc = Bun.spawn(
        [process.execPath, cli, ...(daemon ? ['--daemon'] : []), '--no-mdns', '--no-auth'],
        { cwd: work, env, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', timeout: 25_000 },
      );
      const stdout = { text: '' };
      const stderr = { text: '' };
      collect(proc.stdout, stdout);
      collect(proc.stderr, stderr);
      let listener: Awaited<ReturnType<typeof occupyPort>> | undefined;
      try {
        await pollUntil(
          () => {
            if (proc.exitCode !== null)
              throw new Error(`CLI exited: ${stdout.text} ${stderr.text}`);
            return fs.existsSync(path.join(home, 'ready'));
          },
          12_000,
          `${daemon ? 'daemon' : 'wrapper'} ${pause} barrier`,
        );
        listener = await occupyPort(base + 1, DEFAULT_CONFIG.daemon.bind);
        fs.writeFileSync(path.join(home, 'go'), '');
        await pollUntil(
          () => {
            if (proc.exitCode !== null)
              throw new Error(`CLI exited: ${stdout.text} ${stderr.text}`);
            return fs.existsSync(path.join(agents.claudeDir, 'argv'));
          },
          12_000,
          'session agent',
        );
        const calls = fs
          .readFileSync(path.join(home, 'calls'), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { kind: string; base: number });
        expect(calls).toEqual([
          { kind: 'probe', base },
          { kind: 'start', base },
        ]);
        const entries = new SessionRegistryFile(path.join(remi, 'live-sessions')).listLive();
        expect(entries.map((entry) => entry.wsPort)).toEqual([base + 2]);
        expect(entries[0]?.wsPort).not.toBe(base);
      } finally {
        if (listener) await new Promise<void>((resolve) => listener?.close(() => resolve()));
        fs.writeFileSync(path.join(agents.claudeDir, 'release'), '');
        if (proc.exitCode === null) proc.kill('SIGTERM');
        await Promise.race([proc.exited, Bun.sleep(2000)]);
        if (proc.exitCode === null) {
          proc.kill('SIGKILL');
          await proc.exited;
        }
        fs.rmSync(cli, { force: true });
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(work, { recursive: true, force: true });
      }
    }
  }
}, 100_000);
