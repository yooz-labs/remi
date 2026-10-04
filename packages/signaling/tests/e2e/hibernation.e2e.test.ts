/**
 * Hibernation against the REAL Durable Object: the room is evicted from memory
 * while idle (workerd does it after about ten seconds without an event) and
 * rebuilt on the next event, and a live session must not notice. This is the one
 * test that waits in real time, about fifteen seconds; it is in its own file so
 * the rest of the end-to-end suite stays fast.
 *
 * What it does not show: the production hibernation threshold is unverified.
 */

import { afterEach, expect, test } from 'bun:test';
import { relayV2 } from '@remi/shared';
import { FakeHost, connectClient, newIdentity, newMachine, roomState } from './endpoints.ts';
import { type TestWorker, startWorker } from './harness.ts';
import { HostState, dial, serve } from './session.ts';

const { admitTag, createPairingOffer, systemRandom } = relayV2;

let worker: TestWorker | undefined;
afterEach(() => worker?.stop());

test('a session survives the object being evicted from memory and rebuilt', async () => {
  // a short admission deadline, so its alarm is spent early and the object can go idle
  worker = await startWorker({ ADMIT_TIMEOUT_MS: '1000' });
  const machine = await newMachine();
  const host = await FakeHost.start(worker, machine);
  const state = new HostState();
  const offer = createPairingOffer(systemRandom, Date.now());
  state.offers = [offer];
  await host.openWindow(offer.secret);
  const device = await newIdentity();
  const { socket } = await connectClient(worker, machine, device, await admitTag(offer.secret));
  const pipe = await host.openPipe(await host.nextConnection());
  await socket.json();
  const [hostSide, client] = await Promise.all([
    serve(host, state, pipe),
    dial(socket, { machine, device, pairingSecret: offer.secret }),
  ]);
  await client.send('awake');
  expect(await hostSide.link.text()).toBe('awake');

  const before = (await roomState(worker, machine.ridHex)).boot;
  await Bun.sleep(14_500);
  const after = await roomState(worker, machine.ridHex);
  // a different boot id means the object was rebuilt: its sockets and state came back from
  // the runtime (attachments and tags) and from storage, not from memory
  expect(after.boot).not.toBe(before);
  expect(after.sockets.filter((x) => x?.st === 'open')).toHaveLength(2);
  await hostSide.link.send('after hibernation');
  expect(await client.text()).toBe('after hibernation');
  await client.send('and back');
  expect(await hostSide.link.text()).toBe('and back');
}, 40_000);
