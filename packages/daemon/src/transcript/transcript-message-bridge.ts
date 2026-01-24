/**
 * TranscriptMessageBridge - Maps transcript entries to protocol messages.
 *
 * Sits between TranscriptWatcher and MessageAPI, converting clean
 * transcript entries into structured messages for client delivery.
 *
 * Part of the two-phase message delivery system:
 * - Phase 1 (PTY): Real-time status and question detection
 * - Phase 2 (Transcript): Clean content delivery via this bridge
 */

import type {
  Message,
  StructuredMessage,
  TranscriptContentMessage,
  UUID,
} from '@remi/shared';
import { createTranscriptContent, generateId, now } from '@remi/shared';
import type { MessageAPI } from '../api/message-api.ts';
import type { AssistantEntry, ContentBlock, UserEntry } from './types.ts';

/** Configuration for TranscriptMessageBridge */
export interface TranscriptMessageBridgeConfig {
  readonly sessionId: UUID;
}

/** Events emitted by TranscriptMessageBridge */
export interface TranscriptMessageBridgeEvents {
  /** New transcript content ready to send to client */
  onTranscriptContent: (message: TranscriptContentMessage) => void;
}

/**
 * Maps TranscriptWatcher events to TranscriptContentMessage protocol messages.
 *
 * Deduplicates entries by UUID to prevent re-processing on overlapping reads.
 * Extracts clean text content, tool names, and metadata from entries.
 */
export class TranscriptMessageBridge {
  private readonly sessionId: UUID;
  private readonly messageApi: MessageAPI;
  private readonly events: Partial<TranscriptMessageBridgeEvents>;
  private readonly processedEntryUuids: Set<string> = new Set();

  constructor(
    config: TranscriptMessageBridgeConfig,
    messageApi: MessageAPI,
    events: Partial<TranscriptMessageBridgeEvents> = {},
  ) {
    this.sessionId = config.sessionId;
    this.messageApi = messageApi;
    this.events = events;
  }

  /** Number of entries processed so far */
  get processedCount(): number {
    return this.processedEntryUuids.size;
  }

  /**
   * Handle an assistant entry from TranscriptWatcher.
   * Extracts text content, tool names, and emits a TranscriptContentMessage.
   */
  handleAssistantEntry(entry: AssistantEntry): void {
    if (this.processedEntryUuids.has(entry.uuid)) {
      return; // Already processed
    }

    const textContent = this.extractTextContent(entry.message.content);
    const tools = this.extractToolNames(entry.message.content);
    const hadThinking = this.hasThinkingBlocks(entry.message.content);

    // Skip entries with no meaningful content (pure tool invocations with no text)
    if (!textContent && tools.length === 0) {
      this.processedEntryUuids.add(entry.uuid);
      return;
    }

    // Create a Message for the MessageAPI to structure with bullets
    const message: Message = {
      id: generateId(),
      sessionId: this.sessionId,
      sender: 'agent',
      content: textContent,
      createdAt: entry.timestamp ?? now(),
      state: 'delivered',
      stateChangedAt: now(),
      isEditing: false,
    };

    // Structure the message (assigns bullet IDs)
    this.messageApi.handleMessage(message);
    const structured = this.messageApi.getMessage(message.id);
    if (!structured) return;

    // Only mark as processed after successful structuring
    this.processedEntryUuids.add(entry.uuid);

    // Emit the transcript content message
    const transcriptMessage = createTranscriptContent(
      this.sessionId,
      entry.uuid,
      'assistant',
      textContent,
      structured,
      false, // not an update
      {
        ...(tools.length > 0 && { tools }),
        ...(entry.message.model != null && { model: entry.message.model }),
        ...(hadThinking && { hadThinking }),
        ...(entry.message.usage != null && { usage: entry.message.usage }),
      },
    );

    this.events.onTranscriptContent?.(transcriptMessage);
  }

  /**
   * Handle a user entry from TranscriptWatcher.
   * Emits a TranscriptContentMessage for user messages.
   */
  handleUserEntry(entry: UserEntry): void {
    if (this.processedEntryUuids.has(entry.uuid)) {
      return; // Already processed
    }

    const content =
      typeof entry.message.content === 'string'
        ? entry.message.content
        : this.extractTextContent(entry.message.content as readonly ContentBlock[]);

    // Create a Message for the MessageAPI
    const message: Message = {
      id: generateId(),
      sessionId: this.sessionId,
      sender: 'user',
      content,
      createdAt: entry.timestamp ?? now(),
      state: 'delivered',
      stateChangedAt: now(),
      isEditing: false,
    };

    this.messageApi.handleMessage(message);
    const structured = this.messageApi.getMessage(message.id);
    if (!structured) return;

    // Only mark as processed after successful structuring
    this.processedEntryUuids.add(entry.uuid);

    const transcriptMessage = createTranscriptContent(
      this.sessionId,
      entry.uuid,
      'user',
      content,
      structured,
      false,
    );

    this.events.onTranscriptContent?.(transcriptMessage);
  }

  /**
   * Extract text content from content blocks.
   * Filters out thinking, tool_use, and tool_result blocks.
   */
  private extractTextContent(blocks: readonly ContentBlock[]): string {
    return blocks
      .filter((block): block is ContentBlock & { type: 'text' } => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
  }

  /**
   * Extract tool names from content blocks.
   */
  private extractToolNames(blocks: readonly ContentBlock[]): string[] {
    return blocks
      .filter((block): block is ContentBlock & { type: 'tool_use' } => block.type === 'tool_use')
      .map((block) => block.name);
  }

  /**
   * Check if any content blocks are thinking blocks.
   */
  private hasThinkingBlocks(blocks: readonly ContentBlock[]): boolean {
    return blocks.some((block) => block.type === 'thinking');
  }

  /**
   * Reset state (for session cleanup).
   */
  reset(): void {
    this.processedEntryUuids.clear();
  }
}
