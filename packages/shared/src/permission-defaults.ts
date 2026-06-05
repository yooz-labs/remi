/**
 * Hardcoded fallback values shared by the daemon's HookEventBridge and the
 * web client's question-merge guard (#396).
 *
 * Both layers need to know what the daemon emits when a `PermissionRequest`
 * arrives without `permission_suggestions`: the daemon uses these as the
 * default option labels; the client uses them to detect "this incoming
 * question is the bland fallback, not a richer custom 3-set worth keeping
 * over a freshly rendered multi-choice." Keeping the values in one place
 * prevents the two layers from drifting out of sync.
 */

/**
 * Default option labels for permission prompts when Claude Code does not
 * provide `permission_suggestions`. Order matters: daemon assigns numeric
 * values 1-3 to the entries in this order.
 */
export const DEFAULT_PERMISSION_LABELS = ['Yes', 'Yes, always', 'No'] as const;

/**
 * Window during which the daemon's `QuestionDedup` and the client's
 * `shouldKeepExisting` agree that two emissions belong to the same prompt
 * cycle. Tuned for the observed hook-vs-PTY race; long enough to absorb
 * realistic terminal-redraw cascades, short enough that a stale rich
 * question does not pin the UI when the user takes a coffee break.
 */
export const QUESTION_DEDUP_WINDOW_MS = 5000;
