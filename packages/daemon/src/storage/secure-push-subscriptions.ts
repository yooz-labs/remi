/** Restricted secure subscription records; mutations require the authorization lock (#1200). */
import { ECDH, createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type PushPreferences,
  type SecurePushRegistration,
  isSmallOrderPublicKey,
  relayV2,
} from '@remi/shared';
import { isAuthorityEpoch } from './authority-epoch.ts';
import { writeRestrictedJson } from './restricted-json.ts';

export interface StoredSecurePushSubscription extends SecurePushRegistration {
  readonly publicKey: string;
  readonly fingerprint: string;
  readonly authorizationEpoch: string;
  readonly enrollmentEpoch: string;
  readonly subscriptionEpoch: string;
  readonly pushPrefs: Required<PushPreferences>;
}
const PREFS = ['questions', 'turnComplete', 'harnessDenied', 'turnFailed'] as const;
const REGISTRATION = ['token', 'environment', 'pushPublicKey', 'keyVersion', 'pushPrefs'];
const STORED = [
  ...REGISTRATION,
  'publicKey',
  'fingerprint',
  'authorizationEpoch',
  'enrollmentEpoch',
  'subscriptionEpoch',
]
  .sort()
  .join(',');

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function normalizeSecureRegistration(
  value: unknown,
): SecurePushRegistration & { readonly pushPrefs: Required<PushPreferences> } {
  if (
    !record(value) ||
    Object.keys(value).some((key) => !REGISTRATION.includes(key)) ||
    typeof value['token'] !== 'string' ||
    !/^(?:[0-9a-f]{2}){1,256}$/.test(value['token']) ||
    (value['environment'] !== 'production' && value['environment'] !== 'sandbox') ||
    typeof value['pushPublicKey'] !== 'string' ||
    value['pushPublicKey'].length !== 87 ||
    typeof value['keyVersion'] !== 'number' ||
    !Number.isSafeInteger(value['keyVersion']) ||
    value['keyVersion'] < 1
  )
    throw new Error('INVALID_SUBSCRIPTION');
  const point = relayV2.fromB64u(value['pushPublicKey']);
  if (point.length !== 65 || point[0] !== 4) throw new Error('INVALID_SUBSCRIPTION');
  // Validate stored points synchronously too: read/decision helpers run under
  // the authority lock, where an async WebCrypto import cannot be awaited.
  ECDH.convertKey(point, 'prime256v1');
  const given = value['pushPrefs'];
  if (
    given !== undefined &&
    (!record(given) ||
      Object.keys(given).some((key) => !PREFS.includes(key as (typeof PREFS)[number])) ||
      PREFS.some((key) => key in given && typeof given[key] !== 'boolean'))
  )
    throw new Error('INVALID_SUBSCRIPTION');
  const pushPrefs = {
    questions: record(given) && 'questions' in given ? (given['questions'] as boolean) : true,
    turnComplete:
      record(given) && 'turnComplete' in given ? (given['turnComplete'] as boolean) : true,
    harnessDenied:
      record(given) && 'harnessDenied' in given ? (given['harnessDenied'] as boolean) : true,
    turnFailed: record(given) && 'turnFailed' in given ? (given['turnFailed'] as boolean) : true,
  };
  return Object.freeze({
    token: value['token'],
    environment: value['environment'],
    pushPublicKey: value['pushPublicKey'],
    keyVersion: value['keyVersion'],
    pushPrefs: Object.freeze(pushPrefs),
  });
}

export function readSecurePushSubscriptions(directory: string): StoredSecurePushSubscription[] {
  let value: unknown;
  try {
    const file = path.join(directory, 'secure_push_subscriptions.json');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024)
      throw new Error('bounds');
    const bytes = fs.readFileSync(file);
    if (bytes.length > 128 * 1024) throw new Error('bounds');
    value = JSON.parse(bytes.toString('utf8'));
    if (
      !record(value) ||
      Object.keys(value).sort().join(',') !== 'subscriptions,version' ||
      value['version'] !== 1 ||
      !Array.isArray(value['subscriptions']) ||
      value['subscriptions'].length > 64
    )
      throw new Error('format');
    const seen = new Set<string>();
    for (const item of value['subscriptions']) {
      if (
        !record(item) ||
        Object.keys(item).sort().join(',') !== STORED ||
        typeof item['publicKey'] !== 'string' ||
        typeof item['fingerprint'] !== 'string' ||
        !isAuthorityEpoch(item['authorizationEpoch']) ||
        !isAuthorityEpoch(item['enrollmentEpoch']) ||
        !isAuthorityEpoch(item['subscriptionEpoch']) ||
        seen.has(item['publicKey'])
      )
        throw new Error('format');
      const publicKey = Buffer.from(item['publicKey'], 'base64');
      if (
        publicKey.length !== 32 ||
        publicKey.toString('base64') !== item['publicKey'] ||
        isSmallOrderPublicKey(publicKey) ||
        createHash('sha256').update(publicKey).digest('hex').slice(0, 16) !== item['fingerprint']
      )
        throw new Error('format');
      normalizeSecureRegistration({
        token: item['token'],
        environment: item['environment'],
        pushPublicKey: item['pushPublicKey'],
        keyVersion: item['keyVersion'],
        pushPrefs: item['pushPrefs'],
      });
      if (
        !record(item['pushPrefs']) ||
        Object.keys(item['pushPrefs']).sort().join(',') !== [...PREFS].sort().join(',')
      )
        throw new Error('format');
      seen.add(item['publicKey']);
    }
    return value['subscriptions'] as StoredSecurePushSubscription[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error('SECURE_PUSH_STORE_ERROR');
  }
}
export function writeSecurePushSubscriptions(
  directory: string,
  subscriptions: readonly StoredSecurePushSubscription[],
): void {
  try {
    writeRestrictedJson(path.join(directory, 'secure_push_subscriptions.json'), {
      version: 1,
      subscriptions,
    });
  } catch {
    throw new Error('SECURE_PUSH_STORE_ERROR');
  }
}

/** Grant removal is durable FIRST; this helper never acquires a nested lock. */
export function purgeSecurePushSubscriptionsLocked(
  directory: string,
  publicKeys: readonly string[],
): void {
  const subscriptions = readSecurePushSubscriptions(directory);
  const kept = subscriptions.filter((entry) => !publicKeys.includes(entry.publicKey));
  if (kept.length !== subscriptions.length) writeSecurePushSubscriptions(directory, kept);
}
