import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createCreateSessionRequest,
  createResumeSessionRequest,
  createSessionListRequest,
  createTranscriptLoadRequest,
  serialize,
} from '@remi/shared/protocol.ts';
import type { SessionListResponseMessage } from '@remi/shared/protocol.ts';
import { DEFAULT_CONFIG } from '../../src/config/config.ts';
import {
  PROFILE_CREDENTIAL_ENV,
  PROFILE_CREDENTIAL_ENV_PREFIXES,
} from '../../src/profiles/profile-env.ts';
import { FakeAppServer } from '../helpers/fake-app-server.ts';
import { reserveRange } from '../session/port-test-helpers.ts';
import {
  CLI_TS,
  cleanupHub,
  connectAndHello,
  isolatedEnv,
  makeIsolatedDirs,
  pollUntil,
  spawnDaemon,
  spawnHub,
} from './hub-test-utils.ts';
import { connectAndHelloRaw } from './profile-frame-helpers.ts';

const running: Array<{
  proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  home: string;
  work: string;
  port: number;
}> = [];
const servers: FakeAppServer[] = [];
afterEach(async () => {
  for (const d of running.splice(0)) await cleanupHub(d);
  for (const server of servers.splice(0)) await server.stop();
});

function fixture() {
  const dirs = makeIsolatedDirs();
  const remi = path.join(dirs.home, '.remi');
  const profile = path.join(dirs.home, 'profile-claude');
  const bin = path.join(dirs.home, 'bin');
  const output = path.join(dirs.home, 'fake-output');
  for (const dir of [remi, profile, bin, output]) fs.mkdirSync(dir);
  const fake = `#!/bin/sh
if [ "$1 $2 $3" = 'auth status --json' ]; then
  if [ -e "$CLAUDE_CONFIG_DIR/force-signed-in" ]; then
    printf '%s' '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}'
  elif [ -e "$CLAUDE_CONFIG_DIR/settings.json" ] && /usr/bin/grep -q '"apiKeyHelper"' "$CLAUDE_CONFIG_DIR/settings.json"; then
    printf '%s' '{"loggedIn":true,"authMethod":"api_key_helper","apiKeySource":"apiKeyHelper"}'
  elif [ -e "$CLAUDE_CONFIG_DIR/signed-out" ]; then
    printf '%s' '{"loggedIn":false}'
  elif [ -e "$CLAUDE_CONFIG_DIR/config-mismatch" ]; then
    printf '%s' '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","configDirectory":"/different"}'
  else
    printf '%s' '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}'
  fi
  exit 0
fi
printf '%s' "$CLAUDE_CONFIG_DIR" > "$FAKE_OUTPUT/dir"
env | cut -d= -f1 | sort > "$FAKE_OUTPUT/names"
printf '%s\\n' "$@" > "$FAKE_OUTPUT/argv"
i=0
while [ ! -e "$FAKE_OUTPUT/release" ] && [ "$i" -lt 600 ]; do sleep 0.1; i=$((i + 1)); done
`;
  fs.writeFileSync(path.join(bin, 'claude'), fake, { mode: 0o700 });
  fs.writeFileSync(path.join(bin, 'sh-path'), '#!/bin/sh\necho "$PATH"\n', { mode: 0o700 });
  fs.writeFileSync(
    path.join(remi, 'config.toml'),
    `[profiles.work]\nlabel="Work"\nfolders=[${JSON.stringify(dirs.work)}]\n[profiles.work.claude]\ndir=${JSON.stringify(profile)}\nexpects="subscription"\n`,
  );
  const env = {
    ...Object.fromEntries(PROFILE_CREDENTIAL_ENV.map((name) => [name, 'planted-value'])),
    ...Object.fromEntries(
      PROFILE_CREDENTIAL_ENV_PREFIXES.map((prefix) => [`${prefix}REMI_TEST`, 'planted-value']),
    ),
    AWS_PROFILE: 'planted-value',
    AWS_CONTAINER_AUTHORIZATION_TOKEN: 'planted-value',
    AWS_CONTAINER_CREDENTIALS_FULL_URI: 'planted-value',
    AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: 'planted-value',
    AWS_ROLE_ARN: 'planted-value',
    CLOUDSDK_AUTH_ACCESS_TOKEN: 'planted-value',
    GOOGLE_OAUTH_ACCESS_TOKEN: 'planted-value',
    AWS_REGION: 'planted-value',
    AZURE_CLIENT_SECRET: 'planted-value',
    ANTHROPIC_SECRET_PLACEHOLDER_REMI_TEST: 'planted-value',
    CLAUDE_CODE_OAUTH_REMI_TEST: 'planted-value',
    PATH: `${bin}:/usr/bin:/bin`,
    SHELL: path.join(bin, 'sh-path'),
    FAKE_OUTPUT: output,
    // The Anthropic named-profile directory follows XDG_CONFIG_HOME before HOME, so an ambient
    // value (a CI runner sets one) would hide the files the tests plant under the sandbox HOME.
    XDG_CONFIG_HOME: path.join(dirs.home, '.config'),
    CLAUDE_CONFIG_DIR: path.join(dirs.home, 'inherited-claude'),
    CODEX_HOME: path.join(dirs.home, 'inherited-codex'),
  };
  return { ...dirs, remi, profile, output, env };
}

async function spawnWrapper(
  f: ReturnType<typeof fixture>,
  args: string[],
  extra: Record<string, string> = {},
) {
  const port = await reserveRange(1, 50, DEFAULT_CONFIG.daemon.bind);
  const proc = Bun.spawn(
    [
      process.execPath,
      CLI_TS,
      '--port',
      String(port),
      '--no-relay',
      '--no-telegram',
      '--no-mdns',
      '--no-auth',
      ...args,
    ],
    {
      cwd: f.work,
      env: isolatedEnv(f.home, { ...f.env, ...extra }),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  running.push({ proc, port, home: f.home, work: f.work });
  return proc;
}

for (const route of ['flag', 'environment', 'folder'] as const) {
  test(`Claude ${route} selection scrubs inherited credentials and records its profile`, async () => {
    const f = fixture();
    const started = await spawnDaemon(
      f.home,
      f.work,
      { ...f.env, ...(route === 'environment' && { REMI_PROFILE: 'work' }) },
      route === 'flag' ? ['--remi-profile', 'work'] : [],
    );
    running.push({ ...started, home: f.home, work: f.work });
    await pollUntil(
      () => fs.existsSync(path.join(f.output, 'argv')) || started.proc.exitCode !== null,
      15000,
      'profile agent start',
    );
    expect(started.proc.exitCode).toBeNull();
    expect(fs.readFileSync(path.join(f.output, 'dir'), 'utf8')).toBe(f.profile);
    const names = fs.readFileSync(path.join(f.output, 'names'), 'utf8').split('\n');
    for (const name of PROFILE_CREDENTIAL_ENV) expect(names).not.toContain(name);
    expect(names).not.toContain('AWS_PROFILE');
    expect(names).not.toContain('ANTHROPIC_SECRET_PLACEHOLDER_REMI_TEST');
    expect(names).not.toContain('CLAUDE_CODE_OAUTH_REMI_TEST');
    for (const prefix of PROFILE_CREDENTIAL_ENV_PREFIXES)
      expect(names.some((name) => name.startsWith(prefix))).toBe(false);
    const records = JSON.parse(
      fs.readFileSync(path.join(f.remi, 'sessions.json'), 'utf8'),
    ).sessions;
    const record = records[0];
    const sidecar = JSON.parse(fs.readFileSync(path.join(f.remi, 'session-profiles.json'), 'utf8'));
    expect(fs.statSync(path.join(f.remi, 'session-profiles.json')).mode & 0o777).toBe(0o600);
    expect(record.profile).toBe('work');
    expect(sidecar.sessions[record.remiSessionId]).toEqual({
      profile: 'work',
      revision: record.profileSnapshot.revision,
    });
  }, 25000);
}

test('a different effective login refuses the launch', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.profile, 'settings.json'), '{"apiKeyHelper":"placeholder"}');
  const started = await spawnDaemon(f.home, f.work, f.env, ['--remi-profile', 'work']);
  running.push({ ...started, home: f.home, work: f.work });
  const exit = await Promise.race([started.proc.exited, Bun.sleep(3000).then(() => null)]);
  if (exit === null) started.proc.kill('SIGKILL');
  expect(exit).toBe(78);
  expect(await new Response(started.proc.stderr).text()).toContain(
    "This profile's login is not what will be used (apiKeyHelper).",
  );
  expect(fs.existsSync(path.join(f.output, 'argv'))).toBe(false);
}, 25000);

