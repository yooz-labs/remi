/**
 * Universal Remote Target Resolver
 *
 * Parses positional subcommand args (e.g., "host:port/session-name") combined
 * with --host/--port CLI flags into a structured target. Used by attach, kill,
 * and detach subcommands to resolve where and what to operate on.
 *
 * Pure function: no side effects, no network calls.
 */

import { parseHostPort, parseRemoteTarget } from './ls-client.ts';

export class TargetParseError extends Error {
  readonly suggestion?: string | undefined;

  constructor(message: string, suggestion?: string) {
    super(message);
    this.name = 'TargetParseError';
    this.suggestion = suggestion;
  }
}

export interface ResolvedTarget {
  readonly host: string;
  readonly port: number;
  readonly targetId: string | undefined;
}

export interface ResolveTargetInput {
  readonly subcommandArg: string | undefined;
  readonly cliHost: string | undefined;
  readonly cliPort: number | undefined;
  readonly defaultPort: number;
}

/**
 * Resolve a remote target from a positional arg and/or CLI flags.
 *
 * Resolution order:
 * 1. If arg matches host:port/session -> parse inline (overrides --host/--port)
 * 2. If arg matches host:port -> parse inline (no targetId)
 * 3. If arg is a plain string -> treat as session name; use --host/--port or defaults
 * 4. No arg -> use --host/--port or defaults; targetId is undefined
 *
 * Throws TargetParseError for copy-paste garbage detection.
 */
export function resolveTarget(input: ResolveTargetInput): ResolvedTarget {
  const { subcommandArg, cliHost, cliPort, defaultPort } = input;

  const host = cliHost ?? 'localhost';
  const port = cliPort ?? defaultPort;

  if (!subcommandArg) {
    return { host, port, targetId: undefined };
  }

  // Check for host:port/session format
  // Heuristic: if there's a slash, and the segment between the last colon
  // before the slash and the slash itself is all digits, it's a remote target.
  // Session names like "hostname:dir/branch" have non-numeric dir segments.
  // Known limitation: a purely numeric directory name (e.g., "8765") would be
  // misidentified as a port number.
  const firstSlash = subcommandArg.indexOf('/');
  const colonIdx = firstSlash > 0 ? subcommandArg.lastIndexOf(':', firstSlash - 1) : -1;
  const hasRemoteFormat =
    colonIdx > 0 && /^\d+$/.test(subcommandArg.slice(colonIdx + 1, firstSlash));

  if (hasRemoteFormat) {
    const remote = parseRemoteTarget(subcommandArg, port);
    return { host: remote.host, port: remote.port, targetId: remote.sessionId };
  }

  // Check for host:port without session (for auto-attach)
  const hostPortParsed = parseHostPort(subcommandArg);
  if (hostPortParsed?.cleaned) {
    const corrected = `${hostPortParsed.host}:${hostPortParsed.port}`;
    throw new TargetParseError(
      `Invalid target "${subcommandArg}". Did you mean "${corrected}"?`,
      corrected,
    );
  }
  if (hostPortParsed) {
    return { host: hostPortParsed.host, port: hostPortParsed.port, targetId: undefined };
  }

  // Plain session name or ID
  return { host, port, targetId: subcommandArg };
}
