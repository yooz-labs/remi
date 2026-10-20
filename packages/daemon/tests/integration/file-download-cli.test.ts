/** Shipping entry -> owned actual harness process -> signed WSS -> real D2 service. */
import { expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import {
  type FileFetchAccepted,
  createAnswer,
  createDetachSession,
  createHello,
  createResumeSessionRequest,
  createSessionListRequest,
  createUserInput,
  decodeFileDownloadFrame,
  encodeFileDownloadFrame,
  serialize,
} from '@remi/shared';
import type { FileDownloadRequest } from '../../src/tunnel/file-download-service';
import { Reservations } from '../../src/tunnel/reservations';
import { until } from '../helpers/browser-link-service-fixture';
import {
  fileDownloadCliFixture,
  relayFileDownloadCliFixture,
} from '../helpers/file-download-cli-fixture';

type Fixture = Awaited<ReturnType<typeof fileDownloadCliFixture>>;
type Peer = Awaited<ReturnType<Fixture['peer']>>;
// Observation only: never contend with admission by acquiring the daemon's ledger lock.
function ledgerMatches(
  f: Pick<Fixture, 'files'>,
  predicate: (rows: readonly { state: string; charge: number }[]) => boolean,
): boolean {
  const value = JSON.parse(
    fs.readFileSync(join(f.files.home, 'image-staging', 'ledger', 'reservations.json'), 'utf8'),
  );
  if (
    value.version !== 1 ||
    !Array.isArray(value.records) ||
    !value.records.every(
      (row: unknown) =>
        row &&
        typeof row === 'object' &&
        'state' in row &&
        typeof row.state === 'string' &&
        'charge' in row &&
        typeof row.charge === 'number',
    )
  )
    throw new Error('Owned ledger observation was invalid');
  return predicate(value.records);
}
function common(peer: Peer) {
  const sessionId = peer.hello().sessionId;
  if (!sessionId) throw new Error('Missing actual session');
  return { id: crypto.randomUUID(), timestamp: new Date().toISOString(), sessionId };
}
function begin(peer: Peer, relativePath = 'sample.bin'): FileDownloadRequest {
  const hello = peer.hello();
  if (!hello.harnessSessionId || (hello.harness !== 'claude' && hello.harness !== 'codex'))
    throw new Error('Actual known harness binding absent');
  return {
    ...common(peer),
    type: 'file_fetch_begin',
    relativePath,
    binding: { harness: hello.harness, harnessSessionId: hello.harnessSessionId },
  };
}
async function submit(peer: Peer, request: FileDownloadRequest, timeout = 3000) {
  peer.ws.send(encodeFileDownloadFrame(request));
  await until(
    () => peer.frames.some((frame) => 'requestId' in frame && frame.requestId === request.id),
    'shipping download response',
    timeout,
  );
  const response = peer.frames.find(
    (frame) => 'requestId' in frame && frame.requestId === request.id,
  );
  if (!response) throw new Error('Actual correlated response absent');
  expect(
    peer.received.some((frame) => frame.type === 'ack' && frame.ack.messageId === request.id),
  ).toBe(false);
  return response;
}
function accepted(value: Awaited<ReturnType<typeof submit>>): FileFetchAccepted {
  expect(value.type, JSON.stringify(value)).toBe('file_fetch_accepted');
  if (value.type !== 'file_fetch_accepted') throw new Error('Actual CLI refused acceptance');
  return value;
}
async function pull(peer: Peer, value: FileFetchAccepted) {
  const hash = createHash('sha256');
  let received = 0;
  let sequence = 0;
  while (received < value.byteLength) {
    const chunk = await submit(peer, {
      ...common(peer),
      type: 'file_fetch_read',
      transferId: value.transferId,
      seq: sequence,
      receivedBytes: received,
    });
    expect(chunk.type).toBe('file_fetch_chunk');
    if (chunk.type !== 'file_fetch_chunk') throw new Error('Missing actual private chunk');
    expect(chunk.seq).toBe(sequence++);
    const bytes = Buffer.from(chunk.data, 'base64url');
    expect(bytes.length).toBe(Math.min(32768, value.byteLength - received));
    received += bytes.length;
    hash.update(bytes);
  }
  expect(hash.digest('base64url')).toBe(value.digest);
  expect(
    await submit(peer, {
      ...common(peer),
      type: 'file_fetch_complete',
      transferId: value.transferId,
      receivedBytes: received,
      digest: value.digest,
    }),
  ).toMatchObject({ type: 'file_fetch_result', outcome: 'complete' });
  return sequence;
}

for (const harness of ['claude', 'codex'] as const)
  test(`actual ${harness} CLI advertises only scoped known TLS readiness and pulls1/32768/10MiB`, async () => {
    const f = await fileDownloadCliFixture({ harness, known: harness !== 'codex' });
    try {
      const peer = await f.peer();
      if (harness === 'codex') {
        expect(peer.hello().harnessSessionId).toBeNull();
        expect(peer.hello().capabilities).not.toContain('file_download');
        const first = peer.received.filter((frame) => frame.type === 'hello_ack').length;
        const replays = peer.received.filter((frame) => frame.type === 'replay_batch').length;
        const identity = await f.learnCodexIdentity();
        await until(
          () => peer.hello().harnessSessionId === identity,
          'current scoped known Codex hello',
        );
        expect(peer.received.filter((frame) => frame.type === 'hello_ack')).toHaveLength(first + 1);
        expect(peer.hello().attachState).toBe('attached');
        expect(peer.received.filter((frame) => frame.type === 'replay_batch')).toHaveLength(
          replays,
        );
      }
      expect(peer.hello().harness).toBe(harness);
      expect(peer.hello().capabilities).toContain('file_download');
      expect(peer.hello().machine?.capabilities).toEqual(peer.hello().capabilities);
      for (const size of [1, 32768, 10485760]) {
        const bytes = randomBytes(size);
        f.write('sample.bin', bytes);
        const value = accepted(await submit(peer, begin(peer), size === 10485760 ? 10000 : 3000));
        expect(value.byteLength).toBe(size);
        expect(value.digest).toBe(createHash('sha256').update(bytes).digest('base64url'));
        expect(await pull(peer, value)).toBe(Math.ceil(size / 32768));
      }
      expect(
        new Reservations(join(f.files.home, 'image-staging', 'ledger'))
          .inspect()
          .every((row) => row.state === 'settled' && row.charge === 0),
      ).toBe(true);
    } finally {
      await f.close();
    }
  }, 45000);

test('actual Codex committed rotation refreshes once and cannot continue an old transfer', async () => {
  const f = await fileDownloadCliFixture({ harness: 'codex' });
  try {
    f.write('sample.bin', 'owned Codex rotation');
    const peer = await f.peer();
    const old = accepted(await submit(peer, begin(peer)));
    const count = peer.received.filter((frame) => frame.type === 'hello_ack').length;
    const next = await f.learnCodexIdentity();
    await until(() => peer.hello().harnessSessionId === next, 'actual rotated scoped hello');
    expect(peer.received.filter((frame) => frame.type === 'hello_ack')).toHaveLength(count + 1);
    expect(
      await submit(peer, {
        ...common(peer),
        type: 'file_fetch_read',
        transferId: old.transferId,
        seq: 0,
        receivedBytes: 0,
      }),
    ).toMatchObject({ type: 'file_fetch_refused', code: 'unavailable' });
    await pull(peer, accepted(await submit(peer, begin(peer))));
  } finally {
    await f.close();
  }
}, 30000);

test('shipping attachment duplicate preserves authority; actual detach and fresh attach retire it', async () => {
  const f = await fileDownloadCliFixture();
  try {
    f.write('sample.bin', randomBytes(32769));
    const peer = await f.peer();
    const value = accepted(await submit(peer, begin(peer)));
    let count = peer.received.filter((frame) => frame.type === 'hello_ack').length;
    const actualSession = peer.hello().sessionId;
    if (!actualSession) throw new Error('Actual attached session absent');
    peer.ws.send(serialize(createResumeSessionRequest(actualSession)));
    await until(
      () => peer.received.filter((frame) => frame.type === 'hello_ack').length > count,
      'actual duplicate attach hello',
    );
    expect(
      await submit(peer, {
        ...common(peer),
        type: 'file_fetch_read',
        transferId: value.transferId,
        seq: 0,
        receivedBytes: 0,
      }),
    ).toMatchObject({ type: 'file_fetch_chunk', seq: 0 });
    const sessionId = peer.hello().sessionId;
    if (!sessionId) throw new Error('Actual attached session absent');
    peer.ws.send(serialize(createDetachSession(sessionId)));
    await until(
      () => peer.received.some((frame) => frame.type === 'detach_session_ack' && frame.success),
      'actual detach acknowledgement',
    );
    const detachedRead: FileDownloadRequest = {
      ...common(peer),
      type: 'file_fetch_read',
      transferId: value.transferId,
      seq: 1,
      receivedBytes: 32768,
    };
    peer.ws.send(encodeFileDownloadFrame(detachedRead));
    await Bun.sleep(100);
    expect(
      peer.frames.some((frame) => 'requestId' in frame && frame.requestId === detachedRead.id),
    ).toBe(false);
    count = peer.received.filter((frame) => frame.type === 'hello_ack').length;
    peer.ws.send(serialize(createResumeSessionRequest(sessionId)));
    await until(
      () => peer.received.filter((frame) => frame.type === 'hello_ack').length > count,
      'actual fresh attach hello',
    );
    await pull(peer, accepted(await submit(peer, begin(peer))));
  } finally {
    await f.close();
  }
}, 30000);

test('actual inactive-default appearance retires prior context and sticky removal stays unavailable', async () => {
  const f = await fileDownloadCliFixture();
  try {
    f.write('sample.bin', 'owned protection generation');
    const peer = await f.peer();
    const value = accepted(await submit(peer, begin(peer)));
    const inactive = join(f.files.userHome, '.codex');
    fs.mkdirSync(inactive, { mode: 0o700 });
    const boundaryRead: FileDownloadRequest = {
      ...common(peer),
      type: 'file_fetch_read',
      transferId: value.transferId,
      seq: 0,
      receivedBytes: 0,
    };
    peer.ws.send(encodeFileDownloadFrame(boundaryRead));
    await until(
      () =>
        ledgerMatches(f, (rows) =>
          rows.every((row) => row.state === 'settled' && row.charge === 0),
        ),
      'invalidated transfer settlement',
    );
    expect(
      peer.frames.some(
        (frame) =>
          'requestId' in frame &&
          frame.requestId === boundaryRead.id &&
          frame.type === 'file_fetch_chunk',
      ),
    ).toBe(false);
    expect(await submit(peer, { ...boundaryRead, id: crypto.randomUUID() })).toMatchObject({
      type: 'file_fetch_refused',
      code: 'unavailable',
    });
    await pull(peer, accepted(await submit(peer, begin(peer))));
    fs.rmdirSync(inactive);
    expect(await submit(peer, begin(peer))).toMatchObject({
      type: 'file_fetch_refused',
      code: 'unavailable',
    });
  } finally {
    await f.close();
  }
}, 30000);

test('TLS-off CLI keeps ordinary signed monitoring without download capability or fallback', async () => {
  const f = await fileDownloadCliFixture({ tls: false });
  try {
    const peer = await f.peer();
    expect(peer.hello().sessionId).toBeString();
    expect(peer.hello().harnessSessionId).toBeString();
    expect(peer.hello().capabilities).not.toContain('file_download');
  } finally {
    await f.close();
  }
});

test('actual wrapper downloads and ordinary process cleanup join the actual consumer', async () => {
  const f = await fileDownloadCliFixture({ mode: 'wrapper' });
  try {
    f.write('sample.bin', 'wrapper');
    const peer = await f.peer();
    expect(peer.hello().capabilities).toContain('file_download');
    await pull(peer, accepted(await submit(peer, begin(peer))));
  } finally {
    await f.close();
  }
  expect(f.proc.exitCode).toBe(0);
});

test('occupied public port unwinds helper-owned startup before returning a fixture', async () => {
  const held = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('owned retained listener'),
  });
  let captured: { files: { directory: string }; proc: Bun.Subprocess } | undefined;
  try {
    await expect(
      fileDownloadCliFixture({
        port: held.port as number,
        observe: (owned) => {
          captured = owned;
        },
      }),
    ).rejects.toThrow('Owned download CLI startup failed');
    expect(captured?.proc.exitCode).toBe(1);
    if (!captured) throw new Error('Owned failed startup resources absent');
    expect(fs.existsSync(captured.files.directory)).toBe(false);
    expect(await (await fetch(`http://127.0.0.1:${held.port}`)).text()).toBe(
      'owned retained listener',
    );
  } finally {
    held.stop(true);
  }
}, 30000);

