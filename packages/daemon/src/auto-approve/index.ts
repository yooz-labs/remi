export { AutoApproveService, parseDecision } from './auto-approve-service.ts';
export { AutoApproveGate } from './auto-approve-gate.ts';
export type { AutoApproveEvaluator, AutoApproveGateDeps } from './auto-approve-gate.ts';
export {
  AuthorityStore,
  buildAuthorityFromTranscript,
  enforceAuthorityBoundary,
  isNonHumanForAuthority,
  isWrappedNonHumanText,
  resolveAuthority,
} from './authority.ts';
export type { AuthorityBoundaryResult } from './authority.ts';
export { enforceDenyFloor, matchesCatastrophicPattern } from './deny-floor.ts';
export type { DenyFloorResult } from './deny-floor.ts';
export { EngineHost } from './engine-host.ts';
export type {
  EngineBackendKind,
  EngineHostState,
  EngineOwnership,
  PidStore,
  ReachabilityProbe,
} from './engine-host.ts';
// #822: the boot path asks whether a llama-server exists before telling the
// user anything about it, so both the probe-for-presence and the remedy text
// are exported here rather than reached for through a deep import.
export {
  LLAMACPP_LOG_FILE,
  llamaServerArgs,
  llamaServerMissingHint,
  probeLlamaCpp,
  resolveLlamaServer,
} from './llamacpp-backend.ts';
export {
  ENGINE_LOG_FILE,
  ENGINE_PID_FILE,
  FileEnginePidStore,
  spawnDetachedEngine,
} from './engine-process.ts';
export { resolveProviderUrl } from './llm-client.ts';
export { alertBody, alertTitle, SubagentAlerter } from './subagent-alert.ts';
export type { SubagentAlert } from './subagent-alert.ts';
export type {
  AutoApproveConfig,
  AutoApproveDecision,
  AutoApproveResult,
} from './types.ts';
