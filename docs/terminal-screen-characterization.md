# Read-only terminal screen characterization (#1595, B1 #1608)

2026-10-22. Source baseline: `58024f069505ef7580147d0981b7dd78f21bfc0e`.
The owner approved terminal-first execution of the [backend plan](../.context/issue-1595-backend-plan.md), merged through [#1607](https://github.com/yooz-labs/remi/pull/1607).

## Result

**No production candidate selected.** The isolated `@xterm/headless` 6.0.0 candidate fails the original 256 KiB screen-state gate at 240 columns by 60 rows with the alternate screen active.
Its reachable array buffers alone occupy **366,722 bytes**, before counting JavaScript objects, strings, queued input or a serialized snapshot.
The failure reproduces on source and compiled Apple Silicon Mac executions on both pinned Bun versions, 1.3.11 and 1.4.2.
Do not advertise `terminal_view` or freeze a runtime contract from these results.

The candidate passed 11 bounded screen controls per execution on those same two runtimes, both from source and from compiled binaries: 44 final diagnostic control executions.
Two additional compiled negative controls deliberately write one byte to the owned PTY; each fails the exact zero-input assertion with an actual count of one.
Those successes do not override the resource failure or establish native rendering, authority, supported-host qualification or release acceptance.

## Candidate and isolation

Use the exact npm package `@xterm/headless` 6.0.0, declared MIT, with no transitive dependencies in its package metadata.
Its package-declared commit matches the official `6.0.0` tag at `f447274f430fd22513f6adbf9862d19524471c04`.
The candidate's [headless package](https://github.com/xtermjs/xterm.js/tree/6.0.0/headless) and installed typings describe the server-side API; the viewport access used here requires `allowProposedApi: true`.
That experimental API remains an adoption consideration, not a new production dependency.

The package, its lockfile, upstream MIT license, source probes, initial failed fixture, JSON receipts, compiled binaries, logs and SHA-256 membership manifest are retained under:

```text
/Volumes/S1/yooz/remi/artifacts/terminal-screen-20261022/
  PRE-REGISTERED.md
  candidate/
  binaries/
  compiled-runs/
  manifest.json
```

No daemon/shared/native dependency, runtime hook, protocol registry, capability or live session was changed.
The controls start owned PTY child processes with a minimal environment; they do not launch Claude/Codex, use credentials or send a provider turn.
Compiled probes execute from an empty owned working directory, without the candidate's `node_modules` at that working directory.

## Gates registered before execution

The unchanged plan requires an accurate current screen for redraw, erasure, cursor placement, alternate screens, Unicode chunking and local terminal resize.
The read-only viewer must never write terminal input or cause clipboard/network actions.

Existing proposed limits remain 240 columns, 60 rows, 32 KiB aggregate screen text, 64 KiB encoded message, 256 KiB screen/parser/pending state per session, and at most 32 models/8 MiB per home.
The existing actual-held-answer limit is 1,000 ms before adoption.

Resource admission is a necessary gate.
Reachable array-buffer storage above 256 KiB disproves the budget; a value below it is not a pass or an allocation upper bound.
Snapshot byte length and process RSS are different measurements and cannot establish retained screen-state accounting.

## Measured resource result

The diagnostic walks own data properties, maps and sets, without invoking getters or following function closures.
It counts each reachable `ArrayBuffer`/`SharedArrayBuffer` once, including buffers shared by multiple views.
It does not estimate JavaScript object/string storage, so its result is deliberately a lower bound.
Private-field inspection is confined to this pinned qualification probe, not selected as a production API.

| Geometry | State | Reachable array-buffer bytes | Against 262,144-byte gate |
|---|---|---:|---|
| 120 x 40 | Normal | 78,722 | Not disproved; not a resource pass |
| 120 x 40 | Alternate active | 136,322 | Not disproved; not a resource pass |
| 120 x 40 | Alternate restored | 78,722 | Not disproved; not a resource pass |
| 240 x 60 | Normal | 193,922 | Not disproved; not a resource pass |
| 240 x 60 | Alternate active | **366,722** | **Fails** |
| 240 x 60 | Alternate restored | 193,922 | Not disproved; not a resource pass |

All six values are identical in the four measured source/compiled Mac executions.
The active-alternate control discriminates the extra allocation: returning to the normal screen lowers the observed buffers, while the unchanged active state exceeds the original gate.
Inspecting only the restored normal screen would miss that peak; the earlier restored-only diagnostic receipt is retained separately and is not used as peak acceptance.

This agrees with the pinned [BufferLine implementation](https://github.com/xtermjs/xterm.js/blob/f447274f430fd22513f6adbf9862d19524471c04/src/common/buffer/BufferLine.ts): each cell uses three 32-bit words.
Two 240 x 60 buffers therefore need 345,600 bytes for cell words alone, before the parser's buffers and other state.
This explains the observed failure without claiming total process or complete retained-heap accounting.

## Actual PTY behavior diagnostics

Each of the first ten controls starts a real owned PTY child and feeds its output bytes to the actual candidate while the child remains alive.
The parent signals completion only after parsing; the child then continues observing terminal input for 100 ms and reports its byte count over IPC before exit.
All ten observed zero input bytes on each final execution.
The normal viewer path does not forward input or emulator replies to the child.
The explicit `--negative-write-control` fault path writes `X` to that same live PTY: both compiled runtimes report one actual input byte and fail `overwrite: actual child input`, proving that the zero-input oracle discriminates a real wrong write.
The final control resizes the observer's model locally; it is not a remote resize of a user's agent terminal.

| Control | Checked outcome |
|---|---|
| Overwrite | Carriage return replaces existing cells rather than appending transcript text |
| Erase line | Erased sentinel content is absent from the current screen |
| Cursor redraw | Explicit cursor positioning updates the intended row/column |
| Active alternate screen | Explicitly homed alternate viewport is visible |
| Alternate restoration | The normal viewport and saved cursor are restored |
| Wide and combining text | Basic CJK width and a combining accent produce the expected cells/cursor |
| Split UTF-8 | Feeding captured output one byte at a time preserves the same Unicode screen |
| Split escape sequence | Byte-wise CSI parsing preserves the same erased/redrawn screen |
| Inert OSC metadata | Clipboard/link control strings do not enter visible lines; the headless viewer performs no clipboard/URL action |
| Terminal query | The viewport remains correct and the actual child receives zero input bytes |
| Local model resize | Content survives a supported change from 20 x 4 to 30 x 6 |

The OSC control is a finite headless-library diagnostic, not a native active-content or network-observation acceptance test.
The query emitted no observed `onData` reply under this candidate/options combination; future integration must still provide no output-to-PTY reply path.
Unicode coverage here is basic, not comprehensive grapheme/emoji or native-font cell-width parity.
The 32 KiB/64 KiB serialization boundaries, view leases and device/grant/binding lifecycle are not exercised by these standalone behavior controls.

### Preserved initial fixture failure

The first diagnostic expected entry into the alternate screen to home the cursor, but its output never requested a home operation; the actual screen contained four leading spaces before `alt`.
The corrected owned fixture explicitly emits `CSI H` after switching screens, retaining its original expected viewport/cursor.
The original source and failed stderr are preserved as `candidate/pty-probe-initial.ts` and `candidate/pty-mac-1311-initial.stderr`.
This was a fixture-oracle error, not evidence of a candidate defect or a relaxation of the resource gate.

An intermediate behavior probe parsed captured output after child exit.
Its zero-input receipts could not discriminate live write-back, so those preliminary probes/receipts are preserved with `preliminary` names and excluded from the final counts above.
The corrected live handshake and deliberate wrong-write controls replace that incomplete oracle.

## Reproduction and receipts

Install the pinned candidate in an owned directory with `bun install --ignore-scripts` and this private manifest:

```json
{
  "name": "remi-terminal-screen-candidate",
  "private": true,
  "dependencies": { "@xterm/headless": "6.0.0" }
}
```

Use `candidate/resource-probe.ts` and `candidate/pty-probe.ts` from the retained evidence root.
Remove contradictory color variables in the probe process only.
For each pinned Bun executable, run source probes, compile them with `bun build --compile`, and run the binaries from an empty owned directory:

```sh
env -u FORCE_COLOR -u NO_COLOR /path/to/pinned-bun resource-probe.ts
env -u FORCE_COLOR -u NO_COLOR /path/to/pinned-bun pty-probe.ts
/path/to/pinned-bun build --compile resource-probe.ts --outfile /owned/bin/resource
/path/to/pinned-bun build --compile pty-probe.ts --outfile /owned/bin/pty
/owned/bin/pty --negative-write-control
```

The last command must exit 1 at the named zero-input assertion with actual 1 and expected 0; an unrelated process failure is not an accepted negative control.

The manifest hashes 54 retained source/dependency/build/log/receipt files, including the preregistration, and separately pins both compiler binary hashes at this checkpoint.
Important source hashes:

| File | SHA-256 |
|---|---|
| `candidate/resource-probe.ts` | `a7f42d99bd039fd7c6baacfef23e0a85053e4115a936330776b4d445d925085b` |
| `candidate/pty-probe.ts` | `584a39b144c4828da5492a65086f2a4a5f1696c2f393700e0ffc4c054d2252b6` |
| `candidate/bun.lock` | `6be1e9ccaa43a796f12c6577e34dc105b252e26b12cf96c3ec2818938f61209f` |
| `candidate/node_modules/@xterm/headless/lib-headless/xterm-headless.js` | `17a90b650cf6b77cce2b98c4063884d43545e4ce177a54b76ccfc906f1aacaed` |

## Next gate

Keep the original failed result and select no production dependency/capability.
The pending policy choice is to qualify a larger bounded screen-state budget (proposed 1 MiB/session, at most 32 MiB/home) or retain 256 KiB and restrict supported geometry.
Neither choice is a candidate resource pass; both need explicit pre-registered admission, bounded input/parser/queue state and supported-host qualification.
The existing 32 KiB screen-text/64 KiB message bounds, read-only behavior, WSS/encrypted-relay requirement and current authority rules stay intact.

After that choice, qualify a bounded ingestion/model adapter, including OSC/DCS payloads, long combining sequences, geometry changes, slow consumers and allocation accounting beyond typed arrays.
Discard emulator replies without a PTY input path.
Only then finalize an ADR and proceed to the strict wire phase.

The full Linux ARM64/x64 compiled matrix, actual held-hook responsiveness under screen load, authority/revocation lifecycle, WSS/relay caller, native rendering and signed/deployed acceptance remain unmeasured here.
They were not run to compensate for a failed necessary resource gate.
Media and profiles retain their approved follow-up scope after the terminal work.