test('actual held No completes within1000ms while shipping TLS download work is active without PTY input', async () => {
  const f = await fileDownloadCliFixture();
  const abort = new AbortController();
  let transfer: Promise<void> | undefined;
  let heldResponse: Promise<unknown> | undefined;
  try {
    f.write('sample.bin', randomBytes(10485760));
    const peer = await f.peer();
    // Only this fixture's CLI-generated project hook file is read, never installed settings.
    const owned = JSON.parse(
      fs.readFileSync(join(f.files.work, '.claude', 'settings.local.json'), 'utf8'),
    ) as {
      hooks?: Record<string, { hooks: { type: string; url: string }[] }[]>;
    };
    const url = owned.hooks?.['PermissionRequest']
      ?.flatMap((entry) => entry.hooks)
      .find((entry) => entry.type === 'http')?.url;
    if (!url) throw new Error('Owned generated hook endpoint absent');
    const response = fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: abort.signal,
      body: JSON.stringify({
        hook_event_name: 'PermissionRequest',
        session_id: peer.hello().harnessSessionId,
        cwd: fs.realpathSync(f.files.work),
        permission_mode: 'default',
        tool_name: 'Bash',
        tool_input: { command: 'echo owned-held-no' },
        permission_suggestions: [],
      }),
    }).then((value) => value.json());
    heldResponse = response;
    void response.catch(() => {});
    await until(
      () => peer.received.some((frame) => frame.type === 'question'),
      'actual held question',
    );
    const question = peer.received.find((frame) => frame.type === 'question');
    if (question?.type !== 'question') throw new Error('Missing held question');
    let finished = false;
    transfer = (async () => {
      await pull(peer, accepted(await submit(peer, begin(peer), 10000)));
      finished = true;
    })();
    void transfer.catch(() => {}); // Observed below; early failure still closes its actual owner.
    await until(
      () => ledgerMatches(f, (rows) => rows.some((row) => row.state === 'active')),
      'actual charged active download',
    );
    expect(finished).toBe(false);
    const started = performance.now();
    const sessionId = peer.hello().sessionId;
    if (!sessionId) throw new Error('Actual attached session absent');
    peer.ws.send(
      serialize(
        createAnswer(
          sessionId,
          question.question.id,
          'No',
          peer.hello().claudeSessionId ?? undefined,
        ),
      ),
    );
    const result = await response;
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThanOrEqual(1000);
    expect(result).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } });
    await transfer;
    const reaped = await f.close();
    expect(reaped.consumerReaped).toBe(true);
    expect(reaped.daemonReaped).toBe(true);
    expect(reaped.stdin).toEqual(Buffer.alloc(0));
    console.info(
      'Owned shipping held-No receipt',
      JSON.stringify({
        elapsedMilliseconds: elapsed,
        downloadBytes: 10485760,
        activeAtAnswer: true,
      }),
    );
  } finally {
    abort.abort();
    try {
      await f.close();
    } finally {
      await transfer?.catch(() => {});
      await heldResponse?.catch(() => {});
    }
  }
}, 45000);

