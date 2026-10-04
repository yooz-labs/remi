#!/usr/bin/env python3
"""Independent verifier for the remi relay protocol v2 test vectors.

Written from ADR 0034 alone (section numbers below refer to it), as a second
implementation of the wire protocol.  It recomputes every value in the vector
file from the recorded inputs, runs every negative case through its own
implementation of the checks, and exits non-zero if anything disagrees.

Run from the repository root:

    uv run --with cryptography python scripts/verify-relay-v2-vectors.py

Only the `cryptography` package and the standard library are used.
Python 3.9 or newer.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import math
import re
import sys
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from cryptography.exceptions import InvalidSignature, InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

VECTORS_PATH = (
    Path(__file__).resolve().parent.parent
    / "packages/shared/tests/fixtures/relay-v2/vectors.json"
)

# ---------------------------------------------------------------------------
# Constants (section 2)
# ---------------------------------------------------------------------------

V = 2
RID_LEN = 16
MODES = {"pair": 0x01, "resume": 0x02}
DIR_C2H, DIR_H2C = 0x01, 0x02
TYPE_AUTH, TYPE_READY, TYPE_DATA, TYPE_BYE = 0x01, 0x02, 0x03, 0x04
MAX_COUNTER = 2**40
MAX_PLAINTEXT = 524288
BYE_FRAME = 1 + 8 + 16
MIN_FRAME = 1 + 8 + 1 + 16
MAX_FRAME = 1 + 8 + MAX_PLAINTEXT + 16
MAX_CONTROL_TEXT = 512
MAX_DEVICE_NAME = 64
HANDSHAKE_TIMEOUT_MS = 30000
PAIR_CONFIRM_TIMEOUT_MS = 120000
PAIRING_TTL_SECONDS = 600
PAIRING_SKEW_SECONDS = 60
MAX_PUSH_PLAINTEXT = 2048
CLOSE_CODE, CLOSE_REASON = 4400, "closed"

TAG_LEN = 16
POINT_LEN = 65
TOKEN_PREFIX = "remi-pair2:"
TOKEN_FIXED_LEN = 1 + 1 + 8 + 32 + 32
RELAY_URL_PATTERN = re.compile(
    r"(wss://[a-z0-9.-]+|ws://(localhost|127\.0\.0\.1))"
    r"(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?"
)
B64U_ALPHABET = frozenset(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
)


class RelayError(Exception):
    """A protocol failure carrying one of the section 8 error codes."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code


# ---------------------------------------------------------------------------
# Encodings (section 2)
# ---------------------------------------------------------------------------


def be16(n: int) -> bytes:
    return n.to_bytes(2, "big")


def be64(n: int) -> bytes:
    return n.to_bytes(8, "big")


def lp(x: bytes) -> bytes:
    if len(x) > 0xFFFF:
        raise ValueError("lp is defined for at most 65535 bytes")
    return be16(len(x)) + x


def lps(*parts: bytes) -> bytes:
    return b"".join(lp(p) for p in parts)


def b64u(x: bytes) -> str:
    return base64.urlsafe_b64encode(x).decode("ascii").rstrip("=")


def b64u_decode(text: str) -> bytes:
    """Strict base64url: alphabet only, no length of 1 mod 4, canonical."""
    if not set(text) <= B64U_ALPHABET or len(text) % 4 == 1:
        raise ValueError("not base64url")
    raw = base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    if b64u(raw) != text:
        raise ValueError("not canonical base64url")
    return raw


def sha256(data: bytes) -> bytes:
    return hashlib.sha256(data).digest()


# ---------------------------------------------------------------------------
# Primitives (section 1)
# ---------------------------------------------------------------------------


def ed25519_public(seed: bytes) -> bytes:
    key = Ed25519PrivateKey.from_private_bytes(seed).public_key()
    return key.public_bytes(Encoding.Raw, PublicFormat.Raw)


def ed25519_sign(seed: bytes, message: bytes) -> bytes:
    return Ed25519PrivateKey.from_private_bytes(seed).sign(message)


def ed25519_verify(public_key: bytes, signature: bytes, message: bytes) -> bool:
    try:
        Ed25519PublicKey.from_public_bytes(public_key).verify(signature, message)
    except (InvalidSignature, ValueError):
        return False
    return True


def p256_private(scalar: bytes) -> ec.EllipticCurvePrivateKey:
    return ec.derive_private_key(int.from_bytes(scalar, "big"), ec.SECP256R1())


def p256_public(scalar: bytes) -> bytes:
    key = p256_private(scalar).public_key()
    return key.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)


def p256_import(raw: bytes) -> ec.EllipticCurvePublicKey:
    """Accept only a valid uncompressed SEC1 point; anything else is MALFORMED."""
    # The library would also import a 33-byte compressed point, so the shape
    # (65 bytes, prefix 0x04) is checked here before the on-curve check.
    if len(raw) != POINT_LEN or raw[0] != 0x04:
        raise RelayError("MALFORMED", "not an uncompressed P-256 point")
    try:
        return ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), raw)
    except ValueError as exc:
        raise RelayError("MALFORMED", "point is not on the curve") from exc


def ecdh(scalar: bytes, peer_public: bytes) -> bytes:
    """The shared secret is the 32-byte X coordinate."""
    return p256_private(scalar).exchange(ec.ECDH(), p256_import(peer_public))


def hkdf(ikm: bytes, salt: bytes, info: bytes) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=salt, info=info).derive(ikm)


# ---------------------------------------------------------------------------
# Identities, transcript and key schedule (sections 3, 6.2, 9)
# ---------------------------------------------------------------------------


def room_id(machine_public_key: bytes) -> bytes:
    return sha256(machine_public_key)[:RID_LEN]


def transcript_h1(
    rid: bytes, mode: int, e_c: bytes, n_c: bytes, e_h: bytes, n_h: bytes
) -> bytes:
    fields = (rid, bytes([V]), bytes([mode]), e_c, n_c, e_h, n_h)
    return sha256(lps(b"remi-relay-v2 H1", *fields))


