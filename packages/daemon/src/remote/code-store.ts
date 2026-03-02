/**
 * Persistent storage for the signaling connection code.
 *
 * Stores the code in ~/.remi/connection-code so it persists across
 * daemon restarts, allowing clients to reconnect with the same code.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REMI_DIR = path.join(os.homedir(), '.remi');
const CODE_FILE = path.join(REMI_DIR, 'connection-code');

/** Unambiguous characters for code generation (no 0/O, 1/I/L) */
const ALPHA_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const NUMERIC_CHARS = '23456789';

/** Only accept codes using the unambiguous character set */
const CODE_PATTERN = /^[ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789]{4}$/;

function generateConnectionCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let alpha = '';
  let numeric = '';
  for (let i = 0; i < 4; i++) {
    // biome-ignore lint/style/noNonNullAssertion: index bounded by array length
    alpha += ALPHA_CHARS[bytes[i]! % ALPHA_CHARS.length];
  }
  for (let i = 0; i < 4; i++) {
    // biome-ignore lint/style/noNonNullAssertion: index bounded by array length
    numeric += NUMERIC_CHARS[bytes[4 + i]! % NUMERIC_CHARS.length];
  }
  return `${alpha}-${numeric}`;
}

export class CodeStore {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? CODE_FILE;
  }

  /** Load persisted code. Returns null if file missing or content invalid. */
  load(): string | null {
    try {
      const content = fs.readFileSync(this.filePath, 'utf-8').trim();
      if (CODE_PATTERN.test(content)) {
        return content;
      }
      return null;
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        'code' in err &&
        (err as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return null;
      }
      throw err;
    }
  }

  /** Save a code to disk with restrictive permissions. Creates ~/.remi/ if needed. */
  save(code: string): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, code, { encoding: 'utf-8', mode: 0o600 });
  }

  /** Generate a new code, save it, and return it. */
  refresh(): string {
    const code = generateConnectionCode();
    this.save(code);
    return code;
  }
}
