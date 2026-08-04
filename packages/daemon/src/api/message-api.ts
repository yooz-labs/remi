/**
 * MessageAPI - Bridge between OutputProcessor and adapters.
 *
 * Provides structured message events with bullet tracking.
 * Sits between the raw output parsing and the transport adapters.
 */

import type { AgentStatus, Message, Question, StructuredMessage, UUID } from '@remi/shared';
import { now } from '@remi/shared';
import { BulletEngine } from '../parser/bullet-engine.ts';
import { BulletContentRegistry } from './bullet-content-registry.ts';
import { QuestionDedup } from './question-dedup.ts';

/**
 * Outcome of a `handleQuestion` call (#888 criterion iii). Replaces a bare
 * `void` return -- and deliberately not a bare `boolean` either.
 *
 * Two silent-drop defects (#925, #926) both traced to the same root cause:
 * `handleQuestion` returned `void` and swallowed the outcome when
 * `QuestionDedup` suppressed the emission, so the caller had no way to tell
 * "the question is live" from "the question never registered" without
 * re-querying `SessionRegistry` after the fact. A `boolean` return would
 * fix the immediate defect but reopen a subtler one: `true` would have to
 * mean both "registered" (the ordinary case) and "held" (the load-bearing
 * #573 escalation that bypasses dedup entirely) -- collapsing two outcomes
 * that call sites must treat differently invites exactly the kind of
 * boolean-blindness bug this criterion exists to prevent. A discriminated
 * union instead names all three outcomes and lets a caller `switch` on
 * `status` with TypeScript exhaustiveness checking (a `default` branch
 * asserting `never`): adding a fourth outcome later breaks every such
 * switch at compile time instead of silently falling through one of them.
 *
 * Consumed directly by the two hand-rolled gates that used to re-query the
 * store instead of trusting this return value:
 *   - `QuestionPresenceTracker.pairAndPush`'s confirmed-delivery check (the
 *     deleted `isQuestionLive` dep), via the `PushQuestion` callback type.
 *   - `hook-bridge-setup.ts`'s `rememberElicitation`, via
 *     `HookEventBridge.handleElicitation`'s return.
 */
export type QuestionRegistrationOutcome =
  | { readonly status: 'registered' }
  | { readonly status: 'deduped' }
  | { readonly status: 'held' };

/** Events emitted by MessageAPI to adapters */
export interface MessageAPIEvents {
  /** New structured message created */
  onStructuredMessage: (message: StructuredMessage) => void;

  /** Existing message updated with new content and bullets */
  onStructuredMessageUpdate: (
    messageId: UUID,
    message: StructuredMessage,
    changedBulletIds: readonly number[],
  ) => void;

  /** Message finalized (no more edits expected) */
  onMessageFinalized: (messageId: UUID) => void;

  /** Question detected (pass-through from OutputProcessor). `opts.held` marks a
   *  load-bearing held-hook card that bypassed dedup (#603 Phase 3). */
  onQuestion: (question: Question, opts?: { held?: boolean }) => void;

  /** Status changed (pass-through from OutputProcessor) */
  onStatusChange: (status: AgentStatus, context?: string) => void;
}

/** Configuration for MessageAPI */
export interface MessageAPIConfig {
  /** Session ID */
  readonly sessionId: UUID;

  /** Initial bullet ID (for /resume with history) */
  readonly initialBulletId?: number;

  /** Max chars per bullet before truncation (0 = disabled) */
  readonly maxBulletLength?: number;
}

/**
 * MessageAPI provides structured message events with bullet tracking.
 *
 * Sits between OutputProcessor and adapters to:
 * 1. Add bullet structure to messages
 * 2. Track which bullets changed on updates
 * 3. Provide simpler API for chat adapters
 * 4. Store full content of truncated bullets for expansion
 */
export class MessageAPI {
  private readonly bulletEngine: BulletEngine;
  private readonly contentRegistry: BulletContentRegistry;
  private readonly events: Partial<MessageAPIEvents>;
  private readonly messages: Map<UUID, StructuredMessage> = new Map();
  private readonly sessionId: UUID;
  private readonly questionDedup = new QuestionDedup();

  constructor(config: MessageAPIConfig, events: Partial<MessageAPIEvents> = {}) {
    this.sessionId = config.sessionId;
    const engineConfig =
      config.maxBulletLength !== undefined ? { maxBulletLength: config.maxBulletLength } : {};
    this.bulletEngine = new BulletEngine(
      config.sessionId,
      config.initialBulletId ?? 1,
      engineConfig,
    );
    this.contentRegistry = new BulletContentRegistry();
    this.events = events;
  }

  /** Get bullet engine for direct access if needed */
  get engine(): BulletEngine {
    return this.bulletEngine;
  }

  /** Get current bullet count */
  get bulletCount(): number {
    return this.bulletEngine.bulletCount;
  }

  /** Get a message by ID */
  getMessage(messageId: UUID): StructuredMessage | undefined {
    return this.messages.get(messageId);
  }

