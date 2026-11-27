/**
 * Chat acceptance (#1818): tell the sender that Claude Code submitted the chat
 * message it sent.
 *
 * The daemon types a `user_input` into Claude's terminal (text, then a separate
 * Enter) and, until now, never learned whether Claude took that particular
 * message, so a native client could say only "handed to the connection". Claude
 * Code reports submitted prompts through an admitted main-agent
 * `UserPromptSubmit` hook or a human queued-command transcript attachment. The
 * tracker joins either signal to the oldest pending exact-text entry and sends
 * the result only to its originating connection. Exact text does not identify
 * the original submission: if Claude did not take the daemon input, an
 * identical prompt later typed at the terminal can confirm that pending entry
 * through either signal, although that text did reach Claude (#1838).
 *
 * The match is exact string equality, with no normalization: the writer
 * (`PTYSession.submitInput`) types the text as given and then a CR, so there is
 * nothing to undo, and a prompt that differs in any character is not this
 * message. The one thing that cannot be exact is what the terminal does with a
 * control character in the text (a CR submits early, an Escape starts a key
 * sequence), so a text with any control character other than a newline is not
 * tracked at all ({@link isTrackableChat}). A message the daemon cannot match
 * stays unconfirmed; nothing is guessed.
 *
 * This is a positive signal only. An entry that nothing matches expires without
 * a word (the client keeps its own deadline), the list per session is bounded,
 * and a terminal-typed prompt with no pending entry changes nothing.
 *
 * `promptSubmitted` runs inside the hook listener, synchronously before Claude's
 * hook response, so it only walks a short array and sends one small frame.
 */

import { type UUID, createUserInputResult } from '@remi/shared';

import { log } from '../logger.ts';
import type { SendToConnection } from './trivial-events.ts';

/**
 * How long a typed message may wait for its hook before the daemon forgets it.
 * Claude queues a message typed while it is working and submits it when the turn
 * allows, so this is generous; the client's own wait is much shorter and a late
 * result still clears its warning.
 */
export const CHAT_ACCEPTANCE_TTL_MS = 10 * 60_000;

/** The most typed messages one session waits on; the oldest is dropped, silently, past it. */
export const CHAT_ACCEPTANCE_MAX_PENDING = 16;

/**
 * Whether the daemon can define exact equality for this chat text. Empty or blank
 * text is not a prompt. A control character other than a newline is interpreted by
 * the terminal (CR submits, ESC begins a key sequence, Tab completes), so what
 * Claude ends up submitting is not the text; such a message is left unconfirmed.
 */
export function isTrackableChat(content: string): boolean {
  if (content.trim() === '') return false;
  return !/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u.test(content);
}

interface PendingChat {
  readonly messageId: UUID;
  readonly content: string;
  readonly connectionId: UUID;
  readonly deadline: number;
  readonly sentAt: number;
}

export interface ChatAcceptanceOptions {
  readonly send: SendToConnection;
  /**
   * Whether this connection said it understands `user_input_result` (its
   * `hello_ack` listed `chat_acceptance`). Absent reads as yes.
   */
  readonly canReceive?: (connectionId: UUID) => boolean;
  readonly ttlMs?: number;
  readonly maxPending?: number;
  /** A clock, in milliseconds. */
  readonly now?: () => number;
}

export class ChatAcceptanceTracker {
  private readonly pending = new Map<UUID, PendingChat[]>();
  private readonly signals = new Map<
    UUID,
    Array<{ text: string; kind: 'hook' | 'attachment'; time: number }>
  >();
  private readonly seenAttachments = new Map<UUID, Map<string, number>>();
  private readonly send: SendToConnection;
  private readonly canReceive: (connectionId: UUID) => boolean;
  private readonly ttlMs: number;
  private readonly maxPending: number;
  private readonly now: () => number;

  constructor(options: ChatAcceptanceOptions) {
    this.send = options.send;
    this.canReceive = options.canReceive ?? (() => true);
    this.ttlMs = options.ttlMs ?? CHAT_ACCEPTANCE_TTL_MS;
    this.maxPending = options.maxPending ?? CHAT_ACCEPTANCE_MAX_PENDING;
    this.now = options.now ?? Date.now;
  }

