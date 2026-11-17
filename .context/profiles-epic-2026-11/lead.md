# Lead continuity (cap: 40 lines, 3,000 characters; prune, never append history)

## Decisions in force
2026-11-14: Plan written; slots not waves; serial daemon lane, serial native lane, one docs lane.
2026-11-14: Phase 1 = P1A (model, commands), P1C (Codex characterization), P1B (launches).
2026-11-14: P1A accepts subscription only for authMethod claude.ai with no apiKeySource (fail closed).
2026-11-14: Profile config: expects required per harness; credential-named env keys refused.
2026-11-14: Resume protection: sidecar session-profiles.json, locked like session-store (J9).
2026-11-14: Pack review round 1 applied (Appendix A); P5A-PREP completed at CP0.
2026-11-14: P1B points the session daemon's own transcript discovery at the profile.
2026-11-14: Docs PR stays draft until REL-DOCS; headings fixed for app links.
2026-11-14: P5, P5B, P6, Apps 5 parked; phase 6 may not start (ADR 0049 D9).

## Open risks
2026-11-14: R1 authMethod value unobserved; OG-P1 confirms.
2026-11-14: R2 claude.ai status carries email; privacy lens on every daemon PR.
2026-11-14: R3 phase 1 without P2A in a release (J3).
2026-11-17: R4 read good: Codex default store file, keyring separated; J11 moot; CODEX_API_KEY added.

## Next intentions
2026-11-14: CP0: owner answers J1a to J15, J18; J16, J17 deferred (CP2, CP1); runbook 2.
2026-11-14: CP1: complete P2A to P2D, DOCS-P2; re-verify paths after phase 1.

## Pending owner questions
2026-11-14: Owner approved; J1b option 1 (owner limits), J2 (b), J7 manager may measure.
