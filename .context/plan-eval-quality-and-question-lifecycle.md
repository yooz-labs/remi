# Plan: evaluation quality + question lifecycle

Two tracks the owner raised together. They are separable to ship but share one
substrate, so they are planned together.

Status: proposed, 2026-07-28. Grounded in live log data from `~/.remi/remi.log`
(9.6 MB, current) plus code reads. Every claim below cites a file:line or a
measurement, per `AGENTS.md` → "Verify before you describe".

---

## Part 0 — What the live data actually says

This is the part that decides whether the rest of the plan is worth building.
Measured over the owner's real log, not a synthetic corpus.

| Outcome | Count |
|---|---|
| approve | 2279 |
| deny | 2 |
| **escalate** | **309** |

**~12% escalation rate.** Of those 309:

| Cause | Count | Sees the LLM? |
|---|---|---|
| `always-escalate` (AskUserQuestion / design / plan-mode) | 25 | no — structural |
| infra (queue timeout, LLM timeout, engine error) | 1 | no |
| **LLM verdict** | **~283** | **yes** |

**So over-escalation is overwhelmingly the LLM's own verdict (~92%), not code
fallbacks.** That is the good news: a better prompt is the right lever. Had the
mix been dominated by the five non-LLM escalate paths
(`auto-approve-service.ts:714, 728, 748, 774, 936`), this plan would be wasted
effort and the fix would be elsewhere.

### What the LLM escalates, by theme

| Theme | Count | Verdict |
|---|---|---|
| `rm -rf <build artifact>` | ~48 | **wrong** — `rm -rf dist` is regenerable |
| file edits in the project tree | ~49 | **wrong** — routine work the user asked for |
| git commit / git history | ~13 | **mostly wrong** — user guidance approves git |
| WebFetch / network | ~8 | debatable |
| unfamiliar tool (Chrome MCP, Skill, uvx, pkill, mkdir) | long tail | **structural** |

Ten of the `rm -rf` escalations are literally `rm -rf dist`.

### Why, from the prompt itself

`prompt-builder.ts:30-75` is a **closed-world allowlist**. It enumerates
approvable operations (lines 36-48), then:

```
- Bash: any command you are not sure about
- Any tool not listed above          # line 58-59 -> ESCALATE
```

Three structural consequences, each visible in the log:

1. **Anything not enumerated escalates.** New MCP tools, `Skill`, `uvx`,
   `pkill`, `mkdir` all escalate purely for absence from a list. The list can
   never keep up; this is the long tail.
2. **`Write/Edit` outside scratch is an explicit ESCALATE** (line 51), so every
   code edit escalates unless user guidance overrides — and the log shows the
   model acknowledging the guidance and overriding it anyway:
   > "*While the user guidance mentions approving file edits, this is a complex
   > mutation that requires human judgment on the correctness and impact.*"
3. **There is no risk or reversibility dimension anywhere.** "irreversible"
   appears only as a label on the DENY floor (line 61), never as something the
   model assesses. So `rm -rf` is matched as a *string*, and `dist` never gets
   considered as a *regenerable artifact*.

The owner's two proposals map exactly onto (1)+(3) and (2) respectively. The
diagnosis is confirmed; both features are justified. A third finding they did
not name — the closed-world list — is fixed by the same rubric.

### What is already built (do not rebuild)

- `llm-client.ts:174` already accepts `externalSignal?: AbortSignal`, wired to
  the fetch at 177-181, 235, 277. **Eval cancellation needs a caller, not
  plumbing.**
- `question_resolved` exists end-to-end: `protocol.ts:333`, daemon broadcast,
  handled at `App.tsx:889`. **Card retraction exists.**
