/**
 * #888 criterion (iv): replay the real hook-corpus fixture
 * (`fixtures/hook-corpus.jsonl`, 962 redacted real hook events, #931) through
 * the REAL question-lifecycle machinery and assert the store ends up with no
 * #808-class phantom card -- a question left in `QuestionStore` (via
 * `SessionRegistry`) with nothing left that could ever resolve it.
 *
 * NO MOCKS of decision logic (repo rule): every component that decides
 * whether a question is added/removed is the real production class,
 * unmodified -- `HookEventBridge`, `AutoApproveGate`, `QuestionPresenceTracker`,
 * `MessageAPI` (real `QuestionDedup` inside it), `SessionRegistry` /
 * `QuestionStore`, `TranscriptBinder`, all wired through the real
 * `setupHookBridge` (the exact function `cli.ts` calls per session). Two
 * things ARE test doubles, both transport/plumbing only, never decision
 * logic, matching the precedent already established in
 * `tests/cli/session-phases/hook-bridge-setup.test.ts`:
 *   - `ReplayHookServer`: a `.on()`/`.setPermissionResolver()` recorder so
 *     events can be fired as plain synchronous calls instead of real HTTP.
 *     A real `HookServer` was considered (see `hook-server-bridge-integration
 *     .test.ts`'s precedent), but a HELD PermissionRequest's decision promise
 *     can stay pending for `holdTimeoutSec` (real HTTP would either hang the
 *     replay awaiting it, or race two concurrent unawaited fetches with no
 *     ordering guarantee -- the exact nondeterminism a corpus replay must
 *     not have).
 *   - `fakePTY`: `registerSession` requires a `PTYSession`; nothing here
 *     writes to or reads from it (no PTY render events exist in this corpus
 *     at all -- see "Honest limits" below), so a real PTY has nothing to do.
 *
 * `MessageAPI`'s own `onQuestion`/`onStatusChange` callbacks are
 * deliberately narrowed from production's (`message-api-setup.ts`) to just
 * the STORE-relevant side effects (`sessionRegistry.addQuestion` /
 * `.updateStatus`) -- push/APNS delivery and transcript-watcher forceRead
 * are a different subsystem with its own tests; this file is about whether
 * a card is added/removed correctly, not whether it was delivered. Same
 * simplification, same justification, as the sibling hook-bridge-setup test
 * file's own `realMessageApi` option.
 *
 * ## Honest limits (state plainly, per #888's own instruction)
 *
 * - **The corpus contains only REGISTERED events.** Claude Code sends
 *   nothing else (#203 design, restated in `contract-spec.ts`'s own header).
 *   Zero `Elicitation`/`ElicitationResult`/`PermissionDenied` records exist
 *   (registered by #926, after most of this corpus was captured) and zero
 *   `UserPromptSubmit` (registered by #937, after this corpus). This replay
 *   cannot exercise any #808 sub-scenario that depends on those event types
 *   -- there is no captured data for them anywhere, not just here.
 * - **`SessionStart` is absent by design** (#930: Claude Code hard-discards
 *   `http`-type hook registrations for it before dispatch). Its absence is
 *   not a corpus gap.
 * - **No PTY render exists anywhere in this corpus.** Hooks and PTY output
 *   are two separate capture surfaces; `REMI_HOOK_DEBUG` records only the
 *   former. Consequence, load-bearing for what this replay CAN prove:
 *     - A subagent-tagged (`agent_id` present) `PermissionRequest` is PARKED
 *       per ADR 0004 (`QuestionPresenceTracker.parkAwaitingPTY`) and pushed
 *       to the store ONLY if the prompt then renders on the PTY. Since that
 *       never happens here, every one of this corpus's 154 subagent-tagged
 *       `PermissionRequest` records is expected, correctly, to never reach
 *       the store. This replay cannot exercise the subagent-parked #808
 *       shape (a parked-then-rendered card going stale) at all -- it can
 *       only confirm the parked-and-never-rendered case stays silent, which
 *       is the DESIGNED behavior, not a phantom.
 *     - `holdTimeoutSec` is set to the real production default (1800s,
 *       `config.ts`) specifically so a MAIN-context escalation still pushes
 *       via `AutoApproveGate`'s hold/passthrough-push paths (both push
 *       regardless of PTY -- see `escalateAndHold`/`escalatePassthrough`).
 *       That is the ONLY reason this replay can exercise MAIN-context
 *       card lifecycle at all from hook data alone.
 * - **`PreToolUse`/`PostToolUse` are DOWN-SAMPLED in this corpus**
 *   (`build-hook-corpus.ts`: at most 2 kept per (event, tool_name, key-set)
 *   shape group; 72/71 records total against 354 `PermissionRequest`s). A
 *   card whose only resolution signal would have been a matching
 *   `PreToolUse`/`PostToolUse` (`AutoApproveGate.cancelExternallyResolved`)
 *   can therefore look unresolved here purely because the corpus builder
 *   dropped the matching record, not because remi failed to resolve it.
 *   This file does NOT synthesize a matching event to paper over that --
 *   per #888's instruction, a replay of invented data proves nothing. It
 *   instead relies on the two resolution signals `PreToolUse`/`PostToolUse`
 *   down-sampling cannot remove, because they are kept in FULL (`Stop`: 80,
 *   `SubagentStop`: 87, `SessionEnd`: 7): `AutoApproveGate.cancelStale('Stop',
 *   {mainOnly:true})` sweeps every still-open MAIN escalation, and
 *   `cancelStaleForAgent` (SubagentStop) sweeps every still-open escalation
 *   for that exact agent. Those two are the assertions below.
 * - **`StopFailure`-sourced cards are excluded from every assertion here.**
 *   `hook-bridge-setup.ts`'s own `StopFailure` listener comment says so
 *   explicitly: "#799 deliberately does NOT clear open escalations here...
 *   Known residual leak, tracked as #802." Reporting that as a NEW finding
 *   would misrepresent an already-filed, already-understood gap as this
 *   PR's discovery. `source` is unset on a StopFailure question, which is
 *   what every filter below keys on to exclude it.
 *
 * ## A real phantom exists, but this corpus cannot trigger it (filed as #948)
 *
 * Building this harness surfaced a genuine #808-class bug:
 * `AutoApproveGate.cancelStale(reason, {mainOnly:false})` (the SessionEnd /
 * full-teardown path) only releases BINARY holds (`pendingHolds`); a
 * PASSTHROUGH MAIN escalation (multi-choice/design, e.g. `AskUserQuestion`)
 * is tracked only in `openQuestionSignatures`, and the non-mainOnly branch
 * just does `this.openQuestionSignatures.clear()` -- unlike the `mainOnly`
 * (Stop) branch, which routes every survivor through
 * `resolveSupersededQuestion` (-> `sessionRegistry.removeQuestion`). So a
 * passthrough escalation still open when `SessionEnd` fires with NO
 * intervening `Stop` survives in the store forever. `forceRelease` has the
 * identical shape (`openQuestionSignatures.clear()` with no per-entry
 * resolution). Confirmed by an ISOLATED reproduction (not corpus data,
 * `service:null`, `AskUserQuestion` PermissionRequest immediately followed
 * by `SessionEnd`, no `Stop` between): store size 1 before, 1 after.
 *
 * The REPLAY below does not hit this: every session in the current 962-event
 * corpus that reaches a captured `SessionEnd` also has a `Stop` earlier in
 * that same session, and Stop's `mainOnly` sweep (the correct branch) already
 * clears the signature before SessionEnd ever runs. The SessionEnd checkpoint
 * (`Checkpoint 3` below) is therefore currently VACUOUS against this specific
 * corpus -- it is real, correctly-scoped, and will catch a future capture
 * that has this shape, but as of today's fixture it never has a non-empty
 * case to reject. Said plainly rather than left for a reader to discover:
 * the Stop-mainOnly checkpoint (`Checkpoint 1`) is the one doing the work
 * in this corpus, confirmed by mutation (see the PR description for the
 * red/green transcript -- disabling `cancelStale`'s mainOnly sweep turns
 * two of these tests red, naming the exact surviving `AskUserQuestion` card).
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentStatus, Question, UUID } from '@remi/shared';
import { generateId } from '@remi/shared';
import { MessageAPI } from '../../src/api/message-api.ts';
import type { QuestionRegistrationOutcome } from '../../src/api/message-api.ts';
import { QuestionPresenceTracker } from '../../src/api/question-presence-tracker.ts';
import { __resetLoggerForTests, configureLogger } from '../../src/cli/logger.ts';
import type { HookBridgeHandle } from '../../src/cli/session-phases/hook-bridge-setup.ts';
import { setupHookBridge } from '../../src/cli/session-phases/hook-bridge-setup.ts';
import type { HookServer } from '../../src/hooks/index.ts';
import type { PTYSession } from '../../src/pty/pty-session.ts';
import { SessionBindingStore } from '../../src/session/session-binding-store.ts';
import { SessionRegistryFile } from '../../src/session/session-registry-file.ts';
import { SessionRegistry } from '../../src/session/session-registry.ts';
import { SessionStore } from '../../src/session/session-store.ts';
import { TranscriptDiscovery } from '../../src/transcript/index.ts';
import type { TranscriptWatcher } from '../../src/transcript/index.ts';

// ---------------------------------------------------------------------------
// Corpus loading + session grouping
// ---------------------------------------------------------------------------

const CORPUS_PATH = path.join(import.meta.dir, 'fixtures', 'hook-corpus.jsonl');

type CorpusRecord = Record<string, unknown> & { hook_event_name: string };

function loadCorpus(): CorpusRecord[] {
  const raw = fs.readFileSync(CORPUS_PATH, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CorpusRecord);
}

/** Groups by `session_id`, preserving the corpus file's own order within
 *  each group -- the capture file is append-only in arrival order, so a
 *  session's own subsequence is already chronological even though it is
 *  interleaved with other sessions' events in the raw file. Verified by
 *  the "corpus is chronological per session" sanity test below, not just
 *  assumed. */
