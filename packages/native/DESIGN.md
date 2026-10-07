# Design brief

What the native apps should feel like, and the rules both apps share.
Whether one agent builds both apps or two build them at once, this file is how they stay one product.
Change it in a commit of its own, and say so in the PR.

## The product in one line

"My agent needs me. Yes or No." Remi lets a person run many coding agents on their own machines and stay in control from a Mac or a phone.
The person is busy elsewhere; the app's job is to tell them what needs them, let them answer correctly in seconds, and otherwise stay out of the way.

## Principles

1. **Calm by default.** Most of the time nothing needs the person. The app shows state quietly, and saves color, motion and sound for the moment an agent needs them.
2. **The card is the heart.** A question card must be readable at a glance and impossible to answer wrongly. The person must always see what the answer does (allow once, allow for this session, deny), and which machine and session it belongs to.
3. **Honest.** Never show a control that cannot work: a `terminalOnly` card has no buttons. Never show a state the app does not know: no "connected" without a live socket. Never round a security state up: an unapproved device says it is waiting for approval and how to approve it.
4. **Native first.** Platform navigation, materials (Liquid Glass), SF Symbols, Dynamic Type, keyboard shortcuts on the Mac, haptics on the phone. No web-style custom chrome.
5. **Many machines, one place.** Machines are first-class: every session, card and notification names its machine, and the person can tell at once which machine is unreachable.

## The Mac app (Conductor-like)

- **The main window has three columns:**
  - machines, each with its repositories;
  - the sessions of the selection, with status and the worktree or branch;
  - the session itself.
- **The session view:** the transcript (agent messages, tool calls as compact chips that expand), the open cards inline, and a composer at the bottom.
- **New session sheet:** pick the machine, repository, worktree (new branch or existing), harness (Claude Code, Codex) and model. The hub creates the worktree (`create_session_request.workspace`, #1236) when it lists the `workspaces` capability; for a hub that does not, the sheet starts a session in a directory.
- **Menu bar extra:** a glanceable count of cards that need the person, and the list of them. It stays.
- **Notifications:** native, grouped by machine. A card's notification opens it in place.

## The iPhone app

- **Home:** the sessions grouped by machine, with the cards that need the person on top.
- **The session:** transcript and cards, with a composer.
- **Lock screen:** a notification's buttons follow the daemon's push categories (root AGENTS.md, "Notification channel"), which choose by meaning: Yes and No; Yes, "Yes, always" (an always-allow rule, which needs an unlocked device) and No; or the options of another card with two to four choices and no standing grant, a single-question, single-select AskUserQuestion included. Every other card has no buttons and opens the app: one with `detail`, a "for this session" mode grant, a plan approval, a terminal-only card.
- **Pairing:** adding a machine shows the steps the person must do on that machine (for example `remi authorize`), not just a spinner.

## Shared components (RemiUI)

These are built once and used by both apps:
- **Question card:**
  - Text and detail.
  - Options by meaning: Yes, No, and "for this session" grants.
  - Free text where allowed.
  - Terminal-only and plan-approval variants.
  - States: pending, sending, answered, resolved elsewhere, stale.
- **Session row:** machine, name, harness label, status, last activity, open-card badge.
- **Machine row:**
  - reachability (connected, connecting, unreachable, waiting for approval);
  - transport (local, direct, relay);
  - the person's own name for it.
- **Transcript entries:** user message, agent message (Markdown), tool call chip, error.
- **Composer:** text, send, interrupt (Esc), and the "a prompt is waiting" refusal (`PROMPT_WAITING`), shown as an explanation rather than an error.

## States every screen handles

- Connecting, connected, reconnecting, unreachable.
- First connection: approval pending on the machine (#873), with the exact command to run there.
- Empty: no machines, no sessions, nothing needs you.
- A card answered elsewhere (in the terminal or on another device) disappears with a short note, never silently.

## Tokens

- `RemiUI/Theme.swift` holds spacing and radius tokens. The first design pass replaces its placeholder values and adds color, type and motion tokens.
- Colors come from semantic system colors where possible.
- One accent marks "needs you"; every other status uses neutral tones.

## Accessibility

- Dynamic Type at every size, including the largest accessibility sizes.
- Full VoiceOver labels, with cards announced as questions.
- Contrast that passes in light and dark mode.
- Every card action reachable from the keyboard on the Mac.
