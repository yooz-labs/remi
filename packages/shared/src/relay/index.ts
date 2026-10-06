/**
 * Relay protocol v2 (ADR 0034): the public surface, exported from the package
 * as `relayV2` so no name can collide with the v1 relay modules it replaces.
 *
 * Deliberately small. The handshake is reachable only through `clientStart` and
 * `hostOnHello` and the single-use steps they return, and a `Channel` exists
 * only as a type: nothing here derives a key, builds a transcript, frames bytes
 * or constructs a channel from raw keys. `internal.ts` has the rest, and a test
 * pins this list so a helper cannot join it by accident.
 */

export * from './constants.ts';
export { FAILURE_CLOSE, RelayError, type RelayErrorCode, asRelayError } from './errors.ts';
export { b64u, ctEqual, fromB64u } from './bytes.ts';
export {
  type EcPair,
  type Rng,
  type Signer,
  generateEcPair,
  generateIdentity,
  ridOf,
  signerFromKey,
  systemRandom,
  verifySignature,
} from './primitives.ts';
export {
  type ClientConfig,
  type ClientStep1,
  type ClientStep2,
  type HostConfig,
  type HostPolicy,
  type HostStep1,
  type HostStep2,
  clientStart,
  hostOnHello,
} from './handshake.ts';
export type { Channel, ChannelIO, StreamEnd } from './channel.ts';
export {
  type AdmissionRole,
  type PairingOffer,
  type PairingToken,
  admitTag,
  admitTagHash,
  admitTagMatches,
  createPairingOffer,
  decodePairingToken,
  encodePairingToken,
  fingerprintOf,
  isLiveOffer,
  liveOffers,
  signAdmission,
  verifyAdmission,
} from './pairing.ts';
export { openSeal, pushAad, seal } from './seal.ts';
export { isSmallOrderPublicKey } from './small-order.ts';
export {
  type Admit,
  type HostCommand,
  type HostOp,
  MAX_WORKER_TEXT,
  type Notice,
  type WorkerPath,
  type WorkerRole,
  decodeAdmit,
  encodeAdmit,
  encodeHostCommand,
  decodeNotice,
  decodeHostCommand,
  encodeNotice,
  parseWorkerPath,
} from './worker-wire.ts';

export {
  type SecurePushKind,
  type ApnsEnvironment,
  type PushOption,
  type SecurePushPayload,
  type PushContentMetadata,
  type SignedPushContent,
  type PushCarrier,
  type PushAuthority,
  type UnsignedPushSubmit,
  type PushSubmit,
  type PushRejectReason,
  type PushSubmitResult,
  PUSH_KIND_BYTE,
  APNS_ENVIRONMENT_BYTE,
  buildPushPayload,
  parsePushPayload,
  buildPushContentSigningInput,
  encodeSignedPushContent,
  decodeSignedPushContent,
  sealPushContent,
  openPushContent,
  buildPushSubmitSigningInput,
  encodePushSubmit,
  decodePushSubmit,
  verifyPushSubmit,
  encodePushSubmitResult,
  decodePushSubmitResult,
} from './push.ts';

export {
  type UnsignedNativeAnswer,
  type NativeAnswer,
  type NativeAnswerAuthority,
  type VerifiedNativeAnswer,
  MAX_NATIVE_ANSWER_BODY,
  MAX_NATIVE_ANSWER_JSON,
  NATIVE_ANSWER_TTL_SECONDS,
  NATIVE_ANSWER_FUTURE_SECONDS,
  buildNativeAnswerBody,
  buildNativeAnswerSigningInput,
  nativeAnswerDigest,
  encodeNativeAnswer,
  decodeNativeAnswer,
  verifyNativeAnswer,
} from './native-answer.ts';
