import { describe, expect, it } from 'bun:test';
import type { ProtocolMessage, Question, UUID } from '@remi/shared';
import { generateId } from '@remi/shared';
import { resendPendingQuestions } from '../../../src/cli/handlers/pending-question-resend.ts';

function makeQuestion(text: string): Question {
  return {
    id: generateId(),
    text,
    options: [
      { label: 'Yes', value: '1', isRecommended: true, isYes: true, isNo: false },
      { label: 'No', value: '2', isRecommended: false, isYes: false, isNo: true },
    ],
    allowsFreeText: false,
    isAnswered: false,
  };
}

describe('resendPendingQuestions (#753)', () => {
  const sessionId = generateId() as UUID;
  const claudeSessionId = generateId() as UUID;

  it('sends one live question message per pending question, preserving order', () => {
    const sent: ProtocolMessage[] = [];
    const pending = [makeQuestion('Allow Bash?'), makeQuestion('Allow Edit?')];

    const count = resendPendingQuestions((m) => sent.push(m), sessionId, pending, claudeSessionId);

    expect(count).toBe(2);
    const questions = sent.filter((m) => m.type === 'question');
    expect(questions).toHaveLength(2);
    for (const [i, msg] of questions.entries()) {
      if (msg.type !== 'question') continue;
      expect(msg.question).toBe(pending[i] as Question);
      expect(msg.sessionId).toBe(sessionId);
      expect(msg.claudeSessionId).toBe(claudeSessionId);
    }
  });

  it('omits claudeSessionId from the wire message when not provided', () => {
    const sent: ProtocolMessage[] = [];
    resendPendingQuestions((m) => sent.push(m), sessionId, [makeQuestion('Allow Bash?')]);
    const question = sent.find((m) => m.type === 'question');
    expect(question).toBeDefined();
    expect(question).not.toHaveProperty('claudeSessionId');
  });
});

describe('resendPendingQuestions attach snapshot (#808)', () => {
  const sessionId = generateId() as UUID;

  it('sends a question_snapshot carrying exactly the live ids, AFTER the questions', () => {
    const sent: ProtocolMessage[] = [];
    const pending = [makeQuestion('Allow Bash?'), makeQuestion('Allow Edit?')];

    resendPendingQuestions((m) => sent.push(m), sessionId, pending);

    // Ordering is load-bearing: a snapshot arriving BEFORE the questions it
    // lists would have the client prune cards it is about to be told about.
    expect(sent.map((m) => m.type)).toEqual(['question', 'question', 'question_snapshot']);
    const snapshot = sent.at(-1);
    if (snapshot?.type !== 'question_snapshot') throw new Error('expected a snapshot');
    expect(snapshot.sessionId).toBe(sessionId);
    expect([...snapshot.questionIds]).toEqual(pending.map((q) => q.id));
  });

  it('no pending questions -> STILL sends an empty snapshot (the phantom-clearing case)', () => {
    const sent: ProtocolMessage[] = [];

    // This is the case the additive re-send structurally cannot express, and
    // the one that matters most: a client reconnecting into a quiet session
    // holding a stale card gets no `question` and (pre-#808) no snapshot
    // either, so nothing ever told it to drop the card. The empty id set is
    // that instruction.
    expect(resendPendingQuestions((m) => sent.push(m), sessionId, [])).toBe(0);

    expect(sent).toHaveLength(1);
    const snapshot = sent[0];
    if (snapshot?.type !== 'question_snapshot') throw new Error('expected a snapshot');
    expect(snapshot.sessionId).toBe(sessionId);
    expect([...snapshot.questionIds]).toEqual([]);
  });
});
