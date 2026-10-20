#!/usr/bin/env python3
"""Run standalone journal restart proof while preserving the independent default 43 groups."""
import importlib.util
import sys
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("reserved_matrix", ROOT / "reserved-copy-matrix.py")
assert spec is not None and spec.loader is not None
reserved = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reserved)
RECOVERY_CHECKS = {
    *(f"actual SIGKILL restart {stage} ownership and retained accounting" for stage in
      ("pre-create", "post-create", "post-witness", "post-unlink", "post-cleaned")),
    "real nonblocking contender and killed owner flock release",
    *(f"exact {kind} schema oversize links FIFO mode and missing controls" for kind in
      ("intent", "owned", "cleaned")),
    *(f"captured {root} replacement refuses cleanup and preserves both roots" for root in
      ("scratch", "metadata")),
    "artifact identity links symlink FIFO mode refusal and exact ENOENT outcome",
    "persisted cleaned outcome rejects conflicting artifact without adoption",
    "generated names real permission fault and incomplete intent retention",
    "reopened owned and terminal intents refuse artifact recreation before effects",
    "held intent owned and cleaned name replacements refuse without unlink",
    "actual native unlink failure retains witness artifact and charge",
    "actual intent artifact owned cleaned descriptors are close on exec",
}
CHECKS = reserved.CHECKS | RECOVERY_CHECKS

storage = reserved.reservation.storage

def proof_for(source=reserved.reservation.REPO):
    reservation = reserved.reservation
    return {
        "source": source,
        "files": ("tsconfig.json", "package.json", "bun.lock", "bunfig.toml", reservation.INPUT),
        "source_trees": ("packages/daemon/src", "packages/shared/src", "scripts/tunnel-storage-proof"),
        "entry": "scripts/tunnel-storage-proof/recovery-entry.ts",
        "compile_from_snapshot": True,
        "container_prefix": "remi-recovery-proof",
        "checks": CHECKS,
        "expected": {"reservationInputSha256": storage.digest(source / reservation.INPUT)},
        "scope": "43 predecessor and 18 journal recovery groups; no held-answer rerun, transfer authority, production adoption or reservation refund reconciliation",
    }

if __name__ == "__main__":
    sys.exit(storage.main(proof_for()))
