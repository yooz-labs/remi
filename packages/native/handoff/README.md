# Handoff: the native apps (start here)

You design and build remi's native SwiftUI apps: a Mac app that works like Conductor and an iPhone app.
The epic is #1239.

## Read first

1. [../AGENTS.md](../AGENTS.md): the rules for this package (platform, protocol, security, tests, git).
2. The root [AGENTS.md](../../../AGENTS.md), at least "Verify before you describe" and "Question Detection and Notifications".
3. [../DESIGN.md](../DESIGN.md): the product and the design rules both apps share.
4. The two tracks: [mac.md](mac.md) (the Mac app and RemiKit's core) and [ios.md](ios.md) (the iPhone app and RemiUI, the design system).

## Where the code is

- `packages/native/Remi.xcodeproj` on `develop`: one project with two app targets, `RemiMac` and `RemiPhone`, and a scheme for each.
- `packages/native/RemiKit`: a local Swift package with two libraries, `RemiKit` (not screens) and `RemiUI` (the design system), and its tests.
- The skeleton builds and its tests pass: each app is a placeholder window with an empty asset catalog (app icon and accent color), RemiUI holds placeholder spacing and radius tokens, and RemiKit's tests read the real protocol fixtures (every fixture has a message type; `question` and `session_list_response` decode into models) and decode a session with no name.

## How to work

- **Branches:** one per milestone, off `develop`, named `feature/issue-<number>-<short-name>`. Pull requests go into `develop`.
- **Worktrees are your choice.** To run the two tracks at the same time, create a worktree for each next to the repository (`../remi-worktrees/agents/` from its root), run `bun install` once in each, and remove it when its branch is merged.
- **One agent, both tracks:** take the milestones in this order, since each one feeds the next:
  1. iPhone M1a, the tokens and the shared components in RemiUI;
  2. Mac M1, the three-column window and its sheets on those components;
  3. iPhone M1b, the iPhone screens;
  4. Mac M2, RemiKit's core (#1241);
  5. Mac M3 and iPhone M2, both apps live;
  6. iPhone M3, notifications and parity with the Capacitor app.
- **Each pull request:** the gates in [../AGENTS.md](../AGENTS.md#tests-and-gates) pass, it says what was verified and how, and a design milestone includes screenshots of the previews for the owner's review.
