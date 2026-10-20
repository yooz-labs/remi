// #1170 proof adapter: the daemon owns the sole journal implementation.
export {
  RecoveryError,
  RecoveryIntent,
  type RecoveryOps,
  type RecoveryStage,
  allocatedBlocks,
} from '../../packages/daemon/src/tunnel/recovery';
