/**
 * A deterministic, fail-closed proof for a small shell read-only language
 * (#1082, extended by Phase 2 of epic #1092).
 *
 * This is deliberately a proof, not a risk heuristic. It returns `proved`
 * only when every command and every command substitution belongs to the
 * finite read-only language below. Unknown shell syntax, wrappers,
 * interpreters, real redirects, sensitive assignments, and unrecognised Git
 * forms are rejected. A false negative costs a model call; a false positive
 * would turn an unreviewed shell command into an approval.
 *
 * The proof is not itself an authorization. The capability registry and
 * requested-group gate use it together with
 * a fresh authorization assessment, but Phase 3 does not change approval
 * behavior. In particular, this module does not inspect the filesystem,
 * execute Git, expand variables, or trust model text.
 */

import { githubSubIssueActionEffect } from './operation-effects.ts';
import {
  findRedirectClauses,
  ghTopIndex,
  hasUnsafeGhApiExpansion,
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
 * Prove that `command` is an effect-free read/query script in the Phase 2
 * language. The result is intentionally typed so callers cannot confuse an
 * unknown command with a successful proof.
 */
export function proveCompoundReadOnly(command: string): ReadOnlyProof {
  if (command.trim() === '') return { status: 'rejected', reason: 'empty-command' };
  if (command.length > MAX_COMMAND_CHARS) {
    return { status: 'rejected', reason: 'command-too-long' };
  }

  // Python is an interpreter and therefore never enters the generic shell
  // grammar. The only exception is an exact, quoted-heredoc lock inspection
  // template whose source, imports, file mode, and output code are all fixed
  // below. An arbitrary Python script remains rejected even when a model calls
  // it read-only.
  const python = provePythonLockInspection(command);
  if (python !== null) return python;

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
    } else if (!isSafeStaticHeaderWord(word)) {
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

/** shellWords preserves a quoted item's internal whitespace but not its quotes. */
function isSafeStaticHeaderWord(word: string): boolean {
  return isStaticWord(word) || /^[A-Za-z0-9_./:@%+=,-]+(?:\s+[A-Za-z0-9_./:@%+=,-]+)+$/.test(word);
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

  if (command === 'awk') {
    const projection = proveAwkFieldProjection(body);
    if (projection !== null) return projection;
    return { status: 'rejected', reason: 'interpreter' };
  }

  if (command === 'perl' || command === 'python' || command === 'python3') {
    return { status: 'rejected', reason: 'interpreter' };
  }

  if (command === 'git') return proveGitLeaf(words, state);

  if (command === 'find') return proveFindLeaf(words);

  if (command === 'gh') return proveGhLeaf(words, state, body);

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

/**
 * Prove the one Python family we are willing to run without a human/model
 * decision. The heredoc delimiter must be quoted, the lockfile name is a
 * simple repository-local filename, and every source line is part of a fixed
 * inspection template. This is intentionally a template matcher, not a
 * Python parser: anything outside these exact shapes remains an interpreter
 * and fails closed.
 */
function provePythonLockInspection(command: string): ReadOnlyProof | null {
  const heredoc = /^(?:python3|python) - <<'PY'\r?\n([\s\S]*)\r?\nPY$/.exec(command);
  if (heredoc === null) return null;
  const body = heredoc[1];
  if (body === undefined) return null;
  const lines = body.split(/\r?\n/);

  if (proveTomlLockInspection(lines)) {
    return { status: 'proved', leaves: [{ name: 'python:lock-inspection' }] };
  }
  return null;
}

function proveTomlLockInspection(lines: readonly string[]): boolean {
  if (lines.length !== 9 || lines[0] !== 'import tomllib') return false;
  const load =
    /^d = tomllib\.load\(open\((['"])([A-Za-z0-9][A-Za-z0-9_.-]*\.lock)\1,(['"])rb\3\)\)$/.exec(
      lines[1] ?? '',
    );
  if (load === null || lines[2] !== "pkgs = {p['name']: p for p in d['package']}") return false;
  if (!parsePythonStringList(lines[3] ?? '')) return false;
  return (
    lines[4] === '    p = pkgs.get(n)' &&
    lines[5] === '    if not p: continue' &&
    lines[6] === "    print('==', n, p.get('version'))" &&
    lines[7] === "    for x in p.get('dependencies',[]):" &&
    lines[8] === "        print('   ', x)"
  );
}

/** Parse only a list of simple Python string literals used as package names. */
function parsePythonStringList(line: string): boolean {
  const match = /^for n in \[(.*)\]:$/.exec(line);
  if (match === null) return false;
  const content = match[1]?.trim() ?? '';
  if (content === '') return false;
  const entries = content.split(',');
  if (entries.length > 32) return false;
  return entries.every((entry) => {
    const item = entry.trim();
    const literal = /^(['"])([A-Za-z0-9][A-Za-z0-9_.-]*)\1$/.exec(item);
    return literal !== null;
  });
}

/**
 * `find` is a read-only command only for a small expression language. In
 * particular, output-to-file predicates and all exec/delete predicates are
 * rejected instead of being hidden behind the ordinary `find` group prefix.
 */
function proveFindLeaf(words: readonly string[]):
  | {
      readonly status: 'proved';
      readonly leaf: ReadOnlyProofLeaf;
      readonly outputKind: ValueKind;
    }
  | ProofFailure {
  if (words.length < 2) return { status: 'rejected', reason: 'unsupported-grammar' };

  let index = 1;
  let sawPath = false;
  let sawExpression = false;
  while (index < words.length) {
    const word = words[index];
    if (word === undefined || word === '')
      return { status: 'rejected', reason: 'unsupported-grammar' };

    if (!word.startsWith('-') && word !== '!' && word !== '(' && word !== ')') {
      // Find start paths precede the expression. A second positional after a
      // predicate is ambiguous (it may be an accidental action argument), so
      // the bounded grammar refuses it.
      if (sawExpression || !isSafeFindPath(word)) {
        return { status: 'rejected', reason: 'unsupported-grammar' };
      }
      sawPath = true;
      index++;
      continue;
    }

    if (!sawPath) return { status: 'rejected', reason: 'unsupported-grammar' };
    if (word === '!' || word === '(' || word === ')' || FIND_LOGICAL_PREDICATES.has(word)) {
      sawExpression = true;
      index++;
      continue;
    }
    if (FIND_BOOLEAN_PREDICATES.has(word)) {
      sawExpression = true;
      index++;
      continue;
    }
    if (FIND_VALUE_PREDICATES.has(word)) {
      const value = words[index + 1];
      if (value === undefined || value.startsWith('-') || !isSafeFindValue(value, word)) {
        return { status: 'rejected', reason: 'unsupported-grammar' };
      }
      sawExpression = true;
      index += 2;
      continue;
    }
    // Explicitly name the dangerous family in the proof so a future predicate
    // cannot accidentally become a harmless-looking unknown flag.
    if (
      FIND_UNSAFE_PREDICATES.has(word) ||
      word.startsWith('-exec') ||
      word.startsWith('-fprint')
    ) {
      return { status: 'rejected', reason: 'unsafe-command' };
    }
    return { status: 'rejected', reason: 'unsupported-grammar' };
  }

  if (!sawPath || !sawExpression) return { status: 'rejected', reason: 'unsupported-grammar' };
  return { status: 'proved', leaf: { name: 'find' }, outputKind: 'text' };
}

const FIND_LOGICAL_PREDICATES: ReadonlySet<string> = new Set(['-a', '-and', '-o', '-or', '-not']);

const FIND_BOOLEAN_PREDICATES: ReadonlySet<string> = new Set([
  '-print',
  '-print0',
  '-ls',
  '-prune',
  '-quit',
  '-xdev',
  '-mount',
  '-depth',
  '-d',
  '-H',
  '-L',
  '-P',
  '-readable',
  '-writable',
]);

const FIND_VALUE_PREDICATES: ReadonlySet<string> = new Set([
  '-name',
  '-iname',
  '-path',
  '-ipath',
  '-regex',
  '-iregex',
  '-type',
  '-maxdepth',
  '-mindepth',
  '-size',
  '-user',
  '-group',
  '-perm',
  '-newer',
]);

const FIND_UNSAFE_PREDICATES: ReadonlySet<string> = new Set([
  '-delete',
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-fprint',
  '-fprint0',
  '-fprintf',
  '-fls',
]);

function isSafeFindPath(path: string): boolean {
  return (
    /^[A-Za-z0-9_./:@%+=,-]+$/.test(path) &&
    !path.startsWith('-') &&
    !path.split('/').includes('..')
  );
}

function isSafeFindValue(value: string, predicate: string): boolean {
  if (!/^[A-Za-z0-9_./*?[\\\]:+,@%+=-]+$/.test(value)) return false;
  if (predicate === '-type') return /^[bcdflps]$/.test(value);
  if (predicate === '-maxdepth' || predicate === '-mindepth') return /^\d{1,4}$/.test(value);
  if (predicate === '-size') return /^[+-]?\d{1,9}[cwbkMG]?$/.test(value);
  return true;
}

function proveGhLeaf(
  words: readonly string[],
  state: ProofState,
  rawBody: string,
):
  | {
      readonly status: 'proved';
      readonly leaf: ReadOnlyProofLeaf;
      readonly outputKind: ValueKind;
    }
  | ProofFailure {
  const topIndex = ghTopIndex(words);
  if (topIndex === -1) return { status: 'rejected', reason: 'unknown-command' };
  if (!proveGhGlobalOptions(words, topIndex)) {
    return { status: 'rejected', reason: 'unsupported-grammar' };
  }

  const top = words[topIndex];
  const action = words[topIndex + 1];
  if (top === 'sub-issue') {
    if (githubSubIssueActionEffect(action) !== 'read') {
      return { status: 'rejected', reason: 'unsafe-command' };
    }
    const parent = parseGhSubIssueListArgs(words.slice(topIndex + 2), state);
    if (parent === null) return { status: 'rejected', reason: 'unsupported-grammar' };
    return { status: 'proved', leaf: { name: 'gh:sub-issue-list' }, outputKind: 'text' };
  }

  if (top === 'issue' && action === 'list') {
    const parsed = parseGhIssueListArgs(words.slice(topIndex + 2));
    if (parsed === null) return { status: 'rejected', reason: 'unsupported-grammar' };
    return {
      status: 'proved',
      leaf: { name: 'gh:issue-list' },
      outputKind: parsed.numericSelector ? 'ref' : 'text',
    };
  }

  if (top === 'issue' && action === 'view') {
    const parsed = parseGhIssueViewArgs(words.slice(topIndex + 2), state);
    if (parsed === null) return { status: 'rejected', reason: 'unsupported-grammar' };
    return { status: 'proved', leaf: { name: 'gh:issue-view' }, outputKind: 'text' };
  }

  if (top === 'api') {
    if (hasUnsafeGhApiExpansion(rawBody) || !proveGhApiReadArgs(words.slice(topIndex + 1))) {
      return { status: 'rejected', reason: 'unsupported-grammar' };
    }
    return { status: 'proved', leaf: { name: 'gh:api-get' }, outputKind: 'text' };
  }

  return { status: 'rejected', reason: 'unknown-command' };
}

function proveGhGlobalOptions(words: readonly string[], topIndex: number): boolean {
  for (let index = 1; index < topIndex; index++) {
    const token = words[index];
    if (token === undefined) return false;
    if (token === '--repo' || token === '-R' || token === '--hostname') {
      const value = words[index + 1];
      if (value === undefined || !isSafeGhGlobalValue(value, token)) return false;
      index++;
      continue;
    }
    if (token.startsWith('--repo=') || token.startsWith('--hostname=')) {
      if (
        !isSafeGhGlobalValue(
          token.slice(token.indexOf('=') + 1),
          token.slice(0, token.indexOf('=')),
        )
      ) {
        return false;
      }
      continue;
    }
    return false;
  }
  return true;
}

function parseGhSubIssueListArgs(args: readonly string[], state: ProofState): string | null {
  let parent: string | null = null;
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === undefined) return null;
    if (token === '--repo' || token === '-R' || token === '--hostname') {
      const value = args[index + 1];
      if (value === undefined || !isSafeGhGlobalValue(value, token)) return null;
      index++;
      continue;
    }
    if (token.startsWith('--repo=') || token.startsWith('--hostname=')) {
      if (
        !isSafeGhGlobalValue(
          token.slice(token.indexOf('=') + 1),
          token.slice(0, token.indexOf('=')),
        )
      ) {
        return null;
      }
      continue;
    }
    if (token.startsWith('-') || parent !== null || !isGhIssueReference(token, state)) return null;
    parent = token;
  }
  return parent;
}

interface ParsedGhIssueList {
  readonly numericSelector: boolean;
}

function parseGhIssueListArgs(args: readonly string[]): ParsedGhIssueList | null {
  let numericSelector = false;
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === undefined) return null;
    const consumed = consumeGhOutputOption(args, index);
    if (consumed === undefined) return null;
    if (consumed !== null) {
      if (consumed.kind === 'jq' && consumed.value === '.[].number') numericSelector = true;
      index = consumed.nextIndex;
      continue;
    }
    if (token === '--state' || token === '--label' || token === '--limit') {
      const value = args[index + 1];
      if (value === undefined) return null;
      if (token === '--state' && !new Set(['open', 'closed', 'all']).has(value)) return null;
      if (token === '--label' && !isSafeGhMetadata(value, false)) return null;
      if (token === '--limit' && !/^[1-9]\d{0,3}$/.test(value)) return null;
      index++;
      continue;
    }
    if (token.startsWith('-')) return null;
    return null;
  }
  return { numericSelector };
}

function parseGhIssueViewArgs(args: readonly string[], state: ProofState): string | null {
  let issue: string | null = null;
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === undefined) return null;
    const consumed = consumeGhOutputOption(args, index);
    if (consumed === undefined) return null;
    if (consumed !== null) {
      index = consumed.nextIndex;
      continue;
    }
    if (token === '--comments') continue;
    if (token === '--repo' || token === '-R' || token === '--hostname') {
      const value = args[index + 1];
      if (value === undefined || !isSafeGhGlobalValue(value, token)) return null;
      index++;
      continue;
    }
    if (token.startsWith('--repo=') || token.startsWith('--hostname=')) {
      if (
        !isSafeGhGlobalValue(
          token.slice(token.indexOf('=') + 1),
          token.slice(0, token.indexOf('=')),
        )
      ) {
        return null;
      }
      continue;
    }
    if (token.startsWith('-') || issue !== null || !isGhIssueReference(token, state)) return null;
    issue = token;
  }
  return issue;
}

interface ConsumedGhOutputOption {
  readonly kind: 'json' | 'jq' | 'template';
  readonly value: string;
  readonly nextIndex: number;
}

function consumeGhOutputOption(
  args: readonly string[],
  index: number,
): ConsumedGhOutputOption | null | undefined {
  const token = args[index];
  if (token === undefined) return null;
  let kind: ConsumedGhOutputOption['kind'] | null = null;
  let flagLength = 0;
  if (token === '--json') {
    kind = 'json';
    flagLength = token.length;
  } else if (token === '--jq' || token === '-q') {
    kind = 'jq';
    flagLength = token.length;
  } else if (token === '--template' || token === '-t') {
    kind = 'template';
    flagLength = token.length;
  } else if (token.startsWith('--json=')) {
    kind = 'json';
    flagLength = '--json='.length;
  } else if (token.startsWith('--jq=')) {
    kind = 'jq';
    flagLength = '--jq='.length;
  } else if (token.startsWith('--template=')) {
    kind = 'template';
    flagLength = '--template='.length;
  }
  if (kind === null) return null;

  const inline = token.includes('=') ? token.slice(flagLength) : undefined;
  const value = inline ?? args[index + 1];
  if (value === undefined || value === '' || value.startsWith('-')) return undefined;
  if (kind === 'json' && !/^[A-Za-z][A-Za-z0-9_,.-]*$/.test(value)) return undefined;
  if (kind !== 'json' && !isSafeGhSelector(value)) return undefined;
  return { kind, value, nextIndex: inline === undefined ? index + 1 : index };
}

function proveGhApiReadArgs(args: readonly string[]): boolean {
  let endpoint: string | null = null;
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === undefined) return false;
    if (token === '--' || !token.startsWith('-')) {
      if (token === '--' || endpoint !== null || !isSafeGhEndpoint(token)) return false;
      endpoint = token;
      continue;
    }
    if (token === '-X' || token === '--method') {
      if (args[index + 1] !== 'GET') return false;
      index++;
      continue;
    }
    if (token.startsWith('-X') && token.length > 2) {
      if (token.slice(2) !== 'GET') return false;
      continue;
    }
    if (token.startsWith('--method=')) {
      if (token.slice('--method='.length) !== 'GET') return false;
      continue;
    }
    if (new Set(['--include', '-i', '--paginate', '--slurp', '--silent']).has(token)) continue;
    const consumed = consumeGhOutputOption(args, index);
    if (consumed === undefined) return false;
    if (consumed !== null) {
      index = consumed.nextIndex;
      continue;
    }
    return false;
  }
  return endpoint !== null;
}

function isGhIssueReference(value: string, state: ProofState): boolean {
  if (/^[1-9]\d{0,8}$/.test(value)) return true;
  const match = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
  return match !== null && state.variables.get(match[1] ?? '') === 'ref';
}

function isSafeGhMetadata(value: string, hostname: boolean): boolean {
  if (hostname) return /^[A-Za-z0-9.-]+$/.test(value) && value.includes('.');
  return /^[A-Za-z0-9_.:/,@%+=-]+$/.test(value);
}

function isSafeGhRepository(value: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function isSafeGhGlobalValue(value: string, option: string): boolean {
  if (option === '--hostname') return isSafeGhMetadata(value, true);
  if (option === '--repo' || option === '-R') return isSafeGhRepository(value);
  return false;
}

function isSafeGhSelector(value: string): boolean {
  return /^[A-Za-z0-9_.\[\]:'",|() +*/!=<>?{}-]+$/.test(value);
}

function isSafeGhEndpoint(endpoint: string): boolean {
  if (
    endpoint === '' ||
    endpoint.startsWith('//') ||
    endpoint.startsWith('~') ||
    endpoint.includes('$') ||
    /^[a-z][a-z0-9+.-]*:/i.test(endpoint)
  ) {
    return false;
  }
  const firstPart = endpoint.replace(/^\/+/, '').split(/[/?#]/, 1)[0]?.toLowerCase();
  if (firstPart === 'graphql') return false;
  if (!/^[A-Za-z0-9_./{}?=#&:+,@%~*-]+$/.test(endpoint)) return false;
  for (const match of endpoint.matchAll(/\{([^{}]*)\}/g)) {
    const body = match[1] ?? '';
    if (body.includes(',') || body.includes('..')) return false;
  }
  return !/[{}]/.test(endpoint.replace(/\{[^{}]*\}/g, ''));
}

/**
 * Prove only the raw spelling of a single-action awk field projection.
 *
 * `shellWords` intentionally removes quote boundaries, so it cannot establish
 * that the program was one literal, single-quoted argument. Keep this check on
 * the raw segment and anchor every character outside the field number: no awk
 * options, extra programs or files, patterns, statements, interpolation,
 * printf/system/getline, pipes, or redirects can reach the approved leaf.
 */
const AWK_FIELD_PROJECTION_RE =
  /^awk(?:[ \t]+-F(?::|[A-Za-z0-9_.+-]+)|[ \t]+-F[ \t]+['"][A-Za-z0-9_.+-]+['"])?[ \t]+'\{[ \t]*print[ \t]+\$[0-9]+[ \t]*\}'$/;

function proveAwkFieldProjection(body: string): {
  readonly status: 'proved';
  readonly leaf: ReadOnlyProofLeaf;
  readonly outputKind: ValueKind;
} | null {
  if (!AWK_FIELD_PROJECTION_RE.test(body)) return null;
  return {
    status: 'proved',
    leaf: { name: 'awk:print-field' },
    outputKind: 'text',
  };
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
  'tree',
]);

/** Narrow execution/write escapes for otherwise read-oriented stream tools. */
function hasStreamExecutionOrWriteFlag(command: string, words: readonly string[]): boolean {
  if (command === 'tail' && words.some((word) => word === '-f' || word === '--follow')) return true;
  if (
    (command === 'sort' || command === 'tree' || command === 'diff') &&
    words.some((word) => {
      if (
        word === '-o' ||
        (word.startsWith('-') && !word.startsWith('--') && /^[A-Za-z]*o/.test(word.slice(1)))
      ) {
        return true;
      }
      if (word === '--output' || word.startsWith('--output=')) return true;
      if (
        command === 'sort' &&
        (word === '--compress-program' || word.startsWith('--compress-program='))
      ) {
        return true;
      }
      if (word.startsWith('--')) {
        const name = word.slice(2).split('=', 1)[0] ?? '';
        if (name !== '' && 'output'.startsWith(name)) return true;
      }
      return false;
    })
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
    upper.startsWith('GH_') ||
    upper.startsWith('GITHUB_') ||
    upper.endsWith('_PROXY') ||
    upper === 'HTTP_PROXY' ||
    upper === 'HTTPS_PROXY' ||
    upper === 'ALL_PROXY' ||
    upper === 'NO_PROXY' ||
    upper === 'PAGER' ||
    upper === 'LESS' ||
    upper === 'LESSOPEN' ||
    upper === 'MANPAGER' ||
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
