/** Independent R6 tuples, using public synthetic identities and real Ed25519. */
import { createHash } from 'node:crypto';
import type { NativeAnswer, UnsignedNativeAnswer } from '../../src/relay/index.ts';
import * as r from '../../src/relay/internal.ts';
import { hex, seed, text } from './helpers.ts';

const u16 = (value: number) => Uint8Array.of(value >>> 8, value & 255);
const optionalText = (value: string | undefined) =>
  value === undefined ? Uint8Array.of(0) : r.concat(Uint8Array.of(1), text(value));

/** Deliberately does not call the production native-answer encoder or digest. */
export function independentBody(value: UnsignedNativeAnswer): Uint8Array {
  const selections =
    value.selections === undefined
      ? Uint8Array.of(0)
      : r.concat(
          Uint8Array.of(1),
          r.lps(
            u16(value.selections.length),
            ...value.selections.map((selection) =>
              r.lps(
                u16(selection.questionIndex),
                r.lps(u16(selection.optionIndices.length), ...selection.optionIndices.map(u16)),
                optionalText(selection.text),
              ),
            ),
          ),
        );
  return r.lps(
    Buffer.from(value.rid, 'hex'),
    r.fromB64u(value.machinePublicKey),
    r.fromB64u(value.devicePublicKey),
    value.id,
    value.sessionId,
    r.fromB64u(value.runtimeInstance),
    value.questionId,
    value.collapseId,
    r.be64(value.revision),
    r.fromB64u(value.contentDigest),
    r.fromB64u(value.nonce),
    r.be64(value.issuedAt),
    r.be64(value.expiresAt),
    value.answer,
    optionalText(value.claudeSessionId),
    selections,
    value.cancel === undefined ? Uint8Array.of(0) : Uint8Array.of(1, value.cancel ? 1 : 0),
    optionalText(value.message),
  );
}

export const independentDigest = (body: Uint8Array): string =>
  createHash('sha256').update(body).digest('hex');
export const independentSigningInput = (value: UnsignedNativeAnswer): Uint8Array =>
  r.lps(
    'remi-relay-v2 native answer',
    Buffer.from(independentDigest(independentBody(value)), 'hex'),
  );

export async function buildNativeAnswerVectors() {
  const machineSeed = seed('native answer vector machine');
  const deviceSeed = seed('native answer vector device');
  const machine = await r.signerFromSeed(machineSeed);
  const device = await r.signerFromSeed(deviceSeed);
  const base: UnsignedNativeAnswer = {
    type: 'native_answer',
    v: 2,
    id: 'synthetic-native-request',
    timestamp: '2023-11-14T22:13:20.000Z',
    rid: hex(await r.ridOf(machine.publicKey)),
    machinePublicKey: r.b64u(machine.publicKey),
    devicePublicKey: r.b64u(device.publicKey),
    sessionId: 'synthetic-session',
    runtimeInstance: r.b64u(seed('native answer runtime')),
    questionId: 'synthetic-question',
    collapseId: r.b64u(seed('native answer collapse').slice(0, 16)),
    revision: 7,
    contentDigest: r.b64u(seed('native answer content')),
    nonce: r.b64u(seed('native answer nonce')),
    issuedAt: 1700000000,
    expiresAt: 1700000030,
    answer: '1',
  };
  const variants: [string, Partial<UnsignedNativeAnswer>][] = [
    ['absent-optionals', {}],
    ['empty-message', { message: '' }],
    ['explicit-false', { cancel: false }],
    ['cancel', { answer: '', cancel: true }],
    ['legacy-binding', { claudeSessionId: 'synthetic-harness-instance' }],
    ['unicode-exact', { answer: '\uFEFF e\u0301 🦉 ', message: 'é\r\nline\u0000' }],
    [
      'structured-indices',
      {
        answer: '',
        selections: [
          { questionIndex: 0, optionIndices: [0, 1, 256, 65535] },
          { questionIndex: 65535, optionIndices: [], text: 'exact free text' },
        ],
      },
    ],
    [
      'all-compatible-optionals',
      {
        answer: '',
        claudeSessionId: 'owned-harness',
        selections: [{ questionIndex: 258, optionIndices: [257, 4096] }],
        cancel: false,
        message: 'Keep this exact message.',
      },
    ],
  ];
  const cases = [];
  for (const [name, overrides] of variants) {
    const unsigned = { ...base, ...overrides };
    const body = independentBody(unsigned);
    const signingInput = independentSigningInput(unsigned);
    const message: NativeAnswer = {
      ...unsigned,
      signature: r.b64u(await device.sign(signingInput)),
    };
    cases.push({
      name,
      message,
      bodyHex: hex(body),
      signingInputHex: hex(signingInput),
      requestDigest: independentDigest(body),
    });
  }
  return { version: 1, machineSeedHex: hex(machineSeed), deviceSeedHex: hex(deviceSeed), cases };
}
