## Problem

`packages/native/AGENTS.md` ("Tests and gates") says the hosted `Build and Test (Native)` job is "the only place the Mac `xcodebuild test` is known to run". The workflow `.github/workflows/native-app.yml` (checked on develop 1cbdcc6f, 2026-11-12) runs `swift test` in `packages/native/RemiKit`, four unsigned `xcodebuild build` commands (Mac Debug and Release, iPhone simulator Debug, iPhone device Release), the TestFlight contract script and an unsigned archive. It runs no `xcodebuild ... test`.

The `RemiMac` scheme's test action runs one testable, `RemiKitTests` from the `RemiKit` package, which the hosted `swift test` step also runs (outside Xcode's test runner). So the tests themselves run on every native PR; what does not run is the Xcode test runner for the Mac destination.

Per the repository's "Verify before you describe" rule, a doc that claims more coverage than CI has is a bug: agents read it as "the Mac test target is covered on every PR".

## Fix

Either correct the sentence to say what the hosted job runs, or add the Mac `xcodebuild ... test` step to the workflow (and measure its time and flake rate first, see #1634). The doc fix alone is the small change; adding the step is an owner decision.

## Acceptance

The sentence matches `native-app.yml` at the commit that changes it.
