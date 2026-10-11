/**
 * `remi authorize` - Manage authorized client keys.
 *
 * remi authorize <fingerprint-or-file-or-json>   Add a client's public key
 * remi authorize --remove <fp>    Remove a key by fingerprint
 * remi keys                       List authorized keys
 */

import * as fs from 'node:fs';
import { boundedEscape, errorToString, escapeUnsafeText } from '@remi/shared';
import { IdentityStore } from '../auth/identity-store.ts';

const PRIVATE_IDENTITY_FIELDS = ['encryptedPrivateKey', 'salt', 'iv', 'iterations'] as const;
const KEY_LABEL_MAX_CODE_POINTS = 64;
const KEY_LABEL_TABLE_MAX = 16;
const KEY_LABEL_OUTPUT_MAX = 128;

/** Keep the terminal on one line while preserving a visible marker for legacy tabs and newlines. */
function oneLineLabel(label: string): string {
  return label.replaceAll('\t', '\u2409').replaceAll('\n', '\u240a');
}

function wellFormedUtf16(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function hasControl(text: string): boolean {
  for (const character of text) {
    const codePoint = character.codePointAt(0) as number;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return true;
  }
  return false;
}

/** The public CLI accepts only labels that can be read as-is and safely put in its commands. */
function isSafeKeyLabel(label: string): boolean {
  return (
    wellFormedUtf16(label) &&
    [...label].length > 0 &&
    [...label].length <= KEY_LABEL_MAX_CODE_POINTS &&
    label.trim().length > 0 &&
    !label.startsWith('-') &&
    !hasControl(label) &&
    escapeUnsafeText(label) === label
  );
}

function invalidLabel(): never {
  console.error(
    'Invalid label: use 1 to 64 visible, well-formed Unicode characters and do not start with a hyphen.',
  );
  process.exit(1);
}

function invalidPublicKeyInput(): never {
  console.error('Invalid public key input: expected a JSON object with a publicKey string.');
  process.exit(1);
}

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
    console.error(
      'Usage: remi authorize <exact-pending-fingerprint-or-public-key-file-or-json> [--label name]',
    );
    console.error('       remi authorize --remove <fingerprint>');
    process.exit(1);
  }

  const label = options.label ?? 'unnamed';
  if (!isSafeKeyLabel(label)) invalidLabel();

  if (/^[0-9a-f]{16}$/.test(options.input)) {
    try {
      const key = await store.authorizePendingKey(options.input, label);
      console.log(
        `Authorized pending key: ${key.fingerprint} [${boundedEscape(oneLineLabel(key.label), KEY_LABEL_OUTPUT_MAX)}]`,
      );
    } catch (err) {
      console.error(errorToString(err));
      process.exit(1);
    }
    return;
  }

  let json: string;
  try {
    json = fs.existsSync(options.input) ? fs.readFileSync(options.input, 'utf-8') : options.input;
  } catch {
    console.error('Could not read public key input.');
    process.exit(1);
    return;
  }

  let publicKey: string;
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      invalidPublicKeyInput();
    }
    const record = parsed as Record<string, unknown>;
    if (PRIVATE_IDENTITY_FIELDS.some((field) => Object.hasOwn(record, field))) {
      console.error('Refusing private identity data; use a public-only key export.');
      process.exit(1);
      return;
    }
    publicKey = record['publicKey'] as string;
    if (typeof publicKey !== 'string') {
      invalidPublicKeyInput();
    }
  } catch {
    // Parsing errors can contain the offending input. Keep malformed key material out of output.
    invalidPublicKeyInput();
    return;
  }

  try {
    const key = await store.addAuthorizedKey(publicKey, label);
    console.log('Authorized key added:');
    console.log(`  Fingerprint: ${key.fingerprint}`);
    console.log(`  Label:       ${boundedEscape(oneLineLabel(key.label), KEY_LABEL_OUTPUT_MAX)}`);
  } catch (err) {
    console.error(errorToString(err));
    process.exit(1);
  }
}

export function runListKeys(dir?: string): void {
  const store = new IdentityStore(dir);
  const keys = store.listAuthorizedKeys();

  if (keys.length === 0) {
    console.log('No authorized keys.');
    console.log('Add one with: remi authorize <public-key-file>');
  }

  console.log(`${keys.length} authorized key(s):\n`);
  console.log('FINGERPRINT       LABEL            ADDED         LAST USED');
  console.log('----------------------------------------------------------------');

  for (const key of keys) {
    const added = new Date(key.addedAt).toLocaleDateString();
    const lastUsed = key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleDateString() : 'never';
    const fp = key.fingerprint.padEnd(18);
    const label = boundedEscape(oneLineLabel(key.label), KEY_LABEL_TABLE_MAX).padEnd(17);
    console.log(`${fp}${label}${added.padEnd(14)}${lastUsed}`);
    console.log(`  Public key: ${key.publicKey}`);
  }
  const pending = store.listPendingKeys();
  console.log(`\n${pending.length} pending key(s) awaiting local approval:`);
  for (const key of pending) {
    console.log(`  Fingerprint: ${key.fingerprint}  Expires: ${key.expiresAt}`);
    console.log(`  Public key:  ${key.publicKey}`);
    console.log(`  Approve:     remi authorize ${key.fingerprint} --label device-name`);
  }
  console.log(
    'Compare the fingerprint on the client before approving. For explicit imports use remi export-key --public-only.',
  );
}
