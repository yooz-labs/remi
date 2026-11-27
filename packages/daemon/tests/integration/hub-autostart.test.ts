/** Real CLI processes and isolated homes; no test contacts the default hub port. */
import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DEFAULT_CONFIG,
  formatConfig,
  generateDefaultConfig,
  parseConfigText,
} from '../../src/config/config.ts';
import { SessionRegistryFile } from '../../src/session/session-registry-file.ts';
import { collect, installFakeAgents } from '../helpers/fake-agent-clis.ts';
import { reserveRange } from '../session/port-test-helpers.ts';
import { CLI_TS, isolatedEnv, makeIsolatedDirs, pollUntil } from './hub-test-utils.ts';

const processes: Bun.Subprocess[] = [];
const homes: string[] = [];
const works: string[] = [];
const agentDirectories: string[] = [];

afterEach(async () => {
  for (const dir of agentDirectories.splice(0)) fs.writeFileSync(path.join(dir, 'release'), '');
  for (const proc of processes.splice(0)) {
    if (proc.exitCode === null) proc.kill('SIGTERM');
    await Promise.race([proc.exited, Bun.sleep(2000)]);
    if (proc.exitCode === null) proc.kill('SIGKILL');
  }
  for (const home of homes.splice(0)) {
    const pidFile = path.join(home, '.remi', 'daemon.pid');
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 1) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          /* already exited */
        }
      }
    }
    const status = path.join(home, '.remi', 'daemon-status.json');
    if (fs.existsSync(status)) {
      const hub = JSON.parse(fs.readFileSync(status, 'utf8')) as { pid: number; mode: string };
      if (hub.mode === 'hub' && hub.pid > 1) {
        try {
          process.kill(hub.pid, 'SIGTERM');
        } catch {
          /* already exited */
        }
      }
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
  for (const work of works.splice(0)) fs.rmSync(work, { recursive: true, force: true });
});

async function setup(extra = '') {
  const dirs = makeIsolatedDirs();
  homes.push(dirs.home);
  works.push(dirs.work);
  const agents = installFakeAgents(dirs.home, { claude: true });
  agentDirectories.push(agents.claudeDir);
  const port = await reserveRange(20, 50, DEFAULT_CONFIG.daemon.bind);
  fs.mkdirSync(path.join(dirs.home, '.remi'));
  fs.writeFileSync(
    path.join(dirs.home, '.remi', 'config.toml'),
    `[daemon]\nbase_port = ${port}\n${extra === 'default' ? '' : `hub_auto_start = ${extra === 'off' ? 'false' : 'true'}\n`}[network]\nmdns = false\n${extra === 'fail' ? 'relay = true\nsignaling_url = "wss://remi-signaling.yooz.workers.dev/connect"\n' : ''}`,
  );
  const env = isolatedEnv(dirs.home, {
    ...agents.env,
    REMI_HUB_AUTOSTART: '1',
    REMI_PUSH_SECRET: 'test-secret',
  });
  return { ...dirs, agents, port, env };
}

function launch(f: Awaited<ReturnType<typeof setup>>, args: string[] = []) {
  const proc = Bun.spawn([process.execPath, CLI_TS, ...args], {
    cwd: f.work,
    env: f.env,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    timeout: 25_000,
  });
  processes.push(proc);
  const stdout = { text: '' };
  const stderr = { text: '' };
  collect(proc.stdout, stdout);
  collect(proc.stderr, stderr);
  const output = {
    get text() {
      return stdout.text + stderr.text;
    },
  };
  return { proc, output, stdout, stderr };
}

test('config defaults on and rejects non-boolean', () => {
  expect(DEFAULT_CONFIG.daemon.hub_auto_start).toBe(true);
  expect(generateDefaultConfig()).toContain('hub_auto_start = true');
  expect(formatConfig(DEFAULT_CONFIG)).toContain('hub_auto_start = true');
  expect(parseConfigText('[daemon]\nhub_auto_start = false').config.daemon.hub_auto_start).toBe(
    false,
  );
  expect(() => parseConfigText('[daemon]\nhub_auto_start = "false"')).toThrow(
    'daemon.hub_auto_start',
  );
});

