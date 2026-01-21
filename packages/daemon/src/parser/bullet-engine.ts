/**
 * BulletEngine - Extracts and tracks bullets from message content.
 *
 * Features:
 * - Detects bullets starting with -, *, bullet chars, or numbers (1., 2., etc.)
 * - Handles multi-line bullets (including code blocks)
 * - Maintains session-scoped sequential IDs
 * - Supports /resume by accepting initial bullet count
 * - Optional truncation of long bullets with on-demand expansion
 */

import type { Bullet, BulletType, Message, StructuredMessage, UUID } from '@remi/shared';
import type { BulletContentRegistry } from '../api/bullet-content-registry.ts';

/** Default max chars per bullet before truncation (0 = disabled) */
export const DEFAULT_MAX_BULLET_LENGTH = 0; // Disabled by default

/** Truncation suffix added to truncated content */
export const TRUNCATION_SUFFIX = '\n...';

/** Result of matching a bullet start pattern */
interface BulletMatch {
  type: BulletType;
  content: string;
  originalNumber?: string;
}

/** BulletEngine configuration */
export interface BulletEngineConfig {
  /** Max chars per bullet before truncation (0 = disabled) */
  readonly maxBulletLength?: number;
}

/**
 * BulletEngine extracts bullet points from message content and assigns
 * session-scoped sequential IDs for tracking across edits.
 */
export class BulletEngine {
  private nextBulletId: number;
  private readonly sessionId: UUID;
  private readonly maxBulletLength: number;

  constructor(sessionId: UUID, initialBulletId = 1, config?: BulletEngineConfig) {
    this.sessionId = sessionId;
    this.nextBulletId = initialBulletId;
    this.maxBulletLength = config?.maxBulletLength ?? DEFAULT_MAX_BULLET_LENGTH;
  }

  /** Get current bullet count (next ID - 1) */
  get bulletCount(): number {
    return this.nextBulletId - 1;
  }

  /** Get the next bullet ID that will be assigned */
  get nextId(): number {
    return this.nextBulletId;
  }

  /** Reset bullet counter (for new session) */
  reset(): void {
    this.nextBulletId = 1;
  }

  /** Set initial bullet ID (for /resume with history) */
  setInitialId(id: number): void {
    this.nextBulletId = id;
  }

