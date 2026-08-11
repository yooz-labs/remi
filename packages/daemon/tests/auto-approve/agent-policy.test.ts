/**
 * ADR 0025: per-agent-type permission scoping.
 *
 * The merge asymmetry here IS the security contract — deny unions, allow
 * replaces — so the tests that matter are the ones that fail when the
 * asymmetry is flattened in either direction. ADR 0025 carries an explicit
 * verification obligation for exactly that, because a document asserting "a
 * section cannot weaken a deny" is the ADR 0011 failure mode unless a test
 * fails when it stops being true.
 */

import { describe, expect, test } from 'bun:test';
import {
  type ResolvedPolicy,
  resolvePolicy,
  validateAgents,
} from '../../src/auto-approve/agent-policy.ts';
import { AutoApproveService } from '../../src/auto-approve/auto-approve-service.ts';
import { AUTO_APPROVE_LEVELS, groupsForLevel } from '../../src/auto-approve/levels.ts';
import { knownGroupNames } from '../../src/auto-approve/permission-groups.ts';
import { DEFAULT_CONFIG } from '../../src/config/config.ts';

const BASE: ResolvedPolicy = {
  allow: ['uv run'],
  deny: ['rm -rf /'],
  approveGroups: ['read-only', 'vcs-read'],
  denyGroups: ['fs-write'],
};

describe('resolvePolicy falls through to the base', () => {
  test('main context (no agent type)', () => {
    expect(resolvePolicy(BASE, {}, undefined)).toEqual(BASE);
  });

  test('an empty-string agent type', () => {
    expect(resolvePolicy(BASE, { Explore: { allow: ['x'] } }, '')).toEqual(BASE);
  });

  test('an agent type with no section', () => {
    expect(resolvePolicy(BASE, { Explore: { allow: ['x'] } }, 'general-purpose')).toEqual(BASE);
  });

  test('a MISSPELLED section silently does nothing', () => {
    // ADR 0025 records this as an accepted consequence: there is no registry of
    // agent types to validate a name against. Pinned so the behaviour is a
    // known one rather than a surprise discovered in the field.
    const resolved = resolvePolicy(BASE, { Explor: { approve_groups: ['net-read'] } }, 'Explore');
    expect(resolved.approveGroups).toEqual(['read-only', 'vcs-read']);
  });
});

