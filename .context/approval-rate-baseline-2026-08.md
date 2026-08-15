# Approval-rate baseline (Phase 1, epic #1057 / #992)

Baseline numbers for how much of a real `PermissionRequest` corpus the
deterministic layers (`allow`/`deny`/`approve_groups`/`deny_groups`, #1024's
`evaluateDeterministic`) already decide with no LLM call, what shape the
misses have, and how the live LLM path itself behaves. Produced by
`packages/daemon/tests/auto-approve/run-approval-rate-report.ts` over
`packages/daemon/tests/auto-approve/approval-rate.ts`.

**Status: skeleton only.** The commands below are verified to run; the
"Numbers" section is NOT filled in -- every value there is a placeholder
(`TBD`) until someone runs the report against a real corpus and a real
`remi.log` and transcribes the actual output. Do not fill in a number that
was not read off a real run (repo rule, AGENTS.md "Verify before you
describe").

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

## Numbers

Corpus captured: TBD (date, machine, record count)
Config / level used for the headline numbers below: TBD

### (a) Deterministic coverage

| Level | Total records | Approve | Deny-covered | Residual | Coverage % |
|---|---|---|---|---|---|
| strict | TBD | TBD | TBD | TBD | TBD |
| balanced | TBD | TBD | TBD | TBD | TBD |
| trusted | TBD | TBD | TBD | TBD | TBD |

Per-tool breakdown (trusted): TBD

### (b) Miss classification (residual Bash commands, by shape)

| Bucket | Count | low | moderate | high | critical |
|---|---|---|---|---|---|
| heredoc | TBD | TBD | TBD | TBD | TBD |
| redirection | TBD | TBD | TBD | TBD | TBD |
| pipeline | TBD | TBD | TBD | TBD | TBD |
| chained | TBD | TBD | TBD | TBD | TBD |
| single | TBD | TBD | TBD | TBD | TBD |

### (c) Band distribution of the LLM-bound residue

| Band | Count | % |
|---|---|---|
| low | TBD | TBD |
| moderate | TBD | TBD |
| high | TBD | TBD |
| critical | TBD | TBD |

### (d) Live decision log

remi.log captured: TBD (date range, machine)

- Lines / unparsed / fast-path / llm-path: TBD
- Queue-timeout count: TBD
- Risk-ceiling count: TBD
- Verdict rates (approve/deny/escalate/cancelled/error): TBD
- Latency p50/p95 by verdict: TBD
- Notable `verdict x band x decided_by` combinations: TBD

## Open questions for Phase 2

TBD -- filled in once the real numbers above suggest where the next round of
deterministic coverage (or LLM-path tuning) should focus.
