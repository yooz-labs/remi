import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkLogin } from '../../src/profiles/login-check.ts';

const dirs: string[] = [];
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-login-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function fake(dir: string, output: string, status = 0): string {
  const script = path.join(dir, 'fake-harness');
  fs.writeFileSync(script, `#!/bin/sh\nprintf '%s' ${JSON.stringify(output)}\nexit ${status}\n`, {
    mode: 0o700,
  });
  return script;
}
async function claude(data: unknown, expects = 'subscription') {
  const dir = scratch();
  const output = JSON.stringify(data);
  return checkLogin({
    harness: 'claude',
    expects,
    env: { HOME: dir, CLAUDE_CONFIG_DIR: dir },
    cwd: dir,
    command: fake(dir, output),
  });
}

describe('effective login checks', () => {
  test('maps subscription and API key states with a closed set of facts', async () => {
    expect((await claude({ loggedIn: true, authMethod: 'claude.ai' })).login).toBe('signed_in');
    expect((await claude({ loggedIn: false, authMethod: 'none' })).login).toBe('signed_out');
    expect(
      await claude({ loggedIn: true, authMethod: 'api_key', apiKeySource: 'apiKeyHelper' }),
    ).toMatchObject({ login: 'not_own_login', source: 'apiKeyHelper' });
    expect(await claude({ loggedIn: true, authMethod: 'unexpected' })).toMatchObject({
      login: 'not_own_login',
      source: 'other',
    });
    expect(
      (
        await claude(
          { loggedIn: true, authMethod: 'api_key', apiKeySource: 'apiKeyHelper' },
          'api_key',
        )
      ).login,
    ).toBe('signed_in');
    expect(
      (
        await claude(
          { loggedIn: true, authMethod: 'api_key_helper', apiKeySource: 'anything' },
          'api_key',
        )
      ).login,
    ).toBe('signed_in');
    expect(await claude({ loggedIn: true, authMethod: 'claude.ai' }, 'api_key')).toMatchObject({
      login: 'not_own_login',
      source: 'other',
    });
    expect(await claude({ loggedIn: false, authMethod: 'none' }, 'api_key')).toMatchObject({
      login: 'signed_out',
    });
    expect(await claude({ loggedIn: true, authMethod: 'api_key' }, 'api_key')).toMatchObject({
      login: 'not_own_login',
      source: 'other',
    });
    expect(
      await claude({ loggedIn: true, authMethod: 'api_key', apiKeySource: 'not-recognized' }),
    ).toMatchObject({ login: 'not_own_login', source: 'other' });
    expect(
      await claude({ loggedIn: true, authMethod: 'claude.ai', configDirectory: '/different' }),
    ).toMatchObject({ login: 'not_own_login', source: 'configDirectory' });
  });
  test('identity fields and malformed output do not escape', async () => {
    const dir = scratch();
    const remiHome = path.join(dir, 'remi');
    fs.mkdirSync(remiHome);
    const logs: string[] = [];
    for (const output of [
      JSON.stringify({
        loggedIn: true,
        authMethod: 'claude.ai',
        email: 'MARKER_EMAIL',
        orgId: 'MARKER_ORG',
        orgName: 'MARKER_NAME',
        subscriptionType: 'MARKER_SUB',
        planTier: 'MARKER_PLAN',
      }),
      JSON.stringify({
        loggedIn: true,
        authMethod: 'api_key',
        apiKeySource: '/login managed key',
        email: 'MARKER_EMAIL',
        orgId: 'MARKER_ORG',
        orgName: 'MARKER_NAME',
      }),
      JSON.stringify({
        loggedIn: true,
        authMethod: 'api_key',
        apiProvider: 'gateway',
        email: 'MARKER_EMAIL',
      }),
      '{"email":"MARKER_TRUNCATED',
    ]) {
      const result = await checkLogin({
        harness: 'claude',
        expects: 'subscription',
        env: { HOME: dir, CLAUDE_CONFIG_DIR: dir, REMI_HOME: remiHome },
        cwd: dir,
        command: fake(dir, output),
        log: (line) => logs.push(line),
      });
      expect(JSON.stringify(result)).not.toContain('MARKER_');
      if (output.startsWith('{"email"'))
        expect(result).toEqual({ login: 'unknown', reason: 'error' });
    }
    expect(JSON.stringify(logs)).not.toContain('MARKER_');
    expect(logs).toHaveLength(1);
    expect(fs.readdirSync(remiHome, { recursive: true })).toEqual([]);
  });
  test('refuses to consult Codex until file storage is explicit', async () => {
    const dir = scratch();
    const command = fake(dir, '', 0);
    const options = {
      harness: 'codex' as const,
      expects: 'subscription',
      env: { HOME: dir, CODEX_HOME: dir },
      cwd: dir,
      command,
    };
    expect(await checkLogin(options)).toEqual({ login: 'unknown', reason: 'not_checked' });
    fs.writeFileSync(path.join(dir, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n');
    expect(await checkLogin(options)).toEqual({ login: 'unknown', reason: 'not_checked' });
    fs.writeFileSync(path.join(dir, 'config.toml'), 'cli_auth_credentials_store = "file"\n');
    expect(await checkLogin(options)).toEqual({ login: 'signed_in' });
    expect(await checkLogin({ ...options, command: fake(dir, '', 1) })).toEqual({
      login: 'signed_out',
    });
    expect(await checkLogin({ ...options, command: fake(dir, '', 2) })).toEqual({
      login: 'unknown',
      reason: 'error',
    });
  });
  test('does not spawn for a missing directory or unknown expectation', async () => {
    const dir = scratch();
    const command = path.join(dir, 'fake');
    fs.writeFileSync(command, `#!/bin/sh\ntouch "${dir}/invoked"\n`, { mode: 0o700 });
    expect(
      await checkLogin({
        harness: 'claude',
        expects: 'subscription',
        env: { CLAUDE_CONFIG_DIR: path.join(dir, 'missing') },
        cwd: dir,
        command,
      }),
    ).toMatchObject({ login: 'signed_out' });
    expect(
      await checkLogin({
        harness: 'claude',
        expects: 'future_kind',
        env: { CLAUDE_CONFIG_DIR: dir },
        cwd: dir,
        command,
      }),
    ).toEqual({ login: 'unknown', reason: 'not_checked' });
    expect(fs.existsSync(path.join(dir, 'invoked'))).toBe(false);
  });
  test('missing executable reports unknown', async () => {
    const dir = scratch();
    expect(
      await checkLogin({
        harness: 'claude',
        expects: 'subscription',
        env: { CLAUDE_CONFIG_DIR: dir },
        cwd: dir,
        command: path.join(dir, 'missing'),
      }),
    ).toEqual({ login: 'unknown', reason: 'harness_missing' });
  });
  test('kills the spawned child on timeout', async () => {
    const dir = scratch();
    const command = path.join(dir, 'slow');
    const pidFile = path.join(dir, 'pid');
    fs.writeFileSync(command, `#!/bin/sh\necho $$ > "${pidFile}"\nexec /bin/sleep 10\n`, {
      mode: 0o700,
    });
    expect(
      await checkLogin({
        harness: 'claude',
        expects: 'subscription',
        env: { CLAUDE_CONFIG_DIR: dir },
        cwd: dir,
        command,
        timeoutMs: 500,
      }),
    ).toEqual({ login: 'unknown', reason: 'timeout' });
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
