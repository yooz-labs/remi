/**
 * Question-valued container inventory (#888 criterion ii).
 *
 * Every container in `packages/daemon/src` that tracks state ABOUT a
 * `Question` -- holds `Question` objects directly, or is keyed by a
 * question's id / derived from one -- is enumerated in `REGISTRY` below and
 * classified as one of:
 *
 *   - 'owner'                the card map itself (`QuestionStore`).
 *   - 'pre-card'              state that exists BEFORE a card is registered
 *                             in the store (a stashed hook record, a raw PTY
 *                             parse, an emission gate that decides whether a
 *                             card gets created at all).
 *   - 'post-card-metadata'    bookkeeping ABOUT a card the store already
 *                             owns (a hold, a delivery confirmation, an
 *                             external correlation id) -- not a second,
 *                             competing opinion on whether the question is
 *                             pending.
 *   - 'derived'               a read-only subscriber to the store's own
 *                             `onQuestionsChanged` events; never a source of
 *                             truth, only a mirror.
 *   - 'mixed'                 one container whose entries fall in two of the
 *                             buckets above depending on which code path
 *                             created them (see `openQuestionSignatures`).
 *
 * This list was re-verified against `develop` @ 7bafa22 (2026-07-30) for
 * this issue -- NOT copied from #888's rescope-comment table unchecked. That
 * table was itself already a correction of the original issue body's
 * undercount ("seven" stores), and this pass found it STILL undercounted:
 * five containers below (marked NEW) were not in the rescope comment either.
 * See the PR description for the caller-traced evidence on each.
 *
 * ENFORCEMENT (two layers, both required so a genuinely new container cannot
 * slip in silently):
 *
 *   1. Closed-world scan of the ~10 files known to hold this kind of state
 *      (every container found so far, across two independent audits, lives
 *      in exactly these files -- this is where the bug class keeps
 *      recurring). Every `private` field in these files that is initialized
 *      to `null` / `[]` / `new Map(...)` / `new Set(...)` must appear EITHER
 *      in `REGISTRY` (classified) or in `EXCLUSIONS` (justified as NOT
 *      Question-valued). A field satisfying neither -- e.g. someone adds an
 *      eighth store to `auto-approve-gate.ts` -- fails this test.
 *   2. A repo-wide (not limited to the closed-world file list) scan for
 *      `private` fields whose TYPE literally names `Question` (a
 *      `Map<_, Question>`, `Set<Question>`, or bare `Question | null`
 *      field). This is the net that would catch a wholly new file
 *      introducing a directly Question-typed store outside the closed
 *      world above.
 *
 * Neither layer is a full static-analysis tool -- a container that neither
 * types nor names itself as Question-related (e.g. one keyed by a bare
 * string id with no `Question` in sight) would not be caught by (2), and a
 * new container added outside the ~10 known files would not be caught by
 * (1). Both gaps are accepted: layer (1) covers where this class of bug has
 * actually occurred twice; layer (2) covers the cheap, high-signal case of
 * an obviously-typed new store anywhere. Widening either net further starts
 * flagging the dozens of unrelated Map/Set fields elsewhere in the daemon
 * (session/connection/port bookkeeping) with no way to tell them apart from
 * source text alone -- exactly the kind of question a human has to answer
 * once, by classifying the new field, not a regex.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC_ROOT = join(import.meta.dir, '..', '..', 'src');

type Cls = 'owner' | 'pre-card' | 'post-card-metadata' | 'derived' | 'mixed';

interface Entry {
  readonly file: string; // relative to packages/daemon/src
  readonly field: string;
  readonly cls: Cls;
  readonly note: string;
}

interface ExcludedEntry {
  readonly file: string;
  readonly field: string;
  readonly note: string; // why this is NOT Question-valued
}

/** Every classified Question-valued container. */
const REGISTRY: readonly Entry[] = [
  {
    file: 'session/question-store.ts',
    field: 'map',
    cls: 'owner',
    note: 'The card map itself; single owner of session pendingness (#888 i-b).',
  },
  {
    file: 'api/question-presence-tracker.ts',
    field: 'pending',
    cls: 'pre-card',
    note: 'Hook-derived question stashed by agent, not yet paired with a PTY render or cleared. Agent-keyed because no stable question id exists at park time.',
  },
  {
    file: 'api/question-presence-tracker.ts',
    field: 'awaitingPTY',
    cls: 'pre-card',
    note: 'Subset of pending parked awaiting PTY arbitration (#751); ADR 0004 surface.',
  },
  {
    file: 'api/question-presence-tracker.ts',
    field: 'bufferedDuringEval',
    cls: 'pre-card',
    note: 'PTY prompt buffered while a MAIN auto-approve eval is in flight (#484/#767).',
  },
  {
    file: 'api/question-presence-tracker.ts',
    field: 'armedOrphanQuestion',
    cls: 'pre-card',
    note: 'Candidate for the #712 orphan-prompt debounce timer, before any push decision.',
  },
  {
    file: 'api/question-presence-tracker.ts',
    field: 'arbitratingPTYTexts',
    cls: 'pre-card',
    note: 'NEW, not in the #888 rescope table. Text of parked-render arbitrations in flight (#814); suppresses a same-text echo while the arbiter decides push vs. answered. ADR 0004 surface (arbitrateParkedRender).',
  },
  {
    file: 'api/question-presence-tracker.ts',
    field: 'observedPTYQuestionId',
    cls: 'pre-card',
    note: 'Raw pre-merge PTY-parsed identity (#814), set before any push/buffer/arbitrate decision. Paired with observedPTYText for isPromptCurrent. ADR 0004 surface.',
  },
  {
    file: 'api/question-presence-tracker.ts',
    field: 'observedPTYText',
    cls: 'pre-card',
    note: 'Text half of the #814 raw PTY identity pair; see observedPTYQuestionId.',
  },
  {
    file: 'api/question-presence-tracker.ts',
    field: 'observedRenderOwnedQuestion',
    cls: 'post-card-metadata',
    note: 'Id of the currently-PUSHED render-born question (#888/#920, widened by #1005). Tracks a card the store already owns, to know when to resolve it on a confirmed superseding render. Was `observedHooklessQuestion`, scoped to hookRecord === undefined; that excluded parked subagent escalations, which are hook-BORN but whose hook was answered passthrough at park time (ADR 0004), so the render is their only living evidence and nothing tracked them at all -- they left the store only via lru_eviction. Held cards still never reach here (a held hook means Claude is blocked, not rendering; pushHeldHook is a different trigger).',
  },
  {
    file: 'api/question-presence-tracker.ts',
    field: 'pushedHeldIds',
    cls: 'post-card-metadata',
    note: 'Idempotency guard on an already-pushed held card (#573); set at/after push time.',
  },
  {
    file: 'api/question-dedup.ts',
    field: 'last',
    cls: 'pre-card',
    note: 'QuestionDedup baseline (#409), per agent. Gates MessageAPI.handleQuestion BEFORE sessionRegistry.addQuestion runs (message-api.ts): decides whether a card is created at all.',
  },
  {
    file: 'notifications/push-dedup.ts',
    field: 'last',
    cls: 'post-card-metadata',
    note: 'NEW, not in the #888 rescope table. PushDedup baseline (#409), instantiated as NotificationDispatcher.pushDedup. Gates the APNS push for a question that is ALREADY registered: message-api-setup.ts calls addQuestion (line ~158) before notifications.maybePush (line ~168), so this runs after the card exists.',
  },
  {
    file: 'notifications/notification-dispatcher.ts',
    field: 'deliveryOutcomes',
    cls: 'post-card-metadata',
    note: 'NEW, not in the #888 rescope table. Delivery outcome per question id (#603 Phase 1), recorded by maybePush for an already-registered card so a held hook can awaitDelivery. Same role as AutoApproveGate.confirmedDeliveries, different class.',
  },
  {
    file: 'auto-approve/auto-approve-gate.ts',
    field: 'pendingHolds',
    cls: 'post-card-metadata',
    note: 'Binary main-context holds keyed by the escalated Question.id (#573).',
  },
  {
    file: 'auto-approve/auto-approve-gate.ts',
    field: 'confirmedDeliveries',
    cls: 'post-card-metadata',
    note: 'Held question ids whose notification was confirmed delivered (#603 Phase 1).',
  },
  {
    file: 'auto-approve/auto-approve-gate.ts',
    field: 'evalIdByQuestion',
    cls: 'post-card-metadata',
    note: 'Held question id mapped to its in-flight eval id (#617), so an answer can cancel it.',
  },
  {
    file: 'auto-approve/auto-approve-gate.ts',
    field: 'openQuestionSignatures',
    cls: 'mixed',
    note: 'Every OPEN escalation this gate created, keyed by Question.id (#673/#799). Held entries are post-card metadata (the card is registered); parked entries (#814) are pre-card (parkAwaitingPTY, no card yet). Per the #888 rescope comment.',
  },
  {
    file: 'auto-approve/auto-approve-gate.ts',
    field: 'retiredEscalations',
    cls: 'mixed',
    note: "NEW (#1005). Ids of escalations this gate RETIRED -- resolved, released, or answered on the user's behalf -- so a later parked render can tell 'already settled' from 'never seen' and refuse to push a card no sweep could ever remove. Mixed for the same reason openQuestionSignatures is: retiring a HELD escalation is post-card metadata (its card was registered), retiring a PARKED one (#814) is pre-card (parkAwaitingPTY, no card ever existed). Never a pendingness opinion -- consulted only to SUPPRESS creating a card, never to claim one is live, and forgetting an entry past the cap fails toward pushing.",
  },
  {
    file: 'auto-approve/auto-approve-gate.ts',
    field: 'parkedInputs',
    cls: 'pre-card',
    note: 'Original hook input of every PARKED subagent permission (#814) -- the sole surviving record of what a parked permission asked, before any card exists.',
  },
  {
    file: 'cli/session-phases/hook-bridge-setup.ts',
    field: 'elicitationQuestions',
    cls: 'post-card-metadata',
    note: 'elicitation_id mapped to questionId (#889). rememberElicitation only records after confirming sessionRegistry.getQuestion(...) is non-null -- always post-card.',
  },
  {
    file: 'cli/handlers/resolved-answer-cache.ts',
    field: 'entries',
    cls: 'post-card-metadata',
    note: 'NEW, not in the #888 rescope table. Keyed by questionId (#752); records a successfully-applied answer so a redelivered duplicate is told apart from a genuinely unknown one. Outlives the card (consulted after removeQuestion), still metadata ABOUT a card that existed -- never a competing pendingness opinion.',
  },
  {
    file: 'session/pending-question-created-at-tracker.ts',
    field: 'firstSeen',
    cls: 'derived',
    note: 'Read-only subscriber to onQuestionsChanged (#786/#787); memoizes first-seen time for the live-sessions file mirror. Fed from the store, never a source of truth.',
  },
  {
    file: 'parser/output-processor.ts',
    field: 'pendingQuestion',
    cls: 'pre-card',
    note: 'NEW, not in the #888 rescope table. Raw PTY-parse rising-edge gate, UPSTREAM of QuestionPresenceTracker: OutputProcessor.onQuestion feeds tracker.onPTYPromptVisible/onOrphanPTYPrompt (cli.ts ~1562). Live in the streamStatusOnly pipeline, not dead code.',
  },
  {
    file: 'parser/output-processor.ts',
    field: 'pendingQuestionFp',
    cls: 'pre-card',
    note: 'Fingerprint half of the OutputProcessor rising-edge gate; see pendingQuestion.',
  },
];

