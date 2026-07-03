import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProtocolMessage, UUID } from '@remi/shared';
import { generateId } from '@remi/shared';
import type { MessageAPI } from '../../src/api/message-api.ts';
import { __resetLoggerForTests, configureLogger } from '../../src/cli/logger.ts';
import type { PTYSession } from '../../src/pty/pty-session.ts';
import { SessionBindingStore } from '../../src/session/session-binding-store.ts';
import { SessionRegistryFile } from '../../src/session/session-registry-file.ts';
import { SessionRegistry } from '../../src/session/session-registry.ts';
import { SessionStore } from '../../src/session/session-store.ts';
import {
  type BinderHookEvent,
  TranscriptBinder,
  type TranscriptBinderDeps,
} from '../../src/transcript/transcript-binder.ts';
import { TranscriptDiscovery } from '../../src/transcript/transcript-discovery.ts';
import type { TranscriptWatcher } from '../../src/transcript/transcript-watcher.ts';

/**
 * No-mock unit tests for TranscriptBinder. Real SessionRegistry / SessionStore /
 * SessionBindingStore / SessionRegistryFile on tmp files; a fakePTY capturing
 * submits; sendAndRecord captured into an array. The binder must reproduce the
 * hook-bridge-setup.ts behavior the phase-0 characterization suite pins.
 */

const SID = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789' as UUID;

/** PTYSession fake: isRunning toggles via the closure so tests can "exit" it. */
function fakePTY(submits: string[], state: { running: boolean }): PTYSession {
  return {
    id: generateId(),
    get isRunning() {
      return state.running;
    },
    write: () => {},
    submitInput: async (content: string) => {
      submits.push(content);
    },
    close: async () => {},
  } as unknown as PTYSession;
}

interface MessageApiLog {
  resetCalls: number;
}

function fakeMessageAPI(logRef: MessageApiLog): MessageAPI {
  return {
    handleMessage: () => {},
    handleStatusChange: () => {},
    handleQuestion: () => {},
    reset: () => {
      logRef.resetCalls += 1;
    },
  } as unknown as MessageAPI;
}

