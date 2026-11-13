/** Async Codex questions are explicit user replies, never permission results (#1687). */
import {
  type Question,
  type QuestionStep,
  type ResolvedBy,
  type UUID,
  escapeUnsafeText,
  generateId,
} from '@remi/shared';
import type { SessionRegistry } from '../../session/session-registry.ts';
import {
  type AnswerCommit,
  AnswerDeliveryUncertainError,
  type AnswerValidity,
  type HeldAnswer,
  type HeldAnswerOutcome,
  applyAnswerCommit,
} from '../decision.ts';
import {
  type AsyncQuestionHistory,
  type AsyncQuestionSource,
  asyncQuestionHistoryCollector,
  asyncTitleDigest,
  encodeAsyncQuestionReply,
  parseAsyncQuestionReply,
} from './async-question-codec.ts';
import type { CodexTextContext, CodexTextWriter } from './codex-text-writer.ts';
import { parseThreadItem } from './thread-protocol.ts';

interface Group {
  readonly threadId: string;
  readonly source: AsyncQuestionSource;
  readonly epoch: object;
  readonly answered: Set<number>;
  entry?: Entry;
}
interface Entry {
  readonly group: Group;
  readonly question: Question;
  readonly indices: readonly number[];
  state: 'live' | 'sending' | 'answered' | 'closed';
}
interface Options {
  readonly sessionId: UUID;
  readonly current: () => CodexTextContext | null;
  readonly writer: CodexTextWriter;
  readonly registry: Pick<SessionRegistry, 'getQuestion' | 'removeQuestion'>;
  readonly present: (question: Question) => void;
  readonly resolved: (
    sessionId: UUID,
    questionId: UUID,
    reason: 'answered' | 'cancelled',
    by?: ResolvedBy,
  ) => void;
  readonly notice: (text: string) => void;
  readonly log: (text: string) => void;
  readonly changed?: () => void;
}
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

