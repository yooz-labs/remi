/**
 * TranscriptWatcher - Watches a Claude Code JSONL transcript file.
 *
 * Reads new entries as they're appended and emits events.
 * Treats the source file as READ-ONLY; never modifies it.
 *
 * Uses a combination of fs.watch (for immediate notification) and
 * polling (as a reliability fallback) to detect new entries.
 */

import * as fs from 'node:fs';
import type {
  AssistantEntry,
  SummaryEntry,
  TranscriptEntry,
  TranscriptWatcherConfig,
  TranscriptWatcherEvents,
  UserEntry,
} from './types.ts';

const DEFAULT_POLL_INTERVAL_MS = 2000;

export class TranscriptWatcher {
  private readonly config: Required<TranscriptWatcherConfig>;
  private readonly events: TranscriptWatcherEvents;

  /** Byte offset of last read position in the file */
  private fileOffset = 0;

  /** All parsed entries (our in-memory copy) */
  private readonly entries: TranscriptEntry[] = [];

  /** Map of entry UUID to index for fast lookup */
  private readonly entryIndex: Map<string, number> = new Map();

  /** File watcher handle */
  private watcher: fs.FSWatcher | null = null;

  /** Poll timer handle */
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  /** Whether the watcher is currently running */
  private running = false;

  constructor(config: TranscriptWatcherConfig, events: TranscriptWatcherEvents = {}) {
    this.config = {
      filePath: config.filePath,
      pollIntervalMs: config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      readExisting: config.readExisting ?? true,
    };
    this.events = events;
  }

  /** Whether the watcher is active */
  get isRunning(): boolean {
    return this.running;
  }

  /** Number of entries read so far */
  get entryCount(): number {
    return this.entries.length;
  }

  /** Get all entries */
  getEntries(): readonly TranscriptEntry[] {
    return this.entries;
  }

  /** Get entry by UUID */
  getEntry(uuid: string): TranscriptEntry | undefined {
    const index = this.entryIndex.get(uuid);
    if (index === undefined) return undefined;
    return this.entries[index];
  }

  /** Get all user messages */
  getUserMessages(): UserEntry[] {
    return this.entries.filter((e): e is UserEntry => e.type === 'user');
  }

  /** Get all assistant messages */
  getAssistantMessages(): AssistantEntry[] {
    return this.entries.filter((e): e is AssistantEntry => e.type === 'assistant');
  }

  /**
   * Extract clean text content from an assistant entry.
   * Filters out thinking blocks and tool use; returns only text blocks.
   */
  getAssistantText(entry: AssistantEntry): string {
    const textBlocks = entry.message.content.filter((b) => b.type === 'text');
    return textBlocks.map((b) => (b as { text: string }).text).join('\n');
  }

  /**
   * Get the model used for a given assistant entry.
   */
  getModel(entry: AssistantEntry): string | undefined {
    return entry.message.model;
  }

  /**
   * Start watching the transcript file.
   * If readExisting is true, reads all existing entries first.
   */
  async start(): Promise<void> {
    if (this.running) return;

    // Check if file exists
    if (!fs.existsSync(this.config.filePath)) {
      // File doesn't exist yet; wait for it
      this.waitForFile();
      return;
    }

    // Read existing entries if configured
    if (this.config.readExisting) {
      await this.readNewEntries();
    } else {
      // Skip to end of file
      const stat = fs.statSync(this.config.filePath);
      this.fileOffset = stat.size;
    }

    this.startWatching();
  }

  /**
   * Stop watching the transcript file.
   */
  stop(): void {
    this.running = false;

    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Wait for the transcript file to be created, then start watching.
   */
  private waitForFile(): void {
    this.running = true;
    const dir = this.config.filePath.substring(0, this.config.filePath.lastIndexOf('/'));

    // Watch the directory for the file to appear
    try {
      const dirWatcher = fs.watch(dir, (eventType, filename) => {
        if (filename && this.config.filePath.endsWith(filename)) {
          dirWatcher.close();
          if (this.running) {
            this.start();
          }
        }
      });

      // Also poll in case fs.watch misses it
      this.pollTimer = setInterval(() => {
        if (fs.existsSync(this.config.filePath)) {
          if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
          }
          dirWatcher.close();
          if (this.running) {
            this.start();
          }
        }
      }, this.config.pollIntervalMs);
    } catch {
      // If directory watching fails, fall back to polling only
      this.pollTimer = setInterval(() => {
        if (fs.existsSync(this.config.filePath)) {
          if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
          }
          if (this.running) {
            this.start();
          }
        }
      }, this.config.pollIntervalMs);
    }
  }

  /**
   * Start watching for changes to the transcript file.
   */
  private startWatching(): void {
    this.running = true;

    // Use fs.watch for immediate notifications
    try {
      this.watcher = fs.watch(this.config.filePath, (eventType) => {
        if (eventType === 'change') {
          this.readNewEntries();
        }
      });
    } catch {
      // fs.watch not available; fall back to polling only
    }

    // Also poll as a reliability fallback
    this.pollTimer = setInterval(() => {
      this.readNewEntries();
    }, this.config.pollIntervalMs);
  }

  /**
   * Read new entries from the file since last read position.
   */
  private async readNewEntries(): Promise<void> {
    try {
      const stat = fs.statSync(this.config.filePath);

      // No new data
      if (stat.size <= this.fileOffset) return;

      // Read only the new bytes
      const fd = fs.openSync(this.config.filePath, 'r');
      const bufferSize = stat.size - this.fileOffset;
      const buffer = Buffer.alloc(bufferSize);
      fs.readSync(fd, buffer, 0, bufferSize, this.fileOffset);
      fs.closeSync(fd);

      this.fileOffset = stat.size;

      // Parse the new data line by line
      const newData = buffer.toString('utf-8');
      const lines = newData.split('\n');

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const entry = JSON.parse(trimmed) as TranscriptEntry;
          this.processEntry(entry);
        } catch (parseError) {
          // Skip malformed lines (could be partial writes)
          this.events.onError?.(
            new Error(`Failed to parse transcript line: ${trimmed.slice(0, 100)}`),
          );
        }
      }
    } catch (error) {
      this.events.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Process a single parsed transcript entry.
   */
  private processEntry(entry: TranscriptEntry): void {
    // Check for duplicate (by UUID for user/assistant entries)
    const uuid = (entry.type === 'user' || entry.type === 'assistant') ? entry.uuid : undefined;
    if (uuid) {
      if (this.entryIndex.has(uuid)) {
        return; // Already have this entry
      }
      this.entryIndex.set(uuid, this.entries.length);
    }

    this.entries.push(entry);

    // Emit appropriate event
    switch (entry.type) {
      case 'user':
        this.events.onUserMessage?.(entry);
        break;
      case 'assistant':
        this.events.onAssistantMessage?.(entry);
        break;
      case 'summary':
        this.events.onSummary?.(entry);
        break;
    }
  }
}
