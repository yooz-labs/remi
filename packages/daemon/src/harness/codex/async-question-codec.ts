/** Observed Codex async question metadata and its explicit user-reply envelope (#1687). */
import { createHash } from 'node:crypto';

export interface AsyncQuestion {
  readonly title: string;
  readonly options: readonly string[] | null;
}
export interface AsyncQuestionSource {
  readonly callId: string;
  readonly questions: readonly AsyncQuestion[];
}
export interface AsyncQuestionReply {
  readonly callId: string;
  readonly questionIndex: number;
  readonly question: string;
  readonly answer: string;
}
const OPEN = '<send_user_message_question_reply>';
const CLOSE = '</send_user_message_question_reply>';
const TOOL = 'request_user_input_async';
const CALL = /^call_[A-Za-z0-9_-]{1,190}$/;
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
function text(v: unknown, maximum: number): v is string {
  if (typeof v !== 'string' || v.length > maximum || !v.trim() || v.includes('\0')) return false;
  const bytes = new TextEncoder().encode(v);
  return bytes.length <= maximum && new TextDecoder('utf-8', { fatal: true }).decode(bytes) === v;
}

/** Metadata is authoritative only for this recognized async source, never prose that looks like JSON. */
export function parseAsyncQuestionSource(item: unknown): AsyncQuestionSource | null {
  if (!object(item)) return null;
  const { type, id, delivery, questions } = item;
  if (
    type !== 'agentMessage' ||
    delivery !== 'async' ||
    typeof id !== 'string' ||
    !CALL.test(id) ||
    !Array.isArray(questions) ||
    questions.length < 1 ||
    questions.length > 8
  )
    return null;
  const result: AsyncQuestion[] = [];
  for (const q of questions) {
    if (!object(q) || Object.keys(q).some((key) => key !== 'title' && key !== 'options'))
      return null;
    const { title, options } = q;
    if (!text(title, 4000)) return null;
    if (
      options !== null &&
      options !== undefined &&
      (!Array.isArray(options) ||
        options.length > 12 ||
        options.some((option) => !text(option, 1000)) ||
        new Set(options).size !== options.length)
    )
      return null;
    result.push(
      Object.freeze({
        title,
        options: options == null ? null : Object.freeze([...options] as string[]),
      }),
    );
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 12 * 1024) return null;
  return Object.freeze({ callId: id, questions: Object.freeze(result) });
}

/** Exact recognized envelope only. Malformed or unrelated user text remains literal chat. */
export function parseAsyncQuestionReply(raw: string): readonly AsyncQuestionReply[] | null {
  if (Buffer.byteLength(raw) > 64 * 1024) return null;
  const value = raw.trim();
  if (!value.startsWith(OPEN) || !value.endsWith(CLOSE)) return null;
  try {
    const rows: unknown = JSON.parse(value.slice(OPEN.length, -CLOSE.length).trim());
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 8) return null;
    const replies: AsyncQuestionReply[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (!object(row) || Object.keys(row).length !== 3) return null;
      const { answer, question, questionItemId } = row;
      if (!text(answer, 8192) || !text(question, 4000) || !text(questionItemId, 512)) return null;
      const tuple: unknown = JSON.parse(questionItemId);
      if (
        !Array.isArray(tuple) ||
        tuple.length !== 3 ||
        tuple[0] !== TOOL ||
        typeof tuple[1] !== 'string' ||
        !CALL.test(tuple[1]) ||
        !Number.isInteger(tuple[2]) ||
        tuple[2] < 0 ||
        tuple[2] >= 8
      )
        return null;
      const key = `${tuple[1]}:${tuple[2]}`;
      if (seen.has(key)) return null;
      seen.add(key);
      replies.push(Object.freeze({ callId: tuple[1], questionIndex: tuple[2], question, answer }));
    }
    return Object.freeze(replies);
  } catch {
    return null;
  }
}

export function encodeAsyncQuestionReply(
  source: AsyncQuestionSource,
  answers: readonly { questionIndex: number; answer: string }[],
): string | null {
  if (!answers.length || answers.length > source.questions.length) return null;
  const entries = answers.map(({ questionIndex, answer }) => ({
    answer,
    question: source.questions[questionIndex]?.title,
    questionItemId: JSON.stringify([TOOL, source.callId, questionIndex]),
  }));
  const value = `${OPEN}\n${JSON.stringify(entries)}\n${CLOSE}`;
  return Buffer.byteLength(value) <= 16 * 1024 && parseAsyncQuestionReply(value) !== null
    ? value
    : null;
}

export function readableAsyncQuestion(source: AsyncQuestionSource): string {
  return source.questions
    .map(
      (q, index) =>
        `${source.questions.length > 1 ? `Question ${index + 1}: ` : ''}${q.title}${
          q.options?.length
            ? `\n${q.options.map((option, i) => `${i + 1}. ${option}`).join('\n')}`
            : ''
        }`,
    )
    .join('\n\n');
}
export function readableAsyncReply(text: string): string {
  const replies = parseAsyncQuestionReply(text);
  return replies
    ? replies.map((q) => `Question: ${q.question}\nAnswer: ${q.answer}`).join('\n\n')
    : text;
}
export const asyncTitleDigest = (title: string): string =>
  createHash('sha256').update(title).digest('hex');

export interface AsyncQuestionHistory {
  readonly sources: readonly AsyncQuestionSource[];
  readonly replies: ReadonlyMap<string, string>;
  readonly complete: boolean;
}
/** Bounded metadata only; no transcript/command bodies are retained for recovery. */
export function asyncQuestionHistoryCollector() {
  const sources = new Map<string, AsyncQuestionSource>();
  const replies = new Map<string, string>();
  let overflow = false;
  return {
    source(value: AsyncQuestionSource) {
      sources.delete(value.callId);
      sources.set(value.callId, value);
      if (sources.size > 64) sources.delete(sources.keys().next().value as string);
    },
    reply(text: string) {
      for (const r of parseAsyncQuestionReply(text) ?? []) {
        const key = `${r.callId}:${r.questionIndex}`;
        if (!replies.has(key) && replies.size >= 8192) {
          overflow = true;
          continue;
        }
        replies.set(key, asyncTitleDigest(r.question));
      }
    },
    finish(complete: boolean): AsyncQuestionHistory {
      return { sources: [...sources.values()], replies, complete: complete && !overflow };
    },
  };
}
