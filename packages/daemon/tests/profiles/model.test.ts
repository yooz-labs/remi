import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig } from '../../src/config/config.ts';
import { parseProfiles } from '../../src/profiles/profile-config.ts';
import { PROFILE_CREDENTIAL_ENV, profileEnvironment } from '../../src/profiles/profile-env.ts';
import { resolveProfile } from '../../src/profiles/resolve-profile.ts';
import developBaseline from './develop-config-baseline.json';

function config(raw: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-model-'));
  try {
    const file = path.join(dir, 'config.toml');
    fs.writeFileSync(file, `[daemon]\nbind = "127.0.0.2"\n${raw}`);
    return loadConfig(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const basic = `[profiles.work]\nlabel = "Work"\nfolders = ["/a/b"]\n[profiles.work.claude]\nexpects = "subscription"\n`;

describe('profile configuration', () => {
  test('loads a complete profile and keeps revision independent of label and folders', () => {
    const first = parseProfiles({
      default: 'work',
      work: {
        label: 'Work',
        harness: 'claude',
        args: ['--model', 'opus'],
        folders: ['/a/b'],
        env: { AWS_PROFILE: 'work' },
        claude: { dir: '/a/claude', expects: 'subscription' },
        codex: { dir: '/a/codex', expects: 'api_key' },
      },
    });
    const second = parseProfiles({
      work: {
        label: 'Personal',
        harness: 'claude',
        args: ['--model', 'opus'],
        folders: ['/other'],
        env: { AWS_PROFILE: 'work' },
        claude: { dir: '/a/claude', expects: 'subscription' },
        codex: { dir: '/a/codex', expects: 'api_key' },
      },
    });
    if (!('entries' in first) || !('entries' in second)) throw new Error('fixture failed');
    expect(first.default).toBe('work');
    expect(first.entries['work']).toMatchObject({
      label: 'Work',
      harness: 'claude',
      args: ['--model', 'opus'],
      folders: ['/a/b'],
      env: { AWS_PROFILE: 'work' },
      claude: { dir: '/a/claude', expects: 'subscription' },
      codex: { dir: '/a/codex', expects: 'api_key' },
    });
    expect(first.entries['work']?.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(first.entries['work']?.revision).toBe(second.entries['work']?.revision);
  });
  test('loads a profile without changing the other tables', () => {
    const result = config(basic);
    expect(result.daemon.bind).toBe('127.0.0.2');
    expect('entries' in result.profiles && result.profiles.entries['work']?.label).toBe('Work');
  });
  test.each([
    [
      'bad id',
      `[profiles."bad id"]\nlabel="Work"\n[profiles."bad id".claude]\nexpects="subscription"\n`,
      'profiles: invalid profile id',
    ],
    [
      'reserved default',
      `[profiles.default]\nlabel="Work"\n[profiles.default.claude]\nexpects="subscription"\n`,
      'profiles.default: reserved for the built-in profile and machine default',
    ],
    [
      'email',
      `[profiles.work]\nlabel="PLANTED@example.com"\n[profiles.work.claude]\nexpects="subscription"\n`,
      'profiles.work.label: Use a name such as Work, not an email address',
    ],
    [
      'unsafe label',
      `[profiles.work]\nlabel="PLANTED\\u001b"\n[profiles.work.claude]\nexpects="subscription"\n`,
      'profiles.work.label: label contains unsafe characters',
    ],
    [
      '33 profiles',
      Array.from(
        { length: 33 },
        (_, i) =>
          `[profiles.p${i}]\nlabel="Work"\n[profiles.p${i}.claude]\nexpects="subscription"\n`,
      ).join(''),
      'profiles: at most 32 profiles',
    ],
    [
      'duplicate folder',
      `${basic}[profiles.other]\nlabel="Other"\nfolders=["/a/b"]\n[profiles.other.codex]\nexpects="subscription"\n`,
      'profiles.other.folders: folder appears in more than one profile',
    ],
    [
      'remi secret',
      `[profiles.work]\nlabel="Work"\nenv={REMI_PASSPHRASE="PLANTED"}\n[profiles.work.claude]\nexpects="subscription"\n`,
      "profiles.work.env.REMI_PASSPHRASE: remi does not store credentials; use the harness's own sign-in",
    ],
    [
      'missing expects',
      `[profiles.work]\nlabel="Work"\n[profiles.work.claude]\n`,
      'profiles.work.claude.expects: expected a safe token',
    ],
    [
      'unknown key',
      `[profiles.work]\nlabel="Work"\nPLANTED=true\n[profiles.work.claude]\nexpects="subscription"\n`,
      'profiles.work: unknown key',
    ],
    [
      'relative dir',
      `[profiles.work]\nlabel="Work"\n[profiles.work.claude]\nexpects="subscription"\ndir="PLANTED"\n`,
      'profiles.work.claude.dir: expected an absolute or ~/ path',
    ],
    [
      'unknown default',
      `[profiles]\ndefault="PLANTED"\n${basic}`,
      'profiles.default: must name a configured profile',
    ],
    [
      'credential',
      `[profiles.work]\nlabel="Work"\nenv={CUSTOM_API_KEY="PLANTED"}\n[profiles.work.claude]\nexpects="subscription"\n`,
      "profiles.work.env.CUSTOM_API_KEY: remi does not store credentials; use the harness's own sign-in",
    ],
    [
      'provider',
      `[profiles.work]\nlabel="Work"\nenv={CLAUDE_CODE_USE_BEDROCK="PLANTED"}\n[profiles.work.claude]\nexpects="subscription"\n`,
      'profiles.work.env.CLAUDE_CODE_USE_BEDROCK: not supported in this build',
    ],
    ...['--settings', '--settings=x', '--managed-settings', '--setting-sources'].map((flag) => [
      flag,
      `[profiles.work]\nlabel="Work"\nargs=["${flag}"]\n[profiles.work.claude]\nexpects="subscription"\n`,
      'profiles.work.args: these change which settings, and so which credential, Claude Code uses',
    ]),
  ])('%s isolates the invalid table', (_name, raw, message) => {
    const result = config(raw);
    expect(result.daemon.bind).toBe('127.0.0.2');
    expect(result.profiles).toEqual({ error: message });
    expect(JSON.stringify(result.profiles)).not.toContain('PLANTED');
  });
  test('email refusal does not include the label', () => {
    const result = parseProfiles({ work: { label: 'person@example.com' } });
    expect(result).toEqual({
      error: 'profiles.work.label: Use a name such as Work, not an email address',
    });
  });
  test.each(['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HOME', 'XDG_CONFIG_HOME'])(
    'refuses directory selector %s in profile env without affecting other config',
    (name) => {
      const result = config(
        `[profiles.work]\nlabel="Work"\nenv={${name}="/other"}\n[profiles.work.claude]\nexpects="subscription"\n`,
      );
      expect(result.daemon.bind).toBe('127.0.0.2');
      expect(result.profiles).toEqual({
        error: `profiles.work.env.${name}: set the profile's directory with \`dir\`, not \`env\``,
      });
    },
  );
  test('reserved keys and future expects load', () => {
    const result = parseProfiles({
      work: { label: 'Work', remote_visible: true, claude: { expects: 'future_kind' } },
    });
    expect('entries' in result && result.entries['work']?.claude?.expects).toBe('future_kind');
    expect('notices' in result && result.notices).toHaveLength(1);
  });
  test('no profiles leaves the existing configuration unchanged', () => {
    const result = config('');
    const { profiles, ...rest } = result;
    expect(profiles).toEqual({ entries: {}, notices: [] });
    // Captured by loading the same input with origin/develop fbd2841d.
    expect<unknown>(rest).toEqual(developBaseline);
  });
});

describe('profile selection and environment', () => {
  const profiles = parseProfiles({
    default: 'work',
    work: { label: 'Work', folders: ['/a/b'], claude: { expects: 'subscription' } },
    nested: { label: 'Nested', folders: ['/a/b/c'], codex: { expects: 'subscription' } },
  });
  test('selects flag, environment, longest folder, default and built in', () => {
    expect(resolveProfile({ profiles, cwd: '/a/b/c/d', flag: 'work', envValue: 'nested' })).toEqual(
      { id: 'work', source: 'flag' },
    );
    expect(resolveProfile({ profiles, cwd: '/a/b/c/d', envValue: 'work' })).toEqual({
      id: 'work',
      source: 'env',
    });
    expect(resolveProfile({ profiles, cwd: '/a/b/c/d' })).toEqual({
      id: 'nested',
      source: 'folder',
    });
    expect(resolveProfile({ profiles, cwd: '/a/bc' })).toEqual({
      id: 'work',
      source: 'machine_default',
    });
    expect(resolveProfile({ profiles: parseProfiles(undefined), cwd: '/' })).toEqual({
      id: 'default',
      source: 'built_in',
    });
    expect(resolveProfile({ profiles, cwd: '/', flag: 'default' })).toEqual({
      id: 'default',
      source: 'flag',
    });
    expect(resolveProfile({ profiles, cwd: '/', flag: 'missing' })).toEqual({
      error: 'Unknown profile missing. Run remi profile ls.',
    });
  });
  test('scrubs credentials without mutating the inherited environment', () => {
    if (!('entries' in profiles)) throw new Error('invalid fixture');
    const profile = profiles.entries['work'];
    if (!profile) throw new Error('missing fixture');
    const inherited = Object.fromEntries(PROFILE_CREDENTIAL_ENV.map((name) => [name, 'fixture']));
    const env = profileEnvironment(inherited, profile);
    for (const name of PROFILE_CREDENTIAL_ENV) expect(env[name]).toBeUndefined();
    expect(Object.keys(inherited)).toHaveLength(PROFILE_CREDENTIAL_ENV.length);
  });
  test('configured harness directories override even unvalidated profile env', () => {
    if (!('entries' in profiles)) throw new Error('invalid fixture');
    const profile = profiles.entries['work'];
    if (!profile || !profile.claude) throw new Error('missing fixture');
    const env = profileEnvironment(
      {},
      {
        ...profile,
        codex: { dir: '/configured/codex', expects: 'subscription' },
        env: { CLAUDE_CONFIG_DIR: '/other/claude', CODEX_HOME: '/other/codex' },
      },
    );
    expect(env['CLAUDE_CONFIG_DIR']).toBe(profile.claude.dir);
    expect(env['CODEX_HOME']).toBe('/configured/codex');
  });
  test('canonicalizes symlinked working directories', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-symlink-'));
    try {
      const target = path.join(dir, 'target');
      fs.mkdirSync(target);
      const link = path.join(dir, 'link');
      fs.symlinkSync(target, link);
      const p = parseProfiles({
        work: { label: 'Work', folders: [target], claude: { expects: 'subscription' } },
      });
      expect(resolveProfile({ profiles: p, cwd: link })).toEqual({ id: 'work', source: 'folder' });
      expect(resolveProfile({ profiles: p, cwd: '/', envValue: 'default' })).toEqual({
        id: 'default',
        source: 'env',
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  test('folder matching respects component boundaries without a machine default', () => {
    const mapped = parseProfiles({
      work: { label: 'Work', folders: ['/a/b'], claude: { expects: 'subscription' } },
    });
    expect(resolveProfile({ profiles: mapped, cwd: '/a/bc' })).toEqual({
      id: 'default',
      source: 'built_in',
    });
  });
});

test('broken profiles preserve plain selection and refuse raw mappings', () => {
  const invalid = parseProfiles({
    work: { label: 'bad@example.com', folders: ['/a/b'], claude: { expects: 'subscription' } },
  });
  expect(resolveProfile({ profiles: invalid, cwd: '/a/b/child' })).toEqual({
    error:
      'This folder or machine default selects a profile, but [profiles] has an error: profiles.work.label',
  });
  expect(resolveProfile({ profiles: invalid, cwd: '/a/bc' })).toEqual({
    id: 'default',
    source: 'built_in',
    warning:
      'Profiles are disabled by a configuration error (profiles.work.label); this session uses your default sign-in. Run remi profile ls.',
  });
  expect(resolveProfile({ profiles: invalid, cwd: '/', flag: 'work' })).toEqual({
    error: 'profiles.work.label: Use a name such as Work, not an email address',
  });
  expect(resolveProfile({ profiles: invalid, cwd: '/', envValue: 'work' })).toEqual({
    error: 'profiles.work.label: Use a name such as Work, not an email address',
  });
  const machine = parseProfiles({
    default: 'work',
    work: { label: 'bad@example.com', claude: { expects: 'subscription' } },
  });
  expect(resolveProfile({ profiles: machine, cwd: '/' })).toEqual({
    error:
      'This folder or machine default selects a profile, but [profiles] has an error: profiles.work.label',
  });
  const sharedDir = parseProfiles({
    one: { label: 'One', claude: { dir: '/shared', expects: 'subscription' } },
    two: {
      label: 'Two',
      folders: ['/selected'],
      codex: { dir: '/shared', expects: 'subscription' },
    },
  });
  expect(resolveProfile({ profiles: sharedDir, cwd: '/selected' })).toEqual({
    error:
      'This folder or machine default selects a profile, but [profiles] has an error: profiles.two.codex.dir',
  });
});

test('profile harness directories cannot share another sign-in', () => {
  const harness = { dir: '/shared-dir', expects: 'subscription' };
  expect(
    parseProfiles({
      one: { label: 'One', claude: harness },
      two: { label: 'Two', codex: harness },
    }),
  ).toEqual({ error: 'profiles.two.codex.dir uses the same directory as profiles.one.claude.dir' });
  expect(parseProfiles({ one: { label: 'One', claude: harness, codex: harness } })).toEqual({
    error: 'profiles.one.codex.dir uses the same directory as profiles.one.claude.dir',
  });
  for (const name of ['claude', 'codex'] as const) {
    expect(
      parseProfiles({
        one: {
          label: 'One',
          [name]: { dir: path.join(os.homedir(), `.${name}`), expects: 'subscription' },
        },
      }),
    ).toEqual({
      error: `profiles.one.${name}.dir: This is the built-in default's directory; use the built-in default instead`,
    });
  }
});

test('profile environment rejects inherited sources and remi secrets last', () => {
  const result = parseProfiles({ work: { label: 'Work', claude: { expects: 'subscription' } } });
  if (!('entries' in result) || !result.entries['work']) throw new Error('fixture');
  const profile = result.entries['work'];
  expect(
    profileEnvironment(
      { ANTHROPIC_BASE_URL: 'inherited', ANTHROPIC_CONFIG_DIR: '/foreign' },
      profile,
    ),
  ).not.toHaveProperty('ANTHROPIC_BASE_URL');
  expect(profileEnvironment({ ANTHROPIC_CONFIG_DIR: '/foreign' }, profile)).not.toHaveProperty(
    'ANTHROPIC_CONFIG_DIR',
  );
  const resultEnv = profileEnvironment(
    {},
    { ...profile, env: { ANTHROPIC_BASE_URL: 'profile', REMI_PASSPHRASE: 'not-a-secret' } },
  );
  expect(resultEnv['ANTHROPIC_BASE_URL']).toBe('profile');
  expect(resultEnv['REMI_PASSPHRASE']).toBeUndefined();
  expect(
    parseProfiles({
      work: {
        label: 'Work',
        env: { ANTHROPIC_CONFIG_DIR: '/foreign' },
        claude: { expects: 'subscription' },
      },
    }),
  ).toEqual({ error: 'profiles.work.env.ANTHROPIC_CONFIG_DIR: not supported in this build' });
});

test('every credential selector is refused in profile env', () => {
  for (const name of PROFILE_CREDENTIAL_ENV) {
    const parsed = parseProfiles({
      work: { label: 'Work', env: { [name]: 'PLANTED' }, claude: { expects: 'subscription' } },
    });
    expect(parsed).toEqual({ error: `profiles.work.env.${name}: not supported in this build` });
    expect(JSON.stringify(parsed)).not.toContain('PLANTED');
  }
});

test('unknown keys do not echo control sequences', () => {
  expect(
    parseProfiles({
      work: { label: 'Work', '\u001b[31mPLANTED': true, claude: { expects: 'subscription' } },
    }),
  ).toEqual({ error: 'profiles.work: unknown key' });
});

test('profile command help reaches the global parser', async () => {
  const { parseArgs } = await import('../../src/cli/arg-parser.ts');
  expect(parseArgs(['profile', '--help']).showHelp).toBe(true);
  expect(parseArgs(['profile', '-h']).showHelp).toBe(true);
  expect(
    parseArgs(['profile', 'add', 'work', '--label', 'Work', '--claude']).subcommandArgs,
  ).toEqual(['add', 'work', '--label', 'Work', '--claude']);
});
