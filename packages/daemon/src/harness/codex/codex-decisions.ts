/**
 * The decision channel of a Codex session (epic #1175, phase 4 #1178): the
 * server requests of the shared app-server as phone cards, and the phone's
 * answer sent back as the request's result.
 *
 * remi RELAYS the approval; Codex decides (ADR 0030). remi holds nothing: Codex
 * keeps the request pending and its TUI keeps the overlay up, the card is a
 * second place to answer, and the FIRST answer wins (spike: both subscribers get
 * `serverRequest/resolved`, a late answer is ignored without an error frame).
 * Nothing is typed into the PTY for an answer. The answer and Cancel handlers
 * type only when `answerHeld` says `unknown`, so it never does, for any id (a
 * card this session never showed reads `closed`), and there is no `screen` to
 * read for the guards that would let a typed answer through.
 *
 * What a card may do, from the strictest rule up:
 * - A request that is not about this session's thread is never a card and never
 *   answered. The session passes `threadRole`, from the tracker; request ids are
 *   one daemon-global counter, so a request is named by `(threadId, requestId)`.
 *   The role is read again at the answer, so a thread that stopped being the
 *   session's (a rotation) cannot be answered through a card that outlived it.
 * - Only a plain command approval of the main thread is actionable
 *   (`approval-cards.ts`). A `terminalOnly` card takes no answer; Cancel only
 *   clears it from the phone and sends nothing, so the TUI's overlay stays.
 * - The client is only ever asked to `respond` with a result of the card's own
 *   option; an error response is not even expressible (ADR 0033 decision 4).
 *   Every refusal and every failure on this path fails CLOSED: the card stays or
 *   is cleared, and nothing is sent.
 *
 * A card's life:
 * - `live`: the request is pending and the phone may answer.
 * - `answered`: remi sent its answer; the card is already gone (the answer
 *   handler removed it), and the entry stays until `serverRequest/resolved` so a
 *   second answer cannot be sent.
 * - `retired`: the link dropped. A card the phone cannot answer must not stay
 *   answerable, so every card is unanswerable at once, but it stays on the phone
 *   until the replay says whether the request is still pending: the app-server
 *   replays a pending request to a client that attaches (spike: same id, 4 ms), and
 *   the replayed request makes a NEW card (a new id; the retired one is dismissed in
 *   its place). What no replay re-delivered within the window after the re-attach
 *   was resolved while the link was down, and is dismissed then. A link that never
 *   comes back dismisses them after a grace period, so no dead card outlives it.
 *   A retired card answered at the phone only clears: nothing is sent.
 * That a dropped subscriber does not cancel its pending requests was verified live
 * (Codex 0.160.0, 2026-10-04; plan R1, LV-3 (d)): the prompt stays up and the same
 * request is replayed.
 *
 * The TUI's answer, an Esc, `turn/interrupt` and an RPC `cancel` each resolve a
 * request; the only signal handled for all of them is `serverRequest/resolved`
 * (verified live for each of them), so no status-based dismissal is needed. A
 * card whose resolution Codex never reported would stay until the link drops,
 * `remi unstick` or the session ends.
 */

import { escapeUnsafeText, generateId } from '@remi/shared';
import type { Question, UUID } from '@remi/shared';

import type { SessionRegistry } from '../../session/session-registry.ts';
import type { HeldAnswer, HeldAnswerOutcome } from '../decision.ts';
import type { DecisionChannel } from '../types.ts';
import type { AppServerClient } from './app-server-client.ts';
import type { RequestId } from './app-server-protocol.ts';
import {
  type PendingRequestSpec,
  buildApprovalCard,
  isApprovalMethod,
  requestKey,
  requestThreadId,
  responseFor,
} from './approval-cards.ts';
import { shortThreadId } from './thread-id.ts';

export type ThreadRole = 'main' | 'subagent';

/**
 * The clock the channel's timers run on. Production uses {@link realScheduler}; a test hands in one
 * that fires only what it chooses, so what is set and cleared is observable and nothing sleeps.
 */
export interface Scheduler {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** `setTimeout`, unref'd: a pending sweep or confirmation never keeps the daemon's event loop alive. */
export const realScheduler: Scheduler = {
  set: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout> | undefined),
};