function groupBySession(records: readonly CorpusRecord[]): Map<string, CorpusRecord[]> {
  const bySession = new Map<string, CorpusRecord[]>();
  for (const record of records) {
    const sid = record['session_id'];
    if (typeof sid !== 'string' || sid.length === 0) continue;
    const list = bySession.get(sid);
    if (list) {
      list.push(record);
    } else {
      bySession.set(sid, [record]);
    }
  }
  return bySession;
}

const CORPUS = loadCorpus();
const SESSIONS = groupBySession(CORPUS);

// ---------------------------------------------------------------------------
// Test doubles -- transport/plumbing ONLY, never decision logic (see module
// doc above for why each exists and what real component it stands in for).
// ---------------------------------------------------------------------------

type HookListener = (input: CorpusRecord) => void;

/**
 * Records `setupHookBridge`'s `.on()`/`.setPermissionResolver()` calls and
 * lets the replay loop fire them as plain synchronous function calls. See
 * the module doc's "NO MOCKS" section for why this stands in for a real
 * `HookServer` here (a live-HTTP replay cannot express "fire this event,
 * but do not wait for a 1800s hold to resolve, and definitely do not race
 * the NEXT event against it").
 */
class ReplayHookServer {
  private readonly listeners = new Map<string, HookListener>();
  private permissionResolver: ((input: CorpusRecord) => Promise<unknown>) | null = null;

