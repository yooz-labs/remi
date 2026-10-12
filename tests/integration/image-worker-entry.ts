/** #1170: owned source/compiled entry acceptance; no owner state or real harness. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createImageDecoder,
  imageWorkerCommand,
} from '../../packages/daemon/src/tunnel/image-worker-command';

if (process.argv[2] === '--internal-image-worker') {
  // This owned compiled profile exercises the real factory's self-exec command.
  assert.equal(process.env['BUN_JSC_useJIT'], '0');
  assert.equal(process.env['REMI_ENTRY_OWNED_SENTINEL'], undefined);
  assert.equal(process.env['REMI_ENTRY_OWNED_PRELOAD'], undefined);
  assert(
    Object.keys(process.env)
      .filter((key) => key.startsWith('BUN_JSC_'))
      .every((key) => key === 'BUN_JSC_useJIT'),
  );
  await import('../../packages/daemon/src/entry');
} else if (process.argv[2] === '--runtime-autoload-probe') {
  console.log(
    JSON.stringify({
      dotenv: process.env['REMI_ENTRY_OWNED_SENTINEL'] === 'owned',
      bunfig: process.env['REMI_ENTRY_OWNED_PRELOAD'] === 'owned',
    }),
  );
} else {
  const repo = path.resolve(process.argv[4] ?? path.resolve(import.meta.dir, '../..'));
  const mode = process.argv[2];
  assert(mode === 'source' || mode === 'compiled');
  const cliPath =
    mode === 'compiled' ? process.argv[3] : path.join(repo, 'packages/daemon/src/entry.ts');
  assert(cliPath && path.isAbsolute(cliPath));
  const cliCommand = mode === 'compiled' ? [cliPath] : [process.execPath, '--no-env-file', cliPath];
  const profileCommand = import.meta.path.startsWith('/$bunfs/')
    ? [process.execPath]
    : [process.execPath, import.meta.path];
  const work = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'remi-worker-entry-profile-')),
  );
  fs.chmodSync(work, 0o700);
  const checks: string[] = [];
  const childExits: unknown[] = [];
  const cleanupErrors: string[] = [];
  let hub: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  let childPid: number | undefined;
  let client: WebSocket | undefined;
  const ownedProcesses: Bun.Subprocess[] = [];
  let autoload: { dotenv: boolean; bunfig: boolean } | undefined;
  const check = (value: unknown, label: string): void => {
    assert(value, label);
    checks.push(label);
  };
  const home = path.join(work, 'home');
  const state = path.join(work, 'state');
  const project = path.join(work, 'project');
  const privateCwd = path.join(work, 'worker');
  const configCwd = path.join(work, 'parent-config');
  for (const dir of [home, state, project, privateCwd, configCwd])
    fs.mkdirSync(dir, { mode: 0o700 });
  const runtimeEnv = {
    PATH: '/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    TMPDIR: os.tmpdir(),
    BUN_JSC_useJIT: '0',
  };
  const cliEnv = {
    PATH: runtimeEnv.PATH,
    LANG: runtimeEnv.LANG,
    TMPDIR: runtimeEnv.TMPDIR,
    HOME: home,
    REMI_HOME: state,
  };
  const sync = (
    args: readonly string[],
    input = Buffer.alloc(0),
    cwd = project,
    env: Record<string, string> = cliEnv,
  ) =>
    Bun.spawnSync([...cliCommand, ...args], {
      cwd,
      env,
      stdin: input,
      stdout: 'pipe',
      stderr: 'pipe',
    });
  async function until(predicate: () => boolean, label: string, milliseconds = 15000) {
    const deadline = Date.now() + milliseconds;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error(`timeout:${label}`);
      await Bun.sleep(25);
    }
  }
  async function reap(proc: Bun.Subprocess) {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
    const timer = setTimeout(() => proc.kill('SIGKILL'), 3000);
    try {
      await proc.exited;
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    const fixtures = path.join(repo, 'scripts/tunnel-decoder-proof');
    const inputs = JSON.parse(fs.readFileSync(path.join(fixtures, 'inputs.json'), 'utf8')) as {
      images: Array<{
        filename: string;
        width: number;
        height: number;
        pixelBytes: number;
        pixelSha256: string;
      }>;
    };
    for (const [index, media] of (['image/png', 'image/jpeg'] as const).entries()) {
      const expected = inputs.images[index];
      assert(expected);
      const bytes = fs.readFileSync(path.join(fixtures, expected.filename));
      const decoded = sync(['--internal-image-worker', media], bytes, privateCwd, {
        ...cliEnv,
        REMI_HOME: 'relative-before-cli-control',
      });
      check(
        decoded.exitCode === 0 && decoded.stderr.length === 0,
        `${media}-actual-entry-before-cli`,
      );
      assert.deepEqual(JSON.parse(decoded.stdout.toString()), {
        kind: 'decoded',
        width: expected.width,
        height: expected.height,
        pixelBytes: expected.pixelBytes,
        pixelSha256: expected.pixelSha256,
      });
      checks.push(`${media}-actual-entry-pixels`);
    }
    for (const args of [
      ['--internal-image-worker'],
      ['--internal-image-worker', 'image/gif'],
      ['--internal-image-worker', 'image/png', '--help'],
      ['--internal-image-worker', '--repeat-decode', 'image/jpeg'],
    ]) {
      const refused = sync(args, Buffer.alloc(0), privateCwd, {
        ...cliEnv,
        REMI_HOME: 'relative-before-cli-control',
      });
      check(
        refused.exitCode === 1 &&
          refused.stdout.toString() === '{"kind":"refused"}\n' &&
          refused.stderr.length === 0,
        `malformed-${args.join(':')}`,
      );
    }
    const guard = sync(['--help'], Buffer.alloc(0), project, {
      ...cliEnv,
      REMI_HOME: 'relative-before-cli-control',
    });
    check(
      guard.exitCode === 1 &&
        guard.stderr.toString().includes('REMI_HOME must be an absolute path'),
      'normal-cli-load-positive',
    );
    for (const args of [
      ['--help'],
      ['--help', '--', '--internal-image-worker', 'image/png'],
      ['--help', '--internal-image-worker', 'image/jpeg'],
    ]) {
      const help = sync(args);
      check(
        help.exitCode === 0 &&
          help.stdout.toString().includes('remi') &&
          !help.stdout.toString().includes('{"kind":'),
        `normal-help-${args.join(':')}`,
      );
    }
    const version = sync(['--version']);
    const wantedVersion = JSON.parse(
      fs.readFileSync(path.join(repo, 'package.json'), 'utf8'),
    ).version;
    check(
      version.exitCode === 0 && version.stdout.toString().includes(`remi ${wantedVersion}`),
      'normal-version',
    );
    fs.writeFileSync(path.join(configCwd, '.env'), 'REMI_ENTRY_OWNED_SENTINEL=owned\n');
    fs.writeFileSync(
      path.join(configCwd, 'preload.ts'),
      "process.env['REMI_ENTRY_OWNED_PRELOAD']='owned';\n",
    );
    fs.writeFileSync(path.join(configCwd, 'bunfig.toml'), 'preload = ["./preload.ts"]\n');
    const positive = Bun.spawnSync([...profileCommand, '--runtime-autoload-probe'], {
      cwd: configCwd,
      env: runtimeEnv,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    check(positive.exitCode === 0, 'owned-parent-cwd-runtime-control-exit');
    autoload = JSON.parse(positive.stdout.toString());
    check(autoload?.dotenv === true, 'owned-parent-dotenv-observable');
    // Record bunfig observability separately: compiled preloads vary by runtime.
    const isolated = Bun.spawnSync([...profileCommand, '--runtime-autoload-probe'], {
      cwd: privateCwd,
      env: runtimeEnv,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    check(isolated.exitCode === 0, 'owned-private-cwd-runtime-control-exit');
    assert.deepEqual(JSON.parse(isolated.stdout.toString()), { dotenv: false, bunfig: false });
    checks.push('owned-private-cwd-config-isolation');
    const priorCwd = process.cwd();
    try {
      process.chdir(configCwd);
      const decoder = createImageDecoder(privateCwd);
      const fixedCommand = imageWorkerCommand();
      assert.deepEqual(
        fixedCommand,
        import.meta.path.startsWith('/$bunfs/')
          ? [process.execPath, '--internal-image-worker']
          : [
              process.execPath,
              '--no-env-file',
              path.join(repo, 'packages/daemon/src/entry.ts'),
              '--internal-image-worker',
            ],
      );
      checks.push('fixed-factory-source-or-compiled-command');
      for (const [index, media] of (['image/png', 'image/jpeg'] as const).entries()) {
        const expected = inputs.images[index];
        assert(expected);
        const result = await decoder.decode(
          fs.readFileSync(path.join(fixtures, expected.filename)),
          media,
        );
        assert.deepEqual(result, {
          width: expected.width,
          height: expected.height,
          pixelBytes: expected.pixelBytes,
          pixelSha256: expected.pixelSha256,
        });
        check(
          decoder.lastChildExit?.exitCode === 0 &&
            decoder.lastChildExit.signalCode === null &&
            decoder.lastChildExit.pid === decoder.lastChildPID,
          `${media}-factory-private-cwd-child-exit`,
        );
        childExits.push(decoder.lastChildExit);
        checks.push(`${media}-factory-private-cwd-pixels`);
      }
    } finally {
      process.chdir(priorCwd);
    }
    assert.deepEqual(fs.readdirSync(privateCwd), []);
    checks.push('private-worker-directory-stays-empty');
    const { installFakeAgents, waitForRecordedArgv } = await import(
      '../../packages/daemon/tests/helpers/fake-agent-clis'
    );
    const { reserveRange } = await import('../../packages/daemon/tests/session/port-test-helpers');
    const { createHello, createCreateSessionRequest, generateId, serialize, deserialize } =
      await import('../../packages/shared/src/protocol');
    const agents = installFakeAgents(home, { claude: true });
    const port = await reserveRange(20, 50, '127.0.0.1');
    hub = Bun.spawn(
      [
        ...cliCommand,
        'serve',
        '--port',
        String(port),
        '--no-relay',
        '--no-telegram',
        '--no-mdns',
        '--no-auth',
      ],
      {
        cwd: project,
        env: { ...cliEnv, ...agents.env },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    ownedProcesses.push(hub);
    const hubOutput = new Response(hub.stdout).text();
    const hubError = new Response(hub.stderr).text();
    const statusFile = path.join(state, 'daemon-status.json');
    await until(() => fs.existsSync(statusFile) || hub?.exitCode !== null, 'serve-status');
    check(
      hub.exitCode === null && JSON.parse(fs.readFileSync(statusFile, 'utf8')).mode === 'hub',
      'real-entry-sessionless-serve',
    );
    check(!fs.existsSync(path.join(agents.claudeDir, 'argv')), 'serve-does-not-launch-harness');
    const received: ReturnType<typeof deserialize>[] = [];
    client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    client.addEventListener('message', (event) => {
      received.push(deserialize(String(event.data)));
    });
    await until(() => client?.readyState === WebSocket.OPEN, 'hub-websocket');
    client.send(serialize(createHello(generateId(), 'owned-entry-profile')));
    await until(() => received.some((message) => message?.type === 'hello_ack'), 'hub-hello');
    const request = createCreateSessionRequest(project, {
      harness: 'claude',
      args: ['--model', 'owned-entry-profile'],
    });
    client.send(serialize(request));
    await until(
      () =>
        received.some(
          (message) =>
            message?.type === 'create_session_response' && message.requestId === request.id,
        ),
      'child-response',
      20000,
    );
    const response = received.find(
      (message) => message?.type === 'create_session_response' && message.requestId === request.id,
    );
    assert(response?.type === 'create_session_response');
    check(response.success === true, 'actual-entry-reexec-create-session');
    const argv = await waitForRecordedArgv(agents.claudeDir);
    check(argv.includes('owned-entry-profile'), 'real-inert-harness-child-argv');
    check(
      fs.readFileSync(path.join(agents.claudeDir, 'cwd'), 'utf8').trim() ===
        fs.realpathSync(project),
      'real-inert-harness-child-cwd',
    );
    const records = fs
      .readdirSync(path.join(state, 'live-sessions'))
      .map((name) => JSON.parse(fs.readFileSync(path.join(state, 'live-sessions', name), 'utf8')));
    const record = records.find((item) => item.wsPort === response.port);
    assert(record && Number.isInteger(record.pid) && record.pid > 1);
    childPid = record.pid;
    check(
      childPid !== hub.pid && record.sessionId === response.sessionId,
      'real-entry-child-distinct-session',
    );
    const ack = received.find((message) => message?.type === 'hello_ack');
    check(ack?.type === 'hello_ack' && ack.sessionId === null, 'hub-remains-sessionless');
    fs.writeFileSync(path.join(agents.claudeDir, 'release'), '');
    await until(() => {
      try {
        process.kill(childPid as number, 0);
        return false;
      } catch {
        return true;
      }
    }, 'inert-child-exit');
    checks.push('real-inert-child-exited');
    childPid = undefined;
    client.close();
    client = undefined;
    await reap(hub);
    const [out, err] = await Promise.all([hubOutput, hubError]);
    check(hub.exitCode === 0, 'serve-graceful-exit');
    check(
      out.includes('Remi hub ready!') && !err.includes('Failed to start daemon'),
      'normal-serve-output',
    );
    hub = undefined;
    const notices = fs.readFileSync(path.join(repo, 'THIRD_PARTY_NOTICES'), 'utf8');
    for (const item of ['pngjs@5.0.0', 'pngjs@7.0.0', 'jpeg-js@0.4.4'])
      check(notices.includes(item), `bundled-notices-${item}`);
  } finally {
    client?.close();
    if (childPid) {
      try {
        process.kill(childPid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
          cleanupErrors.push('owned-child-kill');
      }
      await until(() => {
        try {
          process.kill(childPid as number, 0);
          return false;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === 'ESRCH';
        }
      }, 'cleanup-owned-child').catch(() => cleanupErrors.push('owned-child-exit'));
    }
    for (const proc of ownedProcesses) {
      try {
        await reap(proc);
      } catch {
        cleanupErrors.push('owned-process-reap');
      }
    }
    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch {
      cleanupErrors.push('owned-work-remove');
    }
    if (cleanupErrors.length) console.error(JSON.stringify({ complete: false, cleanupErrors }));
  }
  assert.deepEqual(cleanupErrors, []);
  assert(!fs.existsSync(work));
  console.log(
    JSON.stringify({
      complete: true,
      mode,
      runtime: Bun.version,
      platform: process.platform,
      arch: process.arch,
      checks,
      autoload,
      bunfigPositiveObserved: autoload?.bunfig === true,
      childExits,
      cleanupErrors,
      ownedWorkRemoved: true,
    }),
  );
}
