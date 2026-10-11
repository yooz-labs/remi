#!/usr/bin/env python3
"""Run the unchanged 43-group storage proof plus owned held-answer load controls."""

import argparse
import datetime
import importlib.util
import json
import os
import subprocess
import sys
import time
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location(
    "reserved_copy_matrix", ROOT / "reserved-copy-matrix.py"
)
reserved = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reserved)
storage = reserved.reservation.storage
CHECKS = reserved.CHECKS | {
    "10 MiB reserved private-copy load progresses around actual held No",
    "synchronous parent block makes held No exceed one second",
    "actual held No writes zero PTY bytes through reap",
    "deliberate PTY wrong-write invalidates zero-byte witness",
}
S1_ROOT = Path('/Volumes/S1/yooz/remi/artifacts')
ORIGINAL_BUN_INDEX_ID = 'sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7'
ORIGINAL_BUN_PLATFORM_IDS = {
    'arm64': {
        'platform': 'linux/arm64',
        'imageId': 'sha256:06bd53b80989da758c8d2995ba711733090caf688bab09e7d4b21c6c8df728b7',
    },
    'x64': {
        'platform': 'linux/amd64',
        'imageId': 'sha256:38919894db4e117a37f74e3dca503e84f24d97f19cabc5f499a289c2a5d0db7c',
    },
}
IMAGE_PREFLIGHT_BUDGET_SECONDS = 30
IMAGE_PREFLIGHT_COMMAND_TIMEOUT_SECONDS = 8


def write_image_preflight_receipt(path: Path, receipt: dict) -> None:
    if path.exists() or path.is_symlink():
        raise ValueError(f'Linux image preflight receipt must be fresh: {path}')
    with path.open('x') as handle:
        json.dump(receipt, handle, indent=2)
        handle.write('\n')
    path.chmod(0o600)


def inspect_local_image(command: list[str], deadline: float) -> dict:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError('Linux image profile preflight exceeded its 30-second budget')
    timeout = min(IMAGE_PREFLIGHT_COMMAND_TIMEOUT_SECONDS, remaining)
    environment = {
        'PATH': os.environ.get('PATH', '/usr/bin:/bin'),
        'LANG': 'en_US.UTF-8',
    }
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            env=environment,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        stdout = error.stdout.decode(errors='replace') if isinstance(error.stdout, bytes) else (error.stdout or '')
        stderr = error.stderr.decode(errors='replace') if isinstance(error.stderr, bytes) else (error.stderr or '')
        return {
            'command': command,
            'exit': None,
            'timedOut': True,
            'stdout': stdout,
            'stderr': stderr,
        }
    return {
        'command': command,
        'exit': completed.returncode,
        'timedOut': False,
        'stdout': completed.stdout,
        'stderr': completed.stderr,
    }