/**
 * Candidate containers confirmed NOT Question-valued, with the reason. Kept
 * in the same closed-world files as `REGISTRY` so the closed-world scan
 * (layer 1) has a complete accounting of every candidate it finds -- an
 * omission here is exactly as loud a test failure as an unclassified real
 * container, which is the point: nothing in these files is un-triaged.
 */
const EXCLUSIONS: readonly ExcludedEntry[] = [
  {
    file: 'api/question-presence-tracker.ts',
    field: 'orphanTimer',
    note: 'A timer HANDLE for armedOrphanQuestion, not Question data itself.',
  },
  {
    file: 'api/question-presence-tracker.ts',
    field: 'parkedRenderArbiter',
    note: 'A wired callback reference (the #814 arbiter dependency), not per-question state.',
  },
  {
    file: 'notifications/notification-dispatcher.ts',
    field: 'pushDedup',
    note: 'Holds a PushDedup INSTANCE. That instance owns its own container (notifications/push-dedup.ts, field "last"), classified separately above; this field is a wiring reference, not itself Question data.',
  },
  {
    file: 'auto-approve/auto-approve-gate.ts',
    field: 'evalIsSubagentById',
    note: 'Keyed by evalId, a number, not by Question id -- per-eval bookkeeping, not per-question.',
  },
  {
    file: 'parser/output-processor.ts',
    field: 'currentMessageId',
    note: 'A Message id (agent output text), unrelated domain from Question.',
  },
  {
    file: 'parser/output-processor.ts',
    field: 'seenContent',
    note: 'Dedup of raw terminal content CHUNKS (message text), not Question data.',
  },
];

