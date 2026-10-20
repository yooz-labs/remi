#!/usr/bin/env python3
"""Reuse the three-host runner for the existing pinned decoder candidate."""

import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[1]
spec = importlib.util.spec_from_file_location(
    "storage_matrix", ROOT.parent / "tunnel-storage-proof" / "matrix.py"
)
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
CHECKS = {
    "controller owned interpreter policy original pixels and parent environment isolation",
    "owned PNG JPEG inputs and full-decode pixel hashes",
    "input byte and media type refusal",
    "PNG signature header and dimension refusal",
    "PNG animation interlace and unsupported method refusal",
    "PNG duplicate chunk and end structure refusal",
    "JPEG signature header and dimension refusal",
    "JPEG frame precision component and sampling refusal",
    "JPEG segment quantization Huffman and restart length refusal",
    "JPEG scan marker and end structure refusal",
    "full PNG CRC and JPEG entropy decode refusal",
    "owned decoder success refusal and pre-cancel cleanup",
    "actual busy child deadline and reap",
    "actual cancellation saturation and reap",
    "bounded output malformed duplicate and crash refusal",
    "actual result cancellation and subsequent decode",
    "PNG palette length colour and bit-depth refusal",
    "PNG palette uniqueness ordering and required palette refusal",
    "PNG legal palette full-decode pixel agreement",
}
inputs = json.loads((ROOT / "inputs.json").read_text())
snapshot_scripts = "scripts/tunnel-decoder-proof"


def proof_for(source=REPO):
    return {
        "source": source,
        "files": (
            "tsconfig.json",
            "package.json",
            "packages/daemon/package.json",
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
        "entry": snapshot_scripts + "/probe.ts",
        "compile_from_snapshot": True,
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
        "scope": "Thirteen admission/decode, five child lifetime and one interpreter policy group; hard memory/CPU budgets, held approval and production selection remain pending",
    }


if __name__ == "__main__":
    sys.exit(module.main(proof_for()))
