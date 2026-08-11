/**
 * Tests for config file system.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_CONFIG,
  applyEnvOverrides,
  defaultModel,
  detectLocalLLMPlatform,
  formatConfig,
  generateDefaultConfig,
  initConfigFile,
  llamaServerCommand,
  loadConfig,
} from '../src/config/config.ts';

/** What `auto_approve.provider` should default to on the machine running these
 *  tests (#822). Derived from the platform detector rather than read back from
 *  `DEFAULT_CONFIG`, so assertions using it are real rather than circular. */
function expectedDefaultProvider(): string {
  const detected = detectLocalLLMPlatform();
  return detected === 'unsupported' ? 'yooz' : detected;
}

/** #822: the evaluator model default is platform-resolved too — an MLX id
 *  cannot be loaded by llama.cpp. Derived from `detectLocalLLMPlatform`, not
 *  from DEFAULT_CONFIG, so it is a real expectation rather than a tautology.
 *  Without this these assertions pass on a macOS dev machine and fail on CI,
 *  which runs ubuntu-latest. */
function expectedDefaultModel(): string {
  return detectLocalLLMPlatform() === 'llamacpp'
    ? 'YoozLabs/Qwen3.5-4B-qat-GGUF:Q4_0'
    : 'YoozLabs/Qwen3.5-4B-qat-lean-4bit-mlx';
}

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

  test('auto-approve stays opt-in but defaults safe read-only tools in allow (#482)', () => {
    // Off by default (the trust line we never cross silently).
    expect(DEFAULT_CONFIG.auto_approve.enabled).toBe(false);
    // Read-only TOOL-NAME matches (not Bash substrings) so a compound command
    // cannot bypass them; these fast-path file reads without an LLM call.
    expect(DEFAULT_CONFIG.auto_approve.allow).toContain('Read');
    expect(DEFAULT_CONFIG.auto_approve.allow).toContain('Glob');
    expect(DEFAULT_CONFIG.auto_approve.allow).toContain('Grep');
    // No Bash command substrings are defaulted (compound-command-unsafe).
    expect(DEFAULT_CONFIG.auto_approve.allow.some((p) => p.includes(' '))).toBe(false);
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

  test('includes auto_approve section', () => {
    const output = formatConfig(DEFAULT_CONFIG, path.join(TEST_DIR, 'nonexistent.toml'));
    expect(output).toContain('[auto_approve]');
    expect(output).toContain('enabled = false');
    // Platform-dependent by design (#822): the engine on Apple Silicon, a
    // llama.cpp sidecar on Linux. Asserting a literal here passes on a macOS
    // dev machine and fails on Linux CI, which is exactly what happened.
    expect(output).toContain(`provider = "${expectedDefaultProvider()}"`);
    // disable_thinking must be visible in `config show` so a user who set it
    // can confirm it (it was missed in the initial formatConfig wiring).
    expect(output).toContain('disable_thinking = true');
    // approve_groups/deny_groups likewise visible (#494 phase 1).
    expect(output).toContain('approve_groups = ["read-only", "vcs-read", "build-test"]');
    expect(output).toContain('deny_groups = []');
    // escalate_model visible (#522).
    expect(output).toContain('escalate_model = ""');
    // always_escalate_tools visible (#572).
    expect(output).toContain('always_escalate_tools = ["AskUserQuestion", "ExitPlanMode"]');
    // delivery_confirm_timeout / hold_unconfirmed_timeout visible (#603 Phase 1)
    // — guards against the #517-class regression of omitting a field from `config
    // show`.
    expect(output).toContain('delivery_confirm_timeout = 6');
    expect(output).toContain('hold_unconfirmed_timeout = 0');
    // cache_idle visible (#820 stage 1), alongside its stage-2 sibling.
    expect(output).toContain('cache_idle = 300');
    expect(output).toContain('keep_alive = 1800');
  });

  test('default model is a fast 4b-class engine model; escalate_model empty (#522)', () => {
    expect(DEFAULT_CONFIG.auto_approve.model).toBe(expectedDefaultModel());
    expect(DEFAULT_CONFIG.auto_approve.escalate_model).toBe('');
  });

  // #822: the same weights in the container each backend can load. Asserted
  // as an explicit platform->id table rather than through the helper above,
  // so a wrong mapping cannot pass by matching a wrong expectation.
  test('the default model matches the backend the platform resolves to (#822)', () => {
    const backend = detectLocalLLMPlatform();
    const model = DEFAULT_CONFIG.auto_approve.model;
    if (backend === 'llamacpp') {
      expect(model).toContain('GGUF');
      // Explicit for determinism: `-hf` with no tag prefers Q4_K_M/Q8_0 then
      // falls back to the FIRST .gguf in the repo, which is order-dependent
      // if a second quant is ever published.
      expect(model).toContain(':Q4_0');
      expect(model).not.toContain('mlx');
    } else {
      expect(model).toContain('mlx');
      expect(model).not.toContain('GGUF');
    }
  });

  // CI runs ubuntu-latest ONLY, so detectLocalLLMPlatform() there is always
  // 'llamacpp' and the tests above exercise only the GGUF branch. The macOS
  // branch -- the primary shipping platform -- would be unprotected: making
  // defaultModel return the GGUF id unconditionally passes the merge gate
  // while shipping an id the engine rejects with 400 invalid_model, which
  // surfaces as "every question escalates" rather than as a broken daemon.
  // Injected args, like detectLocalLLMPlatform's own table test.
  test('defaultModel maps every platform, on every platform (#822)', () => {
    expect(defaultModel('darwin', 'arm64')).toBe('YoozLabs/Qwen3.5-4B-qat-lean-4bit-mlx');
    expect(defaultModel('linux', 'x64')).toBe('YoozLabs/Qwen3.5-4B-qat-GGUF:Q4_0');
    expect(defaultModel('linux', 'arm64')).toBe('YoozLabs/Qwen3.5-4B-qat-GGUF:Q4_0');
    // unsupported targets inherit the engine's value, matching defaultProvider's
    // 'yooz' fallback so the pair stays coherent.
    expect(defaultModel('darwin', 'x64')).toBe('YoozLabs/Qwen3.5-4B-qat-lean-4bit-mlx');
    expect(defaultModel('win32', 'x64')).toBe('YoozLabs/Qwen3.5-4B-qat-lean-4bit-mlx');
  });

  test('llamaServerCommand never prints an unrunnable -hf argument (#822)', () => {
    // provider = "llamacpp" on Apple Silicon is a real setup and nothing
    // validates provider/model consistency, so the configured id can be the
    // MLX default or empty. Printing `-hf ...-mlx` hands the user a command
    // that cannot load, which is worse than printing none.
    expect(llamaServerCommand()).toContain(':Q4_0');
    expect(llamaServerCommand('YoozLabs/Qwen3.5-4B-qat-lean-4bit-mlx')).toContain('GGUF');
    expect(llamaServerCommand('')).toContain('GGUF');
    // A real GGUF id is passed through untouched.
    expect(llamaServerCommand('YoozLabs/Qwen3.5-0.8B-qat-GGUF:Q4_0')).toContain('0.8B');
  });

  test('the llama-server command remi prints is runnable and matches the config default (#822)', () => {
    // The command in the boot message is the one thing a Linux user copies,
    // so it must carry the quant suffix, bind loopback, and name remi's
    // reserved port. Built from the same constant as the config default so
    // the two cannot drift.
    const cmd = llamaServerCommand('YoozLabs/Qwen3.5-4B-qat-GGUF:Q4_0');
    expect(cmd).toBe(
      'llama-server -hf YoozLabs/Qwen3.5-4B-qat-GGUF:Q4_0 --host 127.0.0.1 --port 19924',
    );
    // 19924 is remi's reserved port (see the ecosystem port table) and is what
    // LLM_PROVIDERS.llamacpp points the client at.
    expect(cmd).toContain('19924');
    expect(DEFAULT_CONFIG.auto_approve.base_url).toContain('19924');
  });

  // The TouchUp tiers read 38/38 on the permission grid but reach it partly by
  // returning no verdict at all (echoing the prompt back) on six of the most
  // dangerous scenarios, which only "pass" because unparsable => escalate.
  // Defaulting to one would be safety by accident (#809 Phase D, engine#303).
  // #822: the supported targets carry DIFFERENT backends, so one hardcoded
  // default is wrong on half of them. Apple Silicon runs the MLX engine; Linux
  // runs a llama.cpp sidecar; an Intel Mac runs neither, and must be told so at
  // boot rather than waiting 30s on an engine that cannot exist.
  test('the local-LLM backend is chosen by platform, not hardcoded', () => {
    expect(detectLocalLLMPlatform('darwin', 'arm64')).toBe('yooz');
    expect(detectLocalLLMPlatform('linux', 'x64')).toBe('llamacpp');
    expect(detectLocalLLMPlatform('linux', 'arm64')).toBe('llamacpp');
  });

  test('an Intel Mac is unsupported, not silently pointed at the MLX engine', () => {
    // The trap this guards: "macOS" reads like the boundary, but MLX makes it
    // Apple Silicon. Defaulting darwin-x64 to 'yooz' would look reasonable and
    // fail as a startup timeout.
    expect(detectLocalLLMPlatform('darwin', 'x64')).toBe('unsupported');
    expect(detectLocalLLMPlatform('win32', 'x64')).toBe('unsupported');
  });

  test('the shipped default provider matches this machine', () => {
    const expected = detectLocalLLMPlatform();
    if (expected !== 'unsupported') {
      expect(DEFAULT_CONFIG.auto_approve.provider).toBe(expected);
    } else {
      // Unsupported targets keep a stable config shape; the daemon reports the
      // gap at boot instead of the config pretending it away.
      expect(DEFAULT_CONFIG.auto_approve.provider).toBe('yooz');
    }
  });

  test('default model is not one of the engine TouchUp grammar tiers', () => {
    expect(['yooz-light-v3', 'yooz-quality-v3']).not.toContain(DEFAULT_CONFIG.auto_approve.model);
  });

  test('REMI_AUTO_APPROVE_ESCALATE_MODEL env override (#522)', () => {
    process.env['REMI_AUTO_APPROVE_ESCALATE_MODEL'] = 'yooz-heavy';
    const config = applyEnvOverrides(DEFAULT_CONFIG);
    expect(config.auto_approve.escalate_model).toBe('yooz-heavy');
    // biome-ignore lint/performance/noDelete: test isolation
    delete process.env['REMI_AUTO_APPROVE_ESCALATE_MODEL'];
  });

  test('rejects escalate_model as a non-string (#522)', () => {
    fs.writeFileSync(TEST_CONFIG, '[auto_approve]\nescalate_model = 35\n');
    expect(() => loadConfig(TEST_CONFIG)).toThrow(/escalate_model/);
  });

  test('masks auto_approve api_key', () => {
    const config = {
      ...DEFAULT_CONFIG,
      auto_approve: { ...DEFAULT_CONFIG.auto_approve, api_key: 'sk-secret' },
    };
    const output = formatConfig(config);
    expect(output).toContain('api_key = "***"');
    expect(output).not.toContain('sk-secret');
  });
});