def host_signing_input(h1: bytes) -> bytes:
    return lps(b"remi-relay-v2 host", h1)


def transcript_h2(h1: bytes, sig_h: bytes, device_pk: bytes, name: bytes) -> bytes:
    return sha256(lps(b"remi-relay-v2 H2", h1, sig_h, device_pk, name))


def client_signing_input(h2: bytes) -> bytes:
    return lps(b"remi-relay-v2 client", h2)


@dataclass(frozen=True)
class SessionKeys:
    c2h: bytes
    h2c: bytes


def derive_session_keys(z: bytes, psk: bytes | None, h1: bytes) -> SessionKeys:
    """HKDF Extract with salt H1 over Z || psk (empty psk in resume mode)."""
    ikm = z + (psk or b"")
    return SessionKeys(
        c2h=hkdf(ikm, h1, b"remi-relay-v2 c2h"),
        h2c=hkdf(ikm, h1, b"remi-relay-v2 h2c"),
    )


def fingerprint(device_pk: bytes, machine_pk: bytes) -> str:
    digest = sha256(lps(b"remi-relay-v2 fingerprint", device_pk, machine_pk))
    hex16 = digest[:8].hex()
    return "-".join(hex16[i : i + 4] for i in range(0, 16, 4))


# ---------------------------------------------------------------------------
# Control frames (section 6.1)
# ---------------------------------------------------------------------------

# kind -> ordered (json key, allowed decoded lengths); None marks the mode string.
CONTROL_LAYOUT: dict[str, tuple] = {
    "hello": (("m", None), ("e", range(65, 66)), ("n", range(32, 33))),
    "hello_ack": (("e", range(65, 66)), ("n", range(32, 33)), ("s", range(64, 65))),
    "auth": (("c", range(112, 177)),),
    "ready": (("c", range(17, 18)),),
}
POINT_KEYS = {"hello": ("e",), "hello_ack": ("e",)}


def encode_control(kind: str, **values: Any) -> str:
    """The canonical compact JSON text of a control frame."""
    members = [f'"v":{V}', f'"t":"{kind}"']
    for key, _ in CONTROL_LAYOUT[kind]:
        value = values[key]
        text = value if isinstance(value, str) else b64u(value)
        members.append(f'"{key}":"{text}"')
    return "{" + ",".join(members) + "}"


def _reject_json_constant(name: str) -> Any:
    raise ValueError(f"JSON constant {name} is not allowed")


def decode_control(text: Any, expected: str) -> dict[str, Any]:
    """The strict decoder of section 6.1; stops at the first failing step."""
    if isinstance(text, bytes):
        raise RelayError("TYPE", "binary frame where text is expected")
    if len(text.encode("utf-8")) > MAX_CONTROL_TEXT:  # step 1
        raise RelayError("OVERSIZE", "control text too long")
    try:  # step 2
        # Every number is read as an IEEE 754 double, as JSON.parse does; the ADR
        # does not say which numeric domain "an integer" is judged in.
        obj = json.loads(text, parse_constant=_reject_json_constant, parse_int=float)
    except ValueError as exc:
        raise RelayError("MALFORMED", "not JSON") from exc
    # An integer is a JSON number with an integer value (so 3.0 counts, true does not).
    version = obj.get("v") if isinstance(obj, dict) else None
    is_integer = isinstance(version, float) and math.isfinite(version)
    if not is_integer or version != int(version):
        raise RelayError("MALFORMED", "not an object with an integer v")
    if version != V:  # step 3
        raise RelayError("VERSION", f"v is {version}")
    if obj.get("t") != expected:  # step 4
        raise RelayError("TYPE", f"t is {obj.get('t')!r}, expected {expected!r}")
    mode = obj.get("m")
    if expected == "hello" and not (isinstance(mode, str) and mode in MODES):  # step 5
        raise RelayError("MODE", f"m is {mode!r}")
    layout = CONTROL_LAYOUT[expected]  # step 6
    if set(obj) != {"v", "t", *(key for key, _ in layout)}:
        raise RelayError("MALFORMED", "wrong key set")
    decoded: dict[str, Any] = {}
    for key, lengths in layout:
        value = obj[key]
        if not isinstance(value, str):
            raise RelayError("MALFORMED", f"{key} is not a string")
        if lengths is None:
            decoded[key] = value
            continue
        try:
            raw = b64u_decode(value)
        except ValueError as exc:
            raise RelayError("MALFORMED", f"{key} is not canonical base64url") from exc
        if len(raw) not in lengths:
            raise RelayError("MALFORMED", f"{key} has {len(raw)} bytes")
        decoded[key] = raw
    if encode_control(expected, **decoded) != text:  # step 7
        raise RelayError("MALFORMED", "text is not the canonical form")
    for key in POINT_KEYS.get(expected, ()):  # E_c and E_h must be points
        p256_import(decoded[key])
    return decoded


# ---------------------------------------------------------------------------
# AEAD frames (section 7)
# ---------------------------------------------------------------------------


def frame_nonce(counter: int) -> bytes:
    return b"\x00" * 4 + be64(counter)


def frame_aad(frame_type: int, direction: int, counter: int) -> bytes:
    return b"remi-relay-v2" + bytes([V, frame_type, direction]) + be64(counter)


def seal_frame(
    key: bytes, frame_type: int, direction: int, counter: int, plaintext: bytes
) -> bytes:
    aad = frame_aad(frame_type, direction, counter)
    return AESGCM(key).encrypt(frame_nonce(counter), plaintext, aad)


def open_frame(
    key: bytes, frame_type: int, direction: int, counter: int, sealed: bytes
) -> bytes:
    aad = frame_aad(frame_type, direction, counter)
    try:
        return AESGCM(key).decrypt(frame_nonce(counter), sealed, aad)
    except InvalidTag as exc:
        raise RelayError("DECRYPT", "tag does not verify") from exc


def encode_frame(
    key: bytes, frame_type: int, sender_direction: int, counter: int, plaintext: bytes
) -> bytes:
    """A binary frame: data carries plaintext, a BYE carries none (the tag alone)."""
    sealed = seal_frame(key, frame_type, sender_direction, counter, plaintext)
    return bytes([frame_type]) + be64(counter) + sealed


