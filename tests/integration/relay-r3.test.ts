/** R3 composes the actual source hub, Worker and shared client; no deployed service or model. */
import { afterEach, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CAPABILITY_HEADER } from '../../packages/daemon/src/auth/capability-token.ts';
import { reserveRange } from '../../packages/daemon/tests/session/port-test-helpers.ts';
import { type TestWorker, startWorker } from '../../packages/signaling/tests/e2e/harness.ts';

const homes: string[] = [];
const processes: ReturnType<typeof Bun.spawn>[] = [];
const workers: TestWorker[] = [];
const sockets: WebSocket[] = [];
const CLI = resolve(import.meta.dir, '../../packages/daemon/src/cli.ts');
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const proc of processes.splice(0)) {
    if (proc.exitCode === null) proc.kill('SIGTERM');
    await proc.exited;
  }
  for (const worker of workers.splice(0)) await worker.stop();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function home() {
  const dir = mkdtempSync(join(tmpdir(), 'remi-r3-'));
  chmodSync(dir, 0o700);
  homes.push(dir);
  mkdirSync(join(dir, 'bin'), { mode: 0o700 });
  for (const command of ['claude', 'codex'])
    writeFileSync(join(dir, 'bin', command), '#!/bin/sh\nexit 88\n', { mode: 0o700 });
  return dir;
}
function spawn(dir: string, args: string[]) {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: dir,
    env: {
      HOME: dir,
      REMI_HOME: join(dir, 'state'),
      PATH: `${join(dir, 'bin')}:/usr/bin:/bin`,
      NODE_ENV: 'test',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  processes.push(proc);
  return proc;
}
async function hub() {
  const dir = home();
  const worker = await startWorker();
  workers.push(worker);
  const port = await reserveRange(1, 50, '127.0.0.1');
  const proc = spawn(dir, [
    'serve',
    '--relay',
    '--signaling-url',
    worker.wsUrl,
    '--port',
    String(port),
    '--no-mdns',
    '--no-telegram',
  ]);
  const stdout = new Response(proc.stdout).text();
  // Read stderr as it arrives: the hub logs its Worker control admission there.
  const log = { tail: '', admitted: false };
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stderr) {
      log.tail = (log.tail + decoder.decode(chunk, { stream: true })).slice(-8192);
      if (log.tail.includes('Relay control admitted')) log.admitted = true;
    }
  })();
  const deadline = Date.now() + 10000;
  while (true) {
    if (proc.exitCode !== null) throw new Error(`hub exited: ${await stdout} ${log.tail}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error('hub startup deadline');
    await Bun.sleep(10);
  }
  return {
    dir,
    port,
    worker,
    proc,
    capability: readFileSync(join(dir, 'state/capability.key'), 'utf8').trim(),
    controlAdmitted: () => log.admitted,
  };
}
/** Wait for a condition, failing with what was awaited when the deadline passes. */
async function until(done: () => boolean, what: string, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}
async function control(port: number, capability?: string) {
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/relay-control`,
    (capability ? { headers: { [CAPABILITY_HEADER]: capability } } : undefined) as never,
  );
  sockets.push(ws);
  return new Promise<boolean>((resolve) => {
    ws.onopen = () => resolve(true);
    ws.onerror = () => resolve(false);
  });
}
test('hub relay control requires capability and is reachable with the actual local token', async () => {
  const running = await hub();
  expect(await control(running.port)).toBe(false);
  expect(await control(running.port, 'wrong')).toBe(false);
  expect(await control(running.port, running.capability)).toBe(true);
}, 20000);
test('retired code command exits visibly before any model invocation', async () => {
  const proc = spawn(home(), ['code']);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(code).toBe(1);
  expect(`${out}${err}`).toContain('remi pair');
}, 10000);
test('noninteractive pair refuses before dialing or starting a model', async () => {
  const proc = spawn(home(), ['pair']);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(code).toBe(1);
  expect(`${out}${err}`).toContain('interactive terminal');
}, 10000);

