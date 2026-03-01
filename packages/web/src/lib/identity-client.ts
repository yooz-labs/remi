/**
 * Client-side identity management.
 *
 * Stores identity in localStorage (private key stays passphrase-encrypted).
 * Manages known hosts (TOFU model) for server fingerprint verification.
 */

import type { RemiIdentity, UnlockedIdentity } from '@remi/shared';
import { createIdentity, deserializeIdentity, serializeIdentity, unlockIdentity } from '@remi/shared';

const IDENTITY_KEY = 'remi-identity';
const KNOWN_HOSTS_KEY = 'remi-known-hosts';

/** Known host entry (TOFU) */
export interface KnownHost {
  readonly fingerprint: string;
  readonly publicKey: string;
  readonly firstSeen: string;
  readonly lastSeen: string;
}

/** Load stored identity (still encrypted) */
export function loadIdentity(): RemiIdentity | null {
  try {
    const stored = localStorage.getItem(IDENTITY_KEY);
    if (!stored) return null;
    return deserializeIdentity(stored);
  } catch {
    return null;
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

/** Generate a new identity and store it */
export async function generateIdentity(passphrase: string): Promise<RemiIdentity> {
  const identity = await createIdentity(passphrase);
  saveIdentity(identity);
  return identity;
}

/** Unlock a stored identity with passphrase */
export async function unlockStoredIdentity(passphrase: string): Promise<UnlockedIdentity> {
  const identity = loadIdentity();
  if (!identity) {
    throw new Error('No identity found');
  }
  return unlockIdentity(identity, passphrase);
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

/** Get the identity fingerprint without unlocking */
export function getFingerprint(): string | null {
  const identity = loadIdentity();
  return identity?.fingerprint ?? null;
}

// -- Known Hosts (TOFU) --

/** Load known hosts map */
export function loadKnownHosts(): Record<string, KnownHost> {
  try {
    const stored = localStorage.getItem(KNOWN_HOSTS_KEY);
    if (!stored) return {};
    return JSON.parse(stored) as Record<string, KnownHost>;
  } catch {
    return {};
  }
}

/** Save known hosts map */
function saveKnownHosts(hosts: Record<string, KnownHost>): void {
  localStorage.setItem(KNOWN_HOSTS_KEY, JSON.stringify(hosts));
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
  const existing = hosts[serverUrl];
  if (!existing) return 'new';
  return existing.fingerprint === fingerprint ? 'match' : 'mismatch';
}

/** Record a server fingerprint (TOFU - trust on first use) */
export function trustHost(serverUrl: string, fingerprint: string, publicKey: string): void {
  const hosts = loadKnownHosts();
  const now = new Date().toISOString();
  hosts[serverUrl] = {
    fingerprint,
    publicKey,
    firstSeen: hosts[serverUrl]?.firstSeen ?? now,
    lastSeen: now,
  };
  saveKnownHosts(hosts);
}

/** Remove a known host */
export function removeKnownHost(serverUrl: string): void {
  const hosts = loadKnownHosts();
  delete hosts[serverUrl];
  saveKnownHosts(hosts);
}
