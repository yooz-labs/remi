/**
 * The agent's process must not inherit remi's own secrets (#1249). Claude Code
 * or Codex, and every command they run, could read them from the environment:
 * the identity passphrase, the push bearer and the Telegram bot token.
 *
 * A real `/bin/sh` is spawned through the real `PTYSession` and prints its
 * environment; the planted secrets must be absent while a control variable and
 * the session's own `env` still arrive.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PTYSession } from '../src/pty/pty-session';

const SECRETS = {
  REMI_PASSPHRASE: 'passphrase-sentinel-1249',
  REMI_PUSH_SECRET: 'push-secret-sentinel-1249',
  TELEGRAM_BOT_TOKEN: 'bot-token-sentinel-1249',
} as const;
const CONTROL = { name: 'REMI_CHILD_ENV_CONTROL_1249', value: 'control-sentinel-1249' };

let session: PTYSession | null = null;
const saved = new Map<string, string | undefined>();

afterEach(async () => {
  try {
    await session?.close(2000);
  } finally {
    // Restored even if close throws: a planted secret must not leak into
    // later test files in the same process.
    session = null;
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
  }
});

function plant(name: string, value: string): void {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  process.env[name] = value;
}

async function childEnvironment(env?: Record<string, string>): Promise<string> {
  let output = '';
  let exited!: () => void;
  const done = new Promise<void>((resolve) => {
    exited = resolve;
  });
  session = new PTYSession(
    { command: '/bin/sh', args: ['-c', 'env; echo END-OF-ENV'], ...(env ? { env } : {}) },
    {
      onData: (data) => {
        output += data;
        if (output.includes('END-OF-ENV')) exited();
      },
      onExit: () => exited(),
    },
  );
  await session.start();
  await Promise.race([done, Bun.sleep(5000)]);
  return output;
}

describe("the agent's process does not inherit remi's secrets (#1249)", () => {
  test('the passphrase, the push bearer and the bot token are absent; other variables arrive', async () => {
    for (const [name, value] of Object.entries(SECRETS)) plant(name, value);
    plant(CONTROL.name, CONTROL.value);

    const output = await childEnvironment();

    expect(output).toContain('END-OF-ENV');
    expect(output).toContain(CONTROL.value);
    for (const value of Object.values(SECRETS)) expect(output).not.toContain(value);
  });

  test('a secret passed in the session env is dropped too, and the rest of that env arrives', async () => {
    const output = await childEnvironment({
      REMI_PUSH_SECRET: SECRETS.REMI_PUSH_SECRET,
      [CONTROL.name]: CONTROL.value,
    });

    expect(output).toContain(CONTROL.value);
    expect(output).not.toContain(SECRETS.REMI_PUSH_SECRET);
  });
});

describe('the denylist covers every secret the daemon reads (#1249)', () => {
  test('each environment variable read under packages/daemon/src whose name says secret is denied', async () => {
    const { REMI_SECRET_ENV } = await import('../src/pty/child-env');
    const names = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith('.ts')) {
          for (const m of readFileSync(path, 'utf8').matchAll(/['"`]([A-Z][A-Z0-9_]+)['"`]/g)) {
            const name = m[1] ?? '';
            if (/(SECRET|TOKEN|PASSPHRASE|PASSWORD|PRIVATE_KEY)/.test(name)) names.add(name);
          }
        }
      }
    };
    walk(join(import.meta.dir, '../src'));

    expect(names.size).toBeGreaterThan(0);
    for (const name of names) expect(REMI_SECRET_ENV).toContain(name);
  });
});
