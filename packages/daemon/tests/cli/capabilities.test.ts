/**
 * The capabilities a daemon lists on `hello_ack` (#1237, ADR 0035) are each
 * documented in the shared registry, so a client can say what a missing one does
 * and no name ships that nothing explains.
 */

import { describe, expect, test } from 'bun:test';
import { PROTOCOL_CAPABILITIES } from '@remi/shared';
import { DAEMON_CAPABILITIES } from '../../src/cli/capabilities.ts';

describe('the daemon advertises only documented capabilities (#1237)', () => {
  test('every capability the daemon lists is in the registry', () => {
    for (const name of DAEMON_CAPABILITIES) {
      expect(Object.hasOwn(PROTOCOL_CAPABILITIES, name), name).toBe(true);
    }
  });

  test('none is listed twice', () => {
    expect(new Set(DAEMON_CAPABILITIES).size).toBe(DAEMON_CAPABILITIES.length);
  });
});