def preflight_linux_images(
    arm64_reference: str,
    x64_reference: str,
    output_path: Path,
) -> tuple[dict, Path]:
    if output_path.is_symlink():
        raise ValueError('--out must not be a symlink')
    output_parent = output_path.parent.resolve(strict=True)
    if not output_parent.is_relative_to(S1_ROOT.resolve()):
        raise ValueError('full storage-approval matrices must write under S1 artifacts')
    output_path = output_parent / output_path.name
    if output_path.exists():
        raise ValueError('--out must be a fresh S1 path')
    receipt_path = output_path.with_name(output_path.name + '-linux-image-profile.json')
    if receipt_path.exists() or receipt_path.is_symlink():
        raise ValueError(f'Linux image profile receipt path must be fresh: {receipt_path}')

    receipt = {
        'schemaVersion': 1,
        'createdAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'scope': 'bounded local-only preflight for the standalone #1170 approval profile',
        'status': 'preflight-started',
        'outputPath': str(output_path),
        'callerSelectedReferences': {
            'arm64': arm64_reference,
            'x64': x64_reference,
        },
        'expected': {
            'imageIndexId': ORIGINAL_BUN_INDEX_ID,
            'platforms': ORIGINAL_BUN_PLATFORM_IDS,
        },
        'executionReferences': {
            'arm64': ORIGINAL_BUN_INDEX_ID,
            'x64': ORIGINAL_BUN_INDEX_ID,
        },
        'policy': {
            'budgetSeconds': IMAGE_PREFLIGHT_BUDGET_SECONDS,
            'commandTimeoutSeconds': IMAGE_PREFLIGHT_COMMAND_TIMEOUT_SECONDS,
            'operations': 'docker image inspect only; no pulls, builds, or containers',
        },
        'observed': {},
    }
    deadline = time.monotonic() + IMAGE_PREFLIGHT_BUDGET_SECONDS
    try:
        refs = {'arm64': arm64_reference, 'x64': x64_reference}
        index_ids = {}
        for arch, reference in refs.items():
            command = [
                'docker', 'image', 'inspect', '--format', '{{.Id}}', '--', reference,
            ]
            result = inspect_local_image(command, deadline)
            receipt['observed'].setdefault(arch, {})['indexInspection'] = result
            if result['timedOut'] or result['exit'] != 0:
                raise RuntimeError(f'caller-selected {arch} Bun image is not locally inspectable')
            image_id = result['stdout'].strip()
            if image_id != ORIGINAL_BUN_INDEX_ID:
                raise RuntimeError(f'caller-selected {arch} image ID is outside the original Bun 1.3.11 pin')
            index_ids[arch] = image_id

        platform_ids = {}
        for arch in refs:
            expected = ORIGINAL_BUN_PLATFORM_IDS[arch]
            command = [
                'docker', 'image', 'inspect', '--platform', expected['platform'],
                '--format', '{{.Id}} {{.Os}} {{.Architecture}}', '--', index_ids[arch],
            ]
            result = inspect_local_image(command, deadline)
            attempts = [result]
            platform_observed = receipt['observed'][arch]
            platform_observed['platformInspectionAttempts'] = attempts
            platform_observed['platformInspection'] = result
            fields = result['stdout'].strip().split()
            if (
                not result['timedOut']
                and result['exit'] == 0
                and fields
                and fields[0] == index_ids[arch]
            ):
                platform_observed['platformInspectionRereadReason'] = (
                    'first platform response returned the already-verified parent index ID'
                )
                result = inspect_local_image(command, deadline)
                attempts.append(result)
                platform_observed['platformInspection'] = result
            if result['timedOut'] or result['exit'] != 0:
                raise RuntimeError(f'cached Bun image has no locally inspectable {expected["platform"]} variant')
            fields = result['stdout'].strip().split()
            if (
                len(fields) != 3
                or fields[0] != expected['imageId']
                or '/'.join(fields[1:]) != expected['platform']
            ):
                raise RuntimeError(f'caller-selected {arch} image platform does not match the original Bun 1.3.11 pin')
            platform_ids[arch] = fields[0]

        receipt['observed']['selectedImageIds'] = index_ids
        receipt['observed']['selectedPlatformImageIds'] = platform_ids
        receipt['status'] = 'preflight-passed'
    except Exception as error:
        receipt['status'] = 'preflight-failed'
        receipt['error'] = {'type': type(error).__name__, 'message': str(error)}
        write_image_preflight_receipt(receipt_path, receipt)
        raise RuntimeError(
            f'Linux approval-profile image preflight failed; receipt retained at {receipt_path}: {error}'
        ) from error

    write_image_preflight_receipt(receipt_path, receipt)
    return receipt, receipt_path


