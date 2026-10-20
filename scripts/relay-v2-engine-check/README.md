# Relay v2 engine check

One check of the relay v2 library's WebCrypto use, runnable in any JavaScript engine that has `crypto.subtle`.
It is how ADR 0034 section 17 was established and how the R2 (Worker) and R4 (iPhone and Android client) gates close: run it on the target, read the result.

`check.ts` has no `node:` import and no Bun API.
It imports the library from `packages/shared/src/relay/internal.ts` and the committed vectors from `packages/shared/tests/fixtures/relay-v2/vectors.json`.
`run()` returns a report; the runners print it as a summary (or as JSON with `--json`) and exit 0 only if every required check passed.

## What it checks

| Group | Meaning | Required |
|---|---|---|
| `base` | Known answers of the primitives (RFC 5869, RFC 4231, SHA-256), the production key path (engine `generateKey`, PKCS8 export and import round trips, ECDH), and complete production handshakes in both modes with data and a BYE | yes |
| `jwk` | The committed vectors replayed through the shipping step functions: every ephemeral key is imported as a JWK with its public coordinates supplied, the signatures of the file are replayed and verified on this engine, and every negative and control case is run | yes |
| `scalar` | The same replay and a few known answers with keys built from a bare scalar or seed (the test-only `deterministic.ts` path) | no, informational |

The `scalar` group is informational because WebKit refuses a P-256 private key imported from PKCS8 without its public half, which is why production never does that.
The report also records Ed25519 measurements (is signing deterministic, does a non-canonical `S` verify, does a small-order public key verify): they are observations, not pass or fail.
Signatures are compared by verification, and byte for byte only on an engine whose signing is observed to be deterministic.

## Run it

All commands are from the repository root, after `bun install --frozen-lockfile`.

```
bun scripts/relay-v2-engine-check/run-bun.ts
bun scripts/relay-v2-engine-check/run-workerd.ts
bun scripts/relay-v2-engine-check/run-webkit.ts
```

- `run-bun.ts` runs it under Bun.
- `run-workerd.ts` bundles `entry-worker.ts`, loads it into workerd (the Cloudflare Workers runtime) through the `miniflare` that the lockfile pins (it ships with `wrangler` in `packages/signaling`), and fetches the report.
  No deployed Worker is contacted.
- `run-webkit.ts` (macOS and `swift` only) bundles `entry-page.ts`, loads it into a `WKWebView` of the system WebKit through `webkit-host.swift`, and prints the report with the WebKit and macOS versions.
  The temporary bundle directory is removed afterwards.

The packages/shared test suite also runs `run()` under Bun (`packages/shared/tests/relay/engine-check.test.ts`), including against corrupted vectors to prove the check can fail.

## Bundle it for another target

The runners bundle with `Bun.build`; the equivalent commands, for a target you load yourself, are:

```
bun build scripts/relay-v2-engine-check/entry-page.ts --target=browser --format=iife --outfile=/tmp/relay-v2-check/page.js
bun build scripts/relay-v2-engine-check/entry-worker.ts --target=browser --format=esm --outfile=/tmp/relay-v2-check/worker.js
```

`page.js` sets `globalThis.__run`, an async function that resolves to the report as JSON text.
`worker.js` is a Workers module whose `fetch` returns the report.

## Run it on an iPhone, a simulator or an Android WebView

Load `page.js` into a web view whose document is a secure context (`crypto.subtle` is absent otherwise), call `__run`, and read the JSON.
The report has `results` (each with `group`, `name`, `ok`), `measurements` and `engine`; the target passes when no result outside the `scalar` group has `ok: false`.

- iOS: a `WKWebView` with `page.js` added as a `WKUserScript` at document start, `loadHTMLString(_, baseURL: URL(string: "http://localhost/"))`, then `callAsyncJavaScript("return await globalThis.__run()", ...)`; `webkit-host.swift` is exactly that for macOS and can be copied into a small iOS app.
- Android: a `WebView` with `javaScriptEnabled`, the page served from a secure origin (for example through `WebViewAssetLoader` at `https://appassets.androidplatform.net/`), then `evaluateJavascript` on a call that stores `await __run()` in a variable you poll.

Neither the iPhone path nor the Android path has been run by the author; they are the owner's checks for R4 (ADR 0034 section 19).

## Android WebView and Ed25519

`generateIdentity`, `verifySignature` and the admission signing use WebCrypto Ed25519.
Chromium added it in version 137 (stated in the independent review of this phase from Chromium's release notes; not verified here), so an Android System WebView older than that throws and the relay is unusable on it: the library fails closed.
The minimum WebView version the design needs is therefore that of Ed25519 in `crypto.subtle`, unknown on any given device until this check runs on it.