  /**
   * Parse content and extract bullets with sequential IDs.
   *
   * @param content - Raw message content
   * @param contentRegistry - Optional registry to store full content for truncated bullets
   * @returns Array of Bullet objects with assigned IDs
   */
  extractBullets(content: string, contentRegistry?: BulletContentRegistry): Bullet[] {
    const lines = content.split('\n');
    const bullets: Bullet[] = [];

    let i = 0;
    while (i < lines.length) {
      const line = lines[i] ?? '';
      const bulletMatch = this.matchBulletStart(line);

      if (bulletMatch !== null) {
        // Found a bullet start
        const bulletLines: string[] = [line];
        const startLine = i;
        let hasCodeBlock = this.hasCodeBlockMarker(bulletMatch.content);
        let inCodeBlock = hasCodeBlock && !this.isCodeBlockClosed(bulletMatch.content);

        // Continue collecting lines for this bullet
        i++;
        while (i < lines.length) {
          const nextLine = lines[i] ?? '';

          // Check if next line is a new bullet (only if not in code block)
          if (!inCodeBlock && this.matchBulletStart(nextLine) !== null) {
            break;
          }

          // Track code block state
          if (this.hasCodeBlockMarker(nextLine)) {
            hasCodeBlock = true;
            // Toggle code block state for each ``` found
            const markers = nextLine.match(/```/g);
            if (markers !== null) {
              for (const _ of markers) {
                inCodeBlock = !inCodeBlock;
              }
            }
          }

          bulletLines.push(nextLine);
          i++;
        }

        // Build bullet content
        const fullContent = bulletLines.join('\n');
        const bulletId = this.nextBulletId++;

        // Apply truncation if configured and content exceeds limit
        let finalContent = fullContent;
        let isTruncated: boolean | undefined = undefined;
        let fullLength: number | undefined = undefined;

        if (this.maxBulletLength > 0 && fullContent.length > this.maxBulletLength) {
          // Store full content for later retrieval
          if (contentRegistry) {
            contentRegistry.store(bulletId, fullContent);
          }

          // Truncate intelligently
          finalContent = this.smartTruncate(fullContent, this.maxBulletLength);
          isTruncated = true;
          fullLength = fullContent.length;
        }

        // Create bullet with assigned ID
        bullets.push({
          bulletId,
          content: finalContent,
          type: bulletMatch.type,
          originalNumber: bulletMatch.originalNumber,
          startLine,
          endLine: startLine + bulletLines.length - 1,
          hasCodeBlock,
          isTruncated,
          fullLength,
        });
      } else {
        i++;
      }
    }

    return bullets;
  }

  /**
   * Truncate content at a sensible boundary (end of line, end of word).
   * Appends truncation suffix.
   */
  private smartTruncate(content: string, maxLength: number): string {
    if (content.length <= maxLength) return content;

    // Leave room for suffix
    const target = maxLength - TRUNCATION_SUFFIX.length;

    // Try to break at newline (if in the last 30%)
    const lastNewline = content.lastIndexOf('\n', target);
    if (lastNewline > target * 0.7) {
      return content.slice(0, lastNewline) + TRUNCATION_SUFFIX;
    }

    // Try to break at space
    const lastSpace = content.lastIndexOf(' ', target);
    if (lastSpace > target * 0.7) {
      return content.slice(0, lastSpace) + TRUNCATION_SUFFIX;
    }

    // Hard truncate
    return content.slice(0, target) + TRUNCATION_SUFFIX;
  }

  /**
   * Create a StructuredMessage from a Message.
   *
   * @param message - The message to structure
   * @param contentRegistry - Optional registry to store full content for truncated bullets
   */
  structureMessage(message: Message, contentRegistry?: BulletContentRegistry): StructuredMessage {
    const bullets = this.extractBullets(message.content, contentRegistry);

    return {
      ...message,
      bullets,
      firstBulletId: bullets.length > 0 ? bullets[0]?.bulletId : undefined,
      lastBulletId: bullets.length > 0 ? bullets[bullets.length - 1]?.bulletId : undefined,
    };
  }

  /**
   * Re-parse an updated message while preserving bullet ID sequence.
   * This handles message edits where some bullets may have changed.
   *
   * For simplicity, we re-extract bullets starting from where this message's
   * bullets began. This means if a message had bullets 5-10 and gets edited,
   * the new bullets will be 5-N where N depends on the new content.
   *
   * @param existing - The existing structured message
   * @param newContent - The new content
   * @param contentRegistry - Optional registry to store full content for truncated bullets
   */
  updateStructuredMessage(
    existing: StructuredMessage,
    newContent: string,
    contentRegistry?: BulletContentRegistry,
  ): StructuredMessage {
    // Save current state
    const savedNextId = this.nextBulletId;

    // Roll back to before this message's bullets
    if (existing.firstBulletId !== undefined) {
      this.nextBulletId = existing.firstBulletId;
    }

    // Re-extract bullets (they get new sequential IDs from where this message started)
    const bullets = this.extractBullets(newContent, contentRegistry);

    // If we ended up with fewer bullets than before, ensure we don't regress
    // the global counter below what other messages might expect
    if (existing.lastBulletId !== undefined && this.nextBulletId <= existing.lastBulletId) {
      // Keep the counter at least where it was
      this.nextBulletId = Math.max(this.nextBulletId, savedNextId);
    }

    return {
      ...existing,
      content: newContent,
      bullets,
      firstBulletId: bullets.length > 0 ? bullets[0]?.bulletId : undefined,
      lastBulletId: bullets.length > 0 ? bullets[bullets.length - 1]?.bulletId : undefined,
    };
  }

  /**
   * Count bullets in content without assigning IDs.
   * Useful for /resume to count history bullets.
   */
  static countBullets(content: string): number {
    // Create a temporary engine just for counting
    const tempEngine = new BulletEngine('temp' as UUID, 1);
    const bullets = tempEngine.extractBullets(content);
    return bullets.length;
  }

  /**
   * Match the start of a bullet line.
   * Returns null if line doesn't start a bullet.
   */
  private matchBulletStart(line: string): BulletMatch | null {
    const trimmed = line.trimStart();

    // Dash bullet: - text
    if (/^-\s+/.test(trimmed)) {
      return { type: 'dash', content: trimmed.replace(/^-\s+/, '') };
    }

    // Asterisk bullet: * text (but not ** for bold)
    if (/^\*\s+/.test(trimmed) && !/^\*\*/.test(trimmed)) {
      return { type: 'asterisk', content: trimmed.replace(/^\*\s+/, '') };
    }

    // Unicode bullet: - - - text
    if (/^[•●◦◆]\s+/.test(trimmed)) {
      return { type: 'bullet', content: trimmed.replace(/^[•●◦◆]\s+/, '') };
    }

    // Numbered: 1. text, 2) text, etc.
    const numberedMatch = trimmed.match(/^(\d+)[.)]\s+(.*)/);
    if (numberedMatch !== null && numberedMatch[1] !== undefined) {
      return {
        type: 'numbered',
        content: numberedMatch[2] ?? '',
        originalNumber: numberedMatch[1],
      };
    }

    return null;
  }

  /** Check if line contains a code block marker */
  private hasCodeBlockMarker(text: string): boolean {
    return text.includes('```');
  }

  /** Check if code blocks in text are balanced (all opened are closed) */
  private isCodeBlockClosed(text: string): boolean {
    const matches = text.match(/```/g);
    return matches === null || matches.length % 2 === 0;
  }
}
