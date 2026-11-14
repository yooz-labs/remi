# Remi reference: question detection and notifications

Moved verbatim out of `AGENTS.md` to keep it under the instruction-size limit; `AGENTS.md` keeps the summary and the standing invariants. Repository-root links are prefixed with `../../` so they resolve from this file.

## Question Detection and Notifications

The old flow diagram (from before the held-hook relay, #1125/#1126) is archived at `.context/archive/2026-h2/notification-and-session-flow.md`; this section is the current description, and #1145 tracks a new diagram.

**Question sources** (daemon side):

- `HookEventBridge` — emits questions from `PermissionRequest` hooks; suppresses redundant notifications.
- `OutputProcessor` — PTY-output parsing (fallback when hooks are unavailable).

**remi relays permissions; Claude Code decides them** (#1125,
[ADR 0030](../../.context/decisions/0030-defer-permission-judgment-to-the-harness.md)).
There is no auto-approve evaluator and no rule layer: remi never answers a
permission without a human choice. `AutoApproveGate` (a historical name; it is
the relay) owns every `PermissionRequest` hook response.

**A binary prompt is answered through its held hook while Claude's own dialog
stays visible** (#1126, [ADR 0031](../../.context/decisions/0031-held-hook-answers-with-native-dialog-visible.md)).
Verified on Claude Code 2.1.287: the dialog renders about 0.1 s after the hook
POST, during the hold. The gate stashes the card, holds the hook, and pushes
the card at once by id (`holdForAnswer` -> `onHeldEscalate` ->
`pushHeldHook`). The first answer wins:

- **Phone:** `answerHeld` maps the card option's MEANING to the hook response,
  never a position on Claude's screen: `Yes` -> `allow`; `No` -> `deny` (an
  optional `message` on the answer reaches Claude as the tool result; the
  protocol carries it, no client sends it yet; Cancel on a held card is a
  No); a standing option -> `allow` + `updatedPermissions`,
  only for `setMode` and an allow `addRules` (labeled "for this session"),
  BOTH echoed with `destination: "session"` so a phone tap never writes a
  settings file; `standingGrantFor` in `hook-event-bridge.ts` is the one
  place that decides, and it stamps the option's `standingGrant` kind.
  The web card reads that kind, never the label's wording (#1155): its hint
  says "This session" for a standing option and "Allow once" only for the
  plain Yes. Telegram does not read it; it keeps every label whole instead:
  a button is cut at 32 characters, so when any label is cut the message
  lists every label in full and numbers the buttons (no buttons when the list
  does not fit in one message).
  `addDirectories` is never offered (its echo did not stop the repeat
  prompt). An answer the card does not offer is refused and the hold stays.
  The lock screen's static "Yes, always" (`REMI_YNA`) is chosen only for an
  `addRules` grant (`selectPushCategory`); a `setMode` card gets no
  actionable category.
- **Terminal Yes:** Claude runs the tool and never closes the held request.
  `PermissionRequest` has no `tool_use_id`, so it is paired on arrival with
  the in-flight `PreToolUse` of the same agent, tool and input (about 10 ms
  earlier); the `PostToolUse`/`PostToolUseFailure` with that id releases the
  hold with an empty response and dismisses the card. It arrives only when
  the tool finishes, so during a long command the card stays up and a phone
  answer is accepted and ignored by Claude. Two identical calls in flight are
  not paired; a name + input match then releases the hold to the terminal
  (card dismissed, prompt kept open, a "handed back to the terminal" notice
  pushed), never closes it. Every release of a live hold that is not an
  answer pushes a notice (`onReleasedToTerminal`).
- **Terminal No / Esc:** Claude closes the held request. `HookServer` hands the
  resolver `req.signal`; its abort (also a session end) dismisses the card
  (an abort at Claude's own hook timeout is handled like the deadline, see
  below). No hook fires for it, so a new
  `UserPromptSubmit` also closes main prompts left open.
- **Deadline:** in wrapper mode at `[prompts] hold_seconds` (default 90, 5
  to 110: under the 2:00 auto-deny of auto-mode fallback prompts, which
  counts during a hold, and the 600 s registered hook timeout) remi releases
  its own hold with an empty response, the dialog stays, the card is
  dismissed and an "answer at the terminal" notice is pushed (#733). A daemon
  or hub session has no terminal of its own, so it holds for
  `[prompts] daemon_hold_seconds` (default 3540, 5 to 3540) and registers
  the hook with a 3600 s timeout (`DAEMON_PERMISSION_REQUEST_HOOK_TIMEOUT`;
  Claude honors it, measured: a 650 s hold answered at 653.6 s ran the
  tool); its notice says `remi attach`, the only way left to answer. An
  abort within 5 s of the registered timeout (`hookTimeoutMs`) is Claude's
  timeout, not a terminal No: released to the terminal with the notice,
  like the deadline (which normally comes first). An auto-mode
  fallback prompt still auto-denies at 2:00 there; Claude fires
  `PermissionDenied` for it (measured), which dismisses the card and pushes
  a `harness_denied` notice. The notice never claims the
  prompt is still waiting (a terminal Yes may already have answered it); it
  is dismissed when the prompt resolves, and a late phone answer does not
  resolve it.

An empty response never decides anything; it is what every non-answer path
sends.

**AskUserQuestion and ExitPlanMode are held the same way** (#1127, ADR 0031
amendment): their dialogs render during the hold, and a phone answer
resolves the hook with a structured `updatedInput` built in
`hooks/structured-answers.ts`, never typed. Verified on Claude Code 2.1.287:

- **AskUserQuestion:** one card for the whole call (each question's text,
  header, options with descriptions, `multiSelect`). The phone sends
  `selections` (option indices per question, or `text` for a single-select
  question); the gate validates them against the tool input and answers
  `{behavior:"allow", updatedInput:{...tool_input, answers}}`, `answers`
  keyed by the raw question text, a multi-select as its labels joined with
  ", ". An answer that leaves a question unanswered, gives a single-select
  question anything but one option or its own text, gives a multi-select
  question no option or text, or names an option that does not exist is
  refused and the hold stays (never completed with a guess); so is every
  answer to an input that does not parse exactly, whose card is marked
  `terminalOnly` (no lock-screen category, no Telegram keyboard, "This
  question can only be answered in the terminal (or Cancel)."). A single option answers
  only a one-question single-select call: the lock screen sends its label,
  Telegram its value, and on any held card a string that is one option's
  value and a DIFFERENT option's label (numeric labels) is ambiguous and
  refused, the hold kept. Cancel denies with "The user dismissed the
  question."
- **ExitPlanMode:** a `plan_approval` card with the plan as `detail` and
  three options by meaning: "Approve, auto-accept edits" / "Approve, approve
  edits manually" (`allow` + the tool input echoed as `updatedInput` + a
  `setMode` `acceptEdits` / `default` with `destination: "session"`) and
  "Keep planning" (`deny` with the phone's message or "Keep planning.";
  Claude revises and asks again). `auto` is not offered (not knowable from
  the payload); the terminal still offers it. Cancel keeps planning. A
  subagent's plan (held in daemon or hub mode) offers "Approve" (`allow` +
  `updatedInput`, no `setMode`: a mode would apply to the whole session)
  and "Keep planning".
- A terminal answer fires `PostToolUse` with the paired `tool_use_id` but a
  different `tool_input` (`{questions, answers}`, or `{}` for a plan), so
  the gate matches a paired id whatever the input. If the request was not
  paired, a finished call of that tool that matches nothing releases the
  one open hold of that tool and agent to the terminal (notice pushed);
  with two or more, nothing is released. Deadlines, abort,
  subagent routing and the chat guard are the binary prompt's.

A **multi-choice string-label permission**, or a question-shaped tool that is
not AskUserQuestion, is still answered `passthrough` and pushed by id at once
(no structured hook answer was verified for either). The permission's answer
is typed behind the #1134 guard. The question-shaped tool's card is
`terminalOnly` (its dialog is Claude's permission prompt, not its questions):
no Telegram buttons, no lock-screen category, and every phone answer is
refused with the terminal wording, never typed. A structured `selections`
answer for a card no hold stands behind is refused, never typed. An open card is also resolved by a matching `PreToolUse`/`PostToolUse`/
`PermissionDenied`, a lead `Stop` or new user prompt (main), `SubagentStop`
(that agent), `SessionEnd`, a transcript rotation, a real session close, or
`remi unstick`; a dismissal is broadcast only for a card that was actually
pushed. At a real close the registry hands the ids of the cards it still held
to the close handler (`closeSession` clears the session first, so nothing else
can look them up), which dismisses each one not already dismissed by the
harness's own teardown, and the daemon waits up to 2 s for its pushes in
flight before it exits (`drainPushDeliveries`, #1223). `remi
unstick` does not close a LIVE hold: its dialog is on screen, so it is
released to the terminal with a "handed back" notice (suppression kept),
and a second unstick clears it.

**No card answer is typed into the PTY for a hook-backed binary prompt**
(raw input from `remi attach` and the phone's Escape button still reach the
dialog by design: they are a person at the terminal). While a
MAIN-agent hook is held, or a prompt waits in the terminal (`terminalPrompts`:
a hold released at its deadline or early, or a rendered wrapper-mode subagent
dialog) for less than the session's hold length, the tracker treats a PTY
render as that dialog (`setHookPromptProbe` -> `hasOpenHookPrompt`), never as
an orphan, so no typed card is rebuilt from it; for a wrapper-mode subagent
prompt the phone keeps exactly one artifact, its notice. The probe is bounded
on purpose (#1126 lead decision), since everything it counts suppresses a
hook-less prompt's card (sandbox network, trust, an agent-team dialog). Only
what does not render is excluded: a subagent HOLD (daemon mode) never counts,
since its dialog does not render while held, neither in this probe nor in the
tracker's other suppression input, the live-question check
(`hasLiveQuestionOnScreen`, which skips a held subagent card; every other
registered card still counts). A `terminalPrompts` entry stops
counting after the hold length, and a subagent's entry is also cleared by
that agent's next `PreToolUse` (`noteAgentToolCall`), `SubagentStop` or
`SessionEnd`; past that a redraw takes the guarded hook-less path (#1134,
fail closed). `handleAnswer` asks
the gate first (`gateAnswerDeps`): a held card is answered through the hook,
and a binary card whose hold has ended is refused (`closed`: answer at the
terminal), never typed. While a main-agent hold is open its dialog is on
screen, so `onUserInput` refuses chat text with `PROMPT_WAITING` even before
the screen parse sees the menu (#1140; `promptUp`, below). Its message is
`PROMPT_WAITING_HELD_MESSAGE`, which does not claim a dialog is up: after a
terminal Yes the hold lasts until `PostToolUse`, so the refusal also covers
the approved command's run (#1144).

**A typed answer carries the screen's numbering** (#1134). This applies only
where no held hook stands behind the card: hook-less prompts (sandbox network,
trust, agent-team dialogs; not all of them reach the phone, the daemon's
startup folder-trust dialog does not, #1147) and multi-choice cards
(AskUserQuestion and ExitPlanMode are held since #1127). When a hook record merges onto a parsed prompt
(`QuestionPresenceTracker.consumeAndMerge`), the card's options are the
parse's options, labels and values unchanged; the hook contributes id, text,
agent, source and tool metadata (including `allowsFreeText`: a permission
dialog takes a pick, not text), never options. The parse carries no yes/no
flags, so the merge sets `isYes`/`isNo` from labels that start with the exact
word "Yes" or "No". Live, before #1134, `addDirectories` + `setMode`
suggestions built a 4-option card over a 3-option dialog, the phone's "No"
typed `4`, Claude ignored it, and the Enter that follows every typed answer
confirmed "1. Yes".

**Every typed phone answer is checked against the screen first.** Guards
in `handleAnswer` before anything is typed (all refuse like a stale answer:
STALE_ANSWER, card consumed, trace reason in parentheses). A refusal means
"answer at the terminal": Claude's own dialog is still there.
- a prompt must be on screen: the card's own prompt for a `source: 'pty'`
  card (`prompt-not-current`, #920), any prompt for a hook card
  (`no-prompt-on-screen`, #1002).
- an option value must be on the menu the tracker last observed
  (`observedPromptOptions`, wired by `trackerScreenDeps`) (`option-not-on-screen`),
  and that screen option's label must EQUAL the card option's after
  normalization (lowercase, all whitespace and box characters removed), or,
  for a pick with a description (a card built from a tool's `questions`; a
  `terminalOnly` card is refused before this check), equal it with
  the description appended (`option-mismatch`). Nothing looser: it fails
  closed; the accepted cost is false refusals on short, partial-frame or
  reworded labels. A pushed-by-id card keeps the hook's numbering, so this
  refuses its digit wherever the hook's list differs from Claude's.
- free text is refused when the card has options and takes no text and a
  numbered menu is on screen (`free-text-into-menu`), and always on a
  pushed-by-id (`held`-stamped) card that has options and takes no text
  (`free-text-on-held-card`). A structured `selections` answer on a card
  no hold stands behind is refused before anything is typed
  (`selections-not-held`, #1127). Free-form `user_input` (including a Telegram
  text reply) is a separate path with its own guard, next.
- a question is claimed while its answer is applied: a duplicate delivery of
  the same choice (the lock screen sends every tap on two channels) reports
  delivered and types nothing; a different concurrent answer is refused.

**Chat text and Stop's `/exit` are refused while a prompt is up** (#1140,
#1155). `onUserInput` types structured input (web chat, a Telegram text reply
or custom text) followed by Enter, and a Stop (`onKillSessionRequest`) types
`/exit` + Enter; into a Claude dialog the letters are ignored and the Enter
confirms the highlighted option, usually "1. Yes", so a message or a Stop sent
from the phone while a prompt waits would approve it. Both read ONE signal,
`promptUp` (`cli/handlers/prompt-up.ts`, built once in `cli.ts` by
`promptUpDeps` and spread into both handler factories; a source-level test pins
that wiring), which says a prompt is up when any of three sources does:

- `held`: a main-agent hook is held (`hasMainHold`; its dialog renders during
  the hold);
- `terminal`: a hook-backed prompt waits in the terminal (`hasOpenHookPrompt`
  beyond a main hold: a hold released at its deadline or handed back early,
  or a rendered wrapper-mode subagent dialog, each for at most the session's
  hold length);
- `menu`: the tracker observes a numbered selection box
  (`observedPromptOptions`; `isNumberedMenu`: every option value is numeric),
  which covers hook-less prompts.

Before #1155 Stop read only the screen parse and the chat guard only the parse
and a main hold, so a dialog the parse missed (or that a text status had
cleared) got the typed Enter. While a prompt is up the chat guard types nothing
and the sender gets an `error` with code `PROMPT_WAITING`, its message by
source (`PROMPT_WAITING_HELD_MESSAGE`; `PROMPT_WAITING_TERMINAL_MESSAGE`,
"Claude is waiting on a prompt in the terminal. Answer it there, press Esc from
the app, or run remi unstick.", since the card is gone; or
`PROMPT_WAITING_MESSAGE`:
"Claude is waiting on a prompt. Answer it from its card or in the terminal (Esc
dismisses it)."; all in `@remi/shared` with `createPromptWaitingError`), plus a
trace record (`input_refused`, reason `chat-into-held-prompt`,
`chat-into-terminal-prompt` or `chat-into-menu`). Telegram renders it as
"Error: ..."; the web client marks the refused bubble failed from
`details.messageId`. Stop types no `/exit` and force-closes the session
instead.

Deliberately typeable: raw input (`raw: true`, an attach client's keystrokes,
the web client's Escape button and Telegram's `/interrupt`, which is how a menu
gets answered or dismissed; its Escape is written exactly, no Enter); a
subprocess `(y/n)` prompt, or Claude prose ending in "(y/n)", which observes
options "y"/"n" and takes text; a free-text prompt (an empty option list); and
anything when nothing is up. A raw write that fails is answered with
`INPUT_NOT_DELIVERED`, and `/interrupt` then shows that error instead of
"Interrupt sent". The parser returns `allowsFreeText: false` (and
`optionsAreFallback: false`) for a Claude selection box, so a hook-less card is
covered by the `free-text-into-menu` guard above and its Telegram card no
longer says "reply with custom text"; a hook record's own flag still wins when
one merges.

What clears the observation (so what unlocks the chat): a status change with no
agent, that is a main-agent hook event (PreToolUse, PostToolUse, Stop,
`idle_prompt`, ...) or a PTY-parsed non-waiting status, including Claude's
empty input prompt (a bare `❯` as the last non-empty line) read as idle while a
prompt is believed up; and `clearPending`. A status carrying an `agent_id`
(SubagentStart/SubagentStop, a teammate's notification) does NOT clear it: a
background agent's activity says nothing about the main dialog. A subagent's
Pre/PostToolUse never reaches the status pipeline at all.

Limits, stated so nobody has to rediscover them. (1) Esc in the terminal fires
no hook, so the observation outlives the dialog until a clear event above: the
idle-prompt recognition when the redraw matches it (no capture of the redraw
right after an Esc exists, so that exact frame is not claimed), otherwise the
next status or Claude's own `idle_prompt` notification, which it sends only
after the session has sat idle for a while. Until then the chat is refused (the
card and the terminal still answer). (2) For chat and Stop, `submitInput` checks
a synchronous caller guard inside its write queue before text and again after
the 50 ms delay before Enter (#1488). Chat rechecks its captured session/PTY,
attachment, binding, typed-chat support and `promptUp`; Stop rechecks its
captured runtime, binding and `promptUp`, force-closing that runtime if invalid.
If chat's context changes after text, Enter is withheld but some text may remain
in the terminal: a correlated partial-input error gives the web message a
"Not submitted" status without Retry. A late receipt or matching transcript
text does not clear that uncertainty. (3) A PTY-parsed status is a text
guess and can clear the observation while the menu is still up; for a
hook-backed prompt the gate's half of `promptUp` still refuses then. (4) The
no-tracker branch is effectively dead in production: `cli.ts` builds a tracker
for every session, hook server or not. It exists for a caller that does not
wire `promptUp` (tests, a future entry point) and it fails open (types the
text), the opposite of the answer guards above. (5) A `terminal` entry counts
for the session's hold length from when it is MARKED (the deadline release,
the early hand-back, or the subagent dialog's render), not from the prompt's
start: in wrapper mode up to `hold_seconds` (90 s) after a deadline release,
about twice the hold from the start; in daemon or hub mode up to
`daemon_hold_seconds` (about 59 minutes). A No answered at the terminal fires
no hook, so the entry can outlive its dialog; in that window Stop
force-closes instead of typing `/exit` (kept by lead decision: a forced close
is always safe) and chat is refused. Ways out: an answer a hook sees (the tool
runs, `Stop`, a new prompt; a subagent's next tool call or `SubagentStop`), a
bare Esc sent through remi (web Esc button, Telegram `/interrupt`, an attach
Esc key), which clears the MAIN agent's entries (`noteTerminalEscape`,
#1155), and `remi unstick`. An Esc typed at a wrapper session's own terminal
does not pass through remi and is not seen. The opposite direction: once an
entry ages out, a dialog still on screen whose parse a text status cleared is
no longer guarded (chat would be typed into it, Stop would type `/exit`).

The parser joins a label's wrapped rows (and an AskUserQuestion description
row) onto the option above, at most two rows, never across footer rows
("Esc to cancel · ..."), dropping divider rows; it used to end the option list
at the first such row and drop every later option, "No" included.


**Subagent permissions follow the terminal**
([ADR 0004](../../.context/decisions/0004-pty-as-arbiter-subagent-questions.md), amended
by ADR 0030 and ADR 0031). A background subagent's dialog does NOT render while
its hook is held (verified live), so the gate takes a required
`hasLocalTerminal` (wrapper mode, fixed at session setup):

- **Wrapper mode (a local terminal):** an `agent_id`-tagged `PermissionRequest`
  is answered `passthrough` so its dialog renders, and parked
  (`passSubagentToTerminal` → `QuestionPresenceTracker.parkAwaitingPTY` with
  `onRender`). When the dialog renders, the phone gets an informational
  "answer at the terminal" notice, never an answerable card; the notice is
  dismissed when the prompt resolves. With no park path the notice is pushed
  at once.
- **Daemon or hub mode (no local terminal):** nobody could answer a rendered
  dialog, so the request is escalated exactly like a main-agent prompt: held,
  with an answerable card. A lead `Stop` spares it; that agent's
  `SubagentStop` releases it. Claude does not fire `PermissionRequest` for a
  call its own allow rules permit (measured on 2.1.287 for background,
  foreground and main calls), so these holds are only for real prompts.

**`subagent_alert` covers what never prompts** (#807, #1155;
`auto-approve/subagent-alert.ts`, patterns in `[notifications]
subagent_alert`). It is for any subagent, foreground or background (any
`agent_id`-tagged call), never the main agent. Because a call the allow rules
permit fires no
`PermissionRequest`, the alert is fed from the tool hooks, in both modes: an
agent-tagged `PreToolUse` whose call matches a pattern is remembered, a
`PermissionRequest` or `PermissionDenied` for that call forgets it, and its
`PostToolUse` or `PostToolUseFailure` delivers the alert (rate-limited,
daemon-wide); `SubagentStop` forgets the agent's unfinished calls. One call
therefore produces at most one phone artifact: a call that prompts gets its
"answer at the terminal" notice (wrapper mode) or its held card (daemon or
hub mode), the actionable one, and never an alert as well; a call that ran
without asking gets the alert. The alert arrives when the call finishes (the
first moment remi knows it ran unasked), so a long command's alert comes at
its end. Before #1155 it was fed from the subagent `PermissionRequest`
passthrough, the one event the allowlisted case never fires.

**Old auto-approve settings.** An old `config.toml` with an `[auto_approve]`
table still loads; the daemon warns once at boot (daemon, `remi serve`,
`remi config`; not again in a hub-spawned session daemon, and `remi start`
reports only removed flags) naming the ignored keys, and `--auto-approve*`
flags are accepted and ignored so old LaunchAgent plists keep starting.
`auto_approve.subagent_alert` is honored as a deprecated fallback when
`[notifications] subagent_alert` is unset, and gets its own "move it" line
instead of being listed as ignored. `remi migrate-permissions` prints the old
`allow`/`deny` lists as a Claude Code `permissions` block for the user to
paste into `~/.claude/settings.json`; it never writes a file. It never emits a
rule broader than the old entry (a bare `Bash` allow, which remi never
applied, is not carried over), and deny entries change meaning: remi matched
them as substrings anywhere in a command, Claude Code matches from the start
of each subcommand, so a migrated deny is narrower and mid-command patterns
(`push --force`) are not carried over. Everything not carried over is listed
on stderr with its reason.

**Notification channels (APNS push, plus iPhone local question notifications):**

- Daemon sends WebSocket `question` (in-app display) AND APNS push (lock screen), by one of two paths (#1200).
- The iPhone app also posts a local question notification for a question first seen after an attach-confirmed snapshot on that session connection. Questions already pending in that snapshot are not posted again on reconnect, including on hub child-session connections. A connection without attach state or without an attach-time snapshot fails closed: it posts no local question notification, and APNS delivery is unaffected. The local notification id differs from the APNS card id, so the app does not coalesce a local notification with an APNS card for the same question.
- **Legacy plaintext push is ON by default.**
  `notifications.legacy_push_enabled` defaults to `true` until secure push ships end to end; the default flips at the R7 gate (owner decision).
  The daemon POSTs the text to the signaling Worker's `/push` with the push secret (`--push-secret` or `REMI_PUSH_SECRET`), and the Worker needs `PUSH_SECRET` (and `LEGACY_PUSH_ENABLED` not set to a false value) to forward it to APNS. A hub passes its push secret to spawned session daemons through their environment only while legacy eligibility remains open; after secure activation it strips that credential (#1679). Same-user process inspection remains possible (#1252).
  Its recipients are the device tokens a phone registered with `register_device_token`, counted only while the path is enabled and has a secret (`legacyChannelOpen`): `legacy_push_enabled = false`, or no push secret, makes old tokens no recipients and the event `no_channel`, not an error-level "legacy failed" per token.
  The sender throws `LegacyPushError`, whose message is one fixed code and whose `status` and `tokenInvalid` fields drive the classifiers: a 429 or a 5xx the Worker did not mark `tokenInvalid` is retried (2 retries, 400 ms then 800 ms), `tokenInvalid` prunes the token, a lost response (`LEGACY_PUSH_UNCERTAIN`) is never retried.
- **The activation latch is machine-wide and one-way.**
  `secure_push_activation.json` is written when a device is enrolled over the relay (pairing), when a relay peer's authority is captured, when a secure subscription registers, when an enrollment is removed while any exists, and when a legacy send finds an enrolled device (`withLegacyPushEligibility`).
  From then on the legacy sender refuses for good (`LEGACY_PUSH_NOT_ELIGIBLE`, reported as `no_channel`) whatever `legacy_push_enabled` says, for EVERY device token on the machine, including a phone connected directly that never touched the relay; a corrupt latch or enrollment file refuses too.
  **Relay enrollment retires legacy push for every device on the machine. Secure delivery then needs a registered per-device key and token and a running secure sender. The web subscription wiring exists in source, but deployed and signed-device acceptance remain unverified.**
- **The secure path** seals each push to a per-device key and sends it through the signed `POST /v2/push/<rid>` route (`notifications/secure-push-*.ts`).
  A hub requires relay opt-in (`--relay` or `network.relay = true`), an unlocked machine identity, a deployment push secret, and a `signaling_url` that is a bare `https`/`wss` origin (no path, query or fragment). An authenticated session daemon can instead forward its signed sealed submissions through the capability-protected local hub; the hub rechecks current recipient authority and registered runtime metadata before adding its provider credential (#1679). This is a machine-user capability boundary, not kernel-authenticated process identity.
  Otherwise `cli.ts` builds no service (it logs why, with the failure class and no message text) and the hub answers `secure_push_register_request` with `UNSUPPORTED` instead of acknowledging a subscription nothing could serve (#1200).
  The registration's `pushPrefs` pass `sanitizePushPreferences` at the store and in the hub branch, so a malformed or unknown preference registers and delivers.
- Signaling server (Cloudflare Worker) relays push payloads to APNS.
- iOS categories `REMI_YN`, `REMI_YNA`, `REMI_MULTI` registered in `AppDelegate.swift`. Their actions are positional (`OPT_i` sends option i) and the first two have hardcoded titles, so `selectPushCategory` picks by meaning, not count (#1134): `REMI_YN` only for exactly [one-time Yes, No]; `REMI_YNA` only for exactly [one-time Yes, an always-allow rule, No], the middle option marked `standingGrant: 'addRules'` (#1126: only there is its static "Yes, always" title true; a `setMode` or unmarked standing option gets no category; its "Yes, always" button is the only static action that requires an unlocked device). A one-time Yes is an option labeled exactly "Yes"; any other Yes is a standing grant, as is any Yes after the first option and a session-grant action. A card with a standing option in any other layout gets NO category (a plain notification, answered in the app), because `REMI_MULTI`'s buttons do not require an unlocked device. No card with a standing option gets the `dynOptions` hint, `REMI_YNA` included: the extension builds its dynamic buttons without `.authenticationRequired`, so a standing grant behind one could be tapped while locked. A permission card with `detail` gets no category and no `dynOptions` either (`hasUnseenDetail`, #1178): a Codex command cut for the lock screen or one that runs in another directory, and, since #1200, every Claude tool input whose summary was shortened (a Bash command or a `command`, `path`, `url` or `description` field over `SUMMARY_MAX`, 120 characters, which `hook-event-bridge.ts` keeps whole in `detail`), on the legacy and the secure path alike.
Its Yes needs the app, where the whole card is, and its push shows the ask, not the start of the detail. Every other 2-4 option card gets `REMI_MULTI`, except by kind (`pushCategoryFor`, #1127): an AskUserQuestion card gets `REMI_MULTI` (with `dynOptions`) only when it is one single-select question, whose tap (the option's label) answers that option through the held hook, and none otherwise; a plan approval never gets a category (approving a plan is not a lock-screen tap). When the Notification Service Extension does not run, `REMI_MULTI` shows all four static "Option N" buttons whatever the option count; a button with no option behind it sends no answer (`RemiAnswerRelay` finds no `opt_n` and defers to the app), and any answer that does arrive still passes the `handleAnswer` guards (an iOS follow-up will add 2- and 3-button categories).

**Push classes and who can mute them** (#968):

Every push carries an explicit `kind`. Before that field existed the classes
were told apart by a NEGATIVE test ("no `questionId`, no `category`") which
could not distinguish turn-complete from a subagent alert at all — on the wire
those two are both exactly `{token, title, body}`.

| `kind` | Fires on | Mutable per device |
|---|---|---|
| `question` | permission prompt, AskUserQuestion, plan approval; an "answer at the terminal" notice (hold deadline, wrapper-mode subagent dialog; no actions, own collapse key `notice-<questionId>`; a repeat pushes again) | yes, `pushPrefs.questions` |
| `turn_complete` | `Stop` after a turn ≥ `turn_complete_min_seconds` (#914); for Codex a `turn/completed` with status `completed` of the same length (#1180); no collapse key, each turn stacks on the lock screen, on the secure path too | yes, `pushPrefs.turnComplete` |
| `subagent_alert` | a subagent's (foreground or background) call matching `[notifications] subagent_alert` finished without ever prompting (#1155); no collapse key, each alert stacks | no — the pattern list IS the control |
| `harness_denied` | `PermissionDenied`: Claude Code's auto-mode classifier blocked a call, or auto-denied an unanswered fallback prompt at 2:00 (#1126); informational, never a card; one collapse key per session (`harness-denied-<sessionId>`), so a blocked loop replaces its notice | yes, `pushPrefs.harnessDenied` |
| `turn_failed` | `StopFailure`: a turn ended on an API error (usage or rate limit, authentication, and similar; #1153), or a Codex `turn/completed` with status `failed` (the title says "Codex stopped", #1180); informational, never a card (nothing in Claude waits, so there is nothing to answer); readable reason from `error`, an excerpt of `last_assistant_message` (Codex: its error message); one collapse key per session (`turn-failed-<sessionId>`), so a different failure replaces the previous notice; one alert per failure (`turnFailureKey`: main agent or subagent, and the reason) until the notice is cleared (#1226: at a usage limit every turn fails, a subagent's included, and each one used to alert the phone again) | yes, `pushPrefs.turnFailed`, default on; **not** muted by `notifications.on_turn_complete = false` |
| `dismiss` | quiet `content-available` clearing a resolved card | **no, deliberately** |

- **A client cannot mute APNS on its own.** The path is daemon → Worker → APNS
  and never consults the client, so a client-side switch is decoration. It
  literally was: `settings.notifications` was written by the settings panel and
  read by nothing. Preferences ride up on `register_device_token` (idempotent
  and keyed by token, so a toggle change is just a re-register) and the daemon
  filters its per-token fan-out in `notifications/push-preferences.ts`. Until
  #1258 the `cli.ts` wiring dropped them, so every device was stored with the
  defaults and muting did nothing; sibling daemons now also adopt the newest
  registration (its preferences included) from the shared store.
- **A phone is pushed only while its lease holds** (#1254, #1272, owner decision).
  Both legacy registrations and secure subscriptions use
  `[notifications] push_lease_hours` (default 720 hours / 30 days since #1677; 0 never expires).
  Legacy registrations renew on registration, while connected and on close;
  a locally connected legacy token never expires there (`isLive`). Secure
  subscriptions renew on registration, when an enrolled relay channel becomes
  ready, periodically while it stays current (at most every 15 minutes, or a
  third of the lease), and on close. Renewal uses the original grant and
  enrollment generations and a nonwaiting lock; a busy or unreadable store
  cannot renew. A stalled hub or failed renewal can therefore lose a secure
  lease; fresh registration is then required.
  Every push reads fresh disk state. Secure fan-out and final send/answer
  invocation check expiry under the authorization lock; an already expired or
  unregistered subscription is never
  recreated by renewal. A new registration has a new subscription generation,
  so it cannot revive a prepared old push or answer. Expired subscriptions remain
  dormant with a durable expiry marker to preserve the push-key version floor until explicit unregister or
  revoke. The file keeps at most 64 total rows; a full dormant file refuses a
  new device with `CAPACITY` until a row is explicitly removed. A longer lease,
  disabling expiry or a clock rollback cannot reactivate a marked epoch; fresh
  registration is required.
  Pre-lease secure records receive one lease from their first locked read;
  future sightings are clamped and persisted once. Timestamped records require
  the upgraded daemon reader; stop older daemons sharing the same remi home.
  Disconnecting a reachable machine explicitly unregisters at once
  (`unregister_device_token` or `secure_push_unregister_request`); removal while
  unreachable is bounded by the lease instead. Revocation and mute changes from
  another process apply on the next push. Store files are owner-only (0600).
  Secure subscription expiry never clears the monotonic legacy-push retirement
  latch. Worker-side phone-initiated revocation remains R7 work.
- **Never filter `dismiss`.** A muted device can still hold a card delivered
  before the mute; dropping its dismissal strands that card on the lock screen
  of the device that asked for less noise. The one exception is a device that
  is gone: unregistered, past its lease, or (on the legacy path) rejected by APNS, gets nothing, dismissals included, so a card it still holds stays
  until the app opens.
  The next main-agent tool call or
  `Stop` after a `turn_failed` push sends one (same collapse key, only while a
  `turn_failed` push is outstanding), so a stale "Claude stopped" does not
  outlive the agent working again. A new prompt does not (#1226): at a usage
  limit it fails too, and clearing on it re-alerted the phone on every retry.
  A session closing, a failed launch and process cleanup retire the secure runtime FIRST (no
  new or actionable push), let the disposal run, then dismiss every pushed question card nothing
  dismissed (`dismissUndismissedQuestions`: `closeSession` clears the session before it announces
  the close, and the gate announces a held card only while it is still registered, so a real close
  dismissed nothing before), wait up to 3 s for the dismissals (`SecurePushService.drain`) and
  only then finish the runtime (`retireSecurePushRuntime` / `closeSecurePushRuntime` in
  `cli.ts`); a dismissal that went out uncertain or failed is sent again with a fresh nonce by
  the next dismissal. At a real close the registry's pending ids are dismissed first, through
  the session's dispatcher on both paths (#1223, above), so `dismissUndismissedQuestions` sends
  only what that missed; the legacy sends are drained by `drainPushDeliveries` at cleanup.
- **Legacy push text is plaintext to the Worker and APNS.** `turn_failed` carries up
  to 140 characters of `last_assistant_message` (or a string `error_details`)
  in its body, the same posture as `turn_complete` (the first 200 characters
  of Claude's last message) and a question's text: the daemon POSTs it to the signaling
  Worker's `/push`, which forwards it to APNS, outside the relay data channel
  and its encryption. This is what ships by default today (see the first bullets of this
  section). The secure path seals the content to the device's push key, so the Worker and
  APNS receive sealed bytes plus delivery metadata (the device token, the collapse key, the
  push class alert or background, timing and size; the event kind is sealed). The app
  subscribes through Settings and `SecurePushSubscriptions` when it has a native identity and a
  relay machine; no signed build has been verified yet. Tracked by the
  relay and push privacy work (`.context/strategy-2026-10.md` section 9); the relay channel
  has its own state (#543, #881).
- **Secure collapse keys and repeats (#1200).** One lock-screen slot per notification:
  a question's own id, `notice-<questionId>`, one per session for `harness_denied`, one per
  episode for `turn_failed`; `turn_complete` and `subagent_alert` get a slot per occurrence, as
  legacy never collapsed them. A collapse key decides whether a notification REPLACES the
  earlier one, never whether it is sent: an identical `harness_denied`, `turn_failed` or notice
  repeat advances the revision and pushes again, while a question or an explicit occurrence id
  (a prompt or turn id) coalesces its duplicate frames. Only slots that can still deliver
  count against the 32 per session: a dismissed, expired or no-longer-registered entry is
  retained for dismissal and replay correctness but holds no slot. A question whose meaning
  exceeds 64 KiB is pushed as bounded information without actions, never dropped.
- **A muted fan-out reports `no_channel`, not `pushed`.** Claiming delivery
  for a fan-out of zero says a card reached a lock screen it never appears on.
  The same holds for a legacy channel that is disabled, has no secret or is latched off, and
  for a dismissal with nothing to clear (`skipped:no_prior_push`); a secure refusal logs its
  class (`refused:capacity`, `refused:stale`, `refused:invalid`, ...), never content or ids.
- Malformed preferences fail toward DELIVERING (`sanitizePushPreferences`), for a secure
  registration as well as the legacy one. A
  wrongly-delivered notification is a nuisance; a wrongly-dropped one is the
  product failing at its only job.
- `notifications.on_turn_complete = false` in `config.toml` stays the
  machine-wide master switch for `turn_complete` and wins over any per-device
  preference for it. It does NOT silence `turn_failed` (#1153): a failed turn
  is the one turn end a user must not miss by default, and only the per-device
  `turnFailed` preference mutes it.

**Constraints from real logs (2026-04-12 analysis, updated #718 2026-07-06):**

- Bash `PermissionRequest` may have `permission_suggestions=undefined` (no suggestions), a legacy plain-string label array (e.g. Edit's `["Yes","Always","No"]`), or — since ~Claude Code 2.0.54 — a STRUCTURED array of typed "permission update entries" (`addRules`, `addDirectories`, `setMode`, `removeRules`, `replaceRules`, `removeDirectories`, each carrying `behavior`/`destination`; ground truth: code.claude.com/docs/en/hooks).
- Notification message is plain text ("Claude needs your permission to use Bash"), no numbered options, and never carries `permission_suggestions` at all.
- Claude Code does NOT always offer a fixed option count. `optionsFromSuggestions` (hook-event-bridge.ts) builds a binary card by MEANING (#1126): [Yes] + one standing option per offerable suggestion (`setMode`, allow `addRules`; never `addDirectories`) + [No], capped at 4 total; with nothing offerable, the honest Yes/No 2-set (`optionsAreFallback: true`). A multi-choice string-label set maps label by label to picks. This is the hook's view, not the screen's (Claude's dialog does not render one option per suggestion, #1134), which is why a held card is answered through the hook and never typed.
- Numbered option text appears only in the terminal UI, not in hook events.
- `HookEventBridge` builds the option set at hook time; a binary card is held and pushed at once, and its answer is the hook response (#1126).
- A standing option is answered by echoing its `permission_suggestions` entry (`QuestionOption.suggestionIndex`) as `{behavior:"allow", updatedPermissions:[...]}` on the held hook. Verified live on Claude Code 2.1.287 (#1126 spike F4) for `setMode` and `addRules`; every echo is sent with `destination: "session"` (lead decision), and an echoed `addDirectories` did not stop the repeat prompt, so it is never offered.
- Redeploy the signaling server after any `packages/signaling/` change (the owner does; the steps are in `docs/relay-worker-deploy-runbook.md`, and no agent deploys).