def parse_frame_header(frame: bytes) -> tuple[int, int]:
    """Checks 2 to 6 of section 7; returns (type, counter)."""
    if len(frame) < BYE_FRAME:  # check 2
        raise RelayError("MALFORMED", "frame shorter than 25 bytes")
    if len(frame) > MAX_FRAME:  # check 3
        raise RelayError("OVERSIZE", "frame longer than MAX_FRAME")
    frame_type = frame[0]
    if frame_type not in (TYPE_DATA, TYPE_BYE):  # check 4
        raise RelayError("TYPE", f"first byte is {frame_type:#04x}")
    if frame_type == TYPE_BYE:  # check 5
        if len(frame) != BYE_FRAME:
            raise RelayError("MALFORMED", "a BYE is exactly 25 bytes")
    elif len(frame) < MIN_FRAME:
        raise RelayError("MALFORMED", "data frame shorter than 26 bytes")
    counter = int.from_bytes(frame[1:9], "big")
    if counter > MAX_COUNTER:  # check 6
        raise RelayError("COUNTER_LIMIT", f"counter {counter} above the limit")
    return frame_type, counter


class DataReceiver:
    """One direction of the data channel, as seen by its receiver."""

    def __init__(self, key: bytes, sender_direction: int, last: int = 0) -> None:
        self.key = key
        self.sender_direction = sender_direction
        self.last = last
        self.closed = False
        self.ended = False

    def receive(self, frame: Any) -> bytes | None:
        """The delivered plaintext of a data frame, or None for a BYE (end marker)."""
        if self.closed:
            raise RelayError("CLOSED", "channel already failed")
        try:
            frame_type, counter, plaintext = self._open(frame)
        except RelayError:
            self.closed = True
            raise
        self.last = counter  # check 10
        if frame_type == TYPE_BYE:
            self.ended = True
            return None
        return plaintext

    def _open(self, frame: Any) -> tuple[int, int, bytes]:
        if isinstance(frame, str):  # check 1
            raise RelayError("TYPE", "text frame on the data channel")
        frame_type, counter = parse_frame_header(frame)  # checks 2 to 6
        if self.ended:  # check 7
            raise RelayError("ENDED", "frame after the peer's BYE")
        if counter != self.last + 1:  # check 8
            raise RelayError("COUNTER", f"got {counter}, expected {self.last + 1}")
        plaintext = open_frame(  # check 9
            self.key, frame_type, self.sender_direction, counter, frame[9:]
        )
        return frame_type, counter, plaintext

    def stream_verdict(self) -> str:
        """How the inbound stream ended if the transport closed now (section 7)."""
        if self.closed:
            return "failed"
        return "clean" if self.ended else "unclean"


# ---------------------------------------------------------------------------
# Handshake steps (section 6.3)
# ---------------------------------------------------------------------------


def client_verify_hello_ack(machine_pk: bytes, hello_text: str, ack_text: str) -> bytes:
    """Client step 3: rebuild H1 from the client's own values and verify sig_h."""
    hello = decode_control(hello_text, "hello")
    ack = decode_control(ack_text, "hello_ack")
    h1 = transcript_h1(
        room_id(machine_pk),
        MODES[hello["m"]],
        hello["e"],
        hello["n"],
        ack["e"],
        ack["n"],
    )
    if not ed25519_verify(machine_pk, ack["s"], host_signing_input(h1)):
        raise RelayError("BAD_SIGNATURE", "sig_h does not verify")
    return h1


def host_open_auth(auth_text: str, z: bytes, h1: bytes, psk: bytes | None) -> bytes:
    """Host step 5, first half: open `auth` under k_c2h (one offer's secret)."""
    keys = derive_session_keys(z, psk, h1)
    ciphertext = decode_control(auth_text, "auth")["c"]
    try:
        return open_frame(keys.c2h, TYPE_AUTH, DIR_C2H, 0, ciphertext)
    except RelayError as exc:
        if psk is not None:
            raise RelayError("PAIRING", "no offer secret opens auth") from exc
        raise


def check_device_name(name: bytes) -> None:
    if len(name) > MAX_DEVICE_NAME:
        raise RelayError("NAME", "longer than 64 bytes")
    try:
        text = name.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise RelayError("NAME", "not UTF-8") from exc
    if any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in text):
        raise RelayError("NAME", "control character")


def host_check_auth(
    plaintext: bytes, h1: bytes, sig_h: bytes, mode: str, enrolled: list[bytes]
) -> bytes:
    """Host step 5, second half: name, sig_c over H2, enrollment; returns D_pk."""
    device_pk, sig_c, name = plaintext[:32], plaintext[32:96], plaintext[96:]
    check_device_name(name)
    h2 = transcript_h2(h1, sig_h, device_pk, name)
    if not ed25519_verify(device_pk, sig_c, client_signing_input(h2)):
        raise RelayError("BAD_SIGNATURE", "sig_c does not verify")
    if mode == "resume" and device_pk not in enrolled:
        raise RelayError("UNKNOWN_DEVICE", "device key is not enrolled")
    return device_pk


def client_open_ready(
    ready_text: str, z: bytes, h1: bytes, psk: bytes | None, mode: str
) -> None:
    """Client step 6: open `ready` under k_h2c and require the mode echo."""
    keys = derive_session_keys(z, psk, h1)
    ciphertext = decode_control(ready_text, "ready")["c"]
    plaintext = open_frame(keys.h2c, TYPE_READY, DIR_H2C, 0, ciphertext)
    if plaintext != bytes([MODES[mode]]):
        raise RelayError("MODE_MISMATCH", f"ready echoes {plaintext.hex()}")


# ---------------------------------------------------------------------------
# Admission (section 4)
# ---------------------------------------------------------------------------


def admission_input(role: str, rid: bytes, nonce: bytes) -> bytes:
    return lps(f"remi-relay-v2 admit {role}".encode("ascii"), rid, nonce)


