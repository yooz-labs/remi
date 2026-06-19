/**
 * JS → native bridge for the lock-screen answer relay (#591 P2).
 *
 * The iOS native handler (`RemiAnswerRelay.swift`) answers a held permission from
 * the lock screen WITHOUT opening the app: it signs the answer with the Ed25519
 * seed and POSTs it to the daemon's direct `/answer` endpoint (the same path
 * `relayAnswerDirect` uses in-app). The native code runs in a background launch
 * and cannot read the WebView's localStorage, so this module mirrors the minimum
 * it needs into UserDefaults via
 * `@capacitor/preferences` (which stores under `CapacitorStorage.<key>` — exactly
 * the keys `RemiNativeStore` reads natively):
 *
 *   - `remi-native-identity` : { seed, publicKey, fingerprint }  (the signer)
 *   - `remi-native-routes`   : { [sessionId]: { wsUrl, claudeSessionId? } }
 *
 * `wsUrl` is the daemon URL the session is connected on (the web app pins it on
 * hello_ack, the same value its cold-start push-answer routing uses). The native
 * handler POSTs the signed answer to that daemon's direct `/answer` endpoint.
 *
 * All writes are no-ops off-native (web/browser). The pure seed derivation +
 * crypto compatibility are proven in `@remi/shared` `tests/native-bridge.test.ts`
 * and `tests/ed25519-native-seed-compat.test.ts`.
 */

import { Preferences } from '@capacitor/preferences';
import { deriveNativeIdentity } from '@remi/shared';
import { loadIdentity } from './identity-client';
import { isNative } from './platform';

const IDENTITY_KEY = 'remi-native-identity';
const ROUTES_KEY = 'remi-native-routes';
/** Backstop cap on stored routes so a long-lived install can't grow unbounded
 *  if a teardown clear is ever missed. Routes are also dropped on eviction. */
const MAX_ROUTES = 32;

/** Per-session routing the native handler uses to reach the daemon. */
export interface NativeRoute {
  /** The daemon ws(s):// URL this session is connected on. */
  readonly wsUrl: string;
  readonly claudeSessionId?: string;
}

/**
 * Mirror the stored identity's signer to native storage so the lock-screen
 * handler can sign. Writes only an UNENCRYPTED identity's seed; if the identity
 * is encrypted or missing, any previously-bridged seed is CLEARED (so a stale
 * key can never sign after the user switches to an encrypted identity). No-op
 * off-native. Never throws — a bridge failure only means the lock-screen relay is
 * unavailable, which the handler already degrades to "open the app".
 */
export async function syncNativeIdentity(): Promise<void> {
  if (!isNative()) return;
  try {
    const identity = loadIdentity();
    const record = identity ? deriveNativeIdentity(identity) : null;
    if (!record) {
      await Preferences.remove({ key: IDENTITY_KEY });
      return;
    }
    await Preferences.set({ key: IDENTITY_KEY, value: JSON.stringify(record) });
  } catch (err) {
    console.warn('[remi] syncNativeIdentity failed (lock-screen relay unavailable):', err);
  }
}

/**
 * Record (or update) the daemon URL for a session so a lock-screen answer can
 * reach the daemon's `/answer` endpoint directly. Call at `hello_ack` for any
 * connection (direct or relay). No-op off-native; never throws.
 */
export async function setNativeRoute(sessionId: string, route: NativeRoute): Promise<void> {
  if (!isNative()) return;
  try {
    const routes = await readRoutes();
    routes[sessionId] = {
      wsUrl: route.wsUrl,
      ...(route.claudeSessionId ? { claudeSessionId: route.claudeSessionId } : {}),
    };
    // Backstop eviction (oldest first, never the entry we just wrote) so a
    // missed teardown can't grow the map without bound.
    const keys = Object.keys(routes);
    if (keys.length > MAX_ROUTES) {
      for (const k of keys.slice(0, keys.length - MAX_ROUTES)) {
        if (k !== sessionId) delete routes[k];
      }
    }
    await Preferences.set({ key: ROUTES_KEY, value: JSON.stringify(routes) });
  } catch (err) {
    console.warn('[remi] setNativeRoute failed:', err);
  }
}

/** Drop a session's relay route (e.g. on disconnect). No-op off-native; never throws. */
export async function clearNativeRoute(sessionId: string): Promise<void> {
  if (!isNative()) return;
  try {
    const routes = await readRoutes();
    if (!(sessionId in routes)) return;
    delete routes[sessionId];
    await Preferences.set({ key: ROUTES_KEY, value: JSON.stringify(routes) });
  } catch (err) {
    console.warn('[remi] clearNativeRoute failed:', err);
  }
}

/** Read + parse the routes map, tolerating a missing or corrupt value. */
async function readRoutes(): Promise<Record<string, NativeRoute>> {
  const { value } = await Preferences.get({ key: ROUTES_KEY });
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, NativeRoute>) : {};
  } catch {
    // Corrupt blob: start fresh rather than wedging every future write. Log it,
    // else "lock-screen answer stopped working after a crash" debugs blind.
    console.warn('[remi] native routes blob is corrupt; resetting');
    return {};
  }
}
