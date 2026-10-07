# Handoff: the iPhone app (Codex, iPhone agent)

You design and build remi's native iPhone app, and you own RemiUI, the design system both apps use.
Another agent builds the Mac app at the same time and owns RemiKit's core (protocol, identity, connection, store); read [../AGENTS.md](../AGENTS.md) for the rules you share, and [../DESIGN.md](../DESIGN.md) for the product.

- **Issue:** #1244 (the iPhone app), under the epic #1239.
- **Branch:** `feature/issue-1244-native-ios`.
- **Worktree:** `../remi-worktrees/native-ios`. Open `packages/native/Remi.xcodeproj` there.
- **Pull requests** go into `feature/issue-1239-epic-native`.

## What you own

- `packages/native/iPhone/`: the `RemiPhone` target.
- `packages/native/RemiKit/Sources/RemiUI/`:
  - tokens (`Theme.swift`);
  - the shared components (question card, session row, machine row, transcript entries, composer);
  - preview data.

The Mac agent uses RemiUI too. Publish components early and keep their APIs small, so both apps look like one product.

## Milestones

**M1: design system and design pass, with preview data only.**
- [ ] **Tokens** in `Theme.swift`: color (semantic, one accent for "needs you"), type, spacing, radius and motion, documented in `DESIGN.md`.
- [ ] **The question card**, every variant:
  - binary;
  - with a "for this session" grant;
  - multi-choice;
  - AskUserQuestion;
  - plan approval;
  - terminal-only;
  - with detail.

  Every state: pending, sending, answered, resolved elsewhere, stale.
- [ ] **The other components:** session row, machine row (reachability, transport, waiting for approval), transcript entries, composer (with the `PROMPT_WAITING` explanation).
- [ ] **Preview data from the golden fixtures.** Copy the fixtures you need into a RemiUI resource folder, and add a test that each copy is byte-identical to its original in `packages/shared/tests/fixtures/protocol/`, so the copies cannot drift.
- [ ] **iPhone screens:** home (sessions by machine, cards on top), the session, pairing (the steps to run on the machine), empty and first-run states.
- **Done when** every component and screen has previews in light and dark mode and at the largest Dynamic Type size, and the owner has reviewed screenshots in the PR.

**M2: live, on RemiKit.**
- [ ] **Use RemiKit's connection and store** as the Mac agent lands them (#1241); until then, keep building against the preview data.
- [ ] **Answer cards by their meaning.** The rules are in the root AGENTS.md: a held card through the hook; nothing typed for a `terminalOnly` card; a card with `detail` only in the app.
- [ ] **Reach a machine:** the iPhone simulator reaches a hub on `127.0.0.1`. A real device needs the machine's `daemon.bind` set and its approval (#873), so show the steps.
- **Done when** the owner answers a real card from the simulator against a hub started from source.

**M3: notifications and parity with the Capacitor app.**
- [ ] **Local notifications for cards** while the app runs.
- [ ] **Remote push and the Notification Service Extension** are later work: secure push and lock-screen answers need X2 (#1242) and the owner's signing. Design their screens now, but don't build their plumbing.
- [ ] **A parity checklist** in the PR:
  - what the Capacitor app does today (`packages/web/ios/App` and `packages/web/src`);
  - what the native app does;
  - what is left.

  The Capacitor app retires when that list is empty (owner decision).
- **Done when** the checklist shows parity, except the items that wait on X2.

## Out of scope for now

- **Relay v2, secure push, and signed lock-screen answers:** X2 (#1242), not until the owner starts it.
- **The Capacitor app** in `packages/web/ios/App`: read it, do not change it.
- **The daemon and the protocol:** propose changes on the protocol-freeze issues (#1234 to #1238).
