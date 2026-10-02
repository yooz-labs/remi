# Competitive review: remote control of coding agents

Date: 2026-10-01.
Method: vendor docs, pricing pages, GitHub repositories and changelogs, read on this date by a research pass and spot-checked (Paseo's repo, license, relay and push code; Codex Remote docs; Kilo mobile docs; Moshi hooks docs; star counts, licenses and last-push dates).
Anything that can go stale is dated. Unconfirmed items are listed at the end; do not use them in marketing.

## Headline

Between February and September 2026, Anthropic and OpenAI both shipped first-party phone control for their agents, and at least six free, OSI-licensed tools now cover most of remi's feature list (Happy, Paseo, T3 Code, HAPI, Vicoa, Remodex).
remi's real differentiation is narrow today, and part of it depends on work not shipped yet (the relay, Codex and OpenCode support).

## Feature matrix

Abbreviations: RC = Claude Code Remote Control; E2E = end-to-end encrypted; APNS = Apple Push Notification service; ZDR = zero data retention; OSI = Open Source Initiative.

| Product | Harnesses | Runs where | Data through vendor? E2E? | Mobile | Start session from phone (machine + folder) | Multi-machine | Background sessions | Approval push + answer | Local models | Price / license |
|---|---|---|---|---|---|---|---|---|---|---|
| **remi (today)** | Claude Code (Codex, OpenCode planned) | Your machines | Direct: no vendor. Relay: Cloudflare Worker, E2E not working by default (#881). Push title and body (tool + command) cross the Worker and APNS in plaintext | iOS (Capacitor), web; Android build in repo, store status unchecked | Yes | Yes, weakly (no machine object, socket-per-session) | Hub + LaunchAgent, survives reboot | Yes; lock-screen Yes/No/Always/Multi actions | remi is not in the model path; untested with API-key, Bedrock or gateway auth | Free; Apache-2.0 core (daemon, CLI, protocol); PolyForm Shield apps and relay (from the release containing #1128) |
| **Claude RC + Claude app** | Claude Code | Your machine | Everything via the Anthropic API over TLS; transcripts stored at Anthropic; not E2E | iOS, Android, web | Partial: only folders where `claude remote-control` runs or folders registered in Desktop; general request open (#96867, 2026-09-24) | Yes | `claude` process must keep running | Push when action is required; answer in app; lock-screen actions not documented | No: refuses API keys, Bedrock/Vertex/Foundry, custom `ANTHROPIC_BASE_URL` | Pro and Max; Team/Enterprise if admin enables; ZDR and HIPAA orgs excluded |
| Claude agent view (`--bg`, `claude agents`) | Claude Code | Your machine | Model API only | None | n/a | No | Survives terminal close, not shutdown | Terminal notifications only | Works through gateways | Included; research preview |
| Claude cloud sessions | Claude Code | Anthropic cloud | Yes | iOS, Android, web | Repo + branch, not a machine | n/a | Yes | In app | No | Subscription |
| **Codex Remote** (GA 2026-06-25) | Codex | ChatGPT desktop app host; `codex remote-control` CLI host experimental | "Secure relay"; E2E not stated | ChatGPT iOS/Android | **Yes**: connected computer + project | Yes | Host must stay awake | Push (open delivery bugs #32908, #33300); approve in app | CLI `--oss`; unconfirmed with Remote | Plus and up; CLI Apache-2.0 |
| GitHub Copilot CLI remote + cloud agent | Copilot | Local CLI / Actions | Session events to GitHub; no E2E | GitHub Mobile, web | CLI no; cloud agent picks a repo | Unconfirmed | Machine must stay awake | Live Activities; approve/deny in app | Bring-your-own provider incl. Ollama | Pro $10 and up |
| Cursor (cloud agents, My Machines) | Cursor agent | Cursor VMs or "My Machines" workers (agent loop in Cursor cloud) | Yes; no E2E | iOS app (2026-06-29) | Repo + worker | Yes | Cloud yes | Push on finish or needs input | Not documented | Paid; proprietary |
| **Kilo Code** | Kilo agent only | `kilo remote` locally, or Kilo cloud | Via Kilo Gateway; E2E undocumented | iOS, Android (2026-07-01) | **Yes**: machine + nested folder | Yes | Unconfirmed | "Needs input" push; lock-screen Approve / Live Activity | Yes | Free for individuals; MIT |
| **Happy Coder** | Claude, Codex, Antigravity, OpenClaw, ACP (OpenCode) | Your machine | Server stores ciphertext; E2E (AES-256-GCM); self-hostable; push via Expo | iOS, Android, web, macOS | Yes (machine + directory + worktree) | Yes | Daemon | Push on completion and permission; answer in app | Undocumented | Free, MIT; 24.0k stars |
| **Paseo** (v0.10.2, 2026-09-29) | Claude, Codex, Copilot, OpenCode, Pi, Antigravity, Muse, ACP | Your machines | Direct by default (loopback), opt-in E2E relay (Curve25519/NaCl), self-hostable; push via Expo with short preview | iOS, Android, desktop, web, CLI | Yes (host + cwd) | Yes | Headless daemon | Push on finished/error/permission | Via harness | Free, Apache-2.0, no login; 19.2k stars |
| T3 Code | Claude, Codex, Cursor, Grok, OpenCode, Antigravity | Your machines | LAN/Tailscale, or T3 Connect (Clerk + Cloudflare Tunnel; E2E undocumented) | iOS (2026-07-29), Android | Yes | Yes | `t3 service install` | Push + Live Activities (needs T3 Connect) | Via harness | Free, MIT; telemetry; 24.1k stars |
| HAPI | 10 harnesses | Your own hub | Optional WireGuard + TLS tunnel | PWA, Telegram Mini App | Yes | Yes | Unconfirmed | Native push with approve/deny/reply actions | Via harness | Free, AGPL-3.0 |
| Vicoa | Claude, Codex, OpenCode, "40+" | Your machines | Hosted relay, no E2E claim; self-hostable | iOS, Android | Unconfirmed | Yes | Unconfirmed | Push on decision or finish | Unconfirmed | 1 machine free; $12/mo; AGPL |
| Remodex | Codex, OpenCode | Mac | E2E relay | iOS | Unconfirmed | Unconfirmed | launchd | In-app only | Unconfirmed | From $3.99/mo; Apache-2.0 |
| **Moshi** | 17+ agents in a terminal | Your machine (SSH/mosh) | Terminal direct; approval text via Moshi's server | iOS, Android | Only by typing in the terminal | Yes | tmux/mosh | Lock screen, Apple Watch, Live Activity | Via harness | Free tier; $7.99-9.99/mo |
| Nimbalyst | Claude Code, Codex | Your desktop | E2E sync Worker | iOS | Yes (project) | Unconfirmed | Desktop app must run | Push on completion/error/approval | Unconfirmed | Free; MIT |
| Conductor | Claude, Codex, Cursor, OpenCode | Mac, or Conductor Cloud | Cloud chats stored by Conductor; no E2E | iOS (2026-09-14, Pro) | Cloud agents only (local unconfirmed) | Unconfirmed | Cloud yes | Unconfirmed | Vague | Free; Pro $50/mo; closed source |
| VibeTunnel | Any terminal | Your Mac/Linux | No vendor server | Web/PWA | Yes (directory picker) | Yes | Unconfirmed | Bell/finish web push; no structured approvals | Via harness | Pay what you want; MIT |
| Warp | Warp agent + CLI agents | Local or Warp cloud | Remote Control uploads session state to Warp | Mobile browser | Cloud agents only | Unconfirmed | Cloud | Desktop only | Public endpoint needed | Free; $20 and up |
| OpenCode built-in | OpenCode | Your machine | `serve`/`web` direct; share links upload to opncd.ai | No official app | Via web UI | No | `serve` | None | Yes | MIT |
| DIY (Termius/Blink + tmux + Tailscale + ntfy hooks) | Any | Your machines | Direct; ntfy/Pushover if added | Termius, Blink | Yes (SSH) | Yes | tmux | Only with hook projects | Yes | Low cost |

Exited or pivoted: Terragon (shut down 2026-02-09), Roo Code (archived 2026-05-15), Vibe Kanban's company (shut down 2026-04-10), Crystal (replaced by Nimbalyst 2026-02-26), Omnara (relaunched 2026-09-09 as a managed-agents platform).
No mobile or remote features: Claude Squad, Sculptor, Gemini CLI (mobile relay request closed as not planned).

## The competitors that matter most

- **Claude RC** (code.claude.com/docs/en/remote-control, launched 2026-02-24): the strongest threat for Claude users. Server mode with up to 32 sessions, per-session worktrees, multi-machine list, approval pushes, attachments, diff pane. Subscription only; transcripts stored at Anthropic; ZDR orgs cannot enable it.
- **Codex Remote** (learn.chatgpt.com/docs/remote): already does "pick computer + project" from the phone. Host is the ChatGPT desktop app; not available on API-key, Free or Go accounts.
- **Paseo** (github.com/getpaseo/paseo): the closest overlap with where remi is heading. Multi-harness daemon, loopback default, opt-in self-hostable E2E relay, native apps on both stores, permission push. Free, Apache-2.0, no login.
- **Happy** (github.com/slopus/happy): mature E2E self-hostable server, session composer (machine, agent, worktree), 1,018 App Store ratings.
- **Kilo, HAPI, Moshi**: the bar for lock-screen and Watch approvals.
- **Conductor**: the UX bar for a native Mac app; its iOS app reaches its cloud agents.

## Where remi stands

**Genuinely different (verified):**

1. No vendor in the path on direct connections. Claude RC stores transcripts at Anthropic; Codex, Copilot and Cursor route through their own servers.
2. Works where Claude RC is unavailable by policy: API keys, Bedrock, Vertex, Foundry, LLM gateways, ZDR and HIPAA orgs. **Needs one remi test under each auth mode before it is claimed.**
3. No subscription tier required (RC needs Pro or above; Codex Remote needs Plus or above).
4. Any folder on any machine, for Claude Code; Anthropic limits this to pre-registered folders.
5. Lock-screen answers: different from Claude RC, Codex, Happy and Paseo (none documented); parity with HAPI, Kilo and Moshi.
6. Reboot-surviving hub: better than Claude agent view and RC; parity with T3 Code and Remodex.

**Behind or at parity:**

- Harness breadth: Claude only, while Paseo, Happy, T3, HAPI and Moshi ship Codex and OpenCode.
- Off-network reach: no working relay; peers ship E2E relays and first-party tools work off-network out of the box.
- Push privacy: command text crosses the Worker and APNS in plaintext (parity with Paseo and Moshi at best).
- License: the apps and relay stay PolyForm Shield (source-available, not open source) while most peers are MIT, Apache or AGPL end to end; the core (daemon, CLI, protocol) is Apache-2.0 from the release containing #1128.
- Android store presence, voice, traction (19-24k stars for peers), first-party polish (diffs, attachments, model switching).
- Reliability: answers from the notification and the Watch have dropped in practice (#665), and the default install did not push binary prompts until `fix/no-service-binary-push`.

**Potentially unique, not built:** the Yooz tie-in (on-device dictation into prompts via Yooz Whisper; local models via yooz-engine and OpenCode).

## Positioning

Candidate statements, each grounded in a verified difference:

1. "Your coding agents on your phone, through your own machines. Direct connections never touch a server."
2. "Works where Claude Remote Control is not allowed: API keys, Bedrock, Vertex, gateways, zero-retention orgs." (after a verifying test)
3. "Start a session in any folder on any of your machines, not only the folder where you left a server running."
4. "Approve from the lock screen. Sessions that survive a reboot."
5. "No Claude or ChatGPT subscription tier required."
6. "Claude Code and Codex, every Mac and Linux box you own, answered from the lock screen." (only once Codex ships)

Claims to avoid until true: "end-to-end encrypted" (#881), "peer-to-peer", "private notifications", "no cloud" while the Worker carries relay or push traffic, "open source" about the apps or the relay (PolyForm Shield is not open source; say it only of the daemon, CLI and protocol, and only from the release containing #1128), "harness-agnostic" until a second harness ships, and anything implying remi judges permissions.

## Unconfirmed (do not use in marketing)

- Lock-screen action buttons for Claude RC, Codex, GitHub Mobile, Cursor, Happy, Paseo, T3 and Vicoa.
- Whether Claude `--bg` sessions can attach to Remote Control.
- Codex Remote: relay E2E; CLI-only or Linux host support; Free/Go eligibility; `--oss` with Remote.
- Kilo relay encryption; lock-screen Approve for local `kilo remote`.
- Conductor mobile reaching local workspaces; Conductor push.
- Vibe Kanban relay after shutdown; T3 Connect E2E; HAPI relay operator; Vicoa encryption; Happy push payload contents.
- remi itself under API-key, Bedrock or gateway auth; Android store status.
