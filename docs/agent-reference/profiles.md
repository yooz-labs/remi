# Account profiles, phase 1A

Profiles are configured in `config.toml` under `[profiles.<id>]`, with a label and at least one `claude` or `codex` table. Each harness table declares `expects` and may adopt an absolute or `~/` directory. Without a directory, remi uses `<remi home>/p/<id>/<harness>`. A profile may also specify a default harness, arguments, folder matches and noncredential environment values. The optional `[profiles]` `default` names a configured profile. Invalid profile configuration disables profiles without disabling other configuration.

The resolver selects a flag, then `REMI_PROFILE`, then the longest matching folder, then the machine default, then the built-in `default`. The built-in profile preserves existing sign-ins. The resolver and environment builder are present for the next slice: **no session launch follows a profile yet**. This slice adds no protocol messages or capabilities.

`remi profile ls` reports effective sign-in states, and `remi profile show <id>` also shows local configuration and warnings. Checks use the harness status commands and discard identity fields. Claude's subscription status expects `claude.ai`, a value read from the 2.1.325 binary but not yet confirmed by the owner gate OG-P1. Codex status is checked only for a home explicitly configured with `cli_auth_credentials_store = "file"`.

`remi profile add <id> --label <name> --claude` creates configuration and an empty default directory; `--codex` adds Codex, and the corresponding `--claude-dir` or `--codex-dir` adopts an existing directory. `--expects api_key` selects an API-key expectation. `remi profile login <id>` runs the harness's own interactive login in the person's terminal; use `--harness` when both are configured. Codex login requires the explicit file store. The Console login warning is shown before an API-key Claude login.

Warnings name potentially relevant Anthropic profiles and managed, user or project settings without displaying values. macOS managed preferences are not inspected. Unknown expectation kinds load but their sign-in is not checked in this build.
