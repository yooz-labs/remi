# Epic #494 — Synchronous permission decisions + permission groups

## Problem (evidence)

Real run, `remi --auto-approve` 0.6.2 (daemon pid 41966, session `82d6c6a6`, a
`/review-pr` with parallel subagents). The failure cascade, repeated dozens of
times in `~/.remi/remi.log`:

```
[AutoApprove 82d6c6a6] Bash: approve (7489ms)                       # 4B LLM, 6-8s, for a pure read
[AutoApprove 82d6c6a6] Subagent Bash: skipping inject "1" (approved); no prompt visible on main PTY (agent=a4de5cc3 ...silent-failure-hunter)
Question detected: Do you want to proceed?...                      # OutputProcessor leaks it to the app
Answer ... : 1
Ignoring stale answer: questionId 48ac7a2f... not in pending [...] # the tap lands on a superseded id
```

Window counts: 23 subagent approvals skipped, 20 stale-answer rejects, 58 real
injects (main agent, worked fine).

Four root causes -> the five user complaints:

| Symptom | Cause |
|---|---|
| "all from a PR review" / "auto-approve read-by-definition w/o LLM" | No built-in read-only fast-path; only the user `allow` list (default `Read/Glob/Grep`, bare tool names) bypasses the LLM. Bash reads (`git show \| sed`) hit the 6-8s LLM. |
| "responded 8 times, stuck, only the terminal resolved it" | Subagent approvals computed but inject **skipped** (`auto-approve-gate.ts:258`): remi answers only by typing into the PTY; for parallel subagents it can't tell whose prompt is on screen, so it skips all. |
| "two questions which is not one, both expired" / "expire although not up" | Skipped prompt **leaks** via OutputProcessor; pending list grows to 6-8 ids; the displayed one is always behind the head -> stale-answer. |
| "no context, just Do you want to proceed?" | PTY parser captures only the bare prompt; the hook's `tool_name`/`tool_input` is never merged in. |

**Root architecture:** remi answers permissions by **PTY injection**
(`hook-server.ts:191` always returns `'{}'`). That structurally cannot handle
off-screen / parallel subagent prompts and races the eval against the PTY render.

## Decision: synchronous hook-response decisions

Verified against the live Claude Code docs (code.claude.com/docs/en/hooks):
HTTP hooks are **synchronous decision points**. For `PermissionRequest`, a 2xx
body `{ "hookSpecificOutput": { "hookEventName": "PermissionRequest",
"decision": { "behavior": "allow" | "deny", "updatedInput"? } } }` is honored
and Claude proceeds **without rendering the prompt**. (`PreToolUse` uses
`permissionDecision: allow|deny|ask`.) Default hook timeout 600s, so a ~7s LLM
eval can block the response fine.

So: stop injecting "1"/"3"; return the decision in the hook response. Read-by-
definition ops approve instantly via configurable groups; LLM verdicts block the
response; only genuine escalations render a prompt (and carry tool/command
context). This fixes latency + the subagent skip + the leak + stale-answers at
the root.

## Current flow (as-is)

- `hook-server.ts handleRequest` -> `dispatch(body)` fire-and-forget -> always returns `'{}'`.
- `AutoApproveGate.handlePermissionRequest` -> `AutoApproveService.evaluate()` (deny pattern 0ms -> allow pattern 0ms -> multichoice -> LLM) -> `inject('1'|'3'|pick)` via `pty.submitInput`, gated for subagents by `tracker.isPromptVisibleOnPTY()`.
- `#484` buffer-until-verdict in `QuestionPresenceTracker` holds the PTY prompt while evaluating; releases on escalate. This whole buffer + the subagent PTY-presence gate exist **only because** answers go through the PTY.

## Phases

### Phase 1 (#495) — Permission groups + expanded command matching  [config layer, still injects]

