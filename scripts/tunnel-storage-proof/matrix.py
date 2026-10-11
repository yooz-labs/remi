#!/usr/bin/env python3
"""Reproduce the existing owned storage packaging spike; no daemon integration."""

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import signal
import shutil
import subprocess
import sys
import tempfile
import uuid

TARGETS = ("bun-darwin-arm64", "bun-linux-arm64", "bun-linux-x64")
CHECKS = {
    "exclusive 0600 creation",
    "exclusive descriptor-relative publication and retirement",
    "same regular descriptor read",
    "component policy",
    "leaf and ancestor symlink refusal",
    "multiply linked file refusal",
    "captured directory survives path replacement; outside untouched",
    "hidden and credential components rejected before open",
    "protected directory overlap and replacement refusal",
    "candidate symlink and hardlink refusal",
    "deterministic ancestor replacement refusal",
    "deterministic final component replacement refusal",
    "open descriptor lease revalidation",
    "directory FIFO socket and device refusal",
    "initial 10 MiB size admission",
    "captured project root replacement refusal",
    "empty nonempty and 10 MiB private copies with exact bytes digest and mode",
    "growth truncation and detected same-size mutation refusal",
    "source link and ancestor leaf root replacement refusal during copy",
    "private bytes mode and effect-time source validation",
    "actual descriptor read and write failure cleanup",
    "nonprivate directory and exclusive creation collision refusal",
    "private publication collision refuses without overwrite",
    "private root replacement cleanup through captured directory",
    "completed private descriptor survives source and root changes",
    "actual completed cleanup failure remains visible and retryable",
    "partial and completed name replacement refuses owned cleanup",
}


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as source:
        for part in iter(lambda: source.read(1024 * 1024), b""):
            value.update(part)
    return value.hexdigest()


def dependency_tree(root, packages):
    """Capture exact membership/types as well as file bytes; new require targets matter."""
    entries = {}
    for name in packages:
        package = root / name
        for item in (package, *package.rglob("*")):
            relative = str(item.relative_to(root))
            if item.is_symlink():
                raise ValueError("Candidate dependency snapshot refuses symlinks")
            if item.is_file():
                entries[relative] = {"type": "file", "sha256": digest(item)}
            elif item.is_dir():
                entries[relative] = {"type": "directory"}
            else:
                raise ValueError("Candidate dependency has missing or unsupported entries")
    return entries


def source_tree(root, directories, exclusions=()):
    """Capture exact source membership, entry types, and file bytes for selected trees."""
    excluded = tuple(Path(value) for value in exclusions)
    entries = {}
    for directory in directories:
        base = Path(directory)
        absolute = root / base
        if absolute.is_symlink() or not absolute.is_dir():
            raise ValueError("Source snapshot tree is missing or unsupported: " + str(base))
        for item in (absolute, *sorted(absolute.rglob("*"))):
            relative = item.relative_to(root)
            if any(relative == skip or skip in relative.parents for skip in excluded):
                continue
            name = relative.as_posix()
            if item.is_symlink():
                raise ValueError("Source snapshot refuses symlinks: " + name)
            if item.is_file():
                entries[name] = {"type": "file", "sha256": digest(item)}
            elif item.is_dir():
                entries[name] = {"type": "directory"}
            else:
                raise ValueError("Source snapshot has an unsupported entry: " + name)
    return entries


