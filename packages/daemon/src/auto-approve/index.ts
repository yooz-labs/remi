export { AutoApproveGate } from './auto-approve-gate.ts';
export type {
  AutoApproveGateDeps,
  ObservedToolCall,
  TerminalReleaseCause,
} from './auto-approve-gate.ts';
// Moved to the harness-neutral module in #1164; re-exported so the gate's own
// importers keep their path.
export type { HeldAnswer, HeldAnswerOutcome } from '../harness/decision.ts';
export { ALWAYS_ESCALATE_TOOLS } from './multichoice.ts';
export { alertBody, alertTitle, SubagentAlerter, subagentCall } from './subagent-alert.ts';
export type { SubagentAlert, SubagentAlertSink, SubagentToolCall } from './subagent-alert.ts';
