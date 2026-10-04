/**
 * Hand-built peers for the tests and the vector generator: they assemble frames
 * from the library's exported pieces, so a test can craft what the real client
 * or host never would (a bad name, a wrong mode echo, a signature over a
 * different transcript) and still have a real counterpart judge it.
 */

import { createHash } from 'node:crypto';
import { relayV2 as r } from '../../src/index.ts';
import { aeadKey, aeadSeal, ecGenerate, ecdh } from '../../src/relay/primitives.ts';
import { seededRandom } from './helpers.ts';

/** Reference length-prefix hash, written out here so these tests do not share the code under test. */
export const refHash = (...parts: Uint8Array[]): Uint8Array => {
  const out: Buffer[] = [];
  for (const p of parts) out.push(Buffer.from([p.length >> 8, p.length & 0xff]), Buffer.from(p));
  return new Uint8Array(createHash('sha256').update(Buffer.concat(out)).digest());
};

/** A hand-rolled client, built from the same exported pieces, to craft frames the real one never would. */
export async function manualClient(
  mode: r.Mode,
  psk: Uint8Array | null,
  machinePk: Uint8Array,
  label: string,
) {
  const random = seededRandom(`${label} manual client`);
  const ephemeral = await ecGenerate(random);
  const nonce = random(32);
  const rid = await r.ridOf(machinePk);
  return {
    hello: r.encodeHello(mode, ephemeral.publicKey, nonce),
    async onAck(ackFrame: string) {
      const ack = r.decodeHelloAck(ackFrame);
      const h1 = await r.transcriptH1({
        rid,
        mode,
        clientEphemeral: ephemeral.publicKey,
        clientNonce: nonce,
        hostEphemeral: ack.ephemeral,
        hostNonce: ack.nonce,
      });
      const keys = await r.deriveSessionKeys(
        await ecdh(ephemeral.privateKey, ack.ephemeral),
        h1,
        psk,
      );
      return {
        h1,
        ack,
        keys,
        sealAuth: async (plaintext: Uint8Array) =>
          r.encodeSealedControl(
            'auth',
            await aeadSeal(await aeadKey(keys.c2h), r.TYPE_AUTH, r.DIR_C2H, 0, plaintext),
          ),
      };
    },
  };
}

/** A hand-rolled host that answers a hello and can seal any `ready` plaintext. */
export async function manualHost(
  machine: r.Signer,
  mode: r.Mode,
  psk: Uint8Array | null,
  helloFrame: string,
  label: string,
) {
  const random = seededRandom(`${label} manual host`);
  const hello = r.decodeHello(helloFrame);
  const ephemeral = await ecGenerate(random);
  const nonce = random(32);
  const h1 = await r.transcriptH1({
    rid: await r.ridOf(machine.publicKey),
    mode,
    clientEphemeral: hello.ephemeral,
    clientNonce: hello.nonce,
    hostEphemeral: ephemeral.publicKey,
    hostNonce: nonce,
  });
  const signature = await machine.sign(r.hostSigningInput(h1));
  const keys = await r.deriveSessionKeys(
    await ecdh(ephemeral.privateKey, hello.ephemeral),
    h1,
    psk,
  );
  return {
    helloAck: r.encodeHelloAck(ephemeral.publicKey, nonce, signature),
    keys,
    sealReady: async (plaintext: Uint8Array) =>
      r.encodeSealedControl(
        'ready',
        await aeadSeal(await aeadKey(keys.h2c), r.TYPE_READY, r.DIR_H2C, 0, plaintext),
      ),
  };
}
