import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runProfileCommand } from '../../src/profiles/cmd-profile.ts';
import { parseProfiles } from '../../src/profiles/profile-config.ts';

const cli = path.resolve(import.meta.dir, '../../src/cli.ts');
const bun = process.execPath;
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-commands-'));
  const bin = path.join(root, 'bin');
  const remi = path.join(root, 'remi');
  fs.mkdirSync(bin);
  fs.mkdirSync(remi);
  const log = path.join(root, 'invocations');
  const script = `#!/bin/sh\nprintf '%s\\n' "$*" >> "$FAKE_LOG"\ncase "$*" in\n  'auth status --json') printf '%s' '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"planted@example.com"}';;\nesac\n`;
  for (const name of ['claude', 'codex'])
    fs.writeFileSync(path.join(bin, name), script, { mode: 0o700 });
  const env = { HOME: root, REMI_HOME: remi, PATH: `${bin}:/usr/bin:/bin`, FAKE_LOG: log };
  const run = (...args: string[]) => {
    const result = Bun.spawnSync([bun, cli, 'profile', ...args], {
      cwd: root,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
  };
  return { root, bin, remi, log, run, config: path.join(remi, 'config.toml') };
}

test('real CLI appends safely and refuses without changing config bytes', () => {
  const f = fixture();
  try {
    const prefix = '# retained exactly\n[daemon]\nbind = "127.0.0.2"\n';
    fs.writeFileSync(f.config, prefix);
    expect(f.run('add', 'work', '--label', 'Work', '--claude', '--codex').code).toBe(0);
    const result = fs.readFileSync(f.config, 'utf8');
    expect(result.startsWith(prefix)).toBe(true);
    expect(result.match(/\[profiles\.work\]/g)).toHaveLength(1);
    for (const name of ['claude', 'codex'])
      expect(fs.statSync(path.join(f.remi, 'p', 'work', name)).mode & 0o777).toBe(0o700);
    const digest = () => createHash('sha256').update(fs.readFileSync(f.config)).digest('hex');
    const before = digest();
    for (const args of [
      ['bad', '--label', 'a@b.com', '--claude'],
      ['work', '--label', 'Other', '--claude'],
      ['missing', '--label', 'Missing', '--claude-dir', path.join(f.root, 'absent')],
    ]) {
      expect(f.run('add', ...args).code).toBe(1);
      expect(digest()).toBe(before);
    }
    const occupied = path.join(f.remi, 'p', 'occupied', 'claude');
    fs.mkdirSync(occupied, { recursive: true });
    fs.writeFileSync(path.join(occupied, 'data'), 'fixture');
    expect(f.run('add', 'occupied', '--label', 'Occupied', '--claude').err).toContain(
      'already exists and is not empty',
    );
    expect(digest()).toBe(before);
    expect(f.run('show', 'work').out).toContain('label: Work');
    expect(f.run('login', 'work', '--harness', 'claude').err).toContain('own terminal');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('real CLI refuses a 33rd profile without modifying the file', () => {
  const f = fixture();
  try {
    const config = Array.from(
      { length: 32 },
      (_, i) => `[profiles.p${i}]\nlabel="Work"\n[profiles.p${i}.claude]\nexpects="subscription"\n`,
    ).join('');
    fs.writeFileSync(f.config, config);
    const digest = () => createHash('sha256').update(fs.readFileSync(f.config)).digest('hex');
    const before = digest();
    expect(f.run('add', 'extra', '--label', 'Extra', '--claude').code).toBe(1);
    expect(digest()).toBe(before);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('real CLI reports states without identity or environment values', () => {
  const f = fixture();
  try {
    const script = `#!/bin/sh\ncase "$CLAUDE_CONFIG_DIR" in\n  */signed) printf '%s' '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"planted@example.com"}';;\n  */out) printf '%s' '{"loggedIn":false}';;\n  */other) printf '%s' '{"loggedIn":true,"authMethod":"api_key","apiKeySource":"apiKeyHelper","email":"planted@example.com"}';;\n  *) printf 'invalid';;\nesac\n`;
    fs.writeFileSync(path.join(f.bin, 'claude'), script, { mode: 0o700 });
    for (const name of ['signed', 'out', 'other', 'unknown']) fs.mkdirSync(path.join(f.root, name));
    const config = ['signed', 'out', 'other', 'unknown']
      .map(
        (name) =>
          `[profiles.${name}]\nlabel="${name}"\nenv={AWS_PROFILE="planted-value"}\n[profiles.${name}.claude]\ndir=${JSON.stringify(path.join(f.root, name))}\nexpects="subscription"\n`,
      )
      .join('');
    fs.writeFileSync(f.config, config);
    const listing = f.run('ls');
    expect(listing.code).toBe(0);
    expect(listing.out.startsWith('default (built-in):')).toBe(true);
    for (const state of [
      'signed in',
      'signed out',
      'not its own sign-in (apiKeyHelper)',
      'unknown (error)',
    ])
      expect(listing.out).toContain(state);
    const show = f.run('show', 'signed');
    expect(show.out).toContain('AWS_PROFILE');
    for (const output of [listing.out, listing.err, show.out, show.err]) {
      expect(output).not.toContain('planted@example.com');
      expect(output).not.toContain('planted-value');
    }
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('real CLI does not invoke Codex without an explicit file store', () => {
  const f = fixture();
  try {
    const codexDir = path.join(f.root, 'codex');
    fs.mkdirSync(codexDir);
    fs.writeFileSync(
      f.config,
      `[profiles.work]\nlabel="Work"\n[profiles.work.codex]\ndir=${JSON.stringify(codexDir)}\nexpects="subscription"\n`,
    );
    for (const store of [undefined, 'keyring']) {
      if (store)
        fs.writeFileSync(
          path.join(codexDir, 'config.toml'),
          `cli_auth_credentials_store = "${store}"\n`,
        );
      expect(f.run('ls').out).toContain('codex: unknown (not_checked)');
      expect(fs.existsSync(f.log)).toBe(false);
    }
    fs.writeFileSync(path.join(codexDir, 'config.toml'), 'cli_auth_credentials_store = "file"\n');
    expect(f.run('ls').out).toContain('codex: signed in');
    expect(fs.readFileSync(f.log, 'utf8')).toBe('login status\n');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('login requires a terminal and an isolated Codex file store', async () => {
  const f = fixture();
  const savedPath = process.env['PATH'];
  const savedLog = process.env['FAKE_LOG'];
  process.env['PATH'] = `${f.bin}:/usr/bin:/bin`;
  process.env['FAKE_LOG'] = f.log;
  try {
    const claudeDir = path.join(f.root, 'claude');
    const codexDir = path.join(f.root, 'codex');
    fs.mkdirSync(claudeDir);
    fs.mkdirSync(codexDir);
    const apiDir = path.join(f.root, 'api');
    fs.mkdirSync(apiDir);
    const profiles = parseProfiles({
      work: {
        label: 'Work',
        claude: { dir: claudeDir, expects: 'subscription' },
        codex: { dir: codexDir, expects: 'subscription' },
      },
      api: { label: 'API', claude: { dir: apiDir, expects: 'api_key' } },
    });
    const lines: string[] = [];
    const io = {
      out: (s: string) => lines.push(s),
      err: (s: string) => lines.push(s),
      isTerminal: () => false,
    };
    expect(await runProfileCommand(['login', 'work', '--harness', 'claude'], profiles, io)).toBe(1);
    expect(fs.existsSync(f.log)).toBe(false);
    const terminal = { ...io, isTerminal: () => true };
    expect(
      await runProfileCommand(['login', 'work', '--harness', 'codex'], profiles, terminal),
    ).toBe(1);
    fs.writeFileSync(
      path.join(codexDir, 'config.toml'),
      'cli_auth_credentials_store = "keyring"\n',
    );
    expect(
      await runProfileCommand(['login', 'work', '--harness', 'codex'], profiles, terminal),
    ).toBe(1);
    expect(lines.join('\n')).toContain('does not keep apart per profile');
    expect(fs.existsSync(f.log)).toBe(false);
    fs.writeFileSync(path.join(codexDir, 'config.toml'), 'cli_auth_credentials_store = "file"\n');
    expect(
      await runProfileCommand(['login', 'work', '--harness', 'codex'], profiles, terminal),
    ).toBe(0);
    expect(
      await runProfileCommand(['login', 'work', '--harness', 'claude'], profiles, terminal),
    ).toBe(0);
    expect(await runProfileCommand(['login', 'api'], profiles, terminal)).toBe(0);
    expect(fs.readFileSync(f.log, 'utf8')).toBe(
      'login\nauth login --claudeai\nauth login --console\n',
    );
    expect(lines.join('\n')).toContain(
      'A Console sign-in without an API key signs out every claude.ai sign-in',
    );
    const missingDir = path.join(f.root, 'missing-adopted');
    const missing = parseProfiles({
      missing: { label: 'Missing', claude: { dir: missingDir, expects: 'subscription' } },
    });
    expect(await runProfileCommand(['login', 'missing'], missing, terminal)).toBe(1);
    expect(fs.existsSync(missingDir)).toBe(false);
  } finally {
    if (savedPath === undefined) Reflect.deleteProperty(process.env, 'PATH');
    else process.env['PATH'] = savedPath;
    if (savedLog === undefined) Reflect.deleteProperty(process.env, 'FAKE_LOG');
    else process.env['FAKE_LOG'] = savedLog;
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('checks and Codex login use configured directories even with unvalidated env', async () => {
  const f = fixture();
  const savedPath = process.env['PATH'];
  const savedLog = process.env['FAKE_LOG'];
  process.env['PATH'] = `${f.bin}:/usr/bin:/bin`;
  process.env['FAKE_LOG'] = f.log;
  try {
    const claudeDir = path.join(f.root, 'claude');
    const codexDir = path.join(f.root, 'codex');
    const wrong = path.join(f.root, 'wrong');
    for (const dir of [claudeDir, codexDir, wrong]) fs.mkdirSync(dir);
    fs.writeFileSync(path.join(codexDir, 'config.toml'), 'cli_auth_credentials_store = "file"\n');
    fs.writeFileSync(path.join(wrong, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n');
    fs.writeFileSync(
      path.join(f.bin, 'claude'),
      `#!/bin/sh\nprintf '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","configDirectory":"%s"}' "$CLAUDE_CONFIG_DIR"\n`,
      { mode: 0o700 },
    );
    fs.writeFileSync(
      path.join(f.bin, 'codex'),
      `#!/bin/sh\nprintf '%s\n' "$CODEX_HOME" >> "$FAKE_LOG"\n`,
      { mode: 0o700 },
    );
    const parsed = parseProfiles({
      work: {
        label: 'Work',
        claude: { dir: claudeDir, expects: 'subscription' },
        codex: { dir: codexDir, expects: 'subscription' },
      },
    });
    if (!('entries' in parsed) || !parsed.entries['work']) throw new Error('invalid fixture');
    const profiles = {
      ...parsed,
      entries: {
        work: { ...parsed.entries['work'], env: { CLAUDE_CONFIG_DIR: wrong, CODEX_HOME: wrong } },
      },
    };
    const lines: string[] = [];
    const io = {
      out: (s: string) => lines.push(s),
      err: (s: string) => lines.push(s),
      isTerminal: () => true,
    };
    expect(await runProfileCommand(['ls'], profiles, io, { cwd: f.root })).toBe(0);
    expect(lines.join('\n')).toContain('claude: signed in');
    expect(lines.join('\n')).toContain('codex: signed in');
    expect(
      await runProfileCommand(['login', 'work', '--harness', 'codex'], profiles, io, {
        cwd: f.root,
      }),
    ).toBe(0);
    expect(fs.readFileSync(f.log, 'utf8')).toBe(`${codexDir}\n${codexDir}\n`);
  } finally {
    if (savedPath === undefined) Reflect.deleteProperty(process.env, 'PATH');
    else process.env['PATH'] = savedPath;
    if (savedLog === undefined) Reflect.deleteProperty(process.env, 'FAKE_LOG');
    else process.env['FAKE_LOG'] = savedLog;
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('add preserves permissions, accepts adopted directories, and keeps symlinks', () => {
  const f = fixture();
  try {
    expect(f.run('add', 'first', '--label', 'First', '--claude').code).toBe(0);
    expect(fs.statSync(f.config).mode & 0o777).toBe(0o600);
    const target = path.join(f.root, 'shared-config');
    fs.renameSync(f.config, target);
    fs.chmodSync(target, 0o640);
    fs.symlinkSync(target, f.config);
    const claude = path.join(f.root, 'adopt-claude');
    const codex = path.join(f.root, 'adopt-codex');
    fs.mkdirSync(claude);
    fs.mkdirSync(codex);
    expect(
      f.run(
        'add',
        'second',
        '--label',
        'Second',
        '--expects',
        'api_key',
        '--claude-dir',
        claude,
        '--codex-dir',
        codex,
      ).code,
    ).toBe(0);
    expect(fs.lstatSync(f.config).isSymbolicLink()).toBe(true);
    expect(fs.statSync(target).mode & 0o777).toBe(0o640);
    expect(fs.readFileSync(target, 'utf8')).toContain('expects = "api_key"');
    expect(f.run('add', 'bad', '--label', 'bad@example.com', '--claude').code).toBe(1);
    expect(fs.existsSync(path.join(f.remi, 'p', 'bad'))).toBe(false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('ls marks the machine default and show renders warnings without values', () => {
  const f = fixture();
  try {
    const dir = path.join(f.root, 'claude');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'settings.json'), '{"apiKeyHelper":"DO_NOT_ECHO"}');
    fs.writeFileSync(
      f.config,
      `[profiles]\ndefault="work"\n[profiles.work]\nlabel="Work"\n[profiles.work.claude]\ndir=${JSON.stringify(dir)}\nexpects="subscription"\n`,
    );
    const list = f.run('ls');
    expect(list.out).toContain('work  Work (machine default)');
    const show = f.run('show', 'work');
    expect(show.out).toContain('user_settings: apiKeyHelper');
    expect(show.out).not.toContain('DO_NOT_ECHO');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('profile help is available through the real CLI', () => {
  const f = fixture();
  try {
    const result = f.run('--help');
    expect(result.code).toBe(0);
    for (const option of [
      '--label',
      '--claude',
      '--codex',
      '--expects',
      '--claude-dir',
      '--codex-dir',
      '--harness',
    ])
      expect(result.out).toContain(option);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('concurrent adds do not lose either profile', async () => {
  const f = fixture();
  try {
    const env = {
      HOME: f.root,
      REMI_HOME: f.remi,
      PATH: `${f.bin}:/usr/bin:/bin`,
      FAKE_LOG: f.log,
    };
    const children = ['one', 'two'].map((id) =>
      Bun.spawn([bun, cli, 'profile', 'add', id, '--label', id, '--claude'], {
        cwd: f.root,
        env,
        stdout: 'ignore',
        stderr: 'ignore',
      }),
    );
    expect(await Promise.all(children.map((child) => child.exited))).toEqual([0, 0]);
    const text = fs.readFileSync(f.config, 'utf8');
    expect(text).toContain('[profiles.one]');
    expect(text).toContain('[profiles.two]');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('real commands discard managed-key and gateway identity fields throughout fixture tree', () => {
  const f = fixture();
  try {
    const managed = path.join(f.root, 'managed');
    const gateway = path.join(f.root, 'gateway');
    const codex = path.join(f.root, 'codex');
    for (const dir of [managed, gateway, codex]) fs.mkdirSync(dir);
    fs.writeFileSync(path.join(codex, 'config.toml'), 'cli_auth_credentials_store = "file"\n');
    fs.writeFileSync(
      path.join(f.bin, 'claude'),
      `#!/bin/sh\n: > "$REMI_HOME/claude-visited"\nidentity="planted"'@example.com'\ncase "$CLAUDE_CONFIG_DIR" in\n*/managed) printf '{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty","apiKeySource":"/login managed key","email":"%s"}' "$identity";;\n*/gateway) printf '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"gateway","email":"%s"}' "$identity";;\nesac\n`,
      { mode: 0o700 },
    );
    fs.writeFileSync(path.join(f.bin, 'codex'), '#!/bin/sh\n: > "$REMI_HOME/codex-visited"\n', {
      mode: 0o700,
    });
    fs.writeFileSync(
      f.config,
      `[profiles.managed]\nlabel="Managed"\n[profiles.managed.claude]\ndir=${JSON.stringify(managed)}\nexpects="subscription"\n[profiles.gateway]\nlabel="Gateway"\n[profiles.gateway.claude]\ndir=${JSON.stringify(gateway)}\nexpects="subscription"\n[profiles.gateway.codex]\ndir=${JSON.stringify(codex)}\nexpects="subscription"\n`,
    );
    const listing = f.run('ls');
    expect(listing.out).toContain('not its own sign-in (/login managed key)');
    expect(listing.out).toContain('not its own sign-in (other)');
    const show = f.run('show', 'gateway');
    const add = f.run('add', 'new', '--label', 'New', '--claude');
    expect(add.code).toBe(0);
    for (const result of [listing, show, add])
      expect(result.out + result.err).not.toContain('planted@example.com');
    expect(fs.existsSync(path.join(f.remi, 'claude-visited'))).toBe(true);
    expect(fs.existsSync(path.join(f.remi, 'codex-visited'))).toBe(true);
    for (const relative of fs.readdirSync(f.root, { recursive: true })) {
      const filename = path.join(f.root, String(relative));
      if (fs.statSync(filename).isFile())
        expect(fs.readFileSync(filename, 'utf8')).not.toContain('planted@example.com');
    }
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
