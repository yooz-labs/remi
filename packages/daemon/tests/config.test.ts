/**
 * Tests for config file system.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DAEMON_HOLD_SECONDS_MAX,
  DEFAULT_CONFIG,
  HOLD_SECONDS_MAX,
  HOLD_SECONDS_MIN,
  applyEnvOverrides,
  formatConfig,
  generateDefaultConfig,
  initConfigFile,
  loadConfig,
  loadConfigWithNotices,
} from '../src/config/config.ts';

const TEST_DIR = path.join(os.tmpdir(), `remi-config-test-${process.pid}`);
const TEST_CONFIG = path.join(TEST_DIR, 'config.toml');

beforeEach(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('loadConfig', () => {
  test('returns defaults when no file exists', () => {
    const config = loadConfig(path.join(TEST_DIR, 'nonexistent.toml'));
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  test('parses valid TOML config', () => {
    fs.writeFileSync(
      TEST_CONFIG,
      `
[daemon]
base_port = 19000
port_range = 10

[telegram]
enabled = true
bot_token = "test-token"
authorized_chat_ids = [123, 456]
`,
    );

    const config = loadConfig(TEST_CONFIG);
    expect(config.daemon.base_port).toBe(19000);
    expect(config.daemon.port_range).toBe(10);
    expect(config.daemon.bind).toBe('127.0.0.1'); // default preserved
    expect(config.telegram.enabled).toBe(true);
    expect(config.telegram.bot_token).toBe('test-token');
    expect(config.telegram.authorized_chat_ids).toEqual([123, 456]);
  });

  test('preserves defaults for missing sections', () => {
    fs.writeFileSync(
      TEST_CONFIG,
      `
[display]
max_bullet_length = 200
`,
    );

    const config = loadConfig(TEST_CONFIG);
    expect(config.display.max_bullet_length).toBe(200);
    expect(config.daemon).toEqual(DEFAULT_CONFIG.daemon);
    expect(config.network).toEqual(DEFAULT_CONFIG.network);
    expect(config.auth).toEqual(DEFAULT_CONFIG.auth);
    expect(config.telegram).toEqual(DEFAULT_CONFIG.telegram);
  });

  test('throws on invalid TOML', () => {
    fs.writeFileSync(TEST_CONFIG, 'this is not valid toml ][}{');

    expect(() => loadConfig(TEST_CONFIG)).toThrow('Invalid TOML');
  });

  test('returns defaults for nonexistent file', () => {
    const config = loadConfig(path.join(TEST_DIR, 'nonexistent.toml'));
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  test('handles partial sections', () => {
    fs.writeFileSync(
      TEST_CONFIG,
      `
[daemon]
bind = "localhost"
`,
    );

    const config = loadConfig(TEST_CONFIG);
    expect(config.daemon.bind).toBe('localhost');
    expect(config.daemon.base_port).toBe(18765); // default preserved
    expect(config.daemon.port_range).toBe(20); // default preserved
  });

  test('persist_sessions defaults to true and parses an override (#637)', () => {
    // Default preserved when omitted
    const defaults = loadConfig(path.join(TEST_DIR, 'nonexistent.toml'));
    expect(defaults.daemon.persist_sessions).toBe(true);

    // Explicit override is parsed
    fs.writeFileSync(
      TEST_CONFIG,
      `
[daemon]
persist_sessions = false
`,
    );
    const config = loadConfig(TEST_CONFIG);
    expect(config.daemon.persist_sessions).toBe(false);
    expect(config.daemon.orphan_timeout).toBe(DEFAULT_CONFIG.daemon.orphan_timeout); // default preserved
  });

  test('handles auth enabled as string or boolean', () => {
    fs.writeFileSync(
      TEST_CONFIG,
      `
[auth]
enabled = true
`,
    );

    const config = loadConfig(TEST_CONFIG);
    expect(config.auth.enabled).toBe(true);
  });
});

describe('applyEnvOverrides', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore original env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        process.env[key] = undefined;
      }
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
  });

  test('REMI_PORT overrides base_port', () => {
    process.env['REMI_PORT'] = '19999';
    const config = applyEnvOverrides(DEFAULT_CONFIG);
    expect(config.daemon.base_port).toBe(19999);
  });

  test('REMI_MAX_BULLET_LENGTH overrides max_bullet_length', () => {
    process.env['REMI_MAX_BULLET_LENGTH'] = '100';
    const config = applyEnvOverrides(DEFAULT_CONFIG);
    expect(config.display.max_bullet_length).toBe(100);
  });

  test('transcript-binder drives by default (#499/#503)', () => {
    // The binder is the unconditional session-binding driver. The flag is a
    // deprecated kill-switch (#470): REMI_TRANSCRIPT_BINDER_ENABLED=false no
    // longer restores an alternate path, it only logs a deprecation warning.
    expect(DEFAULT_CONFIG.features.transcript_binder_enabled).toBe(true);
  });

  test('REMI_TRANSCRIPT_BINDER_ENABLED=false is read but no longer changes behavior (#470)', () => {
    process.env['REMI_TRANSCRIPT_BINDER_ENABLED'] = 'false';
    const config = applyEnvOverrides(DEFAULT_CONFIG);
    expect(config.features.transcript_binder_enabled).toBe(false);
  });

  test('TELEGRAM_BOT_TOKEN enables telegram', () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 'test-token-123';
    const config = applyEnvOverrides(DEFAULT_CONFIG);
    expect(config.telegram.bot_token).toBe('test-token-123');
    expect(config.telegram.enabled).toBe(true);
  });

  test('TELEGRAM_ENABLED=false disables even with token', () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 'test-token-123';
    process.env['TELEGRAM_ENABLED'] = 'false';
    const config = applyEnvOverrides(DEFAULT_CONFIG);
    expect(config.telegram.bot_token).toBe('test-token-123');
    expect(config.telegram.enabled).toBe(false);
  });

  test('TELEGRAM_AUTHORIZED_CHAT_IDS parsed as number array', () => {
    process.env['TELEGRAM_AUTHORIZED_CHAT_IDS'] = '123,456,789';
    const config = applyEnvOverrides(DEFAULT_CONFIG);
    expect(config.telegram.authorized_chat_ids).toEqual([123, 456, 789]);
  });

  test('invalid env values are ignored', () => {
    process.env['REMI_PORT'] = 'not-a-number';
    const config = applyEnvOverrides(DEFAULT_CONFIG);
    expect(config.daemon.base_port).toBe(DEFAULT_CONFIG.daemon.base_port);
  });

  test('does not modify config when relevant env vars are absent', () => {
    // Clear all remi/telegram env vars
    // biome-ignore lint/performance/noDelete: test isolation
    delete process.env['REMI_PORT'];
    // biome-ignore lint/performance/noDelete: test isolation
    delete process.env['REMI_MAX_BULLET_LENGTH'];
    // biome-ignore lint/performance/noDelete: test isolation
    delete process.env['TELEGRAM_BOT_TOKEN'];
    // biome-ignore lint/performance/noDelete: test isolation
    delete process.env['TELEGRAM_ENABLED'];
    // biome-ignore lint/performance/noDelete: test isolation
    delete process.env['TELEGRAM_AUTHORIZED_CHAT_IDS'];
    // biome-ignore lint/performance/noDelete: test isolation
    delete process.env['TELEGRAM_AUTHORIZED_USER_IDS'];

    const config = applyEnvOverrides(DEFAULT_CONFIG);
    expect(config).toEqual(DEFAULT_CONFIG);
  });
});

describe('initConfigFile', () => {
  test('creates config file with defaults', () => {
    const configPath = path.join(TEST_DIR, 'new-config.toml');
    const result = initConfigFile(configPath);
    expect(result).toBe(configPath);
    expect(fs.existsSync(configPath)).toBe(true);

    const content = fs.readFileSync(configPath, 'utf-8');
    expect(content).toContain('[daemon]');
    expect(content).toContain('base_port = 18765');
    expect(content).toContain('[telegram]');
  });

  test('throws if file already exists', () => {
    fs.writeFileSync(TEST_CONFIG, '# existing');
    expect(() => initConfigFile(TEST_CONFIG)).toThrow('already exists');
  });
});

describe('generateDefaultConfig', () => {
  test('generates valid TOML that can be parsed back', () => {
    const toml = generateDefaultConfig();
    const config = loadConfig(
      (() => {
        const p = path.join(TEST_DIR, 'roundtrip.toml');
        fs.writeFileSync(p, toml);
        return p;
      })(),
    );
    expect(config).toEqual(DEFAULT_CONFIG);
  });
});

describe('formatConfig', () => {
  test('formats config as readable string', () => {
    const output = formatConfig(DEFAULT_CONFIG, path.join(TEST_DIR, 'nonexistent.toml'));
    expect(output).toContain('not found, using defaults');
    expect(output).toContain('base_port = 18765');
    expect(output).toContain('[telegram]');
  });

  test('masks bot token', () => {
    const config = {
      ...DEFAULT_CONFIG,
      telegram: { ...DEFAULT_CONFIG.telegram, bot_token: 'secret-token' },
    };
    const output = formatConfig(config);
    expect(output).toContain('***');
    expect(output).not.toContain('secret-token');
  });
});

describe('terminal config (#513)', () => {
  test('defaults: osc9 notify + status cue on + status bar on', () => {
    expect(DEFAULT_CONFIG.terminal).toEqual({
      notify: 'osc9',
      status_cue: true,
      status_bar: true,
    });
  });

  test('loads terminal from TOML', () => {
    fs.writeFileSync(TEST_CONFIG, '[terminal]\nnotify = "osc777"\nstatus_cue = false\n');
    const config = loadConfig(TEST_CONFIG);
    expect(config.terminal.notify).toBe('osc777');
    expect(config.terminal.status_cue).toBe(false);
  });

  test('preserves terminal defaults when section missing', () => {
    fs.writeFileSync(TEST_CONFIG, '[daemon]\nbase_port = 19000\n');
    const config = loadConfig(TEST_CONFIG);
    expect(config.terminal).toEqual(DEFAULT_CONFIG.terminal);
  });

  test('rejects an unknown notify channel', () => {
    fs.writeFileSync(TEST_CONFIG, '[terminal]\nnotify = "growl"\n');
    expect(() => loadConfig(TEST_CONFIG)).toThrow(/terminal\.notify/);
  });

  test('rejects status_cue as a string', () => {
    fs.writeFileSync(TEST_CONFIG, '[terminal]\nstatus_cue = "yes"\n');
    expect(() => loadConfig(TEST_CONFIG)).toThrow(/terminal\.status_cue/);
  });

  test('loads status_bar from TOML', () => {
    fs.writeFileSync(TEST_CONFIG, '[terminal]\nstatus_bar = false\n');
    const config = loadConfig(TEST_CONFIG);
    expect(config.terminal.status_bar).toBe(false);
  });

  test('rejects status_bar as a string', () => {
    fs.writeFileSync(TEST_CONFIG, '[terminal]\nstatus_bar = "yes"\n');
    expect(() => loadConfig(TEST_CONFIG)).toThrow(/terminal\.status_bar/);
  });

  test('REMI_TERMINAL_STATUS_BAR=false disables the bar', () => {
    process.env['REMI_TERMINAL_STATUS_BAR'] = 'false';
    const config = applyEnvOverrides(DEFAULT_CONFIG);
    expect(config.terminal.status_bar).toBe(false);
    // biome-ignore lint/performance/noDelete: test isolation
    delete process.env['REMI_TERMINAL_STATUS_BAR'];
  });

  test('REMI_TERMINAL_NOTIFY env override', () => {
    process.env['REMI_TERMINAL_NOTIFY'] = 'bell';
    const config = applyEnvOverrides(DEFAULT_CONFIG);
    expect(config.terminal.notify).toBe('bell');
    // biome-ignore lint/performance/noDelete: test isolation
    delete process.env['REMI_TERMINAL_NOTIFY'];
  });

  test('REMI_TERMINAL_NOTIFY ignores an invalid value', () => {
    process.env['REMI_TERMINAL_NOTIFY'] = 'nonsense';
    const config = applyEnvOverrides(DEFAULT_CONFIG);
    expect(config.terminal.notify).toBe('osc9'); // default preserved
    // biome-ignore lint/performance/noDelete: test isolation
    delete process.env['REMI_TERMINAL_NOTIFY'];
  });

  test('REMI_TERMINAL_STATUS_CUE=false disables the cue', () => {
    process.env['REMI_TERMINAL_STATUS_CUE'] = 'false';
    const config = applyEnvOverrides(DEFAULT_CONFIG);
    expect(config.terminal.status_cue).toBe(false);
    // biome-ignore lint/performance/noDelete: test isolation
    delete process.env['REMI_TERMINAL_STATUS_CUE'];
  });

  test('formatConfig includes the terminal section', () => {
    const output = formatConfig(DEFAULT_CONFIG, path.join(TEST_DIR, 'nonexistent.toml'));
    expect(output).toContain('[terminal]');
    expect(output).toContain('notify = "osc9"');
    expect(output).toContain('status_cue = true');
    expect(output).toContain('status_bar = true');
  });
});

describe('notifications config (#914)', () => {
  test('defaults: on_turn_complete true, 60s threshold', () => {
    expect(DEFAULT_CONFIG.notifications.on_turn_complete).toBe(true);
    expect(DEFAULT_CONFIG.notifications.turn_complete_min_seconds).toBe(60);
  });

  test('loads notifications from TOML', () => {
    fs.writeFileSync(
      TEST_CONFIG,
      '[notifications]\non_turn_complete = false\nturn_complete_min_seconds = 120\n',
    );
    const config = loadConfig(TEST_CONFIG);
    expect(config.notifications.on_turn_complete).toBe(false);
    expect(config.notifications.turn_complete_min_seconds).toBe(120);
  });

  test('preserves notifications defaults when section missing', () => {
    fs.writeFileSync(TEST_CONFIG, '[daemon]\nbase_port = 19000\n');
    const config = loadConfig(TEST_CONFIG);
    expect(config.notifications).toEqual(DEFAULT_CONFIG.notifications);
  });

  test('rejects on_turn_complete as a string', () => {
    fs.writeFileSync(TEST_CONFIG, '[notifications]\non_turn_complete = "yes"\n');
    expect(() => loadConfig(TEST_CONFIG)).toThrow(/notifications\.on_turn_complete/);
  });

  test('rejects a negative turn_complete_min_seconds', () => {
    fs.writeFileSync(TEST_CONFIG, '[notifications]\nturn_complete_min_seconds = -1\n');
    expect(() => loadConfig(TEST_CONFIG)).toThrow(/notifications\.turn_complete_min_seconds/);
  });

  test('rejects turn_complete_min_seconds as a string', () => {
    fs.writeFileSync(TEST_CONFIG, '[notifications]\nturn_complete_min_seconds = "soon"\n');
    expect(() => loadConfig(TEST_CONFIG)).toThrow(/notifications\.turn_complete_min_seconds/);
  });

  test('accepts turn_complete_min_seconds = 0 (fires on any duration)', () => {
    fs.writeFileSync(TEST_CONFIG, '[notifications]\nturn_complete_min_seconds = 0\n');
    const config = loadConfig(TEST_CONFIG);
    expect(config.notifications.turn_complete_min_seconds).toBe(0);
  });

  test('generateDefaultConfig includes a [notifications] block', () => {
    const generated = generateDefaultConfig();
    expect(generated).toContain('[notifications]');
    expect(generated).toContain('on_turn_complete = true');
    expect(generated).toContain('turn_complete_min_seconds = 60');
  });

  test('formatConfig includes the notifications section', () => {
    const output = formatConfig(DEFAULT_CONFIG, path.join(TEST_DIR, 'nonexistent.toml'));
    expect(output).toContain('[notifications]');
    expect(output).toContain('on_turn_complete = true');
    expect(output).toContain('turn_complete_min_seconds = 60');
    expect(output).toContain('subagent_alert = ["rm -rf", "rm -f", "push --force"');
  });
});

describe('prompts.hold_seconds (#1126)', () => {
  test('defaults to 90 seconds, and 3540 for a daemon or hub session', () => {
    expect(DEFAULT_CONFIG.prompts.hold_seconds).toBe(90);
    expect(DEFAULT_CONFIG.prompts.daemon_hold_seconds).toBe(3540);
    expect(loadConfig(path.join(TEST_DIR, 'missing.toml')).prompts).toEqual({
      hold_seconds: 90,
      daemon_hold_seconds: 3540,
    });
  });

  test('daemon_hold_seconds loads within 5..3540 and is refused outside it', () => {
    for (const v of [HOLD_SECONDS_MIN, 600, DAEMON_HOLD_SECONDS_MAX]) {
      fs.writeFileSync(TEST_CONFIG, `[prompts]\ndaemon_hold_seconds = ${v}\n`);
      expect(loadConfig(TEST_CONFIG).prompts.daemon_hold_seconds).toBe(v);
    }
    for (const bad of ['4', '3541', '3600', '"60"']) {
      fs.writeFileSync(TEST_CONFIG, `[prompts]\ndaemon_hold_seconds = ${bad}\n`);
      expect(() => loadConfig(TEST_CONFIG)).toThrow(/prompts\.daemon_hold_seconds/);
    }
  });

  test('loads from [prompts], inclusive of both bounds', () => {
    for (const v of [HOLD_SECONDS_MIN, 30, HOLD_SECONDS_MAX]) {
      fs.writeFileSync(TEST_CONFIG, `[prompts]\nhold_seconds = ${v}\n`);
      expect(loadConfig(TEST_CONFIG).prompts.hold_seconds).toBe(v);
    }
  });

  test('refuses a value outside 5..110 or not a number, instead of clamping', () => {
    for (const bad of ['4', '111', '600', '-1', '"90"', 'nan']) {
      fs.writeFileSync(TEST_CONFIG, `[prompts]\nhold_seconds = ${bad}\n`);
      expect(() => loadConfig(TEST_CONFIG)).toThrow(/prompts\.hold_seconds/);
    }
  });

  test('is not an [auto_approve] key: an old table cannot set it', () => {
    fs.writeFileSync(TEST_CONFIG, '[auto_approve]\nhold_seconds = 30\n');
    expect(loadConfig(TEST_CONFIG).prompts.hold_seconds).toBe(90);
  });

  test('generateDefaultConfig and formatConfig show the [prompts] block', () => {
    expect(generateDefaultConfig()).toContain('[prompts]\n');
    expect(generateDefaultConfig()).toContain('hold_seconds = 90');
    const output = formatConfig(DEFAULT_CONFIG, path.join(TEST_DIR, 'nonexistent.toml'));
    expect(output).toContain('[prompts]');
    expect(output).toContain('hold_seconds = 90');
  });

  test('the generated default file loads back to the defaults', () => {
    fs.writeFileSync(TEST_CONFIG, generateDefaultConfig());
    expect(loadConfig(TEST_CONFIG).prompts).toEqual(DEFAULT_CONFIG.prompts);
  });
});

describe('notifications.subagent_alert (#807, moved in #1125)', () => {
  test('defaults to the irreversible-only list', () => {
    expect(DEFAULT_CONFIG.notifications.subagent_alert).toEqual([
      'rm -rf',
      'rm -f',
      'push --force',
      'push -f ',
      'reset --hard',
      'DROP TABLE',
      'TRUNCATE',
      'sudo ',
      'chmod 777',
    ]);
  });

  test('loads from [notifications]', () => {
    fs.writeFileSync(TEST_CONFIG, '[notifications]\nsubagent_alert = ["curl", "ssh "]\n');
    expect(loadConfig(TEST_CONFIG).notifications.subagent_alert).toEqual(['curl', 'ssh ']);
  });

  test('an empty list is respected (alerts off)', () => {
    fs.writeFileSync(TEST_CONFIG, '[notifications]\nsubagent_alert = []\n');
    expect(loadConfig(TEST_CONFIG).notifications.subagent_alert).toEqual([]);
  });

  test('rejects a string instead of a list', () => {
    fs.writeFileSync(TEST_CONFIG, '[notifications]\nsubagent_alert = "rm -rf"\n');
    expect(() => loadConfig(TEST_CONFIG)).toThrow(/notifications\.subagent_alert/);
  });

  test('the generated default config carries it and parses back', () => {
    const generated = generateDefaultConfig();
    expect(generated).toContain('subagent_alert = ["rm -rf"');
    fs.writeFileSync(TEST_CONFIG, generated);
    expect(loadConfig(TEST_CONFIG).notifications.subagent_alert).toEqual(
      DEFAULT_CONFIG.notifications.subagent_alert,
    );
  });
});

describe('a removed [auto_approve] table still loads (#1125)', () => {
  const OLD_TABLE = [
    '[auto_approve]',
    'enabled = true',
    'provider = "ollama"',
    'model = 42',
    'allow = "git"',
    'deny = ["sudo "]',
    'level = "bogus"',
    'hold_timeout = -5',
    'residual_action = "maybe"',
    'always_escalate_tools = ["MyTool"]',
    '',
    '[auto_approve.agents.Explore]',
    'approve_groups = ["nope"]',
    '',
  ].join('\n');

  test('values that the old validator refused no longer stop the daemon', () => {
    fs.writeFileSync(TEST_CONFIG, OLD_TABLE);
    expect(() => loadConfig(TEST_CONFIG)).not.toThrow();
  });

  test('reports every top-level key present, sorted, for the boot notice', () => {
    fs.writeFileSync(TEST_CONFIG, OLD_TABLE);
    expect(loadConfigWithNotices(TEST_CONFIG).removedAutoApproveKeys).toEqual([
      'agents',
      'allow',
      'always_escalate_tools',
      'deny',
      'enabled',
      'hold_timeout',
      'level',
      'model',
      'provider',
      'residual_action',
    ]);
  });

  test('the loaded config has no auto_approve section at all', () => {
    fs.writeFileSync(TEST_CONFIG, OLD_TABLE);
    expect('auto_approve' in loadConfig(TEST_CONFIG)).toBe(false);
  });

  test('no table: no keys, no fallback', () => {
    fs.writeFileSync(TEST_CONFIG, '[daemon]\nbase_port = 19000\n');
    const loaded = loadConfigWithNotices(TEST_CONFIG);
    expect(loaded.removedAutoApproveKeys).toEqual([]);
    expect(loaded.subagentAlertFromLegacy).toBe(false);
  });

  test('no file: no keys, no fallback', () => {
    const loaded = loadConfigWithNotices(path.join(TEST_DIR, 'missing.toml'));
    expect(loaded.removedAutoApproveKeys).toEqual([]);
    expect(loaded.subagentAlertFromLegacy).toBe(false);
  });

  test('a non-table auto_approve value is reported, not fatal', () => {
    fs.writeFileSync(TEST_CONFIG, 'auto_approve = true\n');
    expect(loadConfigWithNotices(TEST_CONFIG).removedAutoApproveKeys).toEqual(['auto_approve']);
  });

  test('legacy auto_approve.subagent_alert is honored when [notifications] does not set it', () => {
    fs.writeFileSync(TEST_CONFIG, '[auto_approve]\nsubagent_alert = ["curl"]\n');
    const loaded = loadConfigWithNotices(TEST_CONFIG);
    expect(loaded.config.notifications.subagent_alert).toEqual(['curl']);
    expect(loaded.subagentAlertFromLegacy).toBe(true);
    // Honored, so not "ignored": it gets the boot notice's "move it" line.
    expect(loaded.removedAutoApproveKeys).toEqual([]);
  });

  test('[notifications] subagent_alert wins over the legacy key', () => {
    fs.writeFileSync(
      TEST_CONFIG,
      '[notifications]\nsubagent_alert = ["ssh "]\n\n[auto_approve]\nsubagent_alert = ["curl"]\n',
    );
    const loaded = loadConfigWithNotices(TEST_CONFIG);
    expect(loaded.config.notifications.subagent_alert).toEqual(['ssh ']);
    expect(loaded.subagentAlertFromLegacy).toBe(false);
    // Shadowed, so it IS ignored and listed as such.
    expect(loaded.removedAutoApproveKeys).toEqual(['subagent_alert']);
  });

  test('a malformed legacy subagent_alert is ignored, keeping the default', () => {
    fs.writeFileSync(TEST_CONFIG, '[auto_approve]\nsubagent_alert = "rm -rf"\n');
    const loaded = loadConfigWithNotices(TEST_CONFIG);
    expect(loaded.config.notifications.subagent_alert).toEqual(
      DEFAULT_CONFIG.notifications.subagent_alert,
    );
    expect(loaded.subagentAlertFromLegacy).toBe(false);
    expect(loaded.removedAutoApproveKeys).toEqual(['subagent_alert']);
  });

  test('REMI_AUTO_APPROVE* environment variables change nothing', () => {
    const before = { ...process.env };
    // Baseline under whatever ambient env this test runs in (REMI_PORT may be
    // set when the suite itself runs inside a remi session).
    const baseline = applyEnvOverrides(DEFAULT_CONFIG);
    try {
      process.env['REMI_AUTO_APPROVE'] = 'true';
      process.env['REMI_AUTO_APPROVE_MODEL'] = 'x';
      const config = applyEnvOverrides(DEFAULT_CONFIG);
      expect(config).toEqual(baseline);
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in before)) process.env[key] = undefined;
      }
    }
  });

  test('neither the generated default config nor `remi config` mention it', () => {
    expect(generateDefaultConfig()).not.toContain('auto_approve');
    expect(formatConfig(DEFAULT_CONFIG, path.join(TEST_DIR, 'nonexistent.toml'))).not.toContain(
      'auto_approve',
    );
  });
});

// #880: the exposure was the PAIRING of a network bind with auth resolving off,
// so pin both halves. Either one alone is defensible; together they admit
// unauthenticated `answer`/`user_input` from any LAN host, and mDNS advertises
// the port. A future change that flips the bind back without also settling the
// auth default should fail here.
describe('#880 the shipped defaults do not expose an unauthenticated daemon', () => {
  test('the default bind is loopback', () => {
    expect(DEFAULT_CONFIG.daemon.bind).toBe('127.0.0.1');
  });

  test('auth still defaults to "auto", which resolves OFF — so the bind is what protects', () => {
    // Documenting the coupling rather than asserting a fix that has not
    // happened: `"auto"` is still false on every bind (#880 remains open for
    // the semantics + TOFU work). That is exactly why the bind default is
    // load-bearing and must not be widened casually.
    expect(DEFAULT_CONFIG.auth.enabled).toBe('auto');
  });

  test('a network bind in config.toml still wins — remote access stays opt-in', () => {
    // Round-trips a real file through loadConfig. An earlier draft of this test
    // spread DEFAULT_CONFIG, wrote '0.0.0.0' into the literal, and asserted the
    // value it had just written -- it exercised no parsing, no merge, and could
    // not fail on its own claim. That is the ADR 0011 anti-pattern verbatim, in
    // a test defending a P0.
    fs.writeFileSync(TEST_CONFIG, '[daemon]\nbind = "0.0.0.0"\n');
    expect(loadConfig(TEST_CONFIG).daemon.bind).toBe('0.0.0.0');
  });

  test('an install that materialized the OLD default keeps it — the boot warning is their only signal', () => {
    // `remi config init` writes the bind value into config.toml, so a user who
    // ran it before this change has `bind = "0.0.0.0"` on disk and a value on
    // disk beats a changed default. Pinned because it bounds what the fix
    // claims: new installs are protected, pre-existing config-init installs are
    // not, and nothing in their setup breaks to make them look.
    fs.writeFileSync(TEST_CONFIG, '[daemon]\nbind = "0.0.0.0"\n');
    const cfg = loadConfig(TEST_CONFIG);
    expect(cfg.daemon.bind).not.toBe(DEFAULT_CONFIG.daemon.bind);
    expect(cfg.auth.enabled).toBe('auto'); // still resolves off — still exposed
  });

  test('a freshly generated config carries the loopback default, not a stale literal', () => {
    // generateDefaultConfig interpolates DEFAULT_CONFIG.daemon.bind. If that
    // ever drifts from the shipped default, `remi config init` would hand new
    // users the exposure this change removed.
    const generated = generateDefaultConfig();
    fs.writeFileSync(TEST_CONFIG, generated);
    expect(loadConfig(TEST_CONFIG).daemon.bind).toBe('127.0.0.1');
  });
});

// #1193: the relay registered a room with the signaling Worker on every
// install, and no shipped client can use it. These pin the loader and the
// defaults, not just the constant, so a default that is overridden somewhere
// between the file and the daemon would show up here.
describe('network.relay is off by default (#1193)', () => {
  const missing = () => path.join(TEST_DIR, 'nonexistent.toml');

  test('with no config file', () => {
    expect(DEFAULT_CONFIG.network.relay).toBe(false);
    expect(loadConfig(missing()).network.relay).toBe(false);
  });

  test('a config.toml that sets other network keys leaves it off', () => {
    fs.writeFileSync(TEST_CONFIG, '[network]\nmdns = false\n');
    const cfg = loadConfig(TEST_CONFIG);
    expect(cfg.network.mdns).toBe(false);
    expect(cfg.network.relay).toBe(false);
  });

  test('an explicit relay = true in config.toml still turns it on', () => {
    fs.writeFileSync(TEST_CONFIG, '[network]\nrelay = true\n');
    expect(loadConfig(TEST_CONFIG).network.relay).toBe(true);
  });

  test('an explicit relay = false stays off', () => {
    fs.writeFileSync(TEST_CONFIG, '[network]\nrelay = false\n');
    expect(loadConfig(TEST_CONFIG).network.relay).toBe(false);
  });

  test('`remi config` shows the effective value', () => {
    expect(formatConfig(loadConfig(missing()), missing())).toContain('relay = false');
    fs.writeFileSync(TEST_CONFIG, '[network]\nrelay = true\n');
    expect(formatConfig(loadConfig(TEST_CONFIG), TEST_CONFIG)).toContain('relay = true');
  });

  test('`remi config init` writes the off value for a new install', () => {
    // It materializes the default into the file, and a value on disk beats a
    // changed default; an install that ran it before this change keeps `relay =
    // true`, which the adapter now refuses to serve (relay-fail-closed.test.ts).
    initConfigFile(TEST_CONFIG);
    expect(fs.readFileSync(TEST_CONFIG, 'utf-8')).toContain('relay = false');
    expect(loadConfig(TEST_CONFIG).network.relay).toBe(false);
  });
});
