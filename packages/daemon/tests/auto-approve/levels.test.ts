/**
 * #963: auto-approve strictness levels.
 *
 * The load-bearing assertion is the FIRST one: `strict` must reproduce today's
 * shipped behavior exactly. A level system whose safest setting quietly
 * differs from what users already run is worse than no level system.
 */

import { describe, expect, test } from 'bun:test';
import {
  AUTO_APPROVE_LEVELS,
  DEFAULT_AUTO_APPROVE_LEVEL,
  groupsForLevel,
  isAutoApproveLevel,
  resolveApproveGroups,
} from '../../src/auto-approve/levels.ts';
import { knownGroupNames } from '../../src/auto-approve/permission-groups.ts';
import { DEFAULT_CONFIG } from '../../src/config/config.ts';

describe('strict reproduces today', () => {
  test("strict's groups equal the shipped approve_groups default", () => {
    // Compared against `DEFAULT_CONFIG` itself, not a copy of its literal, so
    // the two cannot drift apart silently.
    expect([...groupsForLevel('strict')].sort()).toEqual(
      [...DEFAULT_CONFIG.auto_approve.approve_groups].sort(),
    );
  });

  test('strict is the shipped default level', () => {
    // Phase 2 needed four review rounds to close eleven bypasses in the write
    // groups. Defaulting to `trusted` in the same change that introduces the
    // switch would bundle "does the mechanism work" with "is the policy
    // right"; flipping it is its own PR.
    expect(DEFAULT_AUTO_APPROVE_LEVEL).toBe('strict');
    expect(DEFAULT_CONFIG.auto_approve.level).toBe('strict');
  });
});

describe('the levels are ordered and additive', () => {
  test('each level is a superset of the one below', () => {
    // Makes "raise the level" mean unambiguously "approve more". Without this
    // a level could silently REMOVE a group someone relied on.
    const strict = new Set(groupsForLevel('strict'));
    const balanced = new Set(groupsForLevel('balanced'));
    const trusted = new Set(groupsForLevel('trusted'));
    for (const g of strict) expect(balanced.has(g)).toBe(true);
    for (const g of balanced) expect(trusted.has(g)).toBe(true);
  });

  test('each step adds exactly the documented group', () => {
    const added = (a: readonly string[], b: readonly string[]) => b.filter((g) => !a.includes(g));
    expect(added(groupsForLevel('strict'), groupsForLevel('balanced'))).toEqual(['fs-write']);
    expect(added(groupsForLevel('balanced'), groupsForLevel('trusted'))).toEqual(['vcs-write']);
  });

  test('every group named by a level actually exists', () => {
    // A typo here would silently approve nothing -- `matchGroups` ignores
    // unknown names -- so the level would appear to work and do nothing.
    const known = knownGroupNames();
    for (const level of AUTO_APPROVE_LEVELS) {
      for (const group of groupsForLevel(level)) {
        expect(known).toContain(group);
      }
    }
  });
});

describe('what no level may contain', () => {
  test('net-read is in no level', () => {
    // Cut in #961 after five of eleven bypasses turned out to be curl's.
    for (const level of AUTO_APPROVE_LEVELS) {
      expect(groupsForLevel(level)).not.toContain('net-read');
    }
  });

  test('no level names a group that does not ship', () => {
    // The mirror of the test above: catches a level referencing a group that
    // was removed, which would otherwise be a silent no-op.
    const known = new Set(knownGroupNames());
    for (const level of AUTO_APPROVE_LEVELS) {
      for (const group of groupsForLevel(level)) {
        expect(known.has(group)).toBe(true);
      }
    }
  });
});

describe('isAutoApproveLevel', () => {
  test('accepts exactly the three levels', () => {
    for (const level of AUTO_APPROVE_LEVELS) expect(isAutoApproveLevel(level)).toBe(true);
  });

  test('rejects everything else', () => {
    for (const bad of ['', 'STRICT', 'loose', 'trusted ', null, undefined, 3, {}, ['trusted']]) {
      expect(isAutoApproveLevel(bad)).toBe(false);
    }
  });
});

describe('resolveApproveGroups', () => {
  test('an absent approve_groups takes the preset', () => {
    const r = resolveApproveGroups('balanced', undefined);
    expect(r.source).toBe('level');
    expect(r.groups).toEqual(groupsForLevel('balanced'));
  });

  test('an explicit approve_groups overrides the preset entirely', () => {
    // Override, not union: a union can only widen, so a user who NARROWED
    // their list would have it silently widened back by a level they set.
    const r = resolveApproveGroups('trusted', ['read-only']);
    expect(r.source).toBe('explicit');
    expect(r.groups).toEqual(['read-only']);
  });

  test('an explicit EMPTY list is respected, not treated as absent', () => {
    // The distinction the whole design rests on: `[]` is a choice ("approve
    // no groups"), `undefined` is "I did not choose". Collapsing them would
    // silently re-enable groups for a user who deliberately turned them off.
    const r = resolveApproveGroups('trusted', []);
    expect(r.source).toBe('explicit');
    expect(r.groups).toEqual([]);
  });

  test('the level is reported either way, for logging and config dump', () => {
    expect(resolveApproveGroups('trusted', ['read-only']).level).toBe('trusted');
    expect(resolveApproveGroups('trusted', undefined).level).toBe('trusted');
  });
});
