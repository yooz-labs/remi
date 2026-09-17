# Curated Permission-Bank Replay

The permission bank is the repeatable evaluation corpus for the verified
read-only auto-approve path. It lets changes to proof, prompts, context
handling, and dual review be tested without asking the user to reproduce a
live Claude session for every iteration.

## What is in the bank

`packages/daemon/tests/auto-approve/permission-bank.ts` is the source of truth.
Each record has:

- provenance: `observed`, `hypothetical`, or `adversarial`;
- a stable category and ID;
- the exact command text;
- simulated session, path, repository, branch, and recent-operation context;
- an authority variant; and
- expected deterministic proof, final decision, reviewer-call count, and
  rationale.

Observed records come from the real command shapes that exposed the original
escalation problem, including branch/worktree inventories, the `uv.lock`
inspection, the import-search loop, GitHub reads, and `git ls-remote`.
Hypothetical records extend the same bounded read families. Adversarial
records cover mutation, credentials, egress, interpreters, privilege, and
persistence. Unsupported-but-plausibly-safe commands are retained as
explicit fail-closed records; an escalation there means proof coverage is
missing, not that the model has been measured wrong.

The bank deliberately does not execute any command. The replay-only context is
inserted into tool input as untrusted data, so tests also verify that machine
text, command output, topical statements, and another session cannot mint
authorization. Session A and Session B use the same path with different session
scopes to exercise routing isolation.

## Offline gate

Run the deterministic guard chain and a fixture-backed pair of reviewer calls:

```bash
bun run test:permission-bank
```

The fixture derives its response from the code-owned verified effects and facts
that the service sends to the reviewers. It is intentionally not a model
quality score. It proves that every labeled case traverses the actual proof,
risk, authorization, scope, and reviewer-call gates, and that the expected
fail-closed behavior remains intact.

## Optional local-model replay

The live runner is opt-in and loopback-only. It streams cases and settled
verdicts to stdout, one case at a time, and never executes a bank command:

```bash
BANK_LIVE=1 BANK_PROVIDER=llamacpp BANK_LIMIT=24 \
  bun run replay:permission-bank
```

The runner defaults to the local llama.cpp endpoint and GGUF model used by the
Linux deployment. It accepts `BANK_BASE_URL`, `BANK_MODEL`,
`BANK_TIMEOUT_SECONDS`, and `BANK_ENABLE_THINKING=1`. Narrow replays can use
`BANK_SOURCE`, `BANK_CATEGORY`, `BANK_AUTHORITY`, `BANK_IDS` (comma-separated),
or `BANK_LIMIT=0` for all selected records. An explicit `BANK_IDS` list always
runs in full and is not truncated by the default smoke limit. With no filters,
the default 24-case smoke run is category-stratified so it includes both safe
and fail-closed families. Custom endpoints must resolve to `localhost`,
`127.0.0.1`, or `::1`.

The production client currently consumes one bounded JSON completion per
review, so “stream” here means the replay cases, results, and selected
telemetry—not raw model-token streaming. The runner reports per-category and
overall results; investigate any unexpected approval before changing the
corpus or weakening a guard.

## How to extend it

Add a record only with a provenance label and a rationale. For an observed
failure, preserve the original command text and add the relevant context
variant rather than normalizing away the shape that failed. For a new safe
approval, first add a deterministic proof and a focused proof test; then add
the bank record and its expected reviewer behavior. Add an adversarial twin
for every newly widened grammar where a shell operator, interpreter, remote
target, credential, or persistence mechanism could change the effect surface.

The corpus is a regression and rollout gate, not permission to bypass the
existing deterministic deny floor, risk ceiling, session scope, or
fail-closed behavior.
