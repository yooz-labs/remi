#!/usr/bin/env python3
"""Run standalone reservation accounting from an immutable repository snapshot."""

import importlib.util
import sys
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[1]
spec = importlib.util.spec_from_file_location("storage_matrix", ROOT / "matrix.py")
storage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(storage)
CHECKS = storage.CHECKS | {
    "durable byte rounding file and identity admission",
    "active device session and hub saturation with staged conversion",
    "home byte and retained cleanup saturation",
    "tiny artifact home and device saturation",
    "actual allocated blocks debt and confirmed deletion before release",
    "missing malformed and nonprivate ledger refuses without reset",
    "private metadata root replacement refusal",
    "real multiprocess admission and restart accounting",
    "nonblocking owned lock contention refuses without waiting",
}
INPUT = "scripts/tunnel-decoder-proof/fixture.png"

if __name__ == "__main__":
    sys.exit(
        storage.main(
            {
                "source": REPO,
                "files": (
                    "tsconfig.json",
                    "package.json",
                    "bun.lock",
                    "bunfig.toml",
                    INPUT,
                ),
                "source_trees": (
                    "packages/daemon/src",
                    "packages/shared/src",
                    "scripts/tunnel-storage-proof",
                ),
                "entry": "scripts/tunnel-storage-proof/reservation-entry.ts",
                "compile_from_snapshot": True,
                "container_prefix": "remi-reservation-proof",
                "checks": CHECKS,
                "expected": {"reservationInputSha256": storage.digest(REPO / INPUT)},
                "scope": (
                    "27 storage and nine trusted-namespace quota groups; Linux resource caps are "
                    "fixtures. No transfer authority, descriptor journal, recovery or production adoption."
                ),
            }
        )
    )
