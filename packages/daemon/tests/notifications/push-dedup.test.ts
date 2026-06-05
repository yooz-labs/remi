/**
 * Tests for the push-trigger dedup (#409).
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

const defaultThreeSet = ['Yes', 'Yes, always', 'No'];
const customThreeSet = [
  'Yes',
  "Yes, and don't ask again this session",
  'No, and tell Claude what to do differently',
];

describe('PushDedup', () => {
  test('first push always fires', () => {
    const dedup = new PushDedup();
    expect(dedup.shouldPush(q(defaultThreeSet))).toBe(true);
  });

  test('default 3-set after default 3-set within window: suppressed', () => {
    let t = 1000;
    const dedup = new PushDedup(5000, () => t);
    expect(dedup.shouldPush(q(defaultThreeSet))).toBe(true);
    t += 100;
    // Same shape, same count → not richer, suppress.
    expect(dedup.shouldPush(q(defaultThreeSet))).toBe(false);
  });

  test('non-default after default within window: fires (upgrade)', () => {
    // The bug case: PTY sees [y/n], emits 2-option Yes/No AFTER the
    // hook bridge fired the default 3-set. The lock-screen options
    // need to upgrade to the real Yes/No so tapping Yes maps to the
    // correct value.
    let t = 1000;
    const dedup = new PushDedup(5000, () => t);
    expect(dedup.shouldPush(q(defaultThreeSet))).toBe(true);
    t += 100;
    expect(dedup.shouldPush(q(['Yes', 'No']))).toBe(true);
  });

  test('default after non-default within window: suppressed', () => {
    // The other ordering: PTY parser fires first with 2-option
    // Yes/No, hook bridge fires the bland 3-set after. Suppress the
    // bland duplicate; the user's first push already covers the
    // prompt with the correct options.
    let t = 1000;
    const dedup = new PushDedup(5000, () => t);
    expect(dedup.shouldPush(q(['Yes', 'No']))).toBe(true);
    t += 100;
    expect(dedup.shouldPush(q(defaultThreeSet))).toBe(false);
  });

  test('strict-more-options upgrade fires', () => {
    let t = 1000;
    const dedup = new PushDedup(5000, () => t);
    expect(dedup.shouldPush(q(['Yes', 'No']))).toBe(true);
    t += 100;
    // Non-default, more options → upgrade.
    expect(dedup.shouldPush(q(['Refactor', 'Patch', 'Skip', 'Other']))).toBe(true);
  });

  test('equal-rank non-default twice within window: suppressed', () => {
    let t = 1000;
    const dedup = new PushDedup(5000, () => t);
    expect(dedup.shouldPush(q(['Yes', 'No']))).toBe(true);
    t += 100;
    expect(dedup.shouldPush(q(['Yes', 'No']))).toBe(false);
  });

  test('beyond window: same rank fires', () => {
    let t = 1000;
    const dedup = new PushDedup(5000, () => t);
    expect(dedup.shouldPush(q(['Yes', 'No']))).toBe(true);
    t += 6000;
    expect(dedup.shouldPush(q(['Yes', 'No']))).toBe(true);
  });

  test('reset clears the baseline', () => {
    let t = 1000;
    const dedup = new PushDedup(5000, () => t);
    expect(dedup.shouldPush(q(defaultThreeSet))).toBe(true);
    dedup.reset();
    t += 100;
    expect(dedup.shouldPush(q(defaultThreeSet))).toBe(true);
  });

  test('boundary: exactly windowMs ago is treated as expired (strict <)', () => {
    let t = 1000;
    const dedup = new PushDedup(5000, () => t);
    expect(dedup.shouldPush(q(defaultThreeSet))).toBe(true);
    t += 5000;
    // At the boundary, the prior baseline expires and the same-rank
    // emission fires as a new prompt cycle.
    expect(dedup.shouldPush(q(defaultThreeSet))).toBe(true);
  });

  test('upgrade re-arms baseline so subsequent equal-or-poorer is suppressed', () => {
    let t = 1000;
    const dedup = new PushDedup(5000, () => t);
    expect(dedup.shouldPush(q(['Yes', 'No']))).toBe(true);
    t += 100;
    // Upgrade to 4 options
    expect(dedup.shouldPush(q(['a', 'b', 'c', 'd']))).toBe(true);
    t += 100;
    // Subsequent 3-option non-default → not strictly more → suppress.
    expect(dedup.shouldPush(q(['a', 'b', 'c']))).toBe(false);
    t += 100;
    // Default 3-set → still poorer → suppress.
    expect(dedup.shouldPush(q(defaultThreeSet))).toBe(false);
  });

  test('Edit-style 3-set with custom labels is treated as default (looksLikeDefault)', () => {
    // looksLikeDefaultPermissionQuestion uses startsWith('yes')/('no'),
    // so Edit's "[Yes, ..., No, ...]" matches default-shape. This is
    // intentional: treating both as the same "binary permission shape"
    // means a duplicate Edit-style emission within window is suppressed.
    let t = 1000;
    const dedup = new PushDedup(5000, () => t);
    expect(dedup.shouldPush(q(customThreeSet))).toBe(true);
    t += 100;
    expect(dedup.shouldPush(q(defaultThreeSet))).toBe(false);
  });
});
