// #1170 proof adapter for the daemon-owned decoder controller.
export {
  DecoderProcess,
  DecoderProcessError,
  MAX_RESULT_BYTES,
  type DecodedPixels,
  type DecoderChildExit,
  type RepeatedDecodeReady,
} from '../../packages/daemon/src/tunnel/image-process';