  on(event: string, listener: HookListener): () => void {
    this.listeners.set(event, listener);
    return () => this.listeners.delete(event);
  }

  setPermissionResolver(resolver: ((input: CorpusRecord) => Promise<unknown>) | null): void {
    this.permissionResolver = resolver;
  }

  fire(event: string, input: CorpusRecord): void {
    const fn = this.listeners.get(event);
    if (!fn) {
      throw new Error(
        `Corpus replay hit event "${event}", which setupHookBridge does not register a listener for -- either the corpus contains an event outside the 10 registered types the corpus doc says it covers, or setupHookBridge dropped a listener.`,
      );
    }
    fn(input);
  }

  /** Fires the synchronous PermissionRequest resolver. NOT awaited by the
   *  replay loop when a hold is expected to stay open -- see the module doc. */
  firePermission(input: CorpusRecord): Promise<unknown> {
    if (!this.permissionResolver) {
      throw new Error('Corpus replay hit a PermissionRequest with no resolver installed');
    }
    return this.permissionResolver(input);
  }
}

/** `registerSession` requires a `PTYSession`; this replay never renders or
 *  writes to one (see "no PTY render exists anywhere in this corpus" in the
 *  module doc), so every method is inert. */
function fakePTY(): PTYSession {
  return {
    id: generateId(),
    isRunning: true,
    write: () => {},
    submitInput: async () => {},
    close: async () => {},
  } as unknown as PTYSession;
}

