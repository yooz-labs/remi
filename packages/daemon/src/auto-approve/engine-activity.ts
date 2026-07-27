/**
 * The shared machine-wide "when did any remi last evaluate?" record (#818/#820).
 *
 * Ten remi daemons share ONE engine, but each runs its own idle-unload timer.
 * Without a shared signal the first daemon to go idle evicts weights the other
 * nine are using, and at that fleet size that is the common case rather than an
 * edge — the user experiences it as remi randomly becoming slow, because every
 * eviction costs the next session a multi-second cold load.
 *
 * This is deliberately a file mtime rather than a protocol: one `utimes` per
 * evaluation, one `stat` per timer fire, no locks, no IPC, nothing to keep in
 * sync, and nothing that breaks when a daemon is SIGKILLed. It restores exactly
 * the semantic ollama gave us for free — unload N minutes after the MACHINE's
 * last use.
 *
 * Every operation is best-effort: a failure here must never affect an
 * evaluation, and an unreadable record degrades to "no reason to wait", so a
 * missing or broken file can never pin weights forever.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ActivityRecord } from './model-residency.ts';

const ACTIVITY_FILE = path.join(os.homedir(), '.remi', 'engine-activity');

/** The production `ActivityRecord`, backed by `~/.remi/engine-activity`. */
export function fileActivityRecord(
  filePath: string = ACTIVITY_FILE,
  now: () => number = () => Date.now(),
): ActivityRecord {
  return {
    touch(): void {
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        // Create-or-update: writing an empty file is cheaper than read-modify
        // -write and the CONTENT is irrelevant — only the mtime is read.
        fs.writeFileSync(filePath, '');
      } catch {
        // Best-effort by contract: a read-only home directory degrades to the
        // old per-process behavior rather than breaking evaluation.
      }
    },
    sinceLastMs(): number | null {
      try {
        const stat = fs.statSync(filePath);
        return Math.max(0, now() - stat.mtimeMs);
      } catch {
        return null;
      }
    },
  };
}
