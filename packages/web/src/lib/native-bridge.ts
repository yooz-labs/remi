/** Public direct-answer routes for the native handler (#591/#1199).
 * Native identity ownership is in ClientIdentityStore. This bridge no longer
 * writes seeds or private bytes to Preferences. R4 migration verifies native
 * persistence before removing the legacy Preferences seed. Direct signed
 * /answer transport remains until R6; protected keys refuse background answers.
 */

import { Preferences } from '@capacitor/preferences';
import { currentNativeIdentity } from './native-identity';
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

/** Cleanup is permitted only after native migration removed the legacy web record. */
export async function syncNativeIdentity(): Promise<void> {
  if (!isNative() || !currentNativeIdentity() || loadIdentity()) return;
  await Preferences.remove({ key: IDENTITY_KEY });
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
