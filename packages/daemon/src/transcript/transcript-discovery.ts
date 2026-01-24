/**
 * TranscriptDiscovery - Discovers Claude Code sessions from transcript files.
 *
 * Scans ~/.claude/projects/ for .jsonl transcript files and extracts
 * session metadata for the discovery feature.
 *
 * READ-ONLY: Never modifies any Claude Code files.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DiscoverableSession } from '@remi/shared';
import type { AssistantEntry, TranscriptEntry, UserEntry } from './types.ts';

/** Default Claude Code projects directory */
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

/** Configuration for transcript discovery */
export interface TranscriptDiscoveryConfig {
  /** Directory to scan for transcript files (default: ~/.claude/projects/) */
  readonly projectsDir?: string;

  /** Maximum age in ms for a session to be considered active (default: 1 hour) */
  readonly activeThresholdMs?: number;

  /** Maximum number of sessions to return (default: 50) */
  readonly maxResults?: number;
}

/** Info extracted from scanning a transcript file */
interface TranscriptFileInfo {
  readonly filePath: string;
  readonly sessionId: string;
  readonly projectPath: string;
  readonly lastModified: Date;
  readonly fileSize: number;
}

/**
 * Discover Claude Code sessions from transcript files on disk.
 *
 * Scans the Claude Code projects directory for .jsonl files and
 * extracts session metadata without loading full file contents.
 */
export class TranscriptDiscovery {
  private readonly config: Required<TranscriptDiscoveryConfig>;

  constructor(config: TranscriptDiscoveryConfig = {}) {
    this.config = {
      projectsDir: config.projectsDir ?? CLAUDE_PROJECTS_DIR,
      activeThresholdMs: config.activeThresholdMs ?? 60 * 60 * 1000, // 1 hour
      maxResults: config.maxResults ?? 50,
    };
  }

  /**
   * Discover all sessions, sorted by last activity (most recent first).
   * Excludes sessions already managed by the daemon (by session ID).
   */
  discoverSessions(excludeSessionIds: Set<string> = new Set()): DiscoverableSession[] {
    const files = this.findTranscriptFiles();
    const sessions: DiscoverableSession[] = [];

    for (const file of files) {
      if (excludeSessionIds.has(file.sessionId)) {
        continue;
      }

      const session = this.fileToDiscoverableSession(file);
      if (session) {
        sessions.push(session);
      }

      if (sessions.length >= this.config.maxResults) {
        break;
      }
    }

    return sessions;
  }

  /**
   * Get the transcript file path for a given project directory.
   * Returns the path to the Claude Code projects directory for that project.
   */
  getProjectTranscriptDir(projectPath: string): string {
    // Claude Code uses the absolute path with slashes replaced by dashes
    const encodedPath = projectPath.replace(/\//g, '-');
    return path.join(this.config.projectsDir, encodedPath);
  }

  /**
   * Find the most recent transcript file for a given project directory.
   * Useful for connecting a daemon-managed session to its transcript.
   */
  findLatestTranscript(projectPath: string): string | null {
    const transcriptDir = this.getProjectTranscriptDir(projectPath);

    if (!fs.existsSync(transcriptDir)) {
      return null;
    }

    const files = this.listJsonlFiles(transcriptDir);
    if (files.length === 0) {
      return null;
    }

    // Sort by modification time, most recent first
    files.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
    return files[0]!.filePath;
  }

  /**
   * Find all .jsonl transcript files across all projects.
   * Sorted by last modification time (most recent first).
   */
  private findTranscriptFiles(): TranscriptFileInfo[] {
    if (!fs.existsSync(this.config.projectsDir)) {
      return [];
    }

    const allFiles: TranscriptFileInfo[] = [];

    try {
      const projectDirs = fs.readdirSync(this.config.projectsDir);

      for (const dirName of projectDirs) {
        const dirPath = path.join(this.config.projectsDir, dirName);

        try {
          const stat = fs.statSync(dirPath);
          if (!stat.isDirectory()) continue;
        } catch {
          continue;
        }

        const files = this.listJsonlFiles(dirPath);
        allFiles.push(...files);
      }
    } catch {
      // Can't read projects directory
      return [];
    }

    // Sort by modification time (most recent first)
    allFiles.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());

    return allFiles;
  }

