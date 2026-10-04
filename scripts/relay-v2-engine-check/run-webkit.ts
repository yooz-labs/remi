/**
 * Runs the engine check in a WKWebView of this Mac's system WebKit (macOS only; needs
 * `swift`). It builds the page bundle into a temporary directory that it removes again.
 *
 *   bun scripts/relay-v2-engine-check/run-webkit.ts [--json]
 *
 * This is macOS's WebKit, not an iPhone's WKWebView: the owner runs the same bundle on a
 * device (see README.md). Exits 0 only if every `base` and `jwk` check passes.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Report, describe, summarize } from './check.ts';

if (process.platform !== 'darwin') {
  console.error(
    'run-webkit.ts needs macOS and swift; on another platform load the bundle in a WebView yourself (README.md).',
  );
  process.exit(2);
}

const bundle = await Bun.build({
  entrypoints: [fileURLToPath(new URL('./entry-page.ts', import.meta.url))],
  target: 'browser',
  format: 'iife',
});
if (!bundle.success || bundle.outputs[0] === undefined) {
  console.error(bundle.logs.join('\n'));
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), 'relay-v2-engine-check-'));
let stdout: string;
try {
  const page = join(dir, 'page.js');
  writeFileSync(page, await bundle.outputs[0].text());
  const host = fileURLToPath(new URL('./webkit-host.swift', import.meta.url));
  const child = Bun.spawn(['swift', host, page], { stdout: 'pipe', stderr: 'inherit' });
  stdout = await new Response(child.stdout).text();
  await child.exited;
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const line = stdout.trim().split('\n').at(-1) ?? '';
const parsed = JSON.parse(line) as {
  meta?: { os: string; webkit: string };
  page?: { secure: boolean; report: Report };
  error?: string;
};
if (parsed.error !== undefined || parsed.page === undefined) {
  console.error(`the WKWebView run failed: ${parsed.error ?? 'no report'}`);
  process.exit(2);
}
if (!parsed.page.secure) {
  console.error('the page was not a secure context');
  process.exit(2);
}
const report = parsed.page.report;
console.log(
  process.argv.includes('--json')
    ? JSON.stringify(report)
    : `${describe(report)}\nWebKit ${parsed.meta?.webkit} on macOS ${parsed.meta?.os}`,
);
process.exit(summarize(report).pass ? 0 : 1);