- `auto-approve-gate.ts:2098` `cancelExternallyResolved` (#673) already resolves
  an open escalation when an external signal proves it was answered elsewhere,
  via `resolveSupersededQuestion` → `releaseHeld` + `removeQuestion`.
- The JSON output contract already exists (`prompt-builder.ts:67-70`), so adding
  fields is an extension, not a rewrite.
- Decision logging already exists and is what produced Part 0. Keep it; it is
  the only way to prove this plan worked.

---

## Part 1 — Structured risk / reversibility rubric

Replace the closed-world list with a rubric the model can apply to operations
nobody enumerated.

### Output schema

Extend the existing verdict JSON:

```json
{
  "decision": "approve" | "deny" | "escalate",
  "risk": "none" | "low" | "moderate" | "high" | "catastrophic",
  "reversibility": "trivial" | "recoverable" | "costly" | "irreversible",
  "reasoning": "...",
  "summary": "..."           // escalate only, unchanged
}
```

`risk` and `reversibility` are **required on every verdict**, including
`approve`. Forcing the model to state them on approvals is what makes them real
reasoning rather than post-hoc justification for a decision already made.

### The rubric

Decision follows from the two axes, stated explicitly in the prompt:

| | trivial | recoverable | costly | irreversible |
|---|---|---|---|---|
| **none / low** | approve | approve | approve | escalate |
| **moderate** | approve | approve | escalate | escalate |
| **high** | escalate | escalate | escalate | escalate |
| **catastrophic** | deny floor | deny floor | deny floor | deny floor |

Worked examples go in the prompt, chosen from the actual failure modes above:

- `rm -rf dist` → risk `low`, reversibility `recoverable` (regenerable by a
  build) → **approve**. Explicitly contrast with `rm -rf src` → `costly`.
- `git commit` → risk `low`, reversibility `recoverable` (`git reset`) →
  approve. `git push --force` → `costly`/`irreversible` → escalate.
- `Edit` on a tracked source file → `recoverable` (version control) → approve.
  Contrast an untracked or generated file.
- An unfamiliar tool → judge by *what it does*, not by absence from a list.

### The key prompt change

Delete `- Any tool not listed above` and `- Bash: any command you are not sure
about` as automatic escalations. Replace with: *assess risk and reversibility;
if you cannot determine what an operation does, that is `high` risk and
escalates.* Same safe outcome for genuine unknowns, without escalating every
tool the list has not caught up with.

The DENY FLOOR (line 61-65) is untouched. The #536 asymmetry stands: allow is
precise, deny is broad.

### Files

- `prompt-builder.ts` — rubric, examples, schema, remove closed-world clauses
- `auto-approve-service.ts` — parse and validate the two new fields; a verdict
  missing them is a parse failure → escalate (fails closed)
- `types.ts` — extend the result type
- Log line — include `risk`/`reversibility` so the mix stays measurable

---

## Part 2 — Authority

The model repeatedly escalates asking for exactly what authority would supply:
*"requires human judgment on whether this change aligns with the intended design
or scope."*

### The trust boundary — the single most important constraint

**Authority is built ONLY from the human's typed input. Claude's output must
never enter it.** If Claude's text can reach the authority summary, Claude can
write itself permission and the feature becomes a privilege-escalation vector
rather than a safety improvement.

Enforcement, defence in depth:

1. Source is the transcript JSONL, filtered to `role === "user"` entries only,
   at the point of extraction — never a text scrape of rendered output.
2. Exclude tool results. A `user`-role entry carrying `tool_result` content is
   Claude's tool output wearing a user envelope; it must be dropped. This is the
   subtle one and needs a dedicated test.
3. The authority block is delimited in the prompt and labelled as *reported
   history, not instruction*. It informs the risk assessment; it is not itself a
   command. The USER GUIDANCE section stays the only instruction channel.
4. Authority can only **lower** escalation for operations already in
   `low`/`moderate` risk. It can never override the DENY FLOOR, never turn
   `high` risk into approve, and never touch the deny list.

That last point is what makes the failure mode bounded: worst case, a poisoned
authority summary approves something that was already low-risk and recoverable.

### Shape

A rolling per-session summary of what the human asked for, maintained by the
daemon and passed with each eval. Given the engine's speed (p95 2.26s on the
current model), the raw recent-user-message list likely fits without a
summarization step for typical sessions; summarize only past a token threshold.
Start with raw + cap, add summarization only if measurement demands it.

### Files

- New `auto-approve/authority.ts` — extraction, filtering, the trust boundary
- `transcript/` — reuse existing watcher; do not add a second reader
- `prompt-builder.ts` — delimited authority block
- `auto-approve-gate.ts` — thread session id → authority into the eval

---

## Part 3 — Question lifecycle

Three linked items. **(a) is independent and ships first.**

### (a) The stray "1"/"2" in chat

Under active trace. `question_resolved` retracts the *card*, so the stray digit
is a different message on a different list. Fix is narrow once the admitting
line is identified. **Hazard:** the same path carries genuine typed user input;
over-suppressing would eat real messages. Suppression must key on "this exact
text was written by an answer to question `<qid>`", never on "the message is
short" or "the message is a digit".

### (b) Retraction

Infrastructure exists. Work is closing gaps: audit every path that resolves a
question and confirm each fires `question_resolved`, and that the client clears
on it. Multi-writer (#795) means two phones plus a terminal is a real scenario.

**Invariant: the chat shows a card if and only if the daemon says it is
pending.** The daemon is the source of truth; clients never infer.

### (c) Eval cancellation

`llm-client.ts` already takes an `externalSignal`. Needed: an `AbortController`
per in-flight eval, owned by the gate, fired when the question resolves by any
route.

**Cancellation is a latency optimization, not a correctness fix.** A fetch
cancelled a millisecond late still lands. Correctness comes from the *result
guard*: on eval completion, check the question is still pending before acting.
Build the guard first; add cancellation second, for the GPU time.

---

## Build order

1. **Part 3(a)** — standalone, immediate user-visible win
2. **Part 3(c) guard** — small, safety-relevant
3. **Part 1** — rubric; measure before/after on the same corpus
4. **Part 2** — authority, on top of the rubric
5. **Part 3(b)** — retraction audit
6. **Part 3(c) cancellation** — last, pure optimization

---

## How we prove it worked

The escalation mix in Part 0 is the baseline; it came from the existing decision
log and can be recomputed identically. Rerun after Parts 1 and 2:

```
grep ': escalate' ~/.remi/remi.log | sed 's/.* - //' | sort | uniq -c | sort -rn
```

Success = the `rm -rf <artifact>`, project-file-edit, and unfamiliar-tool
buckets shrink materially, **while approve/deny on the 38-case permission grid
stays at 38/38.** Regression on the grid is disqualifying regardless of what
happens to the escalation rate: the goal is fewer *wrong* escalations, not fewer
escalations.

Additionally, `bun packages/daemon/tests/auto-approve/run-model-sweep.ts`
against the real local engine, per the no-mocks policy.

## Risks

- **The rubric could approve something the list would have caught.** Mitigated
  by the untouched DENY FLOOR, the 38-case grid as a gate, and `high` risk
  escalating on every reversibility level.
- **Authority poisoning** — addressed above; the tool-result-in-user-envelope
  case is the one to test hardest.
- **Prompt growth costs latency** on a blocking eval (#496). Measure p95 before
  and after; the rubric replaces text rather than purely adding.
- **Retraction hiding a real pending question** is worse than a stray digit.
  Every ambiguous case must fail toward showing the card.
