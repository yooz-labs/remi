// Cloudflare Workers entry: any request returns the report as JSON.
import vectors from '../../packages/shared/tests/fixtures/relay-v2/vectors.json';
import { run } from './check.ts';

export default {
  async fetch(): Promise<Response> {
    return new Response(JSON.stringify(await run(vectors)), {
      headers: { 'content-type': 'application/json' },
    });
  },
};
