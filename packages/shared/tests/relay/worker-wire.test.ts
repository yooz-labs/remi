/**
 * The Worker control messages (`worker-wire.ts`): routes, notices and the two
 * decoders. Wire claims are pinned with LITERAL strings, not with the encoder
 * under test, so the daemon and client phases that write the endpoint side can
 * be checked against the same bytes.
 */

import { describe, expect, test } from 'bun:test';
import { b64u } from '../../src/relay/bytes.ts';
import {
  MAX_WORKER_TEXT,
  decodeAdmit,
  decodeHostCommand,
  encodeNotice,
  parseWorkerPath,
} from '../../src/relay/worker-wire.ts';
import { codeOfSync } from './helpers.ts';

const RID = '00112233445566778899aabbccddeeff';
const CID = 'ffeeddccbbaa99887766554433221100';
const bytes = (n: number, fill: number): Uint8Array => new Uint8Array(n).fill(fill);
const K = b64u(bytes(32, 7));
const S = b64u(bytes(64, 9));
const A = b64u(bytes(32, 5));

describe('routes', () => {
  test('the three routes parse and carry the room id and the connection id', () => {
    const host = parseWorkerPath(`/v2/host/${RID}`);
    expect(host).toMatchObject({ role: 'host', ridHex: RID, cid: null });
    expect(host?.rid).toEqual(Uint8Array.from(Buffer.from(RID, 'hex')));
    expect(parseWorkerPath(`/v2/client/${RID}`)).toMatchObject({ role: 'client', cid: null });
    expect(parseWorkerPath(`/v2/pipe/${RID}/${CID}`)).toMatchObject({
      role: 'pipe',
      ridHex: RID,
      cid: CID,
    });
  });

  test('anything but exactly one of the routes is refused', () => {
    const refused = [
      `/v2/host/${RID.toUpperCase()}`,
      `/v2/host/${RID.slice(2)}`,
      `/v2/host/${RID}00`,
      `/v2/host/${RID}/`,
      `/v2/host/${RID}/${CID}`,
      `/v2/client/${RID}/${CID}`,
      `/v2/pipe/${RID}`,
      `/v2/pipe/${RID}/${CID.slice(2)}`,
      `/v2/pipe/${RID}/${CID.toUpperCase()}`,
      `/v1/host/${RID}`,
      `/v3/host/${RID}`,
      `/host/${RID}`,
      `/v2/relay/${RID}`,
      `/v2/host/${RID.replace('0', 'g')}`,
      `//v2/host/${RID}`,
      `/v2/host/${RID}\n`,
      '/connect/ABCD-2345',
      '/',
    ];
    for (const path of refused) expect([path, parseWorkerPath(path)]).toEqual([path, null]);
  });
});

describe('what the Worker says', () => {
  const nonce = Uint8Array.from({ length: 32 }, (_, i) => i);
  test('each notice is exactly these bytes', () => {
    expect(encodeNotice({ t: 'nonce', nonce })).toBe(
      `{"t":"nonce","n":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"}`,
    );
    expect(encodeNotice({ t: 'admitted' })).toBe('{"t":"admitted"}');
    expect(encodeNotice({ t: 'admitted', hostUp: true })).toBe('{"t":"admitted","up":true}');
    expect(encodeNotice({ t: 'admitted', hostUp: false })).toBe('{"t":"admitted","up":false}');
    expect(encodeNotice({ t: 'host', up: true })).toBe('{"t":"host","up":true}');
    expect(encodeNotice({ t: 'host', up: false })).toBe('{"t":"host","up":false}');
    expect(encodeNotice({ t: 'open' })).toBe('{"t":"open"}');
    expect(encodeNotice({ t: 'connected', cid: CID })).toBe(`{"t":"connected","c":"${CID}"}`);
    expect(encodeNotice({ t: 'gone', cid: CID })).toBe(`{"t":"gone","c":"${CID}"}`);
    expect(encodeNotice({ t: 'ack', op: 'enroll', ok: true })).toBe(
      '{"t":"ack","r":"enroll","ok":true}',
    );
    expect(encodeNotice({ t: 'ack', op: 'pairing', ok: false })).toBe(
      '{"t":"ack","r":"pairing","ok":false}',
    );
  });
});