for (const harness of ['claude', 'codex'] as const)
  test(`actual ${harness} raw recorder captures one byte without Enter through reap`, async () => {
    const f = await fileDownloadCliFixture({ harness });
    try {
      const peer = await f.peer();
      const sessionId = peer.hello().sessionId;
      if (!sessionId) throw Error('Actual attached session absent');
      peer.ws.send(serialize(createUserInput(sessionId, 'q', true)));
      await until(
        () => fs.readFileSync(join(f.files.directory, 'consumer-input')).length === 1,
        'actual raw single byte',
      );
    } finally {
      const reaped = await f.close();
      expect(reaped.consumerReaped).toBe(true);
      expect(reaped.daemonReaped).toBe(true);
      expect(reaped.stdin).toEqual(Buffer.from('q'));
    }
  }, 30000);

test('a missing raw-input record is unproven after actual reap and retains its fixture', async () => {
  const f = await fileDownloadCliFixture();
  const pid = Number(fs.readFileSync(join(f.files.directory, 'consumer-pid'), 'utf8'));
  try {
    await f.peer();
    fs.unlinkSync(join(f.files.directory, 'consumer-input'));
    const failure = await f.close().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError))
      throw Error('Missing raw witness was incorrectly accepted');
    expect(
      failure.errors.some(
        (error: unknown) =>
          error instanceof Error && error.message.includes('Raw input witness missing'),
      ),
    ).toBe(true);
    expect(fs.existsSync(f.files.directory)).toBe(true);
    expect(f.proc.exitCode).not.toBeNull();
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    await f.close().catch(() => {});
    let gone = false;
    try {
      process.kill(pid, 0);
    } catch (error) {
      gone = (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
    // Cleanup after proved death is separate from claiming a measured zero-byte receipt.
    if (f.proc.exitCode !== null && gone) f.files.cleanup();
  }
}, 30000);

