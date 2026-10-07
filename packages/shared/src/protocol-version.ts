/**
 * The protocol version and the capabilities a daemon advertises on `hello_ack`
 * (#1237, ADR 0035), and how a client decides whether a machine can do what it
 * needs.
 */

import { escapeUnsafeText } from './display-text.ts';

/**
 * The wire's version. It changes only on a breaking change (a field removed or
 * renamed, a field whose meaning changes, a message removed, or a request an
 * older client sends that a newer daemon would refuse); an additive change never
 * changes it. Every `hello_ack` carries it since #1237; an ack without it comes
 * from an older daemon.
 */
export const PROTOCOL_VERSION = 1;

/**
 * The version of an ack that names none: a daemon older than #1237, whose wire is
 * the baseline of version 1. A client compares it like any other version.
 */
const VERSIONLESS_ACK_VERSION = 1;

/** Said of a machine whose remi must change: a daemon keeps its binary until it restarts (#539). */
const UPDATE_MACHINE = 'Update remi on that machine and restart it.';

/**
 * Every capability a daemon may list in `hello_ack.capabilities`, with what a
 * daemon that lists it does, phrased to follow "cannot" in a message to the
 * person. A capability names an additive feature a client cannot see in the
 * messages themselves (a request field an older daemon would ignore); it is
 * added by the change that ships the feature. Empty since #1237: everything a
 * daemon did before is the baseline of version 1 (ADR 0035).
 */
export const PROTOCOL_CAPABILITIES: Readonly<Record<string, string>> = {};

/** Whether a machine supports what a client needs, from its `hello_ack`. */
export type HubSupport =
  | { readonly supported: true }
  | {
      readonly supported: false;
      /** `protocol-version`: the versions differ or cannot be read; `capabilities`: one or more are missing. */
      readonly reason: 'protocol-version' | 'capabilities';
      /** The needed capabilities the machine does not list (empty for `protocol-version`). */
      readonly missing: readonly string[];
      /** What to tell the person, naming which side to update. */
      readonly message: string;
    };

/** The most code points of a daemon version a message quotes; the daemon chose it. */
const MAX_QUOTED_VERSION = 40;

/** The `hello_ack` fields {@link hubSupport} reads, typed as a client receives them. */
export interface HubSupportAck {
  readonly protocolVersion?: unknown;
  readonly capabilities?: unknown;
  readonly daemonVersion?: unknown;
}

/**
 * Whether the machine behind `ack` supports `needs` (capability names from
 * {@link PROTOCOL_CAPABILITIES}) for a client that speaks `clientVersion`.
 *
 * - No `protocolVersion`: a daemon older than #1237, whose wire is the baseline
 *   of version 1, so it is compared as version 1. It lists no capabilities, so a
 *   client that needs one is told to update it.
 * - A protocol version other than the client's, in either direction, or one that
 *   is not a positive integer: not supported, and the message says which side to
 *   update. There is no range: a client and a daemon must speak the same version
 *   (ADR 0035).
 * - A needed capability the machine does not list: not supported, named with
 *   what it does.
 *
 * Capability names the client does not know are ignored, so a newer daemon's
 * additions cannot break an older client. Decide with this, never by comparing
 * `daemonVersion`.
 */
export function hubSupport(
  ack: HubSupportAck,
  needs: readonly string[] = [],
  clientVersion: number = PROTOCOL_VERSION,
): HubSupport {
  const remi = quotedRemi(ack.daemonVersion);
  // `=== undefined`, not `??`: a null version is unreadable, not absent.
  const version = ack.protocolVersion === undefined ? VERSIONLESS_ACK_VERSION : ack.protocolVersion;

  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    return {
      supported: false,
      reason: 'protocol-version',
      missing: [],
      message: `${remi} sent a protocol version this app cannot read. ${UPDATE_MACHINE} Update this app too.`,
    };
  }
  if (version !== clientVersion) {
    const update = version > clientVersion ? 'Update this app.' : UPDATE_MACHINE;
    return {
      supported: false,
      reason: 'protocol-version',
      missing: [],
      message: `${remi} speaks protocol version ${version}, and this app speaks version ${clientVersion}. ${update}`,
    };
  }

  const listed = new Set(
    Array.isArray(ack.capabilities)
      ? ack.capabilities.filter((name): name is string => typeof name === 'string')
      : [],
  );
  const missing = [...new Set(needs)].filter((name) => !listed.has(name));
  if (missing.length === 0) return { supported: true };

  const cannot = missing
    .map((name) =>
      // Not Object.hasOwn: the Capacitor app runs on iOS 15.0, and hasOwn needs Safari 15.4.
      Object.prototype.hasOwnProperty.call(PROTOCOL_CAPABILITIES, name)
        ? PROTOCOL_CAPABILITIES[name]
        : name,
    )
    .join('; ');
  return {
    supported: false,
    reason: 'capabilities',
    missing,
    message: `${remi} cannot ${cannot}. ${UPDATE_MACHINE}`,
  };
}

/** "This machine's remi (<version>)", the version escaped and cut, or without it when absent or not text. */
function quotedRemi(daemonVersion: unknown): string {
  if (typeof daemonVersion !== 'string' || daemonVersion === '') return "This machine's remi";
  // Cut before escaping, by code point, so the cut never lands inside an escape or a surrogate pair.
  const points = [...daemonVersion];
  const shown =
    points.length > MAX_QUOTED_VERSION
      ? `${oneLine(points.slice(0, MAX_QUOTED_VERSION).join(''))}...`
      : oneLine(daemonVersion);
  return `This machine's remi (${shown})`;
}

/** {@link escapeUnsafeText}, plus the newline and tab it leaves alone, since a message is one line. */
function oneLine(text: string): string {
  return escapeUnsafeText(text).replaceAll('\n', '\\u000A').replaceAll('\t', '\\u0009');
}