describe('deny UNIONS — a section can never weaken a prohibition', () => {
  test('the base deny survives a section that omits it', () => {
    // THE obligation from ADR 0025. If `deny` were treated like `allow`
    // (replace-when-present), a section setting only approve_groups would be
    // fine, but one setting its own `deny` would silently drop `rm -rf /`.
    const resolved = resolvePolicy(BASE, { Explore: { deny: ['curl'] } }, 'Explore');
    expect(resolved.deny).toContain('rm -rf /');
    expect(resolved.deny).toContain('curl');
  });

  test('the base deny survives a section with an EMPTY deny', () => {
    // The adversarial shape: an explicit `deny = []` is the most direct way to
    // try to clear a machine-wide prohibition for one agent.
    const resolved = resolvePolicy(BASE, { Explore: { deny: [] } }, 'Explore');
    expect(resolved.deny).toEqual(['rm -rf /']);
  });

  test('deny_groups unions the same way', () => {
    const resolved = resolvePolicy(BASE, { Explore: { deny_groups: ['net-read'] } }, 'Explore');
    expect(resolved.denyGroups).toEqual(['fs-write', 'net-read']);
  });

  test('a duplicate deny is not repeated', () => {
    const resolved = resolvePolicy(BASE, { Explore: { deny: ['rm -rf /'] } }, 'Explore');
    expect(resolved.deny).toEqual(['rm -rf /']);
  });

  test('base deny order is preserved, so a reported pattern does not shuffle', () => {
    const base = { ...BASE, deny: ['a', 'b', 'c'] };
    const resolved = resolvePolicy(base, { Explore: { deny: ['d'] } }, 'Explore');
    expect(resolved.deny).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('allow / approve_groups REPLACE — per-role scoping must be able to narrow', () => {
  test('approve_groups replaces rather than merging', () => {
    // The motivating case: give this role LESS. If it merged additively, a
    // section could only ever widen and this would be inexpressible.
    const resolved = resolvePolicy(
      BASE,
      { 'pr-review': { approve_groups: ['read-only'] } },
      'pr-review',
    );
    expect(resolved.approveGroups).toEqual(['read-only']);
    expect(resolved.approveGroups).not.toContain('vcs-read');
  });

  test('an EMPTY approve_groups means none, not "inherit the base"', () => {
    // Treating empty as absent would turn an explicit narrowing into a
    // widening — the one direction this must never fail.
    const resolved = resolvePolicy(BASE, { locked: { approve_groups: [] } }, 'locked');
    expect(resolved.approveGroups).toEqual([]);
  });

  test('an EMPTY allow means none, not "inherit the base"', () => {
    const resolved = resolvePolicy(BASE, { locked: { allow: [] } }, 'locked');
    expect(resolved.allow).toEqual([]);
  });

  test('a section may also widen, which is the user saying so explicitly', () => {
    const resolved = resolvePolicy(
      BASE,
      { Explore: { approve_groups: ['read-only', 'vcs-read', 'net-read'] } },
      'Explore',
    );
    expect(resolved.approveGroups).toContain('net-read');
  });

  test('keys not set by the section inherit the base', () => {
    // The common case is one line: "this role also gets net-read".
    const resolved = resolvePolicy(BASE, { Explore: { approve_groups: ['net-read'] } }, 'Explore');
    expect(resolved.allow).toEqual(['uv run']);
    expect(resolved.deny).toEqual(['rm -rf /']);
    expect(resolved.denyGroups).toEqual(['fs-write']);
  });

  test('the base object is never mutated', () => {
    const snapshot = structuredClone(BASE);
    resolvePolicy(BASE, { Explore: { deny: ['x'], approve_groups: ['y'] } }, 'Explore');
    expect(BASE).toEqual(snapshot);
  });
});

describe('the real AutoApproveService applies the agent section', () => {
  // Everything above is a pure function. Without this block, all of it would
  // stay green if the service never passed `agentType` through -- the feature
  // would be inert and the suite would not notice. No LLM is involved: these
  // are deterministic-layer decisions, which is exactly the layer a subagent
  // reaches at hook time (ADR 0004).
  function service(agents: Record<string, unknown>) {
    return new AutoApproveService(
      {
        enabled: true,
        provider: 'yooz',
        model: 'm',
        api_key: '',
        base_url: 'http://127.0.0.1:19924',
        timeout: 30,
        log_decisions: false,
        allow: [],
        deny: [],
        subagent_alert: [],
        approve_groups: ['read-only'],
        level: 'strict',
        deny_groups: [],
        instructions: '',
        multichoice: 'skip',
        multichoice_model: '',
        escalate_model: '',
        escalate_timeout: 0,
        queue_timeout: 240,
        cache_idle: 0,
        keep_alive: 0,
        engine: 'owned' as const,
        engine_path: '',
        model_cache: '',
        disable_thinking: false,
        always_escalate_tools: [],
        session_precedent: true,
        hold_timeout: 0,
        push_hold_timeout: 0,
        delivery_confirm_timeout: 0,
        hold_unconfirmed_timeout: 0,
        agents,
      } as never,
      () => {},
    );
  }

  const NET_AGENTS = { Explore: { approve_groups: ['read-only', 'net-read'] } };

  test('WebFetch is approved for the agent granted net-read', () => {
    const d = service(NET_AGENTS).evaluateDeterministic(
      'WebFetch',
      { url: 'https://x' },
      'Explore',
    );
    expect(d?.decision).toBe('approve');
    expect(d?.reasoning).toContain('net-read');
  });

  test('the SAME call is not approved for an agent without the section', () => {
    // The whole point of scoping: general-purpose does not inherit Explore's
    // grant. This is the measured case -- a WebFetch with no match parks,
    // renders, and enters the serial queue.
    const d = service(NET_AGENTS).evaluateDeterministic(
      'WebFetch',
      { url: 'https://x' },
      'general-purpose',
    );
    expect(d).toBeNull();
  });

  test('and not for the main context either', () => {
    expect(service(NET_AGENTS).evaluateDeterministic('WebFetch', { url: 'https://x' })).toBeNull();
  });

  test('with no agent section, WebFetch matches nothing', () => {
    expect(
      service({}).evaluateDeterministic('WebFetch', { url: 'https://x' }, 'Explore'),
    ).toBeNull();
  });

  test('a base deny still wins inside an agent that was granted the group', () => {
    const svc = new AutoApproveService(
      {
        enabled: true,
        provider: 'yooz',
        model: 'm',
        api_key: '',
        base_url: 'http://127.0.0.1:19924',
        timeout: 30,
        log_decisions: false,
        allow: [],
        deny: ['WebFetch'],
        subagent_alert: [],
        approve_groups: ['read-only'],
        level: 'strict',
        deny_groups: [],
        instructions: '',
        multichoice: 'skip',
        multichoice_model: '',
        escalate_model: '',
        escalate_timeout: 0,
        queue_timeout: 240,
        cache_idle: 0,
        keep_alive: 0,
        engine: 'owned' as const,
        engine_path: '',
        model_cache: '',
        disable_thinking: false,
        always_escalate_tools: [],
        session_precedent: true,
        hold_timeout: 0,
        push_hold_timeout: 0,
        delivery_confirm_timeout: 0,
        hold_unconfirmed_timeout: 0,
        agents: NET_AGENTS,
      } as never,
      () => {},
    );
    const d = svc.evaluateDeterministic('WebFetch', { url: 'https://x' }, 'Explore');
    expect(d?.decision).toBe('deny-covered');
  });
});

describe('net-read is in no shipped default (ADR 0025)', () => {
  // Written after a mutation exposed the first version of this claim as
  // untestable: it hardcoded `approve_groups` and so could not fail when
  // net-read was added to a LEVEL preset. Reading the presets themselves is
  // the only form of this assertion that can fail on what it claims.
  test('no level preset grants net-read', () => {
    for (const level of AUTO_APPROVE_LEVELS) {
      expect(groupsForLevel(level)).not.toContain('net-read');
    }
  });

  test('the shipped approve_groups default does not grant net-read', () => {
    expect(DEFAULT_CONFIG.auto_approve.approve_groups).not.toContain('net-read');
  });

  test('net-read IS a real, known group — absent from presets, not missing', () => {
    // Without this, deleting the group entirely would also satisfy the two
    // assertions above, and "opt-in" would silently become "unavailable".
    expect(knownGroupNames()).toContain('net-read');
  });
});

describe('validateAgents', () => {
  test('undefined is fine (no table)', () => {
    expect(() => validateAgents(undefined, '/c.toml')).not.toThrow();
  });

  test('an empty table is fine', () => {
    expect(() => validateAgents({}, '/c.toml')).not.toThrow();
  });

  test('a valid table passes', () => {
    expect(() =>
      validateAgents({ Explore: { approve_groups: ['read-only'], deny: ['curl'] } }, '/c.toml'),
    ).not.toThrow();
  });

  test('an array instead of a table throws', () => {
    expect(() => validateAgents([], '/c.toml')).toThrow(/must be a table/);
  });

  test('a non-table section throws, naming the agent', () => {
    expect(() => validateAgents({ Explore: 'read-only' }, '/c.toml')).toThrow(
      /agents\.Explore.*must be a table/s,
    );
  });

  test('a non-array list throws, naming the key', () => {
    expect(() => validateAgents({ Explore: { approve_groups: 'read-only' } }, '/c.toml')).toThrow(
      /agents\.Explore\.approve_groups/,
    );
  });

  test('a non-string element throws', () => {
    expect(() => validateAgents({ Explore: { deny: ['ok', 3] } }, '/c.toml')).toThrow(
      /agents\.Explore\.deny/,
    );
  });

  test('a MISSPELLED key throws instead of being ignored', () => {
    // `approve_group` (singular) would otherwise leave the agent on the base
    // policy while the config file plainly appears to grant something — a
    // config/behaviour mismatch of exactly the kind ADR 0011 exists to stop.
    expect(() => validateAgents({ Explore: { approve_group: ['read-only'] } }, '/c.toml')).toThrow(
      /Unknown key.*approve_group/s,
    );
  });
});