type RelayCliFixture = Awaited<ReturnType<typeof relayFileDownloadCliFixture>>;
type RelayCliPeer = Awaited<ReturnType<RelayCliFixture['connect']>>;
async function relayHello(f: RelayCliFixture, peer: RelayCliPeer) {
  await peer.send(createHello('owned', 'T4', { resumeSessionId: f.sessionId }));
  const hello = await peer.next();
  if (hello.type !== 'hello_ack') throw Error('Actual relay child hello absent');
  return hello;
}
async function relayListBarrier(
  peer: RelayCliPeer,
  received: import('@remi/shared').ProtocolMessage[],
) {
  await peer.send(createSessionListRequest());
  for (let i = 0; i < 64; i++) {
    const message = await peer.next();
    received.push(message);
    if (message.type === 'session_list_response') return;
  }
  throw Error('Actual child list ordering barrier absent');
}
async function relaySubmit(
  peer: RelayCliPeer,
  request: FileDownloadRequest,
  received: import('@remi/shared').ProtocolMessage[] = [],
  budget = 3000,
) {
  await peer.channel.send(new TextEncoder().encode(encodeFileDownloadFrame(request)));
  const deadline = performance.now() + budget;
  for (let i = 0; i < 64; i++) {
    let message: import('@remi/shared').ProtocolMessage;
    try {
      message = await peer.next(Math.max(1, deadline - performance.now()));
    } catch (error) {
      throw new Error(
        `Owned relay phase ${JSON.stringify({ operation: request.type, requestId: request.id, sessionId: request.sessionId, seq: 'seq' in request ? request.seq : null, received: received.map((m) => ({ type: m.type, requestId: 'requestId' in m ? m.requestId : null, code: m.type === 'error' ? m.code : null })).slice(-16), socketClosed: peer.socket.isClosed })}`,
        { cause: error },
      );
    }
    received.push(message);
    if ('requestId' in message && message.requestId === request.id) {
      const frame = decodeFileDownloadFrame(JSON.stringify(message));
      if (!frame) throw Error('Actual strict file result absent');
      return frame;
    }
    if (performance.now() >= deadline) break;
  }
  throw Error('Actual relay correlated response absent');
}
async function relayPull(
  peer: RelayCliPeer,
  value: FileFetchAccepted,
  progress?: (bytes: number) => void,
  received: import('@remi/shared').ProtocolMessage[] = [],
) {
  const hash = createHash('sha256');
  let bytes = 0;
  let seq = 0;
  while (bytes < value.byteLength) {
    const chunk = await relaySubmit(
      peer,
      {
        type: 'file_fetch_read',
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        sessionId: value.sessionId,
        transferId: value.transferId,
        seq,
        receivedBytes: bytes,
      },
      received,
    );
    expect(
      chunk.type,
      chunk.type === 'file_fetch_refused'
        ? `Actual relay refusal code=${chunk.code}, seq=${seq}`
        : `Actual relay response type=${chunk.type}, seq=${seq}`,
    ).toBe('file_fetch_chunk');
    if (chunk.type !== 'file_fetch_chunk') throw Error('Actual relay chunk absent');
    expect(chunk.seq).toBe(seq++);
    const raw = Buffer.from(chunk.data, 'base64url');
    expect(raw.length).toBe(Math.min(32768, value.byteLength - bytes));
    bytes += raw.length;
    hash.update(raw);
    progress?.(bytes);
  }
  expect(hash.digest('base64url')).toBe(value.digest);
  expect(
    await relaySubmit(
      peer,
      {
        type: 'file_fetch_complete',
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        sessionId: value.sessionId,
        transferId: value.transferId,
        receivedBytes: bytes,
        digest: value.digest,
      },
      received,
    ),
  ).toMatchObject({ type: 'file_fetch_result', outcome: 'complete' });
  return seq;
}
for (const harness of ['claude', 'codex'] as const)
  test(`shipping relay-only ${harness} scoped hello and encrypted1/32768/10MiB pulls`, async () => {
    const f = await relayFileDownloadCliFixture({
      harness,
      relay: harness === 'claude' ? 'flag' : 'config',
    });
    try {
      const direct = await f.peer();
      expect(direct.hello().capabilities).not.toContain('file_download');
      const peer = await f.connect();
      const hello = await relayHello(f, peer);
      expect(hello.harness).toBe(harness);
      expect(hello.capabilities).toContain('file_download');
      expect(hello.machine?.capabilities).toEqual(hello.capabilities);
      const wire: Buffer[] = [];
      peer.socket.ws.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') wire.push(Buffer.from(event.data as ArrayBuffer));
      });
      for (const size of [1, 32768, 10485760]) {
        const bytes = randomBytes(size);
        f.write('sample.bin', bytes);
        const request = {
          type: 'file_fetch_begin' as const,
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          sessionId: f.sessionId,
          binding: { harness, harnessSessionId: hello.harnessSessionId as string },
          relativePath: 'sample.bin',
        };
        const value = accepted(
          await relaySubmit(peer, request, [], size === 10485760 ? 10000 : 3000).catch((error) => {
            const ledgerPath = join(f.files.home, 'image-staging', 'ledger', 'reservations.json');
            const ledger = fs.existsSync(ledgerPath)
              ? JSON.parse(fs.readFileSync(ledgerPath, 'utf8')).records.map(
                  (row: { state: string; charge: number }) => ({
                    state: row.state,
                    charge: row.charge,
                  }),
                )
              : null;
            throw new Error(
              `Owned shipping relay begin: ${JSON.stringify({ size, hello, ledger, hub: f.logs, child: f.output.text })}`,
              { cause: error },
            );
          }),
        );
        expect(value.byteLength).toBe(size);
        expect(value.fileName).toBe('sample.bin');
        expect(value.digest).toBe(createHash('sha256').update(bytes).digest('base64url'));
        expect(await relayPull(peer, value)).toBe(Math.ceil(size / 32768));
        if (size >= 64) {
          expect(Buffer.concat(wire).includes(bytes.subarray(0, 64))).toBe(false);
          expect(
            Buffer.concat(wire).includes(Buffer.from(bytes.subarray(0, 64).toString('base64url'))),
          ).toBe(false);
          expect(f.output.text).not.toContain(bytes.subarray(0, 64).toString('base64url'));
        }
      }
      const receipt = await f.close();
      expect(receipt.consumerReaped).toBe(true);
      expect(receipt.daemonReaped).toBe(true);
      expect(receipt.stdinMeasured).toBe(true);
      expect(receipt.stdin).toEqual(Buffer.alloc(0));
    } finally {
      await f.close();
    }
  }, 120000);

