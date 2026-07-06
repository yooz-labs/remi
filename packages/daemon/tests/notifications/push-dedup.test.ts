/**
 * Tests for the push-trigger dedup (#409, #718).
 */

import { describe, expect, test } from 'bun:test';
import type { Question, QuestionOption } from '@remi/shared';
import { PushDedup } from '../../src/notifications/push-dedup.ts';

function opt(label: string): QuestionOption {
  return { label, value: label, isRecommended: false, isYes: false, isNo: false };
}

function q(options: readonly string[], allowsFreeText = false): Question {
  return {
    id: 'q-id',
    text: 'prompt text',
    options: options.map(opt),
    allowsFreeText,
    isAnswered: false,
  };
}

// #718: the daemon's fallback shrank from a fabricated 3-set (Yes / Yes,
// always / No) to the honest Yes/No 2-set — so it is now the SAME shape
// (2 options, "yes"/"no"-prefixed labels) `looksLikeDefaultPermissionQuestion`
// treats as "default". A genuinely distinct 2-option prompt therefore needs
// labels that do NOT both start with "yes"/"no" to be distinguishable from it.
const defaultTwoSet = ['Yes', 'No'];
const customTwoSet = ['Yes', "Don't allow"];
// A real Edit-style 2-option set: distinctively worded but still yes/no-
// prefixed, so the shape heuristic (by design) still treats it as "default".
const editStyleTwoSet = ['Yes', 'No, and tell Claude what to do differently'];

describe('PushDedup', () => {
  test('first push always fires', () => {
    const dedup = new PushDedup();
    expect(dedup.shouldPush(q(defaultTwoSet))).toBe(true);
  });

  test('default 2-set after default 2-set within window: suppressed', () => {
    let t = 1000;
    const dedup = new PushDedup(5000, () => t);
    expect(dedup.shouldPush(q(defaultTwoSet))).toBe(true);
    t += 100;
    // Same shape, same count → not richer, suppress.
    expect(dedup.shouldPush(q(defaultTwoSet))).toBe(false);
  });

  test('non-default after default within window: fires (upgrade)', () => {
    // The bug case: PTY sees a genuine prompt AFTER the hook bridge fired
    // the default fallback. The lock-screen options need to upgrade to the
    // real question so tapping an option maps to the correct value.
    let t = 1000;
    const dedup = new PushDedup(5000, () => t);
    expect(dedup.shouldPush(q(defaultTwoSet))).toBe(true);
    t += 100;
    expect(dedup.shouldPush(q(customTwoSet))).toBe(true);
  });

  test('default after non-default within window: suppressed', () => {
    // The other ordering: PTY parser fires first with a real question,
    // hook bridge fires the bland fallback after. Suppress the bland
    // duplicate; the user's first push already covers the prompt with the
    // correct options.
    let t = 1000;
    const dedup = new PushDedup(5000, () => t);
    expect(dedup.shouldPush(q(customTwoSet))).toBe(true);
    t += 100;
    expect(dedup.shouldPush(q(defaultTwoSet))).toBe(false);
  });

  test('strict-more-options upgrade fires', () => {
    let t = 1000;
    const dedup = new PushDedup(5000, () => t);
    expect(dedup.shouldPush(q(customTwoSet))).toBe(true);
    t += 100;
    // Non-default, more options → upgrade.
    expect(dedup.shouldPush(q(['Refactor', 'Patch', 'Skip', 'Other']))).toBe(true);
  });

  test('equal-rank non-default twice within window: suppressed', () => {
    let t = 1000;
    const dedup = new PushDedup(5000, () => t);
    expect(dedup.shouldPush(q(customTwoSet))).toBe(true);
    t += 100;
    expect(dedup.shouldPush(q(customTwoSet))).toBe(false);
  });

  test('beyond window: same rank fires', () => {
    let t = 1000;
    const dedup = new PushDedup(5000, () => t);
    expect(dedup.shouldPush(q(customTwoSet))).toBe(true);
    t += 6000;
    expect(dedup.shouldPush(q(customTwoSet))).toBe(true);
  });

  test('reset clears the baseline', () => {
    let t = 1000;
    const dedup = new PushDedup(5000, () => t);
    expect(dedup.shouldPush(q(defaultTwoSet))).toBe(true);
    dedup.reset();
    t += 100;
    expect(dedup.shouldPush(q(defaultTwoSet))).toBe(true);
  });

  test('boundary: exactly windowMs ago is treated as expired (strict <)', () => {
    let t = 1000;
    const dedup = new PushDedup(5000, () => t);
    expect(dedup.shouldPush(q(defaultTwoSet))).toBe(true);
    t += 5000;
    // At the boundary, the prior baseline expires and the same-rank
    // emission fires as a new prompt cycle.
    expect(dedup.shouldPush(q(defaultTwoSet))).toBe(true);
  });

  test('upgrade re-arms baseline so subsequent equal-or-poorer is suppressed', () => {
    let t = 1000;
    const dedup = new PushDedup(5000, () => t);
    expect(dedup.shouldPush(q(customTwoSet))).toBe(true);
    t += 100;
    // Upgrade to 4 options
    expect(dedup.shouldPush(q(['a', 'b', 'c', 'd']))).toBe(true);
    t += 100;
    // Subsequent 3-option non-default → not strictly more → suppress.
    expect(dedup.shouldPush(q(['a', 'b', 'c']))).toBe(false);
    t += 100;
    // Default 2-set → still poorer → suppress.
    expect(dedup.shouldPush(q(defaultTwoSet))).toBe(false);
  });

  test('Edit-style 2-set with custom wording is treated as default (looksLikeDefault)', () => {
    // looksLikeDefaultPermissionQuestion uses startsWith('yes')/('no'), so
    // Edit's "[Yes, No, and ...]" matches default-shape by design: treating
    // both as the same "binary permission shape" means a duplicate
    // Edit-style emission within window is suppressed.
    let t = 1000;
    const dedup = new PushDedup(5000, () => t);
    expect(dedup.shouldPush(q(editStyleTwoSet))).toBe(true);
    t += 100;
    expect(dedup.shouldPush(q(defaultTwoSet))).toBe(false);
  });
});
