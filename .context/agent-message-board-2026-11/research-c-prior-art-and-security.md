# Agent message board: prior art, protocols and security (research C)

Part of #1801. Written 2026-11-17 by research agent C.
Scope: protocols, existing projects, failure modes, security models, UX.
Remi's own code (research A) and each harness's mechanisms (research B) are out of scope.

## 0. Method and legend

- "Read" means I fetched and read the page or file myself (WebFetch, or a shallow clone read with `grep` and `sed`).
  WebFetch of some pages passes through a small summarizing model, marked "(summarized)"; Claude Code docs pages came back verbatim.
- "Search only" means I saw the claim only in a web search result snippet; treat as unverified.
- "Ran" never appears: I ran no downloaded code and no agent.
- All URLs were read on 2026-11-17.
- Clones (untrusted data, read only) live under `/Volumes/S1/yooz/remi/cache/message-board-research/`:
  `mcp_agent_mail` (9138f34, 2026-11-01), `claude-peers-mcp` (640183f, 2026-04-26), `agent-deck` (80494e5, 2026-11-16).
- Web queries were generic (protocol, product and technical terms only).

## 1. Protocols

### 1.1 Agent2Agent (A2A)

Source: https://a2a-protocol.org/latest/specification/ (read, summarized, three chunks; sections 1 to 14 seen, §3 and §4.1.x bodies partly cut off).

