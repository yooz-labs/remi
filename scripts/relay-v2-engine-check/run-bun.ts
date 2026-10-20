/**
 * Runs the engine check under Bun (the engine the daemon and the test suite use).
 *
 *   bun scripts/relay-v2-engine-check/run-bun.ts [--json]
 *
 * Exits 0 only if every `base` and `jwk` check passes.
 */

import vectors from '../../packages/shared/tests/fixtures/relay-v2/vectors.json';
import { describe, run, summarize } from './check.ts';

const report = await run(vectors);
console.log(process.argv.includes('--json') ? JSON.stringify(report) : describe(report));
process.exit(summarize(report).pass ? 0 : 1);
