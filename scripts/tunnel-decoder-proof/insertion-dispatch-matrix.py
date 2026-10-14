#!/usr/bin/env python3
"""Thin production insertion caller adapter for the unchanged supported-host runner."""

import importlib.util
import sys
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[1]
spec = importlib.util.spec_from_file_location(
    "insertion_dispatch_matrix", ROOT.parent / "tunnel-storage-proof/matrix.py"
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
            "packages/daemon/src",
            "packages/shared/src",
            "scripts/tunnel-decoder-proof",
            "scripts/tunnel-storage-proof",
        ),
        "source_tree_excludes": (
            "scripts/tunnel-decoder-proof/node_modules",
            "scripts/tunnel-storage-proof/node_modules",
        ),
        "dependencies": {
            "bonjour-service": "1.3.0",
            "grammy": "1.39.2",
            "jpeg-js": "0.4.4",
            "pngjs": "7.0.0",
            "qrcode": "1.5.4",
            "smol-toml": "1.6.0",
            "uqr": "0.1.3",
        },
        "entry": "scripts/tunnel-decoder-proof/insertion-dispatch-entry.ts",
        "compile_from_snapshot": True,
        "runtime_args": ("--owned-spike",),
        "container_prefix": "remi-insertion-dispatch",
        "linux_tmpfs_exec": True,
        "checks": {
            "actual compiled CLI worker stages PNG and JPEG",
            "one no-Enter reference and reordered retry replay per artifact",
            "actual compiled held hook refuses insertion and receives No",
            "revoked original grant cannot replay a cached result",
        },
        "scope": "Actual compiled direct production entry with inert cat CLI; no model or native acceptance; web caller checked separately",
    }


if __name__ == "__main__":
    sys.exit(storage.main(proof_for()))
