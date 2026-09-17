import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { IntentAssessment } from './intent-assessment.ts';
import { OPERATION_EFFECT_REGISTRY } from './operation-effects.ts';
import type { OperationEffect } from './operation-effects.ts';
import { normalizeGitHubRepository } from './repository-context.ts';
import {
  hasShellControl,
  hasUnsafeShellExpansion,
  shellWords,
  splitCompound,
} from './shell-safety.ts';

/** The deliberately small Phase 3 grant family. */
export const SESSION_WORKFLOW_FAMILIES = ['github-issue-planning'] as const;
export type SessionWorkflowFamily = (typeof SESSION_WORKFLOW_FAMILIES)[number];

export type SessionWorkflowOperationKind = 'github-issue-create' | 'github-sub-issue-add';

const REMOTE_MUTATION_EFFECTS = OPERATION_EFFECT_REGISTRY.remote_mutation.effects;

export interface WorkflowOperationFacts {
  readonly sessionId: string;
  readonly workingDirectory: string;
  readonly repository: string;
  readonly family: SessionWorkflowFamily;
  readonly kind: SessionWorkflowOperationKind;
  readonly effects: readonly OperationEffect[];
  readonly target: {
    readonly repository: string;
    readonly issueNumbers: readonly number[];
  };
}

/** Public option metadata. Private scope and expiry never cross the wire. */
export interface WorkflowGrantOffer {
  readonly family: SessionWorkflowFamily;
}

/** The only read capability the evaluator receives. It cannot create or widen a grant. */
export interface WorkflowGrantReader {
  matches(operation: WorkflowOperationFacts): boolean;
}

export interface WorkflowGrantEvaluationContext {
  readonly reader: WorkflowGrantReader;
  readonly repository?: string;
}

export interface SessionWorkflowClassificationContext {
  readonly sessionId: string;
  readonly workingDirectory: string;
  readonly repository?: string;
}

const MAX_GRANTS = 8;
const DEFAULT_TTL_MS = 30 * 60 * 1_000;
const MAX_TTL_MS = 60 * 60 * 1_000;

const ISSUE_CREATE_VALUE_FLAGS = new Set([
  '--title',
  '-t',
  '--body',
  '-b',
  '--label',
  '-l',
  '--assignee',
  '-a',
  '--milestone',
  '-m',
]);
const ISSUE_CREATE_BOOLEAN_FLAGS = new Set(['--draft']);

function canonicalWorkingDirectory(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.includes('\0')) return undefined;
  try {
    return realpathSync.native(trimmed);
  } catch {
    // Test fixtures and a just-created worktree may not exist yet. Resolve
    // those paths deterministically; a later scope mismatch still fails shut.
    return resolve(trimmed);
  }
}

function exactRemoteMutationEffects(effects: readonly OperationEffect[]): boolean {
  return (
    effects.length === REMOTE_MUTATION_EFFECTS.length &&
    REMOTE_MUTATION_EFFECTS.every((effect) => effects.includes(effect))
  );
}

