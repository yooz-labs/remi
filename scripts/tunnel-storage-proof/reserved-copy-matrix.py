#!/usr/bin/env python3
"""Run reserved private-copy composition from the existing immutable snapshot profile."""

import importlib.util
import sys
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location(
    "reservation_matrix", ROOT / "reservation-matrix.py"
)
reservation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reservation)
CHECKS = reservation.CHECKS | {
    "reserved owned PNG preallocated blocks staging and deletion",
    "full home reservation refuses before private copy effects",
    "source growth cleanup confirmed before reservation refund",
    "actual completed unlink failure retains reservation and retries",
    "actual partial unlink failure retains reservation until explicit cleanup",
    "captured private root replacement cleanup precedes reservation release",
    "confirmed deletion accounting contention and corrupt read refusal",
}

if __name__ == "__main__":
    sys.exit(
        reservation.storage.main(
            {
                "source": reservation.REPO,
                "files": (
                    "tsconfig.json",
                    "package.json",
                    "bun.lock",
                    "bunfig.toml",
                    reservation.INPUT,
                ),
                "source_trees": (
                    "packages/daemon/src",
                    "packages/shared/src",
                    "scripts/tunnel-storage-proof",
                ),
                "entry": "scripts/tunnel-storage-proof/reserved-copy-entry.ts",
                "compile_from_snapshot": True,
                "container_prefix": "remi-reserved-copy-proof",
                "checks": CHECKS,
                "expected": {
                    "reservationInputSha256": reservation.storage.digest(
                        reservation.REPO / reservation.INPUT
                    )
                },
                "scope": "36 existing and seven reserved-copy groups; trusted metadata composition only; no recovery, authority or production adoption; cleanupConfirmed proves deletion only, metadata acknowledgment can be uncertain",
            }
        )
    )
