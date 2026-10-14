/// <reference path="./pngjs.d.ts" />
/** Actual compiled CLI/worker/signed socket/held-hook path with an inert local cat harness. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  type HelloAckMessage,
  type ImageInsertRequest,
  type ImageUploadBegin,
  type ProtocolMessage,
  createAnswer,
  createAuthResponse,
  createHello,
  createIdentity,
  createPong,
  deserialize,
  fromBase64,
  generateId,
  serialize,
  sign,
  unlockIdentity,
} from '../../packages/shared/src/index';
import jpg from './fixture.jpg' with { type: 'file' };
import png from './fixture.png' with { type: 'file' };

assert(process.argv[2] === '--owned-spike', 'owned acceptance only');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'dip-'));
fs.chmodSync(fixture, 0o700);
for (const name of ['user', 'state', 'project', 'bin', 'tmp'])
  fs.mkdirSync(path.join(fixture, name), { mode: 0o700 });
fs.writeFileSync(path.join(fixture, 'bin/claude'), '#!/bin/sh\nexec /bin/cat\n', { mode: 0o700 });
const env = {
  PATH: `${fixture}/bin:/usr/bin:/bin`,
  HOME: path.join(fixture, 'user'),
  REMI_HOME: path.join(fixture, 'state'),
  TMPDIR: path.join(fixture, 'tmp'),
  REMI_PTY_CAPTURE: path.join(fixture, 'capture.jsonl'),
};
const children: { pid: number; exitCode: number | null; reaped: true }[] = [];
const reaped = (child: { pid: number; exitCode: number | null }) => {
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' }, 'owned CLI child reaped');
  children.push({ pid: child.pid, exitCode: child.exitCode, reaped: true });
};
const checks: string[] = [];
let daemon: ReturnType<typeof Bun.spawn> | undefined;
let socket: WebSocket | undefined;
let daemonLog: number | undefined;
let completed = false;
const hookAbort = new AbortController();
let hookTimer: ReturnType<typeof setTimeout> | undefined;
async function until(test: () => boolean, label: string) {
  const deadline = performance.now() + 15_000;
  while (!test()) {
    assert(performance.now() < deadline, label);
    await Bun.sleep(10);
  }
}
async function smallOutput(stream: ReadableStream<Uint8Array>, stop: () => void): Promise<number> {
  const reader = stream.getReader();
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return bytes;
      bytes += chunk.value.byteLength;
      if (bytes > 65536) {
        stop();
        throw new Error('Owned CLI output overflow');
      }
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
async function cli(args: string[]) {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: path.join(fixture, 'project'),
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  try {
    const [stdout, stderr, exit] = await Promise.all([
      smallOutput(child.stdout, () => child.kill('SIGKILL')),
      smallOutput(child.stderr, () => child.kill('SIGKILL')),
      child.exited,
    ]);
    assert(stdout + stderr < 65536, 'bounded owned CLI output');
    assert.equal(exit, 0, 'owned CLI command exits successfully');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await child.exited;
    clearTimeout(timer);
    reaped(child);
  }
}
const inputs = (): string[] =>
  fs
    .readFileSync(env.REMI_PTY_CAPTURE, 'utf8')
    .split('\n')
    .flatMap((line) => {
      const match = /^IN \d+ \S+ (.*)$/.exec(line);
      return match ? [JSON.parse(match[1] ?? '') as string] : [];
    });
try {
  const identity = await createIdentity();
  const unlocked = await unlockIdentity(identity);
  await cli([
    'authorize',
    JSON.stringify({ publicKey: identity.publicKey }),
    '--label',
    'owned compiled fixture',
  ]);
  const reserve = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('owned') });
  const port = reserve.port;
  reserve.stop(true);
  const logPath = path.join(fixture, 'daemon.log');
  daemonLog = fs.openSync(logPath, 'w', 0o600);
  daemon = Bun.spawn(
    [
      process.execPath,
      '--daemon',
      '--auth',
      '--port',
      String(port),
      '--bind',
      '127.0.0.1',
      '--no-mdns',
      '--no-relay',
    ],
    {
      cwd: path.join(fixture, 'project'),
      env,
      stdin: 'ignore',
      stdout: daemonLog,
      stderr: daemonLog,
    },
  );
  await until(
    () => fs.readFileSync(logPath, 'utf8').includes('WebSocket adapter listening on port'),
    'actual CLI readiness',
  );
  const messages: ProtocolMessage[] = [];
  let socketError: unknown;
  socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  socket.onmessage = async (event) => {
    try {
      const message = deserialize(String(event.data));
      assert(message, 'compiled daemon response decodes');
      messages.push(message);
      if (message.type === 'auth_challenge')
        socket?.send(
          serialize(
            createAuthResponse(
              identity.publicKey,
              await sign(unlocked.privateKey, fromBase64(message.challenge)),
              identity.fingerprint,
            ),
          ),
        );
      else if (message.type === 'auth_result') {
        assert.equal(message.success, true, 'actual device signature admitted');
        socket?.send(serialize(createHello(generateId(), 'owned compiled fixture')));
      } else if (message.type === 'ping') socket?.send(serialize(createPong(message.id)));
    } catch (error) {
      socketError = error;
    }
  };
  await until(() => messages.some((m) => m.type === 'hello_ack'), 'signed hello');
  let hello = messages.find(
    (m): m is HelloAckMessage => m.type === 'hello_ack' && m.sessionId !== null,
  );
  if (!hello) {
    await Bun.sleep(500);
    socket.send(serialize(createHello(generateId(), 'owned compiled fixture')));
    await until(
      () => messages.some((m) => m.type === 'hello_ack' && m.sessionId !== null),
      'live bound hello',
    );
    hello = messages.find(
      (m): m is HelloAckMessage => m.type === 'hello_ack' && m.sessionId !== null,
    );
  }
  assert(hello?.sessionId && hello.harnessSessionId && hello.harness === 'claude');
  assert(hello.capabilities?.includes('image_staging'));
  assert(
    !hello.capabilities?.includes('image_insertion'),
    'client availability gate remains closed',
  );
  const sessionId = hello.sessionId;
  const binding = { harness: 'claude' as const, harnessSessionId: hello.harnessSessionId };
  const envelope = () => ({ id: generateId(), timestamp: new Date().toISOString(), sessionId });
  async function exchange<T extends ProtocolMessage['type']>(
    request: ProtocolMessage,
    type: T,
    raw = serialize(request),
  ): Promise<Extract<ProtocolMessage, { type: T }>> {
    const at = messages.length;
    socket?.send(raw);
    const response = () =>
      messages.slice(at).find((m) => 'requestId' in m && m.requestId === request.id);
    await until(() => response() !== undefined, 'correlated actual CLI response');
    const value = response();
    assert.equal(value?.type, type, 'expected actual response kind');
    return value as Extract<ProtocolMessage, { type: T }>;
  }
  async function stage(asset: string, mediaType: 'image/png' | 'image/jpeg') {
    const bytes = Buffer.from(await Bun.file(asset).arrayBuffer());
    const begin: ImageUploadBegin = {
      ...envelope(),
      type: 'image_upload_begin',
      binding,
      mediaType,
      byteLength: bytes.length,
      digest: createHash('sha256').update(bytes).digest('base64url'),
    };
    const accepted = await exchange(begin, 'image_upload_accepted');
    for (let at = 0, seq = 0; at < bytes.length; at += 32768, seq++)
      await exchange(
        {
          ...envelope(),
          type: 'image_upload_chunk',
          transferId: accepted.transferId,
          seq,
          data: bytes.subarray(at, at + 32768).toString('base64url'),
        },
        'image_upload_chunk_ack',
      );
    const staged = await exchange(
      { ...envelope(), type: 'image_upload_complete', transferId: accepted.transferId },
      'image_upload_result',
    );
    assert.equal(staged.digest, begin.digest);
    return {
      bytes,
      request: {
        ...envelope(),
        type: 'image_insert_request',
        binding,
        artifactId: staged.artifactId,
      } satisfies ImageInsertRequest,
    };
  }
  let lastRequest: ImageInsertRequest | undefined;
  let writes = 0;
  for (const [asset, mediaType] of [
    [png, 'image/png'],
    [jpg, 'image/jpeg'],
  ] as const) {
    const { bytes, request } = await stage(asset, mediaType);
    lastRequest = request;
    const first = await exchange(request, 'image_insert_result');
    assert.equal(first.outcome, 'inserted');
    const reordered = {
      ...request,
      binding: { harnessSessionId: binding.harnessSessionId, harness: binding.harness },
    };
    assert.deepEqual(
      await exchange(request, 'image_insert_result', JSON.stringify(reordered)),
      first,
    );
    assert.equal(
      (await exchange({ ...request, id: generateId() }, 'image_insert_result')).code,
      'conflict',
    );
    const written = inputs();
    assert.equal(written.length, ++writes);
    const text = written.at(-1);
    assert(typeof text === 'string' && !/[\r\n]/u.test(text));
    const match = /^ @"([^"]+\.(?:png|jpg))" $/u.exec(text);
    assert(match?.[1]);
    assert.deepEqual(fs.readFileSync(match[1]), bytes, 'exact retained image reference');
  }
  checks.push(
    'actual compiled CLI worker stages PNG and JPEG',
    'one no-Enter reference and reordered retry replay per artifact',
  );

  const heldImage = await stage(png, 'image/png');
  const settings = JSON.parse(
    fs.readFileSync(path.join(fixture, 'project/.claude/settings.local.json'), 'utf8'),
  ) as { hooks: { PermissionRequest: { hooks: { type: string; url: string }[] }[] } };
  const hook = settings.hooks.PermissionRequest.flatMap((entry) => entry.hooks).find(
    (entry) => entry.type === 'http',
  );
  assert(hook && ['127.0.0.1', 'localhost'].includes(new URL(hook.url).hostname));
  const at = messages.length;
  hookTimer = setTimeout(() => hookAbort.abort(), 15_000);
  const held = fetch(hook.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: hookAbort.signal,
    body: JSON.stringify({
      session_id: binding.harnessSessionId,
      transcript_path: path.join(fixture, 'project/transcript.jsonl'),
      cwd: path.join(fixture, 'project'),
      permission_mode: 'default',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'echo REMI_COMPILED_INSERT_HOLD' },
    }),
  });
  void held.catch(() => {});
  await until(
    () => messages.slice(at).some((m) => m.type === 'question'),
    'actual compiled held hook question',
  );
  assert.equal((await exchange(heldImage.request, 'image_insert_result')).code, 'prompt_up');
  assert.equal(inputs().length, writes, 'held hook receives no image reference');
  const question = messages.slice(at).find((m) => m.type === 'question');
  assert(question?.type === 'question');
  const no = question.question.options?.find((option) => /^no\b/iu.test(option.label));
  assert(no, 'actual hook has a No option');
  socket.send(serialize(createAnswer(sessionId, question.question.id, no.value)));
  const denied = await held;
  assert.equal(denied.status, 200);
  const decision = (await denied.json()) as {
    hookSpecificOutput: { decision: { behavior: string } };
  };
  assert.equal(decision.hookSpecificOutput.decision.behavior, 'deny');
  checks.push('actual compiled held hook refuses insertion and receives No');

  await cli(['authorize', '--remove', identity.fingerprint]);
  assert(lastRequest);
  assert.equal((await exchange(lastRequest, 'image_insert_result')).code, 'unavailable');
  assert.equal(inputs().length, writes);
  assert.equal(socketError, undefined);
  checks.push('revoked original grant cannot replay a cached result');
  completed = true;
} finally {
  if (hookTimer !== undefined) clearTimeout(hookTimer);
  hookAbort.abort();
  socket?.close();
  if (daemon) {
    daemon.kill('SIGTERM');
    const timer = setTimeout(() => daemon?.kill('SIGKILL'), 5000);
    try {
      await daemon.exited;
    } finally {
      clearTimeout(timer);
    }
    reaped(daemon);
    if (completed) assert.equal(daemon.exitCode, 0, 'actual daemon graceful cleanup');
  }
  if (daemonLog !== undefined) fs.closeSync(daemonLog);
  if (completed) {
    const ledger = JSON.parse(
      fs.readFileSync(path.join(fixture, 'state/image-staging/ledger/reservations.json'), 'utf8'),
    ) as { records: { state: string; charge: number }[] };
    assert.equal(ledger.records.length, 3);
    assert(ledger.records.every((record) => record.state === 'settled' && record.charge === 0));
    assert.deepEqual(fs.readdirSync(path.join(fixture, 'state/image-staging/scratch')), []);
    assert.deepEqual(fs.readdirSync(path.join(fixture, 'state/image-staging/metadata')), []);
    fs.rmSync(fixture, { recursive: true });
  }
}
console.log(
  JSON.stringify({
    bun: Bun.version,
    platform: process.platform,
    arch: process.arch,
    checks,
    children,
    scope:
      'Actual compiled direct production entry with inert cat CLI; no model or native/client availability',
  }),
);
