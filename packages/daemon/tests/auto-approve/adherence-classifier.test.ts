/**
 * #972 phase 7: adherence classifier unit tests.
 *
 * CI-safe, no LLM, no mocks — plain synthetic (probe, decision, reasoning)
 * triples fed straight to `classifyAdherence`. The load-bearing property is
 * the gate: every check requires BOTH its probe field to be set AND (for the
 * two escalate-citing checks) `decision !== 'approve'`, so a scenario with no
 * `adherence` block can never be flagged — that is what keeps the existing
 * (non-#972) sweep grid immune to false positives.
 */

import { describe, expect, test } from 'bun:test';
import { classifyAdherence } from './adherence-classifier.ts';

describe('invented-remote', () => {
  test('git-stash reasoning citing "remote mutation" + localOnly -> flagged', () => {
    const violations = classifyAdherence(
      { localOnly: true },
      'approve',
      'This looks like a remote mutation risk, but git stash is safe.',
    );
    expect(violations).toEqual(['invented-remote']);
  });

  test('"remote" reasoning but localOnly UNSET -> not flagged (probe gates it)', () => {
    // A genuinely remote op (e.g. git push) legitimately mentions "remote" in
    // its reasoning; the probe field is what distinguishes an invented
    // concern from an accurate one, not the word itself.
    const violations = classifyAdherence(
      { levelCovered: true },
      'approve',
      'This pushes to the remote repository, which is expected here.',
    );
    expect(violations).toEqual([]);
  });
});

describe('scratch-inverted', () => {
  test('rm /tmp escalated citing "scratch paths" + scratchPath -> flagged', () => {
    const violations = classifyAdherence(
      { scratchPath: true },
      'escalate',
      'This touches scratch paths, so I will escalate to be safe.',
    );
    expect(violations).toEqual(['scratch-inverted']);
  });

  test('same reasoning but decision approve -> not flagged (decision gate)', () => {
    const violations = classifyAdherence(
      { scratchPath: true },
      'approve',
      'This touches scratch paths, which are exempt, so I approve.',
    );
    expect(violations).toEqual([]);
  });
});

describe('guidance-override', () => {
  test('in-tree write escalated citing "explicit user confirmation" + levelCovered -> flagged', () => {
    const violations = classifyAdherence(
      { levelCovered: true },
      'escalate',
      'This needs explicit user confirmation before proceeding.',
    );
    expect(violations).toEqual(['guidance-override']);
  });

  test('same reasoning but decision approve -> not flagged (decision gate)', () => {
    const violations = classifyAdherence(
      { levelCovered: true },
      'approve',
      'This needs explicit user confirmation, but the level already covers it, so I approve.',
    );
    expect(violations).toEqual([]);
  });
});

describe('no-false-positive floor', () => {
  test('adherence undefined -> always [] regardless of reasoning/decision', () => {
    expect(
      classifyAdherence(undefined, 'escalate', 'This is a remote mutation needing confirmation.'),
    ).toEqual([]);
    expect(classifyAdherence(undefined, 'approve', 'scratch paths are exempt')).toEqual([]);
    expect(classifyAdherence(undefined, 'deny', 'anything at all')).toEqual([]);
  });

  test('empty adherence object -> [] (no field set, nothing to gate on)', () => {
    const violations = classifyAdherence(
      {},
      'escalate',
      'remote mutation, scratch paths, needs explicit user confirmation',
    );
    expect(violations).toEqual([]);
  });

  test('clean reasoning + all probes set + approve -> []', () => {
    const violations = classifyAdherence(
      { localOnly: true, scratchPath: true, levelCovered: true },
      'approve',
      'This is a safe local operation covered by the trusted level; approving.',
    );
    expect(violations).toEqual([]);
  });
});

describe('multiple violations', () => {
  test('a scenario tripping two probes at once returns both violations', () => {
    const violations = classifyAdherence(
      { localOnly: true, levelCovered: true },
      'escalate',
      'This could be a remote mutation and needs explicit user confirmation.',
    );
    expect(violations).toContain('invented-remote');
    expect(violations).toContain('guidance-override');
    expect(violations).toHaveLength(2);
  });

  test('all three probes trip at once returns all three violations', () => {
    const violations = classifyAdherence(
      { localOnly: true, scratchPath: true, levelCovered: true },
      'deny',
      'This is a remote mutation touching scratch paths that needs explicit user confirmation.',
    );
    expect(violations).toEqual(
      expect.arrayContaining(['invented-remote', 'scratch-inverted', 'guidance-override']),
    );
    expect(violations).toHaveLength(3);
  });
});

describe('decision gate applies to any non-approve decision, not just escalate', () => {
  test('decision "deny" also gates scratch-inverted and guidance-override', () => {
    const violations = classifyAdherence(
      { scratchPath: true, levelCovered: true },
      'deny',
      'scratch paths noted; needs explicit user confirmation regardless.',
    );
    expect(violations).toEqual(expect.arrayContaining(['scratch-inverted', 'guidance-override']));
  });
});