import {
  type ProtocolMessage,
  createAnswer,
  createHello,
  createSessionListRequest,
  createUserInput,
  deserialize,
  generateId,
  now,
  relayV2,
  serialize,
} from '@remi/shared';
import {
  Mailbox,
  Socket,
  admit,
  clientUrl,
  hex,
  newIdentity,
  roomCloses,
} from '../../packages/signaling/tests/e2e/endpoints.ts';
async function localSocket(running: Awaited<ReturnType<typeof hub>>) {
  const ws = new WebSocket(`ws://127.0.0.1:${running.port}/relay-control`, {
    headers: { [CAPABILITY_HEADER]: running.capability },
  } as never);
  sockets.push(ws);
  const inbox = new Mailbox<Record<string, unknown>>();
  ws.onmessage = (event) => inbox.push(JSON.parse(String(event.data)));
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('local control refused'));
  });
  return { ws, inbox };
}
async function paired() {
  const running = await hub();
  // Health precedes the hub's asynchronous control admission at the Worker, and a pairing offer
  // needs that control (#1225: a fixed 150 ms wait stood here).
  await until(running.controlAdmitted, 'the hub relay control admission');
  const local = await localSocket(running);
  local.ws.send(JSON.stringify({ t: 'pair', id: 'pair-one' }));
  const offer = await local.inbox.next();
  expect(offer['t']).toBe('offer');
  const token = await relayV2.decodePairingToken(
    String(offer['token']),
    Math.floor(Date.now() / 1000),
  );
  const rid = await relayV2.ridOf(token.machinePublicKey);
  const device = await newIdentity();
  const socket = await Socket.open(clientUrl(running.worker, hex(rid)));
  sockets.push(socket.ws);
  await admit(socket, device, 'client', rid, await relayV2.admitTag(token.secret));
  expect((await socket.json())['t']).toBe('admitted');
  expect((await socket.json())['t']).toBe('open');
  const start = await relayV2.clientStart(
    {
      machinePublicKey: token.machinePublicKey,
      device: device.signer,
      mode: 'pair',
      pairingSecret: token.secret,
      random: relayV2.systemRandom,
      deviceName: 'owned test device',
    },
    Date.now(),
  );
  socket.sendText(start.hello);
  const auth = await start.onHelloAck(await socket.text(), Date.now());
  socket.sendText(auth.auth);
  const compare = await local.inbox.next();
  expect(compare['t']).toBe('compare');
  expect(compare['fingerprint']).toBe(auth.fingerprint);
  expect(existsSync(join(running.dir, 'state/authorized_keys.json'))).toBe(false);
  local.ws.send(
    JSON.stringify({
      t: 'confirm',
      id: 'pair-one',
      offerId: offer['offerId'],
      connectionId: compare['connectionId'],
      fingerprint: compare['fingerprint'],
      accept: true,
    }),
  );
  const ready = await socket.text();
  expect(existsSync(join(running.dir, 'state/authorized_keys.json'))).toBe(true);
  const grants = JSON.parse(readFileSync(join(running.dir, 'state/authorized_keys.json'), 'utf8'));
  expect(
    grants.keys.some(
      (key: { publicKey: string }) =>
        key.publicKey === Buffer.from(device.publicKey).toString('base64'),
    ),
  ).toBe(true);
  expect(
    JSON.parse(readFileSync(join(running.dir, 'state/relay_devices.json'), 'utf8')),
  ).toHaveLength(1);
  const channel = await auth.onReady(ready, Date.now(), {
    emit: (frame) => socket.sendBinary(frame),
    close: (code) => socket.close(code),
  });
  const inbox = new Mailbox<ReturnType<typeof deserialize>>();
  let incoming = Promise.resolve();
  socket.tap((frame) => {
    incoming = incoming.then(async () => {
      if (typeof frame !== 'string') {
        const bytes = await channel.receive(frame);
        if (bytes) inbox.push(deserialize(new TextDecoder().decode(bytes)));
      }
    });
  });
  await channel.send(new TextEncoder().encode(serialize(createHello('owned-device', '2.0.0'))));
  const hello = await nextType(inbox, 'hello_ack');
  expect(hello?.type).toBe('hello_ack');
  const id = generateId();
  await channel.send(
    new TextEncoder().encode(serialize({ type: 'relay_devices_request', id, timestamp: now() })),
  );
  const response = await nextType(inbox, 'relay_devices_response');
  expect(response?.type).toBe('relay_devices_response');
  if (response?.type !== 'relay_devices_response')
    throw new Error('expected correlated devices response');
  expect(response.requestId).toBe(id);
  expect(response.devices).toHaveLength(1);
  return { running, local, device, socket, channel, inbox, drain: () => incoming, rid };
}
/** The Bun release whose client close resets the connection (#1225, `relay-r3-transport-close.test.ts`). */
const RESETTING_RUNTIME = '1.3.11';
/**
 * How the Worker saw the hub's pipe close: the first close the room recorded, as
 * `close <code> "<reason>"` (the hub's pipe closes before the client, whose close it causes).
 */
