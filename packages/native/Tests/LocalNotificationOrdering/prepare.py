#!/usr/bin/env python3
"""Prepare an opt-in iOS source-ordering fixture; never touches an owner app or device."""
from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat

HERE = Path(__file__).resolve().parent
NATIVE = HERE.parent.parent


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def replace_once(value: str, old: str, new: str, label: str) -> str:
    if value.count(old) != 1:
        raise RuntimeError(f"{label}: expected source anchor exactly once; inspect source before updating fixture")
    return value.replace(old, new)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("owned_directory", type=Path, help="existing empty mode-0700 directory owned by this user")
    target = parser.parse_args().owned_directory
    if not target.is_absolute() or target.is_symlink() or not target.is_dir():
        raise SystemExit("fixture directory must be an existing absolute non-symlink directory")
    meta = target.stat()
    if meta.st_uid != os.getuid() or stat.S_IMODE(meta.st_mode) & 0o077 or any(target.iterdir()):
        raise SystemExit("fixture directory must be empty, owned by this user, and private")
    shutil.copytree(NATIVE / "iPhone", target / "iPhone", symlinks=True)
    shutil.copytree(NATIVE / "RemiKit", target / "RemiKit", symlinks=True,
                    ignore=shutil.ignore_patterns(".build", "node_modules", "DerivedData"))
    (target / "Tests").mkdir()
    shutil.copyfile(HERE / "BurstSourceTests.swift", target / "Tests" / "BurstSourceTests.swift")
    shutil.copyfile(HERE / "BurstProbe.swift", target / "iPhone" / "BurstProbe.swift")
    shutil.copyfile(HERE / "project.yml", target / "project.yml")
    changes: dict[str, str] = {}

    app = target / "iPhone" / "RemiPhoneApp.swift"
    before = app.read_text()
    after = (HERE / "OwnedHost.swift").read_text()
    changes[str(app.relative_to(target))] = "".join(difflib.unified_diff(before.splitlines(True), after.splitlines(True), fromfile="production", tofile="owned-host"))
    app.write_text(after)

    coordinator = target / "iPhone" / "PhoneNotificationCoordinator.swift"
    before = coordinator.read_text()
    after = replace_once(before, "        guard await authorizationState().isAllowed else { return }", """        #if !BURST_DIAGNOSTICS
        guard await authorizationState().isAllowed else { return }
        #endif""", "authorization OS boundary")
    after = replace_once(after, "        try? await UNUserNotificationCenter.current().add(request)", """        #if BURST_DIAGNOSTICS
        await BurstProbe.shared.add(identifier: request.identifier, logicalID: id, body: request.content.body)
        #else
        try? await UNUserNotificationCenter.current().add(request)
        #endif""", "add OS boundary")
    after = replace_once(after, """        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: ids)
        center.removeDeliveredNotifications(withIdentifiers: ids)""", """        #if BURST_DIAGNOSTICS
        BurstProbe.shared.remove(ids)
        #else
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: ids)
        center.removeDeliveredNotifications(withIdentifiers: ids)
        #endif""", "remove OS boundary")
    changes[str(coordinator.relative_to(target))] = "".join(difflib.unified_diff(before.splitlines(True), after.splitlines(True), fromfile="production", tofile="instrumented"))
    coordinator.write_text(after)

    view = target / "iPhone" / "PhoneLiveRootView.swift"
    before = view.read_text()
    after = replace_once(before, """        .onChange(of: activeQuestionIDs, initial: true) { oldValue, newValue in
            guard notificationBaselineEstablished else {""", """        .onChange(of: activeQuestionIDs, initial: true) { oldValue, newValue in
            #if BURST_DIAGNOSTICS
            BurstProbe.shared.observe(newValue)
            #endif
            guard notificationBaselineEstablished else {""", "view observation")
    after = replace_once(after, """                Task {
                    await PhoneNotificationCoordinator.notify(""", """                Task {
                    #if BURST_DIAGNOSTICS
                    defer { BurstProbe.shared.finished(id) }
                    #endif
                    await PhoneNotificationCoordinator.notify(""", "notification task completion observation")
    changes[str(view.relative_to(target))] = "".join(difflib.unified_diff(before.splitlines(True), after.splitlines(True), fromfile="production", tofile="instrumented"))
    view.write_text(after)

    store = target / "RemiKit" / "Sources" / "RemiKit" / "Store" / "MachineStore.swift"
    before = store.read_text()
    after = replace_once(before, "    public private(set) var machines: [MachineState]\n", """    public private(set) var machines: [MachineState]
    // Isolated fixture wiring only. No transport is opened by this test seam.
    public func ownedBurstBind(_ endpoint: MachineEndpoint, generation: UUID) {
        connectionGenerations[endpoint] = generation
        parentByConnection[endpoint] = endpoint
    }
    public func ownedBurstReceive(_ event: RemiInboundEvent, endpoint: MachineEndpoint, generation: UUID) {
        receive(event, from: endpoint, generation: generation)
    }
""", "synthetic in-process event binding")
    changes[str(store.relative_to(target))] = "".join(difflib.unified_diff(before.splitlines(True), after.splitlines(True), fromfile="production", tofile="instrumented"))
    store.write_text(after)

    hashes = {}
    for name in changes:
        production = NATIVE / name
        hashes[name] = {"productionSHA256": digest(production.read_bytes()), "fixtureSHA256": digest((target / name).read_bytes())}
    (target / "instrumentation-diffs.json").write_text(json.dumps(changes, indent=2) + "\n")
    (target / "source-hashes.json").write_text(json.dumps(hashes, indent=2) + "\n")
    print(f"Prepared private fixture at {target}; review instrumentation-diffs.json before use.")


if __name__ == "__main__":
    main()
