# ADR 0019: Push kinds are named on the wire; muting them is deliberately asymmetric

**Status:** accepted; amended by ADR 0030 (2026-10-01), ADR 0031 (2026-10-02) and #1153 (2026-10-02)
**Date:** 2026-08-01
**Owner:** Yahya

> **Amended 2026-10-01 by [ADR 0030](0030-defer-permission-judgment-to-the-harness.md).**
> The decision stands; two of its supporting facts changed with #1125.
> The `subagent_alert` patterns now live in `[notifications] subagent_alert` (the old `auto_approve.subagent_alert` is read as a deprecated fallback).
> `awaitDelivery` and the held hook it fed were removed, so a muted fan-out reporting `no_channel` no longer gates a hook; it stays the honest outcome, and the asymmetry below still holds.

> **Amended 2026-10-02 by [ADR 0031](0031-held-hook-answers-with-native-dialog-visible.md).**
> `PushKind` has a fifth value, `harness_denied` (#1126): the informational notice for a call Claude Code's auto-mode classifier blocked (`PermissionDenied`).
> It is mutable per device (`pushPrefs.harnessDenied`, on by default), like `question` and `turn_complete`, so the closed-set `switch` below now has three mutable kinds and the same two unmutable ones (`subagent_alert`, `dismiss`).
> Its notices carry one collapse key per session, so a blocked retry loop replaces its notice instead of stacking.

> **Amended 2026-10-02 by #1153.**
> `PushKind` has a sixth value, `turn_failed`: the informational notice for a turn that ended on an API error (`StopFailure`: a usage or rate limit, authentication, and similar).
> It replaced a "Session stop failed (undefined). Retry?" card that nothing could answer, one more on every failed turn.
> It is mutable per device (`pushPrefs.turnFailed`, on by default), so the closed-set `switch` below now has four mutable kinds and the same two unmutable ones (`subagent_alert`, `dismiss`).
> A fifth, independent preference rather than a share of `turnComplete`: the machine-wide `notifications.on_turn_complete = false` and the per-device `turnComplete` mute silence only the "done" notice, because a failed turn is the one turn end a user must not miss by default (the agent is stopped until something is done).
> Its notices carry one collapse key per session (`turn-failed-<sessionId>`), so a usage limit that fails every following prompt keeps one notice on the lock screen.
> A fan-out where every device muted it resolves `no_channel`, as for a question.
> A later main-agent `Stop` or main-agent tool call (`PreToolUse`) sends a quiet `dismiss` on the same collapse key (only when a `turn_failed` push is outstanding), so a stale "Claude stopped" does not outlive the agent working again; like every `dismiss`, it is never filtered.
> Amended by #1226: a new prompt (`UserPromptSubmit`) no longer dismisses it, since at a usage limit that prompt fails too and the dismiss-then-alert cycle alerted the phone on every retry; and a failure alerts once per `turnFailureKey` (who failed, and why) until the notice is cleared.
> Privacy, unchanged and stated plainly: its text, including an excerpt of up to 140 characters of `last_assistant_message` (or a string `error_details`), goes in plaintext to the signaling Worker's `/push` and on to APNS, the same posture as `turn_complete`. Tracked by the relay and push privacy work (`.context/strategy-2026-10.md` section 9); the relay data channel has its own state (#543, #881).

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

`PushKind` is a closed six-value set: `question`, `turn_complete`,
`subagent_alert`, `harness_denied` (ADR 0031), `turn_failed` (#1153) and
`dismiss`. `wantsPush()` (`push-preferences.ts`) is a `switch` over all six
with no `default`, so a seventh kind is a compile error until an author makes
an explicit call. Four are mutable per device from stored preferences
(`question`, `turn_complete`, `harness_denied`, `turn_failed`); two are
hardcoded to return `true` unconditionally, never derived from stored
preferences:

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
invites a "cleanup" that makes all six kinds go through the same
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