describe('TranscriptBinder', () => {
  let tmpDir: string;
  let sessionRegistry: SessionRegistry;
  let sessionStore: SessionStore;
  let bindingStore: SessionBindingStore;
  let liveSessionsRegistry: SessionRegistryFile;
  let transcriptDiscovery: TranscriptDiscovery;
  let transcriptWatchers: Map<UUID, TranscriptWatcher>;
  let transcriptFallbackTimers: Map<UUID, ReturnType<typeof setInterval>>;
  let sent: ProtocolMessage[];
  let ptySubmits: string[];
  let ptyState: { running: boolean };
  let messageApiLog: MessageApiLog;
  let messageApi: MessageAPI;
  let rotationCallbacks: number;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-binder-'));
    sessionRegistry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    sessionStore = new SessionStore(path.join(tmpDir, 'sessions.json'));
    bindingStore = new SessionBindingStore(sessionStore);
    liveSessionsRegistry = new SessionRegistryFile(path.join(tmpDir, 'live-sessions'));
    fs.mkdirSync(liveSessionsRegistry.dirPath, { recursive: true });
    // Point Claude's transcript-dir encoding at our tmp root so the fallback
    // poll's expectedTranscriptPath stays inside tmp (no real ~/.claude touch).
    transcriptDiscovery = new TranscriptDiscovery({ projectsDir: tmpDir });
    transcriptWatchers = new Map();
    transcriptFallbackTimers = new Map();
    sent = [];
    ptySubmits = [];
    ptyState = { running: true };
    messageApiLog = { resetCalls: 0 };
    messageApi = fakeMessageAPI(messageApiLog);
    rotationCallbacks = 0;
    configureLogger({ writeLog: () => {} });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    for (const w of transcriptWatchers.values()) {
      try {
        (w as unknown as { stop: () => void }).stop();
      } catch {
        /* already stopped */
      }
    }
    for (const t of transcriptFallbackTimers.values()) clearInterval(t);
    await sessionRegistry.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function registerSession(): void {
    sessionRegistry.registerSession(SID, tmpDir, fakePTY(ptySubmits, ptyState), messageApi);
  }

  function deps(): TranscriptBinderDeps {
    return {
      sessionRegistry,
      bindingStore,
      liveSessionsRegistry,
      transcriptWatchers,
      transcriptFallbackTimers,
      transcriptDiscovery,
      messageApi,
      sendAndRecord: (m) => sent.push(m),
      currentPort: () => 8765,
      onRotation: () => {
        rotationCallbacks += 1;
      },
    };
  }

  function makeBinder(mode: 'shadow' | 'drive' = 'drive'): TranscriptBinder {
    return new TranscriptBinder(deps(), { sessionId: SID, workingDirectory: tmpDir }, mode);
  }

  /**
   * Write a real transcript file whose head carries Claude's `custom-title`
   * ownership marker `remi:<port>` (what `-n remi:<port>` produces). Returns the
   * path. currentPort() in deps() is 8765, so port 8765 == "owned by us".
   */
  function writeMarkedTranscript(name: string, port: number): string {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(
      p,
      `${JSON.stringify({ type: 'custom-title', customTitle: `remi:${port}`, sessionId: 's' })}\n`,
    );
    return p;
  }

  /** Insert a fake watcher into the map so teardown/stale-replace has a target. */
  function seedWatcher(filePath: string, stopCalls: number[]): void {
    transcriptWatchers.set(SID, {
      filePath,
      stop: () => stopCalls.push(1),
    } as unknown as TranscriptWatcher);
  }

  function rotations(): Array<{
    old: string | undefined;
    new: string;
    path: string;
    reason: string;
  }> {
    return sent
      .filter((m) => m.type === 'session_rotated')
      .map((m) => {
        const r = m as unknown as {
          oldClaudeSessionId?: string;
          newClaudeSessionId: string;
          newTranscriptPath: string;
          reason: string;
        };
        return {
          old: r.oldClaudeSessionId,
          new: r.newClaudeSessionId,
          path: r.newTranscriptPath,
          reason: r.reason,
        };
      });
  }

  // -------------------------------------------------------------------------
  // classify: 3-way + defer
  // -------------------------------------------------------------------------

  describe('classification (3-way + defer)', () => {
    test('match: first event with no lock locks and starts a watcher', () => {
      registerSession();
      const binder = makeBinder();
      const ev: BinderHookEvent = {
        session_id: 'claude-A',
        transcript_path: path.join(tmpDir, 'a.jsonl'),
        hook_event_name: 'SessionStart',
      };
      const decision = binder.decide(ev);
      expect(decision.classification).toBe('match');
      // Re-run via the drive path (fresh binder so state is clean).
      const driver = makeBinder();
      driver.onHookEvent(ev);
      expect(transcriptWatchers.has(SID)).toBe(true);
      expect(driver.snapshot().claudeSessionId).toBe('claude-A');
      // First-init is not a rotation: no emit.
      expect(rotations()).toHaveLength(0);
    });

    test('foreign: a different session_id while our PTY is alive is dropped', () => {
      registerSession();
      const binder = makeBinder();
      // Lock on A.
      binder.onHookEvent({ session_id: 'claude-A', transcript_path: path.join(tmpDir, 'a.jsonl') });
      const before = transcriptWatchers.get(SID)?.filePath;
      // A sibling/subagent id arrives while PTY runs.
      const d = binder.decide({
        session_id: 'claude-FOREIGN',
        transcript_path: path.join(tmpDir, 'f.jsonl'),
      });
      expect(d.classification).toBe('foreign');
      binder.onHookEvent({
        session_id: 'claude-FOREIGN',
        transcript_path: path.join(tmpDir, 'f.jsonl'),
      });
      // Binding + watcher unchanged.
      expect(binder.snapshot().claudeSessionId).toBe('claude-A');
      expect(transcriptWatchers.get(SID)?.filePath).toBe(before);
    });

    // -----------------------------------------------------------------------
    // Stale-lock recovery via the port marker (#518)
    // -----------------------------------------------------------------------

    test('reclaim: a "foreign" event whose transcript owns our port marker re-adopts (drive)', () => {
      registerSession();
      const binder = makeBinder();
      // Lock on a STALE id (simulates a mid-session attach / dead prior session).
      binder.onHookEvent({
        session_id: 'claude-STALE',
        transcript_path: path.join(tmpDir, 'stale.jsonl'),
      });
      expect(binder.snapshot().claudeSessionId).toBe('claude-STALE');

      // The live session arrives; its transcript carries OUR marker (remi:8765).
      const livePath = writeMarkedTranscript('live.jsonl', 8765);
      binder.onHookEvent({ session_id: 'claude-LIVE', transcript_path: livePath });

      // Re-adopted, not dropped: lock moved, rotation announced, watcher re-pointed.
      expect(binder.snapshot().claudeSessionId).toBe('claude-LIVE');
      expect(transcriptWatchers.get(SID)?.filePath).toBe(livePath);
      const rs = rotations();
      expect(rs).toHaveLength(1);
      expect(rs[0]?.new).toBe('claude-LIVE');
    });

    test('reclaim: decide() reports restart (not foreign) for an owned-marker event', () => {
      registerSession();
      const binder = makeBinder();
      binder.onHookEvent({
        session_id: 'claude-STALE',
        transcript_path: path.join(tmpDir, 'stale.jsonl'),
      });
      const d = binder.decide({
        session_id: 'claude-LIVE',
        transcript_path: writeMarkedTranscript('live.jsonl', 8765),
      });
      expect(d.classification).toBe('restart');
    });

    test('no reclaim: a foreign transcript owning a DIFFERENT port stays foreign (sibling isolation)', () => {
      registerSession();
      const binder = makeBinder();
      binder.onHookEvent({
        session_id: 'claude-STALE',
        transcript_path: path.join(tmpDir, 'stale.jsonl'),
      });
      // A genuine sibling: its transcript carries the sibling's port (9999), not ours.
      const siblingPath = writeMarkedTranscript('sibling.jsonl', 9999);
      const d = binder.decide({ session_id: 'claude-SIBLING', transcript_path: siblingPath });
      expect(d.classification).toBe('foreign');
      binder.onHookEvent({ session_id: 'claude-SIBLING', transcript_path: siblingPath });
      expect(binder.snapshot().claudeSessionId).toBe('claude-STALE'); // unchanged
      expect(rotations()).toHaveLength(0);
    });

    test('admits: owned-marker event is admitted despite a disagreeing lock; sibling is not', () => {
      registerSession();
      const binder = makeBinder();
      binder.onHookEvent({
        session_id: 'claude-STALE',
        transcript_path: path.join(tmpDir, 'stale.jsonl'),
      });
      // Owns our marker -> admitted even though session_id != lock.
      expect(
        binder.admits({
          session_id: 'claude-LIVE',
          transcript_path: writeMarkedTranscript('live.jsonl', 8765),
        }),
      ).toBe(true);
      // Sibling port -> rejected.
      expect(
        binder.admits({
          session_id: 'claude-SIBLING',
          transcript_path: writeMarkedTranscript('sibling.jsonl', 9999),
        }),
      ).toBe(false);
      // Lock match -> admitted (no marker needed).
      expect(
        binder.admits({
          session_id: 'claude-STALE',
          transcript_path: path.join(tmpDir, 's.jsonl'),
        }),
      ).toBe(true);
    });

    test('restart: a different session_id after PTY exited classifies restart', () => {
      registerSession();
      const binder = makeBinder();
      binder.onHookEvent({ session_id: 'claude-A', transcript_path: path.join(tmpDir, 'a.jsonl') });
      // PTY exits -> main is gone.
      ptyState.running = false;
      const d = binder.decide({
        session_id: 'claude-B',
        transcript_path: path.join(tmpDir, 'b.jsonl'),
      });
      expect(d.classification).toBe('restart');
    });

    test('defer: sibling present + no ownership marker defers first-adopt (no lock, no watcher)', () => {
      registerSession();
      // Live sibling in the same dir.
      fs.writeFileSync(
        path.join(liveSessionsRegistry.dirPath, 'sib.json'),
        JSON.stringify({
          sessionId: 'sib-1',
          pid: process.pid,
          wsPort: 18999,
          hookPort: 18001,
          projectPath: tmpDir,
          name: 'sib',
          startedAt: new Date().toISOString(),
        }),
      );
      const binder = makeBinder();
      // Transcript carries no remi:<port> marker -> ownership unproven.
      const ev: BinderHookEvent = {
        session_id: 'claude-A',
        transcript_path: path.join(tmpDir, 'a.jsonl'),
      };
      const d = binder.decide(ev);
      expect(d.classification).toBe('defer');
      binder.onHookEvent(ev);
      expect(binder.snapshot().claudeSessionId).toBeNull();
      expect(transcriptWatchers.has(SID)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // hasSiblingInDir tilde/absolute normalization (#674)
  // -------------------------------------------------------------------------

  describe('hasSiblingInDir projectPath normalization (#674)', () => {
    test('sibling with a tilde-form projectPath is still detected against an absolute workingDirectory', () => {
      registerSession();
      const ourDir = path.join(os.homedir(), 'remi-674-test-nemar-cli');
      // The sibling's live-sessions entry carries an unexpanded `~` form of
      // the same directory -- the exact shape a pre-fix daemon persisted
      // live (#674). Before normalizing both sides, the plain string
      // equality in hasSiblingInDir() would miss this match entirely.
      fs.writeFileSync(
        path.join(liveSessionsRegistry.dirPath, 'sib.json'),
        JSON.stringify({
          sessionId: 'sib-1',
          pid: process.pid,
          wsPort: 18999,
          hookPort: 18001,
          projectPath: '~/remi-674-test-nemar-cli',
          name: 'sib',
          startedAt: new Date().toISOString(),
        }),
      );
      const binder = new TranscriptBinder(
        deps(),
        { sessionId: SID, workingDirectory: ourDir },
        'drive',
      );
      // No ownership marker -> with the sibling detected, this must defer.
      const ev: BinderHookEvent = {
        session_id: 'claude-A',
        transcript_path: path.join(tmpDir, 'a.jsonl'),
      };
      expect(binder.decide(ev).classification).toBe('defer');
    });

    test('sibling with an absolute projectPath is still detected against a tilde-equivalent workingDirectory', () => {
      registerSession();
      const absoluteSiblingDir = path.join(os.homedir(), 'remi-674-test-nemar-cli-2');
      fs.writeFileSync(
        path.join(liveSessionsRegistry.dirPath, 'sib.json'),
        JSON.stringify({
          sessionId: 'sib-1',
          pid: process.pid,
          wsPort: 18999,
          hookPort: 18001,
          projectPath: absoluteSiblingDir,
          name: 'sib',
          startedAt: new Date().toISOString(),
        }),
      );
      const binder = new TranscriptBinder(
        deps(),
        { sessionId: SID, workingDirectory: '~/remi-674-test-nemar-cli-2' },
        'drive',
      );
      const ev: BinderHookEvent = {
        session_id: 'claude-A',
        transcript_path: path.join(tmpDir, 'a.jsonl'),
      };
      expect(binder.decide(ev).classification).toBe('defer');
    });
  });

  // -------------------------------------------------------------------------
  // rotation ordering
  // -------------------------------------------------------------------------

  describe('rotation ordering (#438)', () => {
    test('rotate() ordering: teardown -> onRotation -> emit -> store update -> bind', () => {
      registerSession();
      sessionStore.save({
        remiSessionId: SID,
        claudeSessionId: 'claude-A',
        projectPath: tmpDir,
        port: 8765,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        exitedAt: null,
        exitCode: null,
      });
      const binder = makeBinder();
      // First event adopts A from the store + starts a watcher.
      binder.onHookEvent({ session_id: 'claude-A', transcript_path: path.join(tmpDir, 'a.jsonl') });
      expect(binder.snapshot().claudeSessionId).toBe('claude-A');

      const stopCalls: number[] = [];
      seedWatcher(path.join(tmpDir, 'a.jsonl'), stopCalls);
      const resetsBefore = messageApiLog.resetCalls;

      // PTY exits so the next different id classifies restart.
      ptyState.running = false;
      binder.onHookEvent({ session_id: 'claude-B', transcript_path: path.join(tmpDir, 'b.jsonl') });

      // teardown stopped the old watcher + reset messageApi.
      expect(stopCalls.length).toBeGreaterThanOrEqual(1);
      expect(messageApiLog.resetCalls).toBeGreaterThan(resetsBefore);
      // onRotation injected callback fired.
      expect(rotationCallbacks).toBeGreaterThanOrEqual(1);
      // exactly one session_rotated, store + lock advanced to B.
      expect(rotations()).toEqual([
        { old: 'claude-A', new: 'claude-B', path: path.join(tmpDir, 'b.jsonl'), reason: 'restart' },
      ]);
      expect(sessionStore.findByRemiSessionId(SID)?.claudeSessionId).toBe('claude-B');
      expect(binder.snapshot().claudeSessionId).toBe('claude-B');
    });

    test('path-less restart emits NOTHING and resets the lock without rebinding', () => {
      registerSession();
      sessionStore.save({
        remiSessionId: SID,
        claudeSessionId: 'claude-A',
        projectPath: tmpDir,
        port: 8765,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        exitedAt: null,
        exitCode: null,
      });
      const binder = makeBinder();
      binder.onHookEvent({ session_id: 'claude-A', transcript_path: path.join(tmpDir, 'a.jsonl') });
      ptyState.running = false;
      // Restart event without a transcript_path: the old code nulls the lock and
      // returns BEFORE the store write (initFromHookEvent :353 then :370). The
      // binder must match: no emit, lock null, store unchanged at claude-A.
      binder.onHookEvent({ session_id: 'claude-B' });
      expect(rotations()).toHaveLength(0);
      expect(binder.snapshot().claudeSessionId).toBeNull();
      expect(sessionStore.findByRemiSessionId(SID)?.claudeSessionId).toBe('claude-A');
    });

    test('#451: restart with a live sibling + unmarked transcript defers (no watcher, no store write)', () => {
      // The blocker the rotation reviewer caught: a genuine `restart`
      // classification (PTY exited) with a co-located live sibling and a
      // transcript that carries NO remi:<port> marker must DEFER — emit the
      // rotation (old emits before the guard) but NOT start a watcher or rebind
      // the store, leaving the fallback poll to adopt. The old code reaches the
      // sibling-defer gate because the restart branch nulls the lock first.
      registerSession();
      sessionStore.save({
        remiSessionId: SID,
        claudeSessionId: 'claude-A',
        projectPath: tmpDir,
        port: 8765,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        exitedAt: null,
        exitCode: null,
      });
      const binder = makeBinder();
      binder.onHookEvent({ session_id: 'claude-A', transcript_path: path.join(tmpDir, 'a.jsonl') });
      expect(sessionStore.findByRemiSessionId(SID)?.claudeSessionId).toBe('claude-A');

      // Seed a live sibling in the same project dir (different port + alive pid).
      const sibFile = path.join(liveSessionsRegistry.dirPath, 'sibling.json');
      fs.mkdirSync(liveSessionsRegistry.dirPath, { recursive: true });
      fs.writeFileSync(
        sibFile,
        JSON.stringify({
          sessionId: 'sibling-session',
          pid: process.pid,
          wsPort: 18999,
          hookPort: 18000,
          projectPath: tmpDir,
          name: 'sibling',
          startedAt: new Date().toISOString(),
        }),
      );

      ptyState.running = false; // PTY exited -> a different id classifies 'restart'
      // The rotated transcript (b.jsonl) has NO custom-title marker -> ownership
      // unproven -> with a live sibling present, defer.
      fs.writeFileSync(path.join(tmpDir, 'b.jsonl'), '{"type":"user"}\n');
      binder.onHookEvent({ session_id: 'claude-B', transcript_path: path.join(tmpDir, 'b.jsonl') });

      // Emitted the rotation (old emits before the guard), but DEFERRED the bind:
      expect(rotations()).toHaveLength(1);
      expect(binder.snapshot().claudeSessionId).toBeNull(); // lock not latched to the sibling's id
      expect(sessionStore.findByRemiSessionId(SID)?.claudeSessionId).toBe('claude-A'); // store not rebound
      expect(transcriptWatchers.has(SID)).toBe(false); // no watcher started on the unproven transcript
    });

    test('golden master: multi-rotation control-plane sequence + final binding', () => {
      registerSession();
      sessionStore.save({
        remiSessionId: SID,
        claudeSessionId: 'claude-1',
        projectPath: tmpDir,
        port: 8765,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        exitedAt: null,
        exitCode: null,
      });
      const binder = makeBinder();
      const t1 = path.join(tmpDir, 'm1.jsonl');
      const t2 = path.join(tmpDir, 'm2.jsonl');
      const t3 = path.join(tmpDir, 'm3.jsonl');

      // Mirror the hook-bridge driver: SessionStart pre-empt then onHookEvent.
      const fire = (id: string, p: string) => {
        const ev = { session_id: id, transcript_path: p, hook_event_name: 'SessionStart' };
        binder.preemptOnSessionStart(ev);
        binder.onHookEvent(ev);
      };
      fire('claude-1', t1);
      fire('claude-2', t2);
      fire('claude-3', t3);

      expect(rotations()).toEqual([
        { old: 'claude-1', new: 'claude-2', path: t2, reason: 'restart' },
        { old: 'claude-2', new: 'claude-3', path: t3, reason: 'restart' },
      ]);
      expect(sessionStore.findByRemiSessionId(SID)?.claudeSessionId).toBe('claude-3');
    });
  });

  // -------------------------------------------------------------------------
  // emitRotated idempotency
  // -------------------------------------------------------------------------

  describe('emitRotated idempotency (#438 scalar gate)', () => {
    test('re-emit of the same id does not duplicate the rotation', () => {
      registerSession();
      const binder = makeBinder();
      const fire = (id: string, p: string) => {
        const ev = { session_id: id, transcript_path: p, hook_event_name: 'SessionStart' };
        binder.preemptOnSessionStart(ev);
        binder.onHookEvent(ev);
      };
      fire('claude-A', path.join(tmpDir, 'a.jsonl'));
      fire('claude-B', path.join(tmpDir, 'b.jsonl'));
      // A duplicate SessionStart for B (e.g. coalesced replay): same id, must
      // not re-emit. preempt is a no-op (same id), onHookEvent classifies match.
      fire('claude-B', path.join(tmpDir, 'b.jsonl'));
      expect(rotations()).toEqual([
        { old: 'claude-A', new: 'claude-B', path: path.join(tmpDir, 'b.jsonl'), reason: 'restart' },
      ]);
    });

    test('A->B->A re-resume emits A->B, B->A, and NOT a duplicate A->B', () => {
      registerSession();
      const binder = makeBinder();
      const aPath = path.join(tmpDir, 'a.jsonl');
      const bPath = path.join(tmpDir, 'b.jsonl');
      const fire = (id: string, p: string) => {
        const ev = { session_id: id, transcript_path: p, hook_event_name: 'SessionStart' };
        binder.preemptOnSessionStart(ev);
        binder.onHookEvent(ev);
      };
      fire('claude-A', aPath); // first-init, no emit
      fire('claude-B', bPath); // A->B
      fire('claude-A', aPath); // B->A re-resume
      expect(rotations()).toEqual([
        { old: 'claude-A', new: 'claude-B', path: bPath, reason: 'restart' },
        { old: 'claude-B', new: 'claude-A', path: aPath, reason: 'restart' },
      ]);
      // The scalar gate now holds A; a coalesced replay of A must NOT re-emit.
      fire('claude-A', aPath);
      expect(rotations()).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // store-raced zero-emit (#430)
  // -------------------------------------------------------------------------

  describe('store-raced zero-emit (#430 tripwire)', () => {
    test('store already at the new id: 0 session_rotated but binding advances', () => {
      registerSession();
      const binder = makeBinder();
      // Lock on A.
      binder.onHookEvent({ session_id: 'claude-A', transcript_path: path.join(tmpDir, 'a.jsonl') });

      // Fallback races the store to B before the SessionStart for B.
      sessionStore.save({
        remiSessionId: SID,
        claudeSessionId: 'claude-B',
        projectPath: tmpDir,
        port: 8765,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        exitedAt: null,
        exitCode: null,
      });

      // SessionStart for B arrives; adopt pulls B -> classify 'match' ->
      // tripwire (currentBoundId set) -> ensureWatching -> return BEFORE emit.
      binder.onHookEvent({ session_id: 'claude-B', transcript_path: path.join(tmpDir, 'b.jsonl') });

      expect(rotations()).toHaveLength(0);
      // But the binding DID advance to B.
      expect(binder.snapshot().claudeSessionId).toBe('claude-B');
    });
  });

  // -------------------------------------------------------------------------
  // onSessionEnd
  // -------------------------------------------------------------------------

  describe('onSessionEnd sets mainSessionEnded', () => {
    test('matching id: a subsequent different-id event classifies restart not foreign (PTY still running)', () => {
      registerSession();
      const binder = makeBinder();
      binder.onHookEvent({ session_id: 'claude-A', transcript_path: path.join(tmpDir, 'a.jsonl') });
      expect(ptyState.running).toBe(true);

      // SessionEnd for our locked id -> mainSessionEnded = true.
      binder.onSessionEnd({ session_id: 'claude-A' });

      // PTY is STILL running, but because mainSessionEnded is set, the next
      // different id is a restart (clean-exit restart), not foreign.
      const d = binder.decide({
        session_id: 'claude-B',
        transcript_path: path.join(tmpDir, 'b.jsonl'),
      });
      expect(d.classification).toBe('restart');
    });

    test('foreign id: SessionEnd for a non-matching id does NOT set the flag', () => {
      registerSession();
      const binder = makeBinder();
      binder.onHookEvent({ session_id: 'claude-A', transcript_path: path.join(tmpDir, 'a.jsonl') });

      // SessionEnd from a sibling/subagent (different id) must not unlock us.
      binder.onSessionEnd({ session_id: 'claude-OTHER' });

      // PTY running + flag NOT set -> a different id is still foreign.
      const d = binder.decide({
        session_id: 'claude-B',
        transcript_path: path.join(tmpDir, 'b.jsonl'),
      });
      expect(d.classification).toBe('foreign');
    });

    // The two tests above only exercise decide() (read-only) after
    // onSessionEnd. Neither drives the REAL bind/rotate path (onHookEvent),
    // so neither proves SessionEnd actually triggers a rotation end to end
    // (#470 review gap).
    test('SessionEnd(A) then a real hook event for a new id drives rotate(): emits + rebinds + swaps the watcher (#438)', () => {
      registerSession();
      sessionStore.save({
        remiSessionId: SID,
        claudeSessionId: 'claude-A',
        projectPath: tmpDir,
        port: 8765,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        exitedAt: null,
        exitCode: null,
      });
      const binder = makeBinder();
      const aPath = path.join(tmpDir, 'a.jsonl');
      const bPath = path.join(tmpDir, 'b.jsonl');
      binder.onHookEvent({ session_id: 'claude-A', transcript_path: aPath });
      expect(binder.snapshot().claudeSessionId).toBe('claude-A');
      expect(transcriptWatchers.get(SID)?.filePath).toBe(aPath);

      // Clean exit: SessionEnd for our locked id sets mainSessionEnded, WITHOUT
      // the PTY ever exiting (ptyState.running stays true for this whole test) —
      // unlike the "rotation ordering" suite above, which forces restart via
      // ptyState.running = false. This is the OTHER real trigger for a restart
      // classification, and it must drive the same rotate() path end to end.
      binder.onSessionEnd({ session_id: 'claude-A' });
      expect(ptyState.running).toBe(true);

      // The REAL bind/rotate path — not decide() — for a genuinely new Claude
      // session under the same PTY.
      binder.onHookEvent({ session_id: 'claude-B', transcript_path: bPath });

      expect(rotations()).toEqual([
        { old: 'claude-A', new: 'claude-B', path: bPath, reason: 'restart' },
      ]);
      expect(sessionStore.findByRemiSessionId(SID)?.claudeSessionId).toBe('claude-B');
      expect(binder.snapshot().claudeSessionId).toBe('claude-B');
      expect(transcriptWatchers.get(SID)?.filePath).toBe(bPath);
    });

    test('rotate() resets mainSessionEnded: a foreign id right after a rotation is dropped, not re-adopted as restart (#470 regression guard)', () => {
      registerSession();
      const binder = makeBinder();
      binder.onHookEvent({ session_id: 'claude-A', transcript_path: path.join(tmpDir, 'a.jsonl') });
      binder.onSessionEnd({ session_id: 'claude-A' });
      binder.onHookEvent({ session_id: 'claude-B', transcript_path: path.join(tmpDir, 'b.jsonl') });
      expect(binder.snapshot().claudeSessionId).toBe('claude-B');
      const rotationsBefore = rotations().length;

      // A THIRD, DISTINCT id arrives right after the rotation, PTY still
      // running. rotate() (transcript-binder.ts) must reset mainSessionEnded
      // to false when it rebinds to B; if it did not, the stale `true` left
      // over from SessionEnd(A) would still be set and this event would wrongly
      // classify 'restart', hijacking the lock instead of being dropped. A
      // same-id replay of B would NOT catch this regression — it short-circuits
      // to 'match' before mainSessionEnded is ever consulted — so the id here
      // must be distinct from both A and B.
      const d = binder.decide({
        session_id: 'claude-C',
        transcript_path: path.join(tmpDir, 'c.jsonl'),
      });
      expect(d.classification).toBe('foreign');

      binder.onHookEvent({ session_id: 'claude-C', transcript_path: path.join(tmpDir, 'c.jsonl') });
      expect(binder.snapshot().claudeSessionId).toBe('claude-B'); // unchanged
      expect(rotations()).toHaveLength(rotationsBefore); // no new rotation
    });
  });

  // -------------------------------------------------------------------------
  // close()
  // -------------------------------------------------------------------------

  describe('close()', () => {
    test('clears the watcher AND the fallback timer', () => {
      registerSession();
      const binder = makeBinder();
      const stopCalls: number[] = [];
      seedWatcher(path.join(tmpDir, 'a.jsonl'), stopCalls);
      const timer = setInterval(() => {}, 100000);
      transcriptFallbackTimers.set(SID, timer);

      binder.close();

      expect(stopCalls.length).toBe(1);
      expect(transcriptWatchers.has(SID)).toBe(false);
      expect(transcriptFallbackTimers.has(SID)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // decide() purity
  // -------------------------------------------------------------------------

  describe('decide() purity', () => {
    test('decide performs NO external effect (no send, no store write, no watcher)', () => {
      registerSession();
      const binder = makeBinder();
      const storeBefore = sessionStore.findByRemiSessionId(SID)?.claudeSessionId ?? null;

      // A restart-shaped scenario (which on the drive path WOULD emit + write).
      binder.onHookEvent({ session_id: 'claude-A', transcript_path: path.join(tmpDir, 'a.jsonl') });
      // Snapshot external state after the legitimate drive call.
      const sentAfterDrive = sent.length;
      const watcherAfterDrive = transcriptWatchers.has(SID);
      const rotCbAfterDrive = rotationCallbacks;
      const resetsAfterDrive = messageApiLog.resetCalls;
      // Clear the binding store write the drive path made, to detect a fresh one.
      const storeAfterDrive = sessionStore.findByRemiSessionId(SID)?.claudeSessionId ?? null;

      ptyState.running = false;
      // Now call decide() for a rotation. It must NOT send, write, or start.
      const d = binder.decide({
        session_id: 'claude-B',
        transcript_path: path.join(tmpDir, 'b.jsonl'),
      });
      expect(d.classification).toBe('restart');
      expect(d.wouldEmitRotation).toBe(true);
      expect(d.wouldStartWatcher).toBe(true);
      expect(d.boundIdAfter).toBe('claude-B');

      // No NEW external effect from decide().
      expect(sent.length).toBe(sentAfterDrive); // no send
      expect(transcriptWatchers.has(SID)).toBe(watcherAfterDrive); // no watcher change
      expect(rotationCallbacks).toBe(rotCbAfterDrive); // onRotation not called
      expect(messageApiLog.resetCalls).toBe(resetsAfterDrive); // no teardown/reset
      // Store still holds the drive-path value, NOT a decide() write to B.
      expect(sessionStore.findByRemiSessionId(SID)?.claudeSessionId ?? null).toBe(storeAfterDrive);
      expect(storeBefore).toBeNull();
    });

    test('decide advances internal state so successive calls track rotations', () => {
      registerSession();
      const binder = makeBinder();
      // Pure decisions only.
      const d1 = binder.decide({
        session_id: 'claude-A',
        transcript_path: path.join(tmpDir, 'a.jsonl'),
      });
      expect(d1.classification).toBe('match');
      expect(d1.boundIdAfter).toBe('claude-A');
      expect(d1.wouldEmitRotation).toBe(false); // first-init

      ptyState.running = false;
      const d2 = binder.decide({
        session_id: 'claude-B',
        transcript_path: path.join(tmpDir, 'b.jsonl'),
      });
      expect(d2.classification).toBe('restart');
      expect(d2.boundIdAfter).toBe('claude-B');
      expect(d2.wouldEmitRotation).toBe(true);

      // Re-decide the same B (coalesced replay): scalar gate suppresses emit.
      const d3 = binder.decide({
        session_id: 'claude-B',
        transcript_path: path.join(tmpDir, 'b.jsonl'),
      });
      expect(d3.wouldEmitRotation).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // start() shadow vs drive
  // -------------------------------------------------------------------------

  describe('start() mode behavior', () => {
    test('shadow mode start() is a no-op (no fallback timer)', () => {
      registerSession();
      const binder = makeBinder('shadow');
      binder.start('claude-A');
      expect(transcriptFallbackTimers.has(SID)).toBe(false);
    });

    test('drive mode start() arms the fallback poll', () => {
      registerSession();
      const binder = makeBinder('drive');
      binder.start('claude-A');
      expect(transcriptFallbackTimers.has(SID)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // ensureWatching idempotency + self-heal
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Re-arming rotation dir-poll (#452 no-hooks rotation)
  // -------------------------------------------------------------------------

  describe('rotation dir-poll (#452 no-hooks rotation)', () => {
    /** The dir the rotation poll re-stats (Claude's encoded project dir). */
    function rotationDir(): string {
      return transcriptDiscovery.getProjectTranscriptDir(tmpDir);
    }

    /** Write a transcript file. With `port` it carries a remi:<port> marker. */
    function writeTranscript(claudeId: string, port?: number): string {
      const dir = rotationDir();
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, `${claudeId}.jsonl`);
      const head =
        port === undefined
          ? '{"type":"user","message":{"role":"user","content":"hi"}}\n'
          : `${JSON.stringify({ type: 'custom-title', customTitle: `remi:${port}`, sessionId: claudeId })}\n`;
      fs.writeFileSync(filePath, head);
      return filePath;
    }

    /** A binder with a fast poll cadence for deterministic tests. */
    function makeDriveBinder(): TranscriptBinder {
      return new TranscriptBinder(deps(), { sessionId: SID, workingDirectory: tmpDir }, 'drive', {
        rotationPollIntervalMs: 20,
      });
    }

    test('marker-ready: empty new .jsonl does NOT rotate; once the remi marker is written it DOES', () => {
      registerSession();
      const binder = makeDriveBinder();
      // Lock on A first (our current bind).
      binder.onHookEvent({
        session_id: 'claude-A',
        transcript_path: writeTranscript('claude-A', 8765),
      });
      expect(binder.snapshot().claudeSessionId).toBe('claude-A');
      binder.start('claude-A');

      // A NEW rotation file appears EMPTY (the #452 empty-file edge): the marker
      // is not yet flushed. A poll tick must NOT classify it as a rotation.
      const dir = rotationDir();
      const newPath = path.join(dir, 'claude-B.jsonl');
      fs.writeFileSync(newPath, ''); // zero bytes -> readTranscriptOwnerPort === null
      ptyState.running = false; // PTY exited so a different id would classify restart

      binder.rotationPollTick();
      expect(rotations()).toHaveLength(0);
      expect(binder.snapshot().claudeSessionId).toBe('claude-A'); // unchanged

      // Now Claude flushes the head marker (our port). The next tick rotates.
      fs.writeFileSync(
        newPath,
        `${JSON.stringify({ type: 'custom-title', customTitle: 'remi:8765', sessionId: 'claude-B' })}\n`,
      );
      binder.rotationPollTick();

      expect(rotations()).toEqual([
        { old: 'claude-A', new: 'claude-B', path: newPath, reason: 'restart' },
      ]);
      expect(binder.snapshot().claudeSessionId).toBe('claude-B');
      binder.close();
    });

    test('exactly-once: repeated ticks seeing the same new file rotate only once', () => {
      registerSession();
      const binder = makeDriveBinder();
      binder.onHookEvent({
        session_id: 'claude-A',
        transcript_path: writeTranscript('claude-A', 8765),
      });
      binder.start('claude-A');

      // A fully-flushed rotation file (marker present) appears.
      writeTranscript('claude-B', 8765);
      ptyState.running = false;

      // Drive several ticks; the file persists on disk and is re-listed each time.
      binder.rotationPollTick();
      binder.rotationPollTick();
      binder.rotationPollTick();

      // Despite the poll re-stat'ing the same file every tick, exactly ONE
      // session_rotated crossed the wire (lastAnnouncedRotationId + seen-set).
      expect(rotations()).toEqual([
        {
          old: 'claude-A',
          new: 'claude-B',
          path: path.join(rotationDir(), 'claude-B.jsonl'),
          reason: 'restart',
        },
      ]);
      expect(binder.snapshot().claudeSessionId).toBe('claude-B');
      binder.close();
    });

    test('sibling gate: a new .jsonl carrying a DIFFERENT port marker does NOT rotate us', () => {
      registerSession();
      const binder = makeDriveBinder();
      binder.onHookEvent({
        session_id: 'claude-A',
        transcript_path: writeTranscript('claude-A', 8765),
      });
      binder.start('claude-A');

      // A sibling daemon (port 19999) writes its own fresh transcript into the
      // SHARED project dir. Its marker proves it is the sibling's, not ours.
      writeTranscript('claude-SIB', 19999);
      ptyState.running = false;

      binder.rotationPollTick();
      binder.rotationPollTick(); // a 2nd tick must not change the verdict

      expect(rotations()).toHaveLength(0);
      expect(binder.snapshot().claudeSessionId).toBe('claude-A'); // not rotated
      binder.close();
    });

    test('freshness gate: a STALE same-port transcript (old mtime) does NOT rotate us (#518)', () => {
      registerSession();
      const binder = makeDriveBinder();
      binder.onHookEvent({
        session_id: 'claude-A',
        transcript_path: writeTranscript('claude-A', 8765),
      });
      binder.start('claude-A');

      // A HISTORICAL transcript from a prior run on the SAME port (remi reuses
      // one port per dir, so the dir accumulates our-port transcripts). It
      // carries our marker but is an hour old -> not a live rotation. Without the
      // freshness gate the poll would crawl onto it and strand the live session.
      const stalePath = writeTranscript('claude-OLD', 8765);
      const old = new Date(Date.now() - 3_600_000); // 1h ago (> ROTATION_FRESHNESS_MS)
      fs.utimesSync(stalePath, old, old);
      ptyState.running = false;

      binder.rotationPollTick();
      binder.rotationPollTick();

      expect(rotations()).toHaveLength(0);
      expect(binder.snapshot().claudeSessionId).toBe('claude-A'); // stays on the live bind
      binder.close();
    });

    test('markerless RECENT file is re-polled (never rotates), never permanently dropped', () => {
      registerSession();
      const binder = makeDriveBinder();
      binder.onHookEvent({
        session_id: 'claude-A',
        transcript_path: writeTranscript('claude-A', 8765),
      });
      binder.start('claude-A');

      // A markerless transcript (non-remi / user `-n`). It never proves
      // ownership -> never rotated. Because it stays RECENT it is re-polled
      // (not seen-set), so a later-appearing marker is NOT permanently lost.
      writeTranscript('claude-NOMARK'); // no port -> no remi marker
      ptyState.running = false;

      for (let i = 0; i < 8; i++) binder.rotationPollTick();

      expect(rotations()).toHaveLength(0);
      expect(binder.snapshot().claudeSessionId).toBe('claude-A');
      binder.close();
    });

    test('#452: a SLOW-FLUSH rotation (marker appears after many empty ticks) is NOT dropped', () => {
      registerSession();
      const binder = makeDriveBinder();
      binder.onHookEvent({
        session_id: 'claude-A',
        transcript_path: writeTranscript('claude-A', 8765),
      });
      binder.start('claude-A');

      // The rotated file is created EMPTY and stays empty across MANY ticks (more
      // than the old hard cap of 4) — the slow-flush / transient-EMFILE case the
      // old tick-cap permanently dropped. The dir-poll must keep re-polling.
      const dir = rotationDir();
      const newPath = path.join(dir, 'claude-B.jsonl');
      fs.writeFileSync(newPath, '');
      ptyState.running = false;
      for (let i = 0; i < 10; i++) binder.rotationPollTick();
      expect(rotations()).toHaveLength(0); // no false rotation on the empty edge

      // Claude finally flushes the head marker. Because the candidate was never
      // permanently dropped, the next tick rotates it (the #452 fix).
      fs.writeFileSync(
        newPath,
        `${JSON.stringify({ type: 'custom-title', customTitle: 'remi:8765', sessionId: 'claude-B' })}\n`,
      );
      binder.rotationPollTick();
      expect(rotations()).toEqual([
        { old: 'claude-A', new: 'claude-B', path: newPath, reason: 'restart' },
      ]);
      expect(binder.snapshot().claudeSessionId).toBe('claude-B');
      binder.close();
    });

    test('markerless SETTLED file (mtime past the grace window) is recorded seen', () => {
      registerSession();
      // Short settle window so the test is fast + deterministic.
      const binder = new TranscriptBinder(
        deps(),
        { sessionId: SID, workingDirectory: tmpDir },
        'drive',
        { rotationPollIntervalMs: 20, markerSettleMs: 50 },
      );
      binder.onHookEvent({
        session_id: 'claude-A',
        transcript_path: writeTranscript('claude-A', 8765),
      });
      binder.start('claude-A');

      // A markerless file whose mtime is already well past the settle window: a
      // genuine settled non-remi file we will never own. It is recorded seen so
      // the poll stops re-reading it (bounds the re-stat cost).
      const stale = writeTranscript('claude-NOMARK');
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(stale, old, old);
      ptyState.running = false;

      binder.rotationPollTick();
      expect(rotations()).toHaveLength(0);
      expect(binder.snapshot().claudeSessionId).toBe('claude-A');
      binder.close();
    });

    test('close() clears the dir-poll (no leaked timer/handle after close)', () => {
      registerSession();
      const binder = makeDriveBinder();
      binder.start('claude-A');
      // Drive-mode start armed BOTH the fallback poll and the rotation poll.
      expect(transcriptFallbackTimers.has(SID)).toBe(true);

      binder.close();
      expect(transcriptFallbackTimers.has(SID)).toBe(false);

      // After close, a new fully-marked rotation file must NOT rotate: the poll
      // is torn down, and a late manual tick is inert (mode-guard / dir null).
      writeTranscript('claude-B', 8765);
      ptyState.running = false;
      binder.rotationPollTick();
      expect(rotations()).toHaveLength(0);
    });

    test('shadow mode arms NO dir-poll', () => {
      registerSession();
      const binder = new TranscriptBinder(
        deps(),
        { sessionId: SID, workingDirectory: tmpDir },
        'shadow',
        { rotationPollIntervalMs: 20 },
      );
      binder.start('claude-A');
      // No fallback timer (shadow start is a no-op) AND a manual tick is inert.
      expect(transcriptFallbackTimers.has(SID)).toBe(false);

      writeTranscript('claude-B', 8765);
      ptyState.running = false;
      binder.rotationPollTick();
      expect(rotations()).toHaveLength(0);
    });
  });

  describe('ensureWatching', () => {
    test('idempotent: no-op when a watcher already exists', () => {
      registerSession();
      const binder = makeBinder();
      const stopCalls: number[] = [];
      seedWatcher(path.join(tmpDir, 'a.jsonl'), stopCalls);
      binder.ensureWatching(path.join(tmpDir, 'b.jsonl'), 'match');
      // Existing watcher untouched (still the seeded one, never stopped).
      expect(transcriptWatchers.get(SID)?.filePath).toBe(path.join(tmpDir, 'a.jsonl'));
      expect(stopCalls.length).toBe(0);
    });

    test('self-heal: locked-from-store but watcher gone -> next match event starts it', () => {
      registerSession();
      sessionStore.save({
        remiSessionId: SID,
        claudeSessionId: 'claude-A',
        projectPath: tmpDir,
        port: 8765,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        exitedAt: null,
        exitCode: null,
      });
      const binder = makeBinder();
      expect(transcriptWatchers.has(SID)).toBe(false);
      // A match event from our own Claude with a path self-heals the watcher.
      binder.onHookEvent({
        session_id: 'claude-A',
        transcript_path: path.join(tmpDir, 'a.jsonl'),
        hook_event_name: 'PreToolUse',
      });
      expect(transcriptWatchers.get(SID)?.filePath).toBe(path.join(tmpDir, 'a.jsonl'));
    });

    test('cancels the fallback timer when it starts a watcher', () => {
      registerSession();
      const binder = makeBinder();
      const timer = setInterval(() => {}, 100000);
      transcriptFallbackTimers.set(SID, timer);
      binder.onHookEvent({ session_id: 'claude-A', transcript_path: path.join(tmpDir, 'a.jsonl') });
      expect(transcriptFallbackTimers.has(SID)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // #593: a subagent PermissionRequest that shares our bound transcript must be
  // admitted even when its session_id differs from our lock (parallel/team
  // subagents, empty 00000000 id) and even when the transcript marker is not yet
  // readable — otherwise it is dropped to passthrough and never auto-approved.
  // Covered here without a costly interactive repro: drive `admits` directly.
  // -------------------------------------------------------------------------
  describe('#593 subagent admits — connection-independent ownership', () => {
    function bindMain(mainPath: string): TranscriptBinder {
      registerSession();
      const binder = makeBinder();
      binder.onHookEvent({
        session_id: 'main-claude',
        transcript_path: mainPath,
        hook_event_name: 'SessionStart',
      });
      return binder;
    }

    test('admits a subagent with a DIFFERENT session_id that shares our bound transcript', () => {
      const mainPath = path.join(tmpDir, 'main.jsonl');
      const binder = bindMain(mainPath);
      const admitted = binder.admits({
        session_id: 'subagent-parallel-1',
        agent_id: 'agent-aaaa',
        transcript_path: mainPath,
        hook_event_name: 'PermissionRequest',
      });
      expect(admitted).toBe(true);
    });

    test('admits a subagent with an empty/zero session_id sharing our bound transcript', () => {
      const mainPath = path.join(tmpDir, 'main.jsonl');
      const binder = bindMain(mainPath);
      const admitted = binder.admits({
        session_id: '00000000-0000-0000-0000-000000000000',
        agent_id: 'agent-bbbb',
        transcript_path: mainPath,
        hook_event_name: 'PermissionRequest',
      });
      expect(admitted).toBe(true);
    });

    test("does NOT admit a sibling daemon's subagent (foreign transcript, different port marker)", () => {
      const mainPath = path.join(tmpDir, 'main.jsonl');
      const binder = bindMain(mainPath);
      const siblingPath = writeMarkedTranscript('sibling.jsonl', 9999);
      const admitted = binder.admits({
        session_id: 'sibling-subagent',
        agent_id: 'agent-cccc',
        transcript_path: siblingPath,
        hook_event_name: 'PermissionRequest',
      });
      expect(admitted).toBe(false);
    });

    test('the path shortcut is GATED on agent_id: a foreign NON-subagent event with our (unmarked) path is not admitted', () => {
      const mainPath = path.join(tmpDir, 'main.jsonl');
      const binder = bindMain(mainPath);
      const admitted = binder.admits({
        session_id: 'foreign-main',
        transcript_path: mainPath,
        hook_event_name: 'PermissionRequest',
      });
      expect(admitted).toBe(false);
    });

    test('still admits the main agent (matching session_id), unchanged', () => {
      const mainPath = path.join(tmpDir, 'main.jsonl');
      const binder = bindMain(mainPath);
      const admitted = binder.admits({
        session_id: 'main-claude',
        transcript_path: mainPath,
        hook_event_name: 'PermissionRequest',
      });
      expect(admitted).toBe(true);
    });

    test('admits a subagent in the store-adopt window: lock set, lastTranscriptPath still null', () => {
      // The reviewer's gap: adoptLockFromStore can promote currentBoundId WITHOUT
      // a SessionStart (mid-session attach / daemon restart), so lastTranscriptPath
      // stays null and the exact-path check cannot fire. The basename signal must
      // still admit a subagent sharing the main transcript named <boundId>.jsonl.
      registerSession();
      const binder = makeBinder();
      (binder as unknown as { currentBoundId: string | null }).currentBoundId = 'main-claude';
      const admitted = binder.admits({
        session_id: 'subagent-store-adopt',
        agent_id: 'agent-dddd',
        transcript_path: path.join(tmpDir, 'main-claude.jsonl'),
        hook_event_name: 'PermissionRequest',
      });
      expect(admitted).toBe(true);
    });

    test('store-adopt window stays isolated: a sibling subagent (foreign-named transcript) is not admitted', () => {
      registerSession();
      const binder = makeBinder();
      (binder as unknown as { currentBoundId: string | null }).currentBoundId = 'main-claude';
      const admitted = binder.admits({
        session_id: 'sibling-sub',
        agent_id: 'agent-eeee',
        // named after the SIBLING's id, not ours; the file has no marker either
        transcript_path: path.join(tmpDir, 'sibling-claude.jsonl'),
        hook_event_name: 'PermissionRequest',
      });
      expect(admitted).toBe(false);
    });
  });
});
