# Architecture decisions

Standing decisions for remi, as ADRs. **Read the relevant one before changing
behavior it covers.** Several exist specifically because the decision looks like
an inconsistency worth "cleaning up", and the cleanup would reopen a security
hole or a bug that took a long time to find.

Each ADR carries its **evidence**, not just its conclusion — the measurement, the
issue number, the verified behavior. A decision recorded without its evidence is
what [ADR 0011](0011-verify-before-you-describe.md) exists to prevent.

New ADR: copy [`0000-template.md`](0000-template.md), take the next number, and
add a row below.

## Index

| ADR | Decision |
|---|---|
| [0001](0001-transcript-path-source-of-truth.md) | Transcript path is the session source of truth |
| [0002](0002-model-b-hold-the-hook-notifications.md) | Hold-the-hook notification model; amended by 0030 and 0031: held again since #1126, with Claude's dialog visible and the first answer winning |
| [0003](0003-synchronous-permission-decisions.md) | Synchronous permission decisions; amended by 0030 and 0031: the hook answer is a human's phone answer to a held prompt, or the empty `passthrough` |
| [0004](0004-pty-as-arbiter-subagent-questions.md) | PTY is the arbiter for subagent questions; amended by 0030 and 0031: wrapper mode passes them to the terminal with a notice, daemon mode holds them |
| [0005](0005-hub-and-attach-only-clients.md) | Hub mode and attach-only clients |
| [0006](0006-cc-ref-disavowed.md) | `cc-ref` is not ground truth for Claude Code |
| [0007](0007-release-automation-and-pins.md) | Release automation and toolchain pins |
| [0008](0008-testflight-local-upload.md) | TestFlight uploads are local, not Xcode Cloud |
| [0009](0009-transport-encryption-scope.md) | Encryption is scoped to the relay; direct connections carry none |
| [0010](0010-allow-deny-matching-asymmetry.md) | Allow matching is precise, deny is broad — on purpose (superseded by 0030) |
| [0011](0011-verify-before-you-describe.md) | Security descriptions must be verified against code |
| [0012](0012-protocol-message-registry.md) | Protocol message registry is the single source of truth |
| [0013](0013-total-dispatch-handle-or-ignore.md) | Every protocol consumer declares handle-or-ignore, total over the registry |
| [0014](0014-two-sided-conformance-tests.md) | Contract tests must construct both shipping endpoints |
| [0015](0015-authority-bounded-by-counterfactual.md) | Authority may resolve ambiguity, never decide — amended 2026-08-02: graded authorization may decide, but text alone cannot grade above `implicit` (superseded by 0030) |
| [0016](0016-strictness-levels-are-groups-not-prose.md) | Strictness is level-gated group membership, never prose to the model (superseded by 0030) |
| [0017](0017-deny-floor-enforced-in-code.md) | A model-produced deny is silent, so it is floored in code (superseded by 0030) |
| [0018](0018-write-group-safety-is-three-independent-vetoes.md) | A write-approving group needs three independent vetoes (superseded by 0030) |
| [0019](0019-push-kind-mutability-asymmetry.md) | Push kinds are named on the wire; muting them is asymmetric; amended by 0030: alert patterns moved to `[notifications]`, no hook waits on delivery; amended by 0031: a fifth, per-device mutable kind, `harness_denied`; amended by #1153: a sixth, `turn_failed` (a turn ended on an API error), mutable per device, not muted by `on_turn_complete = false` |
| [0020](0020-client-status-cue-totality.md) | A client status cue must be total over its gate's end paths; amended by 0030: the cues it governed are gone, the rule stands |
| [0021](0021-registration-outcome-not-requery.md) | Question registration outcome flows from the call, not a re-query |
| [0022](0022-status-bar-never-freezes.md) | Status-bar liveness is bounded by `HEARTBEAT_MS`, never by a human |
| [0023](0023-artifact-deletion-is-proved-not-judged.md) | (proposed) Deletion approves only when the target is provably derived — amends #956's blanket escalate rule (superseded by 0030) |
| [0024](0024-loopback-bind-default.md) | The daemon binds loopback by default; off-machine access is opt-in (0023 is claimed by an un-merged branch) |
| [0025](0025-agent-scoped-permissions.md) | Permissions scope per agent_type: deny unions with base, allow/groups replace it (superseded by 0030) |
| [0026](0026-destination-checked-write-grants.md) | Write grants for decidable shell shapes (redirects, heredocs, sed -i), proven by destination (superseded by 0030) |
| [0027](0027-residual-action-deny-vs-escalate.md) | `residual_action` setting: deny-with-reason vs. escalate-to-human for a residual main-agent binary permission (superseded by 0030) |
| [0028](0028-narrow-remote-read-and-session-precedent-scope.md) | Narrow `gh api` reads and private working-directory scope for session precedent (superseded by 0030) |
| [0029](0029-capability-proofs-are-finite-and-group-gated.md) | Capability proofs are finite, effect-registered, and gated by requested groups (superseded by 0030) |
| [0030](0030-defer-permission-judgment-to-the-harness.md) | remi no longer judges permissions; the harness decides and remi relays what is still asked |
| [0031](0031-held-hook-answers-with-native-dialog-visible.md) | A binary prompt is answered through its held hook while Claude's dialog stays visible; first answer wins, nothing is typed; amended by #1127: AskUserQuestion and ExitPlanMode too, with a structured `updatedInput`; amended by #1155: chat and Stop read one prompt-up signal, subagent alerts come from the tool hooks, foreground-subagent holds recorded as unmeasured |
| [0032](0032-harness-seam-and-identity-shim.md) | Harness seam with Claude as the only implementation: `harness` and `harnessSessionId` are typed on the wire (emitted since #1179, see 0033), persisted Claude records store neither (absence means Claude, `version` stays 1), and `getIdentity` derives a Claude identity from `claudeSessionId` and returns null for an unknown harness; phase 2 adds the `Harness` descriptor (`gracefulExitInput`, `resumeArgs`, `transcriptPath`, no registry yet) behind the daemon's transcript-path, Stop and resume call sites; phase 3 moves Claude's launch out of `createNewSession` into `HarnessSession` (`createSession`), replaces the per-session gate, tracker and binder maps with one `harnessSessions` map (a `DecisionChannel` and `dispose()`), and adds the harness boundary ratchet test |
| [0033](0033-codex-adapter-app-server.md) | (proposed) The Codex adapter goes through Codex's shared app-server, never typed keys: a hand-rolled RFC 6455 client over `node:net` (Bun 1.3.11 has no `ws+unix`, 1.3.13 does), which answers server requests only with results and never logs a frame body; fixtures are redacted by an allowlist scan; phase 5 (#1179) dual-emits `harness` and `harnessSessionId` on `hello_ack`, `question` and the session list, advertises `harnesses` on every ack, validates a create request's `harness` and `args` at the trust boundary and spawns the child with them after `--`, refuses resume on a Codex daemon, and says what a headless Codex create cannot know |
| [0034](0034-relay-v2-protocol.md) | Relay protocol v2: transcript-bound handshake with a pairing secret and host-first authentication, counter-nonce AES-256-GCM with authenticated headers, an authenticated end of stream (BYE), one ordered send queue, one generic failure close, production keys from the engine (the scalar-import path fails on WebKit), strict canonical control frames; the Worker enforces admission; Noise not adopted |
| [0035](0035-protocol-version-and-capabilities.md) | `hello_ack` carries `protocolVersion` (an integer, 1, changed only by a breaking change) and `capabilities` (additive features a client cannot see in the messages, documented in `PROTOCOL_CAPABILITIES`; empty, since everything before is the baseline of version 1); clients decide with `hubSupport`, never by comparing `daemonVersion`; `serverVersion` is a constant kept for the WebView Mac app's decoder. For the relay v2 protocol, see 0034 |
| [0036](0036-workspaces.md) | (phase A) `create_session_request.workspace` names a repository and optionally a new branch and base; the hub checks the values as text, then with git (no shell, no inherited `GIT_*`), makes the worktree at `<parent>/remi-worktrees/<name>-<branch>` once a port is held, starts the session there and reports the workspace; new branches only, nothing deletes a worktree; `workspaces` is the first capability. Phases B (the workspace on the session list) and C (recent repositories) are planned |

## By area

Most work touches one of these clusters, and the ADRs in a cluster constrain
each other — reading one without its siblings is how a "fix" reopens the case
another one closed.

- **Permission decisions:** 0030 (current), 0031, 0003; historical, superseded by 0030: 0010, 0015, 0016, 0017, 0018, 0023, 0025, 0026, 0027, 0028, 0029
- **Questions + notifications:** 0031 (current), 0002, 0004, 0019, 0020, 0021, 0022
- **Protocol + contracts:** 0035, 0036, 0012, 0013, 0014, 0006
- **Sessions + transport:** 0001, 0005, 0009, 0024, 0032, 0033, 0034
- **Process:** 0007, 0008, 0011
