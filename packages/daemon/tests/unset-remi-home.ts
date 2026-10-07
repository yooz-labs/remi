/**
 * `bunfig.toml`'s `[test].preload` loads this file before any test file runs
 * (#1155). It removes `REMI_HOME` from the test process's environment and does
 * nothing else.
 *
 * The README recommends exporting `REMI_HOME` (a scratch state directory) to
 * run remi from source. A developer who does that and then runs `bun test`
 * in the same shell used to see tests fail: tests that expect the default
 * `~/.remi` layout under a throwaway `HOME` (trace files, PID files, a
 * spawned worker's state) read the exported directory instead. Tests that
 * exercise `REMI_HOME` itself set it explicitly in the env they pass, so
 * removing the ambient value changes nothing for them.
 *
 * It runs in the parent `bun test` process before any module computes a
 * state path, so a worker a test spawns with `...process.env` does not
 * inherit it either. Loaded by both `bunfig.toml` files (repo root and
 * `packages/daemon`), for the reason `tests/debug/test-harness-marker.ts`
 * gives.
 */
Reflect.deleteProperty(process.env, 'REMI_HOME');
