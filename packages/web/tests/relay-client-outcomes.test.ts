/** Actual wrapper and outcome coordinator consume real source hub/Worker decisions. */
import { expect, test } from 'bun:test';
import {
  type AnswerResultMessage,
  type ProtocolMessage,
  createAnswer,
  createHello,
  createSessionListRequest,
  generateId,
  now,
  relayV2,
} from '@remi/shared';
import { questionKey, resolveQuestionCard, pruneQuestionsNotLive } from '../src/lib/question-collection';
import { mapQuestionToUIQuestion } from '../src/lib/question-mapping';
import { Mailbox } from '../../signaling/tests/e2e/endpoints';
import { RelayMachineChannel } from '../src/lib/relay-machine-channel';
import { type RelayAnswerStatus, RelayRequests } from '../src/lib/relay-requests';
import { ownedRelayChild, ownedRelayOffer } from './helpers/relay-hub';

async function nextType(inbox: Mailbox<ProtocolMessage>, type: ProtocolMessage['type']) {
  for (let i = 0; i < 128; i++) {
    const message = await inbox.next();
    if (message.type === type) return message;
  }
  throw new Error('semantic response missing');
}
async function pair(
  local: Awaited<ReturnType<typeof ownedRelayOffer>>,
  receive: (message: ProtocolMessage) => void,
  onClose: () => void = () => {},
  identityCurrent: () => boolean = () => true,
) {
  const { signer } = await relayV2.generateIdentity();
  const ready = new Mailbox<boolean>();
  const errors: Error[] = [];
  const client = await RelayMachineChannel.pair(
    String(local.offer['token']),
    signer,
    identityCurrent,
    {
      onReady: () => ready.push(true),
      onMessage: receive,
      onClose,
      onError: (error) => errors.push(error),
    },
  );
  await client.start();
  const compare = await local.inbox.next();
  expect(compare['t']).toBe('compare');
  local.ws.send(
    JSON.stringify({
      t: 'confirm',
      id: 'owned-r4',
      offerId: local.offer['offerId'],
      connectionId: compare['connectionId'],
      fingerprint: compare['fingerprint'],
      accept: true,
    }),
  );
  expect(await ready.next()).toBe(true);
  expect((await local.inbox.next())['t']).toBe('paired');
  expect(client.send(createHello('owned-r4', '2'))).toBe(true);
  return { client, signer, errors };
}

