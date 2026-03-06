/**
 * Client-side identity management.
 *
 * Stores identity in localStorage (private key stays passphrase-encrypted).
 * Manages known hosts (TOFU model) for server fingerprint verification.
 */

import type { KnownHost, RemiIdentity, UnlockedIdentity } from '@remi/shared';
import { createIdentity, deserializeIdentity, isEncrypted, serializeIdentity, unlockIdentity } from '@remi/shared';

export type { KnownHost };

const IDENTITY_KEY = 'remi-identity';
const KNOWN_HOSTS_KEY = 'remi-known-hosts';

/** Load stored identity (still encrypted). Returns null if not found. Throws on corrupt data. */
export function loadIdentity(): RemiIdentity | null {
  const stored = localStorage.getItem(IDENTITY_KEY);
  if (!stored) return null;
  try {
    return deserializeIdentity(stored);
  } catch (err) {
    console.error('[remi] Stored identity is corrupt:', err);
    throw new Error(
      'Your stored identity is corrupt. You may need to remove and re-create it in Settings.',
    );
  }
}

/** Save identity to localStorage */
export function saveIdentity(identity: RemiIdentity): void {
  localStorage.setItem(IDENTITY_KEY, serializeIdentity(identity));
}

/** Remove identity from localStorage */
export function removeIdentity(): void {
  localStorage.removeItem(IDENTITY_KEY);
}

/** Check if an identity exists */
export function hasIdentity(): boolean {
  return localStorage.getItem(IDENTITY_KEY) !== null;
}

/** Generate a new identity and store it. Without a passphrase, the key is stored unencrypted. */
export async function generateIdentity(passphrase?: string): Promise<RemiIdentity> {
  const identity = await createIdentity(passphrase);
  saveIdentity(identity);
  return identity;
}

/** Unlock a stored identity. Encrypted identities require a passphrase. */
export async function unlockStoredIdentity(passphrase?: string): Promise<UnlockedIdentity> {
  const identity = loadIdentity();
  if (!identity) {
    throw new Error('No identity found');
  }
  return unlockIdentity(identity, passphrase);
}

/** Check if the stored identity has an encrypted private key. */
export function isIdentityEncrypted(): boolean {
  const identity = loadIdentity();
  if (!identity) return false;
  return isEncrypted(identity);
}

/** Ensure an identity exists. Auto-generates an unencrypted one if missing. */
export async function ensureIdentity(): Promise<RemiIdentity> {
  const existing = loadIdentity();
  if (existing) return existing;
  return generateIdentity();
}

/** Import identity from JSON string */
export function importIdentity(json: string): RemiIdentity {
  const identity = deserializeIdentity(json);
  saveIdentity(identity);
  return identity;
}

/** Export identity as JSON string */
export function exportIdentity(): string | null {
  const identity = loadIdentity();
  if (!identity) return null;
  return serializeIdentity(identity);
}

/** Get the identity fingerprint without unlocking. Returns null on missing or corrupt data. */
export function getFingerprint(): string | null {
  try {
    const identity = loadIdentity();
    return identity?.fingerprint ?? null;
  } catch {
    return null;
  }
}

// -- Known Hosts (TOFU) --

/** Load known hosts map. Throws on corrupt data. */
export function loadKnownHosts(): Record<string, KnownHost> {
  const stored = localStorage.getItem(KNOWN_HOSTS_KEY);
  if (!stored) return {};
  try {
    return JSON.parse(stored) as Record<string, KnownHost>;
  } catch {
    throw new Error(
      'Known hosts data is corrupt. Remove the entry from localStorage (key: remi-known-hosts) to reset.',
    );
  }
}

/** Save known hosts map */
function saveKnownHosts(hosts: Record<string, KnownHost>): void {
  localStorage.setItem(KNOWN_HOSTS_KEY, JSON.stringify(hosts));
}

/** Normalize a URL for use as TOFU host key (strip trailing slashes, lowercase host). */
function normalizeHostKey(url: string): string {
  return url.replace(/\/+$/, '').toLowerCase();
}

/**
 * Check a server's fingerprint against known hosts.
 * Returns 'new' if never seen, 'match' if same, 'mismatch' if changed.
 */
export function checkKnownHost(
  serverUrl: string,
  fingerprint: string,
): 'new' | 'match' | 'mismatch' {
  const hosts = loadKnownHosts();
  const existing = hosts[normalizeHostKey(serverUrl)];
  if (!existing) return 'new';
  return existing.fingerprint === fingerprint ? 'match' : 'mismatch';
}

/** Record a server fingerprint (TOFU - trust on first use) */
export function trustHost(serverUrl: string, fingerprint: string, publicKey: string): void {
  const hosts = loadKnownHosts();
  const key = normalizeHostKey(serverUrl);
  const now = new Date().toISOString();
  hosts[key] = {
    fingerprint,
    publicKey,
    firstSeen: hosts[key]?.firstSeen ?? now,
    lastSeen: now,
  };
  saveKnownHosts(hosts);
}

/** Remove a known host */
export function removeKnownHost(serverUrl: string): void {
  const hosts = loadKnownHosts();
  delete hosts[normalizeHostKey(serverUrl)];
  saveKnownHosts(hosts);
}
