/**
 * `remi keygen` - Generate a new Ed25519 identity keypair.
 *
 * Prompts for a passphrase to encrypt the private key.
 * Writes identity to ~/.remi/identity.json with 0600 permissions.
 */

import { IdentityStore } from '../auth/identity-store.ts';

export interface KeygenOptions {
  passphrase?: string;
  force?: boolean;
  dir?: string;
}

export async function runKeygen(options: KeygenOptions = {}): Promise<void> {
  const store = new IdentityStore(options.dir);

  if (store.exists() && !options.force) {
    const existing = store.load();
    console.error(`Identity already exists (fingerprint: ${existing?.fingerprint ?? 'unknown'}).`);
    console.error('Use --force to overwrite.');
    process.exit(1);
  }

  let passphrase = options.passphrase;

  if (!passphrase) {
    passphrase = await promptPassphrase();
  }

  if (passphrase.length < 8) {
    console.error('Passphrase must be at least 8 characters.');
    process.exit(1);
  }

  console.log('Generating Ed25519 keypair...');
  const identity = await store.generate(passphrase);

  console.log('Identity generated successfully.');
  console.log(`  Fingerprint: ${identity.fingerprint}`);
  console.log('  Stored at:   ~/.remi/identity.json');
  console.log('');
  console.log('Share your public key with clients using: remi export-key --public-only');
}

async function promptPassphrase(): Promise<string> {
  process.stdout.write('Passphrase (min 8 chars): ');

  return new Promise((resolve) => {
    let input = '';
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');

    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode?.(false);
          process.stdin.pause();
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(input);
          return;
        }
        if (ch === '\x7f' || ch === '\b') {
          // Backspace
          if (input.length > 0) {
            input = input.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else if (ch === '\x03') {
          // Ctrl+C
          process.stdout.write('\n');
          process.exit(130);
        } else if (ch >= ' ') {
          input += ch;
          process.stdout.write('*');
        }
      }
    };

    process.stdin.on('data', onData);
  });
}
