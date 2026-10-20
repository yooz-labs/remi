import { createHash } from 'node:crypto';
/** Per-connection outcome memory. A receipt ACK never proves a decision was accepted. */
import { type AnswerMessage, type AnswerResultOutcome, createAnswerResult } from '@remi/shared';
type Entry = {
  content: string;
  startedAt: number;
  result: Promise<AnswerResultOutcome>;
  completed: boolean;
};
export class AnswerResults {
  private readonly entries = new Map<string, Entry>();
  async run(
    message: AnswerMessage,
    recognizedDuplicate: boolean,
    apply: () => Promise<AnswerResultOutcome>,
    generation = '',
  ) {
    const now = Date.now();
    for (const [id, entry] of this.entries)
      if (entry.completed && now - entry.startedAt >= 600000) this.entries.delete(id);
    const content = createHash('sha256')
      .update(
        JSON.stringify([
          generation,
          message.sessionId,
          message.questionId,
          message.answer,
          message.claudeSessionId ?? null,
          message.selections ?? null,
          message.cancel ?? null,
          message.message ?? null,
        ]),
      )
      .digest('hex');
    const old = this.entries.get(message.id);
    let outcome: AnswerResultOutcome;
    if (old) outcome = old.content === content ? await old.result : 'conflict';
    else if (recognizedDuplicate) outcome = 'uncertain';
    else if ([...this.entries.values()].filter((entry) => !entry.completed).length >= 32)
      outcome = 'busy';
    else {
      // Install before calling an async handler, so concurrent same-id answers share exactly one result.
      const entry: Entry = {
        content,
        startedAt: now,
        result: Promise.resolve()
          .then(apply)
          .catch(() => 'uncertain'),
        completed: false,
      };
      this.entries.set(message.id, entry);
      outcome = await entry.result;
      entry.completed = true;
      while ([...this.entries.values()].filter((value) => value.completed).length > 256) {
        const first = [...this.entries].find(([, value]) => value.completed);
        if (first) this.entries.delete(first[0]);
        else break;
      }
    }
    return createAnswerResult(message.id, message.sessionId, message.questionId, outcome);
  }
}
