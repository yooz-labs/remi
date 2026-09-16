/**
 * A deterministic, fail-closed proof for a small shell read-only language
 * (#1082, phase 3 of epic #1081).
 *
 * This is deliberately a proof, not a risk heuristic. It returns `proved`
 * only when every command and every command substitution belongs to the
 * finite read-only language below. Unknown shell syntax, wrappers,
 * interpreters, real redirects, sensitive assignments, and unrecognised Git
 * forms are rejected. A false negative costs a model call; a false positive
 * would turn an unreviewed shell command into an approval.
 *
 * The proof is not itself an authorization. Phase 4 may use it together with
 * a fresh authorization assessment, but Phase 3 does not change approval
 * behavior. In particular, this module does not inspect the filesystem,
 * execute Git, expand variables, or trust model text.
 */

import {
  findRedirectClauses,
  maskQuotedSpans,
  shellWords,
  stripShellGrammar,
} from './shell-safety.ts';
import type { CompoundJoiner } from './shell-safety.ts';

const MAX_COMMAND_CHARS = 8_192;
const MAX_PARTS = 96;
const MAX_SUBSTITUTIONS = 48;
const MAX_RECURSION_DEPTH = 6;

export type ReadOnlyProofReason =
  | 'empty-command'
  | 'command-too-long'
  | 'too-many-parts'
  | 'too-many-substitutions'
  | 'recursion-limit'
  | 'malformed-shell'
  | 'unsupported-shell-control'
  | 'unsafe-redirect'
  | 'unsafe-command-substitution'
  | 'sensitive-assignment'
  | 'unsafe-assignment'
  | 'unsupported-grammar'
  | 'interpreter'
  | 'unsafe-git-form'
  | 'unsafe-command'
  | 'unknown-command'
  | 'no-read-leaf';

export interface ReadOnlyProofLeaf {
  /** Stable, low-cardinality label suitable for telemetry. */
  readonly name: string;
}

export type ReadOnlyProof =
  | {
      readonly status: 'proved';
      readonly leaves: readonly ReadOnlyProofLeaf[];
    }
  | {
      readonly status: 'rejected';
      readonly reason: ReadOnlyProofReason;
    };

type ValueKind = 'literal' | 'text' | 'ref' | 'path' | 'count' | 'worktree-list';

interface InternalResult {
  readonly status: 'proved';
  readonly leaves: readonly ReadOnlyProofLeaf[];
  readonly substitutions: number;
  /** The value shape printed by the final leaf, when the caller needs it. */
  readonly outputKind: ValueKind;
}

interface ProofFailure {
  readonly status: 'rejected';
  readonly reason: ReadOnlyProofReason;
}

type Result = InternalResult | ProofFailure;

interface ProofState {
  readonly variables: Map<string, ValueKind>;
}

interface Substitution {
  readonly start: number;
  readonly end: number;
  readonly command: string;
}

interface SplitResult {
  readonly parts: readonly { readonly text: string; readonly joiner: CompoundJoiner }[];
}

interface SplitFailure {
  readonly reason: 'malformed-shell';
}

/**
 * Prove that `command` is an effect-free read/query script in the Phase 3
 * language. The result is intentionally typed so callers cannot confuse an
 * unknown command with a successful proof.
 */
export function proveCompoundReadOnly(command: string): ReadOnlyProof {
  if (command.trim() === '') return { status: 'rejected', reason: 'empty-command' };
  if (command.length > MAX_COMMAND_CHARS) {
    return { status: 'rejected', reason: 'command-too-long' };
  }

  const result = proveScript(command, new Map(), 0);
  if (result.status === 'rejected') return result;
  if (result.leaves.length === 0) return { status: 'rejected', reason: 'no-read-leaf' };
  if (result.substitutions > MAX_SUBSTITUTIONS) {
    return { status: 'rejected', reason: 'too-many-substitutions' };
  }
  return { status: 'proved', leaves: result.leaves };
}

