#!/usr/bin/env python3
"""Six frozen removed-guard variants, using the original strict compiled predicate."""

import sys
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent
import importlib.util

spec = importlib.util.spec_from_file_location(
    "staging_matrix", ROOT / "staging-codec-matrix.py"
)
assert spec is not None and spec.loader is not None
approval = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = approval
spec.loader.exec_module(approval)
runner = approval.load(
    "staging_mutations",
    ROOT.parent / "tunnel-storage-proof/storage-approval-mutations.py",
)
runner.approval = approval
runner.SUPPORT_MODULES = (sys.modules[__name__], approval, approval.storage, runner)
runner.MUTATIONS = {
    "duplicate-fields": {
        "file": "packages/shared/src/image-staging.ts",
        "old": "parseStrictJson(text, IMAGE_STAGING_LIMITS.frameBytes)",
        "new": "JSON.parse(text)",
        "witness": "frame codec witness: rejects duplicate decoded binding key",
    },
    "unknown-fields": {
        "file": "packages/shared/src/image-staging.ts",
        "old": "  if (Object.keys(object).length !== Object.keys(fields).length) return false;",
        "new": "  // Removed exact field count.",
        "witness": "frame codec witness: rejects unknown root field",
    },
    "frame-budget": {
        "file": "packages/shared/src/image-staging.ts",
        "old": "    if (input.length > IMAGE_STAGING_LIMITS.frameBytes) return null;\n    const text = typeof input === 'string' ? input : fromUtf8(input);\n    if (!scalar(text) || utf8(text).length > IMAGE_STAGING_LIMITS.frameBytes) return null;\n    return validated(parseStrictJson(text, IMAGE_STAGING_LIMITS.frameBytes));",
        "new": "    const text = typeof input === 'string' ? input : fromUtf8(input);\n    if (!scalar(text)) return null;\n    return validated(parseStrictJson(text, Number.MAX_SAFE_INTEGER));",
        "witness": "frame codec witness: rejects oversized frame before parsing",
    },
    "base64-canonical": {
        "file": "packages/shared/src/image-staging.ts",
        "old": "  const bytes = fromB64u(value);",
        "new": "  const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));",
        "witness": "frame codec witness: rejects noncanonical chunk trailing bits",
    },
    "integer-range": {
        "file": "packages/shared/src/image-staging.ts",
        "old": "const sequence = integer(0, IMAGE_STAGING_LIMITS.maxSequence);",
        "new": "const sequence = integer(0, Number.MAX_SAFE_INTEGER);",
        "witness": "frame codec witness: rejects sequence above319",
    },
    "binding-scalar": {
        "file": "packages/shared/src/image-staging.ts",
        "old": "      scalar(s) &&",
        "new": "      true &&",
        "witness": "frame codec witness: rejects lone binding surrogate",
    },
}

if __name__ == "__main__":
    sys.exit(runner.main())
