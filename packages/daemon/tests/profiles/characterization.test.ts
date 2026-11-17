import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkLogin } from '../../src/profiles/login-check.ts';

const paths = [
  '/Library/Application Support/ClaudeCode/managed-settings.json',
  '/Library/Application Support/ClaudeCode/managed-settings.d',
  '/Library/Managed Preferences/com.anthropic.claudecode.plist',
  `/Library/Managed Preferences/${os.userInfo().username}/com.anthropic.claudecode.plist`,
  '/etc/claude-code/managed-settings.json',
  '/etc/claude-code/managed-settings.d',
];
const optedIn = process.env['REMI_CLAUDE_CHARACTERIZATION'] === '1';
const override = process.env['REMI_CLAUDE_CHARACTERIZATION_BIN'];
const command = optedIn ? (override ?? Bun.which('claude')) : null;
const found = optedIn ? paths.find((p) => fs.existsSync(p)) : undefined;
const reason = !optedIn
  ? 'opt-in not set'
  : !command
    ? 'claude not installed'
    : found
      ? `isolation preflight found ${found}`
      : '';
if (reason) console.log(`Claude characterization skipped: ${reason}`);

test.skipIf(!!reason)('characterizes isolated Claude status', async () => {
  if (!command) throw new Error('missing Claude');
  if (!path.isAbsolute(command)) throw new Error('Claude executable must be an absolute path');
  fs.accessSync(command, fs.constants.X_OK);
  if (!fs.statSync(command).isFile()) throw new Error('Claude executable must be a file');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-claude-characterization-'));
  try {
    const config = path.join(root, 'claude');
    const cwd = path.join(root, 'cwd');
    fs.mkdirSync(config);
    fs.mkdirSync(cwd);
    const env = {
      HOME: root,
      CLAUDE_CONFIG_DIR: config,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    };
    expect(
      (await checkLogin({ harness: 'claude', expects: 'subscription', env, cwd, command })).login,
    ).toBe('signed_out');
    expect(
      await checkLogin({
        harness: 'claude',
        expects: 'subscription',
        env: { ...env, ANTHROPIC_API_KEY: 'placeholder-not-a-credential' },
        cwd,
        command,
      }),
    ).toMatchObject({ login: 'not_own_login', source: 'ANTHROPIC_API_KEY' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
