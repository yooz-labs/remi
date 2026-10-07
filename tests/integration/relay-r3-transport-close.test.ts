/**
 * The root cause of #1225, pinned on the runtime itself.
 *
 * The hub is a WebSocket client of the Worker: it sends its last frames on a pipe (the
 * authenticated BYE, or nothing before a failure close) and then calls `close()`. Under CPU load
 * the R3 tests saw the client get the Worker's own failure close (4400, "closed") instead of the
 * hub's close: the Worker recorded the pipe as `close 1006 "WebSocket disconnected without sending
 * Close frame."`, workerd logged `::write(...): Broken pipe`, and the hub's own `onclose` reported
 * a clean close a fraction of a millisecond after `close()`. The Worker turns any close code a
 * socket may not send (1006 here) into its failure close (`passedOn` in
 * `packages/signaling/src/connection-room.ts`), by design.
 *
 * The cause is the runtime's client close. Bun 1.3.11 (the CI and release pin) usually resets the
 * TCP connection right after sending its Close frame, so the peer gets ECONNRESET and can never
 * answer the Close: a Worker that is slow to get to the socket (a loaded machine) then writes its
 * reply into a reset connection and records the close as abnormal, and it can lose what it had not
 * read yet, the hub's BYE included (7 of 102 loaded runs, #1271 review). Bun 1.4.2 ends the
 * connection with a FIN and keeps it open for the peer's answer, so a late answer still completes
 * the closing handshake. The hub therefore leaves an orderly close to the far side for a bounded
 * time after its BYE (`ORDERLY_CLOSE_GRACE_MS` in `hub-relay.ts`).
 *
 * The test is the slow peer: it answers each Close 300 ms late and records how the connection
 * ended. It asserts what each runtime does, so the day the pin moves this test says whether the
 * new runtime closes gracefully, and the one allowance for the reset in `relay-r3.test.ts`
 * (`expectHubClose`) can then go.
 *
 * Measured on macOS only. CI runs Linux, where nobody has observed how either runtime ends the
 * connection, so the test is skipped there rather than asserting an unseen behavior: it guards
 * only on a Mac, where the owner and the agents run the suite, not in CI.
 */
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

/** How late the peer answers the client's Close: far longer than the client takes to close. */
const ANSWER_DELAY_MS = 300;
/**
 * On Bun 1.3.11 most connections end without the late answer: measured 4 of 5 reset (twice, across
 * processes), 8 of 8 in this test unloaded, and under load a few that ended with a FIN but no
 * answer written (2 of 16 runs saw one), which `graceful` also counts as lost. With eight, the
 * chance that none is lost is negligible.
 */
const CONNECTIONS = 8;
/** The Bun release whose client close is known to reset the connection (#1225). */
const RESETTING_RUNTIME = '1.3.11';

interface PeerState {
  buffer: Buffer;
  upgraded: boolean;
  closeFrame: boolean;
  events: string[];
  done: (events: string[]) => void;
}

/**
 * The closing handshake completed: the client's FIN, the peer's late answer written, and a close
 * with no error. A reset shows as `close ECONNRESET`; any other ending (an answer that could not
 * be written) is not graceful either.
 */
function graceful(events: readonly string[]): boolean {
  return (
    events.includes('fin') &&
    events.includes('answered') &&
    !events.some((e) => e !== 'close' && e.startsWith('close'))
  );
}

test.skipIf(process.platform !== 'darwin')(
  `a WebSocket client's close and a peer that answers late (Bun ${Bun.version}, #1225)`,
  async () => {
    const endings: Promise<string[]>[] = [];
    const listener = Bun.listen<PeerState>({
      hostname: '127.0.0.1',
      port: 0,
      allowHalfOpen: true,
      socket: {
        open(socket) {
          let done: PeerState['done'] = () => {};
          endings.push(
            new Promise((resolve) => {
              done = resolve;
            }),
          );
          socket.data = {
            buffer: Buffer.alloc(0),
            upgraded: false,
            closeFrame: false,
            events: [],
            done,
          };
        },
        data(socket, chunk) {
          const peer = socket.data;
          peer.buffer = Buffer.concat([peer.buffer, Buffer.from(chunk)]);
          if (!peer.upgraded) {
            const text = peer.buffer.toString('latin1');
            const end = text.indexOf('\r\n\r\n');
            if (end < 0) return;
            const key = /sec-websocket-key: *(\S+)/i.exec(text)?.[1] ?? '';
            const accept = createHash('sha1')
              .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
              .digest('base64');
            socket.write(
              `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
            );
            peer.upgraded = true;
            peer.buffer = peer.buffer.subarray(end + 4);
          }
          // Client frames are masked; small frames only (the payload length fits in 7 bits).
          let offset = 0;
          while (peer.buffer.length - offset >= 6) {
            const opcode = (peer.buffer[offset] as number) & 0x0f;
            const length = (peer.buffer[offset + 1] as number) & 0x7f;
            const total = 2 + 4 + length;
            if (length > 125 || peer.buffer.length - offset < total) break;
            if (opcode === 0x8 && !peer.closeFrame) {
              peer.closeFrame = true;
              setTimeout(() => {
                if (socket.write(Buffer.from([0x88, 0x02, 0x03, 0xe8])) > 0)
                  peer.events.push('answered');
                socket.end();
              }, ANSWER_DELAY_MS);
            }
            offset += total;
          }
          peer.buffer = peer.buffer.subarray(offset);
        },
        end(socket) {
          socket.data.events.push('fin');
        },
        close(socket, error) {
          const code = (error as NodeJS.ErrnoException | undefined)?.code;
          socket.data.events.push(code ? `close ${code}` : 'close');
          socket.data.done(socket.data.events);
        },
      },
    });
    const seen: string[] = [];
    try {
      for (let i = 0; i < CONNECTIONS; i++) {
        const ws = new WebSocket(`ws://127.0.0.1:${listener.port}/`);
        await new Promise<void>((opened, refused) => {
          ws.onopen = () => opened();
          ws.onerror = () => refused(new Error('upgrade refused'));
        });
        // As the hub ends a pipe: its last frame (the BYE), then the close one microtask later.
        ws.send(new Uint8Array(25));
        await Promise.resolve();
        ws.close(1000);
        const ending = endings[i];
        if (!ending) throw new Error('connection not accepted');
        let timer: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          ending,
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), ANSWER_DELAY_MS + 10_000);
          }),
        ]);
        clearTimeout(timer);
        if (!result) throw new Error('the connection never ended');
        seen.push(`${graceful(result) ? 'graceful' : 'lost'}: ${result.join(',')}`);
      }
    } finally {
      listener.stop(true);
    }
    const lost = seen.filter((ending) => ending.startsWith('lost'));
    if (Bun.version === RESETTING_RUNTIME) {
      // The defect: at least one connection ends before the peer can answer the Close.
      expect(lost.length, seen.join(' | ')).toBeGreaterThan(0);
    } else {
      // A runtime that closes gracefully: every Close is answered, then the connection ends.
      expect(lost, seen.join(' | ')).toEqual([]);
    }
  },
  60_000,
);
