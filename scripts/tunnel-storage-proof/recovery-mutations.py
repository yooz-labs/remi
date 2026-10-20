#!/usr/bin/env python3
"""#1440: reuse exact compiled failure receipt controls for five journal semantics."""
import importlib.util
import sys
from pathlib import Path
from types import ModuleType
from typing import Protocol, cast

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent

def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

class MutationRunner(Protocol):
    approval: ModuleType
    MUTATIONS: dict[str, dict[str, str]]

    def main(self) -> int: ...


runner = cast(MutationRunner, load("storage_mutations", "storage-approval-mutations.py"))
runner.approval = load("recovery_matrix", "recovery-matrix.py")
MUTATIONS = {
    "ownership": {
        "file": "packages/daemon/src/tunnel/recovery.ts",
        "old": "  return stat.isFile() && stat.nlink === 1n && stat.uid === UID && (stat.mode & 0o7777n) === 0o600n;",
        "new": "  return stat.isFile();",
        "witness": "exact intent hardlink marker refusal",
    },
    "current-root": {
        "file": "packages/daemon/src/tunnel/recovery.ts",
        "old": "    if (this.closed || !this.scratch.isCurrent() || !this.metadata.isCurrent()) refuse();",
        "new": "    if (this.closed) refuse();",
        "witness": "exact scratch current root refusal",
    },
    "schema": {
        "file": "packages/daemon/src/tunnel/recovery.ts",
        "old": "    Object.keys(value).join() !== 'version,id,root,artifact' ||",
        "new": "    false ||",
        "witness": "exact intent schema marker refusal",
    },
    "cleanup-outcome": {
        "file": "packages/daemon/src/tunnel/recovery.ts",
        "old": "      const fd = this.artifact();\n      if (fd >= 0) {",
        "new": "      if (terminal) return 'cleaned';\n      const fd = this.artifact();\n      if (fd >= 0) {",
        "witness": "exact cleaned marker conflicting artifact refusal",
    },
    "canonical-bytes": {
        "file": "packages/daemon/src/tunnel/recovery.ts",
        "old": "  return JSON.stringify(value) === raw;",
        "new": "  return true;",
        "witness": "exact intent duplicate-key marker refusal",
    },
}

runner.MUTATIONS = MUTATIONS

if __name__ == "__main__":
    sys.exit(runner.main())
