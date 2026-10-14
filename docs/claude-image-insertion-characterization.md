# Installed Claude image references (#1170)

Measured on 2026-10-13 with the owner-authorized four-turn check.
This is an installed-CLI observation, not a shipped image-insertion caller.

## Inputs and scope

The installed Apple Silicon Claude Code executable was version `2.1.296`, SHA-256 `c9b5341637becbd423ddffc5b254afb645682a3868cb708bbc6cc0e7bb419937`.
The selected model reported `claude-sonnet-5-5` with low effort.
Four short user turns ran in an isolated directory/configuration on S1, with safe mode, an empty tool set and no MCP servers.
Only generated 128-by-128 color-quadrant images were sent.
The owner account's existing authorization was used; no login or owner configuration was changed.

The [official image workflow](https://code.claude.com/docs/en/common-workflows#work-with-images) documents image paths and clipboard input.
The [file-reference workflow](https://code.claude.com/docs/en/common-workflows#reference-files-and-directories) documents `@` paths.
The observations below establish behavior for this installed version, rather than infer it from those descriptions.

## Observations

| Control | Observed result |
|---|---|
| `@"/absolute/space directory/sample.png" `, written without Enter | No user turn or file attachment appeared during the subsequent four-second observation. The recorded write had zero CR/LF bytes. |
| Separate Enter for that PNG | The transcript persisted the PNG's base64 content and actual dimensions as a file attachment. The answer correctly named the four colors. |
| JPEG and extensionless PNG paths, written without Enter | The recorded write had zero CR/LF bytes. A separate Enter produced two image attachments with the expected bytes/media types and two correct color descriptions. |
| Delete all three originals, normal `/exit`, then `--resume` | Startup reconstructed the prior conversation. One short follow-up answered the requested colors correctly while all originals remained absent. The transcript retained the image encodings. |
| New PNG reference in the draft, then delete it before Enter | The subsequent turn added no image attachment for that path. Its model response was unusable with tools disabled; that response is not a successful refusal check. |

The first reference write was 178 bytes including its test question; the second was 281 bytes.
These were Python PTY writes to the real CLI, not calls to Remi's new insertion method.
Remi's separately tested queue method supplies the no-Enter effect; production artifact acquisition, prompt/authority checks and client dispatch still need their own integration.

| Persisted image | Input bytes | SHA-256 |
|---|---:|---|
| PNG with spaces in its parent path | 398 | `7630c2bb88d7af9e128c4adbccb04dc77a98d002a1b1940f662aa2b77a29e4cc` |
| JPEG | 1,133 | `d3834fc431c299ec5064862c53d94474aa688ff8f4b848f9d72614ca39ac5daf` |
| Extensionless PNG | 398 | Same PNG bytes above |

Raw terminal captures, control events, the owned driver, isolated transcript and `cli-receipt.json` are retained under `/Volumes/S1/yooz/remi/artifacts/2026-10-13-insertion-cli-check/`.
The receipt records exactly four user turns.
Both owned CLI processes were stopped, with their absence verified.
The resumed probe's shutdown wait required stopping its Python driver to close the PTY master; no further model turn ran.
Model checks must remain opt-in; CI does not run them.

## Lifetime conclusion and limits

Typing an `@path` does not establish image consumption.
The measured file attachments appeared only after submission, and an original removed before submission was not attached.
An inserted reference therefore needs a readable original while it waits in the draft.
The 24-hour/session-exit staging policy cannot promise an indefinitely valid unsent draft.
The insertion contract must explicitly settle that expiration behavior before advertising availability.

The normal exit/resume observation and persisted image bytes support the measured submitted-image lifecycle.
The follow-up colors could also be deduced from earlier text answers, so this is not an isolated image-only recall proof.
Compaction, future CLI versions, long-term retention and later agent file reads were not measured.
Paths containing literal quotes, backslashes or controls were not accepted by this check; spaces in a quoted absolute path were.

## Additional exact managed-path check

The owner separately authorized one additional generated-image turn on 2026-10-13.
The same executable and model received two quoted real JournalRead `.artifact`
paths in a private home with spaces outside an otherwise empty Claude project.
Typing wrote 486 bytes with zero CR/LF; five seconds later the transcript had
no user message. One separate Enter submitted the turn.

**This exact route failed.** Neither PNG nor JPEG became an embedded image.
Both references were read as raw bytes, and the model declined to name colors.
The observation does not isolate the suffix from the outside-project location;
it disproves availability for these exact paths. The earlier `.png` / `.jpg`
and extensionless-PNG observations remain valid for their measured paths.

The child was reaped with no second turn. Both journals settled with zero
retained charge. Driver, events, transcript and cleanup evidence are under
`exact-route-check/` in the artifact directory above. Exactly five approved
user turns have now been used in total. CI runs none of these model checks.

New image journals use a host-selected `.png` / `.jpg` name from creation,
persisted in their lease and immutable version2 ownership markers. Legacy
`.artifact` journals retain their original version1 name and cleanup route.
No completed file is renamed, linked or copied; quotas and lifetime stay the
same. An older binary rejects the new ledger fields and cannot recover those
rows; use the matching current daemon to retain and settle their charge.
The corrected exact-path model check is still pending separate authorization.
Insertion remains unavailable.

## Queue prerequisite

`PTYSession.insertText` uses the existing serialized queue, requires a synchronous guard at the actual effect and rejects empty/control-containing text.
It writes one literal text payload and appends no Enter.
True means the terminal write returned, false means the guard refused before writing, and a thrown error remains the caller's responsibility to classify against its possible-write retirement record.
This method has no production caller or capability by itself.
Real `/bin/cat` controls cover exact no-Enter bytes, queue ordering, changed queued validity, throwing guards, control refusal and an exited terminal.
