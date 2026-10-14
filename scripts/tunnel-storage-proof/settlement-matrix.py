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
    "260 actual complete cycles bound device and home rows preserve pending and refuse evicted retries",
}
STAGING_CHECKS = {
    *(f"journal image {extension} {case}" for extension in ("png", "jpg") for case in (
        "original name quota markers and reopened cleanup",
        "wrong lease and immutable format refuse alternate cleanup",
        "actual name mutations refuse retained references",
    )),
    *(f"journal image {extension} actual SIGKILL {stage} restart settles original name"
      for extension in ("png", "jpg") for stage in (
          "retirement-committed", "retired-owned", "retired-cleaned", "retired-intent",
          "metadata-fsynced", "settled-committed",
      )),
    "journal closed owned PNG JPEG reads are bounded and expose no raw descriptor",
    "journal staged conversion frees active slots preserves all debt and same artifact",
    "journal staged rows keep device home artifact and byte admission barriers",
    "journal staged byte debt remains under the original home admission accounting",
    "journal open read needs successful close and preeffect busy creates no new debt",
    *(f"journal owned {fault} artifact refuses and retains blocking debt" for fault in
      ("missing", "short", "replacement", "growth", "mutation", "mode", "link")),
    *(f"journal captured {root} replacement refuses read and staged retention" for root in
      ("scratch", "metadata")),
    "journal held read view blocks cleanup until close then settles staged once",
    *(f"journal actual {mode} retains intent until death without recycled FD retry" for mode in
      ("staging-writer-close-fault", "staging-reader-close-fault")),
}
CHECKS = recovery.CHECKS | SETTLEMENT_CHECKS | STAGING_CHECKS
storage = recovery.storage
reserved = recovery.reserved


def proof_for(source=None):
    proof = recovery.proof_for() if source is None else recovery.proof_for(source)
    proof["files"] = (*proof["files"], "scripts/tunnel-decoder-proof/fixture.jpg",
                      "scripts/tunnel-decoder-proof/pngjs.d.ts")
    proof["expected"]["journalStagingJpegInputSha256"] = storage.digest(
        proof["source"] / "scripts/tunnel-decoder-proof/fixture.jpg")
    proof.update(
        {
            "entry": "scripts/tunnel-storage-proof/settlement-entry.ts",
            "container_prefix": "remi-settlement-proof",
            "checks": CHECKS,
            "scope": "105 preserved groups and 18 original image-name groups; no insertion authority, held-answer or R7 rerun",
        }
    )
    return proof


if __name__ == "__main__":
    sys.exit(recovery.storage.main(proof_for()))