test('local session starts one detached hub before its agent', async () => {
  const f = await setup();
  const run = launch(f);
  await pollUntil(() => fs.existsSync(path.join(f.agents.claudeDir, 'argv')), 20_000, 'agent');
  const status = JSON.parse(
    fs.readFileSync(path.join(f.home, '.remi', 'daemon-status.json'), 'utf8'),
  ) as { wsPort: number };
  expect(status.wsPort).toBe(f.port);
  expect(run.output.text).toContain(`Started the remi hub on port ${f.port}.`);
  expect(run.stderr.text).toContain(`Started the remi hub on port ${f.port}.`);
  expect(run.stdout.text).not.toContain('Started the remi hub');
  const entries = fs.readdirSync(path.join(f.home, '.remi', 'live-sessions'));
  expect(entries.length).toBeGreaterThan(0);
  const entry = entries[0];
  if (!entry) throw new Error('missing session registration');
  const session = JSON.parse(
    fs.readFileSync(path.join(f.home, '.remi', 'live-sessions', entry), 'utf8'),
  ) as { wsPort: number };
  expect(session.wsPort).not.toBe(f.port);
  expect(session.wsPort).not.toBe(status.wsPort);
}, 25_000);

test('a session launched inside a child starts a hub with hub status', async () => {
  const f = await setup();
  f.env['REMI_SPAWNED_CHILD'] = '1';
  launch(f);
  await pollUntil(
    () => fs.existsSync(path.join(f.home, '.remi', 'daemon-status.json')),
    15_000,
    'hub status from nested session',
  );
  const status = JSON.parse(
    fs.readFileSync(path.join(f.home, '.remi', 'daemon-status.json'), 'utf8'),
  );
  expect(status.mode).toBe('hub');
  expect(status.wsPort).toBe(f.port);
}, 20_000);

test('a missing hub_auto_start setting starts the hub by default', async () => {
  const f = await setup('default');
  const run = launch(f);
  await pollUntil(
    () => run.stderr.text.includes(`Started the remi hub on port ${f.port}.`),
    15_000,
    'default hub startup',
  );
  expect(fs.existsSync(path.join(f.home, '.remi', 'daemon-status.json'))).toBe(true);
}, 20_000);

test('disabled and failed startup warn and still launch', async () => {
  for (const mode of ['off', 'fail']) {
    const f = await setup(mode);
    const run = launch(f);
    await pollUntil(() => fs.existsSync(path.join(f.agents.claudeDir, 'argv')), 20_000, 'agent');
    expect(run.output.text).toContain(
      "No remi hub is running, so your phone may not see this session's questions or get its notifications. Start the hub with: remi start",
    );
    expect(fs.existsSync(path.join(f.home, '.remi', 'daemon-status.json'))).toBe(false);
  }
}, 50_000);

test('activated secure push changes the session and status warning', async () => {
  const f = await setup('off');
  fs.writeFileSync(
    path.join(f.home, '.remi', 'secure_push_activation.json'),
    '{"version":1,"activated":true}',
  );
  const run = launch(f);
  await pollUntil(() => fs.existsSync(path.join(f.agents.claudeDir, 'argv')), 20_000, 'agent');
  const warning =
    'No remi hub is running, so your phone will not get notifications for this session and sees it only by connecting to its port directly. Start the hub with: remi start';
  expect(run.output.text).toContain(warning);
  const status = Bun.spawnSync([process.execPath, CLI_TS, 'status'], {
    cwd: f.work,
    env: f.env,
    timeout: 5000,
  });
  expect(status.stdout.toString()).toContain(warning);
}, 25_000);

