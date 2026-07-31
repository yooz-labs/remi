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
 * THE MECHANISM DOES NOT READ `NODE_ENV` (corrected after review): an earlier
 * version of this file did, on the claim that "`bun test` sets `NODE_ENV=test`
 * for the whole process." That claim is only true when `NODE_ENV` is UNSET
 * beforehand -- Bun applies it as a default, not an override. A developer
 * whose shell already exports `NODE_ENV=production` (or `development`, a
 * shared `.envrc`, a container default -- none of them exotic) running
 * `bun test packages/daemon/tests/hooks/` with `REMI_HOOK_DEBUG=1` got a
 * record stamped `_provenance: 'live'` for a genuinely synthetic write --
 * silently RECREATING #934 while the field made it look solved, which is
 * worse than not having the field (a reader trusts `'live'` outright; see
 * `build-hook-corpus.ts`'s `isSyntheticRecord`). CI never sets `NODE_ENV`, so
 * this never surfaced there -- only on a developer's machine, exactly where
 * the original contamination was found. No ambient environment variable is
 * an acceptable signal here, whichever one is read: it is settable by
 * anything outside this codebase's control, including by accident.
 *
 * THE ACTUAL MECHANISM: the test harness positively marks itself.
 * `tests/debug/test-harness-marker.ts`, loaded via `bunfig.toml`'s
 * `[test].preload` (two copies -- repo root and `packages/daemon`, since Bun
 * does not search parent directories for `bunfig.toml`), sets its own
 * `REMI_TEST_HARNESS` variable UNCONDITIONALLY the moment `bun test` starts,
 * before any test file's code runs. Unlike `NODE_ENV`, this is not a default
 * that backs off when something is already set -- it always runs when `bun
 * test` runs, so no pre-existing shell state can prevent it. It only runs
 * exclusively for `bun test`, never for `bun run <script>` or a direct `bun
 * <file>.ts` (verified). See that file's doc comment for the full history,
 * the verification commands, and why the marker survives `Bun.spawn` into a
 * worker subprocess with no extra plumbing.
 *
 * FAILURE DIRECTION (documented on purpose -- an undocumented failure mode in
 * a provenance mechanism is its own version of this bug): the one residual
 * risk is a developer's shell independently exporting a truthy
 * `REMI_TEST_HARNESS` for some unrelated reason while running the REAL
 * daemon. That real capture would then be wrongly marked `'test'` and
 * excluded from the corpus. This is the SAFE direction and the one this
 * mechanism is designed to fail toward: a lost real record is recoverable
 * (re-capture); an admitted fabricated record is not, because nothing
 * downstream can tell the difference once it reads `'live'`. Every ambiguous
 * case must resolve toward `'test'`, never toward `'live'` -- which is why
 * the check below is a plain truthiness test, not an exact `=== '1'` match:
 * if the marker were ever set to some OTHER truthy value (a bug in the
 * preload script, a stray shell export, anything), a strict-equality check
 * would read that as `'live'` -- the dangerous direction -- where a
 * truthiness check still correctly reads `'test'`.
 *
 * IMPORTANT: this does NOT gate whether a sink writes at all -- each sink's own
 * env var (`REMI_HOOK_DEBUG=1`, etc.) still fully controls that, unconditionally.
 * Gating the WRITE itself on the test marker was considered for #934 and
 * rejected: a developer running the daemon and the test suite in the same repo
 * checkout would then silently lose REAL diagnostic capture the moment the
 * marker mechanism itself had any bug, with no signal anything was suppressed
 * -- a wrong belief that "capture is on" reading as evidence, exactly the
 * failure class `AGENTS.md`'s "Verify before you describe" exists to prevent.
 * Stamping instead of gating means a record is ALWAYS written when its sink is
 * enabled; the field, not a suppressed write, carries the truth, and a reader
 * (or the corpus builder) filters on it explicitly.
 */

export type DebugProvenance = 'live' | 'test';

/** `'test'` when `REMI_TEST_HARNESS` is set to any truthy value by
 *  `tests/debug/test-harness-marker.ts` (loaded only under `bun test`, via
 *  `bunfig.toml`'s `[test].preload`); `'live'` only when it is unset or
 *  empty, including a compiled binary, a LaunchAgent/systemd-run daemon, or
 *  an interactive `bun run daemon`. Deliberately a truthiness check, not an
 *  exact-value match (see the module doc's FAILURE DIRECTION note): any
 *  ambiguous non-empty value must resolve toward `'test'`, never toward
 *  `'live'`. Read lazily (not cached) so it reflects the calling process at
 *  write time. */
export function debugProvenance(): DebugProvenance {
  return process.env['REMI_TEST_HARNESS'] ? 'test' : 'live';
}