export interface CodexDecisionsDeps {
  /** The remi session whose cards these are (the registry's id). */
  sessionId: UUID;
  /** The session's working directory, as `realpath` resolves it: a command that runs elsewhere says where on its card. */
  sessionDirectory: string;
  client: Pick<AppServerClient, 'respond'>;
  sessionRegistry: Pick<SessionRegistry, 'removeQuestion'>;
  /** Show a card: `messageApi.handleQuestion(q, { held: true })`, which stamps `held`. */
  present: (q: Question) => void;
  onQuestionResolved: (sid: UUID, qid: UUID, reason: 'answered' | 'cancelled') => void;
  /** The tracker's `role`: is this thread the session's, or a subagent's, or neither? */
  threadRole: (threadId: string) => ThreadRole | null;
  log: (message: string) => void;
  /** Tell the person something as a system message (an answer Codex never confirmed, one that could not be sent). */
  notice: (message: string) => void;
  /** Test seams: how long after a re-attach a request that was not replayed is dismissed (3000 ms) and how long a link may stay down before its retired cards are (30 000 ms), how long a delivered answer waits for Codex to confirm it (10 000 ms), and the clock. */
  replayWindowMs?: number;
  disconnectGraceMs?: number;
  confirmMs?: number;
  scheduler?: Scheduler;
}

type EntryState = 'live' | 'answered' | 'retired';

interface Entry {
  spec: PendingRequestSpec;
  state: EntryState;
  /** Set while an `answered` entry waits for Codex's `serverRequest/resolved`. */
  confirmTimer?: unknown;
}

/**
 * How long after a re-attach a request that was not replayed is dismissed. The replay took 4 ms in
 * the spike (`expB3.jsonl:49-51`); a slow one would flicker (a card dismissed, then made again,
 * with a second push), so the window is generous: 3 s.
 */
const REPLAY_WINDOW_MS = 3000;
const DISCONNECT_GRACE_MS = 30_000;
/**
 * A delivered answer is a frame written to a socket, not Codex's decision: if Codex rejects it or
 * never reports `serverRequest/resolved`, the phone has said "answered", the card is gone and the
 * overlay is still up. This long after the answer, the person is told to check the terminal.
 */
const CONFIRM_MS = 10_000;
const UNCONFIRMED_NOTICE = 'Codex has not confirmed the answer; check the terminal';
const UNSENT_NOTICE =
  'remi could not deliver that answer to Codex; try again from the new card if one appears, or answer in the terminal';
/** More requests than this at once is not Codex asking: the oldest are dismissed, never answered. */
const MAX_TRACKED = 64;

const short = shortThreadId;
/** A request id, for a log line: cut, and escaped, because a string id is chosen by the server. */
const logId = (id: RequestId): string => escapeUnsafeText(String(id).slice(0, 24));

export class CodexDecisions implements DecisionChannel {
  private readonly byKey = new Map<string, Entry>();
  private readonly byId = new Map<UUID, Entry>();
  private sweepTimer: unknown;
  private disposed = false;

  constructor(private readonly deps: CodexDecisionsDeps) {}

  /** A server request arrived: a card if it is a request this session may show, else nothing, and never an answer. */
  handleServerRequest(req: { id: RequestId; method: string; params: unknown }): void {
    if (this.disposed) return;
    if (!isApprovalMethod(req.method)) {
      this.deps.log(
        `ignored a ${escapeUnsafeText(JSON.stringify(req.method.slice(0, 64)))} request`,
      );
      return;
    }
    const threadId = requestThreadId(req.params);
    const role = threadId === null ? null : this.deps.threadRole(threadId);
    if (threadId === null || role === null) {
      this.deps.log(`ignored request ${logId(req.id)}: it is not about this session's thread`);
      return;
    }
    const spec = buildApprovalCard(req, generateId, {
      sessionDirectory: this.deps.sessionDirectory,
      ...(role === 'subagent' ? { agentId: threadId } : {}),
    });
    if (spec === null) {
      this.deps.log(`ignored request ${logId(req.id)}: no card for it`);
      return;
    }
    const existing = this.byKey.get(spec.key);
    // The same request delivered again while its card is live is not a new card.
    if (existing?.state === 'live') return;
    // A retired card is dismissed in favor of the replayed one; an answered one has no card left.
    if (existing !== undefined) this.forget(existing, existing.state === 'retired', 'replaced');

    const entry: Entry = { spec, state: 'live' };
    this.track(entry);
    try {
      this.deps.present(spec.question);
    } catch (error) {
      this.forget(entry, false, 'not shown');
      this.deps.log(
        `could not show the card (${error instanceof Error ? error.name : typeof error})`,
      );
      return;
    }
    this.deps.log(
      `request ${logId(req.id)} on ${short(threadId)}: ${spec.actionable ? 'card' : 'terminal-only card'}${role === 'subagent' ? ' (subagent)' : ''}`,
    );
  }