/**
 * Real `MessageAPI`, instrumented to record the `QuestionRegistrationOutcome`
 * (#888 criterion iii, PR #945) behind every `handleQuestion` call -- both
 * the tracker's push path (`pushHeldHook` -> `held: true`) and the bridge's
 * direct-emit path for a source-less StopFailure question. `super.handleQuestion`
 * is the REAL implementation; this only observes its return value from
 * outside, the same non-invasive pattern as the sibling test file's
 * `PassthroughTracker extends QuestionPresenceTracker`.
 */
class LoggingMessageAPI extends MessageAPI {
  readonly outcomeLog: Array<{ questionId: UUID; outcome: QuestionRegistrationOutcome }> = [];

  override handleQuestion(
    question: Question,
    opts?: { held?: boolean },
  ): QuestionRegistrationOutcome {
    const outcome = super.handleQuestion(question, opts);
    this.outcomeLog.push({ questionId: question.id, outcome });
    return outcome;
  }
}

// ---------------------------------------------------------------------------
// Replay rig
// ---------------------------------------------------------------------------

interface ReplayRig {
  readonly sessionRegistry: SessionRegistry;
  readonly remiSessionId: UUID;
  readonly hookServer: ReplayHookServer;
  readonly handle: HookBridgeHandle;
  readonly outcomeLog: Array<{ questionId: UUID; outcome: QuestionRegistrationOutcome }>;
  readonly statusLog: AgentStatus[];
  readonly cleanup: () => Promise<void>;
}

