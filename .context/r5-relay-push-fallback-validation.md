# Relay push answer transport boundary

The legacy push-answer resolver must retain the connection's transport mode.
For relay-v2 sessions, a connection URL names the relay Worker; it is never a
direct daemon `/answer` endpoint. An absent or stripped native capsule must
therefore leave the question unanswered through this legacy event path
(#1200, #1201; ADR 0034).

At `e8adf2ee`, the actual App/browser fixture paired through the source Hub and
real SQLite Worker, attached a source child and opened a real held HTTP hook.
After the actual relay socket disconnected, an existing `OPT_*` event reached
`resolvePushAnswerTarget` and then `relayAnswerDirect`. The Worker received a
plaintext `/answer` POST containing the supplied session id, question id and
selected option, plus the App's actual local Claude session binding. With the
relay still connected, the same event resolved the real hook through the legacy
answer path, bypassing the native capsule owner. Both named assertions failed
on Bun 1.4.2 and 1.3.11. The direct-session control passed one actual POST and
held-hook deny.

`087351c4` makes the resolver require `ConnectionState.mode` and refuse a known
non-direct session before live delivery or stored-route fallback. It also
refuses a cold stored URL that names a known non-direct connection and borrows
only direct reconnect attempts. The App already persists session routes and
native direct routes only for direct connections; the actual browser tests
also verify that relay sessions populate neither direct URL store.

The actual three-case browser baseline and restored controls passed 3 tests /
19 assertions on both runtimes. Removing only the primary transport-mode guard
reproduced both named relay failures while the real direct control still
passed. The resolver's direct and transport-boundary tests passed 24 / 24 on
both. Four project type graphs, changed-file formatting, spelling and diff
checks passed. Independent receipt:
`/private/tmp/remi-r5-stripped-carrier-c6ifz6s_/final-receipt.json`.

The test controls the existing OS event boundary and uses the actual App,
encrypted channel, source Hub, Worker, child and held hook. It does not measure
a signed-device callback or deployment. Fresh combined-checkpoint validation,
shipping browser registration, native R6 transport and the original R7 gates
remain separate. The relay remains off by default.