/** Files scanned by the closed-world (layer 1) scan: every file with at
 *  least one classified or excluded container above. Extend this list --
 *  and REGISTRY/EXCLUSIONS -- when a new file legitimately joins the
 *  question lifecycle; that is the intended way this test grows. */
const CLOSED_WORLD_FILES = [
  'session/question-store.ts',
  'api/question-presence-tracker.ts',
  'api/question-dedup.ts',
  'notifications/push-dedup.ts',
  'notifications/notification-dispatcher.ts',
  'auto-approve/auto-approve-gate.ts',
  'cli/handlers/resolved-answer-cache.ts',
  'session/pending-question-created-at-tracker.ts',
  'parser/output-processor.ts',
] as const;

/** `hook-bridge-setup.ts` is a closure factory, not a class -- its
 *  container is a `const`, not a `private` field. Scanned separately. */
const CLOSURE_FILES = ['cli/session-phases/hook-bridge-setup.ts'] as const;

/** Extract every `private` class-field name initialized to `null`, `[]`,
 *  `new Map(...)`, or `new Set(...)` -- the shape every real container in
 *  `CLOSED_WORLD_FILES` takes (verified by hand against each file). Method-
 *  body locals never match: they are declared with `const`/`let`, not
 *  `private`. */
function extractPrivateFields(source: string): string[] {
  const pattern =
    /^\s*private\s+(?:readonly\s+)?(\w+)\s*(?::[^=;]+)?=\s*(?:new\s+(?:Map|Set)\b|null\b|\[\]|new\s+\w+\()/gm;
  const out: string[] = [];
  for (const m of source.matchAll(pattern)) {
    const name = m[1];
    if (name) out.push(name);
  }
  return out;
}

/** Extract every top-level `const` closure variable initialized to
 *  `new Map(...)` / `new Set(...)` -- the shape `elicitationQuestions`
 *  takes in the closure-based `hook-bridge-setup.ts`. */
function extractConstContainers(source: string): string[] {
  const pattern = /^\s*const\s+(\w+)\s*=\s*new\s+(?:Map|Set)\b/gm;
  const out: string[] = [];
  for (const m of source.matchAll(pattern)) {
    const name = m[1];
    if (name) out.push(name);
  }
  return out;
}

function expectedFieldsFor(file: string): string[] {
  const registered = REGISTRY.filter((e) => e.file === file).map((e) => e.field);
  const excluded = EXCLUSIONS.filter((e) => e.file === file).map((e) => e.field);
  return [...registered, ...excluded];
}

/** Recursively collect every non-test `.ts` file under `dir`. */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...collectSourceFiles(full));
      continue;
    }
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    out.push(full);
  }
  return out;
}