function buildReplayRig(): ReplayRig {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-corpus-replay-'));
  const remiSessionId = generateId();
  const sessionRegistry = new SessionRegistry({ orphanTimeoutMs: 60_000 });
  const sessionStore = new SessionStore(path.join(tmpDir, 'sessions.json'));
  const bindingStore = new SessionBindingStore(sessionStore);
  const liveSessionsRegistry = new SessionRegistryFile(path.join(tmpDir, 'live-sessions'));
  fs.mkdirSync(liveSessionsRegistry.dirPath, { recursive: true });
  const transcriptWatchers = new Map<UUID, TranscriptWatcher>();
  const transcriptFallbackTimers = new Map<UUID, ReturnType<typeof setInterval>>();
  const statusLog: AgentStatus[] = [];

  const messageApi = new LoggingMessageAPI(
    { sessionId: remiSessionId, initialBulletId: 1 },
    {
      // Mirrors ONLY the store-relevant half of production's
      // `message-api-setup.ts` onQuestion -- see the module doc.
      onQuestion: (question, opts) => {
        const stamped: Question = opts?.held === true ? { ...question, held: true } : question;
        sessionRegistry.addQuestion(remiSessionId, stamped, stamped.source ?? 'unknown');
      },
      onStatusChange: (status) => {
        statusLog.push(status);
        sessionRegistry.updateStatus(remiSessionId, status);
      },
    },
  );

  const tracker = new QuestionPresenceTracker((q, opts) => messageApi.handleQuestion(q, opts));

  sessionRegistry.registerSession(remiSessionId, tmpDir, fakePTY(), messageApi);

  const hookServer = new ReplayHookServer();

  const handle = setupHookBridge(
    {
      sessionRegistry,
      bindingStore,
      liveSessionsRegistry,
      transcriptWatchers,
      transcriptFallbackTimers,
      // No LLM auto-approve service: every MAIN permission escalates to the
      // user (real `AutoApproveGate.resolvePermission` "no service" branch),
      // and every SUBAGENT permission parks per ADR 0004. Neither is a test
      // stand-in -- both are real, documented gate behaviors for this config.
      autoApproveService: null,
      currentPort: () => 8765,
      transcriptDiscovery: new TranscriptDiscovery(),
      // Production default (config.ts: `hold_timeout = 1800`). See the
      // module doc's "Honest limits" section for why this is required for
      // the replay to exercise MAIN-context card lifecycle at all.
      holdTimeoutSec: 1800,
    },
    {
      hookServer: hookServer as unknown as HookServer,
      sessionId: remiSessionId,
      workingDirectory: tmpDir,
      messageApi,
      sendAndRecord: () => {},
      tracker,
    },
  );

  return {
    sessionRegistry,
    remiSessionId,
    hookServer,
    handle,
    outcomeLog: messageApi.outcomeLog,
    statusLog,
    cleanup: async () => {
      handle.closeBinder();
      // Release any hold still open (production default holdMs=1800000 means
      // a session whose capture window ended mid-hold would otherwise leave
      // an unref'd-but-live timer for the rest of the test run).
      handle.gate.forceRelease('corpus-replay-test-cleanup');
      for (const watcher of transcriptWatchers.values()) {
        try {
          watcher.stop();
        } catch {
          /* not started */
        }
      }
      for (const timer of transcriptFallbackTimers.values()) clearInterval(timer);
      await sessionRegistry.shutdown();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

/** Drop remi's own `_ts` diagnostic field (never part of the Claude Code hook
 *  contract; see `contract-spec.ts`'s `REMI_OWN_FIELDS`) before dispatch. */
function stripOwnFields(record: CorpusRecord): CorpusRecord {
  const { _ts, ...rest } = record as CorpusRecord & { _ts?: unknown };
  void _ts;
  return rest as CorpusRecord;
}

/**
 * Replay ONE corpus event through the rig. `PermissionRequest` is fired
 * without awaiting the returned decision: with `holdTimeoutSec` configured, a
 * binary MAIN escalation's promise can stay pending until a LATER event
 * (Stop/SubagentStop/SessionEnd) resolves it via the gate's own cancelStale
 * sweep -- see `createHold`: the push (`onHeldEscalate`) happens synchronously
 * before the pending promise is ever constructed, so the store-relevant side
 * effect this replay checks has already landed by the time this function
 * returns, with no `await` needed.
 */
function replayEvent(hookServer: ReplayHookServer, rawRecord: CorpusRecord): void {
  const record = stripOwnFields(rawRecord);
  const eventName = record['hook_event_name'];
  if (eventName === 'PermissionRequest') {
    hookServer.firePermission(record).catch(() => {
      // A rejection here would only mean the resolver itself threw, which
      // resolvePermission already guards internally (fails open); nothing
      // for the replay driver to do with it.
    });
    return;
  }
  hookServer.fire(eventName as string, record);
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

/** MAIN-context, permission-request-sourced questions currently in the store
 *  (StopFailure's source-less cards are excluded -- see module doc). */
function mainPermissionQuestions(rig: ReplayRig): Question[] {
  const current = rig.sessionRegistry.getSession(rig.remiSessionId)?.currentQuestions;
  if (!current) return [];
  return [...current.values()].filter(
    (q) => q.agentId === undefined && q.source === 'permission_request',
  );
}

/** Every permission-request-sourced question currently in the store,
 *  main or subagent (StopFailure excluded, same as above). */
function allPermissionQuestions(rig: ReplayRig): Question[] {
  const current = rig.sessionRegistry.getSession(rig.remiSessionId)?.currentQuestions;
  if (!current) return [];
  return [...current.values()].filter((q) => q.source === 'permission_request');
}

function describeQuestion(q: Question): string {
  return `id=${q.id.slice(0, 8)} agentId=${q.agentId?.slice(0, 8) ?? 'main'} held=${q.held ?? false} text="${q.text.slice(0, 80)}"`;
}

function phantomReport(
  label: string,
  corpusSessionId: string,
  checkpointIndex: number,
  totalEvents: number,
  phantoms: readonly Question[],
): string {
  const lines = phantoms.map((q) => `  - ${describeQuestion(q)}`);
  return (
    `${label} for corpus session ${corpusSessionId.slice(0, 8)} ` +
    `(checkpoint after event ${checkpointIndex + 1}/${totalEvents}):\n${lines.join('\n')}`
  );
}

/**
 * #888 criterion (iii): every card currently in the store must be backed by
 * a 'registered' or 'held' `QuestionRegistrationOutcome` -- never 'deduped'.
 * Checked against the LoggingMessageAPI's outcome ledger, not re-derived, so
 * this is a direct check of the #945 contract rather than a re-implementation
 * of its logic.
 */
function assertOutcomeInvariant(rig: ReplayRig, corpusSessionId: string): void {
  const current = rig.sessionRegistry.getSession(rig.remiSessionId)?.currentQuestions;
  const currentIds = current ? [...current.keys()] : [];
  for (const id of currentIds) {
    const entries = rig.outcomeLog.filter((e) => e.questionId === id);
    expect(
      entries.length,
      `session ${corpusSessionId.slice(0, 8)}: question ${id.slice(0, 8)} is in the store with NO recorded registration outcome at all`,
    ).toBeGreaterThan(0);
    const last = entries[entries.length - 1];
    expect(
      last?.outcome.status,
      `session ${corpusSessionId.slice(0, 8)}: question ${id.slice(0, 8)}'s last recorded ` +
        `outcome was '${last?.outcome.status}', but it is still in the store`,
    ).not.toBe('deduped');
  }
  const dedupedIds = new Set(
    rig.outcomeLog.filter((e) => e.outcome.status === 'deduped').map((e) => e.questionId),
  );
  for (const id of dedupedIds) {
    expect(
      current?.has(id) ?? false,
      `session ${corpusSessionId.slice(0, 8)}: question ${id.slice(0, 8)} reported 'deduped' but IS sitting in the store`,
    ).toBe(false);
  }
}

// ---------------------------------------------------------------------------
// Sanity: the corpus grouping assumption this replay depends on
// ---------------------------------------------------------------------------

describe('hook corpus fixture sanity', () => {
  test('corpus is non-trivial and covers the documented 10 event types', () => {
    expect(CORPUS.length).toBeGreaterThan(900);
    const eventTypes = new Set(CORPUS.map((r) => r['hook_event_name']));
    expect(eventTypes).toEqual(
      new Set([
        'SessionEnd',
        'PreToolUse',
        'PostToolUse',
        'SubagentStart',
        'Stop',
        'Notification',
        'SubagentStop',
        'PermissionRequest',
        'PostToolUseFailure',
        'StopFailure',
      ]),
    );
  });

  test('each session group is chronological (_ts non-decreasing)', () => {
    for (const [sid, events] of SESSIONS) {
      let prev = Number.NEGATIVE_INFINITY;
      for (const [i, ev] of events.entries()) {
        const ts = Date.parse(String(ev['_ts']));
        expect(
          Number.isNaN(ts) ? Number.POSITIVE_INFINITY : ts,
          `session ${sid.slice(0, 8)} event ${i} is out of chronological order`,
        ).toBeGreaterThanOrEqual(prev);
        if (!Number.isNaN(ts)) prev = ts;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The replay
// ---------------------------------------------------------------------------

describe('hook corpus replay (#888 criterion iv)', () => {
  for (const [corpusSessionId, events] of SESSIONS) {
    test(`session ${corpusSessionId.slice(0, 8)} (${events.length} events): no #808-class phantom survives its resolution signal`, async () => {
      configureLogger({ writeLog: () => {} });
      const rig = buildReplayRig();
      try {
        events.forEach((event, i) => {
          replayEvent(rig.hookServer, event);

          // Checkpoint 1 (non-downsampled resolution signal): immediately
          // after a Stop where Claude is genuinely idling (not intercepted),
          // AutoApproveGate.cancelStale('Stop', {mainOnly:true}) has just
          // swept EVERY still-open MAIN escalation synchronously. Nothing
          // replayed so far could leave one behind.
          if (event['hook_event_name'] === 'Stop' && event['stop_hook_active'] !== true) {
            const phantoms = mainPermissionQuestions(rig);
            expect(
              phantoms,
              phantomReport(
                'MAIN-context permission card survived a Stop sweep',
                corpusSessionId,
                i,
                events.length,
                phantoms,
              ),
            ).toEqual([]);
          }

          // Checkpoint 2: immediately after a SubagentStop, that exact
          // agent's still-open escalations have just been swept by
          // cancelStaleForAgent. Scoped to the agent that just stopped.
          // Honest note: this checkpoint is currently VACUOUS too, and for a
          // stronger reason than Checkpoint 3 -- a subagent-tagged
          // 'permission_request' question NEVER reaches the store at all in
          // this corpus (ADR 0004 parks it awaiting a PTY render that never
          // comes; see the module doc). Kept as a real, correctly-scoped
          // invariant for when a corpus captures a paired PTY render.
          if (event['hook_event_name'] === 'SubagentStop') {
            const agentId = event['agent_id'];
            if (typeof agentId === 'string' && agentId.length > 0) {
              const current = rig.sessionRegistry.getSession(rig.remiSessionId)?.currentQuestions;
              const phantoms = current
                ? [...current.values()].filter(
                    (q) => q.agentId === agentId && q.source === 'permission_request',
                  )
                : [];
              expect(
                phantoms,
                phantomReport(
                  `subagent ${agentId.slice(0, 8)}'s permission card survived its SubagentStop`,
                  corpusSessionId,
                  i,
                  events.length,
                  phantoms,
                ),
              ).toEqual([]);
            }
          }
        });

        // Checkpoint 3: a SessionEnd is unambiguous -- the session is over,
        // so nothing can EVER resolve a card still open after it. Checked
        // only when the corpus actually captured this session's SessionEnd
        // (not fabricated for sessions still live at capture time -- #888's
        // instruction against synthesizing events to fill a corpus hole).
        const last = events[events.length - 1];
        if (last?.['hook_event_name'] === 'SessionEnd') {
          const phantoms = allPermissionQuestions(rig);
          expect(
            phantoms,
            phantomReport(
              'permission card survived SessionEnd',
              corpusSessionId,
              events.length - 1,
              events.length,
              phantoms,
            ),
          ).toEqual([]);
        }

        assertOutcomeInvariant(rig, corpusSessionId);
      } finally {
        __resetLoggerForTests();
        await rig.cleanup();
      }
    });
  }
});
