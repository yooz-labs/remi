#!/usr/bin/env python3
"""#1417: actual interpreter-policy refusal plus the shared strict compiled assertion gate."""

import importlib.util
import json
import math
import sys
from collections.abc import Callable
from pathlib import Path
from types import ModuleType
from typing import Protocol, cast

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent


def load(name: str, filename: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, filename)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def policy_rejection_reasons(log_text: str, _receipt: dict) -> list[str]:
    """Only real one-shot policy exit23 can support the named parent assertion."""
    records = []
    for line in log_text.splitlines():
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and "workerPolicyChildExit" in value:
            record = value["workerPolicyChildExit"]
            if isinstance(record, dict) and record.get("phase") == "one-shot":
                records.append(record)
    if len(records) != 1:
        return ["exactly one actual one-shot policy child observation is required"]
    record = records[0]
    if set(record) != {
        "phase",
        "pid",
        "exitCode",
        "signalCode",
        "elapsedMs",
        "awaitedExit",
        "reaped",
        "missingAfterExit",
    }:
        return ["one-shot policy child observation has malformed fields"]
    pid = record["pid"]
    elapsed = record["elapsedMs"]
    if (
        not isinstance(pid, int)
        or isinstance(pid, bool)
        or pid <= 0
        or not isinstance(elapsed, (int, float))
        or isinstance(elapsed, bool)
        or not math.isfinite(elapsed)
        or not 0 <= elapsed <= 5000
    ):
        return ["one-shot policy PID or existing five-second lifetime is invalid"]
    if (
        not isinstance(record["exitCode"], int)
        or isinstance(record["exitCode"], bool)
        or record["exitCode"] != 23
        or record["signalCode"] is not None
        or record["awaitedExit"] is not True
        or record["reaped"] is not True
        or record["missingAfterExit"] is not True
    ):
        return [
            "actual policy exit23 without signal and with awaited ESRCH is required"
        ]
    return []


class MutationRunner(Protocol):
    approval: ModuleType
    SUPPORT_MODULES: tuple[ModuleType, ...] | list[ModuleType] | None
    EXTRA_RUNTIME_REJECTION_REASONS: (
        Callable[[str, dict], list[str] | tuple[str, ...]] | None
    )
    MUTATIONS: dict[str, dict[str, str]]

    def main(self) -> int: ...


runner = cast(
    MutationRunner,
    load(
        "policy_shared_mutations",
        ROOT.parent / "tunnel-storage-proof" / "storage-approval-mutations.py",
    ),
)
approval = load("policy_approval_matrix", ROOT / "approval-matrix.py")
runner.approval = approval
runner.SUPPORT_MODULES = (
    sys.modules[__name__],
    approval,
    approval.decoder,
    approval.storage,
    cast(ModuleType, runner),
)
runner.EXTRA_RUNTIME_REJECTION_REASONS = policy_rejection_reasons
runner.MUTATIONS = {
    "interpreter-policy": {
        "file": "scripts/tunnel-decoder-proof/process.ts",
        "old": "    BUN_JSC_useJIT: '0',",
        "new": "    // Removed shared interpreter policy.",
        "witness": "worker policy witness: isolated interpreter decodes original PNG",
    },
}


if __name__ == "__main__":
    sys.exit(runner.main())