  sentTime(): number {
    return this.now();
  }

  /**
   * Remember a message after its text and Enter were typed. `sentAt` is taken
   * immediately before the text write, so a later signal can confirm it.
   * Returns whether it is tracked.
   */
  record(
    sessionId: UUID,
    messageId: UUID,
    content: string,
    connectionId: UUID,
    sentAt: number,
  ): boolean {
    if (!isTrackableChat(content) || !this.canReceive(connectionId)) return false;
    const now = this.now();
    const list = this.live(sessionId, now);
    list.push({ messageId, content, connectionId, sentAt, deadline: now + this.ttlMs });
    while (list.length > this.maxPending) list.shift();
    this.pending.set(sessionId, list);
    return true;
  }

  /**
   * An admitted main-agent prompt reached Claude. Resolves the oldest unexpired
   * entry whose text equals it and tells that entry's connection. Returns whether
   * one matched.
   */
  promptSubmitted(sessionId: UUID, prompt: string): boolean {
    return this.accept(sessionId, prompt, 'hook');
  }

  queuedCommand(sessionId: UUID, prompt: string, timestamp: unknown, uuid: string): boolean {
    if (
      typeof timestamp !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(timestamp)
    )
      return false;
    const queuedAt = Date.parse(timestamp);
    if (!Number.isFinite(queuedAt) || !uuid) return false;
    return this.accept(sessionId, prompt, 'attachment', queuedAt, uuid);
  }

  private accept(
    sessionId: UUID,
    prompt: string,
    kind: 'hook' | 'attachment',
    queuedAt?: number,
    uuid?: string,
  ): boolean {
    if (!this.pending.has(sessionId)) return false;
    const now = this.now();
    const recent = (this.signals.get(sessionId) ?? []).filter(
      (signal) => now - signal.time < 10_000 && now >= signal.time,
    );
    this.signals.set(sessionId, recent);
    if (recent.some((signal) => signal.text === prompt && signal.kind !== kind)) return false;
    const seen = this.seenAttachments.get(sessionId) ?? new Map<string, number>();
    for (const [id, expiry] of seen) if (expiry <= now) seen.delete(id);
    this.seenAttachments.set(sessionId, seen);
    if (uuid && (seen.has(uuid) || seen.size >= 1024)) return false;
    // If the correlation buffer is full, uncertainty is safer than a false acceptance.
    if (recent.length >= 1024) return false;
    const live = this.live(sessionId, now);
    const index = live.findIndex(
      (entry) =>
        entry.content === prompt &&
        (kind === 'hook' || (queuedAt !== undefined && queuedAt >= entry.sentAt)),
    );
    if (index < 0) return false;
    const [entry] = live.splice(index, 1);
    recent.push({ text: prompt, kind, time: now });
    if (uuid) seen.set(uuid, now + this.ttlMs);
    if (live.length === 0) this.pending.delete(sessionId);
    if (!entry) return false;
    try {
      this.send(entry.connectionId, createUserInputResult(sessionId, entry.messageId, 'accepted'));
    } catch (error) {
      // The sender is gone or its socket is closing; the result is only a convenience.
      log(
        `[ChatAcceptance] result for session ${sessionId.slice(0, 8)} not sent: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return true;
  }

  /** Drop everything a session waits on (it ended). */
  forget(sessionId: UUID): void {
    this.pending.delete(sessionId);
    this.signals.delete(sessionId);
    this.seenAttachments.delete(sessionId);
  }

  /**
   * The session's list with expired entries dropped (the stored array when any
   * remain). A caller that adds to it stores it again.
   */
  private live(sessionId: UUID, now: number): PendingChat[] {
    const stored = this.pending.get(sessionId) ?? [];
    const live = stored.filter((entry) => entry.deadline > now);
    if (live.length === 0) this.pending.delete(sessionId);
    else this.pending.set(sessionId, live);
    return live;
  }
}