function issueNumber(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function optionValue(
  words: readonly string[],
  index: number,
  flag: string,
): { readonly value: string; readonly nextIndex: number } | undefined {
  const token = words[index];
  if (token === `${flag}=`) return undefined;
  if (token?.startsWith(`${flag}=`)) {
    const value = token.slice(flag.length + 1);
    return value.length > 0 ? { value, nextIndex: index + 1 } : undefined;
  }
  if (token !== flag) return undefined;
  const value = words[index + 1];
  return value !== undefined && value.length > 0 ? { value, nextIndex: index + 2 } : undefined;
}

function parseGlobalOptions(
  words: readonly string[],
  start: number,
): { readonly topIndex: number; readonly repository?: string; readonly invalid: boolean } {
  let index = start;
  let repository: string | undefined;
  while (index < words.length) {
    const token = words[index];
    if (token === undefined || !token.startsWith('-')) break;
    const repo = optionValue(words, index, '--repo') ?? optionValue(words, index, '-R');
    if (repo !== undefined) {
      const normalized = normalizeGitHubRepository(repo.value);
      if (normalized === undefined || repository !== undefined) {
        return { topIndex: index, invalid: true };
      }
      repository = normalized;
      index = repo.nextIndex;
      continue;
    }
    const hostname = optionValue(words, index, '--hostname');
    if (hostname !== undefined) {
      if (hostname.value.toLowerCase() !== 'github.com') {
        return { topIndex: index, invalid: true };
      }
      index = hostname.nextIndex;
      continue;
    }
    // No other top-level option is needed for this narrow family. In
    // particular, do not silently accept a wrapper that changes auth, host,
    // or command behavior before the action is parsed.
    return { topIndex: index, invalid: true };
  }
  return repository === undefined
    ? { topIndex: index, invalid: false }
    : { topIndex: index, repository, invalid: false };
}

function parseIssueCreate(
  words: readonly string[],
  start: number,
  explicitRepository: string | undefined,
  context: SessionWorkflowClassificationContext,
): WorkflowOperationFacts | undefined {
  let index = start;
  let repository = explicitRepository;
  let title = false;
  let body = false;
  const issueNumbers: number[] = [];

  while (index < words.length) {
    const token = words[index];
    if (token === undefined || token === '--' || !token.startsWith('-')) return undefined;
    const repo = optionValue(words, index, '--repo') ?? optionValue(words, index, '-R');
    if (repo !== undefined) {
      const normalized = normalizeGitHubRepository(repo.value);
      if (normalized === undefined || repository !== undefined) return undefined;
      repository = normalized;
      index = repo.nextIndex;
      continue;
    }
    const hostname = optionValue(words, index, '--hostname');
    if (hostname !== undefined) {
      if (hostname.value.toLowerCase() !== 'github.com') return undefined;
      index = hostname.nextIndex;
      continue;
    }
    if (ISSUE_CREATE_BOOLEAN_FLAGS.has(token)) {
      index++;
      continue;
    }
    if (
      ISSUE_CREATE_VALUE_FLAGS.has(token) ||
      [...ISSUE_CREATE_VALUE_FLAGS].some((flag) => token.startsWith(`${flag}=`))
    ) {
      const flag = ISSUE_CREATE_VALUE_FLAGS.has(token)
        ? token
        : [...ISSUE_CREATE_VALUE_FLAGS].find((candidate) => token.startsWith(`${candidate}=`));
      if (flag === undefined) return undefined;
      const value = optionValue(words, index, flag);
      if (value === undefined) return undefined;
      if (flag === '--title' || flag === '-t') title = true;
      if (flag === '--body' || flag === '-b') body = true;
      index = value.nextIndex;
      continue;
    }
    // --body-file, --web, --template, --project, unknown flags, and compact
    // short-option bundles are intentionally outside the family.
    return undefined;
  }

  const targetRepository = repository ?? normalizeGitHubRepository(context.repository ?? '');
  if (!title || !body || targetRepository === undefined) return undefined;
  return makeFacts(context, targetRepository, 'github-issue-create', issueNumbers);
}

function parseSubIssueAdd(
  words: readonly string[],
  start: number,
  explicitRepository: string | undefined,
  context: SessionWorkflowClassificationContext,
): WorkflowOperationFacts | undefined {
  let index = start;
  let repository = explicitRepository;
  let parent: number | undefined;
  let child: number | undefined;
  while (index < words.length) {
    const token = words[index];
    if (token === undefined || token === '--') return undefined;
    const repo = optionValue(words, index, '--repo') ?? optionValue(words, index, '-R');
    if (repo !== undefined) {
      const normalized = normalizeGitHubRepository(repo.value);
      if (normalized === undefined || repository !== undefined) return undefined;
      repository = normalized;
      index = repo.nextIndex;
      continue;
    }
    const hostname = optionValue(words, index, '--hostname');
    if (hostname !== undefined) {
      if (hostname.value.toLowerCase() !== 'github.com') return undefined;
      index = hostname.nextIndex;
      continue;
    }
    const childOption = optionValue(words, index, '--sub-issue-number');
    if (childOption !== undefined) {
      if (child !== undefined) return undefined;
      child = issueNumber(childOption.value);
      if (child === undefined) return undefined;
      index = childOption.nextIndex;
      continue;
    }
    if (token.startsWith('-')) return undefined;
    if (parent !== undefined) return undefined;
    parent = issueNumber(token);
    if (parent === undefined) return undefined;
    index++;
  }
  const targetRepository = repository ?? normalizeGitHubRepository(context.repository ?? '');
  if (parent === undefined || child === undefined || targetRepository === undefined)
    return undefined;
  return makeFacts(context, targetRepository, 'github-sub-issue-add', [parent, child]);
}

function makeFacts(
  context: SessionWorkflowClassificationContext,
  repository: string,
  kind: SessionWorkflowOperationKind,
  issueNumbers: readonly number[],
): WorkflowOperationFacts | undefined {
  const sessionId = context.sessionId.trim();
  const workingDirectory = canonicalWorkingDirectory(context.workingDirectory);
  const normalizedRepository = normalizeGitHubRepository(repository);
  if (
    sessionId.length === 0 ||
    workingDirectory === undefined ||
    normalizedRepository === undefined
  ) {
    return undefined;
  }
  return {
    sessionId,
    workingDirectory,
    repository: normalizedRepository,
    family: 'github-issue-planning',
    kind,
    effects: REMOTE_MUTATION_EFFECTS,
    target: { repository: normalizedRepository, issueNumbers },
  };
}

/**
 * Recognize only the finite planning language that can receive a session grant.
 * This function never executes the command and never infers safety from text.
 */
export function classifySessionWorkflowOperation(
  toolName: string,
  toolInput: Record<string, unknown>,
  context: SessionWorkflowClassificationContext,
): WorkflowOperationFacts | undefined {
  if (toolName !== 'Bash' || typeof toolInput['command'] !== 'string') return undefined;
  const command = toolInput['command'];
  if (hasUnsafeShellExpansion(command) || hasShellControl(command)) return undefined;
  const parts = splitCompound(command);
  if (parts.length !== 1) return undefined;
  const words = shellWords(command);
  if (words.length < 3 || words[0] !== 'gh') return undefined;

  const global = parseGlobalOptions(words, 1);
  if (global.invalid) return undefined;
  const top = words[global.topIndex];
  if (top === 'issue') {
    if (words[global.topIndex + 1] !== 'create') return undefined;
    return parseIssueCreate(words, global.topIndex + 2, global.repository, context);
  }
  if (top === 'sub-issue') {
    if (words[global.topIndex + 1] !== 'add') return undefined;
    return parseSubIssueAdd(words, global.topIndex + 2, global.repository, context);
  }
  return undefined;
}

interface StoredGrant {
  readonly family: SessionWorkflowFamily;
  readonly repository: string;
  readonly expiresAt: number;
}

/** One in-memory grant lineage per Remi session. It is never persisted or sent to clients. */
export class SessionWorkflowGrantStore implements WorkflowGrantReader {
  private readonly grants = new Map<string, StoredGrant>();
  private readonly sessionId: string;
  private readonly workingDirectory: string;
  private readonly repository: string | undefined;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    sessionId: string,
    workingDirectory: string,
    repository?: string,
    options?: { readonly ttlMs?: number; readonly now?: () => number },
  ) {
    this.sessionId = sessionId.trim();
    this.workingDirectory = canonicalWorkingDirectory(workingDirectory) ?? '';
    this.repository = repository === undefined ? undefined : normalizeGitHubRepository(repository);
    this.ttlMs = Math.min(Math.max(options?.ttlMs ?? DEFAULT_TTL_MS, 1), MAX_TTL_MS);
    this.now = options?.now ?? Date.now;
  }

  /** Used by the gate before displaying the grant action. */
  canGrant(operation: WorkflowOperationFacts): boolean {
    return this.scopeMatches(operation) && exactRemoteMutationEffects(operation.effects);
  }

  /** Create or refresh the narrow family/repository grant after an explicit answer. */
  grant(operation: WorkflowOperationFacts): boolean {
    if (!this.canGrant(operation)) return false;
    const now = this.now();
    this.purgeExpired(now);
    const key = `${operation.family}:${operation.repository}`;
    if (!this.grants.has(key) && this.grants.size >= MAX_GRANTS) {
      const oldest = this.grants.keys().next();
      if (!oldest.done) this.grants.delete(oldest.value);
    }
    this.grants.delete(key);
    this.grants.set(key, {
      family: operation.family,
      repository: operation.repository,
      expiresAt: now + this.ttlMs,
    });
    return true;
  }

  matches(operation: WorkflowOperationFacts): boolean {
    const now = this.now();
    this.purgeExpired(now);
    if (!this.scopeMatches(operation) || !exactRemoteMutationEffects(operation.effects))
      return false;
    const grant = this.grants.get(`${operation.family}:${operation.repository}`);
    return grant !== undefined && grant.expiresAt > now;
  }

  clear(): void {
    this.grants.clear();
  }

  private scopeMatches(operation: WorkflowOperationFacts): boolean {
    const repository = normalizeGitHubRepository(operation.repository);
    const targetRepository = normalizeGitHubRepository(operation.target.repository);
    return (
      this.sessionId.length > 0 &&
      operation.sessionId === this.sessionId &&
      operation.workingDirectory === this.workingDirectory &&
      this.repository !== undefined &&
      repository === this.repository &&
      targetRepository === repository &&
      operation.family === 'github-issue-planning' &&
      (operation.kind === 'github-issue-create' || operation.kind === 'github-sub-issue-add') &&
      operation.target.issueNumbers.every((number) => Number.isSafeInteger(number) && number > 0)
    );
  }

  private purgeExpired(now: number): void {
    for (const [key, grant] of this.grants) {
      if (grant.expiresAt <= now) this.grants.delete(key);
    }
  }
}

/** The model is evidence only; these exact deterministic facts remain mandatory. */
export function semanticAssessmentMatchesWorkflow(
  operation: WorkflowOperationFacts,
  assessment: IntentAssessment,
): boolean {
  return (
    operation.family === 'github-issue-planning' &&
    exactRemoteMutationEffects(operation.effects) &&
    assessment.intent === 'remote_mutation' &&
    assessment.scope === 'remote_repository' &&
    assessment.reversible === true &&
    assessment.confidence >= 0.85 &&
    exactRemoteMutationEffects(assessment.effects)
  );
}
