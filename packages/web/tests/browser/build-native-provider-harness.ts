/** Output belongs in private test state, never the shipping bundle or user profile. */
import { resolve } from 'node:path';
const output = process.argv[2];
if (!output) throw new Error('Pass an absolute private output path.');
const result = await Bun.build({
  entrypoints: [resolve(import.meta.dir, 'native-provider-harness.ts')],
  target: 'browser',
  minify: true,
});
const artifact = result.outputs[0];
if (!result.success || result.outputs.length !== 1 || !artifact)
  throw new Error('Native provider fixture build failed.');
await Bun.write(output, artifact);
