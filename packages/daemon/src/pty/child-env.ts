/**
 * The environment the agent's process gets (#1249).
 *
 * The harness (Claude Code, Codex) and every command it runs can read its
 * environment, so remi's own secrets are not inherited by it: the identity
 * passphrase, the push bearer and the Telegram bot token. They are removed
 * after the session's own `env` is laid over `process.env`, so no launch path
 * can hand one through. A hub-spawned child daemon is not a harness and is
 * spawned elsewhere (`spawnDaemon`), so it still receives what it needs.
 *
 * This stops inheritance only. A process running as the same user can still
 * read the daemon's own environment and arguments (`ps eww`, Linux's
 * `/proc/<pid>/environ`); keeping secrets out of the environment is #1252.
 * For Codex it covers the TUI remi launches; the commands Codex runs execute
 * in its shared app-server, which keeps the environment it was started with.
 *
 * `pty-child-env-secrets.test.ts` fails if a secret-named string literal
 * under `packages/daemon/src` is not listed here.
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
