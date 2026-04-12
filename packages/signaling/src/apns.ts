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
}

interface ApnsConfig {
  keyId: string;
  teamId: string;
  privateKey: string;
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

  const apnsHost = payload.sandbox ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
  const apnsUrl = `https://${apnsHost}/3/device/${payload.token}`;

  // Guard against reserved APNS key collision in custom data
  if (payload.data && 'aps' in payload.data) {
    throw new Error('ApnsPayload.data must not contain reserved key "aps"');
  }

  const response = await fetch(apnsUrl, {
    method: 'POST',
    headers: {
      authorization: `bearer ${jwt}`,
      'apns-topic': payload.bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
    },
    body: JSON.stringify({
      aps: {
        alert: {
          title: payload.title,
          body: payload.body,
        },
        sound: 'default',
        badge: 1,
        ...(payload.category ? { category: payload.category } : {}),
      },
      ...(payload.data ? payload.data : {}),
    }),
  });

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
