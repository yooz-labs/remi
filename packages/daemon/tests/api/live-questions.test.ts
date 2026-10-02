/**
 * #1126 review: the tracker's live-question check ignores a held SUBAGENT
 * card (its dialog does not render while held); every other registered card
 * still counts. The end-to-end case (real gate, tracker and MessageAPI) is in
 * hook-bridge-setup.test.ts; the source check pins that the Claude session
 * (harness/claude-session.ts) wires the tracker through this function.
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { hasLiveQuestionOnScreen } from '../../src/api/live-questions.ts';

const held = new Set(['sub-held', 'main-held']);
const isHeld = (id: string) => held.has(id);

describe('hasLiveQuestionOnScreen (#1126)', () => {
  test('a held subagent card alone does not count', () => {
    expect(hasLiveQuestionOnScreen([{ id: 'sub-held', agentId: 'agent-1' }], isHeld)).toBe(false);
  });

  test('a held main card counts (its dialog renders during the hold)', () => {
    expect(hasLiveQuestionOnScreen([{ id: 'main-held' }], isHeld)).toBe(true);
  });

  test('an unheld card counts, subagent or not', () => {
    expect(hasLiveQuestionOnScreen([{ id: 'sub-free', agentId: 'agent-1' }], isHeld)).toBe(true);
    expect(hasLiveQuestionOnScreen([{ id: 'hookless' }], isHeld)).toBe(true);
  });

  test('a held subagent card next to any other card: the other counts', () => {
    expect(
      hasLiveQuestionOnScreen([{ id: 'sub-held', agentId: 'agent-1' }, { id: 'hookless' }], isHeld),
    ).toBe(true);
  });

  test('no cards: nothing live', () => {
    expect(hasLiveQuestionOnScreen([], isHeld)).toBe(false);
  });

  test("the Claude session wires the tracker's live-question check through it", () => {
    // The tracker's construction moved from cli.ts to the harness (#1164).
    const source = fs.readFileSync(
      path.resolve(import.meta.dir, '../../src/harness/claude-session.ts'),
      'utf8',
    );
    const start = source.indexOf('const tracker = new QuestionPresenceTracker(');
    expect(start).toBeGreaterThan(0);
    const trackerBlock = source.slice(start, start + 1200);
    expect(trackerBlock).toContain('hasLiveQuestions: () =>');
    expect(trackerBlock).toContain('hasLiveQuestionOnScreen(');
    expect(trackerBlock).toContain('sessionGateHandles.get(sessionId)?.isHeld(');
  });
});