def proof_for(source=reserved.reservation.REPO):
    return {
        "source": source,
        "files": (
            "tsconfig.json",
            "package.json",
            "bun.lock",
            "bunfig.toml",
            reserved.reservation.INPUT,
        ),
        "source_trees": (
            "packages/daemon/src",
            "packages/shared/src",
            "scripts/tunnel-storage-proof",
        ),
        "entry": "scripts/tunnel-storage-proof/storage-approval-entry.ts",
        "description": "Run the standalone storage-load held-answer proof; no production upload caller",
        "compile_from_snapshot": True,
        "runtime_args": ("--owned-spike", "--storage-approval"),
        "container_prefix": "remi-storage-approval",
        "checks": CHECKS,
        "linux_tmpfs_exec": True,
        "expected": {
            "reservationInputSha256": storage.digest(
                source / reserved.reservation.INPUT
            ),
            "nativeHelperSourceSha256": storage.digest(
                source / "scripts/tunnel-storage-proof/openat.c"
            ),
            "nativeHelperOpsSourceSha256": storage.digest(
                source / "scripts/tunnel-storage-proof/storage-approval-native.c"
            ),
        },
        "scope": (
            "43 unchanged storage groups and four actual held-answer load groups; "
            "proof-only FFI helper load uses this profile's 32 MiB executable tmpfs; "
            "no production upload/helper adoption, recovery or transfer authority"
        ),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(add_help=False, allow_abbrev=False)
    parser.add_argument("--source-root", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--canary-only", action="store_true")
    parser.add_argument("--linux-arm64-image")
    parser.add_argument("--linux-x64-image")
    args, storage_args = parser.parse_known_args()
    canary_only = args.canary_only
    if args.source_root is None:
        if not canary_only:
            parser.error("full matrix runs require an S1 frozen prepared source root")
        source = reserved.reservation.REPO
    else:
        if args.source_root.is_symlink():
            parser.error("--source-root must not be a symlink")
        try:
            source = args.source_root.resolve(strict=True)
        except OSError as error:
            parser.error(f"--source-root must be an existing frozen source: {type(error).__name__}")
        if not source.is_dir() or not source.is_relative_to(S1_ROOT.resolve()):
            parser.error("--source-root must be an owned source snapshot under S1 artifacts")
        stat = source.stat()
        if (
            stat.st_uid != os.getuid()
            or (stat.st_mode & 0o777) != 0o700
        ):
            parser.error("--source-root must be owned by the current uid with mode 0700")
    frozen_wrapper = source / 'scripts' / 'tunnel-storage-proof' / 'storage-approval-matrix.py'
    if (
        frozen_wrapper.is_symlink()
        or not frozen_wrapper.is_file()
        or frozen_wrapper.read_bytes() != Path(__file__).resolve().read_bytes()
    ):
        parser.error("executed matrix wrapper must match the frozen source snapshot")
    repository_root = reserved.reservation.REPO.resolve()
    for runtime_module in (reserved, reserved.reservation, storage):
        runtime_file = Path(runtime_module.__file__).resolve()
        try:
            relative = runtime_file.relative_to(repository_root)
        except ValueError:
            parser.error("loaded matrix support module is outside the repository snapshot")
        frozen_file = source / relative
        if (
            frozen_file.is_symlink()
            or not frozen_file.is_file()
            or frozen_file.read_bytes() != runtime_file.read_bytes()
        ):
            parser.error(f"loaded matrix support module differs from frozen snapshot: {relative}")

    if canary_only:
        arm64_image = args.linux_arm64_image or ORIGINAL_BUN_INDEX_ID
        x64_image = args.linux_x64_image or ORIGINAL_BUN_INDEX_ID
    else:
        if not args.linux_arm64_image or not args.linux_x64_image:
            parser.error('full approval matrices require both caller-selected pinned Linux image references')
        try:
            _profile, _profile_path = preflight_linux_images(
                args.linux_arm64_image, args.linux_x64_image, args.out,
            )
        except (OSError, RuntimeError, ValueError) as error:
            print(f'{type(error).__name__}: {error}', file=sys.stderr)
            sys.exit(2)
        arm64_image = ORIGINAL_BUN_INDEX_ID
        x64_image = ORIGINAL_BUN_INDEX_ID

    forwarded_args = [
        *storage_args,
        '--out', str(args.out),
        '--linux-arm64-image', arm64_image,
        '--linux-x64-image', x64_image,
    ]
    if canary_only:
        forwarded_args.append('--canary-only')
    sys.argv = [sys.argv[0], *forwarded_args]
    sys.exit(storage.main(proof_for(source)))