  /** Get all messages */
  getAllMessages(): StructuredMessage[] {
    return Array.from(this.messages.values());
  }

  /**
   * Handle new message from OutputProcessor.
   * Structures the message and emits event.
   */
  handleMessage(message: Message): void {
    const structured = this.bulletEngine.structureMessage(message, this.contentRegistry);
    this.messages.set(message.id, structured);
    this.events.onStructuredMessage?.(structured);
  }

  /**
   * Handle message update from OutputProcessor.
   * Re-structures content and tracks which bullets changed.
   */
  handleMessageUpdate(messageId: UUID, content: string, tool?: string): void {
    const existing = this.messages.get(messageId);

    if (existing === undefined) {
      // Message not found - create as new
      const newMessage: Message = {
        id: messageId,
        sessionId: this.sessionId,
        sender: 'agent',
        content,
        createdAt: now(),
        state: 'sent',
        stateChangedAt: now(),
        isEditing: true,
        tool,
      };
      this.handleMessage(newMessage);
      return;
    }

    // Get old bullet IDs for comparison
    const oldBulletIds = new Set(existing.bullets.map((b) => b.bulletId));
    const oldBulletContent = new Map(existing.bullets.map((b) => [b.bulletId, b.content]));

    // Update the structured message
    const updated = this.bulletEngine.updateStructuredMessage(
      existing,
      content,
      this.contentRegistry,
    );
    const finalMessage: StructuredMessage = {
      ...updated,
      isEditing: true,
      tool,
    };

    this.messages.set(messageId, finalMessage);

    // Determine which bullets changed
    const changedBulletIds: number[] = [];

    for (const bullet of finalMessage.bullets) {
      if (!oldBulletIds.has(bullet.bulletId)) {
        // New bullet
        changedBulletIds.push(bullet.bulletId);
      } else {
        // Check if content changed
        const oldContent = oldBulletContent.get(bullet.bulletId);
        if (oldContent !== bullet.content) {
          changedBulletIds.push(bullet.bulletId);
        }
      }
    }

    this.events.onStructuredMessageUpdate?.(messageId, finalMessage, changedBulletIds);
  }

  /**
   * Finalize a message (mark as no longer editing).
   */
  finalizeMessage(messageId: UUID): void {
    const existing = this.messages.get(messageId);
    if (existing !== undefined) {
      const finalized: StructuredMessage = {
        ...existing,
        isEditing: false,
      };
      this.messages.set(messageId, finalized);
      this.events.onMessageFinalized?.(messageId);
    }
  }

  /**
   * Process history content (from /resume) to set initial bullet count.
   * Call this before processing new messages after a resume.
   */
  processHistoryContent(historyContent: string): number {
    const bulletCount = BulletEngine.countBullets(historyContent);
    this.bulletEngine.setInitialId(bulletCount + 1);
    return bulletCount;
  }

  /**
   * Get full content for a truncated bullet.
   * Returns null if bullet was not truncated or content has expired.
   */
  getFullBulletContent(bulletId: number): string | null {
    return this.contentRegistry.get(bulletId);
  }

  /**
   * Reset state (for new session).
   */
  reset(): void {
    this.bulletEngine.reset();
    this.messages.clear();
    this.contentRegistry.clear();
    this.questionDedup.reset();
  }

  /**
   * Emit a question, deduping against recent emissions. See QuestionDedup
   * for upgrade rules. Returns the registration outcome (#888 criterion
   * iii) instead of silently discarding it -- see `QuestionRegistrationOutcome`
   * for why callers must not be left to guess.
   */
  handleQuestion(question: Question, opts?: { held?: boolean }): QuestionRegistrationOutcome {
    // A HELD escalation (Model B, #573) bypasses the content-dedup: its card is
    // load-bearing — it registers the question that makes the held hook
    // answerable — not a PTY/hook echo. Deduping it away would leave the hook
    // held with no answerable question until it fails open (#603 Phase 3, R7).
    // Its outcome is reported as its own distinct 'held' status, not folded
    // into 'registered': a held push never passes through the dedup gate
    // below, so conflating the two would misrepresent what actually happened.
    if (opts?.held) {
      this.events.onQuestion?.(question, opts);
      return { status: 'held' };
    }
    if (!this.questionDedup.shouldEmit(question)) return { status: 'deduped' };
    this.events.onQuestion?.(question);
    return { status: 'registered' };
  }

  handleStatusChange(status: AgentStatus, context?: string): void {
    // Question dedup baseline is meaningful only while the user is being
    // prompted. Once status leaves 'waiting' (idle/thinking/executing) the
    // current question is either answered or stale, so the next emission
    // should be evaluated fresh — otherwise the next session's first prompt
    // can collide with the prior session's answered prompt within the window.
    if (status !== 'waiting') {
      this.questionDedup.reset();
    }
    this.events.onStatusChange?.(status, context);
  }
}
