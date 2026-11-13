# Worker preamble (sent before every card)

You are a worker for the yooz-labs/remi landing plan (land-branches-2026-11).
Repository rules: `AGENTS.md` and, for native work, `packages/native/AGENTS.md`, in the card's worktree; the global rules of the owner apply (Bun and Biome only, no mocks that replace business logic, American English, no em dashes, no emojis, no AI attribution in commits or PRs).

1. One card, one branch, one PR, in the worktree the card names; absolute paths only.
   If the card's worktree does not exist, create it with `git -C /Users/yahya/Documents/git/yooz/remi worktree add /Volumes/S1/worktrees/remi/NAME BRANCH` (NAME and BRANCH from the card) and run `bun install` once in it.
   Never touch the main checkout `/Users/yahya/Documents/git/yooz/remi` beyond `git fetch`, and never another worktree.
2. Only the manager merges.
   Push once per round.
   Never force-push, never rebase a pushed branch: to update from `develop`, run `git fetch origin && git merge origin/develop`, resolve, rerun the gates.
3. Stay inside the card's Scope; anything else goes in the report as a patch note.
4. Run every gate yourself and quote its last output line; a computed value is never reported as measured.
5. Native gates run under the shared Xcode lock, exactly as the card writes them (`lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock ...`), with `-derivedDataPath /Volumes/S1/derived/remi-NAME` for every `xcodebuild`.
   Known local baseline: `PairingAttemptTests` may fail on clean develop (`packages/native/AGENTS.md`); if it does, rerun with `--skip PairingAttemptTests` and say so.
6. TypeScript gates, when the card's diff touches TypeScript, JSON or config: `bunx biome check .`, `bun run typecheck`, `bun run typecheck:web`, `bun run typecheck:web-tests`, `bun run typecheck:signaling`, `bun scripts/third-party-notices.ts --check`, `typos`.
   Hosted CI runs the full `bun test --coverage` (60 percent minimum); locally run the focused tests the card names.
7. Commits: atomic, subject under 50 characters, imperative, with the issue number; never `[skip ci]` on a PR head; never hand-edit versions.
8. PR text: what changed, what was tested (with the commands), what is not verified, and what ships disabled; no emojis, no AI attribution; one paragraph per line (GitHub renders every newline).
   Extend an existing PR body, never replace it.
   Use "Fixes #N" only when the PR meets the issue's whole acceptance; otherwise "Part of #N".
9. Stop and report on any stop condition, or when the card seems wrong.
10. No computer use, no visible GUI runs, no secrets; never read or print `.p8`, tokens or keychains.
11. The final message is the report: PR number and head commit hash; each gate with its quoted last line; evidence paths (under `/Volumes/S1/yooz/remi/artifacts/land-branches-2026-11/`); a revert check per fix; deviations; questions for the lead; patch notes. At most 25 lines.
