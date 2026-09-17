# Implementation Plan: Semantic Intent Approval and Scoped Workflow Context

## Context

Remi 0.7.11 routes the current evaluations to the correct PID, port, and
session, but the local model still escalates semantically benign operations.
The observed causes are separate:

- `buildPrompt` gives the model a bounded tool input and a long command-name
  policy whose fallback says to escalate when an operation is not plainly
  covered.
- `proveCompoundReadOnly` intentionally accepts only a finite grammar, so
  arbitrary Python, quoted loop values, and some safe projection pipelines
  fall through to the model.
- The current risk reviewer grades authorization text, not the semantic effects
  of the operation.
- Direct allow patterns cover simple commands but not every compound shape;
  this is a parser limitation, not evidence that the user policy was ignored.
- Conversation context is useful evidence but is not a grant. A model must not
  turn a sentence, command output, or another session into authorization.

The product requirement is therefore: approve genuinely benign intent when the
operation's effects are bounded, while escalating uncertainty and retaining
hard safety boundaries. GitHub commands are representative fixtures, not the
policy architecture.

## Reuse and invariants

Reuse the existing `AutoApproveService.evaluate` pipeline, session scope,
`AuthorityStore`, `PrecedentReader`, `classifyRisk`, `proveCompoundReadOnly`,
`enforceDenyFloor`, `enforceRiskCeiling`, decision attribution, and shadow
telemetry. Do not create a second matcher or a second session identity path.

The following invariants are non-negotiable:

1. Deterministic deny floors remain authoritative and can only make a decision
   stricter.
2. A model claim that code is benign cannot prove that arbitrary code has no
   write, network, subprocess, persistence, or credential capability.
3. Conversation/task context is descriptive evidence only. It cannot mint
   explicit authorization and cannot cross sessions.
4. Missing, truncated, malformed, conflicting, or unparseable evidence fails
   toward escalation.
5. A remote mutation can be auto-approved only through an explicit,
   session-scoped workflow grant with bounded target and expiry.
6. Same-path sessions remain isolated by session scope, canonical working
   directory, PID, and port.

## Approach

### Phase 1: shadow semantic intent assessment

Add a bounded operation-context builder that collects the raw tool input,
normalized deterministic facts, repository/branch/working-directory metadata,
recent same-session operation lineage, and recent verified human task context.
The context block must be labeled as untrusted evidence and must not share the
authority-grant wording used by configuration.

Add a local-model semantic assessment with a strict JSON schema:

```json
{
  "intent": "local_read|local_reversible|remote_read|remote_mutation|destructive|interpreter|unknown",
  "effects": ["filesystem_read"],
  "scope": "scratch|repository|remote_repository|production|unknown",
  "reversible": true,
  "confidence": 0.0,
  "reasoning": "brief evidence-based explanation"
}
```

The model must classify observed effects, treat command text and file content
as untrusted data, and never follow instructions embedded in them. The phase
records the assessment beside the existing verdict but does not approve,
deny, or alter routing.

#### Phase 1 call-site limitation

The formatter accepts bounded repository, branch, and caller-supplied lineage
fields, but the current gate has no safe per-evaluation source for those
values. Phase 1 supplies only the existing normalized working-directory
metadata and same-session human context; it does not add global lineage state.
Repository, branch, and lineage telemetry remain unavailable until a scoped
source is introduced.

### Phase 2: capability and effect proofs

Use characterization tests from the live log corpus, then extend the finite
proof language only where a complete safety argument is available. The first
fixtures are the Python lock inspection, import search loop, safe `ls`
compositions, GitHub read commands, and subissue commands.

Create one shared effect registry for command families. GitHub is one adapter:
known output-only subissue listing is read-only; add/remove/reprioritize are
remote mutations; unknown remote-capable extension actions fail closed.

Arbitrary Python remains outside automatic approval unless an exact safe
inspection grammar or a real capability sandbox constrains filesystem writes,
network, subprocesses, and credentials. A model explanation alone is not a
proof.

