/**
 * Shared effect profiles for deterministic capability proofs (#1094).
 *
 * A proof leaf says what a bounded command shape can do; this registry says
 * which effect family and approval group that leaf belongs to. Keeping those
 * facts in one place prevents the shell proof, group matcher, and risk ceiling
 * from growing separate GitHub or interpreter policies.
 *
 * These profiles are not authorization by themselves. A caller still has to
 * request the profile's approval group, and remote mutations have no approval
 * group at all.
 */

export const OPERATION_EFFECTS = [
  'filesystem_read',
  'filesystem_write',
  'filesystem_delete',
  'network_read',
  'network_write',
  'remote_read',
  'remote_mutation',
  'process_execution',
  'credential_access',
  'persistence',
  'privilege_change',
  'package_install',
] as const;

export type OperationEffect = (typeof OPERATION_EFFECTS)[number];

export type CapabilityApprovalGroup = 'read-only' | 'vcs-read' | 'gh-read';

export type OperationFamily =
  | 'local_read'
  | 'bounded_interpreter_read'
  | 'vcs_read'
  | 'github_issue_read'
  | 'github_read'
  | 'remote_mutation';

export interface OperationEffectProfile {
  readonly family: OperationFamily;
  readonly effects: readonly OperationEffect[];
  /** Null means no deterministic approval group may cover this family. */
  readonly approvalGroup: CapabilityApprovalGroup | null;
}

/**
 * The only effect profiles emitted by the Phase 2 proof. A bounded interpreter
 * still has process execution as an effect; it is approvable only because its
 * exact grammar also proves that it cannot write, egress, mutate credentials,
 * or persist state.
 */
export const OPERATION_EFFECT_REGISTRY = {
  local_read: {
    family: 'local_read',
    effects: ['filesystem_read'],
    approvalGroup: 'read-only',
  },
  bounded_interpreter_read: {
    family: 'bounded_interpreter_read',
    effects: ['filesystem_read', 'process_execution'],
    approvalGroup: 'read-only',
  },
  vcs_read: {
    family: 'vcs_read',
    effects: ['filesystem_read', 'network_read', 'remote_read'],
    approvalGroup: 'vcs-read',
  },
  github_issue_read: {
    family: 'github_issue_read',
    effects: ['network_read', 'remote_read'],
    approvalGroup: 'vcs-read',
  },
  github_read: {
    family: 'github_read',
    effects: ['network_read', 'remote_read'],
    approvalGroup: 'gh-read',
  },
  remote_mutation: {
    family: 'remote_mutation',
    effects: ['network_write', 'remote_mutation'],
    approvalGroup: null,
  },
} as const satisfies Readonly<Record<OperationFamily, OperationEffectProfile>>;

export type GitHubSubIssueActionEffect = 'read' | 'remote_mutation' | 'unknown';

const PROOF_NEUTRAL_LEAVES: ReadonlySet<string> = new Set([
  'cd',
  'pwd',
  'true',
  'echo',
  ':',
  'read',
  'printf',
]);

/** Shell-only leaves do not establish a capability on their own. */
export function isNeutralProofLeaf(leafName: string): boolean {
  return PROOF_NEUTRAL_LEAVES.has(leafName);
}

const GH_SUB_ISSUE_READ_ACTIONS: ReadonlySet<string> = new Set(['list']);
const GH_SUB_ISSUE_MUTATION_ACTIONS: ReadonlySet<string> = new Set([
  'add',
  'remove',
  'reprioritize',
]);

/**
 * Classify the extension's known sub-issue actions. Unknown actions are not
 * treated as reads: the risk classifier must keep them on the high/fail-closed
 * side until a complete effect contract is added here.
 */
export function githubSubIssueActionEffect(action: string | undefined): GitHubSubIssueActionEffect {
  if (action !== undefined && GH_SUB_ISSUE_READ_ACTIONS.has(action)) return 'read';
  if (action !== undefined && GH_SUB_ISSUE_MUTATION_ACTIONS.has(action)) {
    return 'remote_mutation';
  }
  return 'unknown';
}

const LOCAL_READ_LEAVES: ReadonlySet<string> = new Set([
  'cd',
  'pwd',
  'true',
  'echo',
  ':',
  'read',
  'printf',
  'cat',
  'head',
  'tail',
  'grep',
  'egrep',
  'rg',
  'wc',
  'file',
  'stat',
  'column',
  'cut',
  'uniq',
  'ls',
  'which',
  'basename',
  'dirname',
  'realpath',
  'mdfind',
  'du',
  'df',
  'find',
  'sort',
  'tree',
  'diff',
  'tr',
  'comm',
  'paste',
  'nl',
  'rev',
]);

const BOUNDED_INTERPRETER_LEAVES: ReadonlySet<string> = new Set([
  'awk:print-field',
  'python:lock-inspection',
]);

const GITHUB_ISSUE_READ_LEAVES: ReadonlySet<string> = new Set(['gh:issue-list', 'gh:issue-view']);

const GITHUB_READ_LEAVES: ReadonlySet<string> = new Set(['gh:api-get', 'gh:sub-issue-list']);

/** Return the registered effect profile for one proof leaf, or null if unknown. */
export function capabilityForProofLeaf(leafName: string): OperationEffectProfile | null {
  if (LOCAL_READ_LEAVES.has(leafName)) return OPERATION_EFFECT_REGISTRY.local_read;
  if (BOUNDED_INTERPRETER_LEAVES.has(leafName)) {
    return OPERATION_EFFECT_REGISTRY.bounded_interpreter_read;
  }
  if (leafName.startsWith('git:')) return OPERATION_EFFECT_REGISTRY.vcs_read;
  if (GITHUB_ISSUE_READ_LEAVES.has(leafName)) {
    return OPERATION_EFFECT_REGISTRY.github_issue_read;
  }
  if (GITHUB_READ_LEAVES.has(leafName)) return OPERATION_EFFECT_REGISTRY.github_read;
  return null;
}
