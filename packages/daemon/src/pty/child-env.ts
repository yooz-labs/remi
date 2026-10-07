/**
 * The environment the agent's process gets (#1249).
 *
 * The harness (Claude Code, Codex) and every command it runs can read its
 * environment, so remi's own secrets never reach it: the identity passphrase,
 * the push bearer and the Telegram bot token. They are removed after the
 * session's own `env` is laid over `process.env`, so no launch path can hand
 * one through. A hub-spawned child daemon is not a harness and is spawned
 * elsewhere (`spawnDaemon`), so it still receives what it needs.
 *
 * `pty-child-env-secrets.test.ts` fails if the daemon reads a secret-named
 * variable that is not listed here.
 */

/** The environment variables remi reads that are secrets. */
export const REMI_SECRET_ENV: readonly string[] = [
  'REMI_PASSPHRASE',
  'REMI_PUSH_SECRET',
  'TELEGRAM_BOT_TOKEN',
];

/** `env` without remi's secrets (a copy; the input is not changed). */
export function withoutRemiSecrets(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const copy = { ...env };
  for (const name of REMI_SECRET_ENV) delete copy[name];
  return copy;
}