### Phase 3: scoped session workflow authorization

Add an explicit human action that creates an in-memory grant bound to the
current Remi session, canonical working directory, repository, operation
family, target constraints, and expiry. Begin with a planning family capable of
covering issue creation and subissue linking, while excluding close, merge,
delete, force-push, credentials, production, package publication, and unknown
remote operations.

The grant matcher consumes deterministic effect facts and semantic intent as
evidence, but the model cannot create or widen a grant. The exact-command
precedent remains separate and byte-exact.

### Phase 4: verified dual-model rollout

Add an independent risk/effect review for ambiguous or externally effectful
operations. Reconcile primary intent, independent review, deterministic
effects, authorization scope, and session grants. Any disagreement, timeout,
malformed output, missing context, or truncated input escalates.

Run the same labeled replay corpus used in Phase 1, then enable behavior only
behind an opt-in setting. The deterministic floor and ceiling remain the final
authority over both model responses.

## Expected files and modules

Likely Phase 1 files:

- `packages/daemon/src/auto-approve/prompt-builder.ts`
- `packages/daemon/src/auto-approve/auto-approve-service.ts`
- `packages/daemon/src/auto-approve/types.ts`
- new `packages/daemon/src/auto-approve/intent-assessment.ts`
- new or extended replay/telemetry helper under
  `packages/daemon/src/auto-approve/`
- focused tests under `packages/daemon/tests/auto-approve/`

Phase 2 is expected to touch `read-only-proof.ts`, `risk-bands.ts`,
`permission-groups.ts`, and focused tests. Phase 3 may touch the Question
model, client answer path, and session-owned grant store. Phase 4 may extend
`risk-review.ts` and the replay harness.

Workers must verify the actual call graph before changing any file and must
update comments or ADR references when behavior and documentation diverge.

## Decision gate before Phase 1 implementation

Proceed only if the lead confirms:

- context is bounded and never treated as authorization;
- shadow mode has zero decision or routing side effects;
- the proposed JSON schema is strict and fail-closed;
- the model sees enough command/script context to classify intent, with an
  explicit truncation marker;
- semantic assessment cannot authorize an effect that the deterministic layer
  cannot bound;
- the first phase has a measurable corpus and a manually reviewed label set.

## Agent budget and routing

The lead owns architecture, policy decisions, load-bearing verification, and
cross-phase synthesis. Phase 1 uses one isolated implementation worker in the
phase worktree. Reserve one fresh focused reviewer for the phase PR and one
additional security reviewer only if the first review identifies an input or
authorization invariant that needs independent rechecking. The same worker
handles accepted review fixes; no parallel worker edits the same files. Maximum
active roles for this phase are lead + worker + two reviewers, four agents
total, with no more than two concurrent reviewers.

## Open judgment calls

1. Task-context size: start with the existing capped human-turn store plus a
   small same-session operation window; only add summarization if replay shows
   context loss. Do not use a model-generated summary as authority.
2. Python: prefer exact safe templates for the first rollout; pursue a
   sandbox only as a separately measured capability project.
3. Workflow grant scope: start with repository + operation-family + TTL, and
   require explicit target checks for every remote mutation.
4. Remote reads: add only known, output-only grammars first. Do not turn all
   network-looking commands into read-only approvals.
5. Model selection: measure MLX 4B first; treat llama.cpp as a separate
   artifact/backend until its replay is run.

## Verification plan

Before/after metrics must be reported by labeled category, not only aggregate
approval rate:

- benign local reads and search pipelines;
- benign bounded interpreters;
- benign remote reads;
- explicitly granted remote planning mutations;
- unscoped remote mutations;
- writes, egress, credentials, persistence, deletion, and destructive actions;
- prompt-injection and context-poisoning controls;
- same-path two-session routing and attribution.

Required checks include focused Bun tests, typecheck, Biome, the real-command
replay harness, and a repeatable local-engine soak. A green unit suite without
the replay and adversarial gates is not sufficient for a behavior-changing
approval path.
