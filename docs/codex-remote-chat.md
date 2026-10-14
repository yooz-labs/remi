# Codex structured remote chat (#1207)

## Decision and current scope

The owner chose structured `turn/start` and `turn/steer` on 2026-10-13,
with the current full-access default retained.
An explicit read-only session remains read-only.
The host's existing launch policy and remote argument allowlist still apply.
See [ADR 0033](../.context/decisions/0033-codex-adapter-app-server.md#structured-remote-chat-decision-1207-2026-10-13).

This first step adds an internal `CodexTextWriter` only.
There is no production caller, public chat contract or advertised capability yet.
Codex's existing `acceptsTypedChat: false` is unchanged.
Nothing in this module types text or Enter into a PTY.

## Internal submission

A request names the exact bound main thread and a client message UUID.
Text is nonblank, valid UTF-8, NUL-free and at most 16 KiB.
A caller supplies a synchronous current-authority check and an opaque runtime epoch,
replaced on runtime, app-server connection or main-thread identity changes.

The writer checks live metadata and local blocking questions.
An idle first turn does not need materialized history.
An active turn uses a bounded latest-turn read and atomic `expectedTurnId` on steer.
The writer checks authority again immediately before its single possible turn RPC.
Every turn request omits sandbox, approval-policy, working-directory and model overrides.

Results mean:

- `accepted`: Codex returned a valid correlated turn ID on the current runtime.
  The named method is not proof of a newly created turn; a start can append to a turn that became active meanwhile.
  Acceptance is not model completion.
- `refused`: no turn RPC was attempted by this writer.
- `uncertain`: a turn RPC may have taken effect, but its outcome cannot be established.
  The writer never automatically retries, falls back from steer to start, or writes PTY input.

The later production caller must own authenticated device/session authority,
request-ID replay/conflict handling and uncertain-result retention.
`clientUserMessageId` provides correlation; this implementation does not claim server deduplication.
The ordinary Remi input ACK is receipt before its handler and cannot serve as a submission result.

## Accountless installed-server control

Ordinary tests construct the real client in an unstarted state and check local refusal.
The installed-server control is opt-in and requires the actual native Codex binary.
For example, with a short canonical temporary path:

```sh
TMPDIR=/Volumes/S1/yooz/remi/tmp \
REMI_CODEX_ACCOUNTLESS_CLI=/absolute/path/to/native/codex \
bun test packages/daemon/tests/harness/codex/codex-text-writer.test.ts
```

The control starts an owned app-server with a new private HOME and CODEX_HOME,
file-only credential storage and an explicit environment whitelist.
It asserts `account: null` before any turn request and stops on any non-null account.
It checks actual default/read-only thread settings,
then exact start/steer parameters, binding/authority changes and a withheld real response.
Its transport tap forwards every request to the installed server and fabricates no response.
It reaps its owned process and removes its private profile afterward.
An optional `REMI_CODEX_ACCOUNTLESS_RECEIPT` path records binary hash,
account absence, measured checks and process cleanup without message bodies.

These checks establish local RPC admission and omission of policy overrides.
They do not establish model completion, model-side steering or sandbox enforcement.
An account-backed model check needs separate bounded owner approval.
Native device UI and the connected daemon/client path remain later steps.