  /**
   * List all .jsonl files in a directory with metadata.
   */
  private listJsonlFiles(dirPath: string): TranscriptFileInfo[] {
    const files: TranscriptFileInfo[] = [];

    try {
      const entries = fs.readdirSync(dirPath);

      for (const entry of entries) {
        if (!entry.endsWith('.jsonl')) continue;

        const filePath = path.join(dirPath, entry);
        try {
          const stat = fs.statSync(filePath);

          // Extract session ID from filename (UUID.jsonl)
          const sessionId = entry.replace('.jsonl', '');

          // Decode project path from directory name
          const dirName = path.basename(dirPath);
          const projectPath = dirName.replace(/-/g, '/');

          files.push({
            filePath,
            sessionId,
            projectPath,
            lastModified: stat.mtime,
            fileSize: stat.size,
          });
        } catch {
          continue;
        }
      }
    } catch {
      // Can't read directory
    }

    return files;
  }

  /**
   * Convert a transcript file info to a DiscoverableSession.
   * Reads the last few lines to get the latest message info.
   */
  private fileToDiscoverableSession(file: TranscriptFileInfo): DiscoverableSession | null {
    const now = Date.now();
    const age = now - file.lastModified.getTime();

    // Determine status based on last modification time
    let status: 'active' | 'idle' | 'completed';
    if (age < 5 * 60 * 1000) {
      // Modified in last 5 minutes
      status = 'active';
    } else if (age < this.config.activeThresholdMs) {
      status = 'idle';
    } else {
      status = 'completed';
    }

    // Try to get the last message and message count from the file tail
    const tailInfo = this.readFileTail(file.filePath);

    return {
      sessionId: file.sessionId,
      projectPath: file.projectPath,
      status,
      lastActivity: file.lastModified.toISOString(),
      messageCount: tailInfo.messageCount,
      model: tailInfo.model,
      lastMessage: tailInfo.lastMessage,
      source: 'transcript',
      canAttach: false, // External sessions can't be attached to via daemon
    };
  }

  /**
   * Read the tail of a transcript file to extract metadata.
   * Only reads the last few KB to avoid loading large files.
   */
  private readFileTail(filePath: string): {
    messageCount: number;
    model?: string;
    lastMessage?: string;
  } {
    const MAX_TAIL_BYTES = 8192; // Read last 8KB

    try {
      const stat = fs.statSync(filePath);
      const readOffset = Math.max(0, stat.size - MAX_TAIL_BYTES);
      const readSize = Math.min(stat.size, MAX_TAIL_BYTES);

      const fd = fs.openSync(filePath, 'r');
      const buffer = Buffer.alloc(readSize);
      fs.readSync(fd, buffer, 0, readSize, readOffset);
      fs.closeSync(fd);

      const content = buffer.toString('utf-8');
      const lines = content.split('\n').filter((l) => l.trim());

      // If we started mid-line (offset > 0), skip the first partial line
      const startIdx = readOffset > 0 ? 1 : 0;

      let messageCount = 0;
      let model: string | undefined;
      let lastMessage: string | undefined;

      for (let i = startIdx; i < lines.length; i++) {
        try {
          const entry = JSON.parse(lines[i]!) as TranscriptEntry;

          if (entry.type === 'user' || entry.type === 'assistant') {
            messageCount++;
          }

          if (entry.type === 'assistant') {
            const assistantEntry = entry as AssistantEntry;
            model = assistantEntry.message.model ?? model;

            // Get text content as preview
            const textBlocks = assistantEntry.message.content.filter((b) => b.type === 'text');
            if (textBlocks.length > 0) {
              const text = (textBlocks[0] as { text: string }).text;
              lastMessage = text.length > 100 ? `${text.slice(0, 97)}...` : text;
            }
          }

          if (entry.type === 'user') {
            const userEntry = entry as UserEntry;
            const content =
              typeof userEntry.message.content === 'string'
                ? userEntry.message.content
                : '[complex content]';
            lastMessage =
              content.length > 100 ? `${content.slice(0, 97)}...` : content;
          }
        } catch {
          // Skip unparseable lines
        }
      }

      // If we only read the tail, the message count is approximate
      if (readOffset > 0) {
        // Estimate total messages from file size ratio
        const ratio = stat.size / readSize;
        messageCount = Math.round(messageCount * ratio);
      }

      const result: { messageCount: number; model?: string; lastMessage?: string } = {
        messageCount,
      };
      if (model) result.model = model;
      if (lastMessage) result.lastMessage = lastMessage;
      return result;
    } catch {
      return { messageCount: 0 };
    }
  }
}
