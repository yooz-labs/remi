# Local Worker controls

These tests construct the real source Worker in workerd/Miniflare, with real HTTP,
WebSocket, cryptography and SQLite state. Provider destinations are owned fixtures;
this does not establish deployed Cloudflare or Apple acceptance.

Run `bun test packages/signaling/tests/e2e` from the repository root.
`E2E_BUNDLER=esbuild` selects the same bundler used by the hosted relay controls.
The supported Bun pins remain the test runner and daemon runtime.

Pinned push-audience controls also require a Node executable (20 or newer).
CI explicitly selects Node 24; local tests find `node` on PATH or the usual
Homebrew/system paths. `REMI_WORKER_TEST_NODE=/absolute/path/to/node` selects one.
Only the owned TCP test listener runs there, with a minimal environment and no
inherited provider variables or `NODE_OPTIONS`.
Bun 1.3.11's direct and relayed `net` half-close controls returned no response
with the controlled endpoints; the independent Node endpoint/control verifies
all 128 KiB through the owned Node listener, without changing Worker requests.

The listener remains bound while Miniflare starts its actual backend at port 0.
It forwards raw HTTP/WebSocket bytes and preserves the original Host header.
`PUSH_AUDIENCE` is configured to that held public origin before startup.
`TestWorker.restart()` keeps the listener while creating a fresh real Miniflare
instance with the same persistence directory. It returns a new wrapper; the old
wrapper cannot stop the new owner. The durable tests still prove that the nonce
and limiter state survive a runtime replacement.

`beforeRuntime` is an observational test barrier: a real competing listener must
receive `EADDRINUSE` there. It never replaces the Worker, provider result or
transport return value. Startup failure closes the held listener, and stop joins
both real runtimes/listeners. Source signatures, limits, audience validation,
assertions and CI deadlines are unchanged.
