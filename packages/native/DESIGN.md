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
6. **Spacious, minimal, deliberate.** Give content enough breathing room to establish hierarchy, but make every region earn its space. Prefer one clear primary action, short supporting copy, aligned full-width controls, and a restrained material surface over dense forms, decorative chrome, or large areas that feel accidentally empty.

## The Mac app (Conductor-like)

- **The main window has three columns:**
  - machines, with the Inbox above them;
  - the sessions of the selected machine, grouped by workspace (the project folder): active workspaces first, then the rest under "Recent". Clicking a closed workspace opens it and shows its latest session (the most urgent, then the most recent), clicking an open one closes it, and the workspace row is never highlighted; under its sessions are a New session button and a more-actions menu. A filter shows all, needs you, live or stored sessions;
  - the session itself, with its conversations (Main and subagents) as small pills above the transcript.
- **Controls:** the toolbars carry only what applies to what is open. Everything else is a menu command with a shortcut (new session, add machine, show or hide the columns, focus the conversation, previous and next session, conversation and machine). Jump to the first or latest activity is in the session's actions menu.
- **The session view:** the transcript (agent messages, tool calls as compact chips that expand; a run of 3 or more is one row, "12 tool calls", that opens in place; the newest entry and search matches stay out of groups), the open cards inline, and a composer at the bottom.
- **New session sheet:** pick the machine, repository, a new branch (the hub makes its worktree; starting in an existing worktree means picking its directory), harness (Claude Code, Codex) and model. The hub creates the worktree (`create_session_request.workspace`, #1236) when it lists the `workspaces` capability; for a hub that does not, the sheet starts a session in a directory.
- **Menu bar extra:** a glanceable count of cards that need the person, and the list of them. It stays. Its icon is the "r" in a square, one color: a thin outlined square with a filled "r" while nothing waits, and a filled square with the "r" knocked out while something does (the same pair as Transit's "t"), with the count beside it.
- **Notifications:** native, grouped by machine. A card's notification opens it in place.
  Short, fully displayed one-time Yes/No requests also offer those choices in the
  notification on an unlocked Mac, without bringing the main window forward.
  A long request, plan, standing grant or unsupported card opens the current
  request in the existing window. A stale or unconfirmed notification answer
  brings that request forward for review.

## The iPhone app

- **Home is an Inbox:** the cards that need the person, from all machines, with a short note for each one resolved elsewhere, a one-line row for each machine problem, and the first-run steps when nothing is connected yet.
  It is not a list of sessions: browsing sessions is the drawer's job.
  The app launches on the Inbox.
- **Each card has an Open conversation link** under it, quieter than the answer controls, that opens the card's session (and its subagent conversation, when the card is from one) on its machine.
  The link only navigates; it never answers.
  A card whose session is gone has no link.
- **When nothing needs the person** the Inbox says "Nothing needs you", gives the number of active sessions, and points to the menu to pick one; a New session button shows when a machine is connected.
  Notes about requests resolved elsewhere can still show below.
- **Sessions live in a left drawer,** reached by an edge swipe or a button at the top left.
  The drawer groups them Needs you, Active and Recent, and each row names its project and its machine.
  A running session wears the same faint-green Working badge as on the Mac (a dot at accessibility text sizes), and a long press on a row opens a small menu beside the row (to its right, over the detail pane, in a wide window): New session here and Resume, the project's other sessions on that machine (most recent first, a running one says so in words), and the copy actions. It is drawn by the root, not the system context menu, whose submenu stacked over the list.
  Search lives in the drawer; the Inbox has none.
  The machine strip in the drawer is a temporary filter: it narrows the list of sessions and never the Inbox or notifications.
  The Inbox has no persisted machine selection; it always spans every machine.
- **The machine strip** depends on how many machines there are.
  One machine is a single line with its name and state, no chips.
  Two to four are an All chip and one chip each; five or more are the same chips in a horizontal scroll that a swipe on them scrolls without closing the drawer.
  At accessibility text sizes two or more become a menu.
  A chip shows a state symbol that differs by shape (never color alone), the name, and the count of open questions in the attention color, the only use of it here.
  Machines that share a display name are told apart by their address.
- **Machine problems** are one line each under the strip: a machine is offline, or waiting for approval.
  Three or more collapse into one line, "3 machines need attention".
  A line opens the Machines sheet.
  The sessions of an offline machine stay in the list, dimmed and captioned "Last known", so the state is never color alone.
- **The Machines sheet** is the home of machine management: connection layer, retry, approval help with the fingerprint and the authorize command, relay confirmation, pairing again and removal.
  The drawer's Manage button and the problem lines open it.
- **The session:** transcript and cards, with a composer.
  It opens at its latest message and has no back button; the drawer is the way out.
  A session has a pane: chat, and a terminal or files once a hub capability and route back them (see Panes).
  No control is drawn for a pane that cannot work.
- **In a session the navigation bar minimizes on scroll** on iOS 27 and later, for sighted people at standard text sizes, to give the transcript reading room.
  It returns on a scroll up.
  It stays visible with VoiceOver, Switch Control or accessibility text sizes, and on iOS 26, so the Menu button is always reachable.
  The edge swipe always opens the drawer.
- **The drawer's actions** are New session, Add machine and Preferences: New session plus two icon buttons.
  At accessibility text sizes they collapse to New session and one More menu that holds Add machine and Preferences, because three stacked labeled buttons would take a large share of the screen.
- **The drawer is a custom container** built on the system edge-pan recognizer and system materials, not web-style chrome (principle 4).
- **Lock screen:** a notification's buttons follow the daemon's push categories (root AGENTS.md, "Notification channel"), which choose by meaning: Yes and No; Yes, "Yes, always" (an always-allow rule, which needs an unlocked device) and No; or the options of another card with two to four choices and no standing grant, a single-question, single-select AskUserQuestion included. Every other card has no buttons and opens the app: one with `detail`, a "for this session" mode grant, a plan approval, a terminal-only card.
- **Pairing:** lead with scanning the short-lived code from `remi pair`, then show the endpoint, pinned daemon fingerprint, expiry and explicit terminal-approval requirement before connecting. Manual host/port and `remi authorize` remain the fallback. The scanner, confirmation and fallback states use one focused card with generous spacing and one primary action, not a dense setup form.

## Panes: terminal and files

- **Status today: no pane is shown.**
  No hub advertises `terminal_view` or `file_download` yet, and this app has no secure transport (a signed WSS connection, or the relay's encrypted child) that ADR 0045 and ADR 0047 require for these frames.
  The panes are built and tested but hidden; they appear only when a hub advertises the capability and the app can reach it over a route that may carry the frames.
- A session has panes beyond chat: a read-only terminal and a file download.
  When offered, each is in the session actions menu and in a segmented switcher.
  With none offered, no switcher and no menu entries are drawn, as before.
- The terminal is a monochrome, monospaced grid of the screen the machine reports, with a block cursor, escaped text, and sideways scrolling at large text sizes.
  It is read only and says so; answering and typing stay in chat.
  A refused, expired or interrupted view says why in plain words and offers Try again.
  After an interruption or expiry the last screen stays, dimmed, under the status line; leaving the pane, a refusal, and removing the machine clear it.
- Files are downloaded by typing a path relative to the session workspace; there is no folder browser.
  The sheet shows the escaped name and size, progress, and "Verified" once every byte matched its checksum.
  The machine's offered name must equal the requested file's name, or the download stops.
  Save is an explicit action through the system file exporter, with an escaped default name; the file is never previewed or opened.
  Cancel, a dropped connection, leaving the pane, a finished Save or Discard, and removing the machine or exiting the session drop the partial or verified bytes held in memory.
  Nothing is written to disk except by the person's Save.

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
- **Composer:** text, send (on the Mac, Return sends and Shift+Return starts a new line), interrupt (Esc), and the "a prompt is waiting" refusal (`PROMPT_WAITING`), shown as an explanation rather than an error.

## States every screen handles

- Connecting, connected, reconnecting, unreachable.
- First connection: approval pending on the machine (#873), with the exact command to run there.
- Empty: no machines, no sessions, nothing needs you.
- A card answered elsewhere (in the terminal or on another device) disappears with a short note, never silently.

## Tokens

- `RemiUI/Theme.swift` holds color, typography, spacing, radius, size and motion tokens.
- Spacing follows a compact 2, 4, 8, 12, 16, 24, 32, 48 point scale. Controls have a 44 point minimum tap target.
- Colors come from semantic system colors where possible. The existing lime is retained only as the attention accent and uses a dark ink color for readable text.
- One accent marks "needs you" and pending approval; every other status uses neutral tones.
  There is one named exception: the composer's send action wears it when there is something to send, because it is the primary action of a session.
- The saturated lime stays on small marks: counts, badges, the needs-you bar, the send action.
  Large surfaces, such as a message bubble, use a very pale wash of it (about 12 percent) with a faint outline and normal text color, because a big rich fill tires the eye.
  Question cards that need the person may be stronger than that: needs-you is the one place the app should be loud.
- Liquid Glass is concentrated on interactive cards and controls. Repeated list rows use lightweight semantic surfaces to keep scrolling efficient.

## Accessibility

- Dynamic Type at every size, including the largest accessibility sizes.
- Full VoiceOver labels, with cards announced as questions.
- Contrast that passes in light and dark mode.
- Every card action reachable from the keyboard on the Mac.
