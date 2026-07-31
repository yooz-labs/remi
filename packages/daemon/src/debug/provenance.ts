/**
 * Provenance stamp for remi's opt-in debug sinks (#934).
 *
 * Every debug sink (`hooks/hook-server.ts`'s `REMI_HOOK_DEBUG` dump,
 * `session/question-trace.ts`'s `REMI_QUESTION_TRACE` dump, `pty/pty-capture.ts`'s
 * `REMI_PTY_CAPTURE` dump) is keyed on an environment variable that the test
 * suite runs under too. `HookServer.handleRequest` cannot tell a test's HTTP
 * POST from Claude Code's; `QuestionStore`/`SessionRegistry` cannot tell a test
 * calling `add()`/`remove()` directly from a real hook-driven mutation; a PTY
 * spawned by a test is byte-for-byte the same shape as a PTY spawned for a real
 * session. So a synthetic record and a real one were, before this,
 * indistinguishable except by an out-of-band convention (a `/tmp`-rooted `cwd`,
 * a hardcoded question id) -- which is exactly the kind of thing that fails
 * open the moment the convention drifts (#934).
 *
 * `bun test` sets `NODE_ENV=test` for the whole process (verified empirically;
 * also already relied on by `cli/cmd-model.ts`'s `ensureEngineViaHost` backstop
 * for the same class of problem -- refusing to start a real engine under the
 * test runner). Every debug sink here runs IN-PROCESS with whatever triggered
 * it: an HTTP POST handled inside the same bun process that received it, or a
 * direct function call from a test file. That makes `NODE_ENV` a signal already
 * available to every sink without adding a second bootstrap mechanism, and one
 * that survives `Bun.spawn` into a worker subprocess as long as the spawn env
 * is not stripped of it (see `question-trace.test.ts`'s worker pattern).
 *
 * IMPORTANT: this does NOT gate whether a sink writes at all -- each sink's own
 * env var (`REMI_HOOK_DEBUG=1`, etc.) still fully controls that, unconditionally.
 * Gating the WRITE itself on `NODE_ENV !== 'test'` was considered for #934 and
 * rejected: a developer running the daemon and the test suite in separate
 * shells that happen to share an ambient `NODE_ENV=test` (a project `.envrc`, a
 * shell-profile export, some container default) would then silently lose REAL
 * diagnostic capture with no signal anything was suppressed -- a wrong belief
 * that "capture is on" reading as evidence, exactly the failure class
 * `AGENTS.md`'s "Verify before you describe" exists to prevent. Stamping
 * instead of gating means a record is ALWAYS written when its sink is enabled;
 * the field, not a suppressed write, carries the truth, and a reader (or the
 * corpus builder) filters on it explicitly.
 */

export type DebugProvenance = 'live' | 'test';

/** `'test'` when running under `bun test` (or a worker it spawned without
 *  stripping `NODE_ENV`); `'live'` otherwise, including a compiled binary, a
 *  LaunchAgent/systemd-run daemon, or an interactive `bun run daemon`. Read
 *  lazily (not cached) so it reflects the calling process at write time. */
export function debugProvenance(): DebugProvenance {
  return process.env['NODE_ENV'] === 'test' ? 'test' : 'live';
}
