/**
 * `remi export-key` - Export identity for sharing across devices.
 *
 * --public-only: Output only the public key (for authorizing on daemon).
 * Default: Output full identity JSON (encrypted private key included).
 */

import { serializeIdentity } from '@remi/shared';
import { IdentityStore } from '../auth/identity-store.ts';

export interface KeyExportOptions {
  publicOnly?: boolean;
  dir?: string;
}

export function runKeyExport(options: KeyExportOptions = {}): void {
  const store = new IdentityStore(options.dir);
  const identity = store.load();

  if (!identity) {
    console.error('No identity found. Run `remi keygen` first.');
    process.exit(1);
  }

  if (options.publicOnly) {
    const publicInfo = {
      publicKey: identity.publicKey,
      fingerprint: identity.fingerprint,
    };
    console.log(JSON.stringify(publicInfo, null, 2));
  } else {
    console.log(serializeIdentity(identity));
  }
}
