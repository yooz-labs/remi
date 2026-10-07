/**
 * Every hello_ack the daemon sends lists its capabilities (#1237, ADR 0035; review of #1269).
 *
 * `createHelloAck` stamps the protocol version itself, but the capabilities come from its caller,
 * and an ack built without them lists none: `hubSupport` would then tell a person whose remi is
 * current to update it. The three production paths pass them today, and an injected list proves each
 * one; this reads the daemon's source so a NEW caller that omits them fails here. A use is clean
 * only when it is a direct call whose third argument is an object literal naming `capabilities`.
 * The bare `Connection`'s ack (`server/connection.ts`) is the one allowlisted file: production
 * never sends it (the WebSocket adapter sets `skipHelloAck`), and it serves library consumers.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { callArguments } from './helpers/call-arguments.ts';
import { stripComments } from './helpers/strip-comments.ts';

const SRC = resolve(import.meta.dir, '..', 'src');
const LIBRARY_ACK = ['server/connection.ts'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

/** What is wrong with the uses of `createHelloAck` in `source`, one line each. */
function offences(source: string): string[] {
  const out: string[] = [];
  const importSpans = [
    ...source.matchAll(/import\s+(?:type\s+)?\{[^}]*\}\s*from\s*['"][^'"]+['"]/g),
  ].map((m) => [m.index as number, (m.index as number) + m[0].length] as const);
  for (const match of source.matchAll(/\bcreateHelloAck\b/g)) {
    const at = match.index as number;
    const end = at + 'createHelloAck'.length;
    const rest = source.slice(end);
    if (importSpans.some(([from, to]) => at >= from && at < to)) {
      if (/^\s+as\s/.test(rest)) out.push('an aliased import of createHelloAck');
      continue;
    }
    if (!rest.trimStart().startsWith('(')) {
      out.push('a use of createHelloAck that is not a direct call');
      continue;
    }
    const { args } = callArguments(source, end + rest.indexOf('('));
    const options = args[2];
    if (options === undefined) out.push('a call with no options');
    else if (!options.startsWith('{') || !/(^|[{,\s])capabilities\b/.test(options)) {
      out.push('a call whose options do not name capabilities');
    }
  }
  return out;
}

describe('every hello_ack the daemon sends lists its capabilities (#1237)', () => {
  const scanned = sourceFiles(SRC).map((file) => ({
    name: relative(SRC, file),
    source: stripComments(readFileSync(file, 'utf8')),
  }));

  test('the callers are the ones this guard was written for (the scan is not vacuous)', () => {
    expect(scanned.length).toBeGreaterThan(150);
    const callers = scanned
      .filter(({ source }) => /\bcreateHelloAck\s*\(/.test(source))
      .map(({ name }) => name)
      .sort();
    expect(callers).toEqual([
      'cli/handlers/connection-events.ts',
      'cli/handlers/resume-session-events.ts',
      'server/connection.ts',
    ]);
  });

  test('every production call names capabilities', () => {
    const bad = scanned
      .filter(({ name }) => !LIBRARY_ACK.includes(name))
      .flatMap(({ name, source }) => offences(source).map((o) => `${name}: ${o}`));
    expect(bad).toEqual([]);
  });

  test('the scan refuses a call without them (control)', () => {
    expect(offences("createHelloAck('1.0.0', id);")).toEqual(['a call with no options']);
    expect(offences("createHelloAck('1.0.0', id, { harnesses: harnesses() });")).toEqual([
      'a call whose options do not name capabilities',
    ]);
    expect(offences("createHelloAck('1.0.0', id, opts);")).toEqual([
      'a call whose options do not name capabilities',
    ]);
    expect(offences("createHelloAck('1.0.0', id, { capabilities, harnesses: h() });")).toEqual([]);
  });
});