async function pipeClose(running: Awaited<ReturnType<typeof hub>>, rid: Uint8Array) {
  const deadline = Date.now() + 5000;
  while (true) {
    const first = (await roomCloses(running.worker, hex(rid)))[0];
    if (first) return first;
    if (Date.now() > deadline) throw new Error('timed out waiting for the room to record a close');
    await Bun.sleep(10);
  }
}
/**
 * #1225: the hub's runtime reset the pipe instead of completing the closing handshake, so the
 * Worker recorded an abnormal close (1006) and closed the client with its own failure close. Only
 * the resetting runtime may take this path; any other runtime must close the pipe as asked.
 */
function resetByRuntime(pipe: string): boolean {
  if (!pipe.startsWith('close 1006 ')) return false;
  expect(Bun.version).toBe(RESETTING_RUNTIME);
  return true;
}
test('real source hub grants only after exact local confirmation and persists before encrypted ready', async () => {
  const { socket, channel, drain, running, rid } = await paired();
  socket.sendText('pong');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closed = await Promise.race([
    socket.closed,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), 10000);
    }),
  ]);
  if (timer) clearTimeout(timer);
  expect(closed).not.toBeNull();
  if (!closed) throw new Error('MISSING_READY_TEXT_REFUSAL');
  expect(closed.code).toBe(relayV2.FAILURE_CLOSE.code);
  const pipe = await pipeClose(running, rid);
  if (resetByRuntime(pipe)) {
    // The Worker's own failure close, with its reason.
    expect(closed.reason).toBe(relayV2.FAILURE_CLOSE.reason);
  } else {
    // The hub's failure close, passed on. Bun 1.3.11 drops longer outbound close reasons
    // (existing Worker E2E probe), so from that hub it arrives without one.
    const reason = Bun.version === RESETTING_RUNTIME ? '' : relayV2.FAILURE_CLOSE.reason;
    expect(pipe).toBe(`close ${relayV2.FAILURE_CLOSE.code} ${JSON.stringify(reason)}`);
    expect(closed.reason).toBe(reason);
  }
  await drain();
  expect(await channel.transportClosed()).toBe('unclean');
}, 20000);

