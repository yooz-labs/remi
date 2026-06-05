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
});
