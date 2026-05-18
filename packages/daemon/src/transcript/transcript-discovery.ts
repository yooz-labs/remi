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
import type {
  AssistantEntry,
  ContentBlock,
  TextBlock,
  TranscriptEntry,
  UserEntry,
} from './types.ts';

/** Type predicate for TextBlock content blocks */
function isTextBlock(block: ContentBlock): block is TextBlock {
  return block.type === 'text';
}

/** Default Claude Code projects directory */
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

/** Configuration for transcript discovery */
export interface TranscriptDiscoveryConfig {
  /** Directory to scan for transcript files (default: ~/.claude/projects/) */
  readonly projectsDir?: string;

  /** Maximum age in ms before a session is marked 'completed' (default: 1 hour). Sessions modified within 5 minutes are 'active'; between 5 minutes and this threshold are 'idle'. */
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
 * extracts session metadata by reading only the tail of each file (last 8KB),
 * avoiding full file loads.
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
   * Get the transcript directory path for a given project.
   * Encodes the project's absolute path into the Claude Code projects directory structure.
   *
   * NOTE: Claude Code's encoding (replacing `/` with `-`) is lossy. Paths containing
   * dashes cannot be reliably decoded back (e.g., `/Users/my-project` and `/Users/my/project`
   * produce the same encoded form). The `projectPath` on discovered sessions may be inaccurate.
   */
  getProjectTranscriptDir(projectPath: string): string {
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
    return files[0]?.filePath ?? null;
  }

  /**
   * Find the most recent transcript for a project, skipping specific session IDs.
   * Used when sibling daemons in the same directory have already claimed transcripts.
   */
  findLatestTranscriptExcluding(projectPath: string, excludeIds: Set<string>): string | null {
    const transcriptDir = this.getProjectTranscriptDir(projectPath);
    if (!fs.existsSync(transcriptDir)) return null;

    const files = this.listJsonlFiles(transcriptDir);
    if (files.length === 0) return null;

    files.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
    for (const file of files) {
      if (!excludeIds.has(file.sessionId)) {
        return file.filePath;
      }
    }
    return null;
  }

  /**
   * Find a transcript file path by its session ID (the UUID filename without .jsonl).
   * Returns the file path if found, null otherwise.
   */
  findTranscriptBySessionId(sessionId: string): string | null {
    const files = this.findTranscriptFiles();
    const match = files.find((f) => f.sessionId === sessionId);
    return match?.filePath ?? null;
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
          continue; // Skip inaccessible directories
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
          // Skip files that can't be stat'd
        }
      }
    } catch {
      // Can't read directory
    }

    return files;
  }

  /**
   * Convert a transcript file info to a DiscoverableSession.
   * Reads the tail of the file (last 8KB) to extract metadata.
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
    if (!tailInfo) {
      return null; // Could not read file
    }

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
      canResume: status !== 'active', // Only offer resume for idle/completed sessions, not actively running ones
      // For external entries the filename UUID IS the Claude session id;
      // path comes from the same disk scan.
      claudeSessionId: file.sessionId,
      transcriptPath: file.filePath,
    };
  }

  /**
   * Read the tail of a transcript file to extract metadata.
   * Only reads the last 8KB to avoid loading large files.
   * Returns null if the file cannot be read.
   */
  private readFileTail(filePath: string): {
    messageCount: number;
    model?: string;
    lastMessage?: string;
  } | null {
    const MAX_TAIL_BYTES = 8192;
    let fd: number | null = null;

    try {
      const stat = fs.statSync(filePath);
      const readOffset = Math.max(0, stat.size - MAX_TAIL_BYTES);
      const readSize = Math.min(stat.size, MAX_TAIL_BYTES);

      const buffer = Buffer.alloc(readSize);
      fd = fs.openSync(filePath, 'r');
      fs.readSync(fd, buffer, 0, readSize, readOffset);
      fs.closeSync(fd);
      fd = null;

      const content = buffer.toString('utf-8');
      const lines = content.split('\n').filter((l) => l.trim());

      // If we started mid-line (offset > 0), skip the first partial line
      const startIdx = readOffset > 0 ? 1 : 0;

      let messageCount = 0;
      let model: string | undefined;
      let lastMessage: string | undefined;

      for (let i = startIdx; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        try {
          const entry = JSON.parse(line) as TranscriptEntry;

          if (entry.type === 'user' || entry.type === 'assistant') {
            messageCount++;
          }

          if (entry.type === 'assistant') {
            const assistantEntry = entry as AssistantEntry;
            model = assistantEntry.message.model ?? model;

            const textBlocks = assistantEntry.message.content.filter(isTextBlock);
            const firstText = textBlocks[0]?.text;
            if (firstText) {
              lastMessage = firstText.length > 100 ? `${firstText.slice(0, 97)}...` : firstText;
            }
          }

          if (entry.type === 'user') {
            const userEntry = entry as UserEntry;
            let msgContent: string;
            if (typeof userEntry.message.content === 'string') {
              msgContent = userEntry.message.content;
            } else if (Array.isArray(userEntry.message.content)) {
              const textBlocks = userEntry.message.content.filter(isTextBlock);
              msgContent = textBlocks[0]?.text || '';
            } else {
              msgContent = '';
            }
            if (msgContent) {
              lastMessage = msgContent.length > 100 ? `${msgContent.slice(0, 97)}...` : msgContent;
            }
          }
        } catch {
          // Skip unparsable lines in tail
        }
      }

      // If we only read the tail, the message count is approximate
      if (readOffset > 0) {
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
      return null;
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* already closed or invalid */
        }
      }
    }
  }
}