test('launch warnings name the source and never print settings values', async () => {
  const f = fixture();
  const anthropic = path.join(f.home, '.config', 'anthropic');
  fs.mkdirSync(path.join(anthropic, 'configs'), { recursive: true });
  fs.writeFileSync(path.join(anthropic, 'active_config'), 'PRIVATE_VALUE');
  fs.writeFileSync(path.join(anthropic, 'configs', 'one'), 'PRIVATE_VALUE');
  fs.writeFileSync(path.join(f.profile, 'force-signed-in'), '');
  fs.writeFileSync(
    path.join(f.profile, 'settings.json'),
    JSON.stringify({ apiKeyHelper: 'PRIVATE_VALUE' }),
  );
  fs.mkdirSync(path.join(f.work, '.claude'));
  fs.writeFileSync(
    path.join(f.work, '.claude', 'settings.json'),
    JSON.stringify({ env: { CUSTOM_TOKEN: 'PRIVATE_VALUE' } }),
  );
  const started = await spawnDaemon(f.home, f.work, f.env, ['--remi-profile', 'work']);
  running.push({ ...started, home: f.home, work: f.work });
  await pollUntil(
    () => fs.existsSync(path.join(f.output, 'argv')) || started.proc.exitCode !== null,
    15000,
    'warning launch',
  );
  expect(started.proc.exitCode).toBeNull();
  fs.writeFileSync(path.join(f.output, 'release'), '');
  expect(await started.proc.exited).toBe(0);
  const output = await new Response(started.proc.stderr).text();
  for (const warning of [
    'anthropic_profile: active_config',
    'anthropic_profile: configs',
    'user_settings: apiKeyHelper',
    'project_settings: env',
  ])
    expect(output).toContain(warning);
  expect(output).not.toContain('PRIVATE_VALUE');
}, 30000);

test('a profile daemon reads its own transcript root and ignores the default root', async () => {
  const f = fixture();
  const started = await spawnDaemon(f.home, f.work, f.env, ['--remi-profile', 'work']);
  running.push({ ...started, home: f.home, work: f.work });
  await pollUntil(() => fs.existsSync(path.join(f.output, 'argv')), 15000, 'profile agent');
  const id = '77777777-7777-4777-8777-777777777777';
  const project = f.work.replace(/\//g, '-');
  const normalDir = path.join(f.home, '.claude', 'projects', project);
  const profileDir = path.join(f.profile, 'projects', project);
  fs.mkdirSync(normalDir, { recursive: true });
  fs.mkdirSync(profileDir, { recursive: true });
  const entry = (content: string) =>
    `${JSON.stringify({ type: 'user', uuid: 'u1', sessionId: id, cwd: f.work, timestamp: new Date().toISOString(), message: { role: 'user', content } })}\n`;
  fs.writeFileSync(path.join(normalDir, `${id}.jsonl`), entry('DEFAULT_SENTINEL'));
  const { ws, received } = await connectAndHello(started.port);
  try {
    ws.send(serialize(createTranscriptLoadRequest(id)));
    await pollUntil(
      () => received.some((msg) => msg.type === 'error'),
      10000,
      'missing profile transcript',
    );
    expect(JSON.stringify(received)).not.toContain('DEFAULT_SENTINEL');
    fs.writeFileSync(path.join(profileDir, `${id}.jsonl`), entry('PROFILE_SENTINEL'));
    const request = createTranscriptLoadRequest(id);
    ws.send(serialize(request));
    await pollUntil(
      () =>
        received.some(
          (msg) => msg.type === 'transcript_load_complete' && msg.requestId === request.id,
        ),
      10000,
      'profile transcript load',
    );
    expect(JSON.stringify(received)).toContain('PROFILE_SENTINEL');
    expect(JSON.stringify(received)).not.toContain('DEFAULT_SENTINEL');
  } finally {
    ws.close();
    fs.writeFileSync(path.join(f.output, 'release'), '');
  }
}, 30000);

test('wrapper refuses signed-out, unknown and unsupported harness selections', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.profile, 'signed-out'), '');
  for (const [args, text] of [
    [
      ['--remi-profile', 'work'],
      'Profile work is not signed in to claude. Run: remi profile login work --harness claude',
    ],
    [['--remi-profile', 'missing'], 'remi profile ls'],
    [['--remi-profile', 'work', '--harness', 'codex'], 'Profile work does not configure codex.'],
  ] as const) {
    const proc = await spawnWrapper(f, [...args]);
    expect(await proc.exited).not.toBe(0);
    expect(await new Response(proc.stderr).text()).toContain(text);
    expect(fs.existsSync(path.join(f.output, 'argv'))).toBe(false);
  }
}, 30000);

test('unsupported expectations and a different status directory refuse before launch', async () => {
  const f = fixture();
  const configPath = path.join(f.remi, 'config.toml');
  const config = fs.readFileSync(configPath, 'utf8');
  fs.writeFileSync(configPath, config.replace('expects="subscription"', 'expects="future_kind"'));
  let proc = await spawnWrapper(f, ['--remi-profile', 'work']);
  expect(await proc.exited).not.toBe(0);
  expect(await new Response(proc.stderr).text()).toContain(
    'Profile work expects future_kind, which this build does not support.',
  );
  expect(fs.existsSync(path.join(f.output, 'argv'))).toBe(false);
  fs.writeFileSync(configPath, config);
  fs.writeFileSync(path.join(f.profile, 'config-mismatch'), '');
  proc = await spawnWrapper(f, ['--remi-profile', 'work']);
  expect(await proc.exited).not.toBe(0);
  expect(await new Response(proc.stderr).text()).toContain(
    "This profile's login is not what will be used (configDirectory).",
  );
  expect(fs.existsSync(path.join(f.output, 'argv'))).toBe(false);
}, 30000);

test('a broken profile table refuses selections and leaves an unrelated default launch usable', async () => {
  const f = fixture();
  const configPath = path.join(f.remi, 'config.toml');
  const config = fs.readFileSync(configPath, 'utf8');
  fs.writeFileSync(
    configPath,
    config.replace('label="Work"', 'label="Work"\nenv={AWS_PROFILE="configured"}'),
  );
  for (const args of [['--remi-profile', 'work'], []]) {
    const proc = await spawnWrapper(f, args);
    expect(await proc.exited).not.toBe(0);
    const output = await new Response(proc.stderr).text();
    expect(output).toContain('profiles.work.env.AWS_PROFILE');
    expect(output).not.toContain('configured');
    expect(fs.existsSync(path.join(f.output, 'argv'))).toBe(false);
  }
  const elsewhere = path.join(f.home, 'elsewhere');
  fs.mkdirSync(elsewhere);
  const plain = await spawnDaemon(f.home, elsewhere, f.env);
  running.push({ ...plain, home: f.home, work: f.work });
  await pollUntil(
    () => fs.existsSync(path.join(f.output, 'argv')) || plain.proc.exitCode !== null,
    15000,
    'default after broken table',
  );
  expect(plain.proc.exitCode).toBeNull();
  fs.writeFileSync(path.join(f.output, 'release'), '');
  expect(await plain.proc.exited).toBe(0);
  const output = await new Response(plain.proc.stderr).text();
  expect(output.split('Profiles are disabled by a configuration error').length - 1).toBe(1);
}, 30000);