def admission_ticket(psk: bytes) -> bytes:
    return hmac.new(psk, b"remi-relay-v2 admit", hashlib.sha256).digest()


def verify_admission(
    role: str, public_key: bytes, rid: bytes, nonce: bytes, signature: bytes
) -> bool:
    """The Worker's check; a host additionally has to hash to the room id."""
    if len(rid) != RID_LEN or len(nonce) != 32:
        return False
    if role == "host" and room_id(public_key) != rid:
        return False
    return ed25519_verify(public_key, signature, admission_input(role, rid, nonce))


# ---------------------------------------------------------------------------
# Pairing token (section 5)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PairingToken:
    relay_url: str
    machine_public_key: bytes
    secret: bytes
    expires_at: int
    seal_public_key: bytes | None


def encode_token(token: PairingToken) -> str:
    flags = 0x01 if token.seal_public_key is not None else 0x00
    raw = (
        bytes([0x02, flags])
        + be64(token.expires_at)
        + token.machine_public_key
        + token.secret
        + (token.seal_public_key or b"")
        + token.relay_url.encode("utf-8")
    )
    return TOKEN_PREFIX + b64u(raw)


def decode_token(text: str, now_sec: int) -> PairingToken:
    """Section 5's decoder; the checks run in the order the ADR lists them."""
    if not text.startswith(TOKEN_PREFIX):
        raise RelayError("TOKEN", "missing prefix")
    try:
        raw = b64u_decode(text[len(TOKEN_PREFIX) :])
    except ValueError as exc:
        raise RelayError("TOKEN", "payload is not canonical base64url") from exc
    if len(raw) < TOKEN_FIXED_LEN:
        raise RelayError("TOKEN", "shorter than the fixed part")
    if raw[0] != 2:
        raise RelayError("TOKEN", f"token_version {raw[0]}")
    if raw[1] & 0xFE:
        raise RelayError("TOKEN", "reserved flag bit set")
    has_seal_key = bool(raw[1] & 0x01)
    url_offset = TOKEN_FIXED_LEN + (POINT_LEN if has_seal_key else 0)
    url_bytes = raw[url_offset:]
    if not 1 <= len(url_bytes) <= 512:
        raise RelayError("TOKEN", "relay_url length outside 1 to 512")
    try:
        relay_url = url_bytes.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise RelayError("TOKEN", "relay_url is not UTF-8") from exc
    # fullmatch, not match with a trailing `$`: Python's `$` also accepts a final "\n".
    if not RELAY_URL_PATTERN.fullmatch(relay_url):
        raise RelayError("TOKEN", "relay_url does not match the policy")
    expires_at = int.from_bytes(raw[2:10], "big")
    if expires_at <= now_sec:
        raise RelayError("EXPIRED", "token expired")
    if expires_at > now_sec + PAIRING_TTL_SECONDS + PAIRING_SKEW_SECONDS:
        raise RelayError("TOKEN", "expiry beyond the policy")
    seal_key = raw[TOKEN_FIXED_LEN:url_offset] if has_seal_key else None
    if seal_key is not None:
        try:
            p256_import(seal_key)
        except RelayError as exc:
            raise RelayError("TOKEN", "seal key is not a valid point") from exc
    return PairingToken(relay_url, raw[10:42], raw[42:74], expires_at, seal_key)


# ---------------------------------------------------------------------------
# Sealing a body to a device (section 10)
# ---------------------------------------------------------------------------


def seal_key_for(
    shared: bytes, ephemeral_public: bytes, recipient_public: bytes
) -> bytes:
    info = lps(b"remi-relay-v2 seal", recipient_public)
    return hkdf(shared, ephemeral_public, info)


def seal_body(
    recipient_public: bytes,
    ephemeral_scalar: bytes,
    nonce: bytes,
    aad: bytes,
    plaintext: bytes,
) -> bytes:
    ephemeral_public = p256_public(ephemeral_scalar)
    shared = ecdh(ephemeral_scalar, recipient_public)
    key = seal_key_for(shared, ephemeral_public, recipient_public)
    return ephemeral_public + nonce + AESGCM(key).encrypt(nonce, plaintext, aad)


def open_sealed(recipient_scalar: bytes, aad: bytes, sealed: bytes) -> bytes:
    low = POINT_LEN + 12 + TAG_LEN + 1
    high = POINT_LEN + 12 + TAG_LEN + MAX_PUSH_PLAINTEXT
    if not low <= len(sealed) <= high:
        raise RelayError("DECRYPT", "sealed value has an impossible length")
    ephemeral_public = sealed[:POINT_LEN]
    nonce = sealed[POINT_LEN : POINT_LEN + 12]
    try:
        shared = ecdh(recipient_scalar, ephemeral_public)
    except RelayError as exc:
        raise RelayError("DECRYPT", "ephemeral key does not import") from exc
    key = seal_key_for(shared, ephemeral_public, p256_public(recipient_scalar))
    try:
        return AESGCM(key).decrypt(nonce, sealed[POINT_LEN + 12 :], aad)
    except InvalidTag as exc:
        raise RelayError("DECRYPT", "tag does not verify") from exc


# ---------------------------------------------------------------------------
# Bookkeeping for the checks
# ---------------------------------------------------------------------------


class Tally:
    """Counts passed checks per group and collects failures."""

    def __init__(self) -> None:
        self.passed: Counter = Counter()
        self.failures: list[str] = []

    def group(self, name: str) -> Group:
        return Group(self, name)


class Group:
    """The checks of one section of the vector file."""

    def __init__(self, tally: Tally, name: str) -> None:
        self.tally = tally
        self.name = name

    def ok(self, label: str, condition: bool, detail: str = "") -> None:
        if condition:
            self.tally.passed[self.name] += 1
        else:
            self.tally.failures.append(f"FAIL [{self.name}] {label}: {detail}")

    def same(self, label: str, actual: Any, recorded: Any) -> None:
        shown = actual.hex() if isinstance(actual, bytes) else actual
        self.ok(label, shown == recorded, f"computed {shown!r}, recorded {recorded!r}")

    def accepts(self, label: str, step: Callable[[], Any]) -> Any:
        """Run a step that must succeed; a RelayError is recorded as a failure."""
        try:
            result = step()
        except RelayError as exc:
            self.ok(label, False, f"rejected with {exc.code}: {exc}")
            return None
        self.ok(label, True)
        return result