function proveScript(
  command: string,
  initialVariables: Map<string, ValueKind>,
  depth: number,
): Result {
  if (depth > MAX_RECURSION_DEPTH) return { status: 'rejected', reason: 'recursion-limit' };

  const split = splitProofParts(command);
  if ('reason' in split) return { status: 'rejected', reason: split.reason };
  if (split.parts.length > MAX_PARTS) return { status: 'rejected', reason: 'too-many-parts' };

  const state: ProofState = { variables: new Map(initialVariables) };
  const leaves: ReadOnlyProofLeaf[] = [];
  let substitutions = 0;
  let outputKind: ValueKind = 'text';
  let sawExecutablePart = false;

  for (const part of split.parts) {
    const result = provePart(part.text, state, depth);
    if (result.status === 'rejected') return result;
    leaves.push(...result.leaves);
    substitutions += result.substitutions;
    if (substitutions > MAX_SUBSTITUTIONS) {
      return { status: 'rejected', reason: 'too-many-substitutions' };
    }
    outputKind = result.outputKind;
    if (result.leaves.length > 0) sawExecutablePart = true;
  }

  if (!sawExecutablePart) return { status: 'rejected', reason: 'no-read-leaf' };
  return { status: 'proved', leaves, substitutions, outputKind };
}

/**
 * Split compound syntax while treating a proven-to-be-balanced `$()` span as
 * one word. `splitCompoundParts` cannot be reused here: it intentionally does
 * not track substitution nesting, so a `;` or `|` inside `$()` would become an
 * outer segment before the inner command could be proved.
 */
function splitProofParts(command: string): SplitResult | SplitFailure {
  const parts: { text: string; joiner: CompoundJoiner }[] = [];
  let current = '';
  let joiner: CompoundJoiner = null;
  let quote: '"' | "'" | "$'" | null = null;

  const push = (nextJoiner: CompoundJoiner): void => {
    parts.push({ text: current, joiner });
    current = '';
    joiner = nextJoiner;
  };

  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const next = command[i + 1];
    if (c === undefined) break;

    if (quote === '"') {
      if (c === '\\' && next !== undefined) {
        current += c + next;
        i++;
        continue;
      }
      if (c === '$' && next === '(') {
        const end = findCommandSubstitutionEnd(command, i);
        if (end === -1) return { reason: 'malformed-shell' };
        current += command.slice(i, end + 1);
        i = end;
        continue;
      }
      current += c;
      if (c === '"') quote = null;
      continue;
    }

    if (quote === "'") {
      current += c;
      if (c === "'") quote = null;
      continue;
    }

    if (quote === "$'") {
      if (c === '\\' && next !== undefined) {
        current += c + next;
        i++;
        continue;
      }
      current += c;
      if (c === "'") quote = null;
      continue;
    }

    if (c === '\\') {
      if (next !== undefined) {
        current += c + next;
        i++;
      } else {
        current += c;
      }
      continue;
    }
    if (c === '$' && next === "'") {
      quote = "$'";
      current += c + next;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      current += c;
      continue;
    }
    if (c === '$' && next === '(') {
      const end = findCommandSubstitutionEnd(command, i);
      if (end === -1) return { reason: 'malformed-shell' };
      current += command.slice(i, end + 1);
      i = end;
      continue;
    }
    if (c === '`') {
      const end = findClosingBacktick(command, i + 1);
      if (end === -1) return { reason: 'malformed-shell' };
      current += command.slice(i, end + 1);
      i = end;
      continue;
    }
    if (c === ';' || c === '\n' || c === '\r') {
      push(c === ';' ? ';' : 'newline');
      continue;
    }
    if (c === '&' && next === '&') {
      push('&&');
      i++;
      continue;
    }
    if (c === '|' && next === '|') {
      push('||');
      i++;
      continue;
    }
    if (c === '|') {
      push('|');
      continue;
    }
    current += c;
  }

  if (quote !== null) return { reason: 'malformed-shell' };
  parts.push({ text: current, joiner });
  return { parts };
}