describe('Question-valued container inventory (#888 ii)', () => {
  test('REGISTRY and EXCLUSIONS have no duplicate (file, field) pairs', () => {
    const keys = [...REGISTRY, ...EXCLUSIONS].map((e) => `${e.file}#${e.field}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('every REGISTRY/EXCLUSIONS entry actually exists in its stated file', () => {
    for (const entry of [...REGISTRY, ...EXCLUSIONS]) {
      const path = join(SRC_ROOT, entry.file);
      const source = readFileSync(path, 'utf8');
      const isClosure = (CLOSURE_FILES as readonly string[]).includes(entry.file);
      const found = isClosure ? extractConstContainers(source) : extractPrivateFields(source);
      expect(found).toContain(entry.field);
    }
  });

  describe('layer 1: closed-world scan of known question-lifecycle files', () => {
    for (const file of CLOSED_WORLD_FILES) {
      test(`${file}: every private null/[]/Map/Set field is classified or excluded`, () => {
        const source = readFileSync(join(SRC_ROOT, file), 'utf8');
        const candidates = extractPrivateFields(source).sort();
        const expected = expectedFieldsFor(file).sort();
        expect(candidates).toEqual(expected);
      });
    }

    for (const file of CLOSURE_FILES) {
      test(`${file}: every const Map/Set container is classified or excluded`, () => {
        const source = readFileSync(join(SRC_ROOT, file), 'utf8');
        const candidates = extractConstContainers(source).sort();
        const expected = expectedFieldsFor(file).sort();
        expect(candidates).toEqual(expected);
      });
    }
  });

  describe('layer 2: repo-wide scan for directly Question-typed private fields', () => {
    // Four SEPARATE, simple patterns rather than one combined alternation --
    // a combined multi-line greedy version was tried and silently
    // under-matched (verified while building this test).
    const PATTERNS = [
      /private\s+(?:readonly\s+)?(\w+).*=\s*new\s+(?:Map|Set)<[^>]*\bQuestion\b[^>]*>/,
      /private\s+(?:readonly\s+)?(\w+)\s*:\s*Question\s*\|\s*null/,
      /private\s+(?:readonly\s+)?(\w+)\s*:\s*(?:readonly\s+)?Question\[\]/,
      /private\s+(?:readonly\s+)?(\w+)\s*:\s*ReadonlyArray<Question>/,
    ];

    function findDirectlyQuestionTypedFields(root: string): { file: string; field: string }[] {
      const out: { file: string; field: string }[] = [];
      for (const file of collectSourceFiles(root)) {
        const source = readFileSync(file, 'utf8');
        const rel = file.slice(root.length + 1);
        for (const line of source.split('\n')) {
          for (const pattern of PATTERNS) {
            const m = line.match(pattern);
            if (m?.[1]) out.push({ file: rel, field: m[1] });
          }
        }
      }
      return out;
    }

    test('every directly Question-typed private field anywhere in packages/daemon/src is classified', () => {
      const found = findDirectlyQuestionTypedFields(SRC_ROOT);
      expect(found.length).toBeGreaterThan(0); // sanity: the scan is not vacuous
      const unclassified = found.filter(
        (f) => !REGISTRY.some((e) => e.file === f.file && e.field === f.field),
      );
      expect(unclassified).toEqual([]);
    });
  });
});
