/**
 * Runs the engine check inside workerd, the Cloudflare Workers runtime, in a local
 * process through the `miniflare` that the repository's lockfile already pins (it comes
 * with `wrangler` in packages/signaling). No deployed Worker is contacted.
 *
 *   bun install --frozen-lockfile
 *   bun scripts/relay-v2-engine-check/run-workerd.ts [--json]
 *
 * Exits 0 only if every `base` and `jwk` check passes.
 */

import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { type Report, describe, summarize } from './check.ts';

const wrangler = realpathSync(
  fileURLToPath(
    new URL('../../packages/signaling/node_modules/wrangler/package.json', import.meta.url),
  ),
);
const miniflarePath = createRequire(wrangler).resolve('miniflare');
interface MiniflareLike {
  dispatchFetch(url: string): Promise<Response>;
  dispose(): Promise<void>;
}
type MiniflareClass = new (options: {
  modules: boolean;
  script: string;
  compatibilityDate: string;
}) => MiniflareLike;
const { Miniflare } = (await import(pathToFileURL(miniflarePath).href)) as {
  Miniflare: MiniflareClass;
};

const bundle = await Bun.build({
  entrypoints: [fileURLToPath(new URL('./entry-worker.ts', import.meta.url))],
  target: 'browser',
  format: 'esm',
});
if (!bundle.success || bundle.outputs[0] === undefined) {
  console.error(bundle.logs.join('\n'));
  process.exit(2);
}

const mf = new Miniflare({
  modules: true,
  script: await bundle.outputs[0].text(),
  compatibilityDate: '2026-01-01',
});
let report: Report;
try {
  report = (await (await mf.dispatchFetch('http://localhost/')).json()) as Report;
} finally {
  await mf.dispose();
}
console.log(process.argv.includes('--json') ? JSON.stringify(report) : describe(report));
process.exit(summarize(report).pass ? 0 : 1);
