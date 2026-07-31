import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MESSAGE_DIRECTION,
  createAck,
  createAgentOutput,
  createError,
  createHelloAck,
  createPing,
  createQuestion,
  createQuestionResolved,
  createQuestionSnapshot,
  createRawPtyOutput,
  createRemiStatus,
  createReplayBatch,
  deserialize,
  generateId,
  now,
  serialize,
} from '@remi/shared';
import type {
  Message,
  MessageHandlers,
  ProtocolMessageMap,
  Question,
  RemiStatus,
  UUID,
} from '@remi/shared';
import { runAttachClient } from '../../src/cli/attach-client.ts';

const TEST_PORT = 9873;

function makeMessage(content: string): Message {
  return {
    id: generateId(),
    sessionId: generateId() as UUID,
    sender: 'agent',
    content,
    createdAt: now(),
    state: 'delivered',
    stateChangedAt: now(),
    isEditing: false,
  };
}

describe('runAttachClient', () => {
  let server: ReturnType<typeof Bun.serve> | null = null;
  let outputPath: string;
  let outputFd: number;
  let outputClosed: boolean;

  function setupOutput(): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-attach-test-'));
    outputPath = path.join(dir, 'output.txt');
    fs.writeFileSync(outputPath, '');
    outputFd = fs.openSync(outputPath, 'w');
    outputClosed = false;
  }

  function readOutput(): string {
    if (!outputClosed) {
      fs.closeSync(outputFd);
      outputClosed = true;
    }
    return fs.readFileSync(outputPath, 'utf-8');
  }

  afterEach(() => {
    if (server) {
      server.stop(true);
      server = null;
    }
    if (!outputClosed) {
      try {
        fs.closeSync(outputFd);
        outputClosed = true;
      } catch {
        // fd may be invalid if setupOutput was never called
      }
    }
  });

  test('sends hello with resumeSessionId', async () => {
    setupOutput();
    const targetSessionId = generateId();
    const receivedMessages: string[] = [];

    server = Bun.serve({
      port: TEST_PORT,
      fetch(req, srv) {
        if (srv.upgrade(req, { data: {} })) return;
        return new Response('Not found', { status: 404 });
      },
      websocket: {
        open() {},
        message(ws, data) {
          const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
          receivedMessages.push(text);
          const msg = deserialize(text);
          if (!msg) return;

          if (msg.type === 'hello') {
            // Verify resumeSessionId is set
            const hello = msg;
            expect(hello.resumeSessionId).toBe(targetSessionId);

            // Send hello_ack then close after a short delay
            ws.send(serialize(createHelloAck('1.0.0', targetSessionId as UUID)));
            setTimeout(() => ws.close(), 100);
          }
        },
        close() {},
      },
    });

    const result = await runAttachClient({
      host: 'localhost',
      port: TEST_PORT,
      sessionId: targetSessionId,
      timeout: 3000,
      outputFd,
    });

    const output = readOutput();
    expect(output).toContain('[attached to session');
    expect(result.reason).toBe('connection_closed');
  });

  test('suppresses agent_output in replay batch (raw PTY provides full view)', async () => {
    setupOutput();
    const targetSessionId = generateId();

    server = Bun.serve({
      port: TEST_PORT + 1,
      fetch(req, srv) {
        if (srv.upgrade(req, { data: {} })) return;
        return new Response('Not found', { status: 404 });
      },
      websocket: {
        open() {},
        message(ws, data) {
          const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
          const msg = deserialize(text);
          if (!msg) return;

          if (msg.type === 'hello') {
            ws.send(serialize(createHelloAck('1.0.0', targetSessionId as UUID)));

            // Send a replay batch with agent output
            const replayMsg = createAgentOutput(makeMessage('Hello from replay'));
            ws.send(serialize(createReplayBatch(targetSessionId as UUID, [replayMsg], true)));

            // Close after sending
            setTimeout(() => ws.close(), 200);
          }
        },
        close() {},
      },
    });

    await runAttachClient({
      host: 'localhost',
      port: TEST_PORT + 1,
      sessionId: targetSessionId,
      timeout: 3000,
      outputFd,
    });

    const output = readOutput();
    // agent_output is suppressed in terminal attach mode; raw PTY provides the view
    expect(output).not.toContain('Hello from replay');
  });

  test('returns error when server is not running', async () => {
    setupOutput();
    const unusedPort = 9875;
    const result = await runAttachClient({
      host: 'localhost',
      port: unusedPort,
      sessionId: generateId(),
      timeout: 1000,
      outputFd,
    });
    expect(result.exitCode).toBe(1);
    expect(result.reason).toBe('error');
  });

  test('handles SESSION_ENDED with clean exit', async () => {
    setupOutput();
    const targetSessionId = generateId();

    server = Bun.serve({
      port: TEST_PORT + 2,
      fetch(req, srv) {
        if (srv.upgrade(req, { data: {} })) return;
        return new Response('Not found', { status: 404 });
      },
      websocket: {
        open() {},
        message(ws, data) {
          const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
          const msg = deserialize(text);
          if (!msg) return;

          if (msg.type === 'hello') {
            ws.send(serialize(createHelloAck('1.0.0', targetSessionId as UUID)));
            setTimeout(() => {
              ws.send(serialize(createError('SESSION_ENDED', 'Session ended')));
            }, 50);
          }
        },
        close() {},
      },
    });

    const result = await runAttachClient({
      host: 'localhost',
      port: TEST_PORT + 2,
      sessionId: targetSessionId,
      timeout: 3000,
      outputFd,
    });

    const output = readOutput();
    expect(output).toContain('[session ended]');
    expect(result.exitCode).toBe(0);
    expect(result.reason).toBe('session_ended');
  });

  test('responds to ping with pong', async () => {
    setupOutput();
    const targetSessionId = generateId();
    const receivedMessages: string[] = [];

    server = Bun.serve({
      port: TEST_PORT + 3,
      fetch(req, srv) {
        if (srv.upgrade(req, { data: {} })) return;
        return new Response('Not found', { status: 404 });
      },
      websocket: {
        open() {},
        message(ws, data) {
          const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
          receivedMessages.push(text);
          const msg = deserialize(text);
          if (!msg) return;

          if (msg.type === 'hello') {
            ws.send(serialize(createHelloAck('1.0.0', targetSessionId as UUID)));
            // Send a ping after hello_ack
            setTimeout(() => {
              ws.send(serialize(createPing()));
            }, 50);
            // Close after giving time for pong
            setTimeout(() => ws.close(), 200);
          }
        },
        close() {},
      },
    });

    await runAttachClient({
      host: 'localhost',
      port: TEST_PORT + 3,
      sessionId: targetSessionId,
      timeout: 3000,
      outputFd,
    });

    // Find the pong response in received messages
    const pongMsg = receivedMessages.find((text) => {
      const msg = deserialize(text);
      return msg?.type === 'pong';
    });
    expect(pongMsg).toBeTruthy();
  });

  function mkRemiStatus(targetSessionId: UUID, overrides: Partial<RemiStatus> = {}): RemiStatus {
    return {
      pid: 1,
      connections: 1,
      sessionStatus: 'idle',
      adapters: ['ws'],
      wsPort: 19924,
      sessionId: targetSessionId,
      repo: 'remi',
      branch: 'develop',
      autoApprove: { inFlight: 0, sinceS: 0, lastVerdict: 'none', lastVerdictAtS: 0 },
      attached: true,
      queuedCount: 0,
      ...overrides,
    };
  }

  function makeQuestion(text: string, held = true): Question {
    return {
      id: generateId() as UUID,
      text,
      options: [
        { label: 'Yes', value: 'yes', isRecommended: true, isYes: true, isNo: false },
        { label: 'No', value: 'no', isRecommended: false, isYes: false, isNo: true },
      ],
      allowsFreeText: false,
      isAnswered: false,
      ...(held ? { held: true } : {}),
    };
  }

  // #753: a HELD permission (Model B) blocks Claude inside the hook, so no
  // raw PTY bytes for the prompt ever exist — the LIVE question message is
  // the only signal an attached terminal gets, and it must render.
  test('renders a banner for a LIVE held question (held prompts never paint the PTY)', async () => {
    setupOutput();
    const targetSessionId = generateId();
    const question = makeQuestion('Allow file edit?');

    server = Bun.serve({
      port: TEST_PORT + 4,
      fetch(req, srv) {
        if (srv.upgrade(req, { data: {} })) return;
        return new Response('Not found', { status: 404 });
      },
      websocket: {
        open() {},
        message(ws, data) {
          const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
          const msg = deserialize(text);
          if (!msg) return;

          if (msg.type === 'hello') {
            ws.send(serialize(createHelloAck('1.0.0', targetSessionId as UUID)));
            setTimeout(() => {
              // Duplicate delivery (daemon re-send + broadcast): renders once.
              ws.send(serialize(createQuestion(question, targetSessionId as UUID)));
              ws.send(serialize(createQuestion(question, targetSessionId as UUID)));
            }, 50);
            setTimeout(() => ws.close(), 200);
          }
        },
        close() {},
      },
    });

    await runAttachClient({
      host: 'localhost',
      port: TEST_PORT + 4,
      sessionId: targetSessionId,
      timeout: 3000,
      outputFd,
    });

    const output = readOutput();
    expect(output).toContain('[remi] pending question: Allow file edit?');
    expect(output).toContain('1) Yes  2) No');
    expect(output).toContain("run 'remi unstick'");
    // Bannered exactly once despite the duplicate delivery.
    expect(output.split('pending question: Allow file edit?').length).toBe(2);
  });

  // #760 review finding 1: the daemon emits multiple `question` messages per
  // VISIBLE prompt cycle (hook bridge + PTY parser, different ids); only held
  // questions — which never render natively — may banner.
  test('does NOT banner a non-held live question (its prompt renders natively in raw PTY)', async () => {
    setupOutput();
    const targetSessionId = generateId();
    const question = makeQuestion('Allow Bash: ls?', /* held */ false);

    server = Bun.serve({
      port: TEST_PORT + 8,
      fetch(req, srv) {
        if (srv.upgrade(req, { data: {} })) return;
        return new Response('Not found', { status: 404 });
      },
      websocket: {
        open() {},
        message(ws, data) {
          const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
          const msg = deserialize(text);
          if (!msg) return;

          if (msg.type === 'hello') {
            ws.send(serialize(createHelloAck('1.0.0', targetSessionId as UUID)));
            setTimeout(() => {
              ws.send(serialize(createQuestion(question, targetSessionId as UUID)));
            }, 50);
            setTimeout(() => ws.close(), 200);
          }
        },
        close() {},
      },
    });

    await runAttachClient({
      host: 'localhost',
      port: TEST_PORT + 8,
      sessionId: targetSessionId,
      timeout: 3000,
      outputFd,
    });

    const output = readOutput();
    expect(output).not.toContain('Allow Bash: ls?');
    expect(output).not.toContain('pending question');
  });

  test('suppresses questions inside a replay batch (history cannot prove pendingness)', async () => {
    setupOutput();
    const targetSessionId = generateId();
    const question = makeQuestion('Old replayed question?');

    server = Bun.serve({
      port: TEST_PORT + 5,
      fetch(req, srv) {
        if (srv.upgrade(req, { data: {} })) return;
        return new Response('Not found', { status: 404 });
      },
      websocket: {
        open() {},
        message(ws, data) {
          const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
          const msg = deserialize(text);
          if (!msg) return;

          if (msg.type === 'hello') {
            ws.send(serialize(createHelloAck('1.0.0', targetSessionId as UUID)));
            ws.send(
              serialize(
                createReplayBatch(
                  targetSessionId as UUID,
                  [createQuestion(question, targetSessionId as UUID)],
                  true,
                ),
              ),
            );
            setTimeout(() => ws.close(), 200);
          }
        },
        close() {},
      },
    });

    await runAttachClient({
      host: 'localhost',
      port: TEST_PORT + 5,
      sessionId: targetSessionId,
      timeout: 3000,
      outputFd,
    });

    const output = readOutput();
    // A replayed question may have been answered long ago (question_resolved
    // is never recorded into history), so no banner.
    expect(output).not.toContain('Old replayed question?');
  });

  test('acknowledges question_resolved only for questions it bannered', async () => {
    setupOutput();
    const targetSessionId = generateId();
    const question = makeQuestion('Allow push?');
    const unrelatedQuestionId = generateId() as UUID;

    server = Bun.serve({
      port: TEST_PORT + 6,
      fetch(req, srv) {
        if (srv.upgrade(req, { data: {} })) return;
        return new Response('Not found', { status: 404 });
      },
      websocket: {
        open() {},
        message(ws, data) {
          const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
          const msg = deserialize(text);
          if (!msg) return;

          if (msg.type === 'hello') {
            ws.send(serialize(createHelloAck('1.0.0', targetSessionId as UUID)));
            setTimeout(() => {
              // A resolved broadcast for a question never bannered: silent.
              ws.send(
                serialize(
                  createQuestionResolved(targetSessionId as UUID, unrelatedQuestionId, 'answered'),
                ),
              );
              ws.send(serialize(createQuestion(question, targetSessionId as UUID)));
              ws.send(
                serialize(createQuestionResolved(targetSessionId as UUID, question.id, 'answered')),
              );
            }, 50);
            setTimeout(() => ws.close(), 250);
          }
        },
        close() {},
      },
    });

    await runAttachClient({
      host: 'localhost',
      port: TEST_PORT + 6,
      sessionId: targetSessionId,
      timeout: 3000,
      outputFd,
    });

    const output = readOutput();
    expect(output).toContain('[remi] pending question: Allow push?');
    expect(output.split('[remi] question answered').length).toBe(2); // exactly once
  });

  // #754: remi_status is display state for the reserved-row bar; on a non-TTY
  // output (piped/tests) the bar never starts and nothing is printed.
  test('consumes remi_status without printing when stdout is not a TTY', async () => {
    setupOutput();
    const targetSessionId = generateId();

    server = Bun.serve({
      port: TEST_PORT + 7,
      fetch(req, srv) {
        if (srv.upgrade(req, { data: {} })) return;
        return new Response('Not found', { status: 404 });
      },
      websocket: {
        open() {},
        message(ws, data) {
          const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
          const msg = deserialize(text);
          if (!msg) return;

          if (msg.type === 'hello') {
            ws.send(serialize(createHelloAck('1.0.0', targetSessionId as UUID)));
            setTimeout(() => {
              ws.send(
                serialize(
                  createRemiStatus(targetSessionId as UUID, {
                    pid: 1,
                    connections: 1,
                    sessionStatus: 'thinking',
                    adapters: ['ws'],
                    wsPort: 19924,
                    sessionId: targetSessionId as UUID,
                    repo: 'remi',
                    branch: 'develop',
                    autoApprove: {
                      inFlight: 0,
                      sinceS: 0,
                      lastVerdict: 'none',
                      lastVerdictAtS: 0,
                    },
                    attached: true,
                    queuedCount: 0,
                  }),
                ),
              );
            }, 50);
            setTimeout(() => ws.close(), 200);
          }
        },
        close() {},
      },
    });

    await runAttachClient({
      host: 'localhost',
      port: TEST_PORT + 7,
      sessionId: targetSessionId,
      timeout: 3000,
      outputFd,
    });

    const output = readOutput();
    // No bar escapes (reverse video / DECSTBM) and no bar label leaked. (The
    // "[attached to session ...]" header is unrelated and expected.)
    expect(output).not.toContain('| attached');
    expect(output).not.toContain('\x1b[7m');
    expect(output).not.toContain('\x1b[1;');
  });

  // #932: statusBarEligible lets a test force the bar on without a real TTY,
  // proving the positive case the "not a TTY" test above only proves the
  // negative of.
  test('paints the reserved-row bar when statusBarEligible is forced true', async () => {
    setupOutput();
    const targetSessionId = generateId();

    server = Bun.serve({
      port: TEST_PORT + 12,
      fetch(req, srv) {
        if (srv.upgrade(req, { data: {} })) return;
        return new Response('Not found', { status: 404 });
      },
      websocket: {
        open() {},
        message(ws, data) {
          const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
          const msg = deserialize(text);
          if (!msg) return;

          if (msg.type === 'hello') {
            ws.send(serialize(createHelloAck('1.0.0', targetSessionId as UUID)));
            setTimeout(() => {
              ws.send(
                serialize(
                  createRemiStatus(targetSessionId as UUID, mkRemiStatus(targetSessionId as UUID)),
                ),
              );
              // #932: the daemon always sends question_snapshot (even empty)
              // right after hello_ack via resendPendingQuestions; the bar's
              // first paint is gated on having observed one.
              ws.send(serialize(createQuestionSnapshot(targetSessionId as UUID, [])));
            }, 50);
            setTimeout(() => ws.close(), 200);
          }
        },
        close() {},
      },
    });

    await runAttachClient({
      host: 'localhost',
      port: TEST_PORT + 12,
      sessionId: targetSessionId,
      timeout: 3000,
      outputFd,
      statusBarEligible: true,
    });

    const output = readOutput();
    expect(output).toContain('\x1b[7m'); // reverse-video bar paint
    expect(output).toContain('\x1b[1;'); // DECSTBM scroll-region assertion
  });

  // #932: attach-client's own StatusBar (the same class the wrapper draws,
  // #754) had NO hasLiveQuestions wiring at all before this fix -- the
  // ~250ms timer painted straight through a live question on this path.
  // question_snapshot (sent on attach and on every change, #753/#798) is the
  // signal that now drives it, and the bar's first-ever paint is deferred
  // until one has been observed (a second review fix) so it cannot read
  // "no question" for a session that already has one live. Proves the
  // mechanism end to end on the REAL attach-client code path (not a
  // StatusBar unit test): the deferred first paint doubling as the onset
  // paint, freeze through a status change made during the freeze, forced
  // paint reflecting that change on the transition back out.
  test('a live question (question_snapshot) suppresses the bar, then the resumed paint reflects a status change made during the freeze', async () => {
    setupOutput();
    const targetSessionId = generateId();
    const questionId = generateId() as UUID;

    server = Bun.serve({
      port: TEST_PORT + 13,
      fetch(req, srv) {
        if (srv.upgrade(req, { data: {} })) return;
        return new Response('Not found', { status: 404 });
      },
      websocket: {
        open() {},
        message(ws, data) {
          const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
          const msg = deserialize(text);
          if (!msg) return;

          if (msg.type === 'hello') {
            ws.send(serialize(createHelloAck('1.0.0', targetSessionId as UUID)));
            // remi_status arrives first, but (#932) startStatusBar() defers
            // its first paint until a question_snapshot has been observed --
            // status A ("idle") is only stored, not yet painted.
            setTimeout(() => {
              ws.send(
                serialize(
                  createRemiStatus(
                    targetSessionId as UUID,
                    mkRemiStatus(targetSessionId as UUID, { sessionStatus: 'idle' }),
                  ),
                ),
              );
            }, 50);
            // question_snapshot arrives with the question already live: this
            // unblocks the deferred start AND is simultaneously the
            // transition into "live", so the bar's first-ever paint IS the
            // onset paint (reflecting status A, stored above).
            setTimeout(() => {
              ws.send(serialize(createQuestionSnapshot(targetSessionId as UUID, [questionId])));
            }, 150);
            // Status changes to B ("thinking") WHILE the question is still
            // live -- must not paint until the freeze ends.
            setTimeout(() => {
              ws.send(
                serialize(
                  createRemiStatus(
                    targetSessionId as UUID,
                    mkRemiStatus(targetSessionId as UUID, { sessionStatus: 'thinking' }),
                  ),
                ),
              );
            }, 600);
            // Question resolves, well ahead of the next timer tick.
            setTimeout(() => {
              ws.send(serialize(createQuestionSnapshot(targetSessionId as UUID, [])));
            }, 1200);
            setTimeout(() => ws.close(), 1700);
          }
        },
        close() {},
      },
    });

    // Peek the output mid-freeze (t=900: after the status-B send at t=600,
    // well ahead of the resolve at t=1200), via a separate read handle so
    // the write fd stays open. This is what actually proves suppression is
    // holding rather than merely coinciding on a final count: if
    // hasLiveQuestions() were broken (e.g. wired to a constant), the status
    // change at t=600 would have produced its own repaint by the very next
    // ~250ms tick, long before t=900 -- and the final bars.length could
    // still land on 2 by coincidence (a plain dedup repaint at t=600 plus
    // nothing else), masking the regression.
    let midFreezeOutput = '';
    setTimeout(() => {
      midFreezeOutput = fs.readFileSync(outputPath, 'utf-8');
    }, 900);

    await runAttachClient({
      host: 'localhost',
      port: TEST_PORT + 13,
      sessionId: targetSessionId,
      timeout: 3000,
      outputFd,
      statusBarEligible: true,
    });

    const midBars = [...midFreezeOutput.matchAll(/\x1b\[7m([^\x1b]*)\x1b\[0m/g)].map((m) => m[1]);
    expect(midBars.length).toBe(1); // still frozen: only the onset paint so far
    expect(midBars[0]).toContain('idle'); // not yet "thinking" -- the freeze held

    const output = readOutput();
    const bars = [...output.matchAll(/\x1b\[7m([^\x1b]*)\x1b\[0m/g)].map((m) => m[1]);
    // Exactly two real paints total: the bar's first-ever paint (deferred
    // until question_snapshot arrives, which doubles as the onset paint
    // since the question is already live by then -- status A, stored
    // earlier), and the resumed paint on the transition back out (status B,
    // reflecting the change made during the freeze). Every tick while
    // frozen wrote nothing, despite the status having changed mid-freeze.
    expect(bars.length).toBe(2);
    expect(bars[0]).toContain('idle');
    expect(bars[1]).toContain('thinking');
  });

  // #932: an older daemon that never sends question_snapshot must not lose
  // the bar entirely -- deferring is a bound (createStatusBar()'s 500ms
  // fallback), not a block.
  test('the bar still starts via the fallback timeout when no question_snapshot ever arrives', async () => {
    setupOutput();
    const targetSessionId = generateId();

    server = Bun.serve({
      port: TEST_PORT + 14,
      fetch(req, srv) {
        if (srv.upgrade(req, { data: {} })) return;
        return new Response('Not found', { status: 404 });
      },
      websocket: {
        open() {},
        message(ws, data) {
          const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
          const msg = deserialize(text);
          if (!msg) return;

          if (msg.type === 'hello') {
            ws.send(serialize(createHelloAck('1.0.0', targetSessionId as UUID)));
            // Deliberately never sends question_snapshot.
            setTimeout(() => {
              ws.send(
                serialize(
                  createRemiStatus(targetSessionId as UUID, mkRemiStatus(targetSessionId as UUID)),
                ),
              );
            }, 50);
            setTimeout(() => ws.close(), 900);
          }
        },
        close() {},
      },
    });

    await runAttachClient({
      host: 'localhost',
      port: TEST_PORT + 14,
      sessionId: targetSessionId,
      timeout: 3000,
      outputFd,
      statusBarEligible: true,
    });

    const output = readOutput();
    expect(output).toContain('\x1b[7m'); // the bar started anyway, past the fallback bound
  });

  // #898: renderMessage's total-dispatch handler for raw_pty_output was
  // exercised only indirectly before (nothing asserted on decoded bytes).
  test('renders decoded raw_pty_output bytes to output', async () => {
    setupOutput();
    const targetSessionId = generateId();
    const payload = Buffer.from('hello from the pty\n', 'utf-8').toString('base64');

    server = Bun.serve({
      port: TEST_PORT + 9,
      fetch(req, srv) {
        if (srv.upgrade(req, { data: {} })) return;
        return new Response('Not found', { status: 404 });
      },
      websocket: {
        open() {},
        message(ws, data) {
          const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
          const msg = deserialize(text);
          if (!msg) return;

          if (msg.type === 'hello') {
            ws.send(serialize(createHelloAck('1.0.0', targetSessionId as UUID)));
            setTimeout(() => {
              ws.send(serialize(createRawPtyOutput(payload, targetSessionId as UUID)));
            }, 50);
            setTimeout(() => ws.close(), 200);
          }
        },
        close() {},
      },
    });

    await runAttachClient({
      host: 'localhost',
      port: TEST_PORT + 9,
      sessionId: targetSessionId,
      timeout: 3000,
      outputFd,
    });

    const output = readOutput();
    expect(output).toContain('hello from the pty');
  });

  // #898: the generic `error` branch (any code other than the early-return
  // SESSION_ENDED/SESSION_BUSY specials handled before renderMessage is
  // reached) was never exercised by name.
  test('renders a generic error inline without ending the session', async () => {
    setupOutput();
    const targetSessionId = generateId();

    server = Bun.serve({
      port: TEST_PORT + 10,
      fetch(req, srv) {
        if (srv.upgrade(req, { data: {} })) return;
        return new Response('Not found', { status: 404 });
      },
      websocket: {
        open() {},
        message(ws, data) {
          const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
          const msg = deserialize(text);
          if (!msg) return;

          if (msg.type === 'hello') {
            ws.send(serialize(createHelloAck('1.0.0', targetSessionId as UUID)));
            setTimeout(() => {
              ws.send(serialize(createError('SOME_OTHER_CODE', 'transient glitch')));
            }, 50);
            setTimeout(() => ws.close(), 200);
          }
        },
        close() {},
      },
    });

    const result = await runAttachClient({
      host: 'localhost',
      port: TEST_PORT + 10,
      sessionId: targetSessionId,
      timeout: 3000,
      outputFd,
    });

    const output = readOutput();
    expect(output).toContain('[error: SOME_OTHER_CODE - transient glitch]');
    // Unlike SESSION_ENDED/SESSION_BUSY, a generic error code does not end
    // the attach session; the connection just closes normally afterward.
    expect(result.reason).toBe('connection_closed');
  });

  // #898: `ack` is direction 'both' and genuinely arrives here — the daemon
  // acks messages this client sends (e.g. terminal_resize, user_input) — but
  // attach-client has never rendered acks and must keep not rendering them.
  // Proves the 'ignore' entry for a real (not merely hypothetical) inbound
  // type is correct, not just unreachable code. (Sent right after hello_ack,
  // not gated on a specific client message, since process.stdout.columns/
  // rows are unset in this non-TTY test environment and attach-client skips
  // its own resize sends in that case.)
  test('ignores a real ack reply without printing or crashing', async () => {
    setupOutput();
    const targetSessionId = generateId();

    server = Bun.serve({
      port: TEST_PORT + 11,
      fetch(req, srv) {
        if (srv.upgrade(req, { data: {} })) return;
        return new Response('Not found', { status: 404 });
      },
      websocket: {
        open() {},
        message(ws, data) {
          const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
          const msg = deserialize(text);
          if (!msg) return;

          if (msg.type === 'hello') {
            ws.send(serialize(createHelloAck('1.0.0', targetSessionId as UUID)));
            setTimeout(() => {
              ws.send(
                serialize(
                  createAck({ messageId: generateId(), state: 'delivered', timestamp: now() }),
                ),
              );
            }, 50);
            setTimeout(() => ws.close(), 200);
          }
        },
        close() {},
      },
    });

    const result = await runAttachClient({
      host: 'localhost',
      port: TEST_PORT + 11,
      sessionId: targetSessionId,
      timeout: 3000,
      outputFd,
    });

    const output = readOutput();
    expect(output).not.toContain('ack');
    expect(output).not.toContain('[error');
    expect(result.reason).toBe('connection_closed');
  });
});

// --- Compile-time totality demonstration (#898 acceptance criterion) ---
//
// attach-client.ts's renderMessage builds a `MessageHandlers<keyof
// ProtocolMessageMap, void>` literal covering every registry key (see the
// doc comment on renderMessage for why the map is sized to the full
// registry rather than a narrower daemon-to-client-only alias). This proves
// the mechanism directly against that same type: a handler map missing one
// key does not satisfy it. Verified live (not just present): removing
// `question_snapshot: 'ignore'` from attach-client.ts's actual handlers
// object and running `bun run typecheck` produced `TS2741: Property
// 'question_snapshot' is missing in type '{...}' but required in type
// 'MessageHandlers<keyof ProtocolMessageMap, void>'` at the object literal;
// restoring the entry made it pass again.
describe('renderMessage handler map is total (compile-time, #898)', () => {
  test('a handler map missing one registry key is rejected by MessageHandlers<keyof ProtocolMessageMap>', () => {
    const registryTypes = Object.keys(MESSAGE_DIRECTION) as (keyof ProtocolMessageMap)[];
    const allButOne = registryTypes.filter((t) => t !== 'question_snapshot');
    const missingOneHandler = Object.fromEntries(
      allButOne.map((t) => [t, 'ignore' as const]),
    ) as MessageHandlers<Exclude<keyof ProtocolMessageMap, 'question_snapshot'>>;

    expect(Object.keys(missingOneHandler).length).toBe(registryTypes.length - 1);

    // @ts-expect-error - deliberately missing 'question_snapshot'; assigning
    // to the full MessageHandlers<keyof ProtocolMessageMap> type must fail.
    // This is the shape attach-client.ts's renderMessage handler map has:
    // forgetting a registry key is a build error here, not a silent runtime
    // no-op (#898's acceptance criterion). Removing this comment to check
    // the assignment is unguarded is how this was verified (see file header
    // note above and the dispatch.ts pattern this mirrors).
    const incomplete: MessageHandlers<keyof ProtocolMessageMap> = missingOneHandler;
    void incomplete;
  });

  test('the same map WITH the key present satisfies the full type', () => {
    const registryTypes = Object.keys(MESSAGE_DIRECTION) as (keyof ProtocolMessageMap)[];
    const complete = Object.fromEntries(
      registryTypes.map((t) => [t, 'ignore' as const]),
    ) as MessageHandlers<keyof ProtocolMessageMap>;

    const total: MessageHandlers<keyof ProtocolMessageMap> = complete;
    expect(Object.keys(total).length).toBe(registryTypes.length);
  });
});