def unhex(value: str | None) -> bytes | None:
    return None if value is None else bytes.fromhex(value)


# ---------------------------------------------------------------------------
# Positive sections: recompute everything from the inputs
# ---------------------------------------------------------------------------


def verify_constants(g: Group, constants: dict[str, Any]) -> None:
    expected = {
        "v": V,
        "maxCounter": MAX_COUNTER,
        "maxPlaintext": MAX_PLAINTEXT,
        "maxFrame": MAX_FRAME,
        "minFrame": MIN_FRAME,
        "maxControlText": MAX_CONTROL_TEXT,
        "maxDeviceName": MAX_DEVICE_NAME,
        "handshakeTimeoutMs": HANDSHAKE_TIMEOUT_MS,
        "pairConfirmTimeoutMs": PAIR_CONFIRM_TIMEOUT_MS,
        "pairingTtlSeconds": PAIRING_TTL_SECONDS,
        "pairingSkewSeconds": PAIRING_SKEW_SECONDS,
        "maxPushPlaintext": MAX_PUSH_PLAINTEXT,
        "closeCode": CLOSE_CODE,
        "closeReason": CLOSE_REASON,
    }
    for name, value in expected.items():
        g.same(name, value, constants[name])
    g.ok(
        "no other constants",
        set(constants) == set(expected),
        str(set(constants) ^ set(expected)),
    )
    # The file carries neither BYE_FRAME nor the type bytes; tie the ADR-only
    # BYE_FRAME to the frame sizes the file does carry.
    g.same("minFrame is BYE_FRAME plus one byte", constants["minFrame"], BYE_FRAME + 1)
    g.same(
        "maxFrame is maxPlaintext plus BYE_FRAME",
        constants["maxFrame"],
        constants["maxPlaintext"] + BYE_FRAME,
    )
    # Where the ADR's table gives both a formula and its value, check both.
    stated = (
        ("BYE_FRAME", BYE_FRAME, 25),
        ("MIN_FRAME", MIN_FRAME, 26),
        ("MAX_FRAME", MAX_FRAME, 524313),
        ("MAX_COUNTER", MAX_COUNTER, 1099511627776),
        ("TYPE_AUTH", TYPE_AUTH, 1),
        ("TYPE_READY", TYPE_READY, 2),
        ("TYPE_DATA", TYPE_DATA, 3),
        ("TYPE_BYE", TYPE_BYE, 4),
    )
    for name, formula, value in stated:
        g.same(f"{name} is {value} in the ADR table", formula, value)


def verify_identities(g: Group, vectors: dict[str, Any]) -> bytes:
    for name, identity in vectors["identities"].items():
        public = ed25519_public(bytes.fromhex(identity["seed"]))
        g.same(f"{name} public key", public, identity["publicKey"])
    rid = room_id(bytes.fromhex(vectors["identities"]["machine"]["publicKey"]))
    g.same("rid", rid, vectors["rid"])
    g.same("ridDerivation", rid, vectors["ridDerivation"])
    return rid


def verify_session(
    g: Group, vec: dict[str, Any], identities: dict[str, Any], rid: bytes
) -> None:
    mode = vec["mode"]
    machine_seed = bytes.fromhex(identities["machine"]["seed"])
    machine_pk = bytes.fromhex(identities["machine"]["publicKey"])
    device_seed = bytes.fromhex(identities["device"]["seed"])
    device_pk = bytes.fromhex(identities["device"]["publicKey"])
    psk = unhex(vec["psk"])
    name = vec["deviceName"].encode("utf-8")
    c_scalar = bytes.fromhex(vec["clientEphemeral"]["scalar"])
    h_scalar = bytes.fromhex(vec["hostEphemeral"]["scalar"])
    n_c, n_h = bytes.fromhex(vec["clientNonce"]), bytes.fromhex(vec["hostNonce"])

    e_c, e_h = p256_public(c_scalar), p256_public(h_scalar)
    g.same("client ephemeral public key", e_c, vec["clientEphemeral"]["publicKey"])
    g.same("host ephemeral public key", e_h, vec["hostEphemeral"]["publicKey"])
    g.same("hello", encode_control("hello", m=mode, e=e_c, n=n_c), vec["hello"])

    h1 = transcript_h1(rid, MODES[mode], e_c, n_c, e_h, n_h)
    g.same("h1", h1, vec["h1"])
    g.same("hostSigningInput", host_signing_input(h1), vec["hostSigningInput"])
    sig_h = ed25519_sign(machine_seed, host_signing_input(h1))
    # Section 16: compare bytes (OpenSSL signs deterministically) and verify.
    g.same("hostSignature", sig_h, vec["hostSignature"])
    g.ok(
        "recorded hostSignature verifies",
        ed25519_verify(
            machine_pk, bytes.fromhex(vec["hostSignature"]), host_signing_input(h1)
        ),
    )
    g.same(
        "helloAck", encode_control("hello_ack", e=e_h, n=n_h, s=sig_h), vec["helloAck"]
    )

    z = ecdh(c_scalar, e_h)
    g.same("z from the client side", z, vec["z"])
    g.same("z from the host side", ecdh(h_scalar, e_c), vec["z"])
    keys = derive_session_keys(z, psk, h1)
    g.same("keys.c2h", keys.c2h, vec["keys"]["c2h"])
    g.same("keys.h2c", keys.h2c, vec["keys"]["h2c"])

    h2 = transcript_h2(h1, sig_h, device_pk, name)
    g.same("h2", h2, vec["h2"])
    g.same("clientSigningInput", client_signing_input(h2), vec["clientSigningInput"])
    sig_c = ed25519_sign(device_seed, client_signing_input(h2))
    g.same("clientSignature", sig_c, vec["clientSignature"])
    g.ok(
        "recorded clientSignature verifies",
        ed25519_verify(
            device_pk, bytes.fromhex(vec["clientSignature"]), client_signing_input(h2)
        ),
    )

    auth_plaintext = device_pk + sig_c + name
    auth_ciphertext = seal_frame(keys.c2h, TYPE_AUTH, DIR_C2H, 0, auth_plaintext)
    g.same("authPlaintext", auth_plaintext, vec["authPlaintext"])
    g.same("authNonce", frame_nonce(0), vec["authNonce"])
    g.same("authAad", frame_aad(TYPE_AUTH, DIR_C2H, 0), vec["authAad"])
    g.same("authCiphertext", auth_ciphertext, vec["authCiphertext"])
    g.same("auth", encode_control("auth", c=auth_ciphertext), vec["auth"])

    ready_plaintext = bytes([MODES[mode]])
    ready_ciphertext = seal_frame(keys.h2c, TYPE_READY, DIR_H2C, 0, ready_plaintext)
    g.same("readyPlaintext", ready_plaintext, vec["readyPlaintext"])
    g.same("readyNonce", frame_nonce(0), vec["readyNonce"])
    g.same("readyAad", frame_aad(TYPE_READY, DIR_H2C, 0), vec["readyAad"])
    g.same("readyCiphertext", ready_ciphertext, vec["readyCiphertext"])
    g.same("ready", encode_control("ready", c=ready_ciphertext), vec["ready"])
    g.same("fingerprint", fingerprint(device_pk, machine_pk), vec["fingerprint"])

    # The recorded control frames must also flow through the receiving roles.
    verified_h1 = g.accepts(
        "client accepts the recorded hello_ack",
        lambda: client_verify_hello_ack(machine_pk, vec["hello"], vec["helloAck"]),
    )
    g.same("client's H1 from the recorded frames", verified_h1, vec["h1"])
    opened = g.accepts(
        "host opens the recorded auth",
        lambda: host_open_auth(vec["auth"], z, h1, psk),
    )
    g.same("recorded auth plaintext", opened, vec["authPlaintext"])
    accepted_device = g.accepts(
        "host accepts the recorded auth",
        lambda: host_check_auth(opened or b"", h1, sig_h, mode, [device_pk]),
    )
    g.same("enrolled device key", accepted_device, identities["device"]["publicKey"])
    g.accepts(
        "client accepts the recorded ready",
        lambda: client_open_ready(vec["ready"], z, h1, psk, mode),
    )

    verify_data_frames(g, vec["data"], vec["bye"], keys)


