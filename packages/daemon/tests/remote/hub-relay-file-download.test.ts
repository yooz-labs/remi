/** Actual encrypted Worker/Hub/strict child download route; no business response substitute. */
import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { createHello, createSessionListRequest, encodeFileDownloadFrame } from '@remi/shared';
import { relayFileDownloadFixture } from '../helpers/file-download-ingress-fixture.ts';

test('enrolled relay file request pulls one actual validated file and confirms cleanup', async () => {
  const f = await relayFileDownloadFixture();
  try {
    const bytes = Buffer.from('owned relay file content');
    f.write(bytes);
    const peer = await f.connect();
    await peer.send(createHello('owned', 'T4', { resumeSessionId: f.sessionId }));
    const hello = await peer.next();
    expect(hello.type).toBe('hello_ack');
    const begin = {
      type: 'file_fetch_begin' as const,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      sessionId: f.sessionId,
      binding: f.binding,
      relativePath: 'sample.bin',
    };
    await peer.channel.send(new TextEncoder().encode(encodeFileDownloadFrame(begin)));
    const accepted = await peer.next();
    expect(accepted.type).toBe('file_fetch_accepted');
    if (accepted.type !== 'file_fetch_accepted') throw Error('Actual relay acceptance absent');
    expect(hello.type === 'hello_ack' && hello.capabilities).toContain('file_download');
    expect(accepted.requestId).toBe(begin.id);
    expect(accepted.fileName).toBe('sample.bin');
    expect(accepted.byteLength).toBe(bytes.length);
    const read = {
      type: 'file_fetch_read' as const,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      sessionId: f.sessionId,
      transferId: accepted.transferId,
      seq: 0,
      receivedBytes: 0,
    };
    await peer.channel.send(new TextEncoder().encode(encodeFileDownloadFrame(read)));
    const chunk = await peer.next();
    expect(chunk.type).toBe('file_fetch_chunk');
    if (chunk.type !== 'file_fetch_chunk') throw Error('Actual relay chunk absent');
    expect(Buffer.from(chunk.data, 'base64url')).toEqual(bytes);
    const complete = {
      type: 'file_fetch_complete' as const,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      sessionId: f.sessionId,
      transferId: accepted.transferId,
      receivedBytes: bytes.length,
      digest: createHash('sha256').update(bytes).digest('base64url'),
    };
    await peer.channel.send(new TextEncoder().encode(encodeFileDownloadFrame(complete)));
    const result = await peer.next();
    expect(result.type === 'file_fetch_result' && result.outcome).toBe('complete');
    expect(
      f
        .ledger()
        .inspect()
        .every((row) => row.state === 'settled' && row.charge === 0),
    ).toBe(true);
    expect(f.logs.join('\n')).not.toContain(bytes.toString());
  } finally {
    await f.close();
  }
}, 30000);

test('relay file child discovery uses actual source list builder and omits endpoints', async () => {
  const f = await relayFileDownloadFixture();
  try {
    const peer = await f.connect();
    await peer.send(createSessionListRequest());
    const list = await peer.next();
    expect(list.type).toBe('session_list_response');
    if (list.type !== 'session_list_response') throw Error('Actual aggregate list absent');
    expect(list.sessions.some((session) => session.sessionId === f.sessionId)).toBe(true);
    expect(list.daemonPorts).toBeUndefined();
    expect(JSON.stringify(list)).not.toContain('file_download');
  } finally {
    await f.close();
  }
}, 15000);

test('original correlatable malformed relay read reaches real service without repair or generic ACK', async () => {
  const f = await relayFileDownloadFixture();
  try {
    f.write('owned malformed read');
    const peer = await f.connect();
    await peer.send(createHello('owned', 'T4', { resumeSessionId: f.sessionId }));
    await peer.next();
    const envelope = () => ({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      sessionId: f.sessionId,
    });
    const begin = {
      ...envelope(),
      type: 'file_fetch_begin' as const,
      binding: f.binding,
      relativePath: 'sample.bin',
    };
    await peer.channel.send(new TextEncoder().encode(encodeFileDownloadFrame(begin)));
    const value = await peer.next();
    if (value.type !== 'file_fetch_accepted') throw Error('Actual known owner absent');
    const request = {
      ...envelope(),
      type: 'file_fetch_read',
      transferId: value.transferId,
      seq: 0.5,
      receivedBytes: 0,
      unknown: 'must remain malformed',
    };
    await peer.channel.send(new TextEncoder().encode(JSON.stringify(request)));
    const response = await peer.next();
    expect(response.type).toBe('file_fetch_refused');
    expect(response.type === 'file_fetch_refused' && response.code).toBe('malformed');
    expect(response.type === 'file_fetch_refused' && response.requestId).toBe(request.id);
    expect(f.invocations.slice(-1)[0]?.kind).toBe('malformed');
    expect(
      f
        .ledger()
        .inspect()
        .some((row) => row.state === 'active'),
    ).toBe(true);
    const valid = {
      ...envelope(),
      type: 'file_fetch_read' as const,
      transferId: value.transferId,
      seq: 0,
      receivedBytes: 0,
    };
    await peer.channel.send(new TextEncoder().encode(encodeFileDownloadFrame(valid)));
    expect((await peer.next()).type).toBe('file_fetch_chunk');
    const cancel = { ...envelope(), type: 'file_fetch_cancel' as const, beginId: begin.id };
    await peer.channel.send(new TextEncoder().encode(encodeFileDownloadFrame(cancel)));
    expect((await peer.next()).type).toBe('file_fetch_cancel_result');
    expect(
      f
        .ledger()
        .inspect()
        .every((row) => row.state === 'settled' && row.charge === 0),
    ).toBe(true);
  } finally {
    await f.close();
  }
}, 15000);

test('relay cancel before acceptance names original beginId and suppresses all private content', async () => {
  const f = await relayFileDownloadFixture();
  try {
    f.write(Buffer.alloc(10485760));
    const peer = await f.connect();
    await peer.send(createHello('owned', 'T4', { resumeSessionId: f.sessionId }));
    await peer.next();
    const begin = {
      type: 'file_fetch_begin' as const,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      sessionId: f.sessionId,
      binding: f.binding,
      relativePath: 'sample.bin',
    };
    const cancel = {
      type: 'file_fetch_cancel' as const,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      sessionId: f.sessionId,
      beginId: begin.id,
    };
    await peer.channel.send(new TextEncoder().encode(encodeFileDownloadFrame(begin)));
    await peer.channel.send(new TextEncoder().encode(encodeFileDownloadFrame(cancel)));
    const received = [];
    let done = false;
    for (let i = 0; i < 8 && !done; i++) {
      const m = await peer.next();
      received.push(m);
      done = m.type === 'file_fetch_cancel_result';
    }
    expect(
      received.some(
        (m) =>
          m.type === 'file_fetch_cancel_result' &&
          m.beginId === begin.id &&
          m.outcome === 'cancelled',
      ),
    ).toBe(true);
    expect(
      received.some((m) => m.type === 'file_fetch_accepted' || m.type === 'file_fetch_chunk'),
    ).toBe(false);
    expect(
      f
        .ledger()
        .inspect()
        .every((row) => row.state === 'settled' && row.charge === 0),
    ).toBe(true);
  } finally {
    await f.close();
  }
}, 30000);
