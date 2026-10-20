#!/usr/bin/env python3
"""#1443 exact compiled semantic guard controls; shared strict receipt predicate."""

import importlib.util
import sys
from pathlib import Path
from types import ModuleType
from typing import Protocol, cast

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class MutationRunner(Protocol):
    approval: ModuleType
    MUTATIONS: dict[str, dict[str, str]]

    def main(self) -> int: ...


runner = cast(
    MutationRunner, load("storage_mutations", "storage-approval-mutations.py")
)
runner.approval = load("settlement_matrix", "settlement-matrix.py")
MUTATIONS = {
    "ongoing-accounting": {
        "file": "packages/daemon/src/tunnel/journal-settlement.ts",
        "old": "          store.writeJournal(lease, projected, measure, effect);",
        "new": "          effect();",
        "witness": "exact ongoing write accounting blocks intervening admission",
    },
    "home": {
        "file": "packages/daemon/src/tunnel/reservations.ts",
        "old": "      if (records.some((record) => record.journal && record.journal.home !== this.homeIdentity))",
        "new": "      if (false)",
        "witness": "exact copied home binding refusal",
    },
    "nonce": {
        "file": "packages/daemon/src/tunnel/journal-schema.ts",
        "old": "    binding.nonce === lease.nonce &&",
        "new": "    true &&",
        "witness": "exact nonce incarnation refusal",
    },
    "ownership": {
        "file": "packages/daemon/src/tunnel/reservations.ts",
        "old": "      if (!record.journal.ownership) throw new ReservationError('unavailable');",
        "new": "      // Removed ownership binding guard.",
        "witness": "exact missing ownership binding prevents effects",
    },
    "retirement-before-refund": {
        "file": "packages/daemon/src/tunnel/reservations.ts",
        "old": "      retire(record.journal.retirement, (measured) => {\n        if (\n          !validWitnesses(measured, ['intent', 'owned', 'cleaned']) ||\n          !record.journal?.retirement ||\n          !sameWitnesses(record.journal.retirement, measured)\n        )\n          throw new ReservationError('unavailable');\n        record.journal.retirement = measured;\n        record.charge = Math.max(\n          record.charge,\n          measured.reduce((sum, marker) => sum + Math.max(4096, marker.allocated), 0),\n        );\n        if (!Number.isSafeInteger(records.reduce((sum, item) => sum + item.charge, 0)))\n          throw new ReservationError('unavailable');\n        this.write(records); // Retained marker allocation debt is durable before unlink attempts.\n      });",
        "new": "      // Removed retirement-before-refund guard.",
        "witness": "no orphan journal markers",
    },
    "history-bound": {
        "file": "packages/daemon/src/tunnel/reservations.ts",
        "old": "        const oldest = records.findIndex((item) => item.state === 'settled');",
        "new": "        const oldest = records.some((item) => item.state === 'settled') ? 0 : -1;",
        "witness": "exact pending record never evicted",
    },
}
runner.MUTATIONS = MUTATIONS


if __name__ == "__main__":
    sys.exit(runner.main())