describe('auto_approve config', () => {
  test('defaults are present', () => {
    expect(DEFAULT_CONFIG.auto_approve).toEqual({
      enabled: false,
      // ADR 0025: empty by default. No shipped config grants any agent type
      // anything the base does not already grant — a non-empty default here
      // would be a per-role permission nobody asked for.
      agents: {},
      // Resolved per platform (#822), so the expectation is too — but derived
      // from `detectLocalLLMPlatform` rather than from `DEFAULT_CONFIG`, which
      // would assert the value against itself and prove nothing.
      provider: expectedDefaultProvider(),
      model: expectedDefaultModel(),
      api_key: '',
      base_url: 'http://127.0.0.1:19924',
      timeout: 30,
      log_decisions: true,
      allow: ['Read', 'Glob', 'Grep'],
      deny: [],
      // #807: irreversible-only by default; broad patterns (curl/ssh) are
      // opt-in per machine because they fire constantly under agent fleets.
      subagent_alert: [
        'rm -rf',
        'rm -f',
        'push --force',
        'push -f ',
        'reset --hard',
        'DROP TABLE',
        'TRUNCATE',
        'sudo ',
        'chmod 777',
      ],
      approve_groups: ['read-only', 'vcs-read', 'build-test'],
      level: 'strict',
      deny_groups: [],
      instructions: '',
      multichoice: 'skip',
      multichoice_model: '',
      escalate_model: '',
      escalate_timeout: 0,
      queue_timeout: 240,
      cache_idle: 300,
      keep_alive: 1800,
      engine: 'owned' as const,
      engine_path: '',
      model_cache: '',
      disable_thinking: true,
      always_escalate_tools: ['AskUserQuestion', 'ExitPlanMode'],
      session_precedent: false,
      hold_timeout: 1800,
      push_hold_timeout: 60,
      delivery_confirm_timeout: 6,
      hold_unconfirmed_timeout: 0,
    });
  });

  test('loads auto_approve from TOML', () => {
    fs.writeFileSync(
      TEST_CONFIG,
      `
[auto_approve]
enabled = true
provider = "openrouter"
model = "anthropic/claude-3-haiku"
api_key = "sk-test"
timeout = 5
`,
    );

    const config = loadConfig(TEST_CONFIG);
    expect(config.auto_approve.enabled).toBe(true);
    expect(config.auto_approve.provider).toBe('openrouter');
    expect(config.auto_approve.model).toBe('anthropic/claude-3-haiku');
    expect(config.auto_approve.api_key).toBe('sk-test');
    expect(config.auto_approve.timeout).toBe(5);
    // Defaults preserved for unset fields
    expect(config.auto_approve.base_url).toBe('http://127.0.0.1:19924');
    expect(config.auto_approve.log_decisions).toBe(true);
  });

  test('rejects provider = "ollama" with an actionable error (#809)', () => {
    fs.writeFileSync(TEST_CONFIG, '[auto_approve]\nprovider = "ollama"\n');
    expect(() => loadConfig(TEST_CONFIG)).toThrow(/ollama support was removed/);
    expect(() => loadConfig(TEST_CONFIG)).toThrow(/"yooz"/);
  });

  test('loads always_escalate_tools from TOML (#572)', () => {
    fs.writeFileSync(TEST_CONFIG, '[auto_approve]\nalways_escalate_tools = ["MyTool"]\n');
    const config = loadConfig(TEST_CONFIG);
    expect(config.auto_approve.always_escalate_tools).toEqual(['MyTool']);
  });

  test('rejects always_escalate_tools as a non-array (#572)', () => {
    fs.writeFileSync(TEST_CONFIG, '[auto_approve]\nalways_escalate_tools = "AskUserQuestion"\n');
    expect(() => loadConfig(TEST_CONFIG)).toThrow(/always_escalate_tools/);
  });

  test('REMI_AUTO_APPROVE_ALWAYS_ESCALATE env override trims and drops empties (#572)', () => {
    process.env['REMI_AUTO_APPROVE_ALWAYS_ESCALATE'] = 'AskUserQuestion, mcp__custom , ';
    const config = applyEnvOverrides(DEFAULT_CONFIG);
    expect(config.auto_approve.always_escalate_tools).toEqual(['AskUserQuestion', 'mcp__custom']);
    // biome-ignore lint/performance/noDelete: test isolation
    delete process.env['REMI_AUTO_APPROVE_ALWAYS_ESCALATE'];
  });

  test('preserves auto_approve defaults when section missing', () => {
    fs.writeFileSync(TEST_CONFIG, '[daemon]\nbase_port = 19000\n');
    const config = loadConfig(TEST_CONFIG);
    expect(config.auto_approve).toEqual(DEFAULT_CONFIG.auto_approve);
  });

  test('REMI_AUTO_APPROVE env override', () => {
    process.env['REMI_AUTO_APPROVE'] = 'true';
    const config = applyEnvOverrides(DEFAULT_CONFIG);
    expect(config.auto_approve.enabled).toBe(true);
    // biome-ignore lint/performance/noDelete: test isolation
    delete process.env['REMI_AUTO_APPROVE'];
  });

  test('REMI_AUTO_APPROVE_MODEL env override', () => {
    process.env['REMI_AUTO_APPROVE_MODEL'] = 'gemma4:e2b';
    const config = applyEnvOverrides(DEFAULT_CONFIG);
    expect(config.auto_approve.model).toBe('gemma4:e2b');
    // biome-ignore lint/performance/noDelete: test isolation
    delete process.env['REMI_AUTO_APPROVE_MODEL'];
  });

  test('REMI_AUTO_APPROVE_API_KEY env override', () => {
    process.env['REMI_AUTO_APPROVE_API_KEY'] = 'sk-override';
    const config = applyEnvOverrides(DEFAULT_CONFIG);
    expect(config.auto_approve.api_key).toBe('sk-override');
    // biome-ignore lint/performance/noDelete: test isolation
    delete process.env['REMI_AUTO_APPROVE_API_KEY'];
  });

  test('REMI_AUTO_APPROVE=false disables when config has enabled=true', () => {
    const enabledConfig = {
      ...DEFAULT_CONFIG,
      auto_approve: { ...DEFAULT_CONFIG.auto_approve, enabled: true },
    };
    process.env['REMI_AUTO_APPROVE'] = 'false';
    const config = applyEnvOverrides(enabledConfig);
    expect(config.auto_approve.enabled).toBe(false);
    // biome-ignore lint/performance/noDelete: test isolation
    delete process.env['REMI_AUTO_APPROVE'];
  });

  test('REMI_AUTO_APPROVE_PROVIDER env override', () => {
    process.env['REMI_AUTO_APPROVE_PROVIDER'] = 'openrouter';
    const config = applyEnvOverrides(DEFAULT_CONFIG);
    expect(config.auto_approve.provider).toBe('openrouter');
    // biome-ignore lint/performance/noDelete: test isolation
    delete process.env['REMI_AUTO_APPROVE_PROVIDER'];
  });

  test('REMI_AUTO_APPROVE_BASE_URL env override', () => {
    process.env['REMI_AUTO_APPROVE_BASE_URL'] = 'http://custom:8080/v1';
    const config = applyEnvOverrides(DEFAULT_CONFIG);
    expect(config.auto_approve.base_url).toBe('http://custom:8080/v1');
    // biome-ignore lint/performance/noDelete: test isolation
    delete process.env['REMI_AUTO_APPROVE_BASE_URL'];
  });

  test('loads allow/deny/instructions from TOML', () => {
    fs.writeFileSync(
      TEST_CONFIG,
      `
[auto_approve]
enabled = true
allow = ["git status", "bun test", "bunx biome"]
deny = ["rm -rf /", "sudo "]
instructions = """
Approve all test runs.
Escalate anything touching secrets.
"""
`,
    );

    const config = loadConfig(TEST_CONFIG);
    expect(config.auto_approve.allow).toEqual(['git status', 'bun test', 'bunx biome']);
    expect(config.auto_approve.deny).toEqual(['rm -rf /', 'sudo ']);
    expect(config.auto_approve.instructions).toContain('Approve all test runs');
    expect(config.auto_approve.instructions).toContain('Escalate anything touching secrets');
  });

  test('allow defaults to safe read-only tools; deny/instructions default empty (#482)', () => {
    // An [auto_approve] section that omits `allow` inherits the safe read-only
    // tool defaults (Read/Glob/Grep); deny and instructions stay empty.
    fs.writeFileSync(TEST_CONFIG, '[auto_approve]\nenabled = true\n');
    const config = loadConfig(TEST_CONFIG);
    expect(config.auto_approve.allow).toEqual(['Read', 'Glob', 'Grep']);
    expect(config.auto_approve.deny).toEqual([]);
    expect(config.auto_approve.instructions).toBe('');
  });

  test('rejects allow as string (security: would match characters)', () => {
    fs.writeFileSync(TEST_CONFIG, '[auto_approve]\nallow = "git"\n');
    expect(() => loadConfig(TEST_CONFIG)).toThrow(/auto_approve\.allow/);
  });

  test('rejects deny as string', () => {
    fs.writeFileSync(TEST_CONFIG, '[auto_approve]\ndeny = "rm"\n');
    expect(() => loadConfig(TEST_CONFIG)).toThrow(/auto_approve\.deny/);
  });

  test('rejects instructions as array', () => {
    fs.writeFileSync(TEST_CONFIG, '[auto_approve]\ninstructions = ["line1", "line2"]\n');
    expect(() => loadConfig(TEST_CONFIG)).toThrow(/auto_approve\.instructions/);
  });

  test('rejects approve_groups as string', () => {
    fs.writeFileSync(TEST_CONFIG, '[auto_approve]\napprove_groups = "read-only"\n');
    expect(() => loadConfig(TEST_CONFIG)).toThrow(/auto_approve\.approve_groups/);
  });

  test('rejects deny_groups as string', () => {
    fs.writeFileSync(TEST_CONFIG, '[auto_approve]\ndeny_groups = "build-test"\n');
    expect(() => loadConfig(TEST_CONFIG)).toThrow(/auto_approve\.deny_groups/);
  });

  test('omitted *_groups inherit the default groups', () => {
    fs.writeFileSync(TEST_CONFIG, '[auto_approve]\nenabled = true\n');
    const config = loadConfig(TEST_CONFIG);
    expect(config.auto_approve.approve_groups).toEqual(['read-only', 'vcs-read', 'build-test']);
    expect(config.auto_approve.deny_groups).toEqual([]);
  });

  test('unknown group name warns but does not throw (ignored)', () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (msg?: unknown) => warnings.push(String(msg));
    try {
      fs.writeFileSync(TEST_CONFIG, '[auto_approve]\napprove_groups = ["read-only", "bogus"]\n');
      const config = loadConfig(TEST_CONFIG);
      expect(config.auto_approve.approve_groups).toEqual(['read-only', 'bogus']);
      expect(warnings.some((w) => w.includes('unknown permission group "bogus"'))).toBe(true);
    } finally {
      console.warn = original;
    }
  });

  test('loads hold_timeout / push_hold_timeout from TOML (#573)', () => {
    fs.writeFileSync(TEST_CONFIG, '[auto_approve]\nhold_timeout = 900\npush_hold_timeout = 45\n');
    const config = loadConfig(TEST_CONFIG);
    expect(config.auto_approve.hold_timeout).toBe(900);
    expect(config.auto_approve.push_hold_timeout).toBe(45);
  });

  test('rejects a negative hold_timeout (#573)', () => {
    fs.writeFileSync(TEST_CONFIG, '[auto_approve]\nhold_timeout = -1\n');
    expect(() => loadConfig(TEST_CONFIG)).toThrow(/hold_timeout/);
  });

  test('rejects a negative push_hold_timeout (#573)', () => {
    fs.writeFileSync(TEST_CONFIG, '[auto_approve]\npush_hold_timeout = -5\n');
    expect(() => loadConfig(TEST_CONFIG)).toThrow(/push_hold_timeout/);
  });

  test('rejects a negative delivery_confirm_timeout (#603)', () => {
    fs.writeFileSync(TEST_CONFIG, '[auto_approve]\ndelivery_confirm_timeout = -1\n');
    expect(() => loadConfig(TEST_CONFIG)).toThrow(/delivery_confirm_timeout/);
  });

  test('rejects a non-numeric delivery_confirm_timeout (#603)', () => {
    fs.writeFileSync(TEST_CONFIG, '[auto_approve]\ndelivery_confirm_timeout = "fast"\n');
    expect(() => loadConfig(TEST_CONFIG)).toThrow(/delivery_confirm_timeout/);
  });

  test('rejects a negative hold_unconfirmed_timeout (#603)', () => {
    fs.writeFileSync(TEST_CONFIG, '[auto_approve]\nhold_unconfirmed_timeout = -1\n');
    expect(() => loadConfig(TEST_CONFIG)).toThrow(/hold_unconfirmed_timeout/);
  });

  test('loads delivery_confirm_timeout / hold_unconfirmed_timeout from TOML (#603)', () => {
    fs.writeFileSync(
      TEST_CONFIG,
      '[auto_approve]\ndelivery_confirm_timeout = 8\nhold_unconfirmed_timeout = 180\n',
    );
    const config = loadConfig(TEST_CONFIG);
    expect(config.auto_approve.delivery_confirm_timeout).toBe(8);
    expect(config.auto_approve.hold_unconfirmed_timeout).toBe(180);
  });

  test('REMI_AUTO_APPROVE_HOLD_TIMEOUT / PUSH_HOLD_TIMEOUT env overrides (#573)', () => {
    process.env['REMI_AUTO_APPROVE_HOLD_TIMEOUT'] = '1200';
    process.env['REMI_AUTO_APPROVE_PUSH_HOLD_TIMEOUT'] = '90';
    const config = applyEnvOverrides(DEFAULT_CONFIG);
    expect(config.auto_approve.hold_timeout).toBe(1200);
    expect(config.auto_approve.push_hold_timeout).toBe(90);
    // biome-ignore lint/performance/noDelete: test isolation
    delete process.env['REMI_AUTO_APPROVE_HOLD_TIMEOUT'];
    // biome-ignore lint/performance/noDelete: test isolation
    delete process.env['REMI_AUTO_APPROVE_PUSH_HOLD_TIMEOUT'];
  });

  test('warns (does not throw) when push_hold_timeout > 0 but hold_timeout = 0 (FIX 4 / #573)', () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (msg?: unknown) => warnings.push(String(msg));
    try {
      fs.writeFileSync(TEST_CONFIG, '[auto_approve]\nhold_timeout = 0\npush_hold_timeout = 60\n');
      const config = loadConfig(TEST_CONFIG); // must NOT throw
      expect(config.auto_approve.hold_timeout).toBe(0);
      expect(config.auto_approve.push_hold_timeout).toBe(60);
      expect(
        warnings.some((w) => w.includes('push_hold_timeout') && w.includes('hold_timeout = 0')),
      ).toBe(true);
    } finally {
      console.warn = original;
    }
  });

  test('does NOT warn when both hold_timeout and push_hold_timeout are set (FIX 4 / #573)', () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (msg?: unknown) => warnings.push(String(msg));
    try {
      fs.writeFileSync(
        TEST_CONFIG,
        '[auto_approve]\nhold_timeout = 1800\npush_hold_timeout = 60\n',
      );
      loadConfig(TEST_CONFIG);
      expect(warnings.some((w) => w.includes('push_hold_timeout'))).toBe(false);
    } finally {
      console.warn = original;
    }
  });

  test('rejects allow with non-string elements', () => {
    fs.writeFileSync(TEST_CONFIG, '[auto_approve]\nallow = ["git", 42]\n');
    expect(() => loadConfig(TEST_CONFIG)).toThrow(/auto_approve\.allow/);
  });

  test('REMI_AUTO_APPROVE_ALLOW env var (comma-separated)', () => {
    process.env['REMI_AUTO_APPROVE_ALLOW'] = 'git status, bun test , Read';
    const config = applyEnvOverrides(DEFAULT_CONFIG);
    expect(config.auto_approve.allow).toEqual(['git status', 'bun test', 'Read']);
    // biome-ignore lint/performance/noDelete: test isolation
    delete process.env['REMI_AUTO_APPROVE_ALLOW'];
  });

  test('REMI_AUTO_APPROVE_DENY env var (newline-separated, trimmed)', () => {
    // Note: env vars strip surrounding whitespace. To use patterns with
    // trailing spaces (like "sudo " disambiguation), use the config file.
    process.env['REMI_AUTO_APPROVE_DENY'] = 'rm -rf /\nsudo -i\ncurl | sh';
    const config = applyEnvOverrides(DEFAULT_CONFIG);
    expect(config.auto_approve.deny).toEqual(['rm -rf /', 'sudo -i', 'curl | sh']);
    // biome-ignore lint/performance/noDelete: test isolation
    delete process.env['REMI_AUTO_APPROVE_DENY'];
  });

  test('REMI_AUTO_APPROVE_INSTRUCTIONS env var', () => {
    process.env['REMI_AUTO_APPROVE_INSTRUCTIONS'] = 'Be careful with git push';
    const config = applyEnvOverrides(DEFAULT_CONFIG);
    expect(config.auto_approve.instructions).toBe('Be careful with git push');
    // biome-ignore lint/performance/noDelete: test isolation
    delete process.env['REMI_AUTO_APPROVE_INSTRUCTIONS'];
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
    expect(DEFAULT_CONFIG.notifications).toEqual({
      on_turn_complete: true,
      turn_complete_min_seconds: 60,
    });
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
  });
});

