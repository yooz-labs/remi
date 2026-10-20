/** Subscription manager against the real source hub and encrypted machine channel (#1200). */
import { expect, test } from 'bun:test';
import {
  type ProtocolMessage,
  type PushPreferences,
  type SecurePushRegisterRequestMessage,
  type SecurePushRegistration,
  createHello,
  relayV2,
} from '@remi/shared';
import { Mailbox } from '../../signaling/tests/e2e/endpoints';
import { RelayMachineChannel } from '../src/lib/relay-machine-channel';
import { RelayRequests } from '../src/lib/relay-requests';
import {
  type PreparedSecurePush,
  type SecurePushOutcome,
  SecurePushSubscriptions,
} from '../src/lib/secure-push-subscriptions';
import { ownedRelayOffer, registerOwnedRelayFixtureCleanup } from './helpers/relay-hub';
registerOwnedRelayFixtureCleanup();

const PREFS: PushPreferences = { questions: true, turnComplete: true, harnessDenied: true, turnFailed: true };
// The source hub fixture has no secure push sender, so it answers every registration it
// receives with UNSUPPORTED (#1200). The manager settles any answered outcome the same way;
// a successful registration over a real hub is covered by the daemon's hub relay tests.
const ANSWERED: SecurePushOutcome = { kind: 'refused', error: 'UNSUPPORTED' };

async function pairedRequests(sent: SecurePushRegisterRequestMessage[]) {
  const local = await ownedRelayOffer();
  const { signer } = await relayV2.generateIdentity();
  const ready = new Mailbox<boolean>();
  let requests: RelayRequests | undefined;
  const client = await RelayMachineChannel.pair(String(local.offer['token']), signer, () => true, {
    onPhase: (phase) => { if (phase === 'connected') ready.push(true); },
    onMessage: (message: ProtocolMessage) => { requests?.receive(message); },
    onClose: () => {},
    onError: () => {},
  });
  await client.start();
  const compare = await local.inbox.next();
  local.ws.send(JSON.stringify({
    t: 'confirm', id: 'owned-r4', offerId: local.offer['offerId'],
    connectionId: compare['connectionId'], fingerprint: compare['fingerprint'], accept: true,
  }));
  expect(await ready.next()).toBe(true);
  expect((await local.inbox.next())['t']).toBe('paired');
  requests = new RelayRequests((message) => {
    if (message.type === 'secure_push_register_request') sent.push(message);
    return client.send(message);
  }, () => {});
  expect(client.send(createHello('owned-r5-subs', '2'))).toBe(true);
  return { client, requests };
}

async function nativeMetadata(): Promise<SecurePushRegistration> {
  const recipient = await relayV2.generateEcPair();
  return { token: 'ab'.repeat(32), environment: 'sandbox', pushPublicKey: relayV2.b64u(recipient.publicKey), keyVersion: 1 };
}

test('registers each connected machine once per token generation and preference set over the real channel', async () => {
  const sent: SecurePushRegisterRequestMessage[] = [];
  const { client, requests } = await pairedRequests(sent);
  const outcomes = new Mailbox<SecurePushOutcome>();
  const metadata = await nativeMetadata();
  let prepared = 0;
  const subscriptions = new SecurePushSubscriptions({
    prepare: async () => { prepared++; return { metadata, validate: async () => {} }; },
    register: (_id, registration) => requests.registerPush(registration),
  }, (_id, outcome) => outcomes.push(outcome));
  const target = { connectionId: 'relay:m', machinePublicKey: 'm' };
  try {
    subscriptions.sync([target], PREFS);
    expect(await outcomes.next()).toEqual(ANSWERED);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.pushPrefs).toEqual(PREFS);
    subscriptions.sync([target], PREFS);
    await Bun.sleep(50);
    expect(prepared, 'An unchanged generation and preference set registers once').toBe(1);
    subscriptions.tokenChanged();
    subscriptions.sync([target], PREFS);
    expect(await outcomes.next()).toEqual(ANSWERED);
    const muted = { ...PREFS, turnComplete: false };
    subscriptions.sync([target], muted);
    expect(await outcomes.next()).toEqual(ANSWERED);
    expect(sent[2]?.pushPrefs).toEqual(muted);
    subscriptions.sync([], muted);
    subscriptions.sync([target], muted);
    expect(await outcomes.next(), 'A reconnect registers again').toEqual(ANSWERED);
    expect(prepared).toBe(4);
  } finally { requests.closed(); await client.close(); }
}, 30000);

