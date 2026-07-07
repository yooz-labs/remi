/**
 * Read the Remi ownership marker from a Claude Code transcript.
 *
 * Each daemon spawns `claude` with `-n remi:<wsPort>` (see
 * `cli/claude-binding.ts` + `cli.ts` `displayName`). Claude records that name
 * at the head of every transcript it writes as a `custom-title` entry:
 *
 *   {"type":"custom-title","customTitle":"remi:18767","sessionId":"..."}
 *
 * Because two daemons sharing a project directory both receive each other's
 * hook events (shared `.claude/settings.local.json` fan-out), the incoming
 * `session_id` alone cannot tell us which daemon's Claude wrote a transcript.
 * The port baked into `customTitle` can: it is content the OWNING daemon
 * caused Claude to write. We use it to prove a rotation is ours before
 * adopting it, even when a genuine sibling daemon is present.
 *
 * READ-ONLY: never modifies the transcript. Returns null when the marker is
 * absent (e.g. the user supplied their own `-n`, or an older Claude/remi),
 * in which case callers fall back to the sibling-guard default.
 */

import * as fs from 'node:fs';

import { logError } from '../cli/logger.ts';

/** Only the first few lines can hold the head marker; cap the read. */
const HEAD_BYTES = 8192;

/**
 * How long a transcript may sit with an unreadable `remi:<port>` head marker
 * before it is treated as genuinely (permanently) markerless rather than
 * still-flushing. Shared home for a value both `TranscriptBinder`'s rotation
 * dir-poll and `ForeignSessionEscalator`'s ownership ladder (#672 review) need:
 * both must tell "still settling, ask again later" apart from "genuinely has
 * no marker" using the same threshold. 10s is far beyond Claude's synchronous
 * create-to-marker gap.
 */
export const MARKER_SETTLE_MS = 10_000;

interface CustomTitleEntry {
  type?: string;
  customTitle?: string;
}

/**
 * Return the remi wsPort encoded in the transcript's `custom-title` head
 * marker, or null if the file is unreadable or carries no `remi:<port>` title.
 */
export function readTranscriptOwnerPort(transcriptPath: string): number | null {
  let fd: number | null = null;
  try {
    const stat = fs.statSync(transcriptPath);
    const readSize = Math.min(stat.size, HEAD_BYTES);
    if (readSize === 0) return null;

    const buffer = Buffer.alloc(readSize);
    fd = fs.openSync(transcriptPath, 'r');
    fs.readSync(fd, buffer, 0, readSize, 0);
    fs.closeSync(fd);
    fd = null;

    const lines = buffer.toString('utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // The marker is at the very head; bail out once real conversation
      // entries start so we never scan a large transcript line-by-line.
      let entry: CustomTitleEntry;
      try {
        entry = JSON.parse(trimmed) as CustomTitleEntry;
      } catch {
        continue;
      }
      if (entry.type === 'custom-title' && typeof entry.customTitle === 'string') {
        const port = parseRemiPort(entry.customTitle);
        if (port !== null) return port;
      }
      if (entry.type === 'user' || entry.type === 'assistant') {
        // Past the header region without a remi marker; stop early.
        return null;
      }
    }
    return null;
  } catch (err) {
    // Fail safe: a missing/unflushed file (ENOENT) is routine during the
    // fallback window, so callers treat null as "no marker". But a non-routine
    // I/O error (EMFILE, ENOMEM, EACCES) is worth surfacing so an operator can
    // see why ownership checks are coming up empty.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== undefined && code !== 'ENOENT') {
      logError(`[transcript-owner] Failed to read ${transcriptPath}: ${code}`);
    }
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

/** Parse `remi:<port>` into the numeric port, or null if it isn't that shape. */
function parseRemiPort(customTitle: string): number | null {
  const match = /^remi:(\d{1,5})$/.exec(customTitle);
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}
