# ADR 0002: Model B — hold the PermissionRequest hook; APNS-only question delivery

**Status:** accepted; amended by ADR 0030 (2026-10-01)
**Date:** 2026-06-19
**Owner:** Yahya

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
`.context/notification-and-session-flow.md` (needs a refresh to this model).