test('authenticated peer BYE receives authenticated host BYE and orderly close', async () => {
  const { channel, socket, drain, running, rid } = await paired();
  await channel.bye();
  const closed = await socket.closed;
  await drain();
  // What the protocol guarantees: the hub's authenticated BYE arrived before the close.
  expect(await channel.transportClosed()).toBe('clean');
  const pipe = await pipeClose(running, rid);
  if (resetByRuntime(pipe)) {
    // The orderly close was lost with the reset; the Worker closed the client with its own.
    expect(closed.code).toBe(relayV2.FAILURE_CLOSE.code);
  } else {
    expect(pipe).toBe('close 1000 ""');
    expect(closed.code).toBe(1000);
  }
}, 20000);
async function nextType(
  inbox: Mailbox<ReturnType<typeof deserialize>>,
  type: ProtocolMessage['type'],
  predicate: (message: ProtocolMessage) => boolean = () => true,
) {
  for (let i = 0; i < 64; i++) {
    const message = await inbox.next();
    if (message?.type === 'raw_pty_output') throw new Error('RAW_PTY_REACHED_RELAY');
    if (message?.type === type && predicate(message)) return message;
  }
  throw new Error('semantic response not found');
}
test('actual child hook decision yields delivered result while stale answer refuses and raw PTY stays local', async () => {
  const { running, channel, inbox } = await paired();
  writeFileSync(
    join(running.dir, 'bin/claude'),
    '#!/bin/sh\nprintf "RAW_PTY_PRIVATE_SENTINEL\\n"\nexec /bin/cat\n',
    { mode: 0o700 },
  );
  const port = await reserveRange(1, 50, '127.0.0.1');
  const child = spawn(running.dir, [
    '--daemon',
    '--port',
    String(port),
    '--no-relay',
    '--no-mdns',
    '--no-telegram',
  ]);
  const childOut = new Response(child.stdout).text();
  const childErr = new Response(child.stderr).text();
  const deadline = Date.now() + 10000;
  let entry: { sessionId: string; hookPort: number; wsPort: number } | undefined;
  while (!entry) {
    if (child.exitCode !== null)
      throw new Error(`controlled child exited: ${await childOut} ${await childErr}`);
    const live = join(running.dir, 'state/live-sessions');
    if (existsSync(live))
      for (const name of readdirSync(live).filter((name) => name.endsWith('.json'))) {
        const value = JSON.parse(readFileSync(join(live, name), 'utf8'));
        if (value.pid === child.pid && value.claudeChildPid) entry = value;
      }
    if (Date.now() > deadline) throw new Error('controlled child registration deadline');
    if (!entry) await Bun.sleep(10);
  }
  const list = createSessionListRequest();
  await channel.send(new TextEncoder().encode(serialize(list)));
  const discovery = await nextType(
    inbox,
    'session_list_response',
    (message) => message.type === 'session_list_response' && message.requestId === list.id,
  );
  expect(discovery.type === 'session_list_response' && discovery.requestId).toBe(list.id);
  expect(
    discovery.type === 'session_list_response' &&
      discovery.sessions.some((session) => session.sessionId === entry.sessionId),
  ).toBe(true);
  await channel.send(
    new TextEncoder().encode(
      serialize(createHello('test', '2.0.0', { resumeSessionId: entry.sessionId })),
    ),
  );
  const attached = await nextType(inbox, 'hello_ack');
  expect(attached.type === 'hello_ack' && attached.sessionId).toBe(entry.sessionId);
  expect(attached.type === 'hello_ack' && Boolean(attached.attachState)).toBe(true);
  if (attached.type !== 'hello_ack' || !attached.claudeSessionId)
    throw new Error('child binding missing');
  const binding = attached.claudeSessionId;
  const controller = new AbortController();
  const hook = fetch(`http://127.0.0.1:${entry.hookPort}/hooks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: controller.signal,
    body: JSON.stringify({
      hook_event_name: 'PermissionRequest',
      session_id: binding,
      transcript_path: attached.transcriptPath ?? join(running.dir, 'owned.jsonl'),
      cwd: running.dir,
      permission_mode: 'default',
      tool_name: 'Bash',
      tool_input: { command: 'PRIVATE_TOOL_SENTINEL' },
    }),
  });
  try {
    const question = await nextType(inbox, 'question');
    if (question.type !== 'question') throw new Error('expected question');
    await channel.send(
      new TextEncoder().encode(
        serialize(
          createUserInput(entry.sessionId, 'PRIVATE_REFUSED_CHAT_SENTINEL', false, binding),
        ),
      ),
    );
    const inputRefusal = await nextType(inbox, 'error');
    expect(inputRefusal.type === 'error' && inputRefusal.code).toBe('PROMPT_WAITING');
    const no = question.question.options.find((option) => option.isNo);
    if (!no) throw new Error('expected held deny option');
    const answer = createAnswer(
      entry.sessionId,
      question.question.id,
      no.value,
      binding,
      'PRIVATE_DENIAL_SENTINEL',
    );
    await channel.send(new TextEncoder().encode(serialize(answer)));
    const result = await nextType(inbox, 'answer_result');
    expect(result.type === 'answer_result' && result.requestId).toBe(answer.id);
    expect(result.type === 'answer_result' && result.outcome).toBe('delivered');
    const decision = await (await hook).json();
    expect(decision.hookSpecificOutput.decision.behavior).toBe('deny');
    expect(decision.hookSpecificOutput.decision.message).toBe('PRIVATE_DENIAL_SENTINEL');
    const stale = createAnswer(entry.sessionId, 'missing-question', 'yes');
    await channel.send(new TextEncoder().encode(serialize(stale)));
    const refused = await nextType(inbox, 'answer_result');
    expect(refused.type === 'answer_result' && refused.requestId).toBe(stale.id);
    expect(refused.type === 'answer_result' && refused.outcome).toBe('stale');
    await channel.send(
      new TextEncoder().encode(
        serialize(createUserInput(entry.sessionId, 'PRIVATE_CHAT_SENTINEL', false, binding)),
      ),
    );
    await channel.send(
      new TextEncoder().encode(
        serialize(createUserInput(entry.sessionId, 'PRIVATE_RAW_INPUT_SENTINEL', true, binding)),
      ),
    );
    // Drain one subsequent correlated semantic request before collecting local diagnostics.
    const after = createSessionListRequest();
    await channel.send(new TextEncoder().encode(serialize(after)));
    await nextType(
      inbox,
      'session_list_response',
      (message) => message.type === 'session_list_response' && message.requestId === after.id,
    );
    child.kill('SIGTERM');
    await child.exited;
    const diagnostic = (await childOut) + (await childErr);
    for (const sentinel of [
      'PRIVATE_DENIAL_SENTINEL',
      'PRIVATE_REFUSED_CHAT_SENTINEL',
      'PRIVATE_CHAT_SENTINEL',
      'PRIVATE_RAW_INPUT_SENTINEL',
    ])
      expect(diagnostic).not.toContain(sentinel);
  } finally {
    controller.abort();
    await hook.catch(() => {});
  }
}, 25000);
