# ADR 0007: Fully automated release train with explicit toolchain pins

**Status:** accepted
**Date:** 2026-07-10
**Owner:** Yahya

## Context

Releases were manual and error-prone; two upstream toolchain regressions
(bun 1.3.12 `--compile` silent-exit binaries; npm 12.0.0 shipping without
sigstore, breaking OIDC provenance publishing) each broke a release with no
code change on our side.

## Decision

Release = a PR develop→main plus a CHANGELOG entry; CI does everything else:
auto-bump-dev counts `-dev.N` on develop pushes, auto-release strips the
suffix and tags `vX.Y.Z` on main, release.yml builds per-platform binaries,
publishes npm + GitHub release + Homebrew, and sync-develop merges back and
opens the next dev line. Toolchain versions in release.yml are PINNED (bun
1.4.2, npm@11) and only bumped deliberately after validating a real
artifact.

## Consequences

Versions are never hand-edited (`bump-version.sh` only). A failed tag
publish cannot be fixed by rerunning — reruns use the tag's committed
workflow file; recovery is: land the workflow fix on main, then re-point the
tag (`git push origin :refs/tags/vX.Y.Z && git tag -f vX.Y.Z <sha> && git
push origin vX.Y.Z`). All publish steps are idempotent to make that safe.
Known cost: CI-gate flakes (#532/#528/#725/#772) can block auto-release on
main; watch the post-merge main run and `gh run rerun --failed`.

## Bun 1.4.2 adoption gate (#1273)

The migration moves all executing workflow pins, the relay workflow contract and
the strict soak-runtime identity together. Old-runtime producer evidence is not
eligible for the new pin. Active close controls require the full reason and clean
transport outcome, without the former 1.3.11 exceptions; historical proof matrices
keep their original runtime identities.

Adoption requires compiled full CLI execution on all three supported host targets,
the full suite, a candidate-runtime relay producer and the issue's live phone
connection before the final merge. Headless hub checks do not replace that phone
acceptance. The preparation's Mac full suite passed; local Linux qualification
remains open after three mDNS discovery failures in an internal-network fixture.
Fresh hosted results and owner hardware evidence belong to the migration PR.

## Alternatives considered

- **`npm install -g npm@latest` in the publish job:** what broke v0.6.19
  twice; latest is not a version.
- **Manual tag/publish:** slower and reintroduces the hand-edit class of
  errors.

## Receipts

#479, #480; PRs #775/#776 (npm pin), bun pin in release.yml comments;
v0.6.19 recovery and v0.6.20 first-try release, 2026-07-09/10.
