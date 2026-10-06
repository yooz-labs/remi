/**
 * Per-launch secure push contexts over the real question store, real recipient stores and real
 * crypto-bearing snapshots (#1200). Time moves with Bun's own `setSystemTime`; nothing else is
 * substituted.
 */
import { afterEach, beforeEach, expect, setSystemTime, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { type Question, type UUID, createIdentity, generateId, relayV2 } from '@remi/shared';
import { IdentityStore } from '../../src/auth/identity-store.ts';
import {
  SecurePushContexts,
  type SecurePushEvent,
  type SecurePushRuntime,
} from '../../src/notifications/secure-push-contexts.ts';
import {
  type SecurePushSnapshot,
  SecurePushStore,
} from '../../src/notifications/secure-push-store.ts';
import { RelayDeviceStore } from '../../src/remote/relay-device-store.ts';
import { QuestionStore } from '../../src/session/question-store.ts';

const SID = 'a0000000-0000-0000-0000-000000000000' as UUID;
const directories: string[] = [];
let questions: QuestionStore;
let contexts: SecurePushContexts;
let runtime: SecurePushRuntime;
let snapshot: SecurePushSnapshot;

async function recipient(): Promise<SecurePushSnapshot> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-secure-contexts-'));
  directories.push(dir);
  const trust = new IdentityStore(dir);
  const identity = await createIdentity();
  await trust.addAuthorizedKey(identity.publicKey, 'owned');
  await new RelayDeviceStore(dir, trust).add(identity.publicKey, 'owned');
  const store = new SecurePushStore(dir, trust);
  const authority = store.captureAuthority(identity.publicKey);
  if (!authority) throw new Error('owned authority missing');
  const pair = await relayV2.generateEcPair();
  const result = await store.register(authority, {
    token: 'ab'.repeat(32),
    environment: 'sandbox',
    pushPublicKey: relayV2.b64u(pair.publicKey),
    keyVersion: 1,
  });
  const current = store.listCurrent()[0];
  if (!result.success || !current) throw new Error('owned registration missing');
  return current;
}
function ask(detail?: string): Question {
  return {
    id: generateId() as UUID,
    text: 'proceed?',
    ...(detail === undefined ? {} : { detail }),
    options: [
      { value: 'y', label: 'Yes', isRecommended: true, isYes: true, isNo: false },
      { value: 'n', label: 'No', isRecommended: false, isYes: false, isNo: true },
    ],
    allowsFreeText: false,
    isAnswered: false,
  };
}
const questionEvent = (q: Question): SecurePushEvent => ({
  kind: 'question',
  logicalId: q.id,
  question: q,
  title: 'Remi',
  body: q.text,
});
const info = (kind: SecurePushEvent['kind'], logicalId: string, extra = {}): SecurePushEvent => ({
  kind,
  logicalId,
  title: 'Remi',
  body: 'body',
  ...extra,
});

beforeEach(async () => {
  questions = new QuestionStore(SID);
  contexts = new SecurePushContexts({
    questionFor: (_sid, qid) => questions.questions.get(qid) ?? null,
    validityFor: () => ({ kind: 'current-prompt' }),
  });
  runtime = contexts.begin(SID);
  snapshot = await recipient();
});
afterEach(() => {
  setSystemTime();
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test('answered and dismissed questions free their slot: the 33rd question is still captured (#1200, B1)', () => {
  for (let i = 0; i < 40; i++) {
    const q = ask();
    questions.add(q);
    expect(contexts.capture(runtime, snapshot, questionEvent(q)), `question ${i}`).not.toBeNull();
    questions.remove(q.id);
    expect(
      contexts.capture(runtime, snapshot, { kind: 'dismiss', logicalId: q.id }),
      `dismissal ${i}`,
    ).not.toBeNull();
  }
});

test('expired informational events free their slot, and 32 live ones still bound the session (#1200, B1)', () => {
  for (let i = 0; i < 32; i++)
    expect(
      contexts.capture(runtime, snapshot, info('question', `foreign-session-${i}`)),
    ).not.toBeNull();
  expect(contexts.capture(runtime, snapshot, info('question', 'foreign-session-32'))).toBeNull();
  setSystemTime(new Date(Date.now() + 301_000));
  expect(
    contexts.capture(runtime, snapshot, info('question', 'foreign-session-32')),
  ).not.toBeNull();
});

test('a question that left the registry without a dismissal holds no slot either (#1200, B1)', () => {
  for (let i = 0; i < 40; i++) {
    const q = ask();
    questions.add(q);
    expect(contexts.capture(runtime, snapshot, questionEvent(q)), `question ${i}`).not.toBeNull();
    questions.remove(q.id);
  }
});

test('an identical informational event is a new occurrence: it is captured again within and after 300 s, on its own collapse key (#1200, B2)', () => {
  const event = info('harness_denied', 'harness-denied-session');
  const first = contexts.capture(runtime, snapshot, event);
  expect(first).not.toBeNull();
  if (!first) return;
  const again = contexts.capture(runtime, snapshot, event);
  expect(again).not.toBeNull();
  if (!again) return;
  expect(again).not.toBe(first);
  expect(again.content.nonce).not.toBe(first.content.nonce);
  expect(again.content.revision).toBe(first.content.revision + 1);
  // One collapse key per session: the later notice replaces the earlier on the lock screen.
  expect(again.content.collapseId).toBe(first.content.collapseId);
  setSystemTime(new Date(Date.now() + 400_000));
  const late = contexts.capture(runtime, snapshot, event);
  expect(late).not.toBeNull();
  expect(late?.content.revision).toBe(first.content.revision + 2);
  expect(late?.content.collapseId).toBe(first.content.collapseId);
});

test('one occurrence id is one occurrence: a duplicate frame coalesces and a stale duplicate is dropped (#1200, B2)', () => {
  const event = info('turn_complete', 'turn-complete-session', { eventId: 'claude:prompt-1' });
  const first = contexts.capture(runtime, snapshot, event);
  expect(first).not.toBeNull();
  expect(contexts.capture(runtime, snapshot, event)).toBe(first);
  setSystemTime(new Date(Date.now() + 400_000));
  expect(contexts.capture(runtime, snapshot, event)).toBeNull();
});

test('turn_complete and subagent_alert occurrences keep their own lock-screen slot, as legacy; a repeated turn_failed keeps one (#1200, B2)', () => {
  const turnA = contexts.capture(
    runtime,
    snapshot,
    info('turn_complete', 'turn-complete-session', { eventId: 'claude:a' }),
  );
  const turnB = contexts.capture(
    runtime,
    snapshot,
    info('turn_complete', 'turn-complete-session', { eventId: 'claude:b' }),
  );
  expect(turnA?.content.collapseId).not.toBe(turnB?.content.collapseId);
  expect(turnA && contexts.isCurrent(turnA)).toBe(true);
  expect(turnB && contexts.isCurrent(turnB)).toBe(true);
  const alertA = contexts.capture(runtime, snapshot, info('subagent_alert', 'subagent-alert'));
  const alertB = contexts.capture(runtime, snapshot, info('subagent_alert', 'subagent-alert'));
  expect(alertA?.content.collapseId).not.toBe(alertB?.content.collapseId);
  expect(alertA && contexts.isCurrent(alertA)).toBe(true);
  expect(alertB && contexts.isCurrent(alertB)).toBe(true);
  const failedA = contexts.capture(runtime, snapshot, info('turn_failed', 'turn-failed-episode'));
  const failedB = contexts.capture(runtime, snapshot, info('turn_failed', 'turn-failed-episode'));
  expect(failedB?.content.collapseId).toBe(failedA?.content.collapseId);
});
