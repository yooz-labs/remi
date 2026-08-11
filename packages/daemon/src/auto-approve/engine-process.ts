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
/**
 * Delete `file` only if it still records exactly `expected`.
 *
 * Every delete on these paths must be compare-then-delete. A blind `unlink`
 * removes whatever is at the path *now*, which is not necessarily what the
 * caller observed a moment ago — that is precisely how two claimants both end
 * up believing they hold an exclusive record.
 *
 * Still a check-then-act at the syscall level, so it narrows the window rather
 * than eliminating it; see the class doc for why that is acceptable here.
 * Returns false when the content had changed (someone else owns it now) or the
 * delete failed.
 */
function unlinkIfMatches(file: string, expected: number): boolean {
  try {
    const current = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    if (current !== expected) return false;
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

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
 * that atomically for the common case — the loser's create fails, it waits, and
 * attaches to the winner's engine.
 *
 * A STALE record (the recorded process is gone, e.g. the machine lost power
 * mid-download) must not wedge the feature forever, so a dead holder is
 * displaced. That displacement is the subtle part, and a naive
 * check-then-unlink-then-create is WRONG: two processes that both observe the
 * same stale record can both proceed, and the second one's `unlink` deletes the
 * first one's freshly written LIVE record before recreating under its own pid.
 * Both callers then believe they hold an exclusive claim, and both spawn an
 * engine — precisely the crash-then-reboot case (stale record + hub and session
 * daemon booting together) this class exists to prevent.
 *
 * So displacement happens under a separate `wx` mutex, with the record
 * RE-CHECKED inside it: whoever takes the mutex is the only process that may
 * delete the stale file, and anyone who took it after a live record appeared
 * backs off instead. Every delete is compare-then-delete (`unlinkIfMatches`) so
 * no process can blindly remove a record or mutex it did not observe.
 *
 * **This is best-effort, not an exclusive lock, and the distinction matters.**
 * Node has no `flock`, and "atomically replace this file only if its owner is
 * dead" is not expressible with create/rename/unlink alone. A narrow window
 * survives: if a process dies mid-displacement it leaves BOTH the record and
 * the mutex stale, and two claimants recovering from that state can each
 * conclude they hold the mutex. Compare-then-delete shrinks that window; it
 * does not close it. Closing it properly needs an OS advisory lock.
 *
 * That is acceptable only because the pidfile is the SECOND line of defence.
 * **The port is the real singleton** (see `engine-host.ts`): 19924 admits one
 * listener, so a claimant that slips through still fails to bind, and
 * `startEngine` cleans up a helper that turns out to be redundant. The pidfile
 * exists to keep that case rare and quiet, not to be the guarantee.
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
    if (this.tryCreate(this.file, pid)) return true;

    // Create failed, so a record exists. Only a DEAD holder may be displaced.
    if (this.read() !== null) return false;

    // Serialize displacement. Without this, two processes that both saw the
    // stale record race, and the second's unlink destroys the first's LIVE
    // record -- both then return true and both spawn an engine.
    const mutex = `${this.file}.claim`;
    if (!this.acquireMutex(mutex, pid)) return false;
    try {
      // RE-CHECK inside the mutex: between our check above and taking it, the
      // holder may have displaced the stale record and be live now.
      const stale = this.rawPid(this.file);
      if (stale === null || isAlive(stale)) return false;
      // Compare-then-delete: only remove the exact stale record we just read.
      // A blind unlink here would destroy a LIVE record written by a process
      // that displaced this one in between -- the same bug one level down.
      if (!unlinkIfMatches(this.file, stale)) return false;
      return this.tryCreate(this.file, pid);
    } finally {
      this.releaseMutex(mutex, pid);
    }
  }

  /** Take the displacement mutex. A mutex left behind by a process that died
   *  mid-displacement is itself displaced, so a crash cannot wedge claiming
   *  permanently — the same staleness rule as the record it guards. */
  private acquireMutex(mutex: string, pid: number): boolean {
    if (this.tryCreate(mutex, pid)) return true;
    const holder = this.rawPid(mutex);
    // Vanished between the failed create and the read: retry once.
    if (holder === null) return this.tryCreate(mutex, pid);
    if (isAlive(holder)) return false;
    // Compare-then-delete, for the same reason as the record itself: a blind
    // unlink would remove a mutex another process legitimately took while we
    // were deciding.
    if (!unlinkIfMatches(mutex, holder)) return false;
    return this.tryCreate(mutex, pid);
  }

  private releaseMutex(mutex: string, pid: number): void {
    unlinkIfMatches(mutex, pid);
  }

  /** The pid recorded in `file` regardless of liveness, or null when absent or
   *  malformed. `read()` deliberately conflates "dead holder" with "no record";
   *  the displacement paths need to tell those apart. */
  private rawPid(file: string): number | null {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }

  release(pid: number): void {
    // Compare-then-delete against the RAW content, not `read()`: release must
    // work for a pid that has already exited (the normal case when clearing our
    // own record), and `read()` deliberately reports a dead holder as absent.
    // Only ever remove OUR record -- releasing unconditionally would let a late
    // cleanup delete the record of an engine somebody else has since started.
    unlinkIfMatches(this.file, pid);
  }

  /** Atomic create-or-fail. `wx` is the whole point — an exists-then-write
   *  would reintroduce the race this class exists to close. */
  private tryCreate(file: string, pid: number): boolean {
    try {
      fs.writeFileSync(file, `${pid}\n`, { flag: 'wx' });
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
  args: readonly string[],
  env: Record<string, string>,
  logFile: string = ENGINE_LOG_FILE,
): number {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const logFd = fs.openSync(logFile, 'a');
  try {
    // Name the executable rather than saying "Engine": since #822 this also
    // launches `llama-server`, and a log banner that calls it the engine is the
    // kind of wrong-but-plausible description ADR 0011 exists to prevent.
    fs.writeSync(
      logFd,
      `\n--- ${path.basename(helperPath)} starting at ${new Date().toISOString()} ---\n`,
    );
    const child = spawn(helperPath, [...args], {
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
    // Cast per the existing idiom in `live-sessions-watcher.ts`: the bundled
    // `ChildProcess` type does not surface the EventEmitter surface it has at
    // runtime, and CI resolves a stricter view of it than a local install.
    (child as unknown as import('node:events').EventEmitter).on('error', (err: unknown) => {
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