describe('auto_approve.level (#963)', () => {
  /** Write a config and load it. Real file, real TOML parse -- no mocks. */
  function load(toml: string) {
    fs.writeFileSync(TEST_CONFIG, toml);
    return loadConfig(TEST_CONFIG);
  }

  test('a config with no level gets strict, i.e. today unchanged', () => {
    const c = load('[auto_approve]\nenabled = true\n');
    expect(c.auto_approve.level).toBe('strict');
    expect([...c.auto_approve.approve_groups].sort()).toEqual(
      ['build-test', 'read-only', 'vcs-read'].sort(),
    );
  });

  test('level = "balanced" adds fs-write', () => {
    const c = load('[auto_approve]\nlevel = "balanced"\n');
    expect(c.auto_approve.approve_groups).toContain('fs-write');
    expect(c.auto_approve.approve_groups).not.toContain('vcs-write');
  });

  test('level = "trusted" adds fs-write and vcs-write', () => {
    const c = load('[auto_approve]\nlevel = "trusted"\n');
    expect(c.auto_approve.approve_groups).toContain('fs-write');
    expect(c.auto_approve.approve_groups).toContain('vcs-write');
    // Still never the cut group, at any level (#961).
    expect(c.auto_approve.approve_groups).not.toContain('net-read');
  });

  test('an explicit approve_groups overrides the level', () => {
    // The upgrade-safety case: someone who set groups before levels existed
    // keeps exactly their behavior.
    const c = load('[auto_approve]\nlevel = "trusted"\napprove_groups = ["read-only"]\n');
    expect(c.auto_approve.approve_groups).toEqual(['read-only']);
    expect(c.auto_approve.level).toBe('trusted');
  });

  test('an explicit EMPTY approve_groups is respected', () => {
    // `[]` means "approve no groups" and must not be mistaken for "unset",
    // which would silently re-enable them.
    const c = load('[auto_approve]\nlevel = "trusted"\napprove_groups = []\n');
    expect(c.auto_approve.approve_groups).toEqual([]);
  });

  test('an explicit approve_groups WITHOUT a level still wins over the default preset', () => {
    // The pre-#963 config shape. Loading it must not have the strict preset
    // overwrite what the user wrote.
    const c = load('[auto_approve]\napprove_groups = ["build-test"]\n');
    expect(c.auto_approve.approve_groups).toEqual(['build-test']);
  });

  test('an invalid level is a startup error naming the valid ones', () => {
    expect(() => load('[auto_approve]\nlevel = "loose"\n')).toThrow(/level/);
    expect(() => load('[auto_approve]\nlevel = "loose"\n')).toThrow(/strict/);
  });

  test('a non-string level is refused too', () => {
    expect(() => load('[auto_approve]\nlevel = 3\n')).toThrow(/level/);
  });

  test('no config file at all yields the strict default', () => {
    const c = loadConfig(path.join(TEST_DIR, 'nope.toml'));
    expect(c.auto_approve.level).toBe('strict');
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

describe('per-agent policy survives the config LOAD path (ADR 0025)', () => {
  // Review found this untested end to end: `validateAgents`, `resolvePolicy`
  // and the service were each covered in isolation, but nothing wrote a real
  // TOML section and asserted it arrived. Deleting the `validateAgents(...)`
  // call from `loadConfig` left the whole suite green.
  //
  // It guards a live coupling, not just wiring: `mergeSection` iterates
  // `Object.keys(defaults)`, so a key absent from DEFAULT_CONFIG is silently
  // DROPPED. `agents: {}` in the defaults is the only reason a user's section
  // is reachable at all — and before this test, removing that line was pinned
  // solely by a `toEqual` snapshot that anyone deleting it would "fix".
  test('a real [auto_approve.agents.<type>] section reaches the loaded config', () => {
    fs.writeFileSync(
      TEST_CONFIG,
      `[auto_approve]
approve_groups = ["read-only"]

[auto_approve.agents.Explore]
approve_groups = ["read-only", "net-read"]
deny = ["curl"]
`,
    );
    const config = loadConfig(TEST_CONFIG);
    expect(config.auto_approve.agents?.['Explore']?.approve_groups).toEqual([
      'read-only',
      'net-read',
    ]);
    expect(config.auto_approve.agents?.['Explore']?.deny).toEqual(['curl']);
    // The base is untouched by the section.
    expect(config.auto_approve.approve_groups).toEqual(['read-only']);
  });

  test('an unknown KEY inside a section is rejected at load', () => {
    fs.writeFileSync(
      TEST_CONFIG,
      `[auto_approve.agents.Explore]
approve_group = ["read-only"]
`,
    );
    expect(() => loadConfig(TEST_CONFIG)).toThrow(/approve_group/);
  });

  test('an unknown GROUP name inside a section warns but loads', () => {
    // Warn, not throw: a throw reaches cli.ts's exit(1), and under the
    // --install LaunchAgent (KeepAlive.SuccessfulExit=false) that is a
    // crash-restart loop over a one-character typo. Matches the base path.
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(' '));
    };
    try {
      fs.writeFileSync(
        TEST_CONFIG,
        `[auto_approve.agents.Explore]
approve_groups = ["net-reed"]
`,
      );
      const config = loadConfig(TEST_CONFIG);
      expect(config.auto_approve.agents?.['Explore']?.approve_groups).toEqual(['net-reed']);
    } finally {
      console.warn = original;
    }
    // Because approve_groups REPLACES, this typo silently narrows the agent
    // below base — which is exactly why it must be reported.
    expect(warnings.join('\n')).toContain('net-reed');
  });
});
