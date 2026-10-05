/** Direct-auth compatibility signing input; not a relay transport (#1198).
 * Authenticator still binds optional signed ephemeral claims using the established
 * v1 domain and length-prefix encoding. Relay v2 uses relay/signing-inputs.ts.
 */
const KEX_CONTEXT = 'remi-relay-kex-v1';

export function kexSigningInput(
  challenge: string,
  daemonEphemeralBase64: string,
  clientEphemeralBase64: string | null,
): ArrayBuffer {
  const parts = [KEX_CONTEXT, challenge, daemonEphemeralBase64, clientEphemeralBase64 ?? ''];
  const encoder = new TextEncoder();
  // `len:value` per part. A value cannot contain its own length prefix, so the
  // encoding is unambiguous.
  return encoder.encode(parts.map((p) => `${p.length}:${p}`).join('')).buffer as ArrayBuffer;
}
