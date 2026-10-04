/**
 * Which harnesses this daemon can start for a `create_session_request`
 * (#1179, epic #1175 phase 5), and the trust-boundary rules for each.
 *
 * A harness is offered when this build has an adapter for it AND its command
 * resolves on this process's PATH. The command is never run to find out
 * (running `codex` or `claude` to probe it would start the very thing the
 * check guards). The list rides on every `hello_ack` as `harnesses`, so a
 * client asks for a harness only after it sees it there; an OLDER hub omits the
 * field and ignores `create_session_request.harness`, which would start Claude.
 *
 * `cli.ts` builds the registry because each harness's validator lives behind
 * the import boundary (`harness-boundary.test.ts`): only `cli.ts` may import
 * `harness/codex/`. This file stays neutral.
 */

import { HARNESS_IDS } from '@remi/shared';
import type { HarnessId } from '@remi/shared';

export type RemoteArgsResult =
  | {
      readonly ok: true;
      readonly args: readonly string[];
      /**
       * The id a `resume` names, lowercased: a Codex thread (`resume <uuid>`) or a Claude session
       * (`--resume <uuid>`); null or absent when the request resumes none.
       */
      readonly resumeThreadId?: string | null;
    }
  | { readonly ok: false; readonly error: string };

/** A request's arguments after the allowlist passed them: what the launch check looks at. */
export interface CheckedRemoteArgs {
  readonly args: readonly string[];
  readonly resumeThreadId: string | null;
}

/**
 * Why a launch cannot happen right now (#1179 review, G8). `client` is what the requester is
 * told: what is refused and the next step, never a host path or a pid. `detail` is the whole
 * reason, for the host's own log.
 */
export interface LaunchRefusal {
  readonly client: string;
  readonly detail: string;
}

/** The session a successful create started, as far as the hub knows it: what a notice may name. */
export interface StartedSession {
  readonly sessionId: string;
  readonly port: number;
}

export interface HarnessSpec {
  /** The executable a session of this harness runs; availability is that it resolves on PATH. */
  readonly command: string;
  /**
   * The default-deny allowlist for a request's `args` (`create_session_request`).
   * Total: any input that is not an array of allowed strings is a refusal, never a throw.
   */
  readonly validateRemoteArgs: (args: unknown) => RemoteArgsResult;
  /**
   * Why a session of this harness cannot start right now (the older-daemon gate, a thread a live
   * session already holds), or null. It sees the arguments the allowlist passed.
   */
  readonly launchRefusal?: (checked: CheckedRemoteArgs) => LaunchRefusal | null;
  /**
   * What a successful create does not tell the client (#1179): this harness is started with no
   * terminal and may stop at a prompt only a terminal can answer, which the daemon cannot see. Built
   * from the session the spawn returned, so it can name `remi attach` exactly (G11), and sent as the
   * response's `notice`: the first line says the condition, any later line what to do about it. Absent
   * for a harness with no such prompt.
   */
  readonly headlessNotice?: (session: StartedSession) => string;
}

/**
 * The path of `command` on the PATH this process has NOW, or null. `Bun.which`
 * reads the PATH the process started with and ignores a later change to
 * `process.env.PATH` (checked on Bun 1.3.11 and 1.4.2), and every daemon
 * changes it at boot (`resolveShellPath`), so the PATH is passed explicitly.
 */
function whichOnCurrentPath(command: string): string | null {
  return Bun.which(command, { PATH: process.env['PATH'] ?? '' });
}

export class HarnessRegistry {
  constructor(private readonly specs: Readonly<Partial<Record<HarnessId, HarnessSpec>>>) {}

  /** The spec of a harness this build has an adapter for, or undefined. */
  get(id: HarnessId): HarnessSpec | undefined {
    return this.specs[id];
  }

  /** Every harness with an adapter whose command resolves, in the order `HARNESS_IDS` names them. */
  available(): HarnessId[] {
    return HARNESS_IDS.filter((id) => {
      const spec = this.specs[id];
      return spec !== undefined && whichOnCurrentPath(spec.command) !== null;
    });
  }
}
