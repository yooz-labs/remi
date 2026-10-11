#!/usr/bin/env python3
"""#1443 standalone journal settlement; preserve separate exact predecessor profiles."""

import importlib.util
import sys
from pathlib import Path
from types import ModuleType
from typing import Protocol, cast

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location(
    "recovery_matrix", ROOT / "recovery-matrix.py"
)
assert spec is not None and spec.loader is not None


class RecoveryMatrix(Protocol):
    CHECKS: set[str]
    storage: ModuleType
    reserved: ModuleType

    def proof_for(self, source: Path = ...) -> dict: ...


recovery = cast(RecoveryMatrix, importlib.util.module_from_spec(spec))
spec.loader.exec_module(cast(ModuleType, recovery))
SETTLEMENT_CHECKS = {
    "ongoing managed writes empty preallocation and busy retry retain charge before admission",
    "actual partial write EBADF and failed owned measurement retain blocking debt until death",
    "actual writer close EBADF latches failure preserves reused FD and blocks until death",
    "managed writable handle holds intent flock until actual writer close",
    "journal actual allocation markers retirement exact refund and recent historical retry",
    "raw release retain mixed nonce ID and injected reincarnation refuse without refund",
    "missing durable ownership binding refuses before filesystem reconciliation effects",
    *(
        f"current and recaptured {root} replacement preserves charge and unrelated bytes"
        for root in ("scratch", "metadata")
    ),
    "current recaptured and copied ledger home identities refuse without refund",
    "missing corrupt oversized malformed optional and unknown ledger states fail closed",
    *(
        f"journal {kind} missing corrupt oversize schema type link mode and replacement controls"
        for kind in ("intent", "owned", "cleaned")
    ),
    "actual native artifact and retirement unlink faults retain charge and retry",
    "persisted retirement verifies every marker before effects and rejects replacement",
    "actual owned-marker preallocation preserves identity and raises retained accounting",
    "marker recreation after unlink or fsync refuses refund and preserves replacement",
    *(
        f"actual SIGKILL {stage} restart with witnessed retirement and exact receipt"
        for stage in (
            "retirement-committed",
            "retired-owned",
            "retired-cleaned",
            "retired-intent",
            "metadata-fsynced",
            "settled-committed",
        )
    ),
    "actual nonblocking intent contention and immediate dead owner flock release",
    "actual parallel settlement retry and new admission conserve exact quota",
    "130 actual complete cycles bound 128 rows preserve pending and refuse evicted retries",
}
CHECKS = recovery.CHECKS | SETTLEMENT_CHECKS
storage = recovery.storage
reserved = recovery.reserved


def proof_for(source=None):
    proof = recovery.proof_for() if source is None else recovery.proof_for(source)
    proof.update(
        {
            "entry": "scripts/tunnel-storage-proof/settlement-entry.ts",
            "container_prefix": "remi-settlement-proof",
            "checks": CHECKS,
            "scope": "61 predecessor and 27 settlement groups; no production adoption, transfer authority, held-answer or R7 rerun",
        }
    )
    return proof


if __name__ == "__main__":
    sys.exit(recovery.storage.main(proof_for()))
