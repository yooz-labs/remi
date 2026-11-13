# Remi reference: protocol, decision object and workspaces

Moved verbatim out of `AGENTS.md` to keep it under the instruction-size limit; `AGENTS.md` keeps the summary and the standing invariants.

#### Protocol version and capabilities (#1237, ADR 0035)

Every `hello_ack` carries `protocolVersion` (`PROTOCOL_VERSION` in `@remi/shared`, now 1; `createHelloAck` stamps it, so no path omits it) and `capabilities`, the daemon's `DAEMON_CAPABILITIES` (`cli/capabilities.ts`) on the connection ack and both resume acks (`hello-ack-sources.test.ts` fails a new ack path that omits them; the bare `Connection`'s ack, which production never sends, lists none).
The version changes only on a breaking change; an additive change never changes it. `protocol-fixtures-additive.test.ts` holds five messages to that; for the rest it is a review rule, and a breaking change raises `PROTOCOL_VERSION` by hand.
A capability names an additive feature a client cannot see in the messages themselves (a request field an older daemon would ignore); it is added by the change that ships the feature, documented in `PROTOCOL_CAPABILITIES`, and a test refuses an undocumented one.
It lists `workspaces` (#1236), the first; everything before #1237 is the baseline of version 1, and an ack without the fields is from an older daemon (golden `hello_ack_legacy`).
Clients decide with `hubSupport(ack, needs)`, never by comparing `daemonVersion`; an ack without a version counts as version 1, and the versions must match exactly. Nothing calls it yet (no TypeScript client needs a capability), and the native apps are its first users.
`serverVersion` is a constant (`'1.0.0'` on the daemon's acks, `'0.1.0'` from a bare `Connection`), kept because the WebView Mac app's decoder requires it.

#### The decision object (#1235, ADR 0038)

A "the agent needs you" moment is the `question` message's `Question` (`Decision` in `@remi/shared` is an alias), frozen for the native apps.
- **`Question.answerPath`** (optional) says how a phone answer reaches the harness:
  - `structured`: a held hook, or Codex's JSON-RPC response;
  - `keystroke`: typed behind the screen guards; a rendered prompt, a multi-choice permission, an elicitation;
  - `none`: every `terminalOnly` card.

  The gate tells the tracker which path a pushed card takes (`onHeldEscalate(id, path)`), and one stamp in `message-api-setup.ts` writes it, forcing `none` for a terminal-only card. Absent is unknown.
- **`question_resolved.resolvedBy`** (optional) says what resolved a card, sent only where the daemon knows:
  - `phone` or `lockscreen` (the `/answer` endpoint): a phone answer that reached the agent;
  - `terminal`: a run paired by `tool_use_id`;
  - `harness`: a paired `PermissionDenied`, `SessionEnd`, a rotation, a subagent that ended with its hold open, Claude's process exiting (what ended the prompt, not who caused it: a person's /exit ends a session too);
  - `timeout`: remi's hold deadline.

  Nothing is named for a terminal No or Esc (no hook fires), Claude's hook timeout, a name-only match (a `PermissionDenied` included), an elicitation's result (a user's hook or a typed chat message can answer it), a Stop or new prompt sweep, Codex's `serverRequest/resolved` or exit, unstick, or a close remi made. A refused or late phone answer is now `cancelled`, not `answered`; `reason` is coarse and a client labels from `resolvedBy` when present. `phone` means remi delivered that answer first, not that it decided (ADR 0038), and a `none` card still takes a Cancel.
- **The resolver.** Every dismissal goes through `createQuestionResolver` (`cli/question-resolution.ts`), which sends each card's resolution and its lock-screen dismissal once, so the first that names a cause wins; one that named none can be followed by one that does, never the reverse. It forgets a card the registry holds again.
- **`kind` is open.** A client renders an unknown kind as a generic card, never as Allow/Deny. Sandbox and trust prompts have no kind (`source: 'pty'`). `localRender` stays off the wire.

#### Workspaces: a session in a new worktree (#1236 phase A, ADR 0036)

`create_session_request.workspace` names a repository on the daemon's machine (absolute or under `~`; any directory in it, or a linked worktree) and optionally `worktree: {branch, base?}`; the daemon lists the `workspaces` capability, and a client checks it first because an older daemon ignores the field.
`parseWorkspaceRequest` (`workspace/worktree.ts`) checks the values as text before a port is probed (no control character, no leading hyphen, at most 200 characters, no `@{` in a branch); a `directory` that is set and resolves elsewhere is refused.
Once a port is held, `prepareWorkspace` finds the main worktree (`git worktree list --porcelain -z`, first entry, git 2.36 or later; bare refused), checks the branch (`check-ref-format --branch`, then one `for-each-ref`: it must not exist or be a folder of an existing branch, or the reverse; new branches only), resolves the base to a commit (default `HEAD`), claims `<parent>/remi-worktrees/<name>-<branch>` (every `/` a `-`) with an exclusive `mkdir` so two requests that map to one directory cannot both reach git, and runs `git worktree add -b <branch> <path> <commit>` in it.
Git runs with no shell, no standard input, no prompt, `core.fsmonitor` off, no inherited `GIT_*` or remi secret, in its own process group; one 60-second deadline covers the preparation, and at it the group (hooks included) is ended.
The repository's own hooks and filters run, as for the person at the machine.
The child starts in the worktree, and `create_session_response.workspace` says `{repository, directory, worktree?: {branch, base}}` (the base as the commit); a resume with a new worktree is refused.
A failed `git worktree add` that left a complete worktree on the branch (a hook failed) is used, with `notice` saying so; any other failure is refused, saying whether the branch stays, and the log lists what is left. The hub removes only its own empty claim.
A refusal tells the client nothing it did not send; the log has git's reason, escaped.
Nothing deletes a worktree (owner decision, #1233), including one whose session failed to start: the failure's log line names it.
Phase B: a daemon's own session-list entry carries `workspace: {repository, directory, branch}` (branch null when HEAD is detached), read from git for the session's directory (`describeWorkspace`, `workspace/describe.ts`) so a worktree a person made and a branch checked out later both show. `WorkspaceCache` answers the list from its last read and refreshes an entry older than 10 seconds in the background (that first list still shows the previous read), keeps the last answer when git cannot answer (logged once per reason), and the registry primes it when the session registers; until the first read finishes the entry has no `workspace`. Both phases resolve the repository with `resolveRepository` (`workspace/git.ts`): a submodule or a separate-git-dir checkout is its own repository; only a linked worktree reads the worktree list.
Phase C: `recent_repositories_request {limit?}` lists main worktrees from recent session records and retained successful hub starts (#1284; `RecentRepositoryStore`, `workspace/recent-store.ts`), most recently used first, each once, with `lastUsedAt`. The hub remembers at most 20 repositories in `recent-repositories.json` under its remi home, with no age expiry, after successful creates (with or without `workspace`) and resumes through the shared starter; wrappers still contribute through their session records. This retains a main repository after its linked worktree is removed or its session ages out. History holds only repository and time, uses restricted atomic writes and an interprocess transaction that yields while waiting, and a failed write is logged without reporting the child start as failed. The walk (`recentRepositoriesReport`, `workspace/recent.ts`) still excludes gone directories, files, paths git cannot resolve, non-repositories, bare repositories and unsafe paths. The limit is 1 to 20 as asked, above 20 is 20, otherwise 10; one 5-second deadline covers every directory check and git call (the source reads come before it); concurrent requests share one walk. An unreadable source contributes nothing while the other still answers; damaged history gets a content-free log line. The wire and `workspaces` capability are unchanged.
