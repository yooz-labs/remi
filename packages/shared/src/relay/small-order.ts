/**
 * Ed25519 small-order public keys.
 *
 * Bun 1.4.2 and 1.3.11 accepted the identity-point key/signature probe.
 * RFC 8032's verification equation does not itself forbid these encodings.
 * Callers must reject them before accepting a public key; direct authentication
 * uses this check before verification, pending registration, or new authorization.
 *
 * The list is every encoding of a point of order dividing 8: the eight points
 * of the torsion subgroup in canonical form, the same encoding with the sign
 * bit flipped where that is meaningful to a decoder (x = 0, which RFC 8032
 * calls invalid but some decoders accept), and the non-canonical aliases `y + p`
 * for the two coordinates below 19 (y = 0 and y = 1). Fourteen encodings.
 * `small-order.test.ts` and `ed25519-public-key.test.ts` recompute the torsion subgroup with independent
 * arithmetic and requires this list to be exactly its encodings.
 */

const SMALL_ORDER: readonly string[] = [
  // order 1: the identity (0, 1), then its sign-bit and non-canonical forms
  '0100000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000080',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  // order 2: (0, -1)
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  // order 4: (+-sqrt(-1), 0), then the non-canonical forms of y = 0
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0000000000000000000000000000000000000000000000000000000000000080',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  // order 8: four points
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa',
];

const SET = new Set(SMALL_ORDER);

const hexOf = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/**
 * True when `publicKey` is a 32-byte encoding of a small-order Ed25519 point.
 * A key of any other length matches no encoding, so it is not small-order here;
 * refusing a wrong length is the caller's own check.
 */
export function isSmallOrderPublicKey(publicKey: Uint8Array): boolean {
  return SET.has(hexOf(publicKey));
}
