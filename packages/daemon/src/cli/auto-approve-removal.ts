/**
 * User-facing notices for the auto-approve removal (#1125, ADR 0030).
 *
 * remi used to judge permissions itself, with a local model (served by the
 * Yooz engine or `llama-server`) and a rule layer configured under
 * `[auto_approve]`. Both were deleted; the harness's own permission settings
 * decide now and remi only relays what is still asked. These strings are
 * what a user with an old config, an old script or an old habit sees.
 */

/** Printed (to stderr) by `remi model`, which then exits 2. One line. */
export const MODEL_COMMAND_REMOVED_MESSAGE =
  'remi model was removed: remi no longer runs a local model to judge permissions; Claude Code decides them now.';