export class CodexAsyncQuestions {
  private readonly groups = new Map<string, Group>();
  private readonly byId = new Map<UUID, Entry>();
  private readonly replies = new Map<string, string>();
  private readonly suppressed = new Set<string>();
  private disposed = false;
  constructor(private readonly options: Options) {}
  private key(threadId: string, callId: string): string {
    return `${threadId}:${callId}`;
  }
  private current(group: Group): boolean {
    const context = this.options.current();
    return !this.disposed && context?.threadId === group.threadId && context.epoch === group.epoch;
  }
  private remember(key: string, digest: string): void {
    this.replies.delete(key);
    this.replies.set(key, digest);
    if (this.replies.size > 8192) {
      const first = this.replies.keys().next().value;
      if (first !== undefined) this.replies.delete(first);
    }
  }
  private suppress(group: Group): void {
    const key = this.key(group.threadId, group.source.callId);
    this.suppressed.add(key);
    if (this.suppressed.size > 1024) {
      const first = this.suppressed.values().next().value;
      if (first !== undefined) this.suppressed.delete(first);
    }
  }
  private clear(entry: Entry, signal: string, answered = false): void {
    if (entry.state === 'closed') return;
    entry.state = 'closed';
    const present =
      this.options.registry.getQuestion(this.options.sessionId, entry.question.id) !== null;
    this.options.registry.removeQuestion(this.options.sessionId, entry.question.id, signal);
    if (present) {
      try {
        this.options.resolved(
          this.options.sessionId,
          entry.question.id,
          answered ? 'answered' : 'cancelled',
          answered ? 'harness' : undefined,
        );
      } catch {
        this.options.log('async question dismissal could not be broadcast');
      }
    }
    this.options.changed?.();
  }
  private sync(group: Group): void {
    if (!this.current(group)) return;
    const indices = group.source.questions
      .map((_, index) => index)
      .filter((index) => !group.answered.has(index));
    const old = group.entry;
    if (!indices.length || this.suppressed.has(this.key(group.threadId, group.source.callId))) {
      if (old) this.clear(old, 'codex_async:resolved', !indices.length);
      return;
    }
    if (
      old &&
      (old.state === 'live' || old.state === 'sending') &&
      JSON.stringify(old.indices) === JSON.stringify(indices)
    )
      return;
    if (old) this.clear(old, 'codex_async:replaced');
    const steps: QuestionStep[] = indices.map((index) => {
      const q = group.source.questions[index];
      if (!q) throw new Error('CODEX_ASYNC_INDEX');
      return {
        text: escapeUnsafeText(q.title),
        multiSelect: false,
        options: (q.options ?? []).map((label, i) => ({
          value: String(i),
          label: escapeUnsafeText(label),
          isRecommended: false,
          isYes: false,
          isNo: false,
        })),
      };
    });
    const question: Question = {
      id: generateId(),
      text: steps[0]?.text ?? 'Codex needs your input',
      options: [],
      questions: steps,
      kind: 'multi_question',
      source: 'elicitation',
      pendingLabel: 'Codex has a question',
      cancelDismissesOnly: true,
      allowsFreeText: true,
      isAnswered: false,
    };
    const entry: Entry = { group, question, indices: Object.freeze(indices), state: 'live' };
    group.entry = entry;
    this.byId.set(question.id, entry);
    try {
      this.options.present(question);
      this.options.changed?.();
    } catch {
      this.clear(entry, 'codex_async:not_shown');
      this.options.log('async question could not be presented');
    }
    if (this.byId.size > 128) {
      const first = this.byId.values().next().value;
      if (first) {
        this.clear(first, 'codex_async:capacity');
        this.byId.delete(first.question.id);
      }
    }
  }
  private source(threadId: string, source: AsyncQuestionSource): void {
    const context = this.options.current();
    if (this.disposed || context?.threadId !== threadId) return;
    const key = this.key(threadId, source.callId);
    let group = this.groups.get(key);
    if (
      !group ||
      group.epoch !== context.epoch ||
      JSON.stringify(group.source) !== JSON.stringify(source)
    ) {
      if (group?.entry) this.clear(group.entry, 'codex_async:changed');
      group = { threadId, source, epoch: context.epoch, answered: new Set() };
      this.groups.delete(key);
      this.groups.set(key, group);
    }
    for (let index = 0; index < source.questions.length; index++) {
      if (
        this.replies.get(`${key}:${index}`) ===
        asyncTitleDigest(source.questions[index]?.title ?? '')
      )
        group.answered.add(index);
    }
    this.sync(group);
    if (this.groups.size > 64) {
      const first = this.groups.entries().next().value;
      if (first) {
        if (first[1].entry) this.clear(first[1].entry, 'codex_async:capacity');
        this.groups.delete(first[0]);
      }
    }
  }
  private reply(threadId: string, text: string): void {
    if (this.options.current()?.threadId !== threadId || this.disposed) return;
    for (const reply of parseAsyncQuestionReply(text) ?? []) {
      const key = this.key(threadId, reply.callId);
      this.remember(`${key}:${reply.questionIndex}`, asyncTitleDigest(reply.question));
      const group = this.groups.get(key);
      if (!group || group.source.questions[reply.questionIndex]?.title !== reply.question) continue;
      group.answered.add(reply.questionIndex);
      this.sync(group);
    }
  }
  reconcile(threadId: string, history: AsyncQuestionHistory): void {
    if (!history.complete || this.options.current()?.threadId !== threadId || this.disposed) return;
    // Replies are applied before any source is offered, including across history pages.
    for (const [key, digest] of history.replies) this.remember(`${threadId}:${key}`, digest);
    for (const group of this.groups.values()) {
      if (group.threadId !== threadId) continue;
      for (let index = 0; index < group.source.questions.length; index++) {
        if (
          this.replies.get(`${this.key(threadId, group.source.callId)}:${index}`) ===
          asyncTitleDigest(group.source.questions[index]?.title ?? '')
        )
          group.answered.add(index);
      }
      this.sync(group);
    }
    for (const source of history.sources) this.source(threadId, source);
  }
  handleNotification(method: string, params: unknown): void {
    if (
      !record(params) ||
      typeof params['threadId'] !== 'string' ||
      this.options.current()?.threadId !== params['threadId']
    )
      return;
    const threadId = params['threadId'];
    if (
      method === 'turn/completed' &&
      record(params['turn']) &&
      Array.isArray(params['turn']['items'])
    ) {
      const collector = asyncQuestionHistoryCollector();
      for (const raw of params['turn']['items']) {
        const item = parseThreadItem(raw);
        if (item?.type === 'agentMessage' && item.asyncQuestion)
          collector.source(item.asyncQuestion);
        else if (item?.type === 'userMessage') collector.reply(item.text);
      }
      this.reconcile(threadId, collector.finish(true));
    } else if (method === 'item/started' || method === 'item/completed') {
      const item = parseThreadItem(params['item']);
      if (item?.type === 'userMessage') this.reply(threadId, item.text);
      else if (method === 'item/completed' && item?.type === 'agentMessage' && item.asyncQuestion)
        this.source(threadId, item.asyncQuestion);
    }
  }
  owns(id: UUID): boolean {
    return this.byId.has(id);
  }
  isHeld(id: UUID): boolean {
    const entry = this.byId.get(id);
    return (
      !!entry &&
      (entry.state === 'live' || entry.state === 'sending') &&
      this.current(entry.group) &&
      !this.suppressed.has(this.key(entry.group.threadId, entry.group.source.callId))
    );
  }
  hasMainHold(): boolean {
    return [...this.byId.keys()].some((id) => this.isHeld(id));
  }
  answerValidity(id: UUID): AnswerValidity {
    return this.isHeld(id) ? { kind: 'current-prompt' } : { kind: 'closed' };
  }
  retireQuestion(id: UUID): void {
    const entry = this.byId.get(id);
    if (entry) {
      this.suppress(entry.group);
      entry.state = 'closed';
      this.options.changed?.();
    }
  }
  forceRelease(suppress = true): { resolved: number } {
    let resolved = 0;
    for (const entry of this.byId.values()) {
      if (entry.state === 'live' || entry.state === 'sending') {
        if (suppress) this.suppress(entry.group);
        this.clear(entry, 'codex_async:released');
        resolved++;
      }
    }
    return { resolved };
  }
  dispose(): void {
    this.forceRelease();
    this.disposed = true;
    this.groups.clear();
    this.byId.clear();
  }