test('a missing native token is retried only on the next token change', async () => {
  const sent: SecurePushRegisterRequestMessage[] = [];
  const { client, requests } = await pairedRequests(sent);
  const outcomes = new Mailbox<SecurePushOutcome>();
  const metadata = await nativeMetadata();
  let tokenPresent = false;
  let prepared = 0;
  const subscriptions = new SecurePushSubscriptions({
    prepare: async () => {
      prepared++;
      // The native bridge answers on a later event-loop turn, never synchronously.
      await Bun.sleep(1);
      if (!tokenPresent) throw new Error('Secure notifications are unavailable.');
      return { metadata, validate: async () => {} };
    },
    register: (_id, registration) => requests.registerPush(registration),
  }, (_id, outcome) => outcomes.push(outcome));
  const target = { connectionId: 'relay:m', machinePublicKey: 'm' };
  try {
    subscriptions.sync([target], PREFS);
    expect(await outcomes.next()).toEqual({ kind: 'unavailable' });
    subscriptions.sync([target], PREFS);
    await Bun.sleep(50);
    expect(prepared, 'No token is the normal state before enabling; it must not loop').toBe(1);
    expect(sent).toHaveLength(0);
    tokenPresent = true;
    subscriptions.tokenChanged();
    subscriptions.sync([target], PREFS);
    expect(await outcomes.next()).toEqual(ANSWERED);
    expect(sent).toHaveLength(1);
  } finally { requests.closed(); await client.close(); }
}, 30000);

test('a token change during preparation discards the stale ticket and sends only the current one', async () => {
  const sent: SecurePushRegisterRequestMessage[] = [];
  const { client, requests } = await pairedRequests(sent);
  const outcomes = new Mailbox<SecurePushOutcome>();
  const first = await nativeMetadata();
  const second = { ...(await nativeMetadata()), token: 'cd'.repeat(32) };
  const release = new Mailbox<PreparedSecurePush>();
  const validated: string[] = [];
  let calls = 0;
  const subscriptions = new SecurePushSubscriptions({
    prepare: async () => {
      calls++;
      const metadata = calls === 1 ? first : second;
      const prepared = { metadata, validate: async () => { validated.push(metadata.token); } };
      return calls === 1 ? release.next() : prepared;
    },
    register: (_id, registration) => requests.registerPush(registration),
  }, (_id, outcome) => outcomes.push(outcome));
  const target = { connectionId: 'relay:m', machinePublicKey: 'm' };
  try {
    subscriptions.sync([target], PREFS);
    await Bun.sleep(20);
    subscriptions.tokenChanged();
    subscriptions.sync([target], PREFS);
    release.push({ metadata: first, validate: async () => { validated.push(first.token); } });
    expect(await outcomes.next()).toEqual(ANSWERED);
    await Bun.sleep(50);
    expect(sent.map((message) => message.token), 'The stale ticket is never sent').toEqual([second.token]);
    expect(validated, 'Only the sent ticket is validated').toEqual([second.token]);
  } finally { requests.closed(); await client.close(); }
}, 30000);

test('a token change while the ticket is validated sends nothing for that ticket', async () => {
  const sent: SecurePushRegisterRequestMessage[] = [];
  const { client, requests } = await pairedRequests(sent);
  const outcomes = new Mailbox<SecurePushOutcome>();
  const first = await nativeMetadata();
  const second = { ...(await nativeMetadata()), token: 'cd'.repeat(32) };
  const validating = new Mailbox<() => void>();
  let calls = 0;
  const subscriptions = new SecurePushSubscriptions({
    prepare: async () => {
      calls++;
      if (calls > 1) return { metadata: second, validate: async () => {} };
      return { metadata: first, validate: () => new Promise<void>((resolve) => validating.push(resolve)) };
    },
    register: (_id, registration) => requests.registerPush(registration),
  }, (_id, outcome) => outcomes.push(outcome));
  const target = { connectionId: 'relay:m', machinePublicKey: 'm' };
  try {
    subscriptions.sync([target], PREFS);
    const finishValidation = await validating.next();
    subscriptions.tokenChanged();
    finishValidation();
    expect(await outcomes.next()).toEqual(ANSWERED);
    await Bun.sleep(50);
    expect(sent.map((message) => message.token), 'A ticket validated for an old token is never sent').toEqual([second.token]);
  } finally { requests.closed(); await client.close(); }
}, 30000);
