#!/usr/bin/env python3
"""Run real RemiKit image process-death controls on synthetic private files (macOS)."""

import argparse
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile


def run(command: list[str], *, timeout: int) -> subprocess.CompletedProcess[str]:
    process = subprocess.Popen(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               start_new_session=True)
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        # The new session contains only this fixture's owned command and its descendants.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            process.communicate(timeout=5)
        except subprocess.TimeoutExpired as error:
            if process.stdout:
                process.stdout.close()
            if process.stderr:
                process.stderr.close()
            raise RuntimeError("An owned fixture descendant did not exit after timeout.") from error
        raise
    return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scratch-path", required=True, type=Path, help="Owned SwiftPM scratch directory")
    args = parser.parse_args()
    if sys.platform != "darwin":
        print("This native fixture requires macOS.", file=sys.stderr)
        return 1
    package = Path(__file__).resolve().parents[2]
    scratch = args.scratch_path.resolve()
    scratch.mkdir(parents=True, exist_ok=True)
    # Build the real package from this checkout before linking the owned standalone helper.
    build = run(["xcrun", "swift", "test", "--package-path", str(package), "--scratch-path", str(scratch),
                 "--filter", "ImageSnapshotOwnerTests|ImageJournalDiskTests"], timeout=60)
    if build.returncode != 0:
        print(build.stdout + build.stderr, file=sys.stderr)
        return 1
    output = scratch / "out"
    products = output / "Products" / "Debug"
    modulemap = output / "Intermediates.noindex" / "GeneratedModuleMaps" / "NativeAPNsRuntime.modulemap"
    if not (products / "libRemiKit.a").is_file() or not modulemap.is_file():
        print("The expected Xcode SwiftPM products are unavailable.", file=sys.stderr)
        return 1

    fixture_root = Path(tempfile.mkdtemp(prefix="remi-image-process."))
    success = False
    try:
        cases = fixture_root / "cases"
        cases.mkdir(mode=0o700)
        with tempfile.TemporaryDirectory(prefix="image-fixture-build.", dir=scratch) as build_dir:
            binary = Path(build_dir) / "fixture"
            compile_result = run(["xcrun", "swiftc", "-I", str(products), "-L", str(products), "-lRemiKit",
                                  "-Xcc", "-fmodule-map-file=" + str(modulemap), "-lsqlite3",
                                  str(Path(__file__).with_name("image-process-fixture.swift")), "-o", str(binary)], timeout=60)
            if compile_result.returncode != 0:
                print(compile_result.stdout + compile_result.stderr, file=sys.stderr)
                return 1
            # The final stage constructs an already-unlinked state; it does not kill inside
            # the production unlink call and must not be reported as that stronger proof.
            for stage in ("reserved", "registered", "partial", "abandon_intent", "after_unlink_constructed"):
                case = Path(tempfile.mkdtemp(prefix="case.", dir=cases))
                crashed = run([str(binary), "crash", stage, str(case)], timeout=10)
                if crashed.returncode != -signal.SIGKILL or not (case / "phase-ready").is_file():
                    print(f"{stage}: expected the owned fixture to reach its kill point.", file=sys.stderr)
                    return 1
                recovered = run([str(binary), "recover", stage, str(case)], timeout=10)
                if recovered.returncode != 0 or recovered.stdout.strip() != f"PASS {stage}":
                    print(f"{stage}: owned recovery failed. {recovered.stdout}{recovered.stderr}", file=sys.stderr)
                    return 1
                print(f"PASS {stage}")
        success = True
        return 0
    except subprocess.TimeoutExpired:
        print("An owned fixture process timed out.", file=sys.stderr)
        return 1
    finally:
        if success:
            shutil.rmtree(fixture_root)
        else:
            print(f"Synthetic fixture files retained for inspection: {fixture_root}", file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
