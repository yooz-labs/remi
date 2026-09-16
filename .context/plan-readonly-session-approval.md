# Read-only approval and session precedent plan

Status: implementation complete on `feature/readonly-session-approval`; awaiting review.
Approved by the user on 2026-09-16.

## Outcome sought

Reduce repeated, low-value permission cards while preserving the local-model
decision path and keeping genuinely risky or ambiguous operations visible to a
human. The two Remi daemons/sessions are intentional and remain separate.

## Evidence and root-cause hypotheses

1. The current `vcs-read` group covers `gh pr`, `gh issue`, and similar read
   commands, but not `gh api`. A safe GitHub API read therefore reaches the
   local model instead of the deterministic read path.
2. In the historical local log, a read-only `gh api` was escalated because the
   model treated the authority/context instructions as insufficient to permit
   a remote operation. The same operation was approved when the authority
   context was absent, which points to a prompt/context interaction rather
   than a model inability to recognize the command.
3. Historical “external resolution” entries are not proof of human answers;
   the code records reusable precedent only through the client/card answer
   path. The precedent feature is disabled in the current effective config and
   its stored key is command-only, so it cannot safely distinguish identical
   commands run in different projects.

## Chosen design

### Deterministic `gh-read` policy

Add a narrow `gh-read` permission group and include it in every shipped level.
It covers only syntax that can be proven to be an output-only `gh api` GET:
one endpoint, optional read/output flags, and explicit GET method forms. POST,
PATCH, DELETE, field/body/input flags, unknown flags, extra endpoints, and
shell-control forms continue to fall through to the model/human path.

This deliberately does not make arbitrary `curl`, `wget`, `ssh`, WebFetch, or
WebSearch silently approved. Remote reads are a separate egress policy and
remain opt-in until their destination and payload semantics are measured.

### Context-bound session precedent

Keep `Question.precedentSignature` command-only because it is sent to clients.
Store a normalized session working-directory context privately with each
precedent and require the current Remi session's canonical directory to match
before consulting approved or denied precedent. This remains stable if Claude
reports a changed hook `cwd` during the session. Missing context fails closed.
The existing per-session stores remain separate, so the two daemon sessions
cannot share answers.

Thread the session's canonical working directory through the bridge/gate/
service and from the answered session through the single `handleAnswer`
recording path. Do not add branch probing or raw cwd to the wire protocol in
this change.

Because the current effective user config explicitly sets
`session_precedent = false`, it is left untouched. The shipped default for new
or otherwise-unconfigured installs will be enabled after the cwd boundary is
implemented; an explicit user value still wins during config loading.

## Implementation phases and gates

1. **Characterization:** add tests for safe/unsafe `gh api` forms, level
   membership, wire-safe command-only signatures, same-directory precedent,
   cross-directory non-match, and missing-context fail-closed behavior.
2. **Policy:** implement the `gh-read` parser/veto, level/default/template
   updates, and deterministic matcher tests.
3. **Precedent:** add private context to store/reader APIs, thread the session
   directory through bridge/gate/service/answer handling, and add isolation
   tests.
4. **Acceptance:** run focused tests, typecheck/format checks, then replay the
   existing local corpus and perform a real local-model smoke test. Safe GETs
   must be 0 ms deterministic approvals; mutation-shaped requests must not be
   approved by `gh-read`; a precedent from another cwd must not authorize.

If an acceptance gate fails, retain the evidence and narrow/revert the
candidate rather than tuning the gate after inspecting the result. No live
daemon configuration, external log, SSH host, GitHub issue, push, or merge is
changed by this plan.

## Acceptance results

- `bun run typecheck`: passed.
- Targeted `bunx biome check` over the changed source and test files: passed;
  `git diff --check`: passed.
- Behavioral suite covering permission groups, configuration/levels, precedent
  storage and matching, wire-safe signatures, answer wiring, risk bands, and
  related auto-approve checks: **1,199 passed, 62 skipped, 0 failed** across
  11 files (1,835 assertions). The skipped cases are the repository's opt-in
  model-judgment cases.
- Final bridge/gate regression selection after making the canonical session
  directory explicit: **1,073 passed, 0 failed** across 8 files (2,045
  assertions), including the changed-hook-`cwd` consistency test.
- The broader focused selection reached **1,348 passed, 8 skipped, 29 failed**;
  every failure was the existing macOS/Bun `Bun.serve({ port: 0 })` ephemeral
  server collision (`EADDRINUSE`) in fixture-backed tests, not a behavioral
  assertion failure. This remains an environment limitation.
- The repository-wide gate `bun test --coverage --dots` reached **6,180
  passed, 71 skipped, 333 failed, and 2 errors** across 269 files. It is not a
  clean pass in this sandbox: the failures include fixed-port and ephemeral
  port contention, network/mDNS `EPERM`, protected `~/.remi` test writes,
  watcher timing, and the expected unavailable llama.cpp supervision path.
  No failure was in the focused decision assertions above, but a real
  integration checkout should rerun this gate with network and daemon-test
  permissions before merge.
- The 72-record fixture replay is a proxy corpus, not a complete sample of
  human-asked Remi prompts: strict approved 7 and left 65 residual; balanced
  and trusted each approved 15 and left 57 residual. WebFetch/WebSearch rows
  were approved by the current explicit user `allow` list, not by `gh-read`;
  the corpus contains no `gh api` rows, so the new group is measured by its
  adversarial unit tests and live smoke instead.
- Against the already-running local QAT engine (`yooz`,
  `YoozLabs/Qwen3.5-4B-qat-lean-4bit-mlx`, loopback `:19924`), with the smoke
  config cloned in memory so the user's config was not changed:
  `gh api /repos/yooz-labs/remi/pulls --paginate` returned deterministic
  `approve` in 0 ms via `gh-read`; `gh api -X POST /repos/yooz-labs/remi/issues
  -f title=pwned` reached the local model and returned `escalate` in 4.3 s.
  No GitHub command was executed and no remote state was changed.

The current `/Users/yahya/.remi/config.toml` remains untouched. Its explicit
`session_precedent = false` and custom approval lists therefore still govern
the existing installation; the new defaults apply to new or otherwise
unconfigured installs, unless the user explicitly opts in/out during config
loading.

## Explicit residuals

- A user-defined broad `allow` rule can still intentionally bypass the model;
  existing config is not rewritten by this change.
- Exact command plus cwd is the precedent scope. Git branch identity is not
  probed synchronously; branch-changing operations remain outside the new
  read group and must pass their existing policy.
- Bun 1.4.2/macOS `Bun.serve({ port: 0 })` test-harness collisions and failed
  historical MBA SSH authentication are verification limitations, not proof
  that this policy is correct or incorrect.