describe('admit', () => {
  test('a host or device proof, with or without a ticket, decodes to its bytes', () => {
    const plain = decodeAdmit(`{"t":"admit","k":"${K}","s":"${S}"}`);
    expect(plain.key).toEqual(bytes(32, 7));
    expect(plain.signature).toEqual(bytes(64, 9));
    expect(plain.ticket).toBeUndefined();
    const ticketed = decodeAdmit(`{"t":"admit","k":"${K}","s":"${S}","a":"${A}"}`);
    expect(ticketed.ticket).toEqual(bytes(32, 5));
  });

  test('every malformation is refused with its own code', () => {
    const cases: [string, unknown, string][] = [
      ['a binary frame', new ArrayBuffer(8), 'TYPE'],
      ['not JSON', 'admit', 'MALFORMED'],
      ['an array', '[]', 'MALFORMED'],
      ['null', 'null', 'MALFORMED'],
      ['a wrong type', `{"t":"enroll","k":"${K}","s":"${S}"}`, 'TYPE'],
      ['a missing type', `{"k":"${K}","s":"${S}"}`, 'TYPE'],
      ['an unknown key', `{"t":"admit","k":"${K}","s":"${S}","x":"1"}`, 'MALFORMED'],
      ['a prototype key', `{"t":"admit","k":"${K}","s":"${S}","__proto__":{}}`, 'MALFORMED'],
      ['a missing key field', `{"t":"admit","s":"${S}"}`, 'MALFORMED'],
      ['a missing signature', `{"t":"admit","k":"${K}"}`, 'MALFORMED'],
      ['a short public key', `{"t":"admit","k":"${b64u(bytes(31, 7))}","s":"${S}"}`, 'MALFORMED'],
      ['a long public key', `{"t":"admit","k":"${b64u(bytes(33, 7))}","s":"${S}"}`, 'MALFORMED'],
      ['a short signature', `{"t":"admit","k":"${K}","s":"${b64u(bytes(63, 9))}"}`, 'MALFORMED'],
      [
        'a short ticket',
        `{"t":"admit","k":"${K}","s":"${S}","a":"${b64u(bytes(31, 5))}"}`,
        'MALFORMED',
      ],
      ['a padded key', `{"t":"admit","k":"${K}=","s":"${S}"}`, 'MALFORMED'],
      ['a non-canonical key', `{"t":"admit","k":"${K.slice(0, -1)}B","s":"${S}"}`, 'MALFORMED'],
      [
        'a standard-alphabet key',
        `{"t":"admit","k":"${K.replace(/-/g, '+')}+","s":"${S}"}`,
        'MALFORMED',
      ],
      ['a numeric key', `{"t":"admit","k":7,"s":"${S}"}`, 'MALFORMED'],
      ['a null ticket', `{"t":"admit","k":"${K}","s":"${S}","a":null}`, 'MALFORMED'],
      [
        'a message over the limit',
        `{"t":"admit","k":"${K}","s":"${S}","a":"${A}","pad":"${'x'.repeat(MAX_WORKER_TEXT)}"}`,
        'OVERSIZE',
      ],
    ];
    for (const [name, input, code] of cases) {
      expect([name, codeOfSync(() => decodeAdmit(input))]).toEqual([name, code]);
    }
  });

  test('the size limit counts UTF-8 bytes, not characters', () => {
    const multibyte = `{"t":"admit","k":"${K}","s":"${S}","x":"${'é'.repeat(200)}"}`;
    expect(multibyte.length).toBeLessThan(MAX_WORKER_TEXT);
    expect(codeOfSync(() => decodeAdmit(multibyte))).toBe('OVERSIZE');
  });
});

describe('host commands', () => {
  test('enroll, revoke and pairing decode to their bytes', () => {
    expect(decodeHostCommand(`{"t":"enroll","k":"${K}"}`)).toEqual({
      t: 'enroll',
      key: bytes(32, 7),
    });
    expect(decodeHostCommand(`{"t":"revoke","k":"${K}"}`)).toEqual({
      t: 'revoke',
      key: bytes(32, 7),
    });
    expect(decodeHostCommand(`{"t":"pairing","h":"${A}","ttl":600}`)).toEqual({
      t: 'pairing',
      ticketHash: bytes(32, 5),
      ttlSeconds: 600,
    });
    expect(decodeHostCommand(`{"t":"pairing","h":"${A}","ttl":1}`)).toMatchObject({
      ttlSeconds: 1,
    });
  });

  test('every malformation is refused with its own code', () => {
    const cases: [string, unknown, string][] = [
      ['a binary frame', new ArrayBuffer(8), 'TYPE'],
      ['an unknown command', `{"t":"promote","k":"${K}"}`, 'TYPE'],
      ['admit is not a command', `{"t":"admit","k":"${K}"}`, 'TYPE'],
      ['enroll without a key', '{"t":"enroll"}', 'MALFORMED'],
      ['enroll with a short key', `{"t":"enroll","k":"${b64u(bytes(31, 7))}"}`, 'MALFORMED'],
      ['enroll carrying a ttl', `{"t":"enroll","k":"${K}","ttl":5}`, 'MALFORMED'],
      ['revoke carrying a hash', `{"t":"revoke","k":"${K}","h":"${A}"}`, 'MALFORMED'],
      ['pairing carrying a key', `{"t":"pairing","h":"${A}","ttl":5,"k":"${K}"}`, 'MALFORMED'],
      ['pairing without a hash', '{"t":"pairing","ttl":5}', 'MALFORMED'],
      [
        'pairing with a short hash',
        `{"t":"pairing","h":"${b64u(bytes(31, 5))}","ttl":5}`,
        'MALFORMED',
      ],
      ['pairing without a ttl', `{"t":"pairing","h":"${A}"}`, 'MALFORMED'],
      ['a zero ttl', `{"t":"pairing","h":"${A}","ttl":0}`, 'MALFORMED'],
      ['a negative ttl', `{"t":"pairing","h":"${A}","ttl":-1}`, 'MALFORMED'],
      ['a ttl past the pairing window', `{"t":"pairing","h":"${A}","ttl":601}`, 'MALFORMED'],
      ['a fractional ttl', `{"t":"pairing","h":"${A}","ttl":1.5}`, 'MALFORMED'],
      ['a string ttl', `{"t":"pairing","h":"${A}","ttl":"5"}`, 'MALFORMED'],
      ['an infinite ttl', `{"t":"pairing","h":"${A}","ttl":1e400}`, 'MALFORMED'],
    ];
    for (const [name, input, code] of cases) {
      expect([name, codeOfSync(() => decodeHostCommand(input))]).toEqual([name, code]);
    }
  });
});