def verify_data_frames(
    g: Group, data: dict[str, Any], bye: dict[str, Any], keys: SessionKeys
) -> None:
    g.ok("bye has exactly c2h and h2c", set(bye) == {"c2h", "h2c"}, str(sorted(bye)))
    for label, direction, key in (
        ("c2h", DIR_C2H, keys.c2h),
        ("h2c", DIR_H2C, keys.h2c),
    ):
        receiver = DataReceiver(key, direction)
        g.ok(f"data.{label} has ten frames", len(data[label]) == 10)
        for entry in data[label]:
            counter = entry["counter"]
            plaintext = bytes.fromhex(entry["plaintext"])
            where = f"data.{label}[{counter}]"
            g.same(f"{where} nonce", frame_nonce(counter), entry["nonce"])
            g.same(
                f"{where} aad", frame_aad(TYPE_DATA, direction, counter), entry["aad"]
            )
            frame = encode_frame(key, TYPE_DATA, direction, counter, plaintext)
            g.same(f"{where} frame", frame, entry["frame"])
            received = g.accepts(
                f"{where} accepted by the receiver",
                lambda entry=entry: receiver.receive(bytes.fromhex(entry["frame"])),
            )
            g.same(f"{where} opens to its plaintext", received, entry["plaintext"])
        verify_stream_end(g, label, direction, key, data[label], bye[label], receiver)


def verify_stream_end(
    g: Group,
    label: str,
    direction: int,
    key: bytes,
    data: list[dict[str, Any]],
    entry: dict[str, Any],
    receiver: DataReceiver,
) -> None:
    """The recorded BYE of one direction, and what its absence or forgery means."""
    where = f"bye.{label}"
    g.ok(f"{where} fields", set(entry) == {"counter", "nonce", "aad", "frame"})
    counter = entry["counter"]
    g.same(f"{where} counter follows the data frames", receiver.last + 1, counter)
    g.same(f"{where} nonce", frame_nonce(counter), entry["nonce"])
    g.same(f"{where} aad", frame_aad(TYPE_BYE, direction, counter), entry["aad"])
    frame = encode_frame(key, TYPE_BYE, direction, counter, b"")
    g.same(f"{where} frame", frame, entry["frame"])
    g.same(f"{where} frame is BYE_FRAME bytes", len(frame), BYE_FRAME)
    g.accepts(
        f"{where} accepted by the receiver",
        lambda: receiver.receive(bytes.fromhex(entry["frame"])),
    )
    g.same(f"{where} ends the stream cleanly", receiver.stream_verdict(), "clean")

    frames = [bytes.fromhex(item["frame"]) for item in data]
    forged = frame[:-1] + bytes([frame[-1] ^ 0x01])
    scenarios = (
        ("the BYE dropped", frames, "unclean"),
        ("the tail and the BYE dropped", frames[:7], "unclean"),
        ("a BYE with a flipped tag bit", frames + [forged], "failed"),
    )
    for name, stream, verdict in scenarios:
        replay = DataReceiver(key, direction)
        for item in stream:
            attempt(lambda item=item, replay=replay: replay.receive(item))
        g.same(f"{where} {name} is {verdict}", replay.stream_verdict(), verdict)


