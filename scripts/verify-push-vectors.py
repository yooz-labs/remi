#!/usr/bin/env python3
"""Independent R5 tuple/signature/ECIES fixture verifier using cryptography + stdlib.

All recorded seeds and scalars are PUBLIC synthetic test inputs. No runtime files
are read. JSON producer order is fixed; verifier preserves each original payload.
Run: uv run --with cryptography python scripts/verify-push-vectors.py
"""
import base64
import hashlib
import json
import struct
from pathlib import Path

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat


def raw(s):
    return base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))


def b64(b):
    return base64.urlsafe_b64encode(b).decode().rstrip('=')


def lp(*fields):
    fields = [s.encode() if isinstance(s, str) else s for s in fields]
    return b''.join(struct.pack('>H', len(s)) + s for s in fields)


def num(n):
    assert 0 <= n <= 2**53 - 1
    return struct.pack('>Q', n)


def digest(b):
    return hashlib.sha256(b).digest()


def no_duplicates(pairs):
    result = {}
    for key, value in pairs:
        assert key not in result, 'duplicate decoded JSON member'
        result[key] = value
    return result


fixture = json.loads((Path(__file__).resolve().parent.parent /
                      'packages/shared/tests/fixtures/relay-v2/push-vectors.json').read_text())
machine = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(fixture['machineSeedHex']))
device = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(fixture['deviceSeedHex']))
mpk = machine.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
dpk = device.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
recipient = ec.derive_private_key(int(fixture['recipientScalarHex'], 16), ec.SECP256R1())
r = recipient.public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
kind_bytes = {'question': 1, 'turn_complete': 2, 'subagent_alert': 3,
              'harness_denied': 4, 'turn_failed': 5, 'dismiss': 6}
env_bytes = {'production': 1, 'sandbox': 2}
class_bytes = {'alert': 1, 'background': 2}
# What the Worker is shown (#1200): no event kind, key version, revision or push key.
submit_keys = {'v', 'audience', 'rid', 'machinePublicKey', 'devicePublicKey', 'token',
               'environment', 'collapseId', 'pushClass', 'nonce', 'issuedAt', 'expiresAt',
               'storeUntil', 'sealed', 'signature'}
for case in fixture['cases']:
    c = case['content']
    rid = digest(mpk)[:16]
    assert c['machinePublicKey'] == b64(mpk) and c['devicePublicKey'] == b64(dpk)
    assert c['pushPublicKey'] == b64(r) and c['rid'] == rid.hex()
    p = case['payloadUtf8'].encode()
    assert p.hex() == case['payloadHex']
    parsed = json.loads(p, object_pairs_hook=no_duplicates)
    body = lp(mpk, rid, dpk, r, num(c['keyVersion']), c['collapseId'], num(c['revision']),
              bytes([kind_bytes[c['kind']]]), raw(c['nonce']), num(c['issuedAt']),
              num(c['expiresAt']), p)
    content_input = lp('remi-relay-v2 push content', digest(body))
    assert content_input.hex() == case['contentInputHex']
    signature = machine.sign(content_input)
    assert b64(signature) == case['signature']
    machine.public_key().verify(signature, content_input)
    inner = lp(body, signature)
    assert inner.hex() == case['innerHex'] and len(inner) <= 2048
    eph = ec.derive_private_key(int(case['ephemeralScalarHex'], 16), ec.SECP256R1())
    e = eph.public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
    shared = eph.exchange(ec.ECDH(), recipient.public_key())
    key = HKDF(algorithm=hashes.SHA256(), length=32, salt=e,
               info=lp('remi-relay-v2 seal', r)).derive(shared)
    nonce = bytes.fromhex(case['sealNonceHex'])
    aad = rid + c['collapseId'].encode()
    sealed = e + nonce + AESGCM(key).encrypt(nonce, inner, aad)
    assert sealed.hex() == case['sealedHex']
    receiver_key = HKDF(algorithm=hashes.SHA256(), length=32, salt=e,
                        info=lp('remi-relay-v2 seal', r)).derive(recipient.exchange(ec.ECDH(), eph.public_key()))
    assert AESGCM(receiver_key).decrypt(nonce, sealed[77:], aad) == inner
    s = case['submit']
    assert json.loads(case['submitJson'], object_pairs_hook=no_duplicates) == s
    assert raw(s['sealed']) == sealed
    assert set(s) == submit_keys, 'submit exposes exactly the Worker-visible fields'
    assert s['pushClass'] == ('background' if c['kind'] == 'dismiss' else 'alert')
    assert s['rid'] == c['rid'] and s['collapseId'] == c['collapseId']
    # Acceptance window <= 60 s; APNs storage follows the content expiry (<= content TTL).
    assert 0 < s['expiresAt'] - s['issuedAt'] <= 60
    assert s['expiresAt'] <= s['storeUntil'] == c['expiresAt'] <= s['issuedAt'] + 3600
    assert s['machinePublicKey'] == c['machinePublicKey'] and s['devicePublicKey'] == c['devicePublicKey']
    submit_body = lp('POST', '/v2/push/' + s['rid'], s['audience'], mpk, rid, dpk,
                     bytes.fromhex(s['token']), bytes([env_bytes[s['environment']]]),
                     s['collapseId'], bytes([class_bytes[s['pushClass']]]),
                     raw(s['nonce']), num(s['issuedAt']), num(s['expiresAt']), num(s['storeUntil']),
                     digest(sealed))
    request_digest = digest(submit_body)
    submit_input = lp('remi-relay-v2 push submit', request_digest)
    assert submit_input.hex() == case['submitInputHex']
    assert request_digest.hex() == case['requestDigest']
    assert b64(machine.sign(submit_input)) == s['signature']
    machine.public_key().verify(raw(s['signature']), submit_input)
    try:
        machine.public_key().verify(signature, submit_input)
        raise AssertionError('cross-purpose signature accepted')
    except InvalidSignature:
        pass
    try:
        machine.public_key().verify(signature, lp('remi-relay-v2 push content', digest(body + b' ')))
        raise AssertionError('modified raw bytes accepted')
    except InvalidSignature:
        pass
    assert parsed['type'] == ('dismiss' if c['kind'] == 'dismiss' else
                              'question' if c['kind'] == 'question' and case['name'] != 'informational-question-no-authority' else 'informational')
assert len(fixture['cases']) == 10
print('10 independent push vectors: exact tuples, signatures, ECIES, raw JSON and cross-purpose refusal verified')
