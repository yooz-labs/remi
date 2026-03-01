/**
 * `remi import-key [file]` - Import an identity from JSON.
 *
 * Reads from file argument or stdin.
 * Writes to ~/.remi/identity.json.
 */

import * as fs from 'node:fs';
import { deserializeIdentity } from '@remi/shared';
import { IdentityStore } from '../auth/identity-store.ts';

export interface KeyImportOptions {
  file?: string | undefined;
  force?: boolean | undefined;
  dir?: string | undefined;
}

export async function runKeyImport(options: KeyImportOptions = {}): Promise<void> {
  const store = new IdentityStore(options.dir);

  if (store.exists() && !options.force) {
    const existing = store.load();
    console.error(`Identity already exists (fingerprint: ${existing?.fingerprint ?? 'unknown'}).`);
    console.error('Use --force to overwrite.');
    process.exit(1);
  }

  let json: string;

  if (options.file) {
    if (!fs.existsSync(options.file)) {
      console.error(`File not found: ${options.file}`);
      process.exit(1);
    }
    json = fs.readFileSync(options.file, 'utf-8');
  } else {
    // Read from stdin
    console.error('Reading identity from stdin (paste JSON, then Ctrl+D):');
    json = await readStdin();
  }

  try {
    const identity = deserializeIdentity(json);
    store.save(identity);
    console.log('Identity imported successfully.');
    console.log(`  Fingerprint: ${identity.fingerprint}`);
  } catch (err) {
    console.error(`Failed to import identity: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

async function readStdin(): Promise<string> {
  const chunks: string[] = [];
  process.stdin.setEncoding('utf-8');
  process.stdin.resume();

  return new Promise((resolve) => {
    process.stdin.on('data', (chunk: string) => {
      chunks.push(chunk);
    });
    process.stdin.on('end', () => {
      resolve(chunks.join(''));
    });
  });
}
