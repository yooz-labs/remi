# Lead continuity (cap: 40 lines, 3,000 characters; prune, never append history)

## Decisions in force
2026-11-14: Plan written; slots not waves; serial daemon lane, serial native lane, one docs lane.
2026-11-14: Phase 1 = P1A (model, commands), P1C (Codex characterization), P1B (launches).
2026-11-14: P1A accepts subscription only for authMethod claude.ai with no apiKeySource (fail closed).
2026-11-14: Profile config: expects required per harness; credential-named env keys refused.
2026-11-14: Resume protection: sidecar session-profiles.json (pending owner J9).
2026-11-14: P1B points the session daemon's own transcript discovery at the profile.
2026-11-14: Docs PR stays draft until REL-DOCS; headings fixed for app links.
2026-11-14: P5, P5B, P6, Apps 5 parked; phase 6 may not start (ADR 0049 D9).

## Open risks
2026-11-14: R1 authMethod value unobserved; OG-P1 confirms.
2026-11-14: R2 claude.ai status carries email; privacy lens on every daemon PR.
2026-11-14: R3 phase 1 without P2A in a release (J3).
2026-11-14: R4 Codex keyring separation unknown until P1C.

## Next intentions
2026-11-14: CP0: two pack reviews, dispositions in plan Appendix A, owner answers J1 to J12.
2026-11-14: CP1: complete P2A to P2D, DOCS-P2, P5A-PREP; re-verify paths after phase 1.

## Pending owner questions
2026-11-14: J1 to J12 (plan section 7), all at CP0.
