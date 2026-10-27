# ADR 0046: A bounded read-only model of the existing terminal

**Status:** accepted for the screen primitive; structural wire in ADR0047 and launch capture in #1620; secure transport/caller pending
**Date:** 2026-10-22
**Owner:** Yahya

## Context

The owner selected a read-only view of the existing agent terminal under #1595.
Input stays in chat and approval controls; this is not a general shell.
The existing ANSI/transcript parser cannot reconstruct a current viewport.
The first isolated headless candidate failed the original 256 KiB state gate.
The owner then approved qualifying 1 MiB/session and 32 models/32 MiB per home,
retaining 240×60 maximum geometry, 32 KiB text and 64 KiB frames.
The original failure is preserved in [the initial report](../../docs/terminal-screen-characterization.md).

## Decision

Use exact `@xterm/headless` 6.0.0 behind `BoundedScreen`, with no scrollback,
only its pinned Unicode-6 buffer API and no PTY/process or external-action sink.
The initial primitive used unchanged upstream JavaScript with a license-only
Bun patch. Ownership phase #1625 extends that patch with a reproducible runtime
derivative: dense content with lazy zero-default foreground/background planes.
The published 6.0.0 JavaScript and source maps remain unchanged as controls,
but the package entry selects the derived bundle.
The original 49 upstream buffer cases were committed before modification and
run against both classes; the actual published and installed engines are also
compared after writes/resizes. See the readable patch, pinned source manifest
and offline generator in `scripts/terminal-engine/`, and
[ownership qualification](../../docs/terminal-view-ownership.md).
MIT notices remain included. No parser, terminal filter, public buffer API,
input boundary or memory limit is broadened.
The proposed buffer API and exact dependency version remain explicit risks.

The primitive accepts owned output and existing local geometry, and returns one
shared immutable complete monochrome viewport with bounded rows/text/cursor.
It never writes input, submits chat, answers approvals or resizes a PTY.
Partial controls/synchronized draws expose no snapshot.
Malformed, unsupported or overloaded state retires the observer without replay,
silent truncation or a fabricated current screen.

Enforce 2–240 columns, 1–60 rows; 64 KiB/eight queued operations including active
input; 2 KiB parser slices and cumulative joining input; 128-byte controls;
16 KiB ignored known OSC metadata; 64-byte cells; 32 KiB per-buffer text; and
64 KiB snapshot JSON minus a 1 KiB future-envelope allowance.
Charge terminal work before dispatch and yield between bounded slices.
Refuse concealment/ambiguous SGR and REP after joining input rather than expose
hidden text or create uncharged combined-string maps.
See [the bounded-model report](../../docs/terminal-screen-bounded-model.md) for
the complete admission rules, preserved failures and receipts.

The 1 MiB necessary gate passed finite retained-heap controls on all six
supported compiled platform/runtime pairs from ADR0040.
It includes maximum geometry, alternate state, a full pending queue, cached
snapshot and one serialized send projection; it is not an OS/allocator ceiling.
The source held-hook No path also passed accepted output/work load and a
discriminating blocking control, without PTY input.

## Runtime boundary and consequences

This decision selects a component, not a terminal transport or client feature.
The original primitive phase added no CLI constructor/caller, registry addition,
`terminal_view` advertisement, view lease, home quota or native pane.
ADR0047 subsequently added the strict structural wire; #1617/#1618 added shared
reservations; [#1620](../../docs/terminal-capture.md) composes reserved capture
before harness start, with bounded native-fragment batching and borrowed disposal.
These additions expose no terminal transport or capability.
The secure service must still reserve send capacity and retire views on current
grant/binding/runtime/connection changes.
Predating or unsupported capture must report unavailable.

New wire fields require the strict registry, shared refusal/positive vectors
and total consumer handle-or-ignore declarations (ADR0012–0014).
Direct terminal snapshots require WSS with existing authenticated authority;
relay snapshots require the encrypted semantic child path.
Raw PTY, terminal input/resize and emulator replies stay refused on that path.
The selected component does not weaken those boundaries or advertise support
before a real secure handler and shipping caller pass.
Native cell/font parity, signed hardware and deployed acceptance remain separate.