  /** `serverRequest/resolved`: the request was answered (by remi or by the TUI), so its card is done. */
  handleResolved(p: { threadId: string; requestId: RequestId }): void {
    if (this.disposed) return;
    const entry = this.byKey.get(requestKey(p.threadId, p.requestId));
    if (entry === undefined) return;
    // Our own answer already removed its card; anyone else's answer dismisses it, for every client.
    this.forget(entry, entry.state !== 'answered', 'codex:resolved');
  }

  /** The link dropped: no card can be answered now, and none is dismissed until the replay says. */
  handleDisconnected(): void {
    if (this.disposed) return;
    let retired = 0;
    for (const entry of [...this.byId.values()]) {
      if (entry.state === 'answered') this.forget(entry, false, 'link lost');
      else {
        entry.state = 'retired';
        retired += 1;
      }
    }
    if (retired === 0) return;
    this.deps.log(`link lost: ${retired} card(s) retired, waiting for a replay`);
    this.armSweep(this.deps.disconnectGraceMs ?? DISCONNECT_GRACE_MS);
  }

  /** The tracker attached again: a pending request is replayed now, so what is not by the end of the window was resolved. */
  handleReattached(): void {
    if (this.disposed) return;
    if ([...this.byId.values()].some((e) => e.state === 'retired')) {
      this.armSweep(this.deps.replayWindowMs ?? REPLAY_WINDOW_MS);
    }
  }

  /** The session ended: every card is dismissed and nothing is handled any more. */
  dispose(): void {
    if (this.disposed) return;
    this.forceRelease('the session ended');
    this.disposed = true;
  }

  answerHeld(questionId: UUID, answer: HeldAnswer): HeldAnswerOutcome {
    const entry = this.byId.get(questionId);
    // Never `unknown`, whatever the id: the handlers type into the PTY for `unknown`, and nothing
    // is typed for a Codex answer. A card this session never showed has no hold; it is closed.
    if (entry === undefined) return 'closed';
    if (entry.state !== 'live') {
      // A retired card is forgotten (the caller dismisses it, and the sweep must not again). An
      // answered one keeps its entry and its confirmation timer: a second client's X or a double
      // tap before `question_resolved` arrives reaches this point, and must not void the notice
      // that Codex never confirmed the first answer.
      if (entry.state === 'retired') this.forget(entry, false, 'closed');
      return 'closed';
    }
    const { spec } = entry;
    if (!spec.actionable) {
      // Cancel only clears the card; any other answer is refused and the card stays.
      if (answer.kind !== 'cancel') return 'refused';
      this.forget(entry, false, 'cancelled');
      return 'closed';
    }
    if (this.deps.threadRole(spec.threadId) !== 'main') {
      this.deps.log(
        `not answering ${logId(spec.requestId)}: its thread is no longer this session's`,
      );
      this.forget(entry, false, 'closed');
      return 'closed';
    }
    const mapped = responseFor(spec, answer);
    if (!mapped.ok) return 'refused';
    let sent = false;
    let encoded = true;
    try {
      sent = this.deps.client.respond(spec.requestId, mapped.result);
    } catch (error) {
      encoded = false;
      this.deps.log(
        `answer to ${logId(spec.requestId)} could not be encoded (${error instanceof Error ? error.name : typeof error})`,
      );
    }
    if (!sent) {
      // Two causes with one remedy for the person: a result that could not be encoded (a bug in
      // remi), or a link that did not take the frame (a socket that is not ready, or not yet seen
      // to be dead). The request may still be pending, and a replay may bring it back as a card.
      if (encoded) this.deps.log(`not answered ${logId(spec.requestId)}: the link did not take it`);
      this.forget(entry, false, 'closed');
      this.tell(UNSENT_NOTICE);
      return 'closed';
    }
    entry.state = 'answered';
    entry.confirmTimer = this.clock.set(
      () => this.unconfirmed(entry),
      this.deps.confirmMs ?? CONFIRM_MS,
    );
    this.deps.log(`answered ${logId(spec.requestId)} on ${short(spec.threadId)}`);
    return 'resolved';
  }