test('duplicate profile directories refuse launch while a distinct symlink stays spelled as configured', async () => {
  const f = fixture();
  const configPath = path.join(f.remi, 'config.toml');
  const config = fs.readFileSync(configPath, 'utf8');
  fs.appendFileSync(
    configPath,
    `[profiles.duplicate]\nlabel="Duplicate"\n[profiles.duplicate.claude]\ndir=${JSON.stringify(f.profile)}\nexpects="subscription"\n`,
  );
  const refused = await spawnWrapper(f, ['--remi-profile', 'work']);
  expect(await refused.exited).not.toBe(0);
  expect(await new Response(refused.stderr).text()).toContain('uses the same directory');
  expect(fs.existsSync(path.join(f.output, 'argv'))).toBe(false);
  const alias = path.join(f.home, 'profile-alias');
  fs.symlinkSync(f.profile, alias);
  fs.writeFileSync(configPath, config.replace(JSON.stringify(f.profile), JSON.stringify(alias)));
  const started = await spawnWrapper(f, ['--remi-profile', 'work']);
  await pollUntil(
    () => fs.existsSync(path.join(f.output, 'argv')) || started.exitCode !== null,
    15000,
    'symlink profile launch',
  );
  expect(started.exitCode).toBeNull();
  expect(fs.readFileSync(path.join(f.output, 'dir'), 'utf8')).toBe(alias);
  fs.writeFileSync(path.join(f.output, 'release'), '');
  expect(await started.exited).toBe(0);
}, 30000);

test('remote explicit profile is refused before a connection', async () => {
  const f = fixture();
  const port = await reserveRange(1, 50, DEFAULT_CONFIG.daemon.bind);
  let connections = 0;
  const listener = Bun.listen({
    hostname: '127.0.0.1',
    port,
    socket: {
      open(socket) {
        connections++;
        socket.end();
      },
      data() {},
      error() {},
    },
  });
  try {
    const proc = await spawnWrapper(f, [
      'new',
      '--host',
      `127.0.0.1:${port}`,
      '--remi-profile',
      'work',
    ]);
    expect(await proc.exited).toBe(2);
    expect(await new Response(proc.stderr).text()).toContain(
      "Choosing a profile for a session on another machine is not supported yet. That machine's folder mapping or default profile applies; run the command without --remi-profile.",
    );
    expect(connections).toBe(0);
  } finally {
    listener.stop(true);
  }
}, 30000);

test('Codex provider conflicts and invalid configuration refuse before a probe or launch', async () => {
  for (const invalid of [false, true]) {
    const f = fixture();
    const dir = path.join(f.home, 'codex');
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(f.home, 'bin', 'codex'),
      '#!/bin/sh\ntouch "$FAKE_OUTPUT/invoked"\n',
      { mode: 0o700 },
    );
    fs.writeFileSync(
      path.join(dir, 'config.toml'),
      invalid ? '[bad' : '[model_providers.test]\nenv_key="MY_PROVIDER_KEY"\n',
    );
    fs.appendFileSync(
      path.join(f.remi, 'config.toml'),
      `[profiles.code]\nlabel="Code"\n${invalid ? '' : 'env={MY_PROVIDER_KEY="configured"}\n'}[profiles.code.codex]\ndir=${JSON.stringify(dir)}\nexpects="subscription"\n`,
    );
    const proc = await spawnWrapper(f, ['--harness', 'codex', '--remi-profile', 'code']);
    expect(await proc.exited).not.toBe(0);
    const error = await new Response(proc.stderr).text();
    expect(error).toContain(
      invalid
        ? 'Could not read the Codex configuration of profile code (config.toml).'
        : 'Profile code sets MY_PROVIDER_KEY, which its Codex configuration reads as a credential; remi does not store credentials.',
    );
    expect(error).not.toContain('planted-value');
    expect(fs.existsSync(path.join(f.output, 'invoked'))).toBe(false);
  }
}, 30000);

test('an unreadable Codex resume store refuses before a child starts', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.remi, 'sessions.json'), 'invalid JSON');
  const started = await spawnDaemon(f.home, f.work, f.env, [
    '--harness',
    'codex',
    '--',
    'resume',
    '01950000-0000-7000-8000-0000000000aa',
  ]);
  running.push({ ...started, home: f.home, work: f.work });
  expect(await started.proc.exited).toBe(78);
  expect(await new Response(started.proc.stderr).text()).toContain('not valid JSON');
  expect(fs.existsSync(path.join(f.output, 'argv'))).toBe(false);
}, 30000);

test('concurrent launches preserve both sidecar entries', async () => {
  const f = fixture();
  const secondOutput = path.join(f.home, 'second-output');
  fs.mkdirSync(secondOutput);
  const one = await spawnDaemon(f.home, f.work, f.env, ['--remi-profile', 'work']);
  const two = await spawnDaemon(f.home, f.work, { ...f.env, FAKE_OUTPUT: secondOutput }, [
    '--remi-profile',
    'work',
  ]);
  running.push({ ...one, home: f.home, work: f.work }, { ...two, home: f.home, work: f.work });
  await pollUntil(
    () =>
      fs.existsSync(path.join(f.output, 'argv')) && fs.existsSync(path.join(secondOutput, 'argv')),
    15000,
    'both profile agents',
  );
  const records = JSON.parse(fs.readFileSync(path.join(f.remi, 'sessions.json'), 'utf8'))
    .sessions as Array<{
    remiSessionId: string;
    profile: string;
    profileSnapshot: { revision: string };
  }>;
  const sidecar = JSON.parse(
    fs.readFileSync(path.join(f.remi, 'session-profiles.json'), 'utf8'),
  ).sessions;
  expect(records).toHaveLength(2);
  for (const record of records)
    expect(sidecar[record.remiSessionId]).toEqual({
      profile: 'work',
      revision: record.profileSnapshot.revision,
    });
  fs.writeFileSync(path.join(f.output, 'release'), '');
  fs.writeFileSync(path.join(secondOutput, 'release'), '');
  await Promise.all([one.proc.exited, two.proc.exited]);
}, 30000);

