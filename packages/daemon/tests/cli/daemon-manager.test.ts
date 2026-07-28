import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  formatVersionDrift,
  listSessionDaemons,
  readPidFileLive,
  stopSessionDaemons,
  terminatePid,
} from '../../src/cli/daemon-manager.ts';
import type { LiveSessionEntry } from '../../src/session/session-registry-file.ts';

const REMI_DIR = path.join(os.homedir(), '.remi');
const PID_FILE = path.join(REMI_DIR, 'daemon.pid');

describe('readPidFileLive', () => {
  afterEach(() => {
    // Clean up test PID files
    try {
      if (fs.existsSync(PID_FILE)) {
        const content = fs.readFileSync(PID_FILE, 'utf-8').trim();
        const pid = Number.parseInt(content, 10);
        // Only clean up if it's a fake PID we created
        if (pid === 999999) {
          fs.unlinkSync(PID_FILE);
        }
      }
    } catch {
      // ignore
    }
  });

  test('returns null when no PID file exists', () => {
    // Rename existing PID file if present to avoid interference
    const backup = `${PID_FILE}.backup`;
    let hadExisting = false;
    try {
      if (fs.existsSync(PID_FILE)) {
        fs.renameSync(PID_FILE, backup);
        hadExisting = true;
      }
    } catch {
      // ignore
    }

    try {
      const pid = readPidFileLive();
      // Could be null (no file) or a real PID if daemon is running
      // When we removed the file, it should be null
      expect(pid).toBeNull();
    } finally {
      if (hadExisting) {
        try {
          fs.renameSync(backup, PID_FILE);
        } catch {
          // ignore
        }
      }
    }
  });

  test('returns null for stale PID file with non-running process', () => {
    // Write a PID that definitely doesn't exist
    fs.mkdirSync(REMI_DIR, { recursive: true });
    fs.writeFileSync(PID_FILE, '999999', 'utf-8');
    const pid = readPidFileLive();
    expect(pid).toBeNull();
    // Should have cleaned up the stale file
    expect(fs.existsSync(PID_FILE)).toBe(false);
  });

  test('returns null for invalid PID file content', () => {
    fs.mkdirSync(REMI_DIR, { recursive: true });
    fs.writeFileSync(PID_FILE, 'not-a-number', 'utf-8');
    const pid = readPidFileLive();
    expect(pid).toBeNull();
  });

  test('returns PID for running process', () => {
    // Use our own PID as a known-running process
    fs.mkdirSync(REMI_DIR, { recursive: true });
    const ourPid = process.pid;
    fs.writeFileSync(PID_FILE, String(ourPid), 'utf-8');
    const pid = readPidFileLive();
    expect(pid).toBe(ourPid);
    // Clean up
    fs.unlinkSync(PID_FILE);
  });
});

describe('readPidFileLive (#542)', () => {
  // Same real-~/.remi discipline as above: only fake PIDs are ever written,
  // and every branch restores/cleans in a finally. The status-file fallback
  // (readStatusFilePidIfAlive) is deliberately NOT unit-tested here —
  // daemon-status.json is actively rewritten by any live daemon on this
  // machine, so it is exercised in the hub integration test against an
  // isolated $HOME instead.
  test('unlinks a stale entry and returns null; live pid round-trips', () => {
    fs.mkdirSync(REMI_DIR, { recursive: true });
    const backup = `${PID_FILE}.backup`;
    let hadExisting = false;
    if (fs.existsSync(PID_FILE)) {
      fs.renameSync(PID_FILE, backup);
      hadExisting = true;
    }
    try {
      fs.writeFileSync(PID_FILE, '999999', 'utf-8');
      expect(readPidFileLive()).toBeNull();
      expect(fs.existsSync(PID_FILE)).toBe(false);

      fs.writeFileSync(PID_FILE, String(process.pid), 'utf-8');
      expect(readPidFileLive()).toBe(process.pid);
      fs.unlinkSync(PID_FILE);
    } finally {
      if (hadExisting) {
        try {
          fs.renameSync(backup, PID_FILE);
        } catch {
          // ignore
        }
      }
    }
  });
});

describe('formatVersionDrift (#539)', () => {
  test('flags a running/installed mismatch', () => {
    const note = formatVersionDrift('0.6.18', '0.6.19-dev.2');
    expect(note).toContain('0.6.18');
    expect(note).toContain('0.6.19-dev.2');
    expect(note).toContain('restart to apply');
  });

  test('silent on match or unknown versions', () => {
    expect(formatVersionDrift('0.6.19', '0.6.19')).toBeNull();
    expect(formatVersionDrift(undefined, '0.6.19')).toBeNull();
    expect(formatVersionDrift('0.6.19', undefined)).toBeNull();
    expect(formatVersionDrift('', '0.6.19')).toBeNull();
  });
});

