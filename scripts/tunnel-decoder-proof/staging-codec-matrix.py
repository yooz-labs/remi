#!/usr/bin/env python3
"""Thin image-staging adapter for the unchanged supported-host snapshot runner."""

import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[1]


def load(name: str, path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


storage = load("staging_storage_matrix", ROOT.parent / "tunnel-storage-proof/matrix.py")


def proof_for(source=REPO):
    return {
        "source": source,
        "files": ("tsconfig.json", "package.json", "bun.lock", "bunfig.toml"),
        "source_trees": (
            "packages/shared/src",
            "packages/shared/tests/fixtures/image-staging",
            "scripts/tunnel-decoder-proof",
            "scripts/tunnel-storage-proof",
        ),
        "source_tree_excludes": (
            "scripts/tunnel-decoder-proof/node_modules",
            "scripts/tunnel-storage-proof/node_modules",
        ),
        "entry": "scripts/tunnel-decoder-proof/staging-codec-probe.ts",
        "compile_from_snapshot": True,
        "runtime_args": ("--owned-spike",),
        "container_prefix": "remi-staging-codec",
        "checks": {
            "nine shapes golden roundtrips and raw refusals",
            "owned PNG JPEG chunk reconstruction and digests",
        },
        "expected": {
            "images": json.loads(
                (
                    source / "packages/shared/tests/fixtures/image-staging/vectors.json"
                ).read_text()
            )["images"]
        },
        "scope": "Dormant wire codec; no lifecycle or Swift runtime acceptance",
    }


if __name__ == "__main__":
    sys.exit(storage.main(proof_for()))
