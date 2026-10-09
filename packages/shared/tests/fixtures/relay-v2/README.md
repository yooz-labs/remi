# Relay v2 oracle

`vectors.json` is copied unchanged from the reviewed relay epic at
`8fb5b88b` (`feature/issue-1195-epic-relay`). SHA-256:
`d64d48636c97f4ac4064b46bc08f39a1b7c16181d1d224ba7790dececbd21084`.

Native X2 (#1242) reads this canonical file directly. It is the same oracle the
TypeScript implementation uses, not a separate set of Swift examples. The
values derive from public deterministic test labels and contain no real keys.

This checkpoint ports the foreground client handshake, admission, pairing
token and counter channel. Sealed push, native background answers and their
oracles remain on the relay epic and are not implemented by this checkpoint.
