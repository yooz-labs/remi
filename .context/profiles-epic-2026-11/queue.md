# Queue: slots and collisions

The board's Steps order is the dispatch priority; `manager_board.py status` places each ready step on the first slot (in Slots order) that takes its tier and can do what it needs.
This file lists, per slot, the cards in priority order with their entry condition, and every pair of steps that can touch the same files.
"After" rules are encoded as `Depends` on the board, so `status` enforces them.

## Per slot

| Slot | Cards in order | Entry condition |
| --- | --- | --- |
| codex-terra (1, worker-hard) | P1A, P1B, P2A, P2B, P2C, P3A, P3B, P4A, P4B; A1, A2, A3 when free | P1A after CP0; each later daemon step after the one before it (Depends); app slices after their CPA checkpoint |
| codex-luna (2, worker) | P1C, DOCS-P1, P5A-PREP, P2D, DOCS-P2, P3C, DOCS-P3, DOCS-P4, A4, REL-DOCS, DV | P1C after CP0; docs steps after their phase's last step; DV after every merge |
| claude-sonnet (2, worker) | the same worker cards when both Luna slots are busy | owner, 2026-11-13: both platforms' worker slots are used |
| claude-opus (1, lead and worker-hard) | worker-hard cards when Terra is busy (in practice the native lane: A1, A2, A3 beside a daemon step) | lead wakes and advisor consults are extra to this slot |
| claude-fable (1, frontier) | none | only if the owner asks |

The Xcode lock serializes native gate runs across all slots; the one simulator is used only for an app slice's visual capture, with the owner's announced consent.

## Collisions

Observed on `develop` `c9e13967`; the checkpoint lead re-reads them when completing an outline card.

| Pair | Shared files | Rule |
| --- | --- | --- |
| P1A, P1C | none (P1C adds one `.context/` note) | may run together |
| P1A, P1B | `packages/daemon/src/profiles/`, `cli/arg-parser.ts`, `cli.ts`, `pty-child-env-secrets.test.ts` | P1B after P1A merges (Depends) |
| P1C, P1B | P1B reads P1C's note | P1B after P1C merges (Depends) |
| P1B, P2A | `cli.ts` (discovery construction, download roots), `transcript/` | P2A after CP1 (Depends) |
| P2A, P2B | `cli.ts`, `profiles/`, session and transcript lists | P2B after P2A (Depends) |
| P2B, P2C, P3B, P4A, P4B | `packages/shared/src/protocol.ts`, `protocol-version.ts`, `packages/daemon/src/cli/capabilities.ts`, `packages/shared/tests/fixtures/protocol/builders.ts` and the generated fixtures, `profiles/` | strictly serial (Depends); each merges `origin/develop` and regenerates fixtures before its gates |
| P2D, P3C, A4 | `packages/web/src/components/settings/`, the session list, the web decoders | serial (P3C after CP2, A4 after CPA4) |
| P3A, P3B | `cli/statusline-installer.ts`, the snapshot store, the Codex app-server client | P3B after P3A (Depends) |
| P3B, A3 | the `usage_warning` kind byte (`packages/shared/src/relay/push.ts`, `NativePushCodec.swift`) | A3 after CP3; A3's codec byte must equal P3B's |
| P4A, P3A | `hooks/hook-types.ts` registration, the hook server | P4A after CP3 (Depends) |
| A1, A2, A3, A4 | RemiKit (`ProtocolSupport.swift`, `Rows.swift`, `BoardTile.swift`), the new-session sheets, `PARITY.md`, the Xcode lock, the simulator | strictly serial through CPA1 to CPA4; never in a wave |
| any app slice, any protocol step | the fixtures the slice decodes | may run together; if the protocol step merges first, the slice merges `origin/develop` and reruns `FixtureConformanceTests` before its merge gate |
| any daemon step, `docs/agent-reference/profiles.md` | that file | serial by Depends already |
| DOCS-P1 to DOCS-P4, REL-DOCS | the yooz-docs branch `docs/remi-profiles` and its two pages | one docs step at a time |
| DOCS-P1, yooz-docs PR #25 | `sidebars.ts`, `docs/tools/remi/` | the docs worker merges `origin/main` into the docs branch after #25 merges and reruns `bun run build` |
| D51, P2A | ADR 0051 on `develop` | P2A after D51 (Depends) |
