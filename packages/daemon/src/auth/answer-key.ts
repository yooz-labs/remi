/**
 * The daemon's long-lived answer key (#875).
 *
 * Phones seal lock-screen answers to this key's public half, which they pin
 * when they connect. It therefore has to outlive restarts: regenerating per
 * boot would invalidate every phone's pin and silently break the lock-screen
 * path until each one reconnected.
 *
 * Stored beside the identity in `~/.remi`, mode 0600. Anyone who can read this
 * file can open every answer ever sealed to it, including recorded ones; see
 * the forward-secrecy note in `shared/src/sealed-answer.ts` for why that
 * tradeoff exists and what it costs.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AnswerKeyPair } from '@remi/shared';
import { generateAnswerKeyPair } from '@remi/shared';

/** Owner read/write only. */
const SECRET_MODE = 0o600;

function defaultKeyPath(): string {
  return path.join(os.homedir(), '.remi', 'answer-key.json');
}

/**
 * Load the answer key, creating it on first use.
 *
 * Written with `wx` so two daemons starting together cannot clobber each
 * other's key: the loser re-reads the winner's. A key that changed under a
 * running phone would look like tampering rather than a race.
 */
export async function loadOrCreateAnswerKey(
  keyPath: string = defaultKeyPath(),
  logFn: (msg: string) => void = console.warn,
): Promise<AnswerKeyPair> {
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });

  const read = (): AnswerKeyPair | null => {
    try {
      const raw = fs.readFileSync(keyPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<AnswerKeyPair>;
      if (
        typeof parsed.publicKeyBase64 === 'string' &&
        typeof parsed.privateKeyPkcs8Base64 === 'string'
      ) {
        const mode = fs.statSync(keyPath).mode & 0o777;
        if (mode !== SECRET_MODE) {
          fs.chmodSync(keyPath, SECRET_MODE);
          logFn(
            `[answer-key] ${keyPath} was mode ${mode.toString(8)}; tightened to 600. Any process that read it can open every answer sealed to this daemon: delete the file to rotate, then reconnect each phone.`,
          );
        }
        return { ...(parsed as AnswerKeyPair) };
      }
      // A corrupt file is replaced rather than tolerated: a half-written key
      // would fail every decryption with no obvious cause.
      logFn(
        `[answer-key] ${keyPath} is unreadable; generating a new key. Reconnect phones to re-pin.`,
      );
      return null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  };

  const existing = read();
  if (existing) return existing;

  const generated = await generateAnswerKeyPair();
  try {
    fs.writeFileSync(keyPath, `${JSON.stringify(generated, null, 2)}\n`, {
      mode: SECRET_MODE,
      flag: 'wx',
    });
    return generated;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const raced = read();
    if (!raced) throw err;
    return raced;
  }
}
