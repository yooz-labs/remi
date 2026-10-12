#!/usr/bin/env python3
"""Run the decoder and held-approval proof from an immutable repo snapshot."""

import importlib.util
import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[1]
spec = importlib.util.spec_from_file_location("decoder_matrix", ROOT / "matrix.py")
assert spec is not None and spec.loader is not None
decoder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(decoder)
CHECKS = decoder.CHECKS | {
    "PNG held No under repeated actual decoder load",
    "JPEG held No under repeated actual decoder load",
    "synchronous parent block makes held No exceed one second",
}
inputs = json.loads((ROOT / "inputs.json").read_text())
snapshot_scripts = "scripts/tunnel-decoder-proof"

storage = decoder.module


def proof_for(source=REPO):
    return {
        "source": source,
        "files": (
            "tsconfig.json",
            "package.json",
            "bun.lock",
            "bunfig.toml",
            "scripts/tunnel-storage-proof/matrix.py",
            "scripts/tunnel-storage-proof/storage-approval-mutations.py",
        ),
        "source_trees": (
            "packages/daemon/src",
            "packages/shared/src",
            snapshot_scripts,
        ),
        "source_tree_excludes": (snapshot_scripts + "/node_modules",),
        "entry": snapshot_scripts + "/approval-entry.ts",
        "description": "Run the standalone decoder and held-approval proof on supported targets",
        "compile_from_snapshot": True,
        "runtime_args": ("--owned-spike", "--approval-spike"),
        "container_prefix": "remi-decoder-approval",
        "checks": CHECKS,
        "dependencies": {"pngjs": "7.0.0", "jpeg-js": "0.4.4"},
        "expected": {
            "images": [
                {
                    key: value
                    for key, value in image.items()
                    if key not in ("filename", "inputSha256")
                }
                for image in inputs["images"]
            ]
        },
        "scope": (
            "Nineteen decoder and three held-answer groups; the 512 MiB Linux limit is a fixture, "
            "portable resource enforcement and production adoption remain pending"
        ),
    }


if __name__ == "__main__":
    sys.exit(storage.main(proof_for()))
