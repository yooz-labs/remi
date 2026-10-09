// Browser and WebView entry: exposes `globalThis.__run()`, which resolves to the report as JSON text.
import vectors from '../../packages/shared/tests/fixtures/relay-v2/vectors.json';
import { run } from './check.ts';

(globalThis as { __run?: () => Promise<string> }).__run = async () =>
  JSON.stringify(await run(vectors));
