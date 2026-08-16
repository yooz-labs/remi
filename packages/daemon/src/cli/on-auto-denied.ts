/**
 * The deny-visibility handler (#1015, extended by #1045 phase 6), lifted out of
 * `cli.ts` so its two load-bearing behaviors can be tested directly — they were
 * previously buried in a module-private closure with no coverage, and the
 * combined review (2026-08-16) proved that a one-line reorder could silently
 * defeat either without a test failing:
 *
 *   - the audit log fires UNCONDITIONALLY, for every `DenySource.kind`, BEFORE
 *     any push decision. This is the whole point of #1015: a deny — including a
 *     `residual` deny that `deny`-mode produced instead of a card (#1045) —
 *     must never vanish without a trace. Moving the log below the push guard is
 *     the exact regression this exists to end.
 *   - only a `model-floor` deny pushes. `config` is the user's own rule firing
 *     as designed; `residual` is `deny`-mode deliberately staying quiet (the
 *     user chose it to be pinged LESS). Both are still logged.
 *
 * Pure given its `AutoDeniedSink`: it computes the operation label and log
 * line, then either pushes or doesn't. `cli.ts` supplies the real sink (the
 * daemon logger + the per-device `sendPushTrigger` fan-out); tests supply spies.
 */

import { deniedBody, deniedOperation, deniedTitle } from '../auto-approve/deny-floor.ts';
import type { DenySource } from '../auto-approve/types.ts';
import type { PermissionRequestHookInput } from '../hooks/index.ts';

/** The side effects `handleAutoDenied` needs, injected so the decision logic
 *  is testable without the daemon's module state. */
export interface AutoDeniedSink {
  /** Append one audit line. Called for EVERY deny, unconditionally. */
  readonly log: (message: string) => void;
  /**
   * Push an informational, dismiss-only banner to every registered device.
   * Called ONLY when the source should notify (`model-floor`). A no-registered-
   * devices no-op is the implementation's own concern, not this function's.
   */
  readonly pushToDevices: (title: string, body: string) => void;
}

/**
 * Log a deny (always) and push it (only for `model-floor`). See the module doc
 * for why the ordering and the push gate are load-bearing.
 */
export function handleAutoDenied(
  sink: AutoDeniedSink,
  input: PermissionRequestHookInput,
  source: DenySource,
  reasoning: string,
): void {
  const op = deniedOperation(input.tool_name, input.tool_input, source.pattern);
  const title = deniedTitle(op);
  const body = deniedBody(op);
  // UNCONDITIONAL, and before the push gate: the audit trace is the guarantee.
  sink.log(`[AutoDenied ${source.kind}] ${title} - ${body} (${reasoning})`);

  // config = the user's own standing rule (no push needed); residual = deny-mode
  // being deliberately quiet (#1045). Only a model-floor deny — the one nobody
  // configured — earns an informational push.
  if (source.kind !== 'model-floor') return;
  sink.pushToDevices(title, body);
}
