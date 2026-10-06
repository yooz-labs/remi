# Relay Worker v2: deploy runbook

For the owner. **No live deploy was done for this change, and no agent holds Cloudflare credentials.**
Nothing here has been run against a Cloudflare account; every command is the owner's to run, and the expected outputs are what the repository's tests and `wrangler`'s documentation lead one to expect, not observations of a deployed Worker.
What the Worker does is in [relay-worker-v2.md](relay-worker-v2.md).

The Worker is deployed by hand: there is no deploy workflow.
`wrangler` is pinned by `bun.lock` (4.58.0 at the time of writing); run it through the repository, never a global copy.

## Before you deploy

1. A fresh checkout of the commit you mean to ship, then:

   ```
   bun install --frozen-lockfile
   bun run typecheck:signaling
   bun test packages/signaling packages/shared/tests/relay
   ```

   The signaling suite starts the real Durable Object in workerd through Miniflare; it needs no account and no network after install.
   `E2E_BUNDLER=esbuild bun test packages/signaling/tests/e2e` runs it against an esbuild bundle (the bundler `wrangler` uses) instead of `Bun.build`.
   Never kill a test run with `SIGKILL`: `workerd` survives it.

2. Decide when.
   The deploy replaces the code behind the `ConnectionRoom` class.
   A pre-R2 room that is still alive at that moment (a code-named room lives five minutes at most) wakes up with the new code and is closed on its first message.
   No shipped client uses the relay (it is off by default since #1193), so nothing visible depends on it.

3. Note that `wrangler.toml` now has a `v4` migration that creates the `GlobalLimiter` class and a second binding, `LIMITER`.
   A migration cannot be undone by a rollback.

## Check the runtime first (ADR 0034 section 19)

The relay library's WebCrypto use has been checked on a local workerd (1.20260107.1), not on the deployed fleet.
Before the real Worker, run the committed check as a throwaway Worker on the deployed runtime and read its report.

```
mkdir -p "$TMPDIR/relay-check"
bun build scripts/relay-v2-engine-check/entry-worker.ts --target=browser --format=esm \
  --outfile="$TMPDIR/relay-check/worker.js"
bunx wrangler deploy "$TMPDIR/relay-check/worker.js" --name remi-engine-check \
  --compatibility-date 2026-01-01
curl -s https://remi-engine-check.<your-subdomain>.workers.dev/ | bun -e \
  'const r = await Bun.stdin.json(); const bad = r.results.filter((x) => x.group !== "scalar" && !x.ok); console.log(r.engine, "failures:", bad.length); process.exit(bad.length ? 1 : 0)'
bunx wrangler delete --name remi-engine-check
```

- The deploy needs your own `wrangler login` (or API token); that is yours to do and no agent does it.
- The check passes when no result outside the `scalar` group has `ok: false`.
  Record the report in the issue (#1197).
- Delete the throwaway Worker afterwards, as in the last line.
- `bunx wrangler deploy <script> --name ...` is `wrangler`'s documented form for a single-file Worker; confirm the flags with `bunx wrangler deploy --help` for the pinned version.

## Deploy

From `packages/signaling`:

```
bunx wrangler deploy
```

- The secrets are not in the repository: `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY` and `PUSH_SECRET` (`bunx wrangler secret put <NAME>`).
  Which of them the deployed Worker has is unknown from the repository.
  `PUSH_SECRET` is **required for sealed push**: `POST /v2/push/<rid>` checks `Authorization: Bearer <PUSH_SECRET>` before it reads anything else, and an unset or blank secret refuses every submit with `UNAUTHORIZED` (HTTP 401).
  The Worker trims the stored value, so a trailing newline from `echo` does no harm; set the same value as `--push-secret` / `REMI_PUSH_SECRET` on each daemon.
  A daemon with no push secret builds no secure push service and logs one line saying so.
- `PUSH_AUDIENCE` is a **required variable** for `POST /v2/push` and is not in `wrangler.toml` because there is no safe default: set it to the Worker's own canonical HTTPS origin, exactly the root the daemon's signaling URL names (no path, query, fragment or credentials), for example `PUSH_AUDIENCE = "https://<your-worker-host>"` in `[vars]`.
  The Worker never infers it from the request host.
  Without it every v2 push answers `WRONG_AUDIENCE`, and a deploy that skips this step silently breaks sealed push.
- `LEGACY_PUSH_ENABLED` controls the legacy plaintext `POST /push`.
  It is **on by default**: unset, empty or any value other than an explicit false (`false`, `0`, `no` or `off`, trimmed, any case) leaves it on, so a deployment that sets only `PUSH_SECRET` keeps working as before.
  It still requires the `PUSH_SECRET` bearer (compared in constant time); an unset or blank secret refuses every request.
  To turn it off now, set `LEGACY_PUSH_ENABLED = "false"` in `[vars]`.
- Optional limit variables (`src/limits.ts` documents each default): set one in `wrangler.toml` `[vars]`, for example `LIMIT_IP_CLIENT = "10"`.
  The push budgets (`PUSH_SEND_*`, `PUSH_ATTEMPT_*`, `PUSH_NONCES`) can only be lowered, never raised past their defaults.
  The defaults are unmeasured.

## Smoke test after deploy

Replace `<worker>` with the deployed host name.

```
curl -s https://<worker>/health
# {"status":"ok","timestamp":"..."}

curl -s -o /dev/null -w '%{http_code}\n' https://<worker>/connect/ABCD-2345
# 404: the code-named room is gone

curl -s -o /dev/null -w '%{http_code}\n' https://<worker>/v2/host/00000000000000000000000000000000
# 426: a route without a WebSocket upgrade

bun -e 'const ws = new WebSocket("wss://<worker>/v2/client/00000000000000000000000000000000");
ws.onmessage = (e) => { console.log(e.data); ws.close(); };
ws.onclose = (e) => console.log("closed", e.code);'
# {"t":"nonce","n":"<43 characters>"}, then the socket closes because the script closed it
```

The last command shows the Worker answers an upgrade with a nonce; it admits nothing.

Two checks of the push configuration (neither sends a notification):

```
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<worker>/v2/push/00000000000000000000000000000000
# 401: no bearer, refused before anything is read; 400 here would mean PUSH_SECRET is not enforced

curl -s -X POST -H "Authorization: Bearer $PUSH_SECRET" -d '{}' https://<worker>/v2/push/00000000000000000000000000000000
# {"v":2,...,"reason":"MALFORMED",...}: the bearer is accepted and the empty body is refused
```
A 429 on a repeat means a rate limit counted you (`LIMIT_IP_CLIENT` is 10 per minute per address by default).

## Retiring the legacy plaintext `POST /push` route

The route receives notification text, session ids and option labels in plaintext, so it is a stopgap: it stays only because app builds that registered no push key still depend on it (plan section 3.5, owner decision D).
It is on by default until the **R7 gate** (plan section 4) and is removed, not merely switched off, when every condition below holds.
Each one is checked by the owner; none is established by this repository's tests.

1. **R7 gate passed.**
   The full end-to-end suite and soak of plan section 4 passed, including a push decrypted by the Notification Service Extension on a real iPhone (plan section 6, gate 2).
2. **No legacy sender is left.**
   Every daemon in use sends sealed push (a push key registered, a `--push-secret` configured): Cloudflare's request analytics (or `bunx wrangler tail`) show no `POST /push` for a full release cycle, or the owner has stopped the last pre-R5 daemon.
   The Worker itself logs nothing.
3. **No app build still depends on it.**
   The oldest TestFlight and App Store build that registered no push key is past its support window, or the owner accepts that those users lose lock-screen notifications until they update.
4. **The default is flipped first.**
   Before deletion the daemon's `legacy_push_enabled` default and the Worker's default (`LEGACY_PUSH_ENABLED`) are changed to off in one release, and `LEGACY_PUSH_ENABLED = "false"` is deployed for one release cycle with no complaint.
5. **Then delete.**
   The route, `LEGACY_PUSH_ENABLED`, the per-isolate `RateLimiter` budgets for it and its tests are deleted, and this section and the legacy statements in [relay-worker-v2.md](relay-worker-v2.md) are removed in the same change.

Until then `LEGACY_PUSH_ENABLED = "false"` is the owner's switch for any deployment that wants it off today.

## Measurements to take (nothing here is measured)

- **Hibernation.**
  Under Miniflare the room is rebuilt after about eleven idle seconds while sockets stay open.
  The production threshold is unverified.
- **Alarm precision** and the alarm firing under load.
- **Billing.**
  Idle hibernating sockets, the edge `ping`/`pong`, and the single `GlobalLimiter` object (Cloudflare documents a soft limit of 1,000 requests per second per object).
  Watch the Durable Objects metrics for the first week.
- **Limits.**
  Every default in `src/limits.ts` is a guess at an abuse bound.
  Adjust them from what the first real clients show.
- **The WebSocket message ceiling.**
  Cloudflare documents 32 MiB for a received message since 2025-10-31; `MAX_FRAME` is 524,313 bytes.
  If you want it measured on the deployed runtime, relay one `MAX_FRAME` message with a real pair of endpoints once R3 and R4 exist.

## Rollback

- `bunx wrangler rollback` returns the code to the previous version.
  The previous version serves the old code-named routes again and does not know the `GlobalLimiter` class, which stays in the account unused; the `v4` migration is not undone.
- If the Worker misbehaves while no client uses the relay, the relay can simply stay off: it is off by default in the daemon.

## What agents never do

No agent runs `wrangler deploy`, `wrangler login`, `wrangler secret` or anything that contacts a Cloudflare account, and none reads or holds a Cloudflare or Apple credential.
The v2 relay protocol does not read or transmit the host harness's login credentials.
The Worker uses the owner's deployment secrets for its push routes: `PUSH_SECRET` as the bearer both require, and the APNS key material configured above to reach Apple.
