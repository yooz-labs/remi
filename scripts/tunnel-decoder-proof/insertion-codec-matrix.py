#!/usr/bin/env python3
"""Thin accepted insertion codec adapter for the unchanged supported-host runner."""

import importlib.util
import sys
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[1]
spec = importlib.util.spec_from_file_location(
    "insertion_storage_matrix", ROOT.parent / "tunnel-storage-proof/matrix.py"
)
assert spec is not None and spec.loader is not None
storage = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = storage
spec.loader.exec_module(storage)


def proof_for(source=REPO):
    return {
        "source": source,
        "files": ("tsconfig.json", "package.json", "bun.lock", "bunfig.toml"),
        "source_trees": (
            "packages/shared/src",
            "packages/shared/tests/fixtures/image-staging",
            "packages/shared/tests/fixtures/image-insertion",
            "scripts/tunnel-decoder-proof",
            "scripts/tunnel-storage-proof",
        ),
        "source_tree_excludes": (
            "scripts/tunnel-decoder-proof/node_modules",
            "scripts/tunnel-storage-proof/node_modules",
        ),
        "entry": "scripts/tunnel-decoder-proof/insertion-codec-probe.ts",
        "compile_from_snapshot": True,
        "runtime_args": ("--owned-spike",),
        "container_prefix": "remi-insertion-codec",
        "checks": {
            "insertion golden frames and exact correlated ingress",
            "original staging codec behavior unchanged",
        },
        "expected": {
            "counts": {"insertionPositive": 14, "insertionNegative": 282, "stagingCharacterized": 503},
            "stagingHash": "6e4b00965be6f1ec973b1cc891778101200adc39471a5e8526fab4737b4cc8dd",
        },
        "scope": "Shared structural codecs; no production insertion or Swift conformance",
    }


if __name__ == "__main__":
    sys.exit(storage.main(proof_for()))
