# Approval-rate baseline (Phase 1, epic #1057 / #992)

Baseline numbers for how much of a real corpus the deterministic layers
(`allow`/`deny`/`approve_groups`/`deny_groups`, #1024's `evaluateDeterministic`)
already decide with no LLM call, what shape the misses have, and how the live
LLM path itself behaves. Produced by
`packages/daemon/tests/auto-approve/run-approval-rate-report.ts` over
`packages/daemon/tests/auto-approve/approval-rate.ts`.

Every number below was read off a real run on 2026-08-15 (repo rule, AGENTS.md
"Verify before you describe"). Two machines: the primary dev Mac ("local",
remi 0.7.7, `level = "trusted"`) and a MacBook Air ("mba", remi 0.7.7 — its
`remi.log` spans older versions too; until 2026-08-15 it silently ran
`strict` because its config had no `level` key, see #1058).

## Prerequisites

A real corpus is gitignored and never committed
(`packages/daemon/tests/auto-approve/fixtures/.local-command-corpus.jsonl`).
Generate one from a machine that has been running remi with
`REMI_HOOK_DEBUG=1` (so `~/.remi/hook-diag.jsonl` has real captures):

```bash
bun run packages/daemon/tests/hooks/fixtures/build-hook-corpus.ts \
  --mode structure-preserving [--input ~/.remi/hook-diag.jsonl]
```

This writes
`packages/daemon/tests/auto-approve/fixtures/.local-command-corpus.jsonl`,
the report's default `--input`.

## Commands

Coverage report against the default corpus, at the shipped default level
(reads `~/.remi/config.toml`, or built-in defaults if absent):

```bash
bun packages/daemon/tests/auto-approve/run-approval-rate-report.ts
```

Sweep all three strictness presets against the same corpus, ignoring
whatever `approve_groups` the config file happens to have:

```bash
for level in strict balanced trusted; do
  echo "=== $level ==="
  bun packages/daemon/tests/auto-approve/run-approval-rate-report.ts --level "$level"
done
```

Dedupe repeated `Bash` commands before replay (closer to "distinct
operations seen" than "raw hook-event volume"):

```bash
bun packages/daemon/tests/auto-approve/run-approval-rate-report.ts --level trusted --unique
```

Add the live decision-log section (verdict/band/decided_by rates, latency
p50/p95, queue-timeout and risk-ceiling counts) from a real `remi.log`:

```bash
bun packages/daemon/tests/auto-approve/run-approval-rate-report.ts \
  --level trusted --log ~/.remi/remi.log
```

Machine-readable output (same computed data as the tables, one JSON object):

```bash
bun packages/daemon/tests/auto-approve/run-approval-rate-report.ts --level trusted --json | jq .
```

## Corpus caveat for this baseline

Neither machine had a usable `PermissionRequest` corpus on 2026-08-15:
hook-diag capture is gated on `REMI_HOOK_DEBUG=1` (hook-server.ts) and the
local machine's only capture window (142 events, ending 2026-08-08) contains
ZERO PermissionRequest events; mba has no `hook-diag.jsonl` at all. The
corpus half below therefore uses `--event PreToolUse` (12 unique records — a
PROXY population that includes calls Claude Code's own allowlist approved
without asking remi) and is small-N; the LOG half is the load-bearing part of
this baseline. #996's corpus numbers (1183 PermissionRequests, 12.9%
coverage at trusted) remain the reference for the asked-remi population.
Re-run the corpus half after a capture window with `REMI_HOOK_DEBUG=1` on a
working session.

## Numbers

Corpus captured: 2026-08-15, local machine, `--event PreToolUse --unique`,
12 unique records (see caveat above).
Headline config: `~/.remi/config.toml`, `level = "trusted"`.

### (a) Deterministic coverage (PreToolUse proxy corpus, --unique)

| Level | Total records | Approve | Deny-covered | Residual | Coverage % |
|---|---|---|---|---|---|
| strict | 12 | 4 | 0 | 8 | 33.3 |
| balanced | 12 | 5 | 0 | 7 | 41.7 |
| trusted | 12 | 5 | 0 | 7 | 41.7 |

Per-tool (trusted): Bash 2/4, Edit 1/1, Read 2/2, SendMessage 0/4,
ToolSearch 0/1. (SendMessage/ToolSearch are session-tooling events the proxy
population includes; they never reach the auto-approve gate in production.)

### (b) Miss classification (residual Bash commands, by shape)

Small-N on this corpus: 2 residual Bash commands, both `redirection`, both
`moderate`. The reference distribution for the real asked-remi population is
#996's: redirection 50%, pipeline 25%, heredoc 13%, chained 7%, single 6%.

### (c) Band distribution of the LLM-bound residue

7 residual records, all `moderate` on this corpus (the high-band shapes —
ssh/scp, git push, package installs — did not occur in the 12-record window;
the LOG half below shows them at volume).

### (d) Live decision log

Format note: lines WITHOUT a `[band=...]` bracket are counted `fast-path`.
On logs predating #1040 (mba's log reaches back before it) that bucket also
contains OLD-format post-LLM verdict lines, so mba's fast-path count is
inflated; a `0ms` duration is the reliable deterministic marker.

**local** (`~/.remi/remi.log`, through 2026-08-15): 29198 lines,
aa-non-decision 314, fast-path 157, llm-path 275, queue-timeout 0,
risk-ceiling 4.

| verdict | n | p50 | p95 |
|---|---|---|---|
| approve | 228 | 0ms | 17672ms |
| escalate | 199 | 5258ms | 25124ms |
| cancelled | 5 | 10778ms | 15725ms |

Notable: `escalate|high|*` = 88 vs `approve|high|*` = 0 — the high band is
structurally unapprovable by the model (#976's unwired matrix half);
`approve|moderate` = 87 vs `escalate|moderate` = 100 — the model escalates
the majority of moderate-band operations despite `authority=yes` (#972).
Overall approve rate 228/432 = 52.8%; excluding the 141 deterministic
`approve|none` fast-path lines, the LLM layer approves 87/287 = 30.3%.

**mba** (`~/.remi/remi.log`, spans multiple versions through 2026-08-14):
139943 lines, aa-non-decision 4669, fast-path 3528, llm-path 525,
queue-timeout 15, risk-ceiling 19.

| verdict | n | p50 | p95 |
|---|---|---|---|
| approve | 2301 | 9423ms | 41442ms |
| deny | 9 | 24778ms | 33186ms |
| escalate | 878 | 11595ms | 32767ms |
| cancelled | 367 | 5684ms | 26226ms |
| error | 498 | 30001ms | 175736ms |

Notable: 498 ERROR verdicts with p50 30001ms — the engine timing out at its
30s ceiling, an entire failure class invisible until this tally; approve p50
9423ms (the Air's LLM is slow enough that "approved" still means a ~10s
hang); `escalate|high|*` = 141 vs `approve|high|*` = 0 (same ceiling wall);
`escalate|none` = 513 (always-escalate + queue-timeout + old-format lines).
Overall approve rate 2301/3555 decided = 64.7%.

## Open questions for Phase 2

- Redirection is the top miss bucket in both #996 (50%) and this proxy corpus
  (2/2) — Phase 2's destination-checked redirect/heredoc coverage attacks the
  right bucket first.
- mba's 498 engine-timeout errors and 9.4s approve p50 are a latency/
  reliability problem no coverage phase fixes — they cap how good the LLM
  path can ever feel on that hardware and strengthen the case for Phases 4-5
  (deterministic widening + precedent) carrying more of the load.
- Whether to turn `REMI_HOOK_DEBUG=1` on by default for a capture window (or
  add a dedicated, structure-preserving-only capture flag) so the next
  baseline has a real PermissionRequest corpus on both machines.
