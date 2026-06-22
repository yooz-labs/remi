# Permission Packs — Research (for #552)

Survey of safe, commonly-run commands per technology platform, to curate
auto-approve "permission packs" on top of the existing `permission-groups.ts`
(#495). Compiled from three sonnet research passes (academic/scientific,
software-dev, infra/cloud) grounded with web search. Sources at the bottom.

> **This is a SAFETY-CRITICAL allowlist.** A wrong SAFE entry silently approves a
> destructive or code-executing command without asking. A wrong EXCLUDE merely
> routes to the user. The asymmetry is severe: **when in doubt, EXCLUDE.**

## Matcher mechanics (cross-cutting — must hold for every pack)

These are the rules the matcher already partly enforces (#495); the packs depend
on all of them:

1. **Prefix + flag-blocklist, not substring.** Approve the base command only when
   no excluded flag is present anywhere in the invocation. One forbidden flag
   forces escalation.
2. **Compound commands escalate unless every segment is independently approved.**
   Split on `\n`, `\r`, `;`, `&&`, `||`, `|`. `git status && rm -rf .` must NOT be
   approved because `git status` matched. (Claude Code itself has this bug:
   anthropics/claude-code#28183.)
3. **Shell-operator guard.** Any `>`, `>>`, `` ` ``, `$()`, or a pipe into a shell
   /runtime (`| sh`, `| bash`, `| zsh`, `| python`, `| node`, `| bun`, `| perl`,
   `| ruby`, `| xargs`) → escalate, even if the base command is safe.
4. **`sudo`/`su`/`doas` prefix → always escalate**, regardless of the trailing
   command.
5. **Inline-eval flags → always escalate**: `-c`, `-e`, `--eval`, `--exec`,
   `-r` (matlab/Rscript) followed by a code string.
6. **Network-fetch-then-run → always escalate**: `npx`, `uvx`, `curl|sh`,
   `wget|sh`, `bash <(curl …)`.

## Proposed built-in packs

### `read-only` (EXTEND the existing pack)

Already exists. The research confirms/adds these blanket-safe (no dangerous
flags) read commands:

- **Blanket-safe** (no gating beyond the operator guard): `ls`, `cat`, `head`,
  `tail` (NOT `-f`/`-F` in a daemon context — persistent process), `wc`, `stat`,
  `file`, `du`, `df`, `pwd`, `dirname`, `basename`, `realpath`, `uname`,
  `hostname` (no arg), `which`, `type`, `printenv`, `env` (no trailing command),
  `date` (NOT `-s`/`--set`), `echo` (operator guard catches `>`), `tree` (NOT
  `-o <file>`), `kpsewhich`.
- **Flag-gated safe**: `grep`/`rg` (rg: NOT `--hostname-bin`), `find` (EXCLUDE
  `-exec`/`-execdir`/`-delete`/`-fprint*`/`-ok*`), `fd` (EXCLUDE
  `-x`/`-X`/`--exec`/`--exec-batch`).

### `latex` (new)

- **SAFE (gated):** `latexmk`, `pdflatex`, `xelatex`, `lualatex`, `latex`, `tex`,
  `bibtex`, `biber`, `makeindex`, `makeglossaries`, `kpsewhich` — with normal
  compile flags (`-interaction=…`, `-output-directory=…`, `-jobname=…`,
  `-synctex=1`, `-halt-on-error`, `-draftmode`, `-recorder`, `-pdf`, `-xelatex`,
  `-lualatex`).
- **EXCLUDE (veto flags):** `-shell-escape` / `--shell-escape` /
  `-enable-write18` / `-write18=` / `-unsafe` (LuaTeX) — arbitrary shell exec.
  Also `latexmk -c`/`-C`/`-CA` (delete generated/aux files) and `latexmk -pvc`
  (persistent watcher) in a daemon context.

### `docs` (new — pandoc/markdown)

- **SAFE (gated):** `pandoc` with format/template/bibliography/toc flags;
  `cmark`, `commonmark`, `markdown` (pure text conversion); `pandoc
  --list-*`/`--version`.
- **EXCLUDE:** `pandoc --filter <path>` / `--lua-filter <path>` (executes an
  external program / Lua with `os.execute`) and `--pdf-engine-opt=-shell-escape`.

### `python-dev` (new — static/format only)

- **SAFE:** `ruff check`, `ruff format --check`, `ruff format`, `mypy`,
  `black --check`, `black`, `uv lock --check`, `uv pip compile`, `uv pip check`,
  `python --version`, `python -m pip list`/`show`/`check`.
- **EXCLUDE (code-exec / network):** `pytest` (loads `conftest.py` → runs code),
  `python <script.py>`, `python -c …`, `python -m <anything else>`,
  `pip install`/`uv pip install`/`uv sync` (build scripts/postinstall),
  `uv run <cmd>`, `tox`, `python -i`, `python -m http.server`.

### `node-dev` (new — static/format only)

- **SAFE:** `tsc --noEmit` (NOT `--watch`), `biome check`/`lint`/`format --write`,
  `eslint` (note: loads `eslint.config.js`, so trusted-repo-only),
  `prettier --check`/`--write`, and **lockfile installs only with
  `--ignore-scripts`**: `pnpm install --frozen-lockfile --ignore-scripts`,
  `npm ci --ignore-scripts`, `bun install --ignore-scripts`.
- **EXCLUDE:** `npm/pnpm/yarn install` without `--ignore-scripts` (lifecycle
  scripts = supply-chain RCE; GitHub is disabling these by default 2026),
  `npm run <script>`, `node <file>`, `node -e`, `tsx`, `bun run`, `bun <file>`,
  `bun --preload`, `vitest`/`jest` (config + tests execute; vitest CVE-2026-47428),
  `npx <pkg>`.

### `rust-dev` (new — CONDITIONAL, trusted-tree only)

- **SAFE (no compilation):** `cargo fmt --check`, `cargo fmt`, `rustfmt <file>`.
- **CONDITIONAL (runs `build.rs` + proc-macros = arbitrary code at build):**
  `cargo check`, `cargo clippy`, `cargo test --no-run`. Widely treated as safe in
  a repo you own with a reviewed `Cargo.lock`, but there is no sandbox. Default
  this pack OFF or document the trust assumption loudly.
- **EXCLUDE:** `cargo run`, `cargo test` (runs binaries), `cargo build` (runs
  build.rs), `cargo install`/`add`/`update`, `rustc <file>`.

### `go-dev` (new — CONDITIONAL on no-cgo)

- **SAFE (pure-Go):** `go vet ./...`, `gofmt -l`, `gofmt -w`, `go build ./...`
  (does not run the binary; but cgo invokes the C compiler — 7 CVEs in
  CFLAGS/LDFLAGS handling, so conditional if the repo uses cgo).
- **EXCLUDE:** `go run`, `go test` (runs tests), `go generate` (runs arbitrary
  `//go:generate`), `go install`, `go get`.

### `vcs-read` (EXTEND the existing pack)

Already exists. Research confirms the safe git read set (`status`, `log`, `diff`,
`show`, `branch --list`, `remote -v`, `stash list`, `blame`, `describe`,
`rev-parse`, `ls-files`, `ls-tree`, `cat-file -t/-p`, `config --get/--list`,
`tag -l`, `worktree list`, `submodule status`) and the gh read set (`pr/issue
view`/`list`/`diff`/`checks`/`status`, `repo view`, `run list`/`view`, `release
list`/`view`, `label list`, `auth status`).

- **Danger line to keep enforced:** `git fetch` modifies `refs/remotes/*` and can
  trigger `post-fetch` hooks → keep EXCLUDE (current behavior). `gh api` is GET by
  default but `-X POST/PATCH/PUT/DELETE` / `-f` are writes → do NOT blanket-approve
  `gh api`; approve only the named read subcommands.

### `container-read` (new)

- **SAFE:** `docker`/`podman` `ps`/`images`/`inspect`/`logs` (NOT `-f`/`--follow`)
  /`stats --no-stream`/`version`/`info`/`volume ls`/`network ls`/`compose
  config`/`compose ps`/`diff`.
- **EXCLUDE:** `run`, `exec`, `build`/`buildx`, `rm`/`rmi`, `stop`/`start`/
  `restart`/`kill`, `system prune`, `pull`/`push`, `cp`, `save`/`export`/`load`/
  `import`, `login`, `compose up`/`down`/`run`/`exec`, anything with
  `--privileged`/`--cap-add`.

### `k8s-read` (new — careful)

- **SAFE:** `kubectl get`/`describe`/`logs` (NOT `-f`) /`top`/`version`/
  `cluster-info`/`api-resources`/`explain`/`config view`/`current-context`.
- **EXCLUDE (mutate/exec/recon/secret):** `exec`, `apply`, `delete`, `edit`,
  `scale`, `patch`, `create`, `replace`, `rollout`, `cordon`/`drain`,
  `port-forward`, `cp`, `proxy`, `run`, `attach`, and **NEVER**
  `kubectl get secrets`/`describe secret`/`get secret -o yaml` (dumps base64
  secret values). Read-only RBAC + exec is a documented cluster-admin escalation.

### `cloud-read` (new — heaviest caveats; default OFF)

Read/list/describe can still return IAM keys, secret values, and env vars
(LeakyCLI, 2024). Only the most inert metadata calls:

- **SAFE (narrow):** `aws --version`/`configure list`/`sts get-caller-identity`/
  `ec2 describe-*`/`s3 ls`/`cloudformation list-stacks`; `gcloud --version`/`config
  list`/`projects list`/`compute … list`/`storage ls`; `az --version`/`account
  list`/`group list`/`resource list`/`vm list`. (List/describe of structural
  resources only.)
- **EXCLUDE:** anything touching secrets/keys/env: `secretsmanager
  get-secret-value`, `ssm get-parameter --with-decryption`, `lambda
  get-function*` (env vars), `iam *`, `gcloud secrets versions access`/`functions
  describe`, `az keyvault secret show`/`storage account keys list`/`*appsettings
  list`; all create/delete/run/cp/sync; `vm run-command`.

## Tools that CANNOT be safely packaged (document as "no pack")

- **Databases** (`psql`, `mysql`, `sqlite3`, `duckdb`, `redis-cli`): a single
  invocation carries arbitrary SQL; `psql -c "SELECT …"` and `psql -c "DROP TABLE
  …"` are structurally identical to a prefix matcher. `\copy`/`\i`/`LOAD DATA`/
  `COPY TO` do file I/O. Use a read-only DB user + per-query approval instead.
- **Network/transfer** (`curl`, `wget`, `scp`, `rsync`, `ssh`): download-then-exec
  and exfiltration are the canonical attacks; no safe structural subset.
- **JVM build** (`gradle`, `mvn`): build scripts are live Groovy/Kotlin/plugins
  evaluated on every invocation, including `gradle tasks`/`mvn validate`. No safe
  subcommand.
- **General build orchestrators** (`make`, `cmake`, `ninja`, `bazel`, `just`,
  `task`): arbitrary command runners by design; `make <target>` is shell.
- **Code runtimes** (`python`, `Rscript`, `matlab`, `octave`, `node`, `bun`):
  blanket-exclude; only literal `--version`/`--help`/narrow metadata queries are
  safe.
- **Test runners** (`pytest`, `vitest`, `jest`, `cargo test`, `go test`): load and
  execute code-bearing config + the code under test.

## Never-auto-approve danger catalog (the floor — must reject in any pack)

- **Filesystem destruction:** `rm -rf`, `rm` with globs, `find … -delete`/`-exec
  rm`, `xargs rm`, bare `> file` (truncate), `truncate -s 0`, `tee` to system
  paths.
- **Block devices:** `dd of=…`, `mkfs.*`, `fdisk`/`parted`/`gdisk`, `shred`/`wipe`.
- **Privilege/credentials:** `sudo`/`su`/`doas`, `chmod -R 777`/`chmod +x`+run,
  `chown -R … /`, writes to `~/.ssh/authorized_keys`/`~/.ssh/config`/shell
  rc/`/etc/cron*`/`~/.gitconfig` (core.hooksPath), reading+piping
  `~/.aws/credentials`/`~/.ssh/id_rsa`.
- **Remote exec/download:** `curl|sh`, `wget -O- |sh`, `bash <(curl …)`,
  `eval $(curl …)`, `source <(curl …)`, `base64 -d | sh`.
- **Code injection:** `eval`, `bash -c`/`sh -c`, `python -c`, `node -e`, `ruby
  -e`/`perl -e`, `source`/`.` of untrusted, command substitution.
- **Process/service:** `kill -9`, `pkill`/`killall`, `kill -9 -1`,
  `shutdown`/`reboot`/`halt`, `systemctl stop`/`disable`, `launchctl unload`.
- **Git history rewrite:** `git push --force`, `git reset --hard`, `git rebase`,
  `git commit --amend`, `git filter-branch`/`filter-repo`, `reflog expire`,
  `gc --prune=now`.
- **Fork bombs / exhaustion:** `:(){ :|:& };:`, `yes > /dev/null &`, unbounded
  `while true`, `dd if=/dev/zero of=file`.
- **Env exfiltration:** `env | curl -d @-`, `printenv | <net>`, `cat /proc/*/environ`.
- **Redirect to system paths:** `> /etc/passwd`/`/etc/hosts`/`/etc/sudoers`,
  `>> ~/.bashrc`, `> /usr/local/bin/<name>`, `| tee /etc/<file>`.

## Sources

NPM ignore-scripts / supply chain (nodejs-security.com, thehackernews.com 2026,
OWASP NPM cheat sheet, Microsoft Security Blog); Rust build.rs sandboxing
(rust-internals, shnatsel.medium.com); Bun lifecycle (bun.com docs,
bunsecurity.dev); Vitest CVE-2026-47428 (securityonline.info); Maven plugins
(javacodegeeks); Go cgo CVEs (tempus-ex.com); Pandoc filter RCE; nbconvert
CVE-2025-53000; kubectl read-only→admin escalation (hoop.dev, k8s RBAC good
practices, Evaneos/kubectl-readonly); LeakyCLI (thehackernews 2024, Orca);
AWS SecurityAudit/ReadOnly; curl|bash attacks (reflexframework, snakesecurity);
DB agent access (dev.to/getpochi); safecmd (AnswerDotAI); Pwning Claude Code
(flatt.tech); compound-command bug anthropics/claude-code#28183.
