/**
 * `bunfig.toml`'s `[test].preload` loads this file before any test file
 * runs, and it does exactly one thing: mark the process as "running under
 * `bun test`" for `src/debug/provenance.ts` to read.
 *
 * WHY THIS EXISTS (found in review of #934, not by original design): the
 * first version of `debugProvenance()` read `process.env.NODE_ENV === 'test'`,
 * on the claim that `bun test` sets `NODE_ENV=test`. That claim is only true
 * when `NODE_ENV` is UNSET beforehand -- Bun applies it as a default, not an
 * override. Verified:
 *
 *   NODE_ENV=production bun test <file>   -> process.env.NODE_ENV === 'production'
 *   (unset)              bun test <file>   -> process.env.NODE_ENV === 'test'
 *
 * So a developer whose shell already exports NODE_ENV=production (or
 * development, a shared .envrc, a container default -- none of them exotic)
 * running `bun test packages/daemon/tests/hooks/` with REMI_HOOK_DEBUG=1
 * would get a debug-sink record stamped `_provenance: 'live'` for a
 * genuinely synthetic, test-originated write. That is not a weakened
 * mitigation, it is the ORIGINAL #934 bug, fully recreated, now disguised as
 * solved because a provenance field exists and says 'live'. CI never sets
 * NODE_ENV, so this never surfaced there -- only on a developer's machine,
 * exactly where the original contamination was found.
 *
 * THE FIX: stop inferring test-ness from an ambient variable ANY shell can
 * set (that is the wrong shape for this check, regardless of which variable
 * it reads) and have the test harness positively mark itself instead. This
 * file sets its own variable UNCONDITIONALLY -- not "if unset," always --
 * so no pre-existing shell state can prevent it from being '1' by the time
 * any test body runs. It only ever runs at all because `bunfig.toml` names
 * it as a `[test]` preload, which fires exclusively for `bun test`, never
 * for `bun run <script>` or a direct `bun <file>.ts` (verified: a plain
 * `bun` invocation of a script in a directory with this config sees the
 * marker as `undefined`).
 *
 * FAILURE DIRECTION, documented on purpose (an undocumented failure mode in
 * a provenance mechanism is its own version of this bug): the one residual
 * risk is a developer's shell independently exporting REMI_TEST_HARNESS=1
 * for some unrelated reason while running the REAL daemon -- that real
 * capture would then be wrongly marked 'test' and excluded from the corpus.
 * This is the SAFE direction: a lost real record is recoverable by
 * re-capturing; an admitted fabricated record is not, because nothing
 * downstream can tell the difference once it is marked 'live'. Every
 * ambiguous case must resolve toward 'test', never toward 'live'.
 *
 * TWO bunfig.toml files load this file: one at the repo root, one at
 * packages/daemon. Bun does not search parent directories for bunfig.toml
 * (verified: a bunfig.toml one level up from the invoking CWD is silently
 * not found), so `bun test` run from the repo root (the documented
 * convention, and this repo's CI) and `bun test` run from inside
 * packages/daemon (its own package.json `test` script) each need their own
 * config pointing at this file, or the second one would silently miss the
 * marker -- exactly the kind of gap this fix exists to close.
 *
 * Propagation to a `Bun.spawn`'d worker subprocess (several tests here spawn
 * a fresh process to get a clean `os.homedir()`, e.g. `question-trace.test.ts`)
 * needs no separate handling: this line runs once, in the parent `bun test`
 * process, before any test file executes, so `process.env['REMI_TEST_HARNESS']`
 * is already '1' in that process's own env by the time a test spreads
 * `...process.env` into a spawned child's env -- the same passthrough every
 * such test already relies on. Verified empirically under an adversarial
 * ambient `NODE_ENV=production`: the child subprocess still sees
 * REMI_TEST_HARNESS=1.
 */
process.env['REMI_TEST_HARNESS'] = '1';