test('relay-only Codex actual known identity refresh is scoped and never replays or reattaches', async () => {
  const f = await relayFileDownloadCliFixture({ harness: 'codex', known: false });
  try {
    const peer = await f.connect();
    const first = await relayHello(f, peer);
    expect(first.harnessSessionId).toBeNull();
    expect(first.capabilities).not.toContain('file_download');
    const before: import('@remi/shared').ProtocolMessage[] = [];
    await relayListBarrier(peer, before);
    const identity = await f.learnCodexIdentity();
    const observed: import('@remi/shared').ProtocolMessage[] = [];
    let next = await peer.next();
    observed.push(next);
    for (let i = 0; i < 32 && next.type !== 'hello_ack'; i++) {
      next = await peer.next();
      observed.push(next);
    }
    expect(next.type).toBe('hello_ack');
    if (next.type !== 'hello_ack') throw Error('Fresh actual Codex hello absent');
    expect(next.harnessSessionId).toBe(identity);
    expect(next.attachState).toBe('attached');
    expect(next.capabilities).toContain('file_download');
    expect(next.machine?.capabilities).toEqual(next.capabilities);
    expect(next.sessionId).toBe(first.sessionId);
    await relayListBarrier(peer, observed);
    expect(observed.filter((m) => m.type === 'hello_ack')).toHaveLength(1);
    expect(observed.filter((m) => m.type === 'replay_batch')).toHaveLength(0);
    expect(before.filter((m) => m.type === 'replay_batch').length).toBe(
      first.replayCount && first.replayCount > 0 ? 1 : 0,
    );
  } finally {
    await f.close();
  }
}, 30000);

