# ADR 0019: Push kinds are named on the wire; muting them is deliberately asymmetric

**Status:** accepted
**Date:** 2026-08-01
**Owner:** Yahya

## Context

Before #968, every push class POSTed the same shape to the signaling Worker's
`/push`. Turn-complete and a subagent alert were both literally
`{token, title, body}` — indistinguishable on the wire — and the only way a
consumer could recognize a question push was a *negative* test ("no
`questionId`, no `category`"). The in-app "Notifications" toggle
(`settings.notifications`) was written by the settings panel and read by
nothing; even wired up, a client-side mute cannot work at all, because the
push path is daemon → signaling Worker → APNS and never consults the client.

#968 added an explicit `kind` field and per-device `pushPrefs`. That
immediately raised a second question the issue called out by name: not every
`kind` should be mutable the same way.

## Decision

`PushKind` is a closed four-value set: `question`, `turn_complete`,
`subagent_alert`, `dismiss`. `wantsPush()` (`push-preferences.ts`) is a
`switch` over all four with no `default`, so a fifth kind is a compile error
until an author makes an explicit call. Two of the four are hardcoded to
return `true` unconditionally, never derived from stored preferences:

- **`dismiss`** — a quiet `content-available` push that clears an
  already-delivered lock-screen card. Filtering it would strand that card on
  the lock screen of the very device that asked for less noise.
- **`subagent_alert`** — already has a user-facing control: it fires only on
  the patterns the user put in `auto_approve.subagent_alert`. A second mute
  would be redundant with a control the user already owns.

The third load-bearing rule lives at the fan-out, not in `wantsPush` itself:
in `NotificationDispatcher.computeDelivery`, the `tokensWanting(..., 'question')`
filter is applied **above** the no-channel check, and an all-muted fan-out
with no attached client resolves to `'no_channel'`, never `'pushed'`
(`notification-dispatcher.ts:342-361`). `awaitDelivery` is what a held hook
polls to decide whether to keep Claude blocked; reporting `'pushed'` for a
fan-out of zero devices would block the hook on a card that will never render
anywhere.

## Consequences

Easier: adding a `PushKind` forces the same binary choice #968 had to make by
hand — mutable or not — at compile time, in one place, rather than as an
implicit default that could silently land on either side.

Harder, and the reason this ADR exists: **the asymmetry looks like an
inconsistency to a reader who has not seen the mechanism it protects, and
invites a "cleanup" that makes all four kinds go through the same
`pushPrefs` check for symmetry.** That change compiles, passes review on
looks, and reopens two different bugs at once — a stranded lock-screen card
for `dismiss`, and a `pushed` outcome reported for a delivery nobody will
ever see for `question`/`turn_complete` once every device happens to be
muted. Any change that adds a `default` branch to `wantsPush`'s switch, or
moves the `tokensWanting` filter below the client/no-channel check in
`computeDelivery`, should be read as reopening this, not simplifying it.

## Alternatives considered

- **Single global "Notifications" toggle (status quo before #968).** Rejected:
  it was already dead code client-side, and even wired up could not express
  "keep turn-complete, mute questions" or the reverse — the exact field
  report that opened #968.
- **Filter `dismiss` like every other kind.** Rejected: it fails the one case
  it exists for — clearing a card on a muted device that is still holding one
  delivered before the mute.
- **Gate `subagent_alert` on `pushPrefs` too.** Rejected as a redundant
  control on top of the pattern list the user already edits for the same
  purpose.

## Receipts

- `packages/daemon/src/notifications/push-preferences.ts` — `PushKind`
  (imported from `push-client.ts`), `wantsPush`, `DEFAULT_PUSH_PREFERENCES`,
  `sanitizePushPreferences`
- `packages/daemon/src/notifications/notification-dispatcher.ts:342-361` —
  the `tokensWanting`/no-channel ordering and its own comment on why the
  placement is load-bearing for a held escalation
- `packages/daemon/tests/notifications/notification-dispatcher.test.ts` —
  `'every device muted + no client attached reports no_channel, not pushed'`,
  `'dismiss still reaches a device that muted BOTH classes'`
- `packages/daemon/tests/notifications/push-preferences.test.ts`
- #968 (issue, the push-class table + proposal), PR #969 (`kind` field +
  per-device toggles)
