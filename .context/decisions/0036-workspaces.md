# ADR 0036: Workspaces, a session in a new worktree the hub creates

**Status:** accepted for phase A (#1236, milestone "Protocol freeze"); phases B and C are planned below
**Date:** 2026-10-07
**Owner:** Yahya

## Context

The native Mac app works like Conductor: one agent session per git worktree, many at once, across machines.
The app is sandboxed (`packages/native/AGENTS.md`): it never runs git or spawns an agent, so the machine has to make the worktree.
`create_session_request` takes a directory, a harness and arguments (#1179), nothing that says "a new branch of this repository".

Owner decisions (#1233, 2026-10-06): hub-created worktrees live in `../remi-worktrees`, next to the repository; the layout inside it is this ADR's to fix; whether closing a session deletes its worktree is open, and until it is decided, nothing deletes one.

## Decision (phase A)

1. **The request.** `create_session_request.workspace` is optional:
   `{ repository: string, worktree?: { branch: string, base?: string } }`.
   - `repository` is a directory in a git repository on the hub's machine: its top level, a directory inside it, or one of its linked worktrees. `~` expands to the hub's home, as for `directory`.
   - Without `worktree`, the session starts in the repository's main worktree.
   - With `worktree`, the hub creates a worktree on a new branch `branch`, from `base` (default: the main worktree's `HEAD`), and starts the session in it.
   - `directory` is refused when it is set (not empty) and, resolved, differs from `repository`, so a request is never ambiguous about where it runs. A client sets it to `repository`, so a hub that ignored `workspace` would at worst start in that repository, never elsewhere; a client must not send `workspace` to a hub that does not list the capability (item 6).
2. **The repository is the main worktree.** The hub asks git for the worktree list (`git worktree list --porcelain`) and takes the first entry, the main worktree, whatever directory the request named. A bare repository (the first entry is marked `bare`) is refused: it has no worktree to start in, and its layout has no "next to the repository".
3. **The layout.** A new worktree is `<parent>/remi-worktrees/<name>-<branch>`, where `<parent>` and `<name>` are the main worktree's parent directory and name, and every `/` in the branch is a `-`. Several repositories in one parent do not collide, and a worktree made from a linked worktree still lands next to the main one. A target that already exists is refused; the hub never reuses or overwrites a directory.
4. **Validation before git runs, and git without a shell.** Every value from the wire is checked first (`parseWorkspaceRequest`, `workspace/worktree.ts`):
   - `repository` is a string with no control character, absolute or under `~` (a relative path would resolve against wherever the hub happened to start);
   - `branch` and `base` are strings of 1 to 200 characters with no leading hyphen and no control character, and `branch` holds no `@{`, which `git check-ref-format --branch` would expand to another branch's name.

   Then git decides (`prepareWorkspace`):
   - the branch name with `git check-ref-format --branch`;
   - that the branch does not exist yet (`git show-ref --verify --quiet refs/heads/<branch>`): phase A creates new branches only;
   - the base with `git rev-parse --verify --quiet --end-of-options <base>^{commit}`, so the worktree is made from the commit it resolved to, recorded in the response (a tree or blob, `main:README.md`, is refused).

   Every git command is an argument vector (`Bun.spawn`, no shell), with no standard input, `GIT_TERMINAL_PROMPT=0`, a 60-second limit, and an environment without remi's secrets or any `GIT_*` variable the hub inherited: a `GIT_DIR` would point every command at another repository (a test sets one and checks it is ignored).
   `git worktree add -b <branch> <path> <commit>` creates the worktree.
   The repository's own hooks run (`post-checkout`), as they would for the person at the machine: it is their repository, and the request comes from a device they approved (#873).
5. **The response.** A successful `create_session_response` carries `workspace`: `{ repository, directory, worktree?: { branch, base } }`, the main worktree, where the session runs, and for a new worktree its branch and the commit it started from.
   A refusal is short and names nothing the client did not send ("That branch already exists in the repository"); the host's log has the reason, escaped.
   The worktree is made only once a free port is held, so a request that cannot start makes none.
   A worktree made for a session that then fails to start stays, and the failure's log line names it: nothing deletes a worktree (owner decision), and an unused one costs a directory.
   Two branches that differ only by `/` and `-` (`a/b`, `a-b`) map to one directory, so the second is refused as taken.
6. **The capability.** The daemon lists `workspaces` in `hello_ack.capabilities` (ADR 0035), the first capability: an older hub ignores `workspace` and starts the session in `directory`, so a client checks `hubSupport(ack, ['workspaces'])` first.

## Phases B and C (planned)

- **B, the workspace on the session:** every session-list entry says its repository, its directory and, in a linked worktree, its branch, read from git for the session's directory, whether the hub created it or a person did.
- **C, recent repositories:** a request for the repositories of the hub's recent sessions, main worktrees only, most recent first, so the app can offer "new session in repository X on machine Y".

## Consequences

- The hub runs git on behalf of an approved device, in a repository that device names. That is less than it already does: `create_session_request` starts an agent in any directory it names.
- Worktrees accumulate until the owner decides on cleanup.
- Tests run against real repositories made with `git init` in temporary directories, never a stand-in for git.
