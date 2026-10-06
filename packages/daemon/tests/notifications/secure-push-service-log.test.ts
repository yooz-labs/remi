/**
 * The service's diagnostics name WHY a push was refused (#1200, B8): a dismissal with nothing to
 * clear is not a refusal, and a real refusal says which class it was, without content or ids.
 * Real stores, contexts, service and transport; every case here stops before any network effect.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { type Question, type UUID, createIdentity, generateId, relayV2 } from '@remi/shared';
import { IdentityStore } from '../../src/auth/identity-store.ts';
import {
  SecurePushContexts,
  type SecurePushEvent,
} from '../../src/notifications/secure-push-contexts.ts';
import {
  SecurePushService,
  type SecureSessionPush,
} from '../../src/notifications/secure-push-service.ts';
import { SecurePushStore } from '../../src/notifications/secure-push-store.ts';
import { SecurePushTransport } from '../../src/notifications/secure-push-transport.ts';
import { RelayDeviceStore } from '../../src/remote/relay-device-store.ts';
import { QuestionStore } from '../../src/session/question-store.ts';

const SID = 'a0000000-0000-0000-0000-000000000000' as UUID;
let directory: string;
let questions: QuestionStore;
let logs: string[];
let secure: SecureSessionPush;
beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-secure-service-log-'));
  const trust = new IdentityStore(directory);
  const identity = await createIdentity();
  await trust.addAuthorizedKey(identity.publicKey, 'owned');
  await new RelayDeviceStore(directory, trust).add(identity.publicKey, 'owned');
  const store = new SecurePushStore(directory, trust);
  const authority = store.captureAuthority(identity.publicKey);
  if (!authority) throw new Error('owned authority missing');
  const pair = await relayV2.generateEcPair();
  const registered = await store.register(authority, {
    token: 'ab'.repeat(32),
    environment: 'sandbox',
    pushPublicKey: relayV2.b64u(pair.publicKey),
    keyVersion: 1,
  });
  if (!registered.success) throw new Error('owned registration missing');
  const { signer } = await relayV2.generateIdentity();
  questions = new QuestionStore(SID);
  const contexts = new SecurePushContexts(
    {
      questionFor: (_sid, qid) => questions.questions.get(qid) ?? null,
      validityFor: () => ({ kind: 'current-prompt' }),
    },
    2048,
    1,
  );
  const origin = 'http://127.0.0.1:9';
  logs = [];
  secure = new SecurePushService({
    store,
    contexts,
    transport: SecurePushTransport.forOwnedLoopbackTest({
      store,
      signer,
      audience: origin,
      ownedOrigin: origin,
      maxAttempts: 1,
      retryDelayMs: 0,
    }),
    machinePublicKey: relayV2.b64u(signer.publicKey),
    rid: '00'.repeat(16),
    log: (outcome) => logs.push(outcome),
  }).forRuntime(contexts.begin(SID));
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

const ask = (): Question => ({
  id: generateId() as UUID,
  text: 'PRIVATE_QUESTION_SENTINEL',
  options: [
    { value: 'y', label: 'Yes', isRecommended: true, isYes: true, isNo: false },
    { value: 'n', label: 'No', isRecommended: false, isYes: false, isNo: true },
  ],
  allowsFreeText: false,
  isAnswered: false,
});
const info = (logicalId: string): SecurePushEvent => ({
  kind: 'question',
  logicalId,
  title: 'Remi',
  body: 'PRIVATE_BODY_SENTINEL',
});

test('a dismissal with no prior push is skipped, not logged as a refusal (#1200, B8)', async () => {
  expect(await secure.send({ kind: 'dismiss', logicalId: generateId() })).toBe('no_channel');
  expect(logs).toEqual(['skipped:no_prior_push']);
});

test('a refusal says its class: capacity, a stale question, an invalid event (#1200, B8)', async () => {
  const gone = ask();
  expect(await secure.send({ kind: 'question', logicalId: gone.id, question: gone })).toBe(
    'failed',
  );
  const mismatched = ask();
  questions.add(mismatched);
  expect(
    await secure.send({ kind: 'question', logicalId: generateId(), question: mismatched }),
  ).toBe('failed');
  expect(await secure.send({ kind: 'question', logicalId: '' })).toBe('failed');
  expect(logs).toEqual(['refused:stale', 'refused:invalid', 'refused:invalid']);
  logs.length = 0;
  // One live slot per session in this fixture: the second live event is refused for capacity.
  // The first dials a closed loopback port and reports its own, different outcome.
  await secure.send(info('foreign-session-1'));
  await secure.send(info('foreign-session-2'));
  expect(logs.filter((line) => line.startsWith('refused'))).toEqual(['refused:capacity']);
});

test('every diagnostic is a fixed class: no content, no id (#1200, B8)', async () => {
  const q = ask();
  await secure.send({ kind: 'question', logicalId: q.id, question: q, body: q.text });
  await secure.send({ kind: 'dismiss', logicalId: generateId() });
  await secure.send(info('foreign-session-PRIVATE_ID_SENTINEL'));
  for (const line of logs) expect(line).toMatch(/^[a-z_]+(:[a-z_]+)?$/);
  expect(logs.join(' ')).not.toContain('PRIVATE');
});
