/** Deterministic public synthetic fixture; never reads runtime identity or configuration. */
import { buildPushVectors } from '../packages/shared/tests/relay/push-vectors-builder.ts';
const path = new URL(
  '../packages/shared/tests/fixtures/relay-v2/push-vectors.json',
  import.meta.url,
);
await Bun.write(path, `${JSON.stringify(await buildPushVectors(), null, 2)}\n`);
