# Relay v2 oracle

`vectors.json` is copied unchanged from the reviewed relay epic at
`8fb5b88b` (`feature/issue-1195-epic-relay`). SHA-256:
`d64d48636c97f4ac4064b46bc08f39a1b7c16181d1d224ba7790dececbd21084`.

Native X2 (#1242) reads this canonical file directly. It is the same oracle the
TypeScript implementation uses, not a separate set of Swift examples. The
values derive from public deterministic test labels and contain no real keys.

The next X2 checkpoint also imports these reviewed files unchanged from the
contract composite `1e96c688` (which retains relay base `8fb5b88b`):

| File | SHA-256 |
| --- | --- |
| `push-vectors.json` | `490c83162d2c8f122d5a79931ac327807da4a6d8b53c4bcc907358e2898fa5c4` |
| `native-answer-vectors.json` | `35a1994241edfda8affb43e56e6a4942e439d46c0821fbc0fb1281a2f41a12d3` |

Importing an oracle does not establish a production caller or device acceptance.
The native implementation receipt in `docs/native-relay-x2.md` names the cases
and runtime gates that were actually exercised.