test('explicit no-relay defeats configured relay-only file preparation', async () => {
  const f = await relayFileDownloadCliFixture({ relay: 'off' });
  try {
    const peer = await f.connect();
    const hello = await relayHello(f, peer);
    expect(hello.capabilities).not.toContain('file_download');
  } finally {
    await f.close();
  }
}, 30000);

test('actual relay held No stays within1000ms during active encrypted10MiB pull and raw reap stays empty', async () => {
  const f = await relayFileDownloadCliFixture();
  const abort = new AbortController();
  let transfer: Promise<number> | undefined;
  let held: Promise<unknown> | undefined;
  try {
    f.write('sample.bin', randomBytes(10485760));
    const peer = await f.connect();
    const hello = await relayHello(f, peer);
    const seen: import('@remi/shared').ProtocolMessage[] = [];
    const config = JSON.parse(
      fs.readFileSync(join(f.files.work, '.claude', 'settings.local.json'), 'utf8'),
    ) as { hooks?: Record<string, { hooks: { type: string; url: string }[] }[]> };
    const hook = config.hooks?.['PermissionRequest']
      ?.flatMap((row) => row.hooks)
      .find((row) => row.type === 'http')?.url;
    if (!hook) throw Error('Owned actual hook absent');
    held = fetch(hook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: abort.signal,
      body: JSON.stringify({
        hook_event_name: 'PermissionRequest',
        session_id: hello.harnessSessionId,
        cwd: fs.realpathSync(f.files.work),
        permission_mode: 'default',
        tool_name: 'Bash',
        tool_input: { command: 'echo owned-relay-held-no' },
        permission_suggestions: [],
      }),
    }).then((response) => response.json());
    void held.catch(() => {});
    let question: Extract<import('@remi/shared').ProtocolMessage, { type: 'question' }> | undefined;
    for (let i = 0; i < 32; i++) {
      const m = await peer.next();
      if (m.type === 'question') {
        question = m;
        break;
      }
    }
    if (!question) throw Error('Actual relay held question absent');
    const begin = {
      type: 'file_fetch_begin' as const,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      sessionId: f.sessionId,
      binding: { harness: 'claude' as const, harnessSessionId: hello.harnessSessionId as string },
      relativePath: 'sample.bin',
    };
    const value = accepted(await relaySubmit(peer, begin, seen, 10000));
    let receivedBytes = 0;
    let finished = false;
    transfer = relayPull(
      peer,
      value,
      (n) => {
        receivedBytes = n;
      },
      seen,
    ).then((seq) => {
      finished = true;
      return seq;
    });
    void transfer.catch(() => {});
    await until(() => receivedBytes > 0, 'actual relay pull made progress');
    expect(receivedBytes).toBeLessThan(value.byteLength);
    expect(finished).toBe(false);
    expect(ledgerMatches(f, (rows) => rows.some((row) => row.state === 'active'))).toBe(true);
    const began = performance.now();
    await peer.send(
      createAnswer(f.sessionId, question.question.id, 'No', hello.claudeSessionId ?? undefined),
    );
    const result = await held;
    const elapsed = performance.now() - began;
    expect(elapsed).toBeLessThanOrEqual(1000);
    expect(result).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } });
    expect(await transfer).toBe(320);
    const receipt = await f.close();
    expect(receipt.consumerReaped).toBe(true);
    expect(receipt.daemonReaped).toBe(true);
    expect(receipt.stdinMeasured).toBe(true);
    expect(receipt.stdin).toEqual(Buffer.alloc(0));
    console.info(
      'Owned relay held-No receipt',
      JSON.stringify({
        elapsedMilliseconds: elapsed,
        downloadBytes: 10485760,
        incompleteTransferAtAnswer: true,
      }),
    );
  } catch (error) {
    try {
      const ledgerPath = join(f.files.home, 'image-staging', 'ledger', 'reservations.json');
      const ledger = fs.existsSync(ledgerPath)
        ? (JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) as {
            version: number;
            records: { state: string; charge: number }[];
          })
        : null;
      if (ledger && (ledger.version !== 1 || !Array.isArray(ledger.records)))
        throw Error('Owned failure ledger observation invalid');
      const pidPath = join(f.files.directory, 'consumer-pid');
      const rawPid = fs.existsSync(pidPath) ? fs.readFileSync(pidPath, 'utf8') : '';
      const consumerPid = /^[1-9][0-9]*\s*$/u.test(rawPid) ? Number(rawPid) : null;
      let consumerAlive = false;
      if (consumerPid)
        try {
          process.kill(consumerPid, 0);
          consumerAlive = true;
        } catch {}
      console.error(
        'Owned relay held failure metadata',
        JSON.stringify({
          hub: f.logs.slice(-16),
          authorityFaults: f.authorityFaults,
          childPid: f.proc.pid,
          childExit: f.proc.exitCode,
          childSignal: f.proc.signalCode,
          consumerPid,
          consumerAlive,
          consumerReady: fs.existsSync(join(f.files.directory, 'consumer-ready')),
          ledger: ledger?.records.map((row) => ({ state: row.state, charge: row.charge })),
          childErrorCodes: f.output.text
            .split('\n')
            .filter((line) => /error|failed|refused|unavailable/iu.test(line))
            .slice(-8)
            .map((line) => line.match(/(?:[A-Za-z]*Error|[A-Z][A-Z0-9_]{3,})/gu) ?? []),
        }),
      );
    } catch (observationError) {
      console.error(
        'Owned relay failure metadata unavailable',
        observationError instanceof Error ? observationError.name : 'non-Error',
      );
    }
    throw error;
  } finally {
    abort.abort();
    try {
      await f.close();
    } finally {
      await transfer?.catch(() => {});
      await held?.catch(() => {});
    }
  }
}, 120000);