test('unavailable legacy push warns definitively without writing activation', async () => {
  for (const mode of ['corrupt', 'disabled', 'no-secret']) {
    const f = await setup('off');
    const activation = path.join(f.home, '.remi', 'secure_push_activation.json');
    if (mode === 'corrupt') fs.writeFileSync(activation, 'invalid');
    if (mode === 'disabled')
      fs.appendFileSync(
        path.join(f.home, '.remi', 'config.toml'),
        '\n[notifications]\nlegacy_push_enabled = false\n',
      );
    if (mode === 'no-secret') f.env['REMI_PUSH_SECRET'] = undefined;
    const before = fs.existsSync(activation) ? fs.readFileSync(activation, 'utf8') : null;
    const run = launch(f);
    await pollUntil(() => fs.existsSync(path.join(f.agents.claudeDir, 'argv')), 20_000, 'agent');
    const warning =
      'No remi hub is running, so your phone will not get notifications for this session';
    expect(run.output.text).toContain(warning);
    const status = Bun.spawnSync([process.execPath, CLI_TS, 'status'], {
      cwd: f.work,
      env: f.env,
      timeout: 5000,
    });
    expect(status.stdout.toString()).toContain(warning);
    expect(fs.existsSync(activation) ? fs.readFileSync(activation, 'utf8') : null).toBe(before);
    expect(fs.existsSync(path.join(f.home, '.remi', 'authorized_keys.json.lock'))).toBe(false);
  }
}, 75_000);

test('concurrent launches share a hub', async () => {
  const f = await setup();
  const first = launch(f);
  const second = launch(f);
  try {
    await pollUntil(
      () => {
        const sessions = path.join(f.home, '.remi', 'live-sessions');
        return (
          fs.existsSync(path.join(f.home, '.remi', 'daemon-status.json')) &&
          fs.existsSync(path.join(f.agents.claudeDir, 'argv')) &&
          fs.existsSync(sessions) &&
          fs.readdirSync(sessions).length >= 2
        );
      },
      20_000,
      'hub and both sessions',
    );
  } catch (error) {
    throw new Error(
      `Concurrent launches did not become ready: ${String(error)}\nfirst: ${first.output.text}\nsecond: ${second.output.text}`,
    );
  }
  expect(
    (first.output.text + second.output.text).match(/Started the remi hub on port/g)?.length,
  ).toBe(1);
  expect(
    fs
      .readFileSync(path.join(f.home, '.remi', 'daemon.log'), 'utf8')
      .match(/--- Daemon starting at/g)?.length,
  ).toBe(1);
}, 30_000);