  retireQuestion(questionId: UUID): void {
    const entry = this.byId.get(questionId);
    if (entry !== undefined) this.forget(entry, false, 'retired');
  }

  isHeld(questionId: UUID): boolean {
    const entry = this.byId.get(questionId);
    return entry?.state === 'live' && entry.spec.actionable;
  }

  // The chat guard and Stop read these two, and neither can reach a Codex session: phone chat is
  // refused earlier (`acceptsTypedChat`) and a Stop force-closes (`gracefulExitInput` is null). A
  // typed chat path (phase 6) adds what it needs; nothing here pretends to know more.
  hasMainHold(): boolean {
    return false;
  }

  hasOpenHookPrompt(): boolean {
    return false;
  }

  /** The app-server's `serverRequest/resolved` is authoritative; an Escape sent through remi needs nothing here. */
  noteTerminalEscape(): void {}

  forceRelease(reason: string): { resolved: number } {
    this.clock.clear(this.sweepTimer);
    this.sweepTimer = undefined;
    let resolved = 0;
    for (const entry of [...this.byId.values()]) {
      const shown = entry.state !== 'answered';
      this.forget(entry, shown, 'codex:released');
      if (shown) resolved += 1;
    }
    if (resolved > 0) this.deps.log(`released ${resolved} card(s): ${reason}`);
    return { resolved };
  }

  private track(entry: Entry): void {
    this.byKey.set(entry.spec.key, entry);
    this.byId.set(entry.spec.question.id, entry);
    while (this.byId.size > MAX_TRACKED) {
      const oldest = this.byId.values().next().value;
      if (oldest === undefined) break;
      this.forget(oldest, oldest.state !== 'answered', 'codex:too-many');
    }
  }

  /** Stop tracking `entry`, and dismiss its card from every client when `dismiss` (else the caller already did, or there is none). */
  private forget(entry: Entry, dismiss: boolean, signal: string): void {
    if (entry.confirmTimer !== undefined) {
      this.clock.clear(entry.confirmTimer);
      entry.confirmTimer = undefined;
    }
    if (this.byKey.get(entry.spec.key) === entry) this.byKey.delete(entry.spec.key);
    if (this.byId.get(entry.spec.question.id) === entry) this.byId.delete(entry.spec.question.id);
    if (!dismiss) return;
    const { sessionId } = this.deps;
    const qid = entry.spec.question.id;
    try {
      this.deps.sessionRegistry.removeQuestion(sessionId, qid, signal);
    } catch (error) {
      this.deps.log(
        `could not remove a card (${error instanceof Error ? error.name : typeof error})`,
      );
    }
    try {
      this.deps.onQuestionResolved(sessionId, qid, 'cancelled');
    } catch (error) {
      this.deps.log(
        `could not tell the clients (${error instanceof Error ? error.name : typeof error})`,
      );
    }
  }

  private get clock(): Scheduler {
    return this.deps.scheduler ?? realScheduler;
  }

  /** Say something to the person; a failure to say it is logged, never thrown into the answer path. */
  private tell(message: string): void {
    try {
      this.deps.notice(message);
    } catch (error) {
      this.deps.log(
        `could not send a notice (${error instanceof Error ? error.name : typeof error})`,
      );
    }
  }

  /** The answer was delivered and Codex never said it was resolved. */
  private unconfirmed(entry: Entry): void {
    entry.confirmTimer = undefined;
    // `forget` clears this timer, so only a callback that was already running can find its entry
    // gone; and an entry with a timer is always `answered`, so being tracked is the whole check.
    if (this.byId.get(entry.spec.question.id) !== entry) return;
    this.deps.log(`no confirmation for the answer to ${logId(entry.spec.requestId)}`);
    this.forget(entry, false, 'unconfirmed');
    this.tell(UNCONFIRMED_NOTICE);
  }

  private armSweep(ms: number): void {
    this.clock.clear(this.sweepTimer);
    this.sweepTimer = this.clock.set(() => this.sweep(), ms);
  }

  /** Dismiss every retired card that nothing replaced. */
  private sweep(): void {
    this.sweepTimer = undefined;
    let swept = 0;
    for (const entry of [...this.byId.values()]) {
      if (entry.state !== 'retired') continue;
      this.forget(entry, true, 'codex:not-replayed');
      swept += 1;
    }
    if (swept > 0) this.deps.log(`${swept} retired card(s) were not replayed; dismissed`);
  }
}
