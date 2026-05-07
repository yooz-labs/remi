/**
 * `remi keygen` - Generate a new Ed25519 identity keypair.
 *
 * By default, creates an unencrypted identity for zero-friction startup.
 * Use --passphrase to encrypt the private key with a passphrase.
 * Use --decrypt to remove the passphrase from an existing identity.
 * Use --encrypt to add a passphrase to an existing identity.
 * Writes identity to ~/.remi/identity.json with 0600 permissions.
 */

import { isEncrypted, rekeyIdentity } from '@remi/shared';
import { errorToString } from '@remi/shared';
import { IdentityStore } from '../auth/identity-store.ts';
import { promptPassphrase } from './prompt-passphrase.ts';

export interface KeygenOptions {
  passphrase?: string | undefined;
  usePassphrase?: boolean | undefined;
  force?: boolean | undefined;
  decrypt?: boolean | undefined;
  encrypt?: boolean | undefined;
  dir?: string | undefined;
}

export async function runKeygen(options: KeygenOptions = {}): Promise<void> {
  const store = new IdentityStore(options.dir);

  // Handle --decrypt: remove passphrase from existing identity
  if (options.decrypt) {
    const identity = store.load();
    if (!identity) {
      console.error('No identity found. Run "remi keygen" first.');
      process.exit(1);
    }
    if (!isEncrypted(identity)) {
      console.error('Identity is already unencrypted. Nothing to do.');
      process.exit(0);
    }

    // Get passphrase to unlock
    const envPassphrase = process.env['REMI_PASSPHRASE'];
    let oldPassphrase: string;
    if (envPassphrase) {
      oldPassphrase = envPassphrase;
    } else {
      oldPassphrase = await promptPassphrase('Current passphrase');
    }

    try {
      const rekeyed = await rekeyIdentity(identity, oldPassphrase, undefined);
      store.save(rekeyed);
      console.log('Passphrase removed. Identity is now unencrypted.');
      console.log(`  Fingerprint: ${rekeyed.fingerprint}`);
      console.log(`  Stored at:   ${store.identityPath}`);
    } catch (err) {
      const detail = errorToString(err);
      console.error(`Failed to decrypt identity: ${detail}. Wrong passphrase?`);
      process.exit(1);
    }
    return;
  }

  // Handle --encrypt: add passphrase to existing identity
  if (options.encrypt) {
    const identity = store.load();
    if (!identity) {
      console.error('No identity found. Run "remi keygen" first.');
      process.exit(1);
    }
    if (isEncrypted(identity)) {
      console.error(
        'Identity is already encrypted. Use --decrypt first to remove the existing passphrase, then --encrypt to set a new one.',
      );
      process.exit(1);
    }

    // Get new passphrase
    let newPassphrase: string;
    if (options.passphrase) {
      newPassphrase = options.passphrase;
    } else {
      newPassphrase = await promptPassphrase('New passphrase (min 8 chars)');
    }
    if (newPassphrase.length < 8) {
      console.error('Passphrase must be at least 8 characters.');
      process.exit(1);
    }

    try {
      const rekeyed = await rekeyIdentity(identity, undefined, newPassphrase);
      store.save(rekeyed);
      console.log('Passphrase added. Identity is now encrypted.');
      console.log(`  Fingerprint: ${rekeyed.fingerprint}`);
      console.log(`  Stored at:   ${store.identityPath}`);
    } catch (err) {
      const detail = errorToString(err);
      console.error(`Failed to encrypt identity: ${detail}`);
      process.exit(1);
    }
    return;
  }

  // Default: generate a new keypair
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
  console.log(`  Encrypted:   ${isEncrypted(identity) ? 'yes' : 'no'}`);
  console.log(`  Stored at:   ${store.identityPath}`);
}
