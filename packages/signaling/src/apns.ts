/**
 * APNS (Apple Push Notification Service) HTTP/2 client.
 * Uses JWT-based authentication with a p8 key.
 */

interface ApnsPayload {
  token: string;
  title: string;
  body: string;
  bundleId: string;
  /** Custom data fields included at top-level of APNS payload (sibling to aps).
   *  Must be flat string values — nested objects are dropped by iOS. */
  data?: Record<string, string>;
  /** Use APNS sandbox endpoint (development builds) */
  sandbox?: boolean;
  /** UNNotificationCategory identifier for action buttons (lock screen / Watch) */
  category?: string;
  /**
   * Collapse identifier (#575, P4a). Sent as the `apns-collapse-id` header AND
   * used to de-dup at the device. A re-push for the same questionId replaces the
   * earlier notification instead of stacking a duplicate. Apple caps this at 64
   * bytes; callers pass a questionId (a UUID, well within the limit).
   */
  collapseId?: string;
  /**
   * Dismissal push (#585, P7). When true the push is QUIET: no `alert`, no
   * `sound`, no `badge` bump — only `content-available: 1` plus the
   * `apns-collapse-id` header. iOS replaces the earlier notification for the same
   * collapse-id with this contentless update, so the lock-screen card for an
   * already-resolved question is cleared/superseded. The app's
   * `didReceiveRemoteNotification` handler then calls
   * `removeDeliveredNotifications(withIdentifiers:)` to drop it entirely
   * (native-only; see web/Capacitor handler).
   */
  dismiss?: boolean;
}

interface ApnsConfig {
  keyId: string;
  teamId: string;
  privateKey: string;
}

/** The fully-resolved APNS HTTP/2 request (URL + headers + JSON body string). */
export interface ApnsRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * Build the APNS HTTP/2 request (URL, headers, body) from a payload + JWT.
 *
 * Extracted as a pure function so the payload shape — including the #575 P4a
 * `content-available` pre-wake flag and the `apns-collapse-id` header — can be
 * asserted directly in tests without intercepting the network.
 *
 * Throws if `payload.data` contains the reserved `aps` key (would clobber the
 * APNS dictionary).
 */
export function buildApnsRequest(payload: ApnsPayload, jwt: string): ApnsRequest {
  const apnsHost = payload.sandbox ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
  const url = `https://${apnsHost}/3/device/${payload.token}`;

  // Guard against reserved APNS key collision in custom data
  if (payload.data && 'aps' in payload.data) {
    throw new Error('ApnsPayload.data must not contain reserved key "aps"');
  }

  // apns-collapse-id (#575, P4a): a re-push for the same question replaces the
  // prior notification on the device instead of stacking a duplicate. Apple
  // caps the value at 64 bytes; a questionId UUID is well within that.
  const collapseId =
    payload.collapseId && payload.collapseId.length > 0
      ? payload.collapseId.slice(0, 64)
      : undefined;

  // A dismissal (#585, P7) is a QUIET background push: it carries no alert and
  // must use the `background` push type at low priority, or APNS rejects a
  // content-available-only payload sent as `alert`. The collapse-id ties it to
  // the original card so iOS supersedes it; the app then removes the delivered
  // notification on receipt.
  const headers: Record<string, string> = {
    authorization: `bearer ${jwt}`,
    'apns-topic': payload.bundleId,
    'apns-push-type': payload.dismiss ? 'background' : 'alert',
    'apns-priority': payload.dismiss ? '5' : '10',
    ...(collapseId ? { 'apns-collapse-id': collapseId } : {}),
  };

  const aps: Record<string, unknown> = payload.dismiss
    ? {
        // Quiet update only: no alert, no sound, no badge bump. iOS replaces the
        // earlier collapse-id card and wakes the app to remove it.
        'content-available': 1,
      }
    : {
        alert: {
          title: payload.title,
          body: payload.body,
        },
        sound: 'default',
        badge: 1,
        // content-available pre-wakes the app in the background so the
        // WebSocket can start reconnecting before the user taps (#575, P4a).
        // Kept alongside the alert so the interactive notification still
        // renders; iOS treats this as a normal alert push with a background
        // wake opportunity.
        'content-available': 1,
        ...(payload.category ? { category: payload.category } : {}),
      };

  const body = JSON.stringify({
    aps,
    ...(payload.data ? payload.data : {}),
  });

  return { url, headers, body };
}

/**
 * Send a push notification via APNS HTTP/2 API.
 * Uses JWT bearer token authentication.
 */
export async function sendApnsPush(
  payload: ApnsPayload,
  config: ApnsConfig,
): Promise<{ success: boolean; error?: string }> {
  const jwt = await createApnsJwt(config);
  const { url, headers, body } = buildApnsRequest(payload, jwt);

  const response = await fetch(url, { method: 'POST', headers, body });

  if (response.ok) {
    return { success: true };
  }

  const errorBody = await response.text().catch(() => '');
  return { success: false, error: `APNS ${response.status}: ${errorBody}` };
}

/** Cache APNS JWTs per keyId: Apple rate-limits token updates to once per 20 min. */
const jwtCache = new Map<string, { jwt: string; iat: number }>();
/** Reuse a cached JWT if it is younger than 50 minutes (3000 s). */
const JWT_MAX_AGE_S = 3000;

/**
 * Create a JWT for APNS authentication.
 * Uses ES256 algorithm with the p8 private key.
 * The JWT is cached per keyId and reused until it is 50 minutes old to avoid
 * APNS TooManyProviderTokenUpdates (429) errors.
 */
async function createApnsJwt(config: ApnsConfig): Promise<string> {
  const nowS = Math.floor(Date.now() / 1000);
  const cached = jwtCache.get(config.keyId);
  if (cached && nowS - cached.iat < JWT_MAX_AGE_S) {
    return cached.jwt;
  }

  const header = {
    alg: 'ES256',
    kid: config.keyId,
  };

  const payload = {
    iss: config.teamId,
    iat: nowS,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  // Import the P8 private key
  const keyData = pemToArrayBuffer(config.privateKey);
  const key = await crypto.subtle.importKey(
    'pkcs8',
    keyData,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );

  // Sign
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(signingInput),
  );

  // WebCrypto SubtleCrypto returns ECDSA signature in raw r||s format (IEEE P1363) — no conversion needed
  const encodedSignature = base64UrlEncode(new Uint8Array(signature));

  const jwt = `${signingInput}.${encodedSignature}`;
  jwtCache.set(config.keyId, { jwt, iat: nowS });
  return jwt;
}

function base64UrlEncode(input: string | Uint8Array): string {
  let bytes: Uint8Array;
  if (typeof input === 'string') {
    bytes = new TextEncoder().encode(input);
  } else {
    bytes = input;
  }
  // Use btoa with String.fromCharCode for Cloudflare Workers compatibility
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  // Strip PEM header/footer and whitespace
  const base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