test('real child resolution does not settle this answer until exact correlated delivered result', async () => {
  const local = await ownedRelayOffer();
  const messages = new Mailbox<ProtocolMessage>();
  const history: RelayAnswerStatus[] = [];
  const pendingResults = new Mailbox<AnswerResultMessage>();
  let requests: RelayRequests | undefined;
  const paired = await pair(local, (message) => {
    if (message.type === 'answer_result') pendingResults.push(message);
    else requests?.receive(message);
    messages.push(message);
  });
  requests = new RelayRequests(
    (message) => paired.client.send(message),
    (status) => history.push(status),
  );
  let abort: AbortController | undefined;
  try {
    await nextType(messages, 'hello_ack');
    const child = await ownedRelayChild(local.running);
    const secondChild = await ownedRelayChild(local.running);
    const list = createSessionListRequest();
    expect(paired.client.send(list)).toBe(true);
    const discovery = await nextType(messages, 'session_list_response');
    expect(discovery.type === 'session_list_response' && discovery.requestId).toBe(list.id);
    expect(
      discovery.type === 'session_list_response' &&
        discovery.sessions.some((s) => s.sessionId === child.entry.sessionId),
    ).toBe(true);
    expect(
      discovery.type === 'session_list_response' &&
        discovery.sessions.some((s) => s.sessionId === secondChild.entry.sessionId),
    ).toBe(true);
    expect(
      paired.client.send(createHello('owned-r4', '2', { resumeSessionId: child.entry.sessionId })),
    ).toBe(true);
    const attached = await nextType(messages, 'hello_ack');
    if (attached.type !== 'hello_ack' || !attached.claudeSessionId)
      throw new Error('verified child binding missing');
    expect(attached.sessionId).toBe(child.entry.sessionId);
    expect(attached.attachState).toBe('attached');
    abort = new AbortController();
    const hook = fetch(`http://127.0.0.1:${child.entry.hookPort}/hooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: abort.signal,
      body: JSON.stringify({
        hook_event_name: 'PermissionRequest',
        session_id: attached.claudeSessionId,
        transcript_path: attached.transcriptPath,
        cwd: local.running.dir,
        permission_mode: 'default',
        tool_name: 'Bash',
        tool_input: { command: 'PRIVATE_NEVER_RUN_TOOL' },
      }),
    });
    // Attach a rejection consumer immediately so failed assertions retain their own
    // diagnostic when finally aborts this real held HTTP request.
    void hook.catch(() => undefined);
    const question = await nextType(messages, 'question');
    if (question.type !== 'question') throw new Error('held question missing');
    const no = question.question.options.find((option) => option.isNo);
    if (!no) throw new Error('deny option missing');
    const answer = createAnswer(
      child.entry.sessionId,
      question.question.id,
      no.value,
      attached.claudeSessionId,
    );
    const ui = mapQuestionToUIQuestion(question.question, question.sessionId, question.timestamp);
    const view = new Map([[questionKey(ui.sessionId, ui.agentId), { ...ui, submitting: true, awaitingRelayOutcome: true }]]);
    expect(requests.answer(answer)).toBe(true);
    expect(requests.answer(answer)).toBe(false);
    expect(requests.answer({ ...answer, id: generateId() })).toBe(false);
    expect(history).toHaveLength(0);
    const resolved = await nextType(messages, 'question_resolved');
    expect(resolved.type === 'question_resolved' && resolved.questionId).toBe(answer.questionId);
    expect(history).toHaveLength(0);
    if (resolved.type !== 'question_resolved') throw new Error('missing resolution');
    const afterResolution = resolveQuestionCard(view, resolved.sessionId, resolved.questionId, resolved.reason);
    expect(afterResolution.questions.size).toBe(1);
    expect(afterResolution.fade).toBe(false);
    const uncertain = new Map([...afterResolution.questions].map(([key, q]) => [key, { ...q, submitting: false, deliveryOutcome: 'uncertain' as const }]));
    expect(pruneQuestionsNotLive(uncertain, child.entry.sessionId, new Set()).size).toBe(1);
    const result = await pendingResults.next();
    expect(requests.receive({ ...result, requestId: generateId() })).toBe(false);
    expect(requests.receive({ ...result, sessionId: generateId() })).toBe(false);
    expect(requests.receive({ ...result, questionId: generateId() })).toBe(false);
    expect(history).toHaveLength(0);
    expect(requests.receive(result)).toBe(true);
    expect(history.map((status) => status.outcome)).toEqual(['delivered']);
    expect((await (await hook).json()).hookSpecificOutput.decision.behavior).toBe('deny');
    expect(
      paired.client.send(
        createHello('owned-r4', '2', { resumeSessionId: secondChild.entry.sessionId }),
      ),
    ).toBe(true);
    const otherAttach = await nextType(messages, 'hello_ack');
    expect(otherAttach.type === 'hello_ack' && otherAttach.sessionId).toBe(
      secondChild.entry.sessionId,
    );
    expect(paired.errors).toHaveLength(0);
  } finally {
    abort?.abort();
    requests.closed();
    await paired.client.close();
  }
}, 25000);

test('actual received but withheld answer result reaches 10-second uncertainty with no automatic answer retry', async () => {
  const local = await ownedRelayOffer();
  const messages = new Mailbox<ProtocolMessage>();
  const outcomes = new Mailbox<RelayAnswerStatus>();
  const paired = await pair(local, (message) => messages.push(message));
  let sends = 0;
  const requests = new RelayRequests(
    (message) => {
      ++sends;
      return paired.client.send(message);
    },
    (status) => outcomes.push(status),
  );
  try {
    await nextType(messages, 'hello_ack');
    const answer = createAnswer(generateId(), generateId(), 'no');
    const began = Date.now();
    expect(requests.answer(answer)).toBe(true);
    const wire = await nextType(messages, 'answer_result');
    expect(wire.type === 'answer_result' && wire.requestId).toBe(answer.id);
    // A transport consumer loses this real reply. Neither send nor a resolution is delivery evidence.
    const result = await outcomes.next(11000);
    expect(Date.now() - began).toBeGreaterThanOrEqual(9900);
    expect(result.outcome).toBe('uncertain');
    expect(sends).toBe(1);
    expect(requests.receive(wire)).toBe(false);
  } finally {
    requests.closed();
    await paired.client.close();
  }
}, 20000);

test('close drains authenticated BYE but suppresses a real decrypt continuation application callback', async () => {
  const local = await ownedRelayOffer();
  const messages = new Mailbox<ProtocolMessage>();
  const endings = new Mailbox<relayV2.StreamEnd>();
  const paired = await pair(
    local,
    (message) => messages.push(message),
    () => {},
  );
  const original = crypto.subtle.decrypt.bind(crypto.subtle);
  let release!: () => void;
  const checkpoint = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Mailbox<boolean>();
  const id = generateId();
  const history: ProtocolMessage[] = [];
  try {
    await nextType(messages, 'hello_ack');
    crypto.subtle.decrypt = async (...args: Parameters<SubtleCrypto['decrypt']>) => {
      const plaintext = await original(...args);
      if (new TextDecoder().decode(plaintext).includes(id)) {
        reached.push(true);
        await checkpoint;
      }
      return plaintext;
    };
    // The real callback recorder observes only frames handed to application code.
    const oldPush = messages.push.bind(messages);
    messages.push = (message) => {
      history.push(message);
      oldPush(message);
    };
    expect(paired.client.send({ type: 'relay_devices_request', id, timestamp: now() })).toBe(true);
    expect(await reached.next()).toBe(true);
    const closing = paired.client.close();
    release();
    await closing;
    expect(
      history.some(
        (message) => message.type === 'relay_devices_response' && message.requestId === id,
      ),
    ).toBe(false);
    expect(paired.client.connected).toBe(false);
    expect(endings.drain()).toHaveLength(0);
  } finally {
    release();
    crypto.subtle.decrypt = original;
    await paired.client.close();
  }
}, 20000);

test('enrolled client receives actual other-device durable/edge ACK while self close remains unverified', async () => {
  const local = await ownedRelayOffer();
  const messages = new Mailbox<ProtocolMessage>();
  let requests: RelayRequests | undefined;
  const first = await pair(
    local,
    (message) => {
      requests?.receive(message);
      messages.push(message);
    },
    () => requests?.closed(),
  );
  requests = new RelayRequests(
    (message) => first.client.send(message),
    () => {},
  );
  let other: Awaited<ReturnType<typeof pair>> | undefined;
  try {
    await nextType(messages, 'hello_ack');
    local.ws.send(JSON.stringify({ t: 'pair', id: 'owned-r4' }));
    local.offer = await local.inbox.next();
    expect(local.offer['t']).toBe('offer');
    const otherMessages = new Mailbox<ProtocolMessage>();
    other = await pair(local, (message) => otherMessages.push(message));
    await nextType(otherMessages, 'hello_ack');
    const devices = await requests.devices();
    expect(devices.devices).toHaveLength(2);
    const otherPublic = Buffer.from(other.signer.publicKey).toString('base64');
    const otherDevice = devices.devices.find((device) => device.publicKey === otherPublic);
    expect(otherDevice).toBeDefined();
    if (!otherDevice) throw new Error('actual second enrolled device missing');
    const result = await requests.revoke(otherDevice.fingerprint);
    expect(result.fingerprint).toBe(otherDevice.fingerprint);
    expect(result.success).toBe(true);
    expect(result.edgeAcknowledged).toBe(true);
    expect((await requests.devices()).devices).toHaveLength(1);
    const own = devices.devices.find((device) => device.publicKey !== otherPublic);
    if (!own) throw new Error('actual own enrolled device missing');
    const self = await requests.revoke(own.fingerprint).then(
      (value) => ({ value }),
      (error) => ({ error: error as Error }),
    );
    if ('error' in self) expect(self.error.message).toContain('unverified');
    else {
      expect(self.value.success).toBe(true);
      expect(typeof self.value.edgeAcknowledged).toBe('boolean');
    }
    expect(first.client.connected).toBe(false);
    const closed = new Mailbox<boolean>();
    const resume = RelayMachineChannel.resume(first.client.pin, first.signer, () => true, {
      onClose: () => closed.push(true),
    });
    try {
      await resume.start();
      expect(await closed.next()).toBe(true);
      expect(resume.connected).toBe(false);
    } finally {
      await resume.close();
    }
  } finally {
    requests.closed();
    await other?.client.close();
    await first.client.close();
  }
}, 20000);

test('identity replacement during actual encryption cannot emit an already queued device revoke', async () => {
  const local = await ownedRelayOffer();
  const messages = new Mailbox<ProtocolMessage>();
  const closedHistory: boolean[] = [];
  let current = true;
  const first = await pair(
    local,
    (message) => messages.push(message),
    () => closedHistory.push(true),
    () => current,
  );
  let other: Awaited<ReturnType<typeof pair>> | undefined;
  const original = crypto.subtle.encrypt.bind(crypto.subtle);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Mailbox<boolean>();
  const id = generateId();
  try {
    await nextType(messages, 'hello_ack');
    local.ws.send(JSON.stringify({ t: 'pair', id: 'owned-r4' }));
    local.offer = await local.inbox.next();
    const otherMessages = new Mailbox<ProtocolMessage>();
    other = await pair(local, (message) => otherMessages.push(message));
    await nextType(otherMessages, 'hello_ack');
    const requests = new RelayRequests(
      (message) => first.client.send(message),
      () => {},
    );
    // Feed the actual response into the coordinator from the endpoint consumer.
    const pending = requests.devices();
    const devicesMessage = await nextType(messages, 'relay_devices_response');
    expect(requests.receive(devicesMessage)).toBe(true);
    const devices = await pending;
    const otherPublic = Buffer.from(other.signer.publicKey).toString('base64');
    const target = devices.devices.find((device) => device.publicKey === otherPublic);
    if (!target) throw new Error('other device missing');
    crypto.subtle.encrypt = async (...args: Parameters<SubtleCrypto['encrypt']>) => {
      const frame = await original(...args);
      const plaintext =
        args[2] instanceof ArrayBuffer
          ? new Uint8Array(args[2])
          : new Uint8Array(args[2].buffer, args[2].byteOffset, args[2].byteLength);
      if (new TextDecoder().decode(plaintext).includes(id)) {
        reached.push(true);
        await held;
      }
      return frame;
    };
    expect(
      first.client.send({
        type: 'relay_device_revoke_request',
        id,
        timestamp: now(),
        fingerprint: target.fingerprint,
      }),
    ).toBe(true);
    expect(await reached.next()).toBe(true);
    current = false;
    release();
    // Let the real ordered encryption/emission continuation settle. This assertion
    // records actual close callbacks, so removing the emit guard fails explicitly.
    await Bun.sleep(100);
    expect(closedHistory).toEqual([true]);
    // The second actual enrolled client remains able to list both durable records.
    const requestId = generateId();
    expect(
      other.client.send({ type: 'relay_devices_request', id: requestId, timestamp: now() }),
    ).toBe(true);
    const after = await nextType(otherMessages, 'relay_devices_response');
    expect(
      after.type === 'relay_devices_response' &&
        after.devices.some((device) => device.fingerprint === target.fingerprint),
    ).toBe(true);
    expect(after.type === 'relay_devices_response' && after.devices).toHaveLength(2);
    requests.closed();
  } finally {
    release();
    crypto.subtle.encrypt = original;
    current = false;
    await first.client.close();
    await other?.client.close();
  }
}, 20000);
