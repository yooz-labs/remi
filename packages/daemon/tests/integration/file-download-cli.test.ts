/** Shipping entry -> owned actual harness process -> signed WSS -> real D2 service. */
import { expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import {
  type FileFetchAccepted,
  createAnswer,
  createDetachSession,
  createResumeSessionRequest,
  createUserInput,
  encodeFileDownloadFrame,
  serialize,
} from '@remi/shared';
import type { FileDownloadRequest } from '../../src/tunnel/file-download-service';
import { Reservations } from '../../src/tunnel/reservations';
import { until } from '../helpers/browser-link-service-fixture';
import { fileDownloadCliFixture } from '../helpers/file-download-cli-fixture';

type Fixture = Awaited<ReturnType<typeof fileDownloadCliFixture>>;
type Peer = Awaited<ReturnType<Fixture['peer']>>;
// Observation only: never contend with admission by acquiring the daemon's ledger lock.
function ledgerMatches(
  f: Fixture,
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
