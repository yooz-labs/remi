# Contributing to Remi

Thanks for considering a contribution. Remi is the Yooz ecosystem's remote monitor for Claude Code (and other coding agent) sessions; PRs that improve correctness, latency, multi-machine discovery, or mobile UX are welcome.

## Before you start

- **License agreement**: this repository is open core, and [LICENSE.md](LICENSE.md) has the full map.
  - `packages/daemon` and `packages/shared`: [Apache License 2.0](packages/daemon/LICENSE).
    Outside contributions are welcome and are licensed under that license.
  - Anything outside the package directories (scripts, docs, CI configuration): Apache License 2.0, on the same terms.
  - `packages/web`, `packages/signaling` and `packages/macos`: [PolyForm Shield 1.0.0](packages/web/LICENSE.md).
    **We do not accept outside contributions to these packages without a prior written agreement**; see the next section.
    The strategic rationale lives in [yooz-engine/LICENSING.md](https://github.com/yooz-labs/yooz-engine/blob/main/LICENSING.md).

  A pull request that touches several packages is licensed per file, by the package each file lives in, and the PolyForm rule below applies to every file under a PolyForm package.
- **DCO sign-off** (required, unchanged): every commit must carry a `Signed-off-by:` trailer.

  ```bash
  git commit -s -m "feat: add auto-discovery probe"
  ```

  The `-s` flag adds a line like `Signed-off-by: Your Name <you@example.com>` derived from `git config user.name` and `user.email`.

- **Discuss first** for non-trivial changes (protocol changes, daemon architecture, new agent integrations). Open an issue describing the problem and the proposed approach.

## Outside contributions to the PolyForm Shield packages

The web client, the signaling relay and the native Mac app are published so that you can read, audit and verify them.
That is the point of the source-available license: a privacy product earns trust by being inspectable.
It is not an invitation to contribute code to them.

A DCO sign-off certifies where a change came from; it does not give Yooz Labs the right to relicense it, and PolyForm Shield does not permit sublicensing.
The first outside change merged into one of these packages would therefore limit what Yooz Labs can later do with the package (offer the dual-license terms in [LICENSE.md](LICENSE.md), or relicense it) without that contributor's consent.
So the rule is simple:

- A pull request that changes a file under `packages/web`, `packages/signaling` or `packages/macos` is closed without review unless we agreed on the contribution terms with you first, in writing.
- If you want to contribute to one of them, open an issue or write to **dev@yooz.info** before you write code.
  We will agree on the scope and on the terms, and only then take a pull request.
- Bug reports, security reports, reproductions and design feedback on these packages are always welcome, and need no agreement.
- Forks for your own use are governed by PolyForm Shield 1.0.0 as written; that is unchanged.

This does not affect `packages/daemon`, `packages/shared`, or anything outside the package directories, which stay open to contributions as described above.

## Workflow

1. **Open an issue** describing the bug or feature (skip for trivial fixes).
2. **Branch from `develop`** (active dev) or `main` (per repo convention; check the latest CONTRIBUTING in your branch): `git checkout -b feature/issue-N-short-description`.
3. **Make atomic commits** with concise messages (under 50 chars, no AI attribution).
4. **Run tests**:

   ```bash
   bun install
   bun test
   ```

5. **Run lint**: `bun run lint` (Biome). CI runs the same on every PR.
6. **Open a PR**. Describe what changed, why, and how to test it. Reference the issue number with `Closes #N`.
7. **Address review findings**. Maintainers run an automated multi-agent review on every PR before merge; plus human review.
8. **Merge after CI green**. Don't merge with red CI.

## Commit style

- Subject: imperative, present tense, under 50 chars, optional `type(#issue):` prefix.
- Body: what + why, not how.
- No emojis, no AI attribution.

## What not to commit

- Secrets (`.env`, API keys, npm tokens, signing certificates).
- `node_modules`, `dist`, `build` artifacts unless they're explicitly tracked release assets.
- Personal IDE config that doesn't fit the team setup.

## Tests

- **Unit tests**: vitest / bun:test under `tests/`. Run before pushing.
- **No mocks of internal modules**. Test against the real APIs where possible. Mock only at system boundaries (network, file system if needed).
- **Coverage goal**: every public daemon endpoint has at least a wire-format and a happy-path test.

## Code style

- TypeScript strict mode, Biome for lint and format.
- Bun for package management; npm only as fallback.
- Don't add error handling for impossible scenarios. Trust your function contracts.
- Don't add comments that explain WHAT the code does (the names should). Comment only the WHY.

## Security

Found a vulnerability? See [`SECURITY.md`](SECURITY.md) — please don't open a public issue.

## Questions

Open an issue, or email **dev@yooz.info**.