- Built-in named groups (curated pattern sets), new module `auto-approve/permission-groups.ts`:
  - `read-only`: tools `Read`/`Glob`/`Grep`/`NotebookRead`; Bash read commands `cat head tail less sed -n rg grep egrep ls find wc file stat jq awk(read) cut sort uniq diff column tree`.
  - `vcs-read`: `git show|log|diff|status|branch|blame|remote -v|ls-files|rev-parse|describe|tag -l|stash list`; `gh pr view|diff|list|checks|status`, `gh issue view|list`, `gh run view|list`, `gh api` (GET, no `-X`/`-f`/`-F`/`--field`).
  - `build-test`: `bun test`, `bun run typecheck`, `tsc --noEmit`, `biome check`, `bunx biome check`, `eslint`(no `--fix`), `bun run lint`, `pytest`(read), `uv run pytest`.
- `config.toml` `[auto_approve]`: `approve_groups` / `deny_groups` (arrays of group names), alongside existing `allow`/`deny`. Order: deny_groups + deny patterns FIRST (any match -> deny), then allow_groups + allow patterns (any match -> approve), then LLM. Unknown group name -> validation warning, ignored.
- Matcher: command-segment-aware **prefix** matching for group command patterns. Split the Bash command on `&&`, `||`, `;`, `|` (respecting quotes minimally) into segments; a group pattern matches if any segment, after trimming leading `env`/`sudo`?-No (sudo never in read groups), starts with the pattern token sequence (word-boundary). So `git show` matches `cd x && git show ...` but NOT `git showoff`, and a read pattern never matches a write because writes aren't in the read set AND a deny group can pre-empt. Keep user `allow`/`deny` as substring (back-comaptible).
  - **Safety invariant (tested adversarially):** no read/vcs/build pattern may match a mutating command. E.g. `git diff` must not match `git diff > x` (redirection) — segment scan treats `>` as outside; be conservative: if a segment contains shell redirection/`$(`/backticks to an unknown sink, do NOT group-approve (fall through to LLM). Document the conservative bias.
- Still answers via PTY injection (no architecture change). Removes the 6-8s latency for read-by-definition ops. Leak fix is Phase 2.

### Phase 2 (#496) — Synchronous hook-response decisions  [the architecture change]

- `hook-server`: add a `resolvePermission(input): Promise<PermissionResolution>` seam. For `PermissionRequest`, `handleRequest` awaits it and serialises the 2xx body. `allow`/`deny` -> behavior; `escalate` -> body that lets Claude render the prompt (`{}` or `behavior:"ask"` — confirm which CC honors), then surface the question as today.
- `AutoApproveGate.handlePermissionRequest` returns the decision instead of injecting. Read-only groups resolve ~0ms; LLM verdicts block (remi eval timeout, << 600s).
- Concurrency: parallel read-only subagent perms fast-path (no `evaluating` contention -> they short-circuit before it). Parallel LLM perms still serialise (2nd escalates) — acceptable; queue is a later optimisation, `log()` it.
- Retire PTY injection for auto-approve verdicts. The subagent PTY-presence skip gate and the `#484` buffer become dead for auto-approve (remove in Phase 3, or guard here).
- **Real-Claude e2e** (extend `tests/e2e/transcript-binding/`): subagent-heavy session; assert read-by-definition perms auto-allow with NO prompt rendered, no question flood, no stale-answer.

### Phase 3 (#497) — Escalation context + cleanup

- Merge `tool_name` + `tool_input` (command) + agent label into the escalated question text/subtitle. Truncate long inputs.
- Remove dead PTY-injection answer path + subagent skip gate + `#484` buffer.
- Update `AGENTS.md` / docs for the synchronous model + groups.

## Out of scope / sequencing

Epic #481 phases 5 (terminal escalation cue + mobile badge) and 6
(answered-anywhere-clears-everywhere + APNS token pruning) are **postponed**
until this epic lands, then resumed.

## Test discipline

No mocks. Real domain objects + spy sinks (matches the existing
`auto-approve-gate.test.ts` style). Each phase independently green:
`bun run typecheck` + `bunx biome check` + `bun test` (excl. the Ollama-gated
auto-approve LLM suite when Ollama is down). Real-Claude e2e at Phase 2.