/** Return the closing `)` for a live `$(`, respecting nested quotes/substitutions. */
function findCommandSubstitutionEnd(text: string, start: number): number {
  let depth = 1;
  let quote: '"' | "'" | "$'" | null = null;
  let backtick = false;
  for (let i = start + 2; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (c === undefined) break;

    if (quote === '"') {
      if (c === '\\' && next !== undefined) {
        i++;
        continue;
      }
      if (c === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    if (quote === "$'") {
      if (c === '\\' && next !== undefined) {
        i++;
        continue;
      }
      if (c === "'") quote = null;
      continue;
    }
    if (backtick) {
      if (c === '\\' && next !== undefined) {
        i++;
        continue;
      }
      if (c === '`') backtick = false;
      continue;
    }
    if (c === '\\' && next !== undefined) {
      i++;
      continue;
    }
    if (c === '$' && next === "'") {
      quote = "$'";
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '`') {
      backtick = true;
      continue;
    }
    if (c === '$' && next === '(') {
      depth++;
      i++;
      continue;
    }
    if (c === '(') {
      depth++;
      continue;
    }
    if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Return the closing backtick, or -1 for an unterminated substitution. */
function findClosingBacktick(text: string, start: number): number {
  for (let i = start; i < text.length; i++) {
    if (text[i] === '\\' && text[i + 1] !== undefined) {
      i++;
      continue;
    }
    if (text[i] === '`') return i;
  }
  return -1;
}

function provePart(rawPart: string, state: ProofState, depth: number): Result {
  const trimmed = rawPart.trim();
  if (trimmed === '') return { status: 'rejected', reason: 'malformed-shell' };

  const redirected = stripSafeDiscardRedirects(trimmed);
  if (redirected === null) return { status: 'rejected', reason: 'unsafe-redirect' };
  const safePart = redirected.trim();
  const syntax = scanForbiddenSyntax(safePart);
  if (syntax !== null) return { status: 'rejected', reason: syntax };

  const substitutions = collectSubstitutions(safePart);
  const masked = maskSubstitutions(safePart, substitutions);

  if (/^(?:(?:do|then|else|elif|while|until|if|!|time)\s+)*export\b/.test(masked)) {
    return { status: 'rejected', reason: 'sensitive-assignment' };
  }

  const structuredHeader = findStructuredHeader(masked);
  if (structuredHeader?.kind === 'unsupported') {
    return { status: 'rejected', reason: 'unsupported-grammar' };
  }

  if (structuredHeader?.kind === 'for') {
    const header = safePart.slice(safePart.length - structuredHeader.remainder.length);
    return proveForHeader(structuredHeader.remainder, collectSubstitutions(header), state, depth);
  }

  const peeled = stripShellGrammar(masked);
  if (peeled.structural) {
    // `stripShellGrammar` intentionally treats any `for` header as structural;
    // the strict header branch above has already validated it. Other pure
    // grammar (`do`, `done`, `then`, `break`, ...) runs no external command.
    return {
      status: 'proved',
      leaves: [],
      substitutions: 0,
      outputKind: 'text',
    };
  }

  const bodyLength = peeled.command.length;
  const body = safePart.slice(safePart.length - bodyLength);
  const assignment = proveAssignments(body, substitutionsInBody(body), state, depth);
  if (assignment !== null) return assignment;

  if (substitutions.length > 0) {
    // Command substitution is allowed only as a value of a local assignment
    // or in a validated `for ... in ...` header. Allowing it in a command's
    // ordinary argv would require proving that its output cannot alter an
    // option, endpoint, or interpreter argument.
    return { status: 'rejected', reason: 'unsafe-command-substitution' };
  }

  const leaf = proveReadLeaf(body, state);
  if (leaf.status === 'rejected') return leaf;
  return {
    status: 'proved',
    leaves: [leaf.leaf],
    substitutions: 0,
    outputKind: leaf.outputKind,
  };
}

/**
 * Find a structured header after only known grammar prefixes. This mirrors the
 * safe peeling direction of `stripShellGrammar`, but is needed before that
 * function returns `structural`: `do for x in $(rm ... )` must validate the
 * nested header instead of letting the outer `do` hide it.
 */
function findStructuredHeader(
  masked: string,
): { readonly kind: 'for' | 'unsupported'; readonly remainder: string } | null {
  let rest = masked.trim();
  for (let i = 0; i < 16; i++) {
    if (/^for\b/.test(rest)) return { kind: 'for', remainder: rest };
    if (/^(?:select|case)\b/.test(rest)) return { kind: 'unsupported', remainder: rest };
    const prefix = /^(?:do|then|else|elif|while|until|if|!|time)(?=\s|$)/.exec(rest);
    if (prefix === null) return null;
    rest = rest.slice(prefix[0].length).trim();
  }
  return { kind: 'unsupported', remainder: rest };
}

function proveForHeader(
  masked: string,
  substitutions: readonly Substitution[],
  state: ProofState,
  depth: number,
): Result {
  const words = shellWords(masked);
  if (words.length < 4 || words[0] !== 'for' || words[2] !== 'in') {
    return { status: 'rejected', reason: 'unsupported-grammar' };
  }
  const variable = words[1];
  if (variable === undefined || !isVariableName(variable) || isSensitiveEnvironmentName(variable)) {
    return { status: 'rejected', reason: 'sensitive-assignment' };
  }
  if (words.slice(3).some((word) => word === '' || word.startsWith('-'))) {
    return { status: 'rejected', reason: 'unsupported-grammar' };
  }

  const nested = proveSubstitutions(substitutions, state, depth, true);
  if (nested.status === 'rejected') return nested;

  for (const word of words.slice(3)) {
    if (word.includes('$')) {
      // The only `$` permitted in a header is the command substitution already
      // masked above. Parameter expansion would make the iteration source
      // unknown, so it is not part of the proof language.
      if (!word.includes('_')) return { status: 'rejected', reason: 'unsupported-grammar' };
    } else if (!isStaticWord(word)) {
      return { status: 'rejected', reason: 'unsupported-grammar' };
    }
  }

  const staticItems = words.slice(3).filter((word) => !word.includes('_'));
  const hasSubstitution = substitutions.length > 0;
  const outputKind =
    hasSubstitution && nested.outputKind === 'ref' && staticItems.length === 0 ? 'ref' : 'text';
  // A literal list of branch names is safe in a ref position. A command
  // substitution is text unless its leaf explicitly emits a ref.
  state.variables.set(variable, hasSubstitution ? outputKind : 'ref');
  return {
    status: 'proved',
    leaves: nested.leaves,
    substitutions: nested.substitutions,
    outputKind: 'text',
  };
}

/**
 * Prove a segment made only of leading shell assignments. An assignment before
 * an external command is rejected: the command, not the assignment spelling,
 * defines whether an environment variable changes execution.
 */
function proveAssignments(
  body: string,
  substitutions: readonly Substitution[],
  state: ProofState,
  depth: number,
): Result | null {
  const masked = maskSubstitutions(body, substitutions);
  const words = shellWords(masked);
  if (words.length === 0 || !words.every((word) => isAssignmentToken(word))) return null;

  const nested = proveSubstitutions(substitutions, state, depth, true);
  if (nested.status === 'rejected') return nested;

  for (const word of words) {
    const separator = word.indexOf('=');
    const name = word.slice(0, separator);
    const value = word.slice(separator + 1);
    if (isSensitiveEnvironmentName(name)) {
      return { status: 'rejected', reason: 'sensitive-assignment' };
    }
    if (value.includes('$') && !value.includes('_')) {
      return { status: 'rejected', reason: 'unsafe-assignment' };
    }
    if (!value.includes('_') && !isStaticWord(value)) {
      return { status: 'rejected', reason: 'unsafe-assignment' };
    }
    const kind = value.includes('_') ? nested.outputKind : 'literal';
    state.variables.set(name, kind);
  }

  return {
    status: 'proved',
    leaves: nested.leaves,
    substitutions: nested.substitutions,
    outputKind: nested.outputKind,
  };
}

function proveSubstitutions(
  substitutions: readonly Substitution[],
  state: ProofState,
  depth: number,
  allowed: boolean,
): Result {
  if (substitutions.length === 0) {
    return { status: 'proved', leaves: [], substitutions: 0, outputKind: 'text' };
  }
  if (!allowed) return { status: 'rejected', reason: 'unsafe-command-substitution' };
  if (depth >= MAX_RECURSION_DEPTH) return { status: 'rejected', reason: 'recursion-limit' };

  const leaves: ReadOnlyProofLeaf[] = [];
  let count = 0;
  let outputKind: ValueKind = 'text';
  for (const substitution of substitutions) {
    const nested = proveScript(substitution.command, new Map(state.variables), depth + 1);
    if (nested.status === 'rejected') {
      return nested;
    }
    leaves.push(...nested.leaves);
    count += nested.substitutions + 1;
    outputKind = nested.outputKind;
    if (count > MAX_SUBSTITUTIONS) {
      return { status: 'rejected', reason: 'too-many-substitutions' };
    }
  }
  return { status: 'proved', leaves, substitutions: count, outputKind };
}

function proveReadLeaf(
  body: string,
  state: ProofState,
):
  | { readonly status: 'proved'; readonly leaf: ReadOnlyProofLeaf; readonly outputKind: ValueKind }
  | ProofFailure {
  const words = shellWords(body);
  const command = words[0];
  if (command === undefined) return { status: 'rejected', reason: 'unknown-command' };

  if (command === 'awk' || command === 'perl' || command === 'python' || command === 'python3') {
    return { status: 'rejected', reason: 'interpreter' };
  }

  if (command === 'git') return proveGitLeaf(words, state);

  if (command === 'echo' || command === 'pwd' || command === 'true' || command === ':') {
    return { status: 'proved', leaf: { name: command }, outputKind: 'text' };
  }

  if (command === 'printf') {
    if (words.includes('-v') || words.some((word) => word.startsWith('-v='))) {
      return { status: 'rejected', reason: 'unsafe-assignment' };
    }
    return { status: 'proved', leaf: { name: 'printf' }, outputKind: 'text' };
  }

  if (command === 'read') {
    for (const word of words.slice(1)) {
      if (word === '--') continue;
      if (word.startsWith('-')) continue;
      if (!isVariableName(word) || isSensitiveEnvironmentName(word)) {
        return { status: 'rejected', reason: 'unsafe-assignment' };
      }
      state.variables.set(word, 'text');
    }
    return { status: 'proved', leaf: { name: 'read' }, outputKind: 'text' };
  }

  if (command === 'cd') {
    return { status: 'proved', leaf: { name: 'cd' }, outputKind: 'text' };
  }

  if (STREAM_READ_COMMANDS.has(command)) {
    if (hasStreamExecutionOrWriteFlag(command, words)) {
      return { status: 'rejected', reason: 'unsafe-command' };
    }
    return {
      status: 'proved',
      leaf: { name: command },
      outputKind: command === 'wc' ? 'count' : 'text',
    };
  }

  return { status: 'rejected', reason: 'unknown-command' };
}

const STREAM_READ_COMMANDS: ReadonlySet<string> = new Set([
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
  'sort',
  'diff',
  'tr',
  'comm',
  'paste',
  'nl',
  'rev',
]);

/** Narrow execution/write escapes for otherwise read-oriented stream tools. */
function hasStreamExecutionOrWriteFlag(command: string, words: readonly string[]): boolean {
  if (command === 'tail' && words.some((word) => word === '-f' || word === '--follow')) return true;
  if (
    command === 'sort' &&
    words.some(
      (word) =>
        word === '-o' ||
        word.startsWith('-o') ||
        word === '--output' ||
        word.startsWith('--output=') ||
        word === '--compress-program' ||
        word.startsWith('--compress-program='),
    )
  )
    return true;
  if (
    command === 'diff' &&
    words.some((word) => word === '--old-group-format' || word === '--new-group-format')
  )
    return true;
  if (
    command === 'rg' &&
    words.some(
      (word) =>
        word === '--pre' ||
        word.startsWith('--pre=') ||
        word === '--pre-glob' ||
        word.startsWith('--pre-glob='),
    )
  )
    return true;
  return false;
}

function proveGitLeaf(
  words: readonly string[],
  state: ProofState,
):
  | { readonly status: 'proved'; readonly leaf: ReadOnlyProofLeaf; readonly outputKind: ValueKind }
  | ProofFailure {
  let index = 1;
  while (words[index] === '-C') {
    const path = words[index + 1];
    if (path === undefined || !isSafeGitWord(path, state, 'path')) {
      return { status: 'rejected', reason: 'unsafe-git-form' };
    }
    index += 2;
  }
  const subcommand = words[index];
  if (subcommand === undefined || subcommand.startsWith('-')) {
    return { status: 'rejected', reason: 'unsafe-git-form' };
  }
  const args = words.slice(index + 1);

  if (subcommand === 'worktree' && args.length > 0 && args[0] === 'list') {
    if (!args.slice(1).every((arg) => arg === '--porcelain' || arg === '--verbose')) {
      return { status: 'rejected', reason: 'unsafe-git-form' };
    }
    return {
      status: 'proved',
      leaf: { name: 'git:worktree-list' },
      outputKind: 'worktree-list',
    };
  }

  if (subcommand === 'rev-parse') {
    if (args.length === 2 && args[0] === '--abbrev-ref' && args[1] === 'HEAD') {
      return { status: 'proved', leaf: { name: 'git:rev-parse-abbrev-ref' }, outputKind: 'ref' };
    }
    if (args.length === 1 && args[0] === '--show-toplevel') {
      return { status: 'proved', leaf: { name: 'git:rev-parse-toplevel' }, outputKind: 'path' };
    }
    return { status: 'rejected', reason: 'unsafe-git-form' };
  }

  if (subcommand === 'status') {
    if (args.length === 1 && (args[0] === '--porcelain' || args[0] === '--short')) {
      return { status: 'proved', leaf: { name: 'git:status' }, outputKind: 'text' };
    }
    return { status: 'rejected', reason: 'unsafe-git-form' };
  }

  if (subcommand === 'branch') {
    if (
      args.length === 3 &&
      args[0] === '-r' &&
      args[1] === '--contains' &&
      isSafeGitWord(args[2] ?? '', state, 'ref')
    ) {
      return { status: 'proved', leaf: { name: 'git:branch-contains' }, outputKind: 'text' };
    }
    return { status: 'rejected', reason: 'unsafe-git-form' };
  }

  if (subcommand === 'ls-remote') {
    if (
      args.length === 3 &&
      args[0] === '--heads' &&
      isSafeGitWord(args[1] ?? '', state, 'remote') &&
      isSafeGitWord(args[2] ?? '', state, 'ref')
    ) {
      return { status: 'proved', leaf: { name: 'git:ls-remote-heads' }, outputKind: 'text' };
    }
    return { status: 'rejected', reason: 'unsafe-git-form' };
  }

  if (subcommand === 'rev-list') {
    if (
      args.length === 2 &&
      args[0] === '--count' &&
      isSafeGitWord(args[1] ?? '', state, 'revision')
    ) {
      return { status: 'proved', leaf: { name: 'git:rev-list-count' }, outputKind: 'count' };
    }
    return { status: 'rejected', reason: 'unsafe-git-form' };
  }

  if (subcommand === 'log') {
    if (
      args.length === 4 &&
      isSafeGitWord(args[0] ?? '', state, 'ref') &&
      args[1] === '--not' &&
      args[2] === '--remotes' &&
      args[3] === '--oneline'
    ) {
      return { status: 'proved', leaf: { name: 'git:log-remotes' }, outputKind: 'text' };
    }
    return { status: 'rejected', reason: 'unsafe-git-form' };
  }

  return { status: 'rejected', reason: 'unsafe-git-form' };
}

type GitWordRole = 'path' | 'ref' | 'remote' | 'revision';

function isSafeGitWord(word: string, state: ProofState, role: GitWordRole): boolean {
  if (word === '' || word.startsWith('-')) return false;
  for (const variable of variableReferences(word)) {
    const kind = state.variables.get(variable);
    if (kind === undefined) return false;
    if (role === 'ref' && kind !== 'ref') return false;
    if (role === 'revision' && kind !== 'ref' && kind !== 'literal') return false;
    if (role === 'remote') return false;
  }
  if (word.includes('$') && variableReferences(word).length === 0) return false;
  if (role === 'remote' && word.includes('/')) return false;
  return isStaticWord(word.replace(/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/g, 'x'));
}

function variableReferences(word: string): string[] {
  const references: string[] = [];
  const pattern = /\$([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
  for (const match of word.matchAll(pattern)) {
    const name = match[1] ?? match[2];
    if (name !== undefined) references.push(name);
  }
  return references;
}

function isAssignmentToken(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

function isVariableName(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(word);
}

/**
 * Names that alter interpreter, loader, Git, transport, or working-directory
 * behavior. This is intentionally broad; non-sensitive local variables are
 * enough for the observed inventory loops.
 */
function isSensitiveEnvironmentName(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    upper === 'PATH' ||
    upper === 'HOME' ||
    upper === 'PWD' ||
    upper === 'OLDPWD' ||
    upper === 'IFS' ||
    upper === 'CDPATH' ||
    upper === 'BASH_ENV' ||
    upper === 'ENV' ||
    upper === 'SHELLOPTS' ||
    upper === 'BASHOPTS' ||
    upper === 'GLOBIGNORE' ||
    upper.startsWith('BASH_') ||
    upper.startsWith('ZSH_') ||
    upper.startsWith('KSH_') ||
    upper.startsWith('GIT_') ||
    upper.startsWith('SSH_') ||
    upper.endsWith('_PROXY') ||
    upper === 'HTTP_PROXY' ||
    upper === 'HTTPS_PROXY' ||
    upper === 'ALL_PROXY' ||
    upper === 'NO_PROXY' ||
    upper.startsWith('LD_') ||
    upper.startsWith('DYLD_') ||
    upper.startsWith('PYTHON') ||
    upper === 'RUBYOPT' ||
    upper === 'NODE_OPTIONS' ||
    upper === 'PERL5OPT' ||
    upper === 'PROMPT_COMMAND'
  );
}

/** Literal/parameter-free values. Expansion is handled before this check. */
function isStaticWord(word: string): boolean {
  return word !== '' && !/[\s;&|<>`$(){}[\]*?~]/.test(word);
}

/** Find live `$()` spans, ignoring quoted literal text. */
function collectSubstitutions(text: string): Substitution[] {
  const substitutions: Substitution[] = [];
  let quote: '"' | "'" | "$'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (c === undefined) break;
    if (quote === '"') {
      if (c === '\\' && next !== undefined) {
        i++;
        continue;
      }
      if (c === '$' && next === '(') {
        const end = findCommandSubstitutionEnd(text, i);
        if (end === -1) return [];
        substitutions.push({ start: i, end, command: text.slice(i + 2, end) });
        i = end;
        continue;
      }
      if (c === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    if (quote === "$'") {
      if (c === '\\' && next !== undefined) {
        i++;
        continue;
      }
      if (c === "'") quote = null;
      continue;
    }
    if (c === '\\' && next !== undefined) {
      i++;
      continue;
    }
    if (c === '$' && next === "'") {
      quote = "$'";
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '$' && next === '(') {
      const end = findCommandSubstitutionEnd(text, i);
      if (end === -1) return [];
      substitutions.push({ start: i, end, command: text.slice(i + 2, end) });
      i = end;
    }
  }
  return substitutions;
}

function substitutionsInBody(body: string): Substitution[] {
  return collectSubstitutions(body);
}

/** Replace live substitutions with same-length inert characters. */
function maskSubstitutions(text: string, substitutions: readonly Substitution[]): string {
  if (substitutions.length === 0) return text;
  const chars = text.split('');
  for (const substitution of substitutions) {
    for (let i = substitution.start; i <= substitution.end; i++) {
      if (chars[i] !== undefined) chars[i] = '_';
    }
  }
  return chars.join('');
}

/**
 * Permit only the already-established discard/fd-dup redirects. A real path,
 * input redirect, glued redirect, `&>` form, or opaque target is rejected.
 */
function stripSafeDiscardRedirects(segment: string): string | null {
  // Parse only the current shell level. Quoted `>` characters are prose, and
  // redirects inside `$()` belong to the recursive proof of that substitution;
  // inspecting raw text here would mistake both for redirects owned by this
  // segment (`echo "$b -> $n"` was the concrete false positive).
  const substitutions = collectSubstitutions(segment);
  const visible = maskQuotedSpans(maskSubstitutions(segment, substitutions));
  const clauses = findRedirectClauses(visible);
  if (clauses.length === 0) return segment;

  const ranges: Array<{ readonly start: number; readonly end: number }> = [];
  let cursor = 0;
  for (const clause of clauses) {
    const index = visible.indexOf(clause.text, cursor);
    if (index === -1) return null;
    const before = visible[index - 1];
    if (index > 0 && before !== undefined && (!/\s/.test(before) || before === '&')) {
      return null;
    }
    const safeDiscard = /^\d*>>?\/dev\/null$/.test(clause.text);
    const safeDup = /^\d*>>?&\d+$/.test(clause.text);
    if (clause.target.kind === 'opaque' || (!safeDiscard && !safeDup)) return null;
    ranges.push({ start: index, end: index + clause.text.length });
    cursor = index + clause.text.length;
  }

  let result = '';
  let start = 0;
  for (const range of ranges) {
    result += segment.slice(start, range.start);
    start = range.end;
  }
  return result + segment.slice(start);
}

/** Return the first unsupported live shell construct, if any. */
function scanForbiddenSyntax(segment: string): ReadOnlyProofReason | null {
  let quote: '"' | "'" | "$'" | null = null;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    const next = segment[i + 1];
    if (c === undefined) break;
    if (quote === '"') {
      if (c === '\\' && next !== undefined) {
        if (next === '\n' || next === '\r') return 'unsupported-shell-control';
        i++;
        continue;
      }
      if (c === '$' && next === '(') {
        const end = findCommandSubstitutionEnd(segment, i);
        if (end === -1) return 'malformed-shell';
        i = end;
        continue;
      }
      if (c === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    if (quote === "$'") {
      if (c === '\\' && next !== undefined) {
        i++;
        continue;
      }
      if (c === "'") quote = null;
      continue;
    }
    if (c === '\\' && next !== undefined) {
      if (next === '\n' || next === '\r') return 'unsupported-shell-control';
      i++;
      continue;
    }
    if (c === '$' && next === "'") {
      quote = "$'";
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '$' && next === '(') {
      const end = findCommandSubstitutionEnd(segment, i);
      if (end === -1) return 'malformed-shell';
      i = end;
      continue;
    }
    if (c === '`') return 'unsafe-command-substitution';
    if (c === '&' || c === '<' || c === '>' || c === '(' || c === ')' || c === '{' || c === '}') {
      return 'unsupported-shell-control';
    }
    if (c === '#' && (i === 0 || /\s/.test(segment[i - 1] ?? ''))) {
      return 'unsupported-shell-control';
    }
  }
  return quote === null ? null : 'malformed-shell';
}
