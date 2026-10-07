# ADR 0002: Model B — hold the PermissionRequest hook; APNS-only question delivery

**Status:** accepted; amended by ADR 0030 (2026-10-01) and ADR 0031 (2026-10-02)
**Date:** 2026-06-19
**Owner:** Yahya

> **Amended 2026-10-02 by [ADR 0031](0031-held-hook-answers-with-native-dialog-visible.md).**
> The hold is back for every binary prompt the phone can answer, and it does not hide Claude's dialog: verified against Claude Code 2.1.287, the dialog renders about 0.1 s after the hook POST, during the hold, and a later hook answer resolves it.
> So the first answer wins: the phone's through the hook response, the terminal's directly in the dialog (a Yes is seen as the paired `PostToolUse`, a No or Esc as Claude closing the held request).
> remi releases its own hold at `[prompts] hold_seconds` with an empty response, which decides nothing.
> "Always" answers echo only `setMode` and session-scoped `addRules`; nothing is typed into the PTY for a binary prompt.
> The "Consequences" paragraph below about Claude not rendering while held is superseded by this.

> **Amended 2026-10-01 by [ADR 0030](0030-defer-permission-judgment-to-the-harness.md).**
> Holding is not in effect after #1125: holds were only enabled when an auto-approve service existed, and that service is deleted, so every `PermissionRequest` is answered `passthrough` at once and Claude's own dialog renders in the terminal.
> Phone answers are relayed by typing into that dialog, guarded by the exact-label screen check of #1134 (PR #1136; a refusal means answer at the terminal), until #1126 reintroduces holds with Claude's native dialog still visible.
> The model below is kept as the design #1126 builds on, not a description of what ships today.

## Context

The original flow parsed PTY output for permission prompts and injected
keystrokes to answer. It raced the terminal, missed prompts, and could inject
stale answers. Meanwhile lock-screen answers need to work when the app is
suspended, which local notifications cannot do.

## Decision

Hold the `PermissionRequest` hook open (Model B): the hook response IS the
answer channel. Questions are delivered as WebSocket `question` (in-app) plus
APNS push (lock screen) — never local notifications. Answering a held hook
with an echoed `permission_suggestions` entry is equivalent to picking that
option in the dialog.

## Consequences

Answers resolve synchronously through the hook — no PTY injection for the
main flow (the multichoice "pick" path keeps a narrow injection helper).
Delivery robustness becomes load-bearing: BadDeviceToken pruning, token
persistence across disconnects, dedup of the three answer routes (#752), and
honest fallback option sets when Claude offers no structured suggestions.
PTY parsing survives only as fallback and render-detection.

## Alternatives considered

- **PTY parse + inject (status quo ante):** lost to races and stale-answer
  injection (bug family #28/#382/#384/#537/#551/#560).
- **Local notifications for questions:** cannot act from a suspended app;
  rejected.

## Receipts

Epics #571 (0.6.13), #603, #624; hook docs at code.claude.com/docs/en/hooks.
Detail formerly in `.context/epic-notifications-rethink.md`,
`epic-notification-robustness-refactor.md`, `phase2-hold-cancel-spec.md`,
`native-lockscreen-answer-relay.md` (pruned 2026-07-10). Flow diagram:
`.context/archive/2026-h2/notification-and-session-flow.md` (needs a refresh to this model).
