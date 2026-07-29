/**
 * Local capability token (#869).
 *
 * The Origin check from #535 stops a WEBSITE from answering permission
 * prompts. It cannot stop another PROCESS on the same machine, because a
 * process simply omits the `Origin` header and is then indistinguishable from
 * the CLI, which sends none either. Something has to be presented that a
 * stranger cannot produce.
 *
 * This is that thing: a random secret in `~/.remi/capability.key`, mode 0600,
 * which local clients read and send on the WebSocket upgrade.
 *
 * ## What it is worth, stated plainly
 *
 * A file readable by the user does not stop a process running AS that user
 * from reading it too. This raises the bar from "any local process can
 * approve a permission" to "any process that can read the user's home
 * directory can". That is a genuine improvement and it is not a boundary.
 * The real boundary needs OS-level peer credentials, which TCP loopback does
 * not provide on macOS; see the note in #869.
 *
 * ## Who can use it
 *
 * The CLI can: same user, same filesystem. A browser cannot, so browser
 * clients authenticate with the Ed25519 challenge they already implement for
 * remote daemons. The macOS app cannot either, and deliberately so: it is
 * sandboxed with no access to `~/.remi` (`packages/macos/Remi/Remi.entitlements`,
 * by design in #649/#651), which is why it is getting its own Ed25519 identity
 * rather than a copy of this secret.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Header carrying the token on the WebSocket upgrade. */
export const CAPABILITY_HEADER = 'x-remi-capability';

/** 32 bytes, hex-encoded: long enough that guessing is not a strategy. */
const TOKEN_BYTES = 32;

/** Owner read/write only. A capability anyone can read is not a capability. */
const SECRET_MODE = 0o600;

function defaultTokenPath(): string {
  return path.join(os.homedir(), '.remi', 'capability.key');
}

/**
 * Read the token, creating it if absent.
 *
 * Created with mode 0600 via the open flags rather than a later `chmod`, so
 * there is no window in which the file exists world-readable. An existing file
 * with looser permissions is tightened and reported, since a token other users
 * can read is worth exactly nothing and silently trusting it would be worse
 * than having none.
 */
export function loadOrCreateCapabilityToken(
  tokenPath: string = defaultTokenPath(),
  logFn: (msg: string) => void = console.warn,
): string {
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });

  try {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim();
    if (existing.length > 0) {
      const mode = fs.statSync(tokenPath).mode & 0o777;
      if (mode !== SECRET_MODE) {
        fs.chmodSync(tokenPath, SECRET_MODE);
        logFn(
          `[capability] ${tokenPath} was mode ${mode.toString(8)}; tightened to 600. Any process that read it before now holds a valid token: delete the file to rotate.`,
        );
      }
      return existing;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  // wx => fail if it appeared between the read above and now, rather than
  // clobbering a token another daemon just wrote and is already handing out.
  try {
    fs.writeFileSync(tokenPath, `${token}\n`, { mode: SECRET_MODE, flag: 'wx' });
    return token;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    return fs.readFileSync(tokenPath, 'utf8').trim();
  }
}

/** Read the token without creating one. Null when there is none to read. */
export function readCapabilityToken(tokenPath: string = defaultTokenPath()): string | null {
  try {
    const token = fs.readFileSync(tokenPath, 'utf8').trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/**
 * Constant-time comparison.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself leak
 * length, so both sides are hashed to a fixed width first.
 */
export function capabilityTokenMatches(
  presented: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (!presented || !expected) return false;
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}
