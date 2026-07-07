import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readPidFileLive } from '../../src/cli/daemon-manager.ts';

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