def verify_admission_section(g: Group, vectors: dict[str, Any], rid: bytes) -> None:
    adm, identities = vectors["admission"], vectors["identities"]
    nonce = bytes.fromhex(adm["nonce"])
    for role, who in (("host", "machine"), ("client", "device")):
        message = admission_input(role, rid, nonce)
        g.same(f"{role} input", message, adm[f"{role}Input"])
        signature = ed25519_sign(bytes.fromhex(identities[who]["seed"]), message)
        g.same(f"{role} signature", signature, adm[f"{role}Signature"])
        public = bytes.fromhex(identities[who]["publicKey"])
        recorded = bytes.fromhex(adm[f"{role}Signature"])
        g.ok(
            f"recorded {role} proof passes the Worker check",
            verify_admission(role, public, rid, nonce, recorded),
        )
    ticket = admission_ticket(bytes.fromhex(adm["pairingSecret"]))
    g.same("ticket", ticket, adm["ticket"])
    g.same("ticketHash", sha256(ticket), adm["ticketHash"])


def verify_token_section(g: Group, vectors: dict[str, Any]) -> None:
    section = vectors["pairingToken"]
    machine_pk = vectors["identities"]["machine"]["publicKey"]
    for variant in ("noSealKey", "withSealKey"):
        rec = section[variant]
        token = PairingToken(
            rec["relayUrl"],
            bytes.fromhex(rec["machinePublicKey"]),
            bytes.fromhex(rec["secret"]),
            rec["expiresAtSec"],
            unhex(rec["sealPublicKey"]),
        )
        g.same(f"{variant} text", encode_token(token), rec["text"])
        decoded = decode_token(rec["text"], section["nowSec"])
        g.ok(f"{variant} decodes to its fields", decoded == token)
        g.same(f"{variant} names the machine key", token.machine_public_key, machine_pk)


def verify_seal_section(g: Group, vectors: dict[str, Any]) -> None:
    rec = vectors["seal"]
    recipient_scalar = bytes.fromhex(rec["recipientScalar"])
    recipient_public = p256_public(recipient_scalar)
    g.same("recipient public key", recipient_public, rec["recipientPublicKey"])
    aad = bytes.fromhex(rec["rid"]) + rec["questionId"].encode("utf-8")
    g.same("aad", aad, rec["aad"])
    sealed = seal_body(
        recipient_public,
        bytes.fromhex(rec["ephemeralScalar"]),
        bytes.fromhex(rec["nonce"]),
        aad,
        bytes.fromhex(rec["plaintext"]),
    )
    g.same("sealed", sealed, rec["sealed"])
    opened = open_sealed(recipient_scalar, aad, bytes.fromhex(rec["sealed"]))
    g.same("sealed opens to its plaintext", opened, rec["plaintext"])


# ---------------------------------------------------------------------------
# Negative cases (section 16)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Outcome:
    """What the implementation did with a case: an error code, or None if accepted.

    Codes that start with "VERIFIER:" report a broken precondition of the case
    itself and can never equal a protocol error code.
    """

    code: str | None
    accepted: int | None = None


def attempt(fn: Callable[[], object]) -> Outcome:
    try:
        fn()
    except RelayError as exc:
        return Outcome(exc.code)
    return Outcome(None)


def case_control_decode(case: dict[str, Any]) -> Outcome:
    return attempt(lambda: decode_control(case["text"], case["frame"]))


def case_ec_point(case: dict[str, Any]) -> Outcome:
    return attempt(lambda: p256_import(bytes.fromhex(case["publicKey"])))


def case_hello_ack_verify(case: dict[str, Any]) -> Outcome:
    machine_pk = bytes.fromhex(case["machinePublicKey"])
    return attempt(
        lambda: client_verify_hello_ack(
            machine_pk, case["clientHello"], case["helloAck"]
        )
    )


def case_auth_open(case: dict[str, Any]) -> Outcome:
    z, h1, psk = bytes.fromhex(case["z"]), bytes.fromhex(case["h1"]), unhex(case["psk"])
    if "senderPsk" in case:  # the same auth must open under the sender's secret
        sender_psk = unhex(case["senderPsk"])
        sender = attempt(lambda: host_open_auth(case["auth"], z, h1, sender_psk))
        if sender.code is not None:
            return Outcome(f"VERIFIER: senderPsk does not open auth ({sender.code})")
    return attempt(lambda: host_open_auth(case["auth"], z, h1, psk))


def case_auth_check(case: dict[str, Any]) -> Outcome:
    z, h1, psk = bytes.fromhex(case["z"]), bytes.fromhex(case["h1"]), unhex(case["psk"])
    sig_h = bytes.fromhex(case["hostSignature"])
    enrolled = [bytes.fromhex(key) for key in case["enrolled"]]

    def run() -> None:
        plaintext = host_open_auth(case["auth"], z, h1, psk)
        host_check_auth(plaintext, h1, sig_h, case["mode"], enrolled)

    return attempt(run)


def case_ready_open(case: dict[str, Any]) -> Outcome:
    z, h1, psk = bytes.fromhex(case["z"]), bytes.fromhex(case["h1"]), unhex(case["psk"])
    return attempt(lambda: client_open_ready(case["ready"], z, h1, psk, case["mode"]))


def case_data_sequence(case: dict[str, Any]) -> Outcome:
    key = bytes.fromhex(case["key"])
    receiver = DataReceiver(key, case["direction"], case["startRecv"] - 1)
    frames = [bytes.fromhex(frame_hex) for frame_hex in case["frames"]]
    accepted = 0
    for index, frame in enumerate(frames):
        failure = attempt(lambda frame=frame: receiver.receive(frame))
        if failure.code is None:
            accepted += 1
            continue
        # Section 7: after the first failure every later receive is CLOSED, even
        # a frame that would have been valid; the file records no code for them.
        for later in frames[index:]:
            again = attempt(lambda later=later: receiver.receive(later))
            if again.code != "CLOSED":
                return Outcome(
                    f"VERIFIER: channel not closed for good ({again.code})", accepted
                )
        return Outcome(failure.code, accepted)
    return Outcome(None, accepted)


def case_frame_length(case: dict[str, Any]) -> Outcome:
    """A frame of `length` bytes of the given type, counter 1: checks 1 to 6 only."""
    header = bytes([case["type"]]) + be64(1)
    frame = header.ljust(case["length"], b"\x00")[: case["length"]]
    return attempt(lambda: parse_frame_header(frame))


