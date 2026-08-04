/**
 * Golden fixture tests for the protocol registry (#895).
 *
 * One checked-in JSON fixture per {@link ProtocolMessageMap} key, each
 * produced by that type's own `create*` factory (see
 * `fixtures/protocol/builders.ts`, `fixtures/protocol/generate.ts`). For
 * every registry type this asserts:
 *  1. a fixture file exists,
 *  2. it round-trips through `serialize`/`deserialize` without loss, and
 *  3. regenerating it right now from the same factory + inputs produces the
 *     same shape (id/timestamp aside) as the checked-in copy — so an
 *     accidental field rename/add/remove on a message interface or its
 *     factory shows up as a failing test, not a silent wire-shape drift.
 *
 * A 46th fixture (`__unknown_type__.json`, deliberately NOT a registry key)
 * pins the forward-compat contract: `deserialize` returns `null` for a type
 * it doesn't recognize instead of throwing.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MESSAGE_DIRECTION, deserialize, serialize } from '../src/protocol.ts';
import type { ProtocolMessageMap } from '../src/protocol.ts';
import { FIXTURE_BUILDERS, normalizeForComparison } from './fixtures/protocol/builders.ts';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'protocol');

function loadFixtureRaw(name: string): string {
  return readFileSync(join(FIXTURES_DIR, `${name}.json`), 'utf-8');
}

const registryTypes = Object.keys(MESSAGE_DIRECTION) as (keyof ProtocolMessageMap)[];

describe('protocol fixtures (#895)', () => {
  test('every registry key has exactly one fixture builder', () => {
    expect(Object.keys(FIXTURE_BUILDERS).sort()).toEqual([...registryTypes].sort());
  });

  describe.each(registryTypes)('%s', (type) => {
    test('fixture file exists', () => {
      expect(() => loadFixtureRaw(type)).not.toThrow();
    });

    test('fixture round-trips through serialize/deserialize', () => {
      const raw = loadFixtureRaw(type);
      const parsedOriginal = JSON.parse(raw) as Record<string, unknown>;

      const deserialized = deserialize(raw);
      expect(deserialized).not.toBeNull();
      expect(deserialized?.type).toBe(type);

      // biome-ignore lint/style/noNonNullAssertion: asserted not-null above
      const reserialized = JSON.parse(serialize(deserialized!));
      expect(reserialized).toEqual(parsedOriginal);
    });

    test('regenerated fixture matches the checked-in copy', () => {
      const raw = loadFixtureRaw(type);
      const checkedIn = normalizeForComparison(type, JSON.parse(raw));

      const builder = FIXTURE_BUILDERS[type];
      const regenerated = normalizeForComparison(
        type,
        JSON.parse(JSON.stringify(builder())) as Record<string, unknown>,
      );

      expect(regenerated).toEqual(checkedIn);
    });
  });

  test('bogus-type fixture is rejected by deserialize (forward-compat contract)', () => {
    const raw = loadFixtureRaw('__unknown_type__');
    const parsed = JSON.parse(raw) as { type: string };

    // Sanity: the fixture really is bogus, not an accidental real type.
    expect(registryTypes).not.toContain(parsed.type);

    expect(deserialize(raw)).toBeNull();
  });
});
