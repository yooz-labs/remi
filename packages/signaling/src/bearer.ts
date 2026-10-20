/**
 * Constant-time bearer check for the push routes (#1200).
 *
 * Both sides are hashed first, so the comparison always runs over two 32-byte
 * digests: it neither depends on where the presented value first differs nor
 * reveals the secret's length. A secret that is unset or blank authorizes
 * nothing, so a deployment that forgot to configure it refuses every request
 * instead of becoming an open relay.
 */

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

/**
 * True only when `header` is exactly `Bearer <secret>`. The configured secret is
 * trimmed, because `echo value | wrangler secret put` stores a trailing newline
 * that no HTTP header value can ever carry.
 */
export async function bearerAuthorized(
  header: string | null,
  secret: string | undefined,
): Promise<boolean> {
  const expected = secret?.trim();
  if (!expected) return false;
  const presented = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  const [a, b] = await Promise.all([sha256(presented), sha256(expected)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= (a[i] as number) ^ (b[i] as number);
  return difference === 0;
}