test('Codex uses the selected socket and scrubs provider names from probe and launch', async () => {
  const f = fixture();
  const server = FakeAppServer.start();
  servers.push(server);
  fs.writeFileSync(
    path.join(server.codexHome, 'config.toml'),
    `[model_providers.test]\nenv_key = "MY_PROVIDER_KEY"\nenv_http_headers = { "X-Org" = "MY_ORG_HEADER" }\n`,
  );
  fs.appendFileSync(
    path.join(f.remi, 'config.toml'),
    `[profiles.code]\nlabel="Code"\nharness="codex"\n[profiles.code.codex]\ndir=${JSON.stringify(server.codexHome)}\nexpects="subscription"\n`,
  );
  fs.writeFileSync(
    path.join(f.home, 'bin', 'codex'),
    `#!/bin/sh
if [ "$1 $2" = 'login status' ]; then
  printf '%s\\n' status >> "$FAKE_OUTPUT/probe-calls"
  env | cut -d= -f1 | sort > "$FAKE_OUTPUT/probe-names"
  exit 0
fi
printf '%s' "$CODEX_HOME" > "$FAKE_OUTPUT/codex-home"
env | cut -d= -f1 | sort > "$FAKE_OUTPUT/codex-names"
printf '%s\\n' "$@" > "$FAKE_OUTPUT/codex-argv"
i=0
while [ ! -e "$FAKE_OUTPUT/release" ] && [ "$i" -lt 600 ]; do sleep 0.1; i=$((i + 1)); done
`,
    { mode: 0o700 },
  );
  const started = await spawnDaemon(
    f.home,
    f.work,
    { ...f.env, MY_PROVIDER_KEY: 'planted-value', MY_ORG_HEADER: 'planted-value' },
    ['--harness', 'codex', '--remi-profile', 'code'],
  );
  running.push({ ...started, home: f.home, work: f.work });
  await pollUntil(
    () => fs.existsSync(path.join(f.output, 'codex-argv')) || started.proc.exitCode !== null,
    15000,
    'Codex launch',
  );
  expect(started.proc.exitCode).toBeNull();
  expect(fs.readFileSync(path.join(f.output, 'codex-home'), 'utf8')).toBe(server.codexHome);
  await pollUntil(
    () => server.received.some(({ frame }) => frame['method'] === 'initialize'),
    10000,
    'profile app-server connection',
  );
  for (const file of ['probe-names', 'codex-names']) {
    const names = fs.readFileSync(path.join(f.output, file), 'utf8').split('\n');
    for (const name of [...PROFILE_CREDENTIAL_ENV, 'MY_PROVIDER_KEY', 'MY_ORG_HEADER'])
      expect(names).not.toContain(name);
  }
  fs.writeFileSync(path.join(f.output, 'release'), '');
  expect(await started.proc.exited).toBe(0);
  const startOutput =
    (await new Response(started.proc.stdout).text()) +
    (await new Response(started.proc.stderr).text());
  expect(startOutput).not.toContain('planted-value');
  for (const item of fs.readdirSync(f.home, { recursive: true })) {
    const file = path.join(f.home, String(item));
    const stat = fs.lstatSync(file);
    if (stat.isFile()) expect(fs.readFileSync(file, 'utf8')).not.toContain('planted-value');
  }
  fs.rmSync(path.join(f.output, 'release'));
  fs.rmSync(path.join(f.output, 'codex-argv'));
  const automatic = await spawnWrapper(f, ['--remi-profile', 'code']);
  await pollUntil(
    () => fs.existsSync(path.join(f.output, 'codex-argv')) || automatic.exitCode !== null,
    15000,
    'profile default harness',
  );
  expect(automatic.exitCode).toBeNull();
  expect(fs.readFileSync(path.join(f.output, 'codex-home'), 'utf8')).toBe(server.codexHome);
  fs.writeFileSync(path.join(f.output, 'release'), '');
  expect(await automatic.exited).toBe(0);
  const thread = '01950000-0000-7000-8000-0000000000aa';
  server.createRollout(thread);
  const sessionsPath = path.join(f.remi, 'sessions.json');
  const sessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
  sessions.sessions[0].harnessSessionId = thread;
  fs.writeFileSync(sessionsPath, JSON.stringify(sessions));
  for (const daemon of [false, true]) {
    if (daemon)
      fs.writeFileSync(
        path.join(server.codexHome, 'config.toml'),
        `cli_auth_credentials_store = "keyring"\n[model_providers.test]\nenv_key = "MY_PROVIDER_KEY"\nenv_http_headers = { "X-Org" = "MY_ORG_HEADER" }\n`,
      );
    fs.rmSync(path.join(f.output, 'release'));
    fs.rmSync(path.join(f.output, 'codex-argv'));
    const launched = daemon
      ? await spawnDaemon(f.home, f.work, f.env, ['--harness', 'codex', '--', 'resume', thread])
      : { proc: await spawnWrapper(f, ['codex', 'resume', thread]), port: 0 };
    if (daemon) running.push({ ...launched, home: f.home, work: f.work });
    await pollUntil(
      () => fs.existsSync(path.join(f.output, 'codex-argv')) || launched.proc.exitCode !== null,
      15000,
      'Codex resume',
    );
    expect(launched.proc.exitCode).toBeNull();
    expect(fs.readFileSync(path.join(f.output, 'codex-home'), 'utf8')).toBe(server.codexHome);
    expect(fs.readFileSync(path.join(f.output, 'codex-argv'), 'utf8')).toContain(
      `resume\n${thread}`,
    );
    fs.writeFileSync(path.join(f.output, 'release'), '');
    expect(await launched.proc.exited).toBe(0);
  }
  expect(fs.readFileSync(path.join(f.output, 'probe-calls'), 'utf8').trim().split('\n')).toEqual([
    'status',
    'status',
    'status',
    'status',
  ]);
  const listing = Bun.spawn([process.execPath, CLI_TS, '--sessions', 'all'], {
    cwd: f.work,
    env: isolatedEnv(f.home, f.env),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(await listing.exited).toBe(0);
  expect(await new Response(listing.stdout).text()).toContain(
    `remi codex --remi-profile code resume ${thread}`,
  );
  fs.rmSync(path.join(server.codexHome, 'config.toml'));
  fs.rmSync(path.join(f.output, 'release'));
  fs.rmSync(path.join(f.output, 'codex-argv'));
  const defaultStore = await spawnWrapper(f, ['--remi-profile', 'code']);
  await pollUntil(
    () => fs.existsSync(path.join(f.output, 'codex-argv')) || defaultStore.exitCode !== null,
    15000,
    'Codex default store',
  );
  expect(defaultStore.exitCode).toBeNull();
  fs.writeFileSync(path.join(f.output, 'release'), '');
  expect(await defaultStore.exited).toBe(0);
  expect(
    fs.readFileSync(path.join(f.output, 'probe-calls'), 'utf8').trim().split('\n'),
  ).toHaveLength(5);
}, 45000);

test('hub resumes the recorded profile and reports a refused child', async () => {
  const f = fixture();
  const workConfig = path.join(f.remi, 'config.toml');
  fs.writeFileSync(
    workConfig,
    fs
      .readFileSync(workConfig, 'utf8')
      .replace('label="Work"', 'label="Work"\nargs=["--model", "profile-model"]'),
  );
  const other = path.join(f.home, 'other');
  const otherWork = path.join(f.home, 'other-work');
  fs.mkdirSync(other);
  fs.mkdirSync(otherWork);
  const codexOnlyWork = path.join(f.home, 'codex-only-work');
  const bothWork = path.join(f.home, 'both-work');
  const bothClaude = path.join(f.home, 'both-claude');
  for (const dir of [codexOnlyWork, bothWork, bothClaude]) fs.mkdirSync(dir);
  fs.appendFileSync(
    path.join(f.remi, 'config.toml'),
    `[profiles.other]\nlabel="Other"\nfolders=[${JSON.stringify(otherWork)}]\n[profiles.other.claude]\ndir=${JSON.stringify(other)}\nexpects="subscription"\n[profiles.codeonly]\nlabel="Code"\nharness="codex"\nfolders=[${JSON.stringify(codexOnlyWork)}]\n[profiles.codeonly.codex]\ndir=${JSON.stringify(path.join(f.home, 'code-only-home'))}\nexpects="subscription"\n[profiles.both]\nlabel="Both"\nharness="codex"\nfolders=[${JSON.stringify(bothWork)}]\n[profiles.both.claude]\ndir=${JSON.stringify(bothClaude)}\nexpects="subscription"\n[profiles.both.codex]\ndir=${JSON.stringify(path.join(f.home, 'both-codex'))}\nexpects="subscription"\n`,
  );
  fs.symlinkSync(process.execPath, path.join(f.home, 'bin', 'bun'));
  let port = await reserveRange(20, 50, DEFAULT_CONFIG.daemon.bind);
  let hub = await spawnHub(
    { home: f.home, work: f.work },
    { ...f.env, REMI_PORT: String(port) },
    CLI_TS,
    port,
  );
  running.push(hub as (typeof running)[number]);
  const ask = async (
    request:
      | ReturnType<typeof createCreateSessionRequest>
      | ReturnType<typeof createResumeSessionRequest>,
  ) => {
    const { ws, received } = await connectAndHello(port);
    try {
      ws.send(serialize(request));
      await pollUntil(
        () =>
          received.some(
            (msg) =>
              (msg.type === 'create_session_response' || msg.type === 'resume_session_response') &&
              msg.requestId === request.id,
          ),
        20000,
        'hub response',
      );
      return received.find(
        (msg) =>
          (msg.type === 'create_session_response' || msg.type === 'resume_session_response') &&
          msg.requestId === request.id,
      ) as { success: boolean; error?: string; sessionId?: string };
    } finally {
      ws.close();
    }
  };
  const records = () =>
    JSON.parse(fs.readFileSync(path.join(f.remi, 'sessions.json'), 'utf8')).sessions as Array<{
      remiSessionId: string;
      claudeSessionId: string;
      exitedAt: string | null;
      profile?: string;
      profileSnapshot?: { revision: string };
    }>;
  const release = async (id: string) => {
    fs.writeFileSync(path.join(f.output, 'release'), '');
    await pollUntil(
      () => records().some((s) => s.remiSessionId === id && s.exitedAt !== null),
      15000,
      'child exit',
    );
    fs.rmSync(path.join(f.output, 'release'));
    fs.rmSync(path.join(f.output, 'argv'));
  };
  try {
    const first = await ask(
      createCreateSessionRequest(f.work, { args: ['--model', 'user-model'] }),
    );
    expect(first.success).toBe(true);
    await pollUntil(() => fs.existsSync(path.join(f.output, 'argv')), 15000, 'first profile child');
    expect(fs.readFileSync(path.join(f.output, 'argv'), 'utf8')).toContain(
      '--model\nprofile-model\n--model\nuser-model',
    );
    expect(fs.readFileSync(path.join(f.output, 'dir'), 'utf8')).toBe(f.profile);
    const original = records().find((s) => s.remiSessionId === first.sessionId);
    expect(original?.profile).toBe('work');
    const sidecar = JSON.parse(fs.readFileSync(path.join(f.remi, 'session-profiles.json'), 'utf8'));
    expect(sidecar.sessions[first.sessionId as string]).toEqual({
      profile: 'work',
      revision: original?.profileSnapshot?.revision,
    });
    await release(first.sessionId as string);
    const configPath = path.join(f.remi, 'config.toml');
    const config = fs.readFileSync(configPath, 'utf8');
    fs.writeFileSync(
      configPath,
      `[profiles]\ndefault="other"\n${config.replace(`folders=[${JSON.stringify(f.work)}]\n`, '')}`,
    );
    const resumed = await ask(createResumeSessionRequest(first.sessionId as string));
    expect(resumed.success).toBe(true);
    await pollUntil(() => fs.existsSync(path.join(f.output, 'argv')), 15000, 'resumed child');
    const resumedDir = fs.readFileSync(path.join(f.output, 'dir'), 'utf8');
    expect(fs.readFileSync(path.join(f.output, 'argv'), 'utf8')).toContain(
      `--resume\n${original?.claudeSessionId}`,
    );
    await release(resumed.sessionId as string);
    const byArgs = await ask(
      createCreateSessionRequest(otherWork, {
        args: ['--resume', original?.claudeSessionId as string],
      }),
    );
    expect(byArgs.success).toBe(true);
    await pollUntil(
      () => fs.existsSync(path.join(f.output, 'argv')),
      15000,
      'resume from other folder',
    );
    const byArgsDir = fs.readFileSync(path.join(f.output, 'dir'), 'utf8');
    await release(byArgs.sessionId as string);
    expect([resumedDir, byArgsDir]).toEqual([f.profile, f.profile]);
    fs.writeFileSync(configPath, config);
    const unmapped = path.join(f.home, 'unmapped');
    fs.mkdirSync(unmapped);
    const plain = await ask(createCreateSessionRequest(unmapped));
    expect(plain.success).toBe(true);
    await pollUntil(
      () => fs.existsSync(path.join(f.output, 'argv')),
      15000,
      'default profile child',
    );
    await release(plain.sessionId as string);
    const recordsPath = path.join(f.remi, 'sessions.json');
    const rawRecords = JSON.parse(fs.readFileSync(recordsPath, 'utf8'));
    const plainRecord = rawRecords.sessions.find(
      (s: { remiSessionId: string }) => s.remiSessionId === plain.sessionId,
    );
    expect(plainRecord.profile).toBeUndefined();
    plainRecord.projectPath = f.work;
    fs.writeFileSync(recordsPath, JSON.stringify(rawRecords));
    const plainResume = await ask(createResumeSessionRequest(plain.sessionId as string));
    expect(plainResume.success).toBe(true);
    await pollUntil(
      () => fs.existsSync(path.join(f.output, 'argv')),
      15000,
      'default profile resume',
    );
    expect(fs.readFileSync(path.join(f.output, 'dir'), 'utf8')).toBe(
      path.join(f.home, 'inherited-claude'),
    );
    await release(plainResume.sessionId as string);
    const remote = await spawnWrapper(
      f,
      ['new', '--host', '127.0.0.1', '--port', String(port), '--dir', f.work],
      {
        REMI_PROFILE: 'other',
      },
    );
    await pollUntil(
      () => fs.existsSync(path.join(f.output, 'argv')) || remote.exitCode !== null,
      15000,
      'remote child',
    );
    if (remote.exitCode !== null) throw new Error(await new Response(remote.stderr).text());
    expect(remote.exitCode).toBeNull();
    expect(fs.readFileSync(path.join(f.output, 'dir'), 'utf8')).toBe(f.profile);
    const remoteRecord = records().find((s) => s.exitedAt === null);
    expect(remoteRecord).toBeDefined();
    await release(remoteRecord?.remiSessionId as string);
    const remoteExit = await Promise.race([remote.exited, Bun.sleep(5000).then(() => null)]);
    if (remoteExit === null) remote.kill('SIGKILL');
    expect(remoteExit).not.toBeNull();
    const remoteText = await new Response(remote.stderr).text();
    expect(remoteText.split('REMI_PROFILE applies to this machine only;').length - 1).toBe(1);
    const omitted = await ask(createCreateSessionRequest(bothWork));
    expect(omitted.success).toBe(true);
    await pollUntil(
      () => fs.existsSync(path.join(f.output, 'argv')),
      15000,
      'omitted harness child',
    );
    expect(fs.readFileSync(path.join(f.output, 'dir'), 'utf8')).toBe(bothClaude);
    await release(omitted.sessionId as string);
    const codexOnly = await ask(createCreateSessionRequest(codexOnlyWork));
    expect(codexOnly.success).toBe(false);
    expect(fs.existsSync(path.join(f.output, 'argv'))).toBe(false);
    fs.writeFileSync(path.join(f.profile, 'signed-out'), '');
    const refused = await ask(createCreateSessionRequest(f.work));
    expect(refused.success).toBe(false);
    expect(refused).not.toHaveProperty('errorCode');
    expect(fs.existsSync(path.join(f.output, 'argv'))).toBe(false);
    fs.rmSync(path.join(f.profile, 'signed-out'));
    hub.proc.kill('SIGKILL');
    await hub.proc.exited;
    port = await reserveRange(20, 50, DEFAULT_CONFIG.daemon.bind);
    hub = await spawnHub(
      { home: f.home, work: f.work },
      { ...f.env, REMI_PORT: String(port), REMI_PROFILE: 'other' },
      CLI_TS,
      port,
    );
    running.push(hub as (typeof running)[number]);
    const inherited = await ask(createResumeSessionRequest(first.sessionId as string));
    expect(inherited.success).toBe(true);
    await pollUntil(
      () => fs.existsSync(path.join(f.output, 'argv')),
      15000,
      'resume with inherited hub profile',
    );
    expect(fs.readFileSync(path.join(f.output, 'dir'), 'utf8')).toBe(f.profile);
    await release(inherited.sessionId as string);
    hub.proc.kill('SIGKILL');
    await hub.proc.exited;
    fs.writeFileSync(
      path.join(f.remi, 'config.toml'),
      `[profiles.other]\nlabel="Other"\nfolders=[${JSON.stringify(otherWork)}]\n[profiles.other.claude]\ndir=${JSON.stringify(other)}\nexpects="subscription"\n`,
    );
    port = await reserveRange(20, 50, DEFAULT_CONFIG.daemon.bind);
    hub = await spawnHub(
      { home: f.home, work: f.work },
      { ...f.env, REMI_PORT: String(port) },
      CLI_TS,
      port,
    );
    running.push(hub as (typeof running)[number]);
    const removed = await ask(createResumeSessionRequest(first.sessionId as string));
    expect(removed.success).toBe(false);
    expect(fs.existsSync(path.join(f.output, 'argv'))).toBe(false);
    const expectedRefusal =
      "The session's profile could not start. Run remi profile ls on the machine.";
    expect([codexOnly.error, refused.error, removed.error]).toEqual([
      expectedRefusal,
      expectedRefusal,
      expectedRefusal,
    ]);
  } finally {
    fs.writeFileSync(path.join(f.output, 'release'), '');
  }
}, 90000);

test('wrapper resumes use the recorded profile and detect older writers', async () => {
  const f = fixture();
  const otherWork = path.join(f.home, 'other-work');
  const otherProfile = path.join(f.home, 'other-profile');
  fs.mkdirSync(otherWork);
  fs.mkdirSync(otherProfile);
  fs.appendFileSync(
    path.join(f.remi, 'config.toml'),
    `[profiles.other]\nlabel="Other"\nfolders=[${JSON.stringify(otherWork)}]\n[profiles.other.claude]\ndir=${JSON.stringify(otherProfile)}\nexpects="subscription"\n`,
  );
  const first = await spawnDaemon(f.home, otherWork, f.env, ['--remi-profile', 'work']);
  running.push({ ...first, home: f.home, work: f.work });
  await pollUntil(() => fs.existsSync(path.join(f.output, 'argv')), 15000, 'first agent');
  fs.writeFileSync(path.join(f.output, 'release'), '');
  expect(await first.proc.exited).toBe(0);
  const records = JSON.parse(fs.readFileSync(path.join(f.remi, 'sessions.json'), 'utf8')).sessions;
  const initial = records[0];
  const wrapper = async (args: string[], extra: Record<string, string> = {}) => {
    fs.rmSync(path.join(f.output, 'release'), { force: true });
    fs.rmSync(path.join(f.output, 'argv'), { force: true });
    const port = await reserveRange(1, 50, DEFAULT_CONFIG.daemon.bind);
    const proc = Bun.spawn(
      [
        process.execPath,
        CLI_TS,
        '--port',
        String(port),
        '--no-relay',
        '--no-telegram',
        '--no-mdns',
        '--no-auth',
        ...args,
      ],
      {
        cwd: otherWork,
        env: isolatedEnv(f.home, { ...f.env, ...extra }),
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    running.push({ proc, port, home: f.home, work: f.work });
    return proc;
  };
  for (const args of [
    ['--resume'],
    ['--resume', initial.remiSessionId.slice(0, 8)],
    ['--', '--resume', initial.claudeSessionId],
  ]) {
    const proc = await wrapper(args);
    await pollUntil(
      () => fs.existsSync(path.join(f.output, 'argv')) || proc.exitCode !== null,
      15000,
      'wrapper resume',
    );
    expect(proc.exitCode).toBeNull();
    expect(fs.readFileSync(path.join(f.output, 'dir'), 'utf8')).toBe(f.profile);
    expect(fs.readFileSync(path.join(f.output, 'argv'), 'utf8')).toContain(
      `--resume\n${initial.claudeSessionId}`,
    );
    fs.writeFileSync(path.join(f.output, 'release'), '');
    expect(await proc.exited).toBe(0);
  }
  const conflict = await wrapper(['--resume'], { REMI_PROFILE: 'other' });
  expect(await conflict.exited).not.toBe(0);
  expect(await new Response(conflict.stderr).text()).toContain(
    'This session belongs to profile work. Resume it without --remi-profile, or with --remi-profile work.',
  );
  expect(fs.existsSync(path.join(f.output, 'argv'))).toBe(false);
  const flagConflict = await wrapper(['--resume', '--remi-profile', 'other']);
  expect(await flagConflict.exited).not.toBe(0);
  expect(await new Response(flagConflict.stderr).text()).toContain(
    'This session belongs to profile work. Resume it without --remi-profile, or with --remi-profile work.',
  );
  expect(fs.existsSync(path.join(f.output, 'argv'))).toBe(false);
  const file = path.join(f.remi, 'sessions.json');
  const sessions = JSON.parse(fs.readFileSync(file, 'utf8'));
  const latest = sessions.sessions.sort((a: { startedAt: string }, b: { startedAt: string }) =>
    b.startedAt.localeCompare(a.startedAt),
  )[0];
  const sidecarPath = path.join(f.remi, 'session-profiles.json');
  const sidecarRaw = fs.readFileSync(sidecarPath, 'utf8');
  for (const [key, value] of [
    ['profile', 'other'],
    ['revision', 'different-revision'],
  ]) {
    const changedSidecar = JSON.parse(sidecarRaw);
    changedSidecar.sessions[latest.remiSessionId][key as string] = value;
    fs.writeFileSync(sidecarPath, JSON.stringify(changedSidecar));
    const conflict = await wrapper(['--resume']);
    expect(await conflict.exited).not.toBe(0);
    expect(await new Response(conflict.stderr).text()).toContain(
      "This session's profile information was changed by another remi process. Start a new session.",
    );
    expect(fs.existsSync(path.join(f.output, 'argv'))).toBe(false);
  }
  const sidecar = JSON.parse(sidecarRaw);
  Reflect.deleteProperty(sidecar.sessions, latest.remiSessionId);
  fs.writeFileSync(sidecarPath, JSON.stringify(sidecar));
  const missingSidecar = await wrapper(['--resume']);
  expect(await missingSidecar.exited).not.toBe(0);
  expect(await new Response(missingSidecar.stderr).text()).toContain(
    "This session's profile information was changed by another remi process. Start a new session.",
  );
  expect(fs.existsSync(path.join(f.output, 'argv'))).toBe(false);
  fs.writeFileSync(sidecarPath, sidecarRaw);
  const configPath = path.join(f.remi, 'config.toml');
  const config = fs.readFileSync(configPath, 'utf8');
  fs.writeFileSync(
    configPath,
    config.replace('label="Work"', 'label="Work"\nargs=["--model", "test"]'),
  );
  const changed = await wrapper(['--resume']);
  expect(await changed.exited).not.toBe(0);
  expect(await new Response(changed.stderr).text()).toContain(
    'Profile work changed after this session started. Start a new session.',
  );
  expect(fs.existsSync(path.join(f.output, 'argv'))).toBe(false);
  fs.writeFileSync(configPath, config.slice(config.indexOf('[profiles.other]')));
  const removed = await wrapper(['--resume']);
  expect(await removed.exited).not.toBe(0);
  expect(await new Response(removed.stderr).text()).toContain(
    'This session was started in profile work, which no longer exists. Start a new session.',
  );
  expect(fs.existsSync(path.join(f.output, 'argv'))).toBe(false);
  fs.writeFileSync(configPath, config);
  Reflect.deleteProperty(latest, 'profile');
  Reflect.deleteProperty(latest, 'profileSnapshot');
  fs.writeFileSync(file, JSON.stringify(sessions));
  const refused = await wrapper(['--resume']);
  const refusedExit = await Promise.race([refused.exited, Bun.sleep(3000).then(() => null)]);
  if (refusedExit === null) refused.kill('SIGKILL');
  expect(refusedExit).not.toBeNull();
  expect(refusedExit).not.toBe(0);
  expect(await new Response(refused.stderr).text()).toContain(
    "This session's profile information was changed by another remi process. Start a new session.",
  );
  expect(fs.existsSync(path.join(f.output, 'argv'))).toBe(false);
  for (const args of [
    ['--', '--continue'],
    ['new', '--dir', otherWork],
  ]) {
    const proc = await wrapper(args);
    await pollUntil(
      () => fs.existsSync(path.join(f.output, 'argv')) || proc.exitCode !== null,
      15000,
      'new session in other folder',
    );
    expect(proc.exitCode).toBeNull();
    expect(fs.readFileSync(path.join(f.output, 'dir'), 'utf8')).toBe(otherProfile);
    fs.writeFileSync(path.join(f.output, 'release'), '');
    expect(await proc.exited).toBe(0);
  }
}, 45000);

for (const configured of [true, false]) {
  test(`session frames ${configured ? 'withhold profile paths' : 'retain default paths'}`, async () => {
    const f = fixture();
    const directory = configured ? f.profile : path.join(f.home, '.claude');
    const codexDirectory = path.join(f.home, 'profile-codex');
    if (configured) {
      fs.mkdirSync(codexDirectory);
      fs.appendFileSync(
        path.join(f.remi, 'config.toml'),
        `\n[profiles.work.codex]\ndir=${JSON.stringify(codexDirectory)}\nexpects="subscription"\n`,
      );
    }
    if (!configured) fs.writeFileSync(path.join(f.remi, 'config.toml'), '');
    const other = path.join(f.home, 'external-work');
    const projectDir = path.join(directory, 'projects', other.replace(/\//g, '-'));
    fs.mkdirSync(projectDir, { recursive: true });
    const externalId = '77777777-7777-4777-8777-777777777777';
    fs.writeFileSync(
      path.join(projectDir, `${externalId}.jsonl`),
      `${JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), sessionId: externalId, cwd: other, timestamp: new Date().toISOString(), message: { role: 'user', content: 'external' } })}\n`,
    );
    const started = await spawnDaemon(
      f.home,
      f.work,
      f.env,
      configured ? ['--remi-profile', 'work'] : [],
    );
    running.push({ ...started, home: f.home, work: f.work });
    await pollUntil(() => fs.existsSync(path.join(f.output, 'argv')), 15000, 'agent started');
    const { ws, received, raw } = await connectAndHelloRaw(started.port);
    try {
      const request = createSessionListRequest(true);
      ws.send(serialize(request));
      await pollUntil(
        () =>
          received.some(
            (message) =>
              message.type === 'session_list_response' && message.requestId === request.id,
          ),
        10000,
        'session list',
      );
      const hello = received.find((message) => message.type === 'hello_ack');
      const list = received.find(
        (message) => message.type === 'session_list_response' && message.requestId === request.id,
      );
      if (hello?.type !== 'hello_ack' || list?.type !== 'session_list_response')
        throw new Error('missing response');
      const external = list.sessions.find(
        (session) => session.claudeSessionId === externalId || session.sessionId === externalId,
      );
      const own = list.sessions.find((session) => session.sessionId !== externalId);
      expect(external).toBeDefined();
      expect(own).toBeDefined();
      if (configured) {
        expect(hello.transcriptPath).toBeNull();
        expect(Object.hasOwn(own as object, 'transcriptPath')).toBe(false);
        expect(Object.hasOwn(external as object, 'transcriptPath')).toBe(false);
        expect(raw.join('\n')).not.toContain(f.profile);
        expect(raw.join('\n')).not.toContain(codexDirectory);
      } else {
        expect(hello.transcriptPath).toContain(directory);
        expect(own?.transcriptPath).toContain(directory);
        expect(external?.transcriptPath).toContain(directory);
      }
    } finally {
      ws.close();
      fs.writeFileSync(path.join(f.output, 'release'), '');
    }
  }, 30000);
}

/** A profile daemon whose work directory is a git repository, with one external transcript on disk. */
async function startFrameDaemon(configured: boolean) {
  const f = fixture();
  const directory = configured ? f.profile : path.join(f.home, '.claude');
  if (!configured) fs.writeFileSync(path.join(f.remi, 'config.toml'), '');
  const other = path.join(f.home, 'external-work');
  const projectDir = path.join(directory, 'projects', other.replace(/\//g, '-'));
  fs.mkdirSync(projectDir, { recursive: true });
  const externalId = '88888888-8888-4888-8888-888888888888';
  fs.writeFileSync(
    path.join(projectDir, `${externalId}.jsonl`),
    `${JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), sessionId: externalId, cwd: other, timestamp: new Date().toISOString(), message: { role: 'user', content: 'external' } })}\n`,
  );
  // A repository makes the first workspace read change the cached answer, which is what
  // makes the daemon push an unsolicited session list (WorkspaceCache.onChange).
  const init = Bun.spawnSync(['git', 'init', '--quiet', f.work], {
    env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin', HOME: f.home },
  });
  expect(init.exitCode).toBe(0);
  const started = await spawnDaemon(
    f.home,
    f.work,
    f.env,
    configured ? ['--remi-profile', 'work'] : [],
  );
  running.push({ ...started, home: f.home, work: f.work });
  await pollUntil(() => fs.existsSync(path.join(f.output, 'argv')), 15000, 'agent started');
  const client = await connectAndHelloRaw(started.port);
  return { f, directory, externalId, started, ...client };
}

for (const configured of [true, false]) {
  test(`unsolicited session lists ${configured ? 'withhold profile paths' : 'retain default paths'}`, async () => {
    const { f, directory, externalId, started, ws, received, raw } =
      await startFrameDaemon(configured);
    try {
      const requested = new Set<string>();
      const ask = () => {
        const request = createSessionListRequest(true);
        requested.add(request.id);
        ws.send(serialize(request));
        return request;
      };
      const first = ask();
      await pollUntil(
        () => received.some((m) => m.type === 'session_list_response' && m.requestId === first.id),
        10000,
        'the first session list',
      );
      // A changed workspace read is what pushes an unsolicited list (WorkspaceCache.onChange).
      // The read at session start may finish before this client connects, so change the branch and
      // ask again until the cache's 10 s lifetime lapses and the next read sees the change.
      const flip = Bun.spawnSync(
        ['git', '-C', f.work, 'symbolic-ref', 'HEAD', 'refs/heads/flipped'],
        {
          env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin', HOME: f.home },
        },
      );
      expect(flip.exitCode).toBe(0);
      const unsolicited = () =>
        received.filter(
          (m): m is SessionListResponseMessage =>
            m.type === 'session_list_response' && !requested.has(m.requestId),
        );
      const deadline = Date.now() + 25000;
      while (unsolicited().length === 0 && Date.now() < deadline) {
        ask();
        await Bun.sleep(1000);
      }
      const workspaceList = unsolicited()[0] as SessionListResponseMessage;
      expect(
        workspaceList.sessions.some(
          (s) => s.sessionId === externalId || s.claudeSessionId === externalId,
        ),
      ).toBe(true);
      // A sibling daemon registering is what the live-sessions census pushes a list for.
      const siblingPort = 49321;
      fs.writeFileSync(
        path.join(f.home, '.remi', 'live-sessions', 'sibling.json'),
        JSON.stringify({
          sessionId: crypto.randomUUID(),
          pid: process.pid,
          wsPort: siblingPort,
          hookPort: siblingPort + 1,
          projectPath: f.work,
          name: 'sibling',
          startedAt: new Date().toISOString(),
        }),
      );
      await pollUntil(
        () => unsolicited().some((m) => m.daemonPorts?.includes(siblingPort)),
        15000,
        'the live-sessions census session list',
      );
      const censusList = unsolicited().find((m) =>
        m.daemonPorts?.includes(siblingPort),
      ) as SessionListResponseMessage;
      for (const list of [workspaceList, censusList]) {
        const own = list.sessions.find(
          (s) =>
            s.sessionId !== externalId && s.claudeSessionId !== externalId && s.name !== 'sibling',
        );
        const external = list.sessions.find(
          (s) => s.sessionId === externalId || s.claudeSessionId === externalId,
        );
        expect(external).toBeDefined();
        if (configured) {
          for (const session of list.sessions)
            expect(Object.hasOwn(session, 'transcriptPath')).toBe(false);
        } else {
          expect(external?.transcriptPath).toContain(directory);
          expect(own?.transcriptPath).toContain(directory);
        }
      }
      if (configured) expect(raw.join('\n')).not.toContain(f.profile);
    } finally {
      ws.close();
      fs.writeFileSync(path.join(f.output, 'release'), '');
      await started.proc.exited;
    }
  }, 60000);
}

for (const configured of [true, false]) {
  test(`a rotated session ${configured ? 'withholds the profile transcript path' : 'announces the default transcript path'}`, async () => {
    const { f, directory, started, ws, received, raw } = await startFrameDaemon(configured);
    try {
      const claudeId = /--session-id\s+(\S+)/.exec(
        fs.readFileSync(path.join(f.output, 'argv'), 'utf8'),
      )?.[1];
      if (claudeId === undefined) throw new Error('no session id in the agent argv');
      const liveDir = path.join(f.home, '.remi', 'live-sessions');
      const own = fs
        .readdirSync(liveDir)
        .map(
          (name) =>
            JSON.parse(fs.readFileSync(path.join(liveDir, name), 'utf8')) as { hookPort: number },
        )
        .find((entry) => entry.hookPort > 0);
      if (own === undefined) throw new Error('the daemon wrote no live-sessions entry');
      const project = path.join(directory, 'projects', fs.realpathSync(f.work).replace(/\//g, '-'));
      fs.mkdirSync(project, { recursive: true });
      const post = async (
        sessionId: string,
        event: string,
        extra: Record<string, unknown> = {},
      ) => {
        const response = await fetch(`http://127.0.0.1:${own.hookPort}/hooks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            hook_event_name: event,
            session_id: sessionId,
            cwd: fs.realpathSync(f.work),
            permission_mode: 'default',
            transcript_path: path.join(project, `${sessionId}.jsonl`),
            ...extra,
          }),
        });
        await response.text();
      };
      // The agent's session locks, ends, and a new one starts in the same terminal: a restart.
      const nextId = crypto.randomUUID();
      for (const id of [claudeId, nextId]) fs.writeFileSync(path.join(project, `${id}.jsonl`), '');
      await post(claudeId, 'UserPromptSubmit', { prompt_id: crypto.randomUUID(), prompt: 'hi' });
      await post(claudeId, 'SessionEnd', { reason: 'clear' });
      await post(nextId, 'UserPromptSubmit', { prompt_id: crypto.randomUUID(), prompt: 'hi' });
      await pollUntil(
        () => received.some((m) => m.type === 'session_rotated'),
        10000,
        'the session_rotated frame',
      );
      const rotated = received.find((m) => m.type === 'session_rotated');
      if (rotated?.type !== 'session_rotated') throw new Error('no session_rotated');
      if (configured) {
        expect(Object.hasOwn(rotated, 'newTranscriptPath')).toBe(false);
        expect(raw.join('\n')).not.toContain(f.profile);
      } else {
        expect(rotated.newTranscriptPath).toContain(directory);
      }
    } finally {
      ws.close();
      fs.writeFileSync(path.join(f.output, 'release'), '');
      await started.proc.exited;
    }
  }, 45000);
}

test('a damaged sidecar refuses a configured launch before probing', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.remi, 'session-profiles.json'), 'not json');
  const proc = await spawnWrapper(f, ['--remi-profile', 'work']);
  expect(await proc.exited).not.toBe(0);
  expect(await new Response(proc.stderr).text()).toContain(
    `Could not read ${path.join(f.remi, 'session-profiles.json')}, which records session profiles; a profile session cannot start until it is repaired or moved aside.`,
  );
  expect(fs.existsSync(path.join(f.output, 'argv'))).toBe(false);
}, 25000);

test('ambiguous forwarded resume is refused before spawning in daemons and wrappers', async () => {
  for (const [daemon, configured] of [
    [true, false],
    [true, true],
    [false, false],
    [false, true],
  ] as const) {
    const f = fixture();
    if (!configured) fs.writeFileSync(path.join(f.remi, 'config.toml'), '');
    const claudeId = crypto.randomUUID();
    const records = [0, 1].map(() => ({
      remiSessionId: crypto.randomUUID(),
      claudeSessionId: claudeId,
      projectPath: f.work,
      port: 19200,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      exitedAt: null,
      exitCode: null,
    }));
    fs.writeFileSync(
      path.join(f.remi, 'sessions.json'),
      JSON.stringify({ version: 1, sessions: records }),
    );
    const started = daemon
      ? await spawnDaemon(f.home, f.work, f.env, ['--', '--resume', claudeId])
      : { proc: await spawnWrapper(f, ['--', '--resume', claudeId]), port: 0 };
    if (daemon) running.push({ ...started, home: f.home, work: f.work });
    expect(await started.proc.exited).toBe(daemon && configured ? 78 : 1);
    const stdout = await new Response(started.proc.stdout).text();
    const stderr = await new Response(started.proc.stderr).text();
    const logPath = path.join(f.remi, 'remi.log');
    const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
    expect(stdout + stderr + log).toContain(
      `Ambiguous Claude session ID ${claudeId.slice(0, 8)}: 2 records; refusing to choose one`,
    );
    expect(fs.existsSync(path.join(f.output, 'argv'))).toBe(false);
  }
}, 45000);

test('with profiles configured and Codex as the default, a profile-free top-level --resume is refused by the late branch', async () => {
  const f = fixture();
  fs.appendFileSync(path.join(f.remi, 'config.toml'), '\n[harness]\ndefault="codex"\n');
  const record = {
    remiSessionId: crypto.randomUUID(),
    claudeSessionId: crypto.randomUUID(),
    projectPath: f.work,
    port: 19200,
    pid: null,
    startedAt: new Date().toISOString(),
    exitedAt: new Date().toISOString(),
    exitCode: 0,
  };
  fs.writeFileSync(
    path.join(f.remi, 'sessions.json'),
    JSON.stringify({ version: 1, sessions: [record] }),
  );
  const proc = await spawnWrapper(f, ['--resume']);
  expect(await proc.exited).toBe(2);
  expect(await new Response(proc.stderr).text()).toContain(
    "--resume is remi's flag for Claude sessions",
  );
  expect(fs.existsSync(path.join(f.output, 'argv'))).toBe(false);
}, 25000);

test('Codex profile arguments precede session arguments in a daemon and a wrapper', async () => {
  const f = fixture();
  const server = FakeAppServer.start();
  servers.push(server);
  fs.appendFileSync(
    path.join(f.remi, 'config.toml'),
    `[profiles.code]\nlabel="Code"\nharness="codex"\nargs=["--model", "profile-model"]\n[profiles.code.codex]\ndir=${JSON.stringify(server.codexHome)}\nexpects="subscription"\n`,
  );
  fs.writeFileSync(
    path.join(f.home, 'bin', 'codex'),
    `#!/bin/sh
if [ "$1 $2" = 'login status' ]; then
  exit 0
fi
printf '%s\\n' "$@" > "$FAKE_OUTPUT/codex-argv"
i=0
while [ ! -e "$FAKE_OUTPUT/release" ] && [ "$i" -lt 600 ]; do sleep 0.1; i=$((i + 1)); done
`,
    { mode: 0o700 },
  );
  for (const daemon of [true, false]) {
    fs.rmSync(path.join(f.output, 'release'), { force: true });
    fs.rmSync(path.join(f.output, 'codex-argv'), { force: true });
    const launched = daemon
      ? await spawnDaemon(f.home, f.work, f.env, [
          '--harness',
          'codex',
          '--remi-profile',
          'code',
          '--',
          '--model',
          'user-model',
        ])
      : {
          proc: await spawnWrapper(f, ['--remi-profile', 'code', '--model', 'user-model']),
          port: 0,
        };
    if (daemon) running.push({ ...launched, home: f.home, work: f.work });
    await pollUntil(
      () => fs.existsSync(path.join(f.output, 'codex-argv')) || launched.proc.exitCode !== null,
      15000,
      'Codex profile argument launch',
    );
    expect(launched.proc.exitCode).toBeNull();
    expect(fs.readFileSync(path.join(f.output, 'codex-argv'), 'utf8')).toContain(
      '--model\nprofile-model\n--model\nuser-model',
    );
    fs.writeFileSync(path.join(f.output, 'release'), '');
    expect(await launched.proc.exited).toBe(0);
  }
}, 45000);

test('profile arguments precede session arguments in a wrapper', async () => {
  const f = fixture();
  const config = path.join(f.remi, 'config.toml');
  fs.writeFileSync(
    config,
    fs
      .readFileSync(config, 'utf8')
      .replace('label="Work"', 'label="Work"\nargs=["--model", "profile-model"]'),
  );
  const proc = await spawnWrapper(f, ['--remi-profile', 'work', '--', '--model', 'user-model']);
  await pollUntil(
    () => fs.existsSync(path.join(f.output, 'argv')) || proc.exitCode !== null,
    15000,
    'profile argument launch',
  );
  expect(fs.readFileSync(path.join(f.output, 'argv'), 'utf8')).toContain(
    '--model\nprofile-model\n--model\nuser-model',
  );
  fs.writeFileSync(path.join(f.output, 'release'), '');
  expect(await proc.exited).toBe(0);
}, 25000);
