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
export { isLocalProviderUrl, resolveProviderUrl } from './llm-client.ts';
export {
  buildShadowReviewPrompt,
  formatShadowReviewOperation,
  parseShadowRiskReview,
} from './risk-review.ts';
export type { RiskReviewMode, ShadowRiskReview } from './risk-review.ts';
export {
  buildIntentAssessmentPrompt,
  buildIntentAssessmentPromptFromFormatted,
  fingerprintIntentOperation,
  formatIntentAssessmentContext,
  parseIntentAssessment,
} from './intent-assessment.ts';
export {
  INTENT_ASSESSMENT_EFFECTS,
  INTENT_ASSESSMENT_INTENTS,
  INTENT_ASSESSMENT_SCOPES,
  MAX_INTENT_CONTEXT_CHARS,
  MAX_INTENT_LINEAGE_ENTRIES,
  MAX_INTENT_OPERATION_CHARS,
  MAX_INTENT_REASONING_CHARS,
  MAX_INTENT_RESPONSE_CHARS,
} from './intent-assessment.ts';
export type {
  FormattedIntentAssessmentContext,
  Intent,
  IntentAssessment,
  IntentAssessmentContext,
  IntentAssessmentParseOptions,
  IntentEffect,
  IntentOperationContext,
  IntentScope,
} from './intent-assessment.ts';
export { proveCompoundReadOnly } from './read-only-proof.ts';
export type { ReadOnlyProof, ReadOnlyProofLeaf, ReadOnlyProofReason } from './read-only-proof.ts';
export {
  OPERATION_EFFECTS,
  OPERATION_EFFECT_REGISTRY,
  capabilityForProofLeaf,
  githubSubIssueActionEffect,
  isNeutralProofLeaf,
} from './operation-effects.ts';
export type {
  CapabilityApprovalGroup,
  GitHubSubIssueActionEffect,
  OperationEffect,
  OperationEffectProfile,
  OperationFamily,
} from './operation-effects.ts';
export {
  detectGitHubRepository,
  normalizeGitHubRepository,
  parseGitHubRemoteUrl,
} from './repository-context.ts';
export {
  classifySessionWorkflowOperation,
  semanticAssessmentMatchesWorkflow,
  SessionWorkflowGrantStore,
  SESSION_WORKFLOW_FAMILIES,
} from './session-workflow-grant.ts';
export type {
  SessionWorkflowClassificationContext,
  SessionWorkflowFamily,
  SessionWorkflowOperationKind,
  WorkflowGrantEvaluationContext,
  WorkflowGrantOffer,
  WorkflowGrantReader,
  WorkflowOperationFacts,
} from './session-workflow-grant.ts';
export { alertBody, alertTitle, SubagentAlerter } from './subagent-alert.ts';
export type { SubagentAlert } from './subagent-alert.ts';
export type {
  AutoApproveConfig,
  AutoApproveDecision,
  AutoApproveResult,
} from './types.ts';
