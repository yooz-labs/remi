/**
 * `remi keygen` - Generate a new Ed25519 identity keypair.
 *
 * By default, creates an unencrypted identity for zero-friction startup.
 * Use --passphrase to encrypt the private key with a passphrase.
 * Writes identity to ~/.remi/identity.json with 0600 permissions.
 */

import { IdentityStore } from '../auth/identity-store.ts';
import { promptPassphrase } from './prompt-passphrase.ts';

export interface KeygenOptions {
  passphrase?: string | undefined;
  usePassphrase?: boolean | undefined;
  force?: boolean | undefined;
  dir?: string | undefined;
}

export async function runKeygen(options: KeygenOptions = {}): Promise<void> {
  const store = new IdentityStore(options.dir);

  if (store.exists() && !options.force) {
    let fp = 'unknown';
    try {
      fp = store.load()?.fingerprint ?? 'unknown';
    } catch {
      /* corrupt file; show unknown */
    }
    console.error(`Identity already exists (fingerprint: ${fp}).`);
    console.error('Use --force to overwrite.');
    process.exit(1);
  }

  let passphrase: string | undefined;

  if (options.passphrase) {
    // Explicit passphrase provided via env or option
    passphrase = options.passphrase;
  } else if (options.usePassphrase) {
    // --passphrase flag: prompt interactively
    passphrase = await promptPassphrase('Passphrase (min 8 chars)');
  }
  // Otherwise: no passphrase (unencrypted identity)

  if (passphrase !== undefined && passphrase.length < 8) {
    console.error('Passphrase must be at least 8 characters.');
    process.exit(1);
  }

  console.log('Generating Ed25519 keypair...');
  const identity = await store.generate(passphrase);

  console.log('Identity generated successfully.');
  console.log(`  Fingerprint: ${identity.fingerprint}`);
  console.log(`  Encrypted:   ${identity.iterations > 0 ? 'yes' : 'no'}`);
  console.log(`  Stored at:   ${store.identityPath}`);
}
