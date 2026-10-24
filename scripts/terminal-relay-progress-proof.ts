/** Necessary-only transport probe (#1656). No production relay terminal route or accounting claim. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPing,
  createPong,
  decodeTerminalViewFrame,
  encodeTerminalViewFrame,
  relayV2,
  serialize,
} from '@remi/shared';
import type { TerminalSendSlot } from '../packages/daemon/src/terminal/send-slot.ts';
import {
  terminalServiceFixture,
  until,
} from '../packages/daemon/tests/helpers/terminal-service-fixture.ts';
import {
  FakeHost,
  Socket,
  admit,
  newIdentity,
  newMachine,
} from '../packages/signaling/tests/e2e/endpoints.ts';
import { startWorker } from '../packages/signaling/tests/e2e/harness.ts';

const publish = (file: string, value: unknown) => {
  fs.writeFileSync(`${file}.new`, JSON.stringify(value));
  fs.renameSync(`${file}.new`, file);
};
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const bytes = (value: object) => new TextEncoder().encode(serialize(value as never));
async function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Owned probe deadline: ${label}`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
const directory = process.argv[3];
if (process.argv[2] === '--client') {
  assert(directory);
  const device = await newIdentity();
  publish(join(directory, 'identity'), { publicKey: relayV2.b64u(device.publicKey) });
  await until(
    () => fs.existsSync(join(directory, 'connect')),
    'public transport descriptor',
    10_000,
  );
  const descriptor = read(join(directory, 'connect'));
  const socket = await Socket.open(descriptor.url);
  let channel: relayV2.Channel | undefined;
  let chain = Promise.resolve();
  let failure: unknown;
  let projectionPing: string | undefined;
  let dataSeen = false;
  try {
    await admit(socket, device, 'client', relayV2.fromB64u(descriptor.rid));
    assert.equal((await socket.json())['t'], 'admitted');
    assert.equal((await socket.json())['t'], 'open');
    const step1 = await relayV2.clientStart(
      {
        machinePublicKey: relayV2.fromB64u(descriptor.machinePublicKey),
        device: device.signer,
        mode: 'resume',
        random: relayV2.systemRandom,
      },
      Date.now(),
    );
    socket.sendText(step1.hello);
    const step2 = await step1.onHelloAck(await socket.text(), Date.now());
    socket.sendText(step2.auth);
    channel = await step2.onReady(await socket.text(), Date.now(), {
      emit: (frame) => socket.sendBinary(frame),
      close: (code) => socket.close(code),
    });
    const active = channel;
    socket.tap((frame) => {
      chain = chain
        .then(async () => {
          const plaintext = await active.receive(frame);
          assert(plaintext, 'probe receives data, not BYE');
          if (!dataSeen) {
            assert.equal(plaintext.byteLength, 65_536);
            assert.equal(digest(plaintext), descriptor.hash);
            assert.equal(decodeTerminalViewFrame(plaintext)?.type, 'session_terminal_snapshot');
            dataSeen = true;
            publish(join(directory, 'decoded'), {
              hash: digest(plaintext),
              bytes: plaintext.byteLength,
            });
            return;
          }
          const message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
          assert.equal(message.type, 'ping');
          if (!projectionPing) {
            projectionPing = message.id;
            await active.send(bytes(createPong(randomUUID())));
            publish(join(directory, 'wrong-sent'), {});
          } else {
            await active.send(bytes(createPong(message.id)));
          }
        })
        .catch((error) => {
          failure = error;
        });
    });
    publish(join(directory, 'ready'), { pid: process.pid });
    await until(
      () => failure !== undefined || fs.existsSync(join(directory, 'release')),
      'withheld projection progress',
      10_000,
    );
    if (failure) throw failure;
    assert(projectionPing && dataSeen);
    await active.send(bytes(createPong(projectionPing)));
    publish(join(directory, 'matched-sent'), {});
    await until(
      () => failure !== undefined || fs.existsSync(join(directory, 'stop')),
      'owned client shutdown',
      10_000,
    );
    if (failure) throw failure;
    await chain;
    if (descriptor.stallShutdown) {
      process.on('SIGTERM', () => {});
      process.kill(process.pid, 'SIGSTOP');
    }
  } finally {
    channel?.close();
    socket.close();
    await within(socket.closed, 1000, 'client socket close');
  }
} else {
  assert.equal(process.argv[2], '--run');
  assert(directory, 'explicit owned receipt directory');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const ipc = fs.mkdtempSync(join(tmpdir(), 'remi-b4q-'));
  const result: Record<string, unknown> = {
    status: 'running',
    scope: 'necessary-only local encrypted transport',
    premature: process.argv.includes('--premature'),
  };
  const worker = await startWorker();
  let host: FakeHost | undefined;
  let pipe: Socket | undefined;
  let channel: relayV2.Channel | undefined;
  let fixture: Awaited<ReturnType<typeof terminalServiceFixture>> | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let stopped = false;
  let slot: TerminalSendSlot | undefined;
  let released = false;
  let failure: unknown;
  let receiveFailure: unknown;
  let receiveChain = Promise.resolve();
  let projectionPong = false;
  let genericPong = false;
  let wrongPong = false;
  const projectionPing = createPing();
  const genericPing = createPing();
  const wireLengths: number[] = [];
  try {
    const machine = await newMachine();
    fixture = await terminalServiceFixture();
    const peer = await fixture.client(false, true);
    assert(peer.packet);
    const opened = await peer.submit(peer.open());
    assert.equal(opened.type, 'session_terminal_opened');
    if (opened.type !== 'session_terminal_opened') throw new Error('open refused');
    await until(() => peer.packet?.hasPendingPong() === true, 'real open native ping');
    peer.packet.confirmPong();
    const records = Reflect.get(fixture.service, 'records') as Map<
      object,
      { slot: TerminalSendSlot }
    >;
    assert.equal(records.size, 1);
    slot = [...records.values()][0]?.slot;
    assert(slot);
    await until(() => !slot?.busy, 'open native disposal');
    const snapshot = await peer.submit(peer.read(opened.viewId));
    assert.equal(snapshot.type, 'session_terminal_snapshot');
    await until(() => peer.packet?.hasPendingPong() === true, 'held snapshot native ping');
    const raw = new TextEncoder().encode(encodeTerminalViewFrame(snapshot));
    assert(raw.byteLength <= 65_536);
    const unit = new Uint8Array(65_536).fill(32);
    unit.set(raw);
    assert(
      decodeTerminalViewFrame(unit),
      'legal trailing JSON whitespace preserves strict snapshot',
    );
    const borrowed = () => {
      const frame = fixture?.capture.contextFor(fixture.sessionId)?.borrow();
      frame?.release();
      return slot?.busy === true && frame === null;
    };
    assert(borrowed(), 'real model held before relay send');
    const stdout = fs.openSync(join(directory, 'client.stdout'), 'w');
    const stderr = fs.openSync(join(directory, 'client.stderr'), 'w');
    try {
      child = Bun.spawn([process.execPath, '--no-env-file', import.meta.path, '--client', ipc], {
        env: {
          HOME: process.env['HOME'] ?? ipc,
          TMPDIR: tmpdir(),
          PATH: process.env['PATH'] ?? '/usr/bin:/bin',
          E2E_BUNDLER: 'esbuild',
        },
        stdout,
        stderr,
      });
    } finally {
      fs.closeSync(stdout);
      fs.closeSync(stderr);
    }
    await until(
      () => fs.existsSync(join(ipc, 'identity')) || child?.exitCode !== null,
      'owned client key',
    );
    assert.equal(child.exitCode, null);
    const clientKey = relayV2.fromB64u(read(join(ipc, 'identity')).publicKey);
    host = await FakeHost.start(worker, machine);
    await host.enroll(clientKey);
    publish(join(ipc, 'connect'), {
      url: `${worker.wsUrl}/v2/client/${machine.ridHex}`,
      rid: relayV2.b64u(machine.rid),
      machinePublicKey: relayV2.b64u(machine.publicKey),
      hash: digest(unit),
      stallShutdown: process.argv.includes('--stall-shutdown'),
    });
    pipe = await host.openPipe(await host.nextConnection());
    const activePipe = pipe;
    const policy = {
      offers: [],
      isEnrolled: (key: Uint8Array) => Buffer.from(key).equals(Buffer.from(clientKey)),
    };
    const step1 = await relayV2.hostOnHello(
      { machine: machine.signer, random: relayV2.systemRandom },
      await pipe.text(),
      policy,
      Date.now(),
    );
    pipe.sendText(step1.helloAck);
    const step2 = await step1.onAuth(await pipe.text(), policy, Date.now());
    const ready = await step2.ready(Date.now(), {
      emit: (frame) => {
        wireLengths.push(frame.byteLength);
        activePipe.sendBinary(frame);
      },
      close: (code) => activePipe.close(code),
    });
    channel = ready.channel;
    pipe.sendText(ready.ready);
    const active = channel;
    pipe.tap((frame) => {
      receiveChain = receiveChain
        .then(async () => {
          const plaintext = await active.receive(frame);
          assert(plaintext);
          const message = JSON.parse(new TextDecoder().decode(plaintext));
          assert.equal(message.type, 'pong');
          if (message.pingId === projectionPing.id) projectionPong = true;
          else if (message.pingId === genericPing.id) genericPong = true;
          else wrongPong = true;
        })
        .catch((error) => {
          receiveFailure = error;
        });
    });
    await until(() => fs.existsSync(join(ipc, 'ready')), 'owned encrypted client ready');
    assert.equal(read(join(ipc, 'ready')).pid, child.pid);
    process.kill(child.pid, 'SIGSTOP');
    stopped = true;
    const ps = Bun.spawnSync(['/bin/ps', '-o', 'state=', '-p', String(child.pid)]);
    assert.equal(ps.exitCode, 0);
    assert(ps.stdout.toString().includes('T'), 'actual client process stopped');
    await active.send(unit);
    assert.equal(wireLengths[0], 65_561);
    if (result['premature']) {
      peer.packet.confirmPong();
      await until(() => !slot?.busy, 'deliberate early native release');
      released = true;
    }
    assert(
      borrowed(),
      'projection remains borrowed after send completion before encrypted progress',
    );
    assert(!fs.existsSync(join(ipc, 'decoded')), 'stopped client has not decoded');
    await active.send(bytes(projectionPing));
    process.kill(child.pid, 'SIGCONT');
    stopped = false;
    await until(() => wrongPong || receiveFailure !== undefined, 'actual wrong encrypted pong');
    if (receiveFailure) throw receiveFailure;
    assert(borrowed() && !projectionPong, 'wrong pong retains original model ownership');
    assert.equal(read(join(ipc, 'decoded')).hash, digest(unit));
    await active.send(bytes(genericPing));
    await until(
      () => genericPong || receiveFailure !== undefined,
      'independent encrypted ping progress',
    );
    if (receiveFailure) throw receiveFailure;
    assert(
      borrowed() && !projectionPong && !active.closed,
      'generic control progresses while terminal receipt withheld',
    );
    publish(join(ipc, 'release'), {});
    await until(
      () => projectionPong || receiveFailure !== undefined,
      'matching ordered encrypted pong',
    );
    if (receiveFailure) throw receiveFailure;
    assert(borrowed(), 'only the original real native receipt releases model ownership');
    peer.packet.confirmPong();
    await until(() => !slot?.busy, 'original native receipt release');
    released = true;
    const next = fixture.capture.contextFor(fixture.sessionId)?.borrow();
    assert(next, 'actual model can be borrowed after matching progress and native disposal');
    next.release();
    publish(join(ipc, 'stop'), {});
    assert.equal(
      await within(child.exited, 2000, 'owned client exit'),
      0,
      'owned client exited successfully',
    );
    assert.throws(() => process.kill(child?.pid as number, 0), { code: 'ESRCH' });
    result['status'] = 'passed-transport-prefix-only';
    result['wireLengths'] = wireLengths;
    result['plaintextBytes'] = unit.byteLength;
    result['hash'] = digest(unit);
  } catch (error) {
    failure = error;
    result['status'] = 'failed';
    result['error'] = String(error);
  } finally {
    const errors: unknown[] = [];
    if (child && child.exitCode === null) {
      if (stopped) process.kill(child.pid, 'SIGCONT');
      publish(join(ipc, 'release'), {});
      publish(join(ipc, 'stop'), {});
      child.kill('SIGTERM');
      try {
        await within(child.exited, 1000, 'client termination');
      } catch {
        // A stopped owned process may not service TERM. Escalate only this
        // still-unreaped child, then record uncertainty if it cannot be joined.
        child.kill('SIGKILL');
        result['clientRequiredKill'] = true;
        try {
          await within(child.exited, 1000, 'client kill and join');
        } catch (error) {
          errors.push(error);
        }
      }
    }
    if (slot?.busy && !released) slot.nativeClosed();
    channel?.close();
    pipe?.close();
    host?.control.close();
    for (const cleanup of [() => fixture?.close(), () => worker.stop()]) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    result['ownedCleanupJoined'] = errors.length === 0;
    if (errors.length) {
      result['cleanupErrors'] = errors.map(String);
      result['status'] = 'failed';
      failure ??= errors[0];
    }
    result['finishedAt'] = new Date().toISOString();
    publish(join(directory, 'result.json'), result);
    if (!failure) fs.rmSync(ipc, { recursive: true });
  }
  if (failure) throw failure;
  console.log(JSON.stringify(result));
}
