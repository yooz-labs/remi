/**
 * Who asks for the relay (#1193). The default is off, so the decision at the
 * one registration site in `cli.ts` is: the config says so, or the user passed
 * `--permanent-code` (which only makes sense with a relay), and `--no-relay`
 * beats both.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../../src/cli/arg-parser.ts';
import { DEFAULT_CONFIG, relayRequested } from '../../src/config/config.ts';

describe('relayRequested', () => {
  test('a stock install does not start the relay', () => {
    expect(relayRequested(DEFAULT_CONFIG.network.relay, parseArgs([]))).toBe(false);
  });

  test('network.relay = true in config starts it', () => {
    expect(relayRequested(true, parseArgs([]))).toBe(true);
  });

  test('--permanent-code starts it without a config entry', () => {
    expect(relayRequested(false, parseArgs(['--auth', '--permanent-code']))).toBe(true);
  });

  test('--no-relay wins over the config and over --permanent-code', () => {
    expect(relayRequested(true, parseArgs(['--no-relay']))).toBe(false);
    expect(relayRequested(false, parseArgs(['--no-relay', '--permanent-code']))).toBe(false);
  });
});

describe('cli.ts registration site (source-level wiring pin)', () => {
  // cli.ts is a script with top-level side effects, so it cannot be imported
  // here; reading its source is the only cheap way to pin that the decision goes
  // through relayRequested and nothing reads the raw config value beside it.
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../src/cli.ts'),
    'utf-8',
  );

  test('registers the relay through relayRequested, passing both command-line flags', () => {
    // The whole argument object, not only the call: dropping `noRelay` (or
    // hard-coding it false) leaves every integration test that passes
    // `--no-relay` green, since the default is off, and ignores the flag.
    expect(source).toMatch(
      /relayRequested\(\s*remiConfig\.network\.relay,\s*\{\s*noRelay: cliNoRelay,\s*permanentCode: cliPermanentCode,?\s*\}\s*\)/,
    );
  });

  test('reads network.relay nowhere else', () => {
    expect(source.match(/remiConfig\.network\.relay/g)).toHaveLength(1);
  });
});