def case_token_decode(case: dict[str, Any]) -> Outcome:
    return attempt(lambda: decode_token(case["text"], case["nowSec"]))


def case_seal_open(case: dict[str, Any]) -> Outcome:
    scalar = bytes.fromhex(case["recipientScalar"])
    aad, sealed = bytes.fromhex(case["aad"]), bytes.fromhex(case["sealed"])
    return attempt(lambda: open_sealed(scalar, aad, sealed))


def case_admission_verify(case: dict[str, Any]) -> Outcome:
    verdict = verify_admission(
        case["role"],
        bytes.fromhex(case["publicKey"]),
        bytes.fromhex(case["rid"]),
        bytes.fromhex(case["nonce"]),
        bytes.fromhex(case["signature"]),
    )
    return Outcome(None if verdict else "ADMISSION_REJECTED")


CASE_HANDLERS: dict[str, Callable[[dict[str, Any]], Outcome]] = {
    "control_decode": case_control_decode,
    "ec_point": case_ec_point,
    "hello_ack_verify": case_hello_ack_verify,
    "auth_open": case_auth_open,
    "auth_check": case_auth_check,
    "ready_open": case_ready_open,
    "data_sequence": case_data_sequence,
    "frame_length": case_frame_length,
    "token_decode": case_token_decode,
    "seal_open": case_seal_open,
    "admission_verify": case_admission_verify,
}


# The fields section 16 lists for each kind, besides kind, name, expect and code.
# `accepted` is required for every data_sequence case ("for accept or a rejection").
CASE_FIELDS: dict[str, tuple[frozenset, frozenset]] = {
    "control_decode": (frozenset({"frame", "text"}), frozenset()),
    "ec_point": (frozenset({"publicKey"}), frozenset()),
    "hello_ack_verify": (
        frozenset({"session", "machinePublicKey", "clientHello", "helloAck"}),
        frozenset(),
    ),
    "auth_open": (
        frozenset({"session", "z", "h1", "psk", "auth"}),
        frozenset({"senderPsk"}),
    ),
    "auth_check": (
        frozenset(
            {"session", "mode", "z", "h1", "psk", "hostSignature", "auth", "enrolled"}
        ),
        frozenset(),
    ),
    "ready_open": (
        frozenset({"session", "mode", "z", "h1", "psk", "ready"}),
        frozenset(),
    ),
    "data_sequence": (
        frozenset({"key", "direction", "startRecv", "frames", "accepted"}),
        frozenset(),
    ),
    "frame_length": (frozenset({"type", "length"}), frozenset()),
    "token_decode": (frozenset({"text", "nowSec"}), frozenset()),
    "seal_open": (frozenset({"recipientScalar", "aad", "sealed"}), frozenset()),
    "admission_verify": (
        frozenset({"role", "publicKey", "rid", "nonce", "signature"}),
        frozenset(),
    ),
}


def shape_problem(case: dict[str, Any]) -> str | None:
    """Describe a case whose fields differ from section 16's list, or return None."""
    required, optional = CASE_FIELDS[case["kind"]]
    common = {"kind", "name", "expect", "code"}
    missing = sorted((required | {"name", "expect"}) - set(case))
    unknown = sorted(set(case) - required - optional - common)
    if missing or unknown:
        return f"missing fields {missing}, unlisted fields {unknown}"
    return None


def judge_case(case: dict[str, Any], outcome: Outcome) -> str | None:
    """Describe the disagreement between a case and an outcome, or return None."""
    if case["expect"] not in ("accept", "reject"):
        return f"expect is {case['expect']!r}"
    if case["expect"] == "accept":
        if outcome.code is not None:
            return f"expected accept, implementation rejected with {outcome.code}"
    else:
        if outcome.code is None:
            return "expected reject, implementation accepted"
        # Section 16: every rejecting case has a code, except admission_verify.
        if "code" not in case and case["kind"] != "admission_verify":
            return "a rejecting case has no code"
        if "code" in case and outcome.code != case["code"]:
            return (
                f"expected code {case['code']}, implementation reported {outcome.code}"
            )
    if "accepted" in case and outcome.accepted != case["accepted"]:
        return (
            f"expected {case['accepted']} frames accepted, "
            f"implementation accepted {outcome.accepted}"
        )
    return None


def verify_negative_cases(tally: Tally, cases: list[dict[str, Any]]) -> None:
    for case in cases:
        group = tally.group(f"negative.{case['kind']}")
        if case["kind"] not in CASE_HANDLERS:
            group.ok(case["name"], False, "no handler for this kind of case")
            continue
        problem = shape_problem(case)
        if problem is None:
            problem = judge_case(case, CASE_HANDLERS[case["kind"]](case))
        group.ok(case["name"], problem is None, problem or "")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def run_all(vectors: dict[str, Any]) -> Tally:
    tally = Tally()
    header = tally.group("header")
    header.ok("format is 1", vectors["format"] == 1)
    header.ok("protocol name", vectors["protocol"] == "remi-relay-v2")
    verify_constants(tally.group("constants"), vectors["constants"])
    rid = verify_identities(tally.group("identities"), vectors)
    for mode in ("pair", "resume"):
        group = tally.group(f"sessions.{mode}")
        verify_session(group, vectors["sessions"][mode], vectors["identities"], rid)
    verify_admission_section(tally.group("admission"), vectors, rid)
    verify_token_section(tally.group("pairingToken"), vectors)
    verify_seal_section(tally.group("seal"), vectors)
    verify_negative_cases(tally, vectors["negative"])
    return tally


def main() -> int:
    vectors = json.loads(VECTORS_PATH.read_text(encoding="utf-8"))
    tally = run_all(vectors)
    for group in sorted(tally.passed):
        print(f"{group:30} {tally.passed[group]:4} passed")
    for failure in tally.failures:
        print(failure)
    if tally.failures:
        print(f"FAILED: {len(tally.failures)} check(s)")
        return 1
    print(f"ALL OK ({sum(tally.passed.values())} checks)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