- **Purpose:** discovery and task exchange between independent agent servers, possibly from different vendors.
- **Version:** latest released 1.0.0 (spec header); `A2A-Version` header on every request (§3.6).
  The `vibe-agi/a2a-adapter` page says it verifies v1.0.1, wire protocol `1.0` (https://pkg.go.dev/github.com/vibe-agi/a2a-adapter, read).
- **Transports:** JSON-RPC, gRPC, HTTP+JSON/REST, all required to be functionally equivalent (§1.3, §9 to §12).
  Streaming is SSE-like events; push is a webhook (plain HTTP POST to a client-supplied URL).
- **Message model:** `Task` (unit of work, persistent state, history, artifacts), `Message` (one turn, role user or agent, made of `Part`s), `Artifact` (output, made of Parts), `contextId` groups tasks.
  States: SUBMITTED, WORKING, COMPLETED, FAILED, CANCELED, REJECTED (terminal), INPUT_REQUIRED, AUTH_REQUIRED (interrupted) (§4.1.3).
  Event order: "All implementations MUST deliver events in the order they were generated" (§3.1.6).
  Webhooks are at-least-once; "Clients SHOULD process notifications idempotently" (§4.3.3, §13.2).
- **Identity and auth:** an Agent Card (JSON at `/.well-known/agent-card.json`) names endpoints, skills and `securitySchemes` (API key, HTTP, OAuth 2.0, OIDC, mTLS).
  "The server MUST authenticate every incoming request" (§7.4); authorization is "implementation-specific" (§7.5).
  Card signing (JWS plus JCS canonicalization) is optional: "MAY be digitally signed" (§8.4).
  An optional `tenant` routing field exists on operations.
  In-task credentials: "Credentials SHOULD be bound to the agent which originated the request" and entering AUTH_REQUIRED "MUST NOT be assumed to authorize subsequent messages" (§7.6.3, §7.6.4).
- **Security gaps I verified in the text (§13, read):** SSRF checks on webhook URLs are SHOULD; no nonce, timestamp or signature for webhooks (replay not addressed); rate limiting is SHOULD; section 13 has no text on prompt injection.
  `messageId` appears in examples, but I did not find it defined as an idempotency key (unknown; §3 not fully read).
- **Fit for interactive terminal CLIs:** poor as a wire protocol, good as vocabulary.
  A2A assumes each peer is a server that owns a task and answers; an interactive TUI session is a human-facing process with a composer, not a request handler.
  Evidence that people adapt anyway: `vibe-agi/a2a-adapter` wraps one CLI agent per process via Claude's long-lived stream-json control protocol and Codex's `codex app-server`, maps tool gating to an `auth-required` task, gives anonymous loopback callers a built-in `local` principal, requires mTLS or a shared principal on non-loopback binds, and its resubscribe "does not replay the discrete SSE events missed while disconnected" (read).
  That adapter drives programmatic modes, not the interactive terminal UI, which is exactly the gap a Remi board would fill.
  `synapse-a2a`, `a2acode`, `a2a-bridge` also exist (search only; synapse-a2a page failed to load).
- **What it would take to adapt:** a hub-side facade that presents each Remi session as an A2A-like endpoint (card, Task, Message, contextId), plus a delivery adapter per harness.
  Cheap and valuable: borrow the task state names (especially INPUT_REQUIRED and AUTH_REQUIRED, which match "the agent needs you"), `contextId` for thread grouping, `messageId`, `tenant`.
  Not worth it at first: gRPC, discovery registries, card signing for a one-machine hub.

### 1.2 Model Context Protocol (MCP)

Source: https://modelcontextprotocol.io/specification/2026-07-28/changelog (read, verbatim) and https://modelcontextprotocol.io/seps/2663-tasks-extension (read, large, grepped).

- **Purpose:** an agent (client) calls tools and reads resources on a server.
  It is not an agent-to-agent protocol; messaging is whatever tools a server exposes.
- **2026-07-28 revision (changelog):**
  - stateless core: no `initialize` handshake, no `Mcp-Session-Id`; version and capabilities ride in every request's `_meta`;
  - `server/discover`;
  - `subscriptions/listen`, a long-lived POST-response stream for opted-in server-to-client change notifications (tool, prompt, resource list changes and resource subscriptions), not a general mailbox;
  - SSE resumability and redelivery removed ("A broken response stream loses the in-flight request");
  - Tasks moved to the extension `io.modelcontextprotocol/tasks` (`tasks/get` polling, `tasks/update`, `tasks/cancel`, no `tasks/list`);
  - server-initiated elicitation and sampling replaced by Multi Round-Trip Requests (`resultType: "input_required"`);
  - Roots, Sampling and Logging deprecated;
  - OpenTelemetry `traceparent` conventions in `_meta`.
- **Tasks extension security text (SEP-2663, read):** "task ID becomes the only line of defense against contamination" when no auth context can be bound, which is why `tasks/list` was dropped; task IDs "MUST" have enough entropy not to be guessable; auth checks on each task request.
- **Messaging and notification patterns that exist today:**
  - Pull: an agent calls a `check_inbox` style tool (MCP Agent Mail, `claude-peers-mcp` fallback).
  - Push into a running Claude Code session: the Claude-specific `claude/channel` capability, see 2.1 (Channels).
    The Channels page notes a channel server that negotiates MCP revision 2026-07-28 is not registered on the "v2 MCP client runtime" (https://code.claude.com/docs/en/channels.md, read), so push delivery is coupled to a moving, vendor-specific mechanism.
- **Fit:** a board exposed as an MCP server works on every harness that speaks MCP, but only as pull (the agent must decide to call it).
  Push needs a harness-specific nudge (hook, channel, or typing into the PTY).
  Tool descriptions are themselves an injection channel (see 3.2).

### 1.3 Agent Client Protocol (ACP, editor to agent)

Source: https://agentclientprotocol.com/protocol/overview and /protocol/transports (both read, summarized).

- **Purpose:** an editor or other UI client drives a coding agent; JSON-RPC 2.0, modeled on LSP.
- **Transport:** only stdio is defined ("currently defines one transport mechanism"); a Streamable HTTP remote transport "is being specified in the transport RFD" (not yet a standard as of the page).
- **Message model:** `initialize`, `session/new`, `session/load`, `session/prompt`, `session/update` notifications (message chunks, tool calls, plans, mode changes), `session/request_permission` (agent asks client), `session/cancel`.
  Optional client methods: file read/write, terminals, `elicitation/create`.
- **Identity and auth:** the client launches the agent as a subprocess; authentication is agent-specific via an `authenticate` method.
  Multiple clients per agent and agent-to-agent are not addressed on the pages I read.
- **Fit:** the closest standard to "a UI steers one interactive coding session", so it is relevant to the human-to-agent side of Remi (phone as the client), not to agent-to-agent.
  A claim of an ACP "1.0 spec" came from a blog (search only, unverified).
  The acronym collides with IBM's Agent Communication Protocol, reported as merged into A2A in August 2025 (search only).
  `a2acode` reportedly bridges ACP agents to A2A (search only).

### 1.4 Other and 2026 successors

- Agentic AI Foundation (Linux Foundation, formed 2025-12-09, MCP governance moved there) and A2A under Linux Foundation stewardship; AGNTCY (Cisco) donated to the Linux Foundation (all search only: https://www.linuxfoundation.org/press/linux-foundation-welcomes-the-agntcy-project-to-standardize-open-multi-agent-system-infrastructure-and-break-down-ai-agent-silos appeared in results, not opened).
- Agent Network Protocol (ANP): no results found; unknown.
- I found no 2026 protocol that standardizes "mailbox between interactive CLI sessions".
  The de facto designs are vendor-specific (2.1) and community MCP servers (2.2).

## 2. Existing projects and products

### 2.1 Claude Code's own features (read, https://code.claude.com, 2026-11-17)

**Cross-session messaging** (https://code.claude.com/docs/en/cross-session-messaging.md, verbatim):
- Model: push into a running session; `ListAgents` and `SendMessage` tools; on by default from v2.1.224.
- Delivery: "The receiving Claude reads the message between tool calls during an active turn. When the receiving session is idle, Claude Code starts a new turn with the message."
- Transport: per-session Unix domain socket restricted to the OS user (fallback dir `/tmp/cc-socks-<uid>`), a per-session token `CLAUDE_CODE_MESSAGING_TOKEN`; cross-machine goes through Anthropic servers via Remote Control.
- Provenance: the receiver is told the message came from another session, "not from you"; it "can't approve anything", "can't change configuration", slash commands arrive as plain text, and the receiver's own permission prompts still fire.
- Inbound controls (`crossSessionInbound`): `accept`, `hold` (approval dialog, 5 minute `dialogExpiry`, at most 100 held), `refuse`.
  Default when unset: sessions are classed as "bypass permission prompts" or "prompting"; a bypassing receiver holds every message unless the sender also bypasses, and a prompting receiver holds only messages from a bypassing sender.
- Limits: plain text only; about one million characters per message on the same machine; sender-side refusal after a rapid burst; receiver rate-limits per sender, drops identical repeats in a short window, queues at most 50; "A message loop between two sessions therefore stops on its own."
- Idle subscription: `notify_when_idle`, dropped after 12 hours.
- Human visibility: one dim line `Message from @name: first line... (ctrl+o to expand)` stays in the transcript; undelivered messages are listed under "Waiting to be delivered".
- Setting `isolatePeerMachines` requires approval before any message leaves the machine, even in bypass mode.

**Agent teams** (https://code.claude.com/docs/en/agent-teams, verbatim): experimental, one lead plus teammates.
- Mailbox: a JSON file per agent at `~/.claude/teams/{team}/inboxes/{agent}.json`; entries are validated on read and invalid ones removed; a message counts as sent only when the file write succeeds.
- Delivery: "delivered automatically to recipients"; idle teammates notify the lead with their final answer; shared task list with file-lock claiming.
- Humans: select a teammate in the agent panel and type to it directly; teammate permission prompts bubble to the lead; split panes need tmux or iTerm2.
- Security text: a teammate "can't approve a permission prompt or supply consent on your behalf"; in auto mode a classifier "reviews each message before Claude Code delivers it" and treats relayed approval claims as untrusted.
- Documented limits: no session resume for in-process teammates, one team per session, no nested teams, status lag, token cost scales per teammate, same-file edits overwrite.

**Channels** (https://code.claude.com/docs/en/channels.md, verbatim): research preview; an MCP server pushes events into a running session (`<channel source=...>` event); two-way with a reply tool.
- Security: per-channel sender allowlist bootstrapped by pairing code, "everyone else is silently dropped"; the channel must also be named in `--channels`; a channel that declares permission relay lets any allowlisted sender approve or deny tool use, so "only allowlist senders you trust with that authority."

**Agent view** (https://code.claude.com/docs/en/agent-view.md, summarized): see section 5.

**Subagents:** work inside one session and return results; named subagents can message each other (stated in the agent teams comparison table).

### 2.2 Mailbox and message-board projects for coding agents

| Project | Source read | Model |
|---|---|---|
| MCP Agent Mail (Python; superseded by a Rust rewrite) | clone 9138f34, README | MCP over HTTP; pull with reminder hooks |
| claude-peers-mcp | clone 640183f, README, `broker.ts`, `server.ts` | localhost broker; push via Channels |
| agent-inbox (PyPI) | search snippet only (page failed to load) | SQLite mailbox, HTTP plus stdio MCP; unverified |

**MCP Agent Mail** (`/Volumes/S1/yooz/remi/cache/message-board-research/mcp_agent_mail/README.md`, read):
- Identity: agents register a self-chosen memorable name per `project_key`; optional `registration_token` appears on some tools; per-agent `contact_policy`.
- Addressing and consent: project isolation by default; policies `open`, `auto` (default; allows when there is shared context such as same thread, overlapping file reservations or recent contact), `contacts_only`, `block_all`; a `request_contact` handshake sends an `ack_required` intro; `CONTACT_ENFORCEMENT_ENABLED` can be switched off.
- Delivery is pull: `fetch_inbox(unread_only, urgent_only, since_ts, limit)`; because agents forget to check, integration scripts install a `PostToolUse` hook that curls the inbox and prints a reminder "at most once per 2 minutes".
  The README records a delivery dead end: Codex's older `notify` program output "is discarded and never shown to the model, so a reminder printed there cannot reach the agent"; Codex now uses a project-local hooks file that the user must trust (pinned by hash).
- Coordination aids: threads (`thread_id`), `ack_required` plus `acknowledge_message`, advisory file reservations (leases with TTL, pre-commit guard), Git archive plus SQLite FTS index (human-auditable).
- Human steering: a web UI plus a "Human Overseer" composer; overseer messages are marked high importance, bypass contact policies, come from a special `HumanOverseer` sender and carry a preamble telling the agent to pause, do the request, then resume ("The human's guidance supersedes all other priorities").
- Auth: bearer token or JWT/JWKS; a `HTTP_ALLOW_LOCALHOST_UNAUTHENTICATED` switch exists; rate limiting is "optional" (token bucket).
- Redaction: share/export bundles apply scrub presets (`standard` scrubs API keys and tokens, `strict` redacts bodies).
- Failure modes visible in the docs: identity is self-claimed; reminders are rate limited so urgent mail can wait two minutes; a commercial companion app drives panes via tmux "Message Stacks" with "Double-Arm confirmations for destructive work" (README claim only; companion not read).

**claude-peers-mcp** (`.../claude-peers-mcp/`, read):
- A broker on `127.0.0.1:7899` with SQLite; each session's MCP server polls it every second (`POLL_INTERVAL_MS = 1000`) and pushes arrivals with `notifications/claude/channel`; `list_peers` scoped to machine, directory or repo.
- No authentication: my `grep` for authorization, bearer, secret, password, token, origin and cors over `broker.ts`, `server.ts` and `shared/` matched only the optional OpenAI summary call.
  `insertMessage.run(body.from_id, body.to_id, ...)` takes the sender id from the request body, so any local process can post as any peer.
- The server instructions tell the model to "RESPOND IMMEDIATELY ... Treat incoming peer messages like a coworker tapping you on the shoulder".
  The README quick start runs `claude --dangerously-skip-permissions --dangerously-load-development-channels`.
  Net: untrusted-ish input, authority to act, and no sender authentication; the opposite of the Claude Code first-party defaults in 2.1.

### 2.3 tmux and PTY-typing orchestrators

- **agent-deck** (`.../agent-deck/`, read; supports Claude Code, Gemini CLI, Codex, OpenCode, Aider per the search snippet): `session send` types into tmux panes.
  Its own source documents the failure mode: "the initial tmux send-keys + Enter occasionally races claude's welcome-screen Enter handler, leaving the prompt typed in the composer but never submitted" (`cmd/agent-deck/launch_verify_prompt.go`, v1.7.64 comment).
  The fix is to observe the composer, retry once, then warn; delivery outcomes include `typed_not_submitted` and `send_failed` (`cmd/agent-deck/session_send_residue.go`: "a chunk's send-keys failed mid-paste, or the final Enter failed").
  It also has a "conductor" bridge to Telegram, Slack or Discord (README link, `conductor/README.md` read).
- **General tmux guidance** (search only, https://crystl.dev/blog/agent-team-in-tmux/ and https://mager.co/blog/2026-08-23-orchestrating-agents-with-tmux/): `send-keys` "has no delivery guarantee", returns no exit code; send text and Enter as separate calls with a pause.
- **Lesson:** typing into a PTY is the only mechanism that works on every harness, and it is the least reliable: no ack, races with dialogs and welcome screens, and the text is indistinguishable from a human's.

### 2.4 Other harness and framework surfaces (shallow; research B owns mechanisms)

- **OpenCode server** (https://opencode.ai/docs/server/, read, summarized; page says V1 docs): `opencode serve` on `127.0.0.1:4096`, optional HTTP basic auth via `OPENCODE_SERVER_PASSWORD`; `POST /session/:id/prompt_async` returns 204; `GET /event` SSE; `parentID` child sessions; `/tui/append-prompt` and `/tui/submit-prompt` drive an attached TUI.
  Push-capable and structured; no message provenance concept on the pages read.
- **Codex subagents** (https://learn.chatgpt.com/docs/agent-configuration/subagents, read, summarized): `/subagents` switches threads; "Subagents inherit your current sandbox policy"; an approval request from an inactive thread "can surface ... even while you are looking at the main thread" with the source thread named; non-interactive runs fail the action back to the parent; `agents.max_concurrent_threads_per_session` caps parallelism; "The web sidebar ... doesn't provide controls to stop or steer an individual subagent."
- **Cursor** (search only): a follow-up can be sent now (applied "at the agent's next tool call") or queued; a forum post says iOS only queues; a REST endpoint adds an instruction to a running background agent; forum thread titles mention dropped follow-ups and a new session per follow-up (titles only, unverified).
- **LangGraph Agent Inbox** (search only): `interrupt()` pauses a graph, state persists, a human resumes with `Command(resume=...)` (approve or edit shown; a reject action not confirmed).
  Pull-style human inbox; relevant to the phone card pattern, not to agent-to-agent.
- AutoGen and CrewAI: not researched beyond noting they target API-driven agents, not interactive CLI sessions (no source read; unknown).

## 3. Design lessons and failure modes of agent-to-agent chat

### 3.1 Loops and runaway cost

- Evidence: one widely repeated story of two agents in a four-agent pipeline ping-ponging "clarify section 3.2" requests for about 11 days and roughly 47,000 USD (search only, vendor blogs selling cost control, likely one original source; treat as illustrative, not verified).
  Its stated lessons: no per-agent budget, no stopping rule, billing alert fired after the spend; a content hash would have caught the identical repeats.
- First-party mitigation that exists: Claude Code's per-sender rate limit, identical-repeat drop, queue cap of 50 and sender-side burst refusal (2.1, read).
- Takeaway: enforce limits before delivery (turn and hop counts per thread, dedup, per-pair rate), and make "stop" a human-visible control; alerts after the fact are not enforcement.

### 3.2 Prompt injection through peer messages (published work)

- **Prompt Infection** (Lee and Tiwari, arXiv 2410.07283, submitted 2024-10-09; abstract read): malicious prompts "self-replicate across interconnected agents"; their defense LLM Tagging marks agent-originated text; it "substantially slows" spread when combined with other safeguards.
- **Agent session smuggling** (Palo Alto Networks Unit 42, October 2025; read at https://unit42.paloaltonetworks.com/agent-session-smuggling-in-agent2agent-systems/): a malicious remote agent uses an open stateful A2A session to slip hidden instructions between a legitimate request and response; PoC leaked system instructions and tool schemas and triggered an unauthorized buy; "not a flaw in the A2A protocol itself" but implicit trust; not seen in the wild.
  Mitigations quoted: out-of-band confirmation "through a separate channel the LLM cannot influence", context grounding (flag drift from the original request and terminate), signed agent cards (prevents impersonation, "does not prevent a trusted agent from being subverted"), and show real-time agent activity to the user.
- **Threat model for multi-agent injection** (Paul and Nandy, arXiv 2609.22949, 2026-09-19, workshop-accepted; abstract read): 14 attack vectors in four classes including inter-agent injection and cascading orchestrator manipulation; in their six-agent testbed 67 percent of agents had at least one scope violation despite guardrails; four controls (signed provenance, boundary sanitization, per-role tool scoping, anomaly detection) cut success from 31.2 to 4.2 percent.
  Figures are the authors' own testbed numbers, not independently checked.
- **Rule of Two** (Meta, 2025-10-31, read at https://ai.meta.com/blog/practical-ai-agent-security/): within a session an agent should satisfy no more than two of: [A] processes untrustworthy inputs, [B] accesses sensitive systems or private data, [C] changes state or communicates externally; otherwise require supervision such as human approval.
  Meta itself says it is "a supplement, and not a substitute" for other controls.
- **Lethal trifecta** (Simon Willison, 2025-06-16, read): private data plus untrusted content plus external communication; "we still don't know how to 100% reliably prevent this."
- **Design patterns** (Beurer-Kellner, Tramer et al., arXiv 2506.08837; search snippets only): once an agent ingests untrusted input it must be constrained so the input cannot trigger consequential actions; dual-LLM and plan-first patterns; a general-purpose agent is unlikely to be made reliably safe.
- **CaMeL composition** (NeurIPS 2026 listing "Can CaMeLs Talk?"; listing only): guarantees do not compose when agents call agents; proposes a protocol preserving provenance across agent boundaries (claims unverified).
- **MCP tool poisoning** (Invariant Labs, 2025-04-01; search snippets): instructions hidden in tool descriptions; "rug pull" changes after approval.
  Relevance: a board's own tool descriptions and any peer-supplied "summary" or "role" fields are also model-visible input.
- **OWASP Top 10 for Agentic Applications 2026** (released 2025-12-09 per vendor summaries; primary document not read): ASI03 identity and privilege abuse, ASI07 insecure inter-agent communication; suggested defenses are per-agent identity, short-lived scoped credentials, mutual authentication, signed messages.

Implication for CLI sessions: a peer message is untrusted input that arrives with the authority of a user turn, and the receiving session often has file and shell access (conditions A, B, C all true).
Claude Code's answer is provenance plus restrictions, not filtering: tell the model the text came from another session, refuse approvals, config changes and slash commands from it, and default-hold between bypass-mode and prompting sessions (2.1).

### 3.3 Confused deputy and escalation across sessions

- A message from session A makes session B act with B's permissions; if B runs with prompts bypassed, A has effectively gained B's authority.
  Claude Code's default (hold when the receiver bypasses and the sender does not, deliver only between like classes) targets exactly this (read, 2.1).
- Agent teams: "A teammate that was denied an action can't relay it to another teammate to bypass the check" (read, 2.1); Claude Code also instructs senders never to ask another session for an action denied in their own session.
- A2A: in-task authorization is not transferable ("MUST NOT be assumed to authorize subsequent messages", §7.6.4) and credentials passed in band are exposed to every agent in a chain (§7.6.3).
- MCP: token passthrough is an anti-pattern and proxies need per-client consent (https://modelcontextprotocol.io/docs/draft/tutorials/security/security_best_practices, search snippet only).
- The hub itself is a deputy: if it can deliver typed input into any session, whoever can call the hub can type into every session.
  `claude-peers-mcp` shows the failure (no sender authentication, 2.2).

### 3.4 Context pollution

- Teammates start with no lead history and only the spawn prompt (agent teams page, read); cross-session messages are "never the sender's conversation history or files" (read).
  Both choose small, explicit text over shared context.
- Every delivered message "counts toward usage like a prompt you type" (read), so chatty boards cost tokens in the receiver and also displace its working context.
- Agent Mail's `unread_only` option exists to cut "token-burn for polling agents" (README, read).
- Takeaway: size caps far below a million characters, threads that summarize, and no automatic cross-posting of tool output.

### 3.5 Ordering, delivery and idempotency

- A2A: ordered event delivery per task, at-least-once webhooks, consumers dedupe, task and message ids (read).
  MCP 2026-07-28 deliberately removed stream resumability, so the client must reissue with a new request id (read), which makes sender-side idempotency keys the client's job.
- Claude Code: a message is "sent" only when the mailbox write succeeds (agent teams) and the sender is told on refusal ("Not sent", names the reason) (read).
- PTY delivery has no ack and can leave text typed but unsubmitted (agent-deck, 2.3, read).
- Agent Mail adds explicit `ack_required` and `acknowledge_message` for application-level acknowledgment (README, read).
- Takeaway: distinguish accepted by hub, queued for a session, handed to the harness, shown to the model, and acknowledged by the agent; never say "delivered" for a typed write; use an idempotency key and at-least-once plus dedup.

### 3.6 Human-in-the-loop and audit

- Out-of-band approval is the one mitigation every security source agrees on (Unit 42, Meta, Claude Code docs).
- Audit: Agent Mail keeps every message in Git plus SQLite; A2A requires logs to exclude credentials and personal data (§13.4, read); Claude Code keeps the preview line in the transcript.

## 4. Security and privacy model for a local hub carrying agent messages

Grounded in the sources above; items marked (proposal) are my synthesis, not something I found shipped.

1. **Hub-assigned identity, never self-claimed.** Agent Mail names are self-registered; claude-peers takes `from_id` from the request body.
   Claude Code binds a per-session token and socket (2.1).
   Proposal: the hub stamps every message with sender session id, harness, project directory and an origin flag (human, agent, system) that senders cannot set.
2. **Capability tokens per session.** A2A recommends "unique, single-purpose tokens for each push notification configuration" (§13.2); MCP requires high-entropy task ids as bearer tokens (SEP-2663); Claude Code uses a per-session messaging token (2.1).
   Proposal: a token scoped to one session and one project, revocable when the session ends.
3. **Scopes.** Project isolation by default (Agent Mail `project_key`); list scopes machine, directory, repo (claude-peers `list_peers`); working directory shown to disambiguate same-named sessions (Claude Code).
   Proposal: same repository or worktree by default; cross-project and cross-machine need an explicit human grant.
4. **Allow-lists of who may message whom.** Agent Mail's `open`/`auto`/`contacts_only`/`block_all`; Channels sender allowlist with pairing; a2a-adapter `--allow-peer` and fail-closed 403 (read); Claude Code `accept`/`hold`/`refuse`.
   Default-deny with a human-approved link is the common safe shape.
5. **Mode-aware delivery.** Claude Code's bypass-versus-prompting classing (2.1).
   Proposal: never deliver agent-origin messages to a session in a no-prompt or auto-approve posture without a human approving the thread once.
6. **Peer messages are untrusted input.** Frame them as agent-origin data (LLM Tagging; Claude Code's "came from another session, not from you"), refuse them any power to approve, to change configuration, or to run commands; never type them into a composer without a visible agent-origin marker (agent-deck shows why raw typing is indistinguishable from the human).
7. **Rate, size and loop limits.** Claude Code: per-sender rate limit, identical-repeat drop, queue cap 50, sender-side burst refusal, about 1M character cap; A2A: SHOULD rate-limit all operations; Agent Mail: optional token bucket.
   Proposal: much smaller default size cap (the 1M figure is a transport ceiling, not a context-friendly size), hop and turn limits per thread, and a per-pair budget.
8. **Expiry.** `dialogExpiry` 5 minutes, idle subscription 12 hours (Claude Code), webhook 10 to 30 second timeouts (A2A), `ttlMs` (MCP Tasks).
   Held and undelivered messages should expire and say so to the sender.
9. **Redaction and privacy.** Agent Mail scrub presets for exports; A2A logs must not hold credentials (§13.4); Claude Code: same-machine messages "never through Anthropic servers" while other-machine ones are.
   Proposal: scrub known secret patterns before storage and before phone push; keep message bodies out of push notification payloads.
10. **Cross-machine.** Claude Code `isolatePeerMachines` (approval before leaving the machine, even in bypass mode); a2a-adapter requires mTLS or a shared principal off loopback and warns not to use the shared principal "to separate mutually untrusted clients".
    A2A agent card signing is optional and was criticized by vendor analyses (search only).
11. **Local-socket hygiene.** Claude Code refuses to create its socket in a directory it cannot accept and restricts it to the OS user; OpenCode and Agent Mail make auth optional on loopback, claude-peers has none.
    Any local process running as the same user can still read process memory or tokens in environment variables, so tokens narrow blast radius, not remove it (reasoning, not a quoted source).

## 5. UX ideas for showing and steering a conversation

- **Agent view** (Claude Code, summarized): sessions grouped by state with "Needs input" near the top; a row shows a one-line status; Space to peek and reply; attach for the full session; detaching "never stops" the session; a reply to a working session joins a queue rather than interrupting; a reply to a permission prompt does not answer it ("Your message waits in the queue").
- **Message preview line** (Claude Code): sender name plus first line, expandable; undelivered messages listed separately.
- **Approval dialog for held messages** (Claude Code): shows sender and preview, Approve delivers one message, Deny or timeout drops it; this maps directly to a phone card.
- **Codex:** approval overlay names the source thread so you know which agent is asking; the web sidebar is read-only (no steering), a cautionary example.
- **Cursor** (search only): two verbs, send now (steer at the next tool boundary) and queue (after the task); mobile reportedly queue-only.
- **Agent Mail web UI** (read): threads, per-agent inboxes, search, file leases, and an Overseer composer where a human message is visibly special, high priority and bypasses contact policy.
- **LangGraph Agent Inbox** (search only): an inbox of interrupts with approve or edit on a pending tool call.
- **Unit 42 recommendation:** expose "real-time agent activity" and remote instructions so a human can spot a hijack.
- Proposals for a phone board: (a) thread view with sender badges (harness, project) and an unmistakable human versus agent origin; (b) a pause-all switch and per-thread stop; (c) hop counter and spend per thread; (d) held-message cards (approve once, always for this pair, deny); (e) a human "interject" that is clearly marked and interrupts only at a safe boundary; (f) quiet by default, notify only when a human is needed (Claude Code agent view notifies on needs input, finished, failed).

## 6. Comparison table

| Name | Model | Push or pull | Humans see it? | Main risk |
|---|---|---|---|---|
| A2A 1.0 | Task, Message, Artifact between servers | Both (SSE, webhooks, polling) | Only via the client app | No injection guidance; optional card signing; replay not addressed |
| MCP 2026-07-28 (+ Tasks ext.) | Tool calls, task handles, `subscriptions/listen` | Pull; push only for list changes | Via the host client | Not a messaging protocol; tool text is injectable; Channels coupled to older revision |
| ACP | Editor drives one agent, JSON-RPC | Client pushes prompts, agent streams updates | Yes, the editor is the human UI | stdio only; no agent-to-agent; remote transport unfinished |
| Claude Code cross-session messaging | Socket message between sessions | Push (between tool calls or new turn) | One-line preview, transcript, hold dialog | Confused deputy if both sides bypass; Claude-only |
| Claude Code agent teams | Mailbox JSON plus task list | Push inside team | Agent panel, talk to any teammate | Cost, file conflicts, no resume, experimental |
| Claude Code Channels | MCP server pushes events | Push | Inbound line in terminal | Allowlist misconfiguration; permission relay authority; preview-only |
| claude-peers-mcp | Local broker plus Channels | Push (1 s poll then channel) | CLI status only | No sender auth, "respond immediately" prompt, run with permissions bypassed |
| MCP Agent Mail | Inbox/outbox, threads, leases | Pull plus reminder hook | Web UI, Git archive, Overseer | Self-claimed identity; reminders rate limited; hook trust per harness |
| agent-deck, tmux send-keys | Type into panes | Push without ack | TUI dashboard, tmux | Typed-but-unsubmitted race, no provenance, no ack |
| OpenCode server | HTTP sessions, `prompt_async` | Push plus SSE | TUI/web attached | Optional auth; no provenance on pages read |
| Codex subagents | Parent spawns and waits on child threads | Parent-driven | `/subagents`, approval overlay | Inherits sandbox; web view read-only; not peer chat |
| a2a-adapter (Go) | A2A facade over one CLI agent | Push (SSE) | Via A2A client | One process per agent; no replay on resubscribe; programmatic mode only |
| Cursor follow-ups | Instruction to a running agent | Push (steer or queue) | App and web | Mobile queue-only (unverified); dropped follow-ups reported (titles only) |
| LangGraph Agent Inbox | Interrupt, human resume | Pull by human | Yes, inbox UI | Framework-bound, not CLI sessions |

## 7. Five design principles that follow from the evidence

1. **The hub, not the sender, says who spoke; peer text is data.**
   Stamp provenance the sender cannot forge, mark agent-origin text as such, and let it never approve, reconfigure or run commands.
   Evidence: Claude Code's inbound rules, Prompt Infection's LLM Tagging, Unit 42, the no-auth claude-peers failure.
2. **Deliver at safe boundaries and report honest delivery states.**
   Separate accepted, queued, handed to the harness, shown, acknowledged; use idempotency keys with at-least-once plus dedup; treat typed PTY writes as unverified.
   Evidence: agent-deck's `typed_not_submitted`, A2A webhook semantics, Claude Code "between tool calls" and sender-visible refusals.
3. **Default-deny addressing, scoped to project, with mode-aware consent.**
   Same-project by default, a human-approved link for anything wider, and no agent-origin delivery to a no-prompt session without approval.
   Evidence: Agent Mail contact policies, Claude Code's bypass-class default, `isolatePeerMachines`, Meta's Rule of Two.
4. **Bound every conversation before it starts costing money.**
   Hop and turn limits, per-pair rate, dedup of identical repeats, small size caps, TTLs and a budget, enforced pre-delivery with a visible stop.
   Evidence: Claude Code's throttles, the (secondhand) runaway-loop story, A2A rate-limit text.
5. **Keep the human outside the model's channel, and keep the record.**
   Approvals, pause and interjection travel on the phone, never through the message path; the full thread, with sender and outcome, is stored and visible.
   Evidence: Unit 42's out-of-band recommendation, Claude Code's hold dialog and agent view, Agent Mail's Git audit trail.
   Corollary on protocols: borrow A2A vocabulary (task states, `contextId`, `messageId`, INPUT_REQUIRED) and keep the wire local until a real interoperability need appears.

## 8. What I could not verify

- A2A: sections 3 (SendMessage) and 4.1.x bodies were not fully visible; whether `messageId` is an idempotency key is unknown; card-spoofing research found only through a vendor blog.
- ACP: whether a formal 1.0 exists; the state of the remote-transport proposal beyond the sentence on the transports page.
- ANP and any 2026 successor protocol: nothing found.
- `agent-inbox` (PyPI), `synapse-a2a`, `a2acode`, `a2a-bridge`: pages failed to load or were search snippets only; behavior and safety unknown.
- tmux orchestrators other than agent-deck: secondary blog claims only.
- Cursor behavior: docs and forum titles from search only; mobile steering status may be stale.
- LangGraph Agent Inbox: reject action not confirmed; AutoGen and CrewAI not researched.
- The 47,000 USD loop story: likely a single secondhand source; no primary postmortem.
- OWASP agentic list, the design-patterns paper, CaMeL multi-agent paper, MCP security best practices, Invariant tool poisoning: seen via snippets or abstracts, not full primary text.
- Claude Code features are recent and flagged experimental or research preview (agent teams, channels, agent view); version numbers and behavior may change; I did not run Claude Code, so none of its documented behavior was tested.
- Whether Codex or OpenCode will expose an equivalent of Claude Code's between-tool-call delivery (research B's scope).
- Cross-user and multi-user hub threats; Windows and Linux socket behavior.
