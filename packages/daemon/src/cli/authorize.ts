/**
 * `remi authorize` - Manage authorized client keys.
 *
 * remi authorize <file-or-json>   Add a client's public key
 * remi authorize --remove <fp>    Remove a key by fingerprint
 * remi keys                       List authorized keys
 */

import * as fs from 'node:fs';
import { IdentityStore } from '../auth/identity-store.ts';

export interface AuthorizeOptions {
  input?: string | undefined;
  label?: string | undefined;
  remove?: string | undefined;
  dir?: string | undefined;
}

export async function runAuthorize(options: AuthorizeOptions): Promise<void> {
  const store = new IdentityStore(options.dir);

  // Remove mode
  if (options.remove) {
    const removed = store.removeAuthorizedKey(options.remove);
    if (removed) {
      console.log(`Removed key with fingerprint ${options.remove}`);
    } else {
      console.error(`No key found with fingerprint ${options.remove}`);
      process.exit(1);
    }
    return;
  }

  // Add mode
  if (!options.input) {
    console.error('Usage: remi authorize <public-key-file-or-json> [--label name]');
    console.error('       remi authorize --remove <fingerprint>');
    process.exit(1);
  }

  let json: string;
  if (fs.existsSync(options.input)) {
    json = fs.readFileSync(options.input, 'utf-8');
  } else {
    // Treat as inline JSON
    json = options.input;
  }

  let publicKey: string;
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    publicKey = parsed['publicKey'] as string;
    if (typeof publicKey !== 'string') {
      throw new Error('Missing publicKey field');
    }
  } catch (err) {
    console.error(
      `Failed to parse public key: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
    return; // unreachable, helps TS
  }

  const label = options.label ?? 'unnamed';

  try {
    const key = await store.addAuthorizedKey(publicKey, label);
    console.log('Authorized key added:');
    console.log(`  Fingerprint: ${key.fingerprint}`);
    console.log(`  Label:       ${key.label}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

export function runListKeys(dir?: string): void {
  const store = new IdentityStore(dir);
  const keys = store.listAuthorizedKeys();

  if (keys.length === 0) {
    console.log('No authorized keys.');
    console.log('Add one with: remi authorize <public-key-file>');
    return;
  }

  console.log(`${keys.length} authorized key(s):\n`);
  console.log('FINGERPRINT       LABEL            ADDED         LAST USED');
  console.log('----------------------------------------------------------------');

  for (const key of keys) {
    const added = new Date(key.addedAt).toLocaleDateString();
    const lastUsed = key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleDateString() : 'never';
    const fp = key.fingerprint.padEnd(18);
    const label = key.label.slice(0, 16).padEnd(17);
    console.log(`${fp}${label}${added.padEnd(14)}${lastUsed}`);
  }
}