describe('listSessionDaemons (#859)', () => {
  function entry(over: Partial<LiveSessionEntry> = {}): LiveSessionEntry {
    return {
      sessionId: '11111111-1111-1111-1111-111111111111',
      pid: 100,
      wsPort: 18765,
      hookPort: 0,
      projectPath: '/tmp/p',
      name: 'proj/main',
      startedAt: new Date(0).toISOString(),
      ...over,
    } as LiveSessionEntry;
  }

  test('reports the session daemons stop/status previously could not see', () => {
    // `stop`/`status` resolve only the hub's daemon.pid / daemon-status.json.
    // Session daemons write status-<PORT>.json, which nothing enumerated -- so
    // both commands announced "not running" while `remi ls` listed one.
    const found = listSessionDaemons(() => [
      entry({ pid: 100, wsPort: 18765, name: 'a/main' }),
      entry({ pid: 200, wsPort: 18766, name: 'b/main' }),
    ]);
    expect(found).toEqual([
      { pid: 100, wsPort: 18765, name: 'a/main' },
      { pid: 200, wsPort: 18766, name: 'b/main' },
    ]);
  });

  test('deduplicates by pid: one daemon hosting several sessions is one process', () => {
    const found = listSessionDaemons(() => [
      entry({ pid: 100, wsPort: 18765, name: 'a/main', sessionId: 'x' }),
      entry({ pid: 100, wsPort: 18765, name: 'a/other', sessionId: 'y' }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.pid).toBe(100);
  });

  test('an empty registry reports none', () => {
    expect(listSessionDaemons(() => [])).toEqual([]);
  });
});

describe('terminatePid (#859)', () => {
  /** Records signals and never touches a real process. */
  function recorder(aliveFor: number) {
    const sent: string[] = [];
    let probes = 0;
    return {
      sent,
      deps: {
        signal: (_pid: number, sig: NodeJS.Signals | 0) => {
          if (sig === 0) {
            probes++;
            if (probes > aliveFor) throw new Error('ESRCH');
            return;
          }
          sent.push(String(sig));
        },
        sleep: () => {},
      },
    };
  }

  test('SIGTERM alone is enough when the process exits', () => {
    const r = recorder(0); // first liveness probe already reports gone
    expect(terminatePid(1234, 3000, r.deps)).toBe(true);
    expect(r.sent).toEqual(['SIGTERM']);
  });

  test('escalates to SIGKILL when SIGTERM is ignored', () => {
    // The riskiest line in the change: it had no seam and no test.
    const r = recorder(Number.MAX_SAFE_INTEGER); // never dies
    const gone = terminatePid(1234, 0, r.deps); // zero grace: straight to escalation
    expect(r.sent).toEqual(['SIGTERM', 'SIGKILL']);
    expect(gone).toBe(false); // still alive after SIGKILL -> reported as failure
  });

  test('a process already gone is success, not an error', () => {
    const deps = {
      signal: () => {
        const e = new Error('no such process') as NodeJS.ErrnoException;
        e.code = 'ESRCH';
        throw e;
      },
      sleep: () => {},
    };
    expect(terminatePid(1234, 3000, deps)).toBe(true);
  });

  test('a signal we are not allowed to send is NOT reported as stopped', () => {
    const deps = {
      signal: () => {
        const e = new Error('operation not permitted') as NodeJS.ErrnoException;
        e.code = 'EPERM';
        throw e;
      },
      sleep: () => {},
    };
    expect(terminatePid(1234, 3000, deps)).toBe(false);
  });
});

describe('stopSessionDaemons (#859)', () => {
  test('counts only the daemons that actually stopped', () => {
    // The count feeds the exit code: "remi stop --all && echo ok" must not
    // print ok while a daemon is still running.
    const stubborn = 200;
    const deps = {
      signal: (pid: number, sig: NodeJS.Signals | 0) => {
        if (pid === stubborn) return; // alive to every probe, ignores every signal
        const e = new Error('gone') as NodeJS.ErrnoException;
        e.code = 'ESRCH';
        if (sig === 0) throw e;
      },
      sleep: () => {},
    };
    const stopped = stopSessionDaemons(
      [
        { pid: 100, wsPort: 18765, name: 'a' },
        { pid: stubborn, wsPort: 18766, name: 'b' },
      ],
      deps,
    );
    expect(stopped).toBe(1);
  });
});
