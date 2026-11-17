# Account profiles

Profiles are configured in `config.toml` under `[profiles.<id>]`, with a label and at least one `claude` or `codex` table. Each harness table declares `expects` and may adopt an absolute or `~/` directory. Without a directory, remi uses `<remi home>/p/<id>/<harness>`. A profile may also specify a default harness, arguments, folder matches and noncredential environment values. The optional `[profiles]` `default` names a configured profile. Invalid profile configuration disables profiles without disabling other configuration.

Local session launches select `--remi-profile <id>`, then `REMI_PROFILE`, then the longest matching folder, then the machine default, then the built-in `default`. Resolution uses the session directory. A hub child resolves independently; a hub's inherited `REMI_PROFILE` supplies its default for new children. An omitted remote harness still selects Claude. The built-in profile leaves the existing environment and login path unchanged. This slice adds no protocol messages or capabilities.

`remi profile ls` reports effective sign-in states, and `remi profile show <id>` also shows local configuration and warnings. Checks use the harness status commands and discard identity fields. A configured profile must pass its effective-login check before the agent starts. The Claude subscription values `claude.ai` and `firstParty` are unconfirmed until owner gate OG-P1. Codex status uses its configured home with the default, file, or keyring store; the characterization is in [the P1C note](../../.context/profiles-codex-credentials.md).

`remi profile add <id> --label <name> --claude` creates configuration and an empty default directory; `--codex` adds Codex, and the corresponding `--claude-dir` or `--codex-dir` adopts an existing directory. `--expects api_key` selects an API-key expectation. `remi profile login <id>` runs the harness's own interactive login in the person's terminal; use `--harness` when both are configured. The Console login warning is shown before an API-key Claude login.

Configured-profile launches remove inherited credential and provider selectors before the status probe and the agent start. Codex provider `env_key` and `env_http_headers` names from its `config.toml` are also removed; a profile cannot set them in `env`. AWS and Google identity environment variables are removed for both harnesses. Cloud tools can still use file-based defaults, such as AWS configuration and application-default credentials, which remi neither reads nor changes. Whether profile `env` can later carry cloud identity pointers is owner call J20.

The session record stores the selected profile and its revision. A separate mode-0600 `session-profiles.json` preserves profile ownership evidence if an older writer removes fields from the record. It narrows, but does not close, the older-remi hazard: an older binary that resumes by itself never reads the sidecar. Resume uses the stored profile rather than folder mapping or a hub's inherited default; a missing or changed profile, conflicting selection, or disagreement with the sidecar is refused before launch. Hub resumes keep their harness arguments after `--` and the child reads the record. A process resuming in place refuses a session belonging to a different profile.

Local refusals name the missing sign-in, unsupported expectation or harness, conflicting profile, changed profile, or invalid configuration. A child refusal is logged locally and a remote requester sees `The session's profile could not start. Run remi profile ls on the machine.` Explicit non-default `--remi-profile` with `--host` is refused before connecting; local `REMI_PROFILE` does not select a remote profile and produces a notice instead.

Refusal messages include:

- `Profile <id> does not configure <harness>.` and `Profile <id> expects <value>, which this build does not support.`
- `Profile <id> is not signed in to <harness>. Run: remi profile login <id> --harness <harness>`, `This profile's login is not what will be used (<source>).`, and `Could not confirm the sign-in of profile <id> (<reason>). Run: remi profile ls`.
- `Profile <id> sets <name>, which its Codex configuration reads as a credential; remi does not store credentials.` and `Could not read the Codex configuration of profile <id> (config.toml).`
- `This session's profile information was changed by another remi process. Start a new session.`, `This session was started in profile <id>, which no longer exists. Start a new session.`, and `Profile <id> changed after this session started. Start a new session.`
- `This session belongs to profile <id>. Resume it without --remi-profile, or with --remi-profile <id>.` A different-profile in-process resume directs the person to the hub or `remi --resume` on the machine.
- `Choosing a profile for a session on another machine is not supported yet. That machine's folder mapping or default profile applies; run the command without --remi-profile.`

Profile labels on session-list entries, remote selection and visibility, hub discovery across multiple profile transcript roots, the profile session status line, and download protection for inactive profiles remain for phase 2. A running profile session uses its selected directories for transcript discovery and download roots.

Warnings name potentially relevant Anthropic profiles and managed, user or project settings without displaying values. macOS managed preferences are not inspected. Unknown expectation kinds load but their sign-in is not checked in this build.

A profile id is a lowercase letter or digit followed by up to 31 lowercase letters, digits or hyphens; at most 32 profiles can be configured. The five reserved future settings are accepted with one notice per boot and are not used in this version. A bad profile table makes `remi profile` commands print the error and exit; `remi config` shows profile ids and labels or the error. Unknown expectation kinds report `unknown (not_checked)`.