def main(proof=None):
    if proof is None:
        proof = {
            "source": Path(__file__).resolve().parent,
            "files": ("probe.ts", "admission.ts", "admission-probe.ts", "private-copy.ts", "copy-probe.ts", "openat.c", "matrix.py"),
            "checks": CHECKS,
            "scope": "Seven primitives plus nine admission and eleven private-copy controls; production helper, quotas, recovery and full T0a remain pending",
        }
    parser = argparse.ArgumentParser(description=proof.get("description", __doc__))
    parser.add_argument("--bun-1311", type=Path, required=True)
    parser.add_argument("--bun-current", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--linux-arm64-image", required=True)
    parser.add_argument("--linux-x64-image", required=True)
    parser.add_argument("--build-only", action="store_true")
    parser.add_argument("--node-modules", type=Path)
    parser.add_argument(
        "--invalidation-control",
        action="store_true",
        help="Verify source, entry, and dependency additions are rejected before launch",
    )
    parser.add_argument(
        "--canary-only",
        action="store_true",
        help="Run both Bun versions on the local Apple Silicon target only",
    )
    parser.add_argument(
        "--linux-memory-mib",
        type=int,
        help="Override the Linux Docker memory fixture limit (default: 256 MiB)",
    )
    parser.add_argument(
        "--linux-pids-limit",
        type=int,
        help="Override the Linux Docker PID limit (default: 32)",
    )
    parser.add_argument(
        "--runtime-temp-base",
        type=Path,
        help="Use a caller-supplied short absolute base for one owned runtime scratch directory",
    )
    options = parser.parse_args()
    if options.linux_memory_mib is not None and options.linux_memory_mib < 1:
        parser.error("--linux-memory-mib must be positive")
    if options.linux_pids_limit is not None and options.linux_pids_limit < 1:
        parser.error("--linux-pids-limit must be positive")
    if options.runtime_temp_base is not None and not options.runtime_temp_base.is_absolute():
        parser.error("--runtime-temp-base must be an absolute path")
    matrix_targets = ("bun-darwin-arm64",) if options.canary_only else TARGETS
    compilers = (("1311", options.bun_1311), ("current", options.bun_current))
    source = proof["source"]
    checks = proof["checks"]
    source_trees = tuple(proof.get("source_trees", ()))
    source_tree_excludes = tuple(proof.get("source_tree_excludes", ()))
    tree_manifest = source_tree(source, source_trees, source_tree_excludes)
    source_hashes = {
        name: entry["sha256"]
        for name, entry in tree_manifest.items()
        if entry["type"] == "file"
    }
    for name in proof["files"]:
        path = source / name
        if path.is_symlink() or not path.is_file():
            raise ValueError("Source snapshot file is missing or unsupported: " + name)
        source_hashes[name] = digest(path)
    runner = Path(__file__).resolve()
    runner_hash = digest(runner)
    output = options.out.resolve()
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    runner_snapshot = output / "runner.py"
    runner_snapshot.write_bytes(runner.read_bytes())
    if digest(runner_snapshot) != runner_hash:
        raise RuntimeError("Runner changed while taking its snapshot")
    snapshot = output / "source"
    snapshot.mkdir(mode=0o700)
    snapshot_entries = dict(tree_manifest)
    for name, value in source_hashes.items():
        snapshot_entries.setdefault(name, {"type": "file", "sha256": value})
    for name, entry in snapshot_entries.items():
        destination = snapshot / name
        if entry["type"] == "directory":
            destination.mkdir(mode=0o700, parents=True, exist_ok=True)
            continue
        destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        destination.write_bytes((source / name).read_bytes())
        if digest(destination) != entry["sha256"]:
            raise RuntimeError("Source changed while taking its snapshot; start a new run")
    if source_tree(snapshot, source_trees, source_tree_excludes) != tree_manifest:
        raise RuntimeError("Source tree changed while taking its snapshot; start a new run")
    dependency_hashes = {}
    dependency_manifest = {}
    dependencies = proof.get("dependencies", {})
    if dependencies:
        if options.node_modules is None:
            raise RuntimeError("Supply installed standalone pinned candidate dependencies with --node-modules")
        dependency_manifest = dependency_tree(options.node_modules, dependencies)
        dependency_hashes = {name: entry["sha256"] for name, entry in dependency_manifest.items()
                             if entry["type"] == "file"}
        for name, version in dependencies.items():
            package = options.node_modules / name
            if json.loads((package / "package.json").read_text())["version"] != version:
                raise RuntimeError("Candidate dependency version mismatch: " + name)
            shutil.copytree(package, snapshot / "node_modules" / name)
        if (dependency_tree(options.node_modules, dependencies) != dependency_manifest or
                dependency_tree(snapshot / "node_modules", dependencies) != dependency_manifest):
            raise RuntimeError("Candidate dependency tree changed while taking its snapshot")
    compiler_cwd = snapshot if proof.get("compile_from_snapshot") else output / "compiler-cwd"
    compiler_cwd.mkdir(mode=0o700, exist_ok=True)
    temporary = output / "tmp"
    temporary.mkdir(mode=0o700)
    runtime_cwd = output / "empty-cwd"
    runtime_cwd.mkdir(mode=0o700)
    environment = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                   "LANG": "en_US.UTF-8", "TMPDIR": str(temporary)}
    runtime_environment = environment
    runtime_temp_dir = None
    runtime_temp_base_created = False
    runtime_temp_cleaned = False
    if options.runtime_temp_base is not None:
        runtime_temp_base = options.runtime_temp_base
        if runtime_temp_base.is_symlink():
            parser.error("--runtime-temp-base must not be a symlink")
        if not runtime_temp_base.exists():
            runtime_temp_base.mkdir(mode=0o700, parents=True)
            runtime_temp_base_created = True
        if not runtime_temp_base.is_dir():
            parser.error("--runtime-temp-base must be a directory")
        runtime_temp_dir = Path(tempfile.mkdtemp(prefix="m-", dir=runtime_temp_base))
        runtime_environment = {**environment, "TMPDIR": str(runtime_temp_dir)}
    linux_memory_mib = options.linux_memory_mib or 256
    linux_pids_limit = options.linux_pids_limit or 32
    runtime_args = tuple(proof.get("runtime_args", ("--owned-spike",)))
    entry = Path(proof.get("entry", "probe.ts"))
    if entry.is_absolute() or ".." in entry.parts:
        raise ValueError("Proof entry must be a captured path inside the source snapshot")
    results = []
    container = None
    run_id = uuid.uuid4().hex[:12]
    versions = {}
    images = {}
    image_pins = {}
    cleanup_errors = []
    invalidation_controls = []

    def interrupted(_signal, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupted)

    def source_unchanged():
        try:
            return (digest(runner) == runner_hash and digest(runner_snapshot) == runner_hash and
                    all(digest(directory / name) == value
                        for directory in (source, snapshot) for name, value in source_hashes.items()) and
                    source_tree(source, source_trees, source_tree_excludes) == tree_manifest and
                    source_tree(snapshot, source_trees, source_tree_excludes) == tree_manifest and
                    (not dependencies or all(dependency_tree(directory, dependencies) == dependency_manifest
                        for directory in (options.node_modules, snapshot / "node_modules"))))
        except (OSError, ValueError):
            return False

    def save():
        unchanged = source_unchanged()
        (output / "receipt.json").write_text(json.dumps({
            "host": {"system": platform.system(), "machine": platform.machine()},
            "sourceHashes": source_hashes,
            "runnerSha256": runner_hash,
            "dependencyHashes": dependency_hashes,
            "dependencyTree": dependency_manifest,
            **({"sourceTree": tree_manifest} if source_trees else {}),
            "targets": list(matrix_targets),
            "sourceUnchanged": unchanged,
            "compilerVersions": versions,
            "linuxImages": images,
            "cleanupErrors": cleanup_errors,
            **({"invalidationControls": invalidation_controls}
               if options.invalidation_control else {}),
            "complete": (unchanged and not cleanup_errors and len(results) == 2 * len(compilers) * len(matrix_targets) and all(item.get("passed") for item in results)
                         and all(item.get("artifactSha256") for item in results if item["label"].startswith("build-"))
                         and (not options.invalidation_control or
                              len(invalidation_controls) == 3 and all(item["passed"] for item in invalidation_controls))),
            "scope": proof["scope"],
            **({"linuxMemoryMiB": linux_memory_mib}
               if options.linux_memory_mib is not None else {}),
            **({"linuxPidsLimit": linux_pids_limit}
               if options.linux_pids_limit is not None else {}),
            **({"runtimeTempBase": str(options.runtime_temp_base),
                "runtimeTempDir": str(runtime_temp_dir),
                "runtimeTempDirCleaned": runtime_temp_cleaned}
               if runtime_temp_dir is not None else {}),
            "results": results,
        }, indent=2) + "\n")

    def run(label, arguments, expected=None, cwd=None, env=None):
        if not source_unchanged():
            raise RuntimeError("Source changed during the matrix; start a new run")
        item = {"label": label, "command": [str(value) for value in arguments],
                "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}
        log = output / (label + ".log")
        print(label, flush=True)
        with log.open("w") as stream:
            child = subprocess.Popen(item["command"], cwd=cwd or compiler_cwd, env=env or environment,
                                     stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
            try:
                item["exit"] = child.wait(timeout=120)
            except (subprocess.TimeoutExpired, KeyboardInterrupt):
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass  # The owned child exited between timeout and cleanup.
                child.wait()
                item["exit"] = -signal.SIGKILL
                item["timedOutOrInterrupted"] = True
        item["passed"] = item["exit"] == 0
        if not source_unchanged():
            item["passed"] = False
            item["sourceChangedAfterRun"] = True
        if expected is not None and item["passed"]:
            receipts = []
            for line in log.read_text().splitlines():
                try:
                    receipts.append(json.loads(line))
                except ValueError:
                    pass
            value = receipts[-1] if receipts else {}
            item["probe"] = value
            item["passed"] = (value.get("bun") == expected[0] and
                              value.get("platform") == expected[1] and
                              value.get("arch") == expected[2] and
                              value.get("checks") is not None and
                              len(value["checks"]) == len(checks) and set(value["checks"]) == checks and
                              all(value.get(key) == expected_value for key, expected_value in proof.get("expected", {}).items()))
        results.append(item)
        save()
        if not item["passed"]:
            raise RuntimeError(label + " failed; inspect its retained log")

    def invalidation_control(label, add_path):
        marker = output / (label + ".launched")
        marker.unlink(missing_ok=True)
        add_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        add_path.write_text("owned invalidation control\n")
        try:
            try:
                run(label, [sys.executable, "-c",
                    "from pathlib import Path; import sys; Path(sys.argv[1]).write_text('launched')",
                    str(marker)])
            except RuntimeError as error:
                if str(error) != "Source changed during the matrix; start a new run":
                    raise
            else:
                raise RuntimeError(label + " did not reject the added entry")
            if marker.exists():
                raise RuntimeError(label + " launched the guarded command")
        finally:
            add_path.unlink(missing_ok=True)
        item = {"label": label, "passed": source_unchanged() and not marker.exists()}
        invalidation_controls.append(item)
        save()
        if not item["passed"]:
            raise RuntimeError(label + " failed to restore the owned snapshot")

    try:
        if options.invalidation_control:
            invalidation_control(
                "invalidation-source-addition",
                snapshot / "packages/shared/src/invalidation-control.ts",
            )
            invalidation_control(
                "invalidation-entry-addition",
                snapshot / "scripts/tunnel-decoder-proof/added-entry.ts",
            )
            invalidation_control(
                "invalidation-dependency-addition",
                snapshot / "node_modules/pngjs/lib/invalidation-control.js",
            )
        for label, executable in compilers:
            executable = executable.resolve()
            version = subprocess.check_output([str(executable), "--version"], env=environment,
                                              text=True, timeout=30).strip()
            if label == "1311" and version != "1.3.11":
                raise RuntimeError("The pinned compiler must be Bun 1.3.11")
            versions[label] = version
            for target in matrix_targets:
                artifact = output / (label + "-" + target)
                run("build-" + label + "-" + target, [executable, "--no-env-file", "build", "--compile",
                    "--target=" + target, "--outfile=" + str(artifact), snapshot / entry])
                results[-1]["artifactSha256"] = digest(artifact)
                save()
                if options.build_only:
                    results.append({"label": "run-" + label + "-" + target, "passed": False,
                                    "executed": False, "reason": "Build-only preparation"})
                    save()
                    continue
                operating_system, architecture = target.removeprefix("bun-").split("-")
                expected_arch = "x64" if architecture == "x64" else "arm64"
                if operating_system == "darwin":
                    host_arch = platform.machine().lower()
                    unavailable = (platform.system() != "Darwin"
                                   or host_arch not in ("arm64", "aarch64"))
                    if unavailable:
                        results.append({"label": "run-" + label + "-" + target, "passed": False,
                                        "executed": False, "reason": "Apple Silicon Mac execution unavailable"})
                        save()
                        continue
                    run("run-" + label + "-" + target, [artifact, *runtime_args],
                        (version, "darwin", expected_arch), cwd=runtime_cwd,
                        env=runtime_environment)
                else:
                    image = options.linux_arm64_image if architecture == "arm64" else options.linux_x64_image
                    docker_platform = "linux/" + ("amd64" if architecture == "x64" else "arm64")
                    # Pin the locally addressable image/index before selecting its platform.
                    # Docker's containerd store can expose a platform manifest digest
                    # via inspect --platform that docker run cannot resolve as an image.
                    if image not in image_pins:
                        image_id = subprocess.check_output([
                            "docker", "image", "inspect", "--format", "{{.Id}}", "--", image],
                            env=environment, text=True, timeout=30).strip()
                        if not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id):
                            raise RuntimeError("Cached Linux image has no canonical local ID")
                        image_pins[image] = image_id
                    image_id = image_pins[image]
                    image_info = subprocess.check_output([
                        "docker", "image", "inspect", "--platform", docker_platform,
                        "--format", "{{.Id}} {{.Os}} {{.Architecture}}", "--", image_id],
                        env=environment, text=True, timeout=30).strip().split()
                    if (len(image_info) != 3 or not re.fullmatch(r"sha256:[0-9a-f]{64}", image_info[0])
                            or "/".join(image_info[1:]) != docker_platform):
                        raise RuntimeError("Cached Linux image does not match " + docker_platform)
                    selected = {"reference": image, "id": image_id,
                                "platformImageId": image_info[0], "platform": docker_platform}
                    if architecture in images and images[architecture] != selected:
                        raise RuntimeError("Linux platform selection changed during the matrix")
                    images[architecture] = selected
                    container_name = proof.get("container_prefix", "remi-storage-proof") + "-" + run_id + "-" + label + "-" + architecture
                    container = {"name": container_name, "cidfile": output / (container_name + ".cid")}
                    run("run-" + label + "-" + target, ["docker", "run", "--rm", "--pull=never",
                        "--name", container_name, "--cidfile", container["cidfile"], "--platform", docker_platform,
                        "--network", "none", "--read-only", "--memory", str(linux_memory_mib) + "m", "--pids-limit", str(linux_pids_limit),
                        "--cpus", "1", "--tmpfs", "/tmp:rw,nosuid,size=32m", "--workdir", "/tmp",
                        "--mount", "type=bind,src=" + str(output) + ",dst=/proof,readonly",
                        "--env", "TMPDIR=/tmp", image_id, "/proof/" + artifact.name, *runtime_args],
                        (version, "linux", expected_arch))
                    container = None
        save()
        complete = json.loads((output / "receipt.json").read_text())["complete"]
        print("Complete packaging matrix" if complete else "Partial matrix; missing executions remain unaccepted")
        return 0 if complete else 2
    finally:
        if container:
            try:
                container_id = container["cidfile"].read_text().strip()
                if not re.fullmatch(r"[0-9a-f]{64}", container_id):
                    raise ValueError("Invalid owned container ID")
                cleanup = subprocess.run(["docker", "rm", "--force", container_id], env=environment,
                                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
                if cleanup.returncode:
                    cleanup_errors.append({"container": container_id, "exit": cleanup.returncode})
            except FileNotFoundError:
                pass  # Docker never wrote this run's cidfile; ownership is unproven.
            except (OSError, ValueError, subprocess.TimeoutExpired) as error:
                cleanup_errors.append({"container": container["name"], "error": type(error).__name__})
        if runtime_temp_dir is not None:
            try:
                shutil.rmtree(runtime_temp_dir)
                runtime_temp_cleaned = True
            except OSError as error:
                cleanup_errors.append({"runtimeTempDir": str(runtime_temp_dir),
                                       "error": type(error).__name__})
            if runtime_temp_base_created:
                try:
                    runtime_temp_base.rmdir()
                except OSError:
                    pass  # Leave a shared or nonempty caller-supplied base intact.
        save()


if __name__ == "__main__":
    sys.exit(main())
