#!/usr/bin/env python3
"""Reuse the three-host runner for the existing pinned decoder candidate."""
import importlib.util
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("storage_matrix", ROOT.parent / "tunnel-storage-proof" / "matrix.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
CHECKS = {
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
}
inputs = json.loads((ROOT / "inputs.json").read_text())
if __name__ == "__main__":
    sys.exit(module.main({
        "source": ROOT,
        "files": ("probe.ts", "admission.ts", "decode.ts", "pngjs.d.ts", "fixture.png", "fixture.jpg", "inputs.json", "package.json", "bun.lock", "matrix.py", "THIRD-PARTY-LICENSES.txt"),
        "checks": CHECKS,
        "dependencies": {"pngjs": "7.0.0", "jpeg-js": "0.4.4"},
        "expected": {"images": [{key: value for key, value in image.items() if key not in ("filename", "inputSha256")} for image in inputs["images"]]},
        "scope": "Ten decoder header/malformed/full-decode groups; process budgets, cancellation, concurrency, held approval and production selection remain pending",
    }))
