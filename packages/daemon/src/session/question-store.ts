/**
 * QuestionStore — single owner of a session's pending-question map (#888).
 *
 * Extracted from `SessionRegistry`, which used to mutate `currentQuestions`
 * (add / evict / remove / clear) directly inline, each site independently
 * emitting its own question-lifecycle trace record. After this change, grep
 * for `.set(` / `.delete(` / `.clear(` on a pending-question map anywhere in
 * `packages/daemon/src` turns up only this file. `SessionRegistry`'s
 * `addQuestion` / `removeQuestion` / `clearQuestions` / `getQuestion` keep
 * their exact pre-existing signatures (#888's explicit ask) and become thin
 * adapters, so no call site -- production or test -- needs to change.
 *
 * `ManagedSession.currentQuestions` stays a real, live view over THIS
 * store's own map (not a copy taken at some point in time) -- so every
 * existing `.get` / `.has` / `.size` / `.values` / `.keys` read call site
 * keeps working completely unchanged; only the ability to mutate it moved
 * here, and is enforced at the type level (`ReadonlyMap`).
 *
 * Scope note (#888 PR body): this consolidates ONLY the pendingness map
 * itself -- "is this question still awaiting an answer, and what is it."
 * The gate's own bookkeeping about a pending question it already knows about
 * (`AutoApproveGate`'s `pendingHolds` / `openQuestionSignatures` /
 * `parkedInputs` / `evalIdByQuestion` / `confirmedDeliveries`,
 * `QuestionPresenceTracker`'s `pending` / `awaitingPTY` / `bufferedDuringEval`
 * / `armedOrphanQuestion`) is left as-is: each is metadata about HOW to
 * resolve a question this store already owns (an open auto-approve eval, a
 * held hook, a parked PTY-arbitration record), not a second, competing
 * opinion on WHETHER it is pending. Folding those in too was judged too
 * large and too risky for one PR given how much of #751/#763/#767/#814's
 * hard-won correctness lives in their exact current shape (see the PR
 * description for the full reasoning) -- scoped out as follow-up work.
 */

import type { Question, UUID } from '@remi/shared';
import { traceQuestionEvent } from './question-trace.ts';

/** Upper bound on concurrently-pending questions per session. Real prompts are
 *  few (main + a handful of subagents); the cap is a backstop against a runaway
 *  prompt loop growing the map unbounded. Oldest is evicted first. */
const MAX_PENDING_QUESTIONS = 8;

/** Events emitted by QuestionStore. */
export interface QuestionStoreEvents {
  /** Fires with the FULL current set after every add / remove / evict / clear
   *  (never a delta), so a caller mirroring this into another store (the
   *  live-sessions registry file, `question_snapshot` broadcast) can always
   *  overwrite rather than merge. */
  onQuestionsChanged?: (questions: readonly Question[]) => void;
}

export class QuestionStore {
  /** The ONE map of pending questions for this session. Nothing outside this
   *  class may mutate it -- see the class doc. */
  private readonly map = new Map<UUID, Question>();

  constructor(
    private readonly sessionId: UUID,
    private readonly events: QuestionStoreEvents = {},
  ) {}

  /** Read-only live view. Same underlying Map instance every call (not a
   *  snapshot copy), so `.get`/`.has`/`.size`/`.values`/`.keys` always reflect
   *  the current state -- callers just cannot `.set`/`.delete`/`.clear` it. */
  get questions(): ReadonlyMap<UUID, Question> {
    return this.map;
  }

  /**
   * Register a pending question. Multiple can coexist (main + subagent); each
   * is tracked by its own id so answering one never invalidates another.
   * Bounded by MAX_PENDING_QUESTIONS (oldest evicted first) so a runaway
   * prompt loop cannot grow the map without limit.
   *
   * `callSite` (#887/#888) names the internal caller for the question-trace;
   * `SessionRegistry.addQuestion` passes its own name so the trace is
   * byte-for-byte unchanged from before this extraction.
   */
  add(question: Question, signal = 'unknown', callSite = 'QuestionStore.add'): void {
    this.map.delete(question.id); // re-insert so a refreshed question is "newest"
    this.map.set(question.id, question);
    while (this.map.size > MAX_PENDING_QUESTIONS) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.map.get(oldest);
      this.map.delete(oldest);
      // Log: an evicted prompt may have an outstanding APNS push whose answer
      // will now be refused as STALE_ANSWER. Should be unreachable in normal
      // use (cap is generous); a hit signals a runaway prompt loop -- or,
      // pre-#888/#920, a hook-less question with no other removal path.
      console.warn(
        `[QuestionStore] pending-question cap (${MAX_PENDING_QUESTIONS}) exceeded; evicted oldest id=${oldest} text="${evicted?.text.slice(0, 60) ?? ''}"`,
      );
      // #808: an LRU eviction is a removal too -- it never goes through
      // remove() (there is no single questionId call site for it), so trace
      // it here directly rather than let it appear as a silent gap.
      traceQuestionEvent({
        action: 'remove',
        sessionId: this.sessionId,
        questionId: oldest,
        promptId: evicted?.promptId,
        agentId: evicted?.agentId,
        isSubagent: evicted?.agentId !== undefined,
        signal: 'lru_eviction',
        callSite: `${callSite}:lru_eviction`,
        throughFunnel: true,
      });
    }
    this.notifyChanged();
    traceQuestionEvent({
      action: 'add',
      sessionId: this.sessionId,
      questionId: question.id,
      promptId: question.promptId,
      agentId: question.agentId,
      isSubagent: question.agentId !== undefined,
      signal,
      callSite,
    });
  }

  /** Remove one answered/resolved question by id. `signal` (#808) names the
   *  event/reason that caused the removal (e.g. 'PostToolUse', 'Stop',
   *  'user_answer', 'pty_render_superseded'); `toolName`, when the caller
   *  knows it, is carried onto the same record. `callSite` (#887) names the
   *  internal caller -- threaded through, NOT hardcoded, so two records
   *  naming the default cannot be mistaken for proof of a double-fire from
   *  one path (see `question-trace.ts`'s own KNOWN LIMIT note). */
  remove(
    questionId: UUID,
    signal = 'unknown',
    toolName?: string,
    callSite = 'QuestionStore.remove',
  ): void {
    const existing = this.map.get(questionId);
    this.map.delete(questionId);
    this.notifyChanged();
    traceQuestionEvent({
      action: 'remove',
      sessionId: this.sessionId,
      questionId,
      promptId: existing?.promptId,
      agentId: existing?.agentId,
      isSubagent: existing?.agentId !== undefined,
      toolName,
      signal,
      callSite,
      throughFunnel: true,
    });
  }

  /** Drop all pending questions (e.g. on Claude session restart / `/clear`,
   *  `/resume`). `signal` (#808) is carried onto one trace record per
   *  cleared question. */
  clear(signal = 'unknown', callSite = 'QuestionStore.clear'): void {
    const cleared = [...this.map.values()];
    this.map.clear();
    this.notifyChanged();
    for (const q of cleared) {
      traceQuestionEvent({
        action: 'remove',
        sessionId: this.sessionId,
        questionId: q.id,
        promptId: q.promptId,
        agentId: q.agentId,
        isSubagent: q.agentId !== undefined,
        signal,
        callSite,
        throughFunnel: true,
      });
    }
  }

  /** Look up a pending question by id (null if not awaitable). */
  get(questionId: UUID): Question | null {
    return this.map.get(questionId) ?? null;
  }

  private notifyChanged(): void {
    this.events.onQuestionsChanged?.([...this.map.values()]);
  }
}
