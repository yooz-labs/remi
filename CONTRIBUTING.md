# Contributing to Remi

Thanks for considering a contribution.
Remi is the Yooz ecosystem's remote monitor for Claude Code (and other coding agent) sessions; PRs to the Apache-2.0 packages that improve correctness, latency or multi-machine discovery are welcome.
The web client, the signaling relay and the native Mac app take outside changes only by prior written agreement; see [Outside contributions to the PolyForm Shield packages](#outside-contributions-to-the-polyform-shield-packages).

## Before you start

- **License agreement**: this repository is open core, and [LICENSE.md](LICENSE.md) has the full map.
  - `packages/daemon` and `packages/shared`: [Apache License 2.0](packages/daemon/LICENSE).
    Outside contributions are welcome and are licensed under that license.
  - Anything outside the package directories (scripts, docs, CI configuration): Apache License 2.0, on the same terms.
  - `packages/web`, `packages/signaling`, `packages/macos` and `packages/native`: [PolyForm Shield 1.0.0](packages/web/LICENSE.md).
    **We do not accept outside contributions to these packages without a prior written agreement**; see [Outside contributions to the PolyForm Shield packages](#outside-contributions-to-the-polyform-shield-packages).
    The strategic rationale lives in [yooz-engine/LICENSING.md](https://github.com/yooz-labs/yooz-engine/blob/main/LICENSING.md).

  A pull request that touches a PolyForm Shield package is closed under the rule below, even if it also touches an open part.
  Send the Apache-2.0 changes as a separate pull request.
- **DCO sign-off** (required, unchanged): every commit must carry a `Signed-off-by:` trailer.

  ```bash
  git commit -s -m "feat: add auto-discovery probe"
  ```

  The `-s` flag adds a line like `Signed-off-by: Your Name <you@example.com>` derived from `git config user.name` and `user.email`.

- **Discuss first** for non-trivial changes (protocol changes, daemon architecture, new agent integrations). Open an issue describing the problem and the proposed approach.

## Outside contributions to the PolyForm Shield packages

The web client, the signaling relay and the native Mac app are published so that you can read and audit them.
They are source-available for that reason: a privacy product earns trust by being inspectable.
It is not an invitation to contribute code to them.

A DCO sign-off certifies where a change came from.
PolyForm Shield 1.0.0 does not allow a licensee to sublicense (see "No Other Rights" in [packages/web/LICENSE.md](packages/web/LICENSE.md)), so, as we read it, a sign-off alone would not let Yooz Labs relicense an outside change or offer it under commercial or dual-license terms (see [LICENSE.md](LICENSE.md)).
The first outside change merged into one of these packages could therefore limit what Yooz Labs can later do with the package without that contributor's consent.
So the rule is simple:

- A pull request that changes a file under `packages/web`, `packages/signaling`, `packages/macos` or `packages/native` is closed without review,
  unless we agreed on the contribution terms with you first, in writing.
- If you want to contribute to one of them, open an issue or write to **dev@yooz.info** before you write code.
  We decide case by case whether to proceed.
  If we do, we agree on the scope and the terms in writing first, and only then take a pull request.
- Bug reports, security reports, reproductions and design feedback on these packages are always welcome, and need no agreement.
  We read them, but we do not copy outside code from them into these packages without an agreement.
- Forking, modifying and using these packages for any permitted purpose stays governed by PolyForm Shield 1.0.0 as written.

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
