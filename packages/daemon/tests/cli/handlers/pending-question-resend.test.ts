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
    expect(sent).toHaveLength(2);
    for (const [i, msg] of sent.entries()) {
      expect(msg.type).toBe('question');
      if (msg.type !== 'question') continue;
      expect(msg.question).toBe(pending[i] as Question);
      expect(msg.sessionId).toBe(sessionId);
      expect(msg.claudeSessionId).toBe(claudeSessionId);
    }
  });

  it('omits claudeSessionId from the wire message when not provided', () => {
    const sent: ProtocolMessage[] = [];
    resendPendingQuestions((m) => sent.push(m), sessionId, [makeQuestion('Allow Bash?')]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toHaveProperty('claudeSessionId');
  });

  it('no pending questions -> sends nothing and reports 0', () => {
    const sent: ProtocolMessage[] = [];
    expect(resendPendingQuestions((m) => sent.push(m), sessionId, [])).toBe(0);
    expect(sent).toHaveLength(0);
  });
});
