/** The actual bounded reader over real Request/ReadableStream I/O, before any JSON parser. */
import { expect, test } from 'bun:test';
import { readPushBody } from '../src/push-gateway.ts';

test('actual push body reader accepts8192 bytes from a stream without trusting Content-Length', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(8192).fill(32));
      controller.close();
    },
  });
  expect(
    (await readPushBody(new Request('https://owned.example', { method: 'POST', body: stream })))
      .length,
  ).toBe(8192);
});
test('actual push body reader cancels an8193 byte stream before JSON or further reads', async () => {
  let canceled = false;
  let eof: ReturnType<typeof setTimeout> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(8193).fill(32));
      // Finite owned stream EOF: removing the ceiling resolves, not a test timeout.
      eof = setTimeout(() => controller.close(), 20);
    },
    cancel() {
      canceled = true;
      clearTimeout(eof);
    },
  });
  await expect(
    readPushBody(new Request('https://owned.example', { method: 'POST', body: stream })),
  ).rejects.toThrow('OVERSIZE');
  expect(canceled).toBe(true);
});
test('actual push body reader refuses malformed UTF8 before JSON', async () => {
  await expect(
    readPushBody(
      new Request('https://owned.example', { method: 'POST', body: Uint8Array.of(255) }),
    ),
  ).rejects.toThrow('MALFORMED');
});
