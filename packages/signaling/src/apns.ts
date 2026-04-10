/**
 * APNS (Apple Push Notification Service) HTTP/2 client.
 * Uses JWT-based authentication with a p8 key.
 */

interface ApnsPayload {
  token: string;
  title: string;
  body: string;
  bundleId: string;
  /** Custom data fields included at top-level of APNS payload (sibling to aps) */
  data?: Record<string, string>;
  /** Use APNS sandbox endpoint (development builds) */
  sandbox?: boolean;
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

/**
 * Create a JWT for APNS authentication.
 * Uses ES256 algorithm with the p8 private key.
 */
async function createApnsJwt(config: ApnsConfig): Promise<string> {
  const header = {
    alg: 'ES256',
    kid: config.keyId,
  };

  const payload = {
    iss: config.teamId,
    iat: Math.floor(Date.now() / 1000),
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

  // Convert DER signature to raw r||s format for JWT
  const rawSig = derToRaw(new Uint8Array(signature));
  const encodedSignature = base64UrlEncode(rawSig);

  return `${signingInput}.${encodedSignature}`;
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

/**
 * Convert DER-encoded ECDSA signature to raw r||s format.
 * WebCrypto outputs DER, but JWT needs raw.
 */
function derToRaw(der: Uint8Array): Uint8Array {
  // DER structure: 0x30 len 0x02 rLen r 0x02 sLen s
  let offset = 2; // skip 0x30 and length byte
  if (der[1]! > 0x80) offset += der[1]! - 0x80; // handle extended length

  // Read r
  offset++; // skip 0x02
  const rLen = der[offset]!;
  offset++;
  let rStart = offset;
  let rActualLen = rLen;
  // Skip leading zero padding
  if (rActualLen === 33 && der[rStart] === 0) {
    rStart++;
    rActualLen = 32;
  }
  const r = der.slice(rStart, rStart + rActualLen);
  offset = rStart + rActualLen;

  // Read s
  offset++; // skip 0x02
  const sLen = der[offset]!;
  offset++;
  let sStart = offset;
  let sActualLen = sLen;
  if (sActualLen === 33 && der[sStart] === 0) {
    sStart++;
    sActualLen = 32;
  }
  const s = der.slice(sStart, sStart + sActualLen);

  // Pad to 32 bytes each
  const raw = new Uint8Array(64);
  raw.set(r.length <= 32 ? r : r.slice(r.length - 32), 32 - Math.min(r.length, 32));
  raw.set(s.length <= 32 ? s : s.slice(s.length - 32), 64 - Math.min(s.length, 32));
  return raw;
}
