/**
 * Production seams for `EngineHost` (#818): the `~/.remi/engine.pid` record and
 * the detached spawn.
 *
 * `engine-host.ts` holds the POLICY (attach first, claim before spawning, never
 * reap on exit) and takes both of these as injectable deps so it stays testable
 * without touching the filesystem or starting processes. This module is the
 * other half: the real implementations, which are the parts that can only be
 * verified against a real OS.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { errorToString } from '@remi/shared';
import type { PidStore } from './engine-host.ts';

const REMI_DIR = path.join(os.homedir(), '.remi');

/** The engine start record. Sibling of `daemon.pid` (the hub's), deliberately
 *  separate: the engine is a peer of the hub, not a child of it, and outlives
 *  whichever process started it. */
export const ENGINE_PID_FILE = path.join(REMI_DIR, 'engine.pid');

/** Where a remi-started engine's stdout/stderr go. Without this the helper's
 *  own diagnostics vanish, and "the engine did not come up" is exactly the
 *  case where you need them. */
export const ENGINE_LOG_FILE = path.join(REMI_DIR, 'engine.log');

/** Is this pid a live process? Signal 0 tests existence without delivering
 *  anything. EPERM means alive but owned by another user, which still counts —
 *  something holds the record and we must not claim it. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * `~/.remi/engine.pid`, claimed exclusively.
 *
 * The exclusivity is what makes it a start-race guard rather than a note: two
 * daemons booting together must not both spawn a multi-GB helper. `wx` gives
 * that atomically — the loser's create fails, it waits, and attaches to the
 * winner's engine.
 *
 * A STALE record (the recorded process is gone, e.g. the machine lost power
 * mid-download) must not wedge the feature forever, so a dead holder is cleared
 * and the claim retried once. The retry is bounded at one: if a live process
 * takes the record in between, it genuinely owns it and we lose fairly.
 */
export class FileEnginePidStore implements PidStore {
  constructor(private readonly file: string = ENGINE_PID_FILE) {}

  read(): number | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return null;
    }
    const pid = Number.parseInt(raw.trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    // A record naming a dead process is not a record. Reporting null here is
    // what lets `claim` clear it and what stops `remi engine stop` from
    // signalling a pid that has since been recycled by an unrelated process.
    return isAlive(pid) ? pid : null;
  }

  claim(pid: number): boolean {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (this.tryCreate(pid)) return true;

    // Create failed, so a record exists. Only a DEAD holder may be displaced.
    if (this.read() !== null) return false;
    try {
      fs.unlinkSync(this.file);
    } catch {
      // Someone else cleared it first; the retry below settles who wins.
    }
    return this.tryCreate(pid);
  }

  release(pid: number): void {
    // Read the raw file rather than `read()`: release must work for a pid that
    // has already exited (the normal case when clearing our own record), and
    // `read()` deliberately reports a dead holder as absent.
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return;
    }
    // Only ever remove OUR record. Releasing unconditionally would let a late
    // cleanup delete the record of an engine somebody else has since started.
    if (Number.parseInt(raw.trim(), 10) !== pid) return;
    try {
      fs.unlinkSync(this.file);
    } catch {
      // Already gone: the post-condition holds either way.
    }
  }

  /** Atomic create-or-fail. `wx` is the whole point — an exists-then-write
   *  would reintroduce the race this class exists to close. */
  private tryCreate(pid: number): boolean {
    try {
      fs.writeFileSync(this.file, `${pid}\n`, { flag: 'wx' });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Start the engine helper DETACHED, mirroring how `daemon-manager.ts` launches
 * the hub: `detached: true` + `unref()`, output to a log file, no handle kept.
 *
 * Detached is not an optimization here, it is the contract. The engine is a
 * machine-wide singleton shared by every session daemon; a session that spawned
 * it and then quit must not take auto-approve down for the others (#818).
 *
 * Returns the child's pid. Throws when the spawn itself fails (bad path,
 * missing execute bit) so `EngineHost` can release its claim and report the
 * reason rather than leaving a record for a process that never existed.
 */
export function spawnDetachedEngine(
  helperPath: string,
  env: Record<string, string>,
  logFile: string = ENGINE_LOG_FILE,
): number {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const logFd = fs.openSync(logFile, 'a');
  try {
    fs.writeSync(logFd, `\n--- Engine starting at ${new Date().toISOString()} ---\n`);
    const child = spawn(helperPath, [], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, ...env },
    });
    // A spawn failure surfaces TWICE: synchronously on some runtimes, and as an
    // asynchronous 'error' event on all of them. An unhandled 'error' event on
    // a ChildProcess is thrown as an uncaught exception, which on a detached
    // helper would take the whole daemon down over a missing engine binary --
    // the opposite of the "no engine is not fatal" contract. Absorb it here;
    // `EngineHost.waitForReady` already treats never-answering as unavailable.
    child.on('error', (err) => {
      try {
        fs.appendFileSync(logFile, `Engine spawn failed: ${errorToString(err)}\n`);
      } catch {
        // The log is best-effort; never let diagnostics become the failure.
      }
    });
    const pid = child.pid;
    if (pid === undefined) {
      throw new Error('spawn returned no pid');
    }
    child.unref();
    // The child holds its own duplicate of the descriptor, so closing ours does
    // not cut off its logging -- and NOT closing it leaks an fd per attempt.
    return pid;
  } finally {
    try {
      fs.closeSync(logFd);
    } catch (err) {
      // Nothing actionable: the spawn already succeeded or already threw.
      void errorToString(err);
    }
  }
}
