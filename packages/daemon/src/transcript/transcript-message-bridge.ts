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

import type { Message, TranscriptContentBlock, TranscriptContentMessage, UUID } from '@remi/shared';
import { createTranscriptContent, generateId, now } from '@remi/shared';
import type { MessageAPI } from '../api/message-api.ts';
import type { AssistantEntry, ContentBlock, UserEntry } from './types.ts';
import { isWrappedNonHumanText } from './user-entry-provenance.ts';

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
  /** Tracks the transcript file's own session ID to detect session boundaries */
  private transcriptSessionId: string | null = null;

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
    // Track the transcript's session ID. When it changes, a new Claude Code
    // session started. Switch to the new session (prefer latest, not first).
    if (entry.sessionId && entry.sessionId !== this.transcriptSessionId) {
      this.transcriptSessionId = entry.sessionId;
    }

    const textContent = this.extractTextContent(entry.message.content);
    const tools = this.extractToolNames(entry.message.content);
    const hadThinking = this.hasThinkingBlocks(entry.message.content);

    // Skip entries with no text AND no tool blocks (thinking-only entries)
    const visibleBlocks = entry.message.content.filter(
      (b: ContentBlock) => b.type === 'text' || b.type === 'tool_use' || b.type === 'tool_result',
    );
    if (!textContent && visibleBlocks.length === 0) {
      this.processedEntryUuids.add(entry.uuid);
      return;
    }

    // For tool-only entries (no text), generate a descriptive placeholder
    const displayContent = textContent || (tools.length > 0 ? `Used ${tools.join(', ')}` : '');

    // Create a Message for the MessageAPI to structure with bullets
    const message: Message = {
      id: generateId(),
      sessionId: this.sessionId,
      sender: 'agent',
      content: displayContent,
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

    // Convert raw content blocks for client rendering
    const contentBlocks = this.toContentBlocks(entry.message.content);

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
        contentBlocks,
      },
    );

    this.events.onTranscriptContent?.(transcriptMessage);
  }

  /**
   * Handle a user entry from TranscriptWatcher.
   * Emits a TranscriptContentMessage for user messages.
   *
   * Provenance filtering (#936): Claude Code stamps `isMeta: true` at the
   * entry's top level on "user"-role entries IT injected rather than
   * something the human typed — most consequentially a subagent's own
   * `<agent-message from="...">` text in an agent-team session, which
   * otherwise renders in the chat view as a message the human sent (measured
   * across real transcripts: 47 of 88 `isMeta: true` entries were exactly
   * this shape — see `user-entry-provenance.ts`'s module doc for the full
   * breakdown). This mirrors that module's design (also used by
   * `auto-approve/authority.ts`'s `extractUserEntryText`): `isMeta` is
   * checked FIRST and unconditionally, before any content-shape logic, then
   * the residual `isWrappedNonHumanText` denylist catches the cohort
   * (`<command-name>`, `<local-command-stdout>`) that is NOT stamped
   * `isMeta` at all. `isWrappedNonHumanText` is imported from
   * `user-entry-provenance.ts` rather than redefined here so all call sites
   * can never drift into different denylists.
   *
   * SKIP, not tag: an excluded entry is dropped outright (marked processed,
   * no message emitted) rather than shipped with a provenance flag for
   * clients to render specially. This matches what the web client already
   * does for the six pre-existing wrapper tags — `stripProtocolTags` removes
   * tag and content, and the caller (`App.tsx`) drops the message entirely
   * when nothing is left — so there is no "render it differently" case being
   * lost: a rendered bubble was never the intended outcome for this cohort.
   * Filtering here also fixes every client at once (macOS, iOS, web), not
   * just the one that happens to run `stripProtocolTags`.
   */
  handleUserEntry(entry: UserEntry): void {
    if (this.processedEntryUuids.has(entry.uuid)) {
      return; // Already processed
    }
    // Track the transcript's session ID (switch to latest on change).
    if (entry.sessionId && entry.sessionId !== this.transcriptSessionId) {
      this.transcriptSessionId = entry.sessionId;
    }

    // Primary defense: see doc comment above.
    if (entry.isMeta === true) {
      this.processedEntryUuids.add(entry.uuid);
      return;
    }

    const rawContent = entry.message.content;
    const content =
      typeof rawContent === 'string'
        ? rawContent
        : this.extractTextContent(rawContent as readonly ContentBlock[]);

    // Skip user entries with no text content (tool_result entries)
    if (!content) {
      this.processedEntryUuids.add(entry.uuid);
      return;
    }

    // Residual defense for the non-isMeta wrapper cohort; see doc above.
    if (typeof rawContent === 'string' && isWrappedNonHumanText(rawContent)) {
      this.processedEntryUuids.add(entry.uuid);
      return;
    }

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
   * Convert raw content blocks to protocol format for the web client.
   * Includes text, tool_use, and tool_result blocks. Skips thinking blocks.
   * Truncates tool output to prevent oversized messages.
   */
  private toContentBlocks(blocks: readonly ContentBlock[]): TranscriptContentBlock[] {
    const MAX_TOOL_OUTPUT = 500;
    return blocks
      .filter((b) => b.type !== 'thinking')
      .map((block): TranscriptContentBlock | null => {
        if (block.type === 'text') {
          return { type: 'text', text: block.text };
        }
        if (block.type === 'tool_use') {
          return {
            type: 'tool_use',
            toolUseId: block.id,
            toolName: block.name,
            toolInput:
              typeof block.input === 'string'
                ? block.input.slice(0, MAX_TOOL_OUTPUT)
                : JSON.stringify(block.input).slice(0, MAX_TOOL_OUTPUT),
          };
        }
        if (block.type === 'tool_result') {
          const output =
            typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content
                    .filter((c) => c.type === 'text')
                    .map((c) => (c as { text: string }).text)
                    .join('\n')
                : '';
          return {
            type: 'tool_result',
            toolUseId: block.tool_use_id,
            ...(block.tool_name != null && { toolName: block.tool_name }),
            toolOutput: output.slice(0, MAX_TOOL_OUTPUT),
            ...(block.is_error != null && { isError: block.is_error }),
          };
        }
        return null;
      })
      .filter((b): b is TranscriptContentBlock => b !== null);
  }

  /**
   * Reset state (for session cleanup).
   */
  reset(): void {
    this.processedEntryUuids.clear();
    this.transcriptSessionId = null;
  }
}