test('management, remote and daemon commands never auto-start a hub', async () => {
  const f = await setup();
  for (const args of [
    ['status'],
    ['keys'],
    ['attach', '--port', String(f.port)],
    ['new', '--host', '127.0.0.1', '--port', String(f.port)],
  ]) {
    const result = Bun.spawnSync([process.execPath, CLI_TS, ...args], {
      cwd: f.work,
      env: f.env,
      timeout: 5000,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.stdout.toString() + result.stderr.toString()).not.toContain(
      'Started the remi hub',
    );
    expect(fs.existsSync(path.join(f.home, '.remi', 'daemon.pid'))).toBe(false);
  }
  const run = launch(f, ['--daemon', '--port', String(f.port + 1), '--no-mdns']);
  await pollUntil(
    () => fs.existsSync(path.join(f.agents.claudeDir, 'argv')),
    20_000,
    'daemon agent',
  );
  expect(run.output.text).not.toContain('Started the remi hub');
  expect(run.output.text).toContain('No remi hub is running');
  expect(fs.existsSync(path.join(f.home, '.remi', 'daemon.pid'))).toBe(false);
}, 30_000);

test('status reports the possible legacy path and the reserved port is refused', async () => {
  const f = await setup('off');
  const status = Bun.spawnSync([process.execPath, CLI_TS, 'status'], {
    cwd: f.work,
    env: f.env,
    timeout: 5000,
  });
  expect(status.stdout.toString()).toContain(
    "No remi hub is running, so your phone may not see this session's questions or get its notifications. Start the hub with: remi start",
  );
  const reserved = Bun.spawnSync([process.execPath, CLI_TS, '--port', String(f.port)], {
    cwd: f.work,
    env: f.env,
    timeout: 5000,
  });
  expect(reserved.exitCode).not.toBe(0);
  expect(reserved.stderr.toString()).toContain(`Port ${f.port} is reserved for the remi hub.`);
  expect(fs.existsSync(path.join(f.home, '.remi', 'daemon.pid'))).toBe(false);
}, 15_000);

test.each([
  ['--port', 'BASE'],
  ['codex', '--worktree'],
])(
  'refused local launch %s %s does not start a hub',
  async (first, second) => {
    const f = await setup();
    const args = [first, second];
    const result = Bun.spawnSync(
      [process.execPath, CLI_TS, ...args.map((arg) => (arg === 'BASE' ? String(f.port) : arg))],
      { cwd: f.work, env: f.env, timeout: 8000, stdout: 'pipe', stderr: 'pipe' },
    );
    expect(result.exitCode).not.toBe(0);
    expect(fs.existsSync(path.join(f.home, '.remi', 'daemon.pid'))).toBe(false);
    expect(fs.existsSync(path.join(f.home, '.remi', 'daemon-status.json'))).toBe(false);
  },
  20_000,
);

test('a REMI_HOME override does not auto-start', async () => {
  const f = await setup();
  const override = path.join(f.home, 'scratch-state');
  fs.mkdirSync(override);
  fs.copyFileSync(path.join(f.home, '.remi', 'config.toml'), path.join(override, 'config.toml'));
  f.env['REMI_HOME'] = override;
  const run = launch(f);
  await pollUntil(() => fs.existsSync(path.join(f.agents.claudeDir, 'argv')), 20_000, 'agent');
  expect(run.output.text).toContain('No remi hub is running');
  expect(fs.existsSync(path.join(override, 'daemon.pid'))).toBe(false);
}, 25_000);

test('port probing skips a reserved candidate without changing the range', async () => {
  const f = await setup('off');
  const registry = new SessionRegistryFile(path.join(f.home, 'registry'));
  expect(await registry.findAvailablePort(f.port, 20, DEFAULT_CONFIG.daemon.bind, [f.port])).toBe(
    f.port + 1,
  );
}, 10_000);

test('initial session probe reserves the configured hub base', async () => {
  const f = await setup('off');
  const run = launch(f);
  await pollUntil(
    () => {
      if (run.proc.exitCode !== null)
        throw new Error(`Session exited before agent: ${run.output.text}`);
      return fs.existsSync(path.join(f.agents.claudeDir, 'argv'));
    },
    15_000,
    'session agent',
  );
  const registry = new SessionRegistryFile(path.join(f.home, '.remi', 'live-sessions'));
  expect(registry.listLive().map((entry) => entry.wsPort)).toEqual([f.port + 1]);
  expect(run.output.text).not.toContain('is reserved for the remi hub');
}, 20_000);

test('an existing hub is reused by the next local session', async () => {
  const f = await setup();
  const first = launch(f);
  await pollUntil(
    () => fs.existsSync(path.join(f.agents.claudeDir, 'argv')),
    20_000,
    'first agent',
  );
  const second = launch(f);
  await pollUntil(
    () => fs.readdirSync(path.join(f.home, '.remi', 'live-sessions')).length >= 2,
    20_000,
    'both sessions',
  );
  expect(first.output.text).toContain(`Started the remi hub on port ${f.port}.`);
  expect(second.output.text).not.toContain('Started the remi hub');
  expect(second.output.text).not.toContain('No remi hub is running');
  expect(
    fs
      .readFileSync(path.join(f.home, '.remi', 'daemon.log'), 'utf8')
      .match(/--- Daemon starting at/g)?.length,
  ).toBe(1);
}, 25_000);

test('a stalled detached launcher times out and reports the warning', async () => {
  const f = await setup();
  const fakeRemi = path.join(f.home, 'fake-bin', 'remi');
  fs.writeFileSync(fakeRemi, '#!/bin/sh\nexec /bin/sleep 30\n', { mode: 0o700 });
  const modulePath = path.resolve(import.meta.dir, '../../src/cli/hub-autostart.ts');
  const script = `process.argv[0] = 'test-parent'; process.argv[1] = 'test-parent'; const { ensureHubForSession } = await import(${JSON.stringify(modulePath)}); await ensureHubForSession(true, { legacyEnabled: true, pushSecret: 'test-secret' }); console.log('continued');`;
  const started = Date.now();
  const proc = Bun.spawn([process.execPath, '-e', script], {
    cwd: f.work,
    env: f.env,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 14_000,
  });
  processes.push(proc);
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain('continued');
  expect(stderr).toContain(
    "No remi hub is running, so your phone may not see this session's questions or get its notifications. Start the hub with: remi start",
  );
  expect(Date.now() - started).toBeLessThan(14_000);
  expect(Date.now() - started).toBeGreaterThanOrEqual(9000);
}, 16_000);

test('a missing launcher fails immediately with a warning and a logged cause', async () => {
  const f = await setup();
  f.env['PATH'] = path.join(f.home, 'missing');
  const modulePath = path.resolve(import.meta.dir, '../../src/cli/hub-autostart.ts');
  const script = `process.argv[0] = 'test-parent'; process.argv[1] = 'test-parent'; const { ensureHubForSession } = await import(${JSON.stringify(modulePath)}); await ensureHubForSession(true, { legacyEnabled: true, pushSecret: 'test-secret' });`;
  const started = Date.now();
  const result = Bun.spawnSync([process.execPath, '-e', script], {
    cwd: f.work,
    env: f.env,
    timeout: 13_000,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(Date.now() - started).toBeLessThan(2000);
  expect(result.stderr.toString()).toContain('No remi hub is running');
  expect(fs.readFileSync(path.join(f.home, '.remi', 'daemon.log'), 'utf8')).toContain('ENOENT');
}, 15_000);

test('failed launcher logs its bounded last stderr line with secrets redacted', async () => {
  const f = await setup();
  f.env['REMI_PASSPHRASE'] = 'passphrase-example';
  f.env['REMI_PUSH_SECRET'] = 'push-example';
  f.env['TELEGRAM_BOT_TOKEN'] = 'telegram-example';
  fs.writeFileSync(
    path.join(f.home, 'fake-bin', 'remi'),
    '#!/bin/sh\nprintf "earlier line\\nlauncher: %s %s %s %0400d\\n" "$REMI_PASSPHRASE" "$REMI_PUSH_SECRET" "$TELEGRAM_BOT_TOKEN" 0 >&2\nexit 1\n',
    { mode: 0o700 },
  );
  const modulePath = path.resolve(import.meta.dir, '../../src/cli/hub-autostart.ts');
  const script = `process.argv[0] = 'test-parent'; process.argv[1] = 'test-parent'; const { ensureHubForSession } = await import(${JSON.stringify(modulePath)}); await ensureHubForSession(true, { legacyEnabled: true, pushSecret: 'test-secret' });`;
  const result = Bun.spawnSync([process.execPath, '-e', script], {
    cwd: f.work,
    env: f.env,
    timeout: 5000,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(result.exitCode).toBe(0);
  const log = fs.readFileSync(path.join(f.home, '.remi', 'daemon.log'), 'utf8').trim();
  expect(log).toContain('launcher: [REDACTED] [REDACTED] [REDACTED]');
  expect(log).not.toContain('earlier line');
  expect(log.length).toBeLessThanOrEqual('[hub autostart] startup failed: '.length + 300);
  for (const secret of ['passphrase-example', 'push-example', 'telegram-example']) {
    expect(log).not.toContain(secret);
    expect(result.stderr.toString()).not.toContain(secret);
  }
  expect(result.stderr.toString()).not.toContain('launcher:');
}, 10_000);
