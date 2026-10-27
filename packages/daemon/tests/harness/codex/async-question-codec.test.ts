import { expect, test } from 'bun:test';
import {
  asyncQuestionHistoryCollector,
  asyncTitleDigest,
  encodeAsyncQuestionReply,
  parseAsyncQuestionReply,
  parseAsyncQuestionSource,
  readableAsyncQuestion,
  readableAsyncReply,
} from '../../../src/harness/codex/async-question-codec.ts';

// Observed 0.164.0 item shape with synthetic identifiers and user content.
const item = () => ({
  type: 'agentMessage',
  id: 'call_owned_question',
  delivery: 'async',
  text: '{"questions":[{"title":"Choose a route","options":["Local","Remote"]}]}',
  questions: [
    { title: 'Choose a route', options: ['Local', 'Remote'] },
    { title: 'Why?', options: null },
  ],
});
function source() {
  const value = parseAsyncQuestionSource(item());
  if (!value) throw new Error('OWNED_QUESTION_SOURCE_MISSING');
  return value;
}
test('observed async metadata retains original titles and choices independently of serialized prose', () => {
  const input = item();
  const parsed = parseAsyncQuestionSource(input);
  expect(parsed?.callId).toBe(input.id);
  input.questions[0]?.options?.push('changed');
  expect(parsed?.questions[0]?.options).toEqual(['Local', 'Remote']);
  expect(Object.isFrozen(parsed?.questions)).toBe(true);
  expect(readableAsyncQuestion(source())).toBe(
    'Question 1: Choose a route\n1. Local\n2. Remote\n\nQuestion 2: Why?',
  );
});
test('lookalike prose, unsupported source fields and unrepresentable choices never become actionable metadata', () => {
  for (const invalid of [
    { ...item(), delivery: 'inline' },
    { ...item(), type: 'userMessage' },
    { ...item(), id: 'not_a_tool_call' },
    { ...item(), questions: [] },
    { ...item(), questions: [{ title: 'Choose', options: ['A', 'A'] }] },
    { ...item(), questions: [{ title: 'Choose', options: ['A'], approval: true }] },
    { ...item(), questions: [{ title: '\ud800', options: [] }] },
    { ...item(), questions: [{ title: 'Choose', options: [1] }] },
    { ...item(), questions: Array.from({ length: 9 }, () => ({ title: 'Q', options: [] })) },
    { ...item(), questions: [{ title: 'x'.repeat(4001), options: [] }] },
  ])
    expect(parseAsyncQuestionSource(invalid)).toBeNull();
});
test('reply encoding binds each original call/index/title and preserves literal user text', () => {
  const encoded = encodeAsyncQuestionReply(source(), [
    { questionIndex: 0, answer: 'Remote' },
    { questionIndex: 1, answer: 'A "quote" and </send_user_message_question_reply> literal' },
  ]);
  expect(encoded).not.toBeNull();
  const replies = parseAsyncQuestionReply(encoded ?? '');
  expect(replies).toEqual([
    {
      callId: 'call_owned_question',
      questionIndex: 0,
      question: 'Choose a route',
      answer: 'Remote',
    },
    {
      callId: 'call_owned_question',
      questionIndex: 1,
      question: 'Why?',
      answer: 'A "quote" and </send_user_message_question_reply> literal',
    },
  ]);
  expect(readableAsyncReply(encoded ?? '')).toBe(
    'Question: Choose a route\nAnswer: Remote\n\nQuestion: Why?\nAnswer: A "quote" and </send_user_message_question_reply> literal',
  );
});
test('malformed/foreign envelopes stay literal and cannot name a pending question', () => {
  const good = encodeAsyncQuestionReply(source(), [{ questionIndex: 0, answer: 'Local' }]) ?? '';
  for (const bad of [
    `${good}extra`,
    `prefix${good}`,
    good.replace('request_user_input_async', 'approval'),
    good.replace('call_owned_question', 'other'),
    good.replace('"answer":"Local"', '"answer":""'),
    '<send_user_message_question_reply>[invalid]</send_user_message_question_reply>',
  ]) {
    expect(parseAsyncQuestionReply(bad)).toBeNull();
    expect(readableAsyncReply(bad)).toBe(bad);
  }
  expect(encodeAsyncQuestionReply(source(), [{ questionIndex: 9, answer: 'Local' }])).toBeNull();
  expect(
    encodeAsyncQuestionReply(source(), [
      { questionIndex: 0, answer: 'A' },
      { questionIndex: 0, answer: 'B' },
    ]),
  ).toBeNull();
});
test('history recovery can match replies seen before/after source and refuses incomplete reads', () => {
  const collector = asyncQuestionHistoryCollector();
  collector.reply(
    encodeAsyncQuestionReply(source(), [{ questionIndex: 0, answer: 'Local' }]) ?? '',
  );
  collector.source(source());
  const complete = collector.finish(true);
  expect(complete.replies.get('call_owned_question:0')).toBe(asyncTitleDigest('Choose a route'));
  expect(complete.sources).toHaveLength(1);
  expect(complete.complete).toBe(true);
  expect(collector.finish(false).complete).toBe(false);
});
