# ADR 0036: Workspaces, a session in a new worktree the hub creates

**Status:** accepted for phases A and B (#1236, milestone "Protocol freeze"); phase C is planned below
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
   - Without `worktree`, the session starts in the repository's main worktree, even when `repository` names a linked one. To start in an existing worktree, a client sends its path as `directory`, with no `workspace`.
   - With `worktree`, the hub creates a worktree on a new branch `branch`, from `base` (default: the main worktree's `HEAD`, a detached one included), and starts the session in it. A resume (Claude's `--resume`, Codex's `resume`) is refused with a new worktree: a resumed session belongs to the directory it ran in.
   - `directory` is refused when it is set (not empty) and, resolved, differs from `repository`, so a request is never ambiguous about where it runs. A client sets it to `repository`, so a hub that ignored `workspace` would at worst start in that repository, never elsewhere; a client must not send `workspace` to a hub that does not list the capability (item 6).
2. **The repository is the main worktree.** One resolver (`resolveRepository`, `workspace/git.ts`) asks git where the named directory sits (`rev-parse --path-format=absolute --is-bare-repository --git-dir --git-common-dir`, then `--show-toplevel`). A directory whose git directory is its common directory is its own repository, and the repository is its top level: a main worktree, a submodule (whose git directory lives under the superproject's `.git/modules`) or a checkout with a separate git directory. Only a linked worktree reads the worktree list (`git worktree list --porcelain -z`, which needs git 2.36 or later), whose first entry is the main worktree. Before the #1276 review the worktree list was read for every directory, which named a submodule's git directory as its repository and put a worktree made from a submodule inside `.git/modules`. A bare repository, or a linked worktree of one, is refused: it has no worktree to start in, and its layout has no "next to the repository". A main worktree whose path holds a control character is refused, as a requested `directory` with one is (#1179). An older git, a repository git does not trust (`safe.directory`) and a timeout each get their own refusal, not "not a repository".
3. **The layout.** A new worktree is `<parent>/remi-worktrees/<name>-<branch>`, where `<parent>` and `<name>` are the main worktree's parent directory and name, and every `/` in the branch is a `-`. A worktree made from a linked worktree still lands next to the main one. Names can collide: branches `a/b` and `a-b`, or repository `x` with branch `a/b` and repository `x-a` with branch `b`, map to one directory. So the target is claimed with an exclusive `mkdir` before git runs, and the request that does not get it is refused as taken, concurrently too: before the claim, two such requests at once both reached `git worktree add`, and git's cleanup after the loser's failure removed the winner's worktree (#1270 review, reproduced in 40 of 40 trials). A name over 255 bytes is refused by the same `mkdir`, before git makes the branch. The hub never reuses or overwrites a directory.
4. **Validation before git runs, and git without a shell.** Every value from the wire is checked first (`parseWorkspaceRequest`, `workspace/worktree.ts`):
   - `repository` is a string with no control character, absolute or under `~` (a relative path would resolve against wherever the hub happened to start);
   - `branch` and `base` are strings of 1 to 200 characters with no leading hyphen, no control character and no character `escapeUnsafeText` writes out (bidi and invisible ones would reach clients in the branch and the directory), and `branch` holds no `@{`, which `git check-ref-format --branch` would expand to another branch's name.

   Then git decides (`prepareWorkspace`):
   - the branch name with `git check-ref-format --branch`;
   - that the branch does not exist yet, and that it is not a folder of an existing branch or the other way round (`feature` and `feature/login`, which git refuses only after it has started), from one `git for-each-ref` of the local branches: phase A creates new branches only;
   - the base with `git rev-parse --verify --quiet --end-of-options <base>^{commit}`, so the worktree is made from the commit it resolved to, recorded in the response (a tree or blob, `main:README.md`, is refused).

   Every git command is an argument vector (`Bun.spawn`, no shell) in a process group of its own, with no standard input, `GIT_TERMINAL_PROMPT=0`, `-c core.fsmonitor=false`, and an environment without remi's secrets or any `GIT_*` variable the hub inherited: a `GIT_DIR` would point every command at another repository (tests check both, the secret through a hook's environment).
   One deadline, 60 seconds, covers the whole preparation. Each command is raced against it, and at the deadline the group is sent SIGTERM, then SIGKILL two seconds later: a hook or filter git started holds the output pipes open after git itself is killed, so killing git alone did not bound the call (#1270 review). A test checks a hook that would sleep 30 seconds is ended.
   `git worktree add -b <branch> <path> <commit>` creates the worktree in the claimed directory.
   The repository's own hooks (`post-checkout`) and filter drivers (`smudge`) run, as they would for the person at the machine: it is their repository, and the request comes from a device they approved (#873). The fsmonitor command does not: nothing here needs it.
5. **The response.** A successful `create_session_response` carries `workspace`: `{ repository, directory, worktree?: { branch, base } }`, the main worktree, where the session runs, and for a new worktree its branch and the commit it started from.
   A refusal is short and names nothing the client did not send ("That branch already exists in the repository"); the host's log has the reason, escaped. The refusals do tell an approved device whether a path exists, is a repository, is bare, or has a branch or a commit; that is by design, since it can already start an agent there.
   The worktree is made only once a free port is held, so a request that cannot start because no port is free makes none.
   When `git worktree add` exits non-zero, the hub looks at what it left. A complete worktree on the branch (a hook or filter failed after git made it) is used, and the response's `notice` says git reported an error: refusing it would leave a worktree the person never hears about and a branch a retry cannot reuse. Otherwise the request is refused, the refusal says when the branch stays (git makes it first), and the log says what is left. The one thing the hub removes is its own claim, when git left it empty. At the deadline nothing is inspected or removed (git may still be exiting), and the log says the directory and the branch may remain.
   A worktree made for a session that then fails to start stays, and the failure's log line names it: nothing deletes a worktree (owner decision), and an unused one costs a directory.
6. **The capability.** The daemon lists `workspaces` in `hello_ack.capabilities` (ADR 0035), the first capability: an older hub ignores `workspace` and starts the session in `directory`, so a client checks `hubSupport(ack, ['workspaces'])` first.

## Decision (phase B): the workspace on the session

7. **A daemon's own session-list entry carries `workspace`:** `{ repository, directory, branch }`, the repository's main worktree (a bare repository's own directory), the top level of the worktree the session's directory is in, and the branch checked out there (null when HEAD is detached).
   It is read from git for the session's directory (`readWorkspace`, `workspace/describe.ts`: the resolver of item 2, then `symbolic-ref -q HEAD` with `refs/heads/` removed, since `--short` writes `heads/<name>` when a tag shares the name; the same runner rules as phase A and a 5-second deadline), not remembered from a create request: a session a person started in a worktree is described too, and a branch the agent checks out later shows. Paths keep their spaces.
   It is absent outside a repository, in a bare one or inside a `.git` directory, when a path or the branch holds a control, bidi or invisible character (the agent can name a branch, and it would reach clients as text), on transcript entries, and from an older daemon; a client reads absence as unknown, not as "no repository".
8. **The list never waits on git.** `WorkspaceCache` answers from its last read at once and starts a read when it has none or the last is older than 10 seconds; reads of one directory never overlap. The registry asks once when the session registers, so the first read usually finishes before the first list; until it does, the entry has no `workspace`.
   So a list can be stale: the first list more than 10 seconds after the last read still shows that read and starts a new one, and the list after it shows the change. Nothing pushes a change to clients yet; a broadcast on change waits for one builder of a daemon's own entry (#1274).
   A read git cannot answer (missing, a timeout, git older than 2.36, a repository it does not trust) keeps the previous answer and is logged once per reason, so the field does not disappear while git is slow.
   The registry builds the entry for both the requested list and the live-sessions broadcast, so both carry it (the broadcast still lacks the harness identity: #1274).

## Phase C (planned)

- **Recent repositories:** a request for the repositories of the hub's recent sessions, main worktrees only, most recent first, so the app can offer "new session in repository X on machine Y".

## Consequences

- The hub runs git on behalf of an approved device, in a repository that device names, with that repository's hooks and filters. That is less than it already does: `create_session_request` starts an agent in any directory it names.
- A client waits up to the deadline (60 seconds) plus the spawn for a response. The CLI's `remi new --host` gives up at 30 seconds; a client that gives up early may leave a worktree and a session it never hears about, and a retry is then refused because the branch exists.
- git 2.36 or later is needed on the machine (Ubuntu 22.04 ships 2.34); an older one is refused with that reason.
- Worktrees accumulate until the owner decides on cleanup.
- Tests run against real repositories made with `git init` in temporary directories, never a stand-in for git.
