/**
 * The whole library, low-level helpers included (ADR 0034 section 12).
 *
 * `index.ts` is the public surface and exports only what a daemon, Worker or
 * client needs. Everything else is reachable here for the tests, the vector
 * generator and the verifiers, and for nothing else: a helper that builds a
 * transcript, derives a key or frames bytes outside the handshake steps must
 * never be a call a later phase can reach through `relayV2`.
 */

export * from './constants.ts';
export * from './errors.ts';
export * from './bytes.ts';
export * from './primitives.ts';
export * from './envelope.ts';
export * from './handshake.ts';
export * from './channel.ts';
export * from './pairing.ts';
export * from './seal.ts';