  async answerHeld(
    id: UUID,
    answer: HeldAnswer,
    commit?: AnswerCommit,
  ): Promise<HeldAnswerOutcome> {
    const entry = this.byId.get(id);
    if (
      !entry ||
      entry.state === 'closed' ||
      entry.state === 'answered' ||
      this.suppressed.has(this.key(entry.group.threadId, entry.group.source.callId)) ||
      !this.current(entry.group)
    )
      return 'closed';
    if (entry.state === 'sending') return 'refused';
    if (answer.kind === 'cancel') {
      this.suppress(entry.group);
      entry.state = 'closed';
      return 'closed';
    }
    if (!commit) return 'authority-refused';
    const answers: Array<{ questionIndex: number; answer: string }> = [];
    if (answer.kind === 'text' && entry.indices.length === 1) {
      const index = entry.indices[0];
      if (index === undefined) return 'refused';
      answers.push({ questionIndex: index, answer: answer.text });
    } else if (answer.kind === 'selections' && answer.selections.length === entry.indices.length) {
      const used = new Set<number>();
      for (const selection of answer.selections) {
        const index = entry.indices[selection.questionIndex];
        if (!Number.isInteger(selection.questionIndex) || index === undefined || used.has(index))
          return 'refused';
        used.add(index);
        const choices = selection.optionIndices ?? [];
        if (!Array.isArray(choices)) return 'refused';
        const custom = selection.text;
        if (typeof custom === 'string' && custom.trim() && choices.length === 0)
          answers.push({ questionIndex: index, answer: custom });
        else if (custom === undefined && choices.length === 1 && Number.isInteger(choices[0])) {
          const selected = entry.group.source.questions[index]?.options?.[choices[0] as number];
          if (selected === undefined) return 'refused';
          answers.push({ questionIndex: index, answer: selected });
        } else return 'refused';
      }
    } else return 'refused';
    const text = encodeAsyncQuestionReply(entry.group.source, answers);
    if (!text) return 'refused';
    entry.state = 'sending';
    const canSend = () =>
      entry.state === 'sending' &&
      !this.suppressed.has(this.key(entry.group.threadId, entry.group.source.callId)) &&
      this.current(entry.group) &&
      entry.group.entry === entry &&
      this.options.registry.getQuestion(this.options.sessionId, id)?.isAnswered === false;
    let sent = false;
    // A normal user-message echo can resolve/replace the card before its RPC
    // result arrives. It removes pre-send authority, not a valid receipt for
    // the already sent operation. Thread/runtime checks remain in both phases.
    const current = () => this.current(entry.group) && (sent || canSend());
    let authorityRefused = false;
    const result = await this.options.writer.send(
      { id: generateId(), threadId: entry.group.threadId, text },
      current,
      (send) => {
        const result = applyAnswerCommit(() => {
          if (!canSend()) return false;
          send();
          sent = true;
          return true;
        }, commit);
        if (result.kind === 'refused') {
          authorityRefused = true;
          return false;
        }
        return result.value;
      },
    );
    if (result.outcome === 'uncertain') {
      this.suppress(entry.group);
      entry.state = 'closed';
      const replacement = entry.group.entry;
      if (replacement && replacement !== entry) this.clear(replacement, 'codex_async:uncertain');
      this.options.changed?.();
      try {
        this.options.notice(
          'Question answer delivery is uncertain. Check this conversation before answering again.',
        );
      } catch {
        this.options.log('async question uncertainty notice could not be broadcast');
      }
      throw new AnswerDeliveryUncertainError();
    }
    if (result.outcome === 'refused') {
      if (current()) entry.state = 'live';
      else return 'closed';
      return authorityRefused ? 'authority-refused' : 'refused';
    }
    entry.state = 'answered';
    this.options.changed?.();
    for (const answer of answers) {
      entry.group.answered.add(answer.questionIndex);
      this.remember(
        `${this.key(entry.group.threadId, entry.group.source.callId)}:${answer.questionIndex}`,
        asyncTitleDigest(entry.group.source.questions[answer.questionIndex]?.title ?? ''),
      );
    }
    // The normal answer core removes this card; retire any refreshed partial card too.
    if (entry.group.entry !== entry) this.sync(entry.group);
    return 'resolved';
  }
}
