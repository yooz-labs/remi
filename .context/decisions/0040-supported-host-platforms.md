# ADR 0040: Supported hosts are Apple Silicon Macs and Linux

**Status:** accepted
**Date:** 2026-10-10
**Owner:** Yahya

## Context

The release and file-tunnel probe matrices inherited four targets, including
Intel macOS. After an unnecessary Rosetta setup, the owner clarified that Remi
is offered for Apple Silicon Macs and Linux, with Linux x86 compatibility.

## Decision

Supported host binaries are `darwin-arm64`, `linux-arm64` and `linux-x64`.
The Mac product targets Apple Silicon (M1 and later).
Intel macOS is not a supported distribution or acceptance target.
Each two-version Bun matrix therefore requires six supported executions.
Linux x86_64 remains a required target alongside Linux ARM64.

Build, installer, npm, Homebrew and release declarations use those three targets.
This repository records prior Intel/Rosetta runs as historical extra work;
they impose no future gate or product dependency.
The native Xcode track applies the Apple Silicon scope to Mac archive settings.
Mobile and browser clients retain their existing platform requirements.

## Evidence and consequences

The owner's explicit instruction on 2026-10-10 supersedes the inherited
four-target matrix; #1233 records the roadmap decision and #1350 implements it.
Published historical artifacts are historical releases; this changes future
distribution declarations through the normal release train (ADR 0007).
File-tunnel race, authority and resource requirements remain unchanged.