test('shipping relay one-byte BEGIN original authority caller control', async () => {
  const f = await relayFileDownloadCliFixture({ harness: 'claude' });
  try {
    const peer = await f.connect();
    const hello = await relayHello(f, peer);
    const childFrames = f.observeChildFrames();
    f.write('sample.bin', Buffer.from('q'));
    const begin = {
      type: 'file_fetch_begin' as const,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      sessionId: f.sessionId,
      binding: { harness: 'claude' as const, harnessSessionId: hello.harnessSessionId as string },
      relativePath: 'sample.bin',
    };
    const value = accepted(
      await relaySubmit(peer, begin).catch((error) => {
        throw new Error(
          `Owned exact authority caller ${JSON.stringify({
            operation: begin.type,
            sessionId: f.sessionId,
            authorityFaults: f.authorityFaults,
            childFrames,
            hub: f.logs,
            childAlive: f.proc.exitCode === null,
          })}`,
          { cause: error },
        );
      }),
    );
    expect(value.byteLength).toBe(1);
    expect(
      await relaySubmit(peer, {
        type: 'file_fetch_cancel',
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        sessionId: f.sessionId,
        beginId: begin.id,
      }),
    ).toMatchObject({ outcome: 'cancelled' });
  } finally {
    await f.close();
  }
}, 30000);
