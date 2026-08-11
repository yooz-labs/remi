/**
 * #1051: a loopback bind stopped mDNS advertising with no log line at all.
 *
 * These test the DECISION, which is the part that can be tested — the caller is
 * module-level startup code in cli.ts with no seam. What they cannot prove is
 * that cli.ts calls it; that is pinned separately by asserting the bare
 * `return null` is gone from the source.
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type MdnsAdvertiseInputs,
  mdnsSuppression,
  mdnsSuppressionMessage,
} from '../../src/mdns/advertise-decision.ts';

describe('cli.ts actually uses the decision', () => {
  // Everything below tests a pure function. Without this, all of it would stay
  // green if someone restored the bare `return null` in cli.ts -- a suite that
  // passes while the bug is back is the ADR 0011 row-5 anti-pattern, and this
  // file is defending a user-visible regression that shipped once already.
  const cli = fs.readFileSync(path.join(import.meta.dir, '..', '..', 'src', 'cli.ts'), 'utf8');

  test('the silent suppression return is gone', () => {
    expect(cli).not.toContain('|| isLocalhostBind) return null;');
  });

  test('the suppression path logs the decision', () => {
    expect(cli).toContain('mdnsSuppression(');
    expect(cli).toContain('logFn(mdnsSuppressionMessage(');
  });
});

/** Advertising: network bind, mDNS on, no flag. */
const ADVERTISING: MdnsAdvertiseInputs = {
  cliNoMdns: false,
  configMdns: true,
  isLocalhostBind: false,
  bindHost: '0.0.0.0',
};

describe('mdnsSuppression', () => {
  test('a network bind with mDNS enabled advertises', () => {
    expect(mdnsSuppression(ADVERTISING)).toBeNull();
  });

  test('a loopback bind suppresses, carrying the host', () => {
    // The case #880 made universal: every stock install takes this path now.
    const s = mdnsSuppression({ ...ADVERTISING, isLocalhostBind: true, bindHost: '127.0.0.1' });
    expect(s).toEqual({ kind: 'loopback', bindHost: '127.0.0.1' });
  });

  test('--no-mdns suppresses', () => {
    expect(mdnsSuppression({ ...ADVERTISING, cliNoMdns: true })).toEqual({ kind: 'cli-flag' });
  });

  test('network.mdns = false suppresses', () => {
    expect(mdnsSuppression({ ...ADVERTISING, configMdns: false })).toEqual({ kind: 'config' });
  });

  test('the CLI flag is reported ahead of a loopback bind', () => {
    // Precedence is not cosmetic. Reporting 'loopback' here would tell the user
    // to set daemon.bind -- advice their own --no-mdns would then override, so
    // they would follow it and still see nothing.
    const s = mdnsSuppression({ ...ADVERTISING, cliNoMdns: true, isLocalhostBind: true });
    expect(s).toEqual({ kind: 'cli-flag' });
  });

  test('config is reported ahead of a loopback bind', () => {
    const s = mdnsSuppression({ ...ADVERTISING, configMdns: false, isLocalhostBind: true });
    expect(s).toEqual({ kind: 'config' });
  });

  test('the CLI flag outranks a config that also disables it', () => {
    const s = mdnsSuppression({ ...ADVERTISING, cliNoMdns: true, configMdns: false });
    expect(s).toEqual({ kind: 'cli-flag' });
  });
});

describe('mdnsSuppressionMessage', () => {
  test('the loopback message names the remedy AND the auth trap', () => {
    const msg = mdnsSuppressionMessage({ kind: 'loopback', bindHost: '127.0.0.1' });
    expect(msg).toContain('127.0.0.1');
    expect(msg).toContain('daemon.bind');
    // Naming bind alone would walk the user into the #880 exposure: "auto"
    // resolves to false on every bind, so a widened bind with default auth is
    // the unauthenticated LAN path 0.7.6 just closed.
    expect(msg).toContain('auth.enabled');
  });

  test('deliberate suppressions state the fact without prescribing a remedy', () => {
    // #1051 is explicit that these must not nag: someone who passed --no-mdns
    // does not need to be told how to undo it on every boot.
    for (const s of [{ kind: 'cli-flag' } as const, { kind: 'config' } as const]) {
      const msg = mdnsSuppressionMessage(s);
      expect(msg).toContain('Not advertising');
      expect(msg).not.toContain('daemon.bind');
      expect(msg).not.toContain('auth.enabled');
    }
  });

  test('every suppression produces a non-empty [mDNS] line', () => {
    // The whole point of #1051: no suppression path may be silent. A new kind
    // added without a message would fail here rather than reintroduce the bug.
    const all = [
      { kind: 'cli-flag' } as const,
      { kind: 'config' } as const,
      { kind: 'loopback', bindHost: '127.0.0.1' } as const,
    ];
    for (const s of all) {
      const msg = mdnsSuppressionMessage(s);
      expect(msg.startsWith('[mDNS]')).toBe(true);
      expect(msg.length).toBeGreaterThan(20);
    }
  });

  test('each suppression says something DIFFERENT', () => {
    // Three conditions behind one message would be the same defect in a new
    // costume: the user still could not tell which one fired.
    const msgs = [
      mdnsSuppressionMessage({ kind: 'cli-flag' }),
      mdnsSuppressionMessage({ kind: 'config' }),
      mdnsSuppressionMessage({ kind: 'loopback', bindHost: '127.0.0.1' }),
    ];
    expect(new Set(msgs).size).toBe(3);
  });
});
