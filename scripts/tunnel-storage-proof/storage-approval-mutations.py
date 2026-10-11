#!/usr/bin/env python3
"""Prove three named storage-approval witnesses reject private source mutations."""

import argparse
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent
S1_ROOT = Path("/Volumes/S1/yooz/remi").resolve()
S1_ARTIFACTS = S1_ROOT / "artifacts"
spec = importlib.util.spec_from_file_location(
    "storage_approval_matrix", ROOT / "storage-approval-matrix.py"
)
approval = importlib.util.module_from_spec(spec)
spec.loader.exec_module(approval)

MUTATIONS = {
    "actual-copy": {
        "file": "scripts/tunnel-storage-proof/private-copy.ts",
        "old": "      if (!count) return null;\n      let written = 0;",
        "new": "      if (!count) return null;\n      if (offset === 0) buffer.writeUInt8(buffer.readUInt8(0) ^ 1, 0);\n      let written = 0;",
        "witness": "actual-copy witness: private-copy digest matches generated input",
    },
    "actual-denial": {
        "file": "packages/daemon/src/auto-approve/auto-approve-gate.ts",
        "old": "    const decision = this.decisionFor(hold, answer);",
        "new": "    const decision = answer.kind === 'option' ? 'allow' : this.decisionFor(hold, answer);",
        "witness": "actual-denial witness: original held PermissionRequest HTTP response parsed as deny",
    },
    "zero-pty": {
        "file": "scripts/tunnel-storage-proof/storage-approval-probe.ts",
        "old": "        actualOutcome = await handlers.relayAnswer(sessionId, questionId, NO.value);\n        return Response.json({ outcome: actualOutcome });",
        "new": "        actualOutcome = await handlers.relayAnswer(sessionId, questionId, NO.value);\n        await pty.write(NO.value);\n        return Response.json({ outcome: actualOutcome });",
        "witness": "zero-PTY witness: actual held No produced zero PTY bytes before the /bin/cat drain barrier",
    },
}
BUN_VERSIONS = {"1311": "1.3.11", "current": "1.4.2"}


def digest(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def require_private_s1_source(path: Path) -> Path:
    if path.is_symlink():
        raise ValueError("mutation source root must not be a symlink")
    source = path.resolve(strict=True)
    if not source.is_relative_to(S1_ARTIFACTS.resolve()) or not source.is_dir():
        raise ValueError("mutation source root must be a directory under S1 artifacts")
    info = source.stat()
    if info.st_uid != os.getuid() or (info.st_mode & 0o777) != 0o700:
        raise ValueError("mutation source root must be current-uid-owned with mode 0700")
    return source


def require_fresh_s1_output(path: Path) -> Path:
    if path.exists() or path.is_symlink():
        raise ValueError("mutation output must be fresh")
    output = path.resolve()
    if not output.is_relative_to(S1_ARTIFACTS.resolve()):
        raise ValueError("mutation output must be under S1 artifacts")
    return output


def replace_once(path: Path, old: str, new: str) -> tuple[str, str]:
    source = path.read_text()
    if source.count(old) != 1:
        raise ValueError(f"mutation selector did not match exactly once: {path.name}")
    before = digest(path)
    path.write_text(source.replace(old, new, 1))
    after = digest(path)
    if before == after:
        raise ValueError(f"mutation did not change source bytes: {path.name}")
    return before, after


def named_assertion_failure(log_text: str, witness: str, executable_name: str) -> dict | None:
    """Parse the exact Bun assertion and a stack frame from the compiled proof."""
    lines = log_text.splitlines()
    matches = []
    prefix = "AssertionError: "
    for index, line in enumerate(lines):
        stripped = line.strip()
        if not stripped.startswith(prefix) or stripped[len(prefix) :] != witness:
            continue
        frames = [
            candidate.strip()
            for candidate in lines[index + 1 : index + 81]
            if candidate.strip().startswith("at ")
            and "/$bunfs/" in candidate
            and executable_name in candidate
        ]
        if frames:
            matches.append(
                {"type": "AssertionError", "message": witness, "compiledFrame": frames[0]}
            )
    return matches[0] if len(matches) == 1 else None


def mutation_rejection_reasons(
    receipt: dict,
    witness: str,
    expected_artifact_path: str,
    expected_runtime_command: list[str],
    expected_run_label: str,
    expected_target: str,
    executable_name: str,
    selected_compiler: dict,
) -> list[str]:
    """Return why structured evidence does not prove a compiled mutation rejection."""
    reasons = []
    if receipt.get("phase") != "proof-runtime":
        reasons.append("phase is not proof-runtime")
    if receipt.get("selectedCompiler") != selected_compiler:
        reasons.append("selected Bun identity does not match the requested mutation cell")
    if selected_compiler.get("label") not in BUN_VERSIONS:
        reasons.append("selected Bun label is not supported")
    elif selected_compiler.get("expectedVersion") != BUN_VERSIONS[selected_compiler["label"]]:
        reasons.append("selected Bun expected version does not match its label")
    if selected_compiler.get("observedVersion") != selected_compiler.get("expectedVersion"):
        reasons.append("selected Bun compiler version does not match its label")
    if selected_compiler.get("runtimeVersionInFailureLog") != selected_compiler.get("expectedVersion"):
        reasons.append("compiled runtime version in the named failure log does not match its label")
    if selected_compiler.get("binaryUnchanged") is not True:
        reasons.append("selected Bun executable identity changed during the mutation run")

    build = receipt.get("build")
    if not isinstance(build, dict) or build.get("passed") is not True:
        reasons.append("compiled build did not pass")
    else:
        if build.get("label") != f"build-{executable_name}":
            reasons.append("compiled build label does not match the expected proof")
        if not isinstance(build.get("artifactSha256"), str) or re.fullmatch(
            r"[a-f0-9]{64}", build["artifactSha256"]
        ) is None:
            reasons.append("compiled artifact hash is missing or malformed")
        build_command = build.get("command")
        if not isinstance(build_command, list) or not all(
            isinstance(value, str) for value in build_command
        ):
            reasons.append("compiled build command is missing")
        elif (
            not build_command
            or build_command[0] != selected_compiler.get("resolvedPath")
            or "--compile" not in build_command
            or f"--target={expected_target}" not in build_command
            or f"--outfile={expected_artifact_path}" not in build_command
        ):
            reasons.append(
                "compiled build command does not bind the selected Bun, artifact and target"
            )

    run = receipt.get("run")
    if not isinstance(run, dict):
        reasons.append("compiled runtime result is missing")
    else:
        if run.get("label") != expected_run_label:
            reasons.append("runtime result label does not match the compiled proof")
        if run.get("command") != expected_runtime_command:
            reasons.append("runtime command does not name the expected compiled artifact")
        if run.get("processCompleted") is not True:
            reasons.append("runtime process did not complete with a structured result")
        exit_code = run.get("exit")
        if (
            not isinstance(exit_code, int)
            or isinstance(exit_code, bool)
            or exit_code <= 0
        ):
            reasons.append("runtime exit is not a positive nonzero process exit")
        if run.get("passed") is not False:
            reasons.append("runtime result is not a failed execution")
        if run.get("timedOutOrInterrupted") is not False:
            reasons.append("runtime timed out or has no explicit non-timeout result")
        if run.get("probe") is not None:
            reasons.append("runtime produced a success probe instead of a named failure")

    if receipt.get("buildReceiptSourceUnchanged") is not True:
        reasons.append("matrix runner did not confirm the frozen source remained unchanged")
    if receipt.get("runnerErrorMatchesFailedRuntime") is not True:
        reasons.append("matrix runner did not report this runtime failure")
    if receipt.get("runnerStatus") is not None:
        reasons.append("matrix runner returned without the expected failed-runtime exception")

    assertion = receipt.get("assertionFailure")
    if (
        not isinstance(assertion, dict)
        or assertion.get("type") != "AssertionError"
        or assertion.get("message") != witness
        or not isinstance(assertion.get("compiledFrame"), str)
        or "/$bunfs/" not in assertion["compiledFrame"]
        or executable_name not in assertion["compiledFrame"]
    ):
        reasons.append("exact named AssertionError from the compiled proof is missing")
    return reasons


def run_acceptance_control(
    witness: str,
    expected_artifact_path: str,
    expected_runtime_command: list[str],
    expected_run_label: str,
    expected_target: str,
    executable_name: str,
    selected_compiler: dict,
    *,
    setup_failure: bool,
) -> dict:
    """Run real subprocess controls and submit their evidence to the receipt gate."""
    if setup_failure:
        source = (
            "import sys; "
            "print('AssertionError: ' + sys.argv[1]); "
            f"print('    at setupFailure (/$bunfs/root/{executable_name}:1:1)'); "
            "raise SystemExit(2)"
        )
        phase = "setup"
    else:
        source = (
            "import sys; "
            "print('AssertionError: ' + sys.argv[1]); "
            f"print('    at successfulControl (/$bunfs/root/{executable_name}:1:1)')"
        )
        phase = "proof-runtime"
    command = [sys.executable, "-c", source, witness]
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=5,
            env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C"},
            check=False,
        )
        exit_code = completed.returncode
        log_text = completed.stdout + completed.stderr
        timed_out = False
    except subprocess.TimeoutExpired as error:
        exit_code = None
        stdout = (
            error.stdout.decode(errors="replace")
            if isinstance(error.stdout, bytes)
            else (error.stdout or "")
        )
        stderr = (
            error.stderr.decode(errors="replace")
            if isinstance(error.stderr, bytes)
            else (error.stderr or "")
        )
        log_text = stdout + stderr
        timed_out = True
    failure = named_assertion_failure(log_text, witness, executable_name)
    if setup_failure:
        control_receipt = {
            "phase": "setup",
            "selectedCompiler": selected_compiler,
            "build": {"passed": False, "command": None, "artifactSha256": None},
            "run": None,
            "assertionFailure": failure,
            "buildReceiptSourceUnchanged": True,
            "runnerErrorMatchesFailedRuntime": False,
            "runnerStatus": None,
        }
    else:
        # This deliberately synthetic build row lets the successful process test
        # the same receipt predicate as a real mutation run. It is control data,
        # never evidence of a compiled proof execution.
        control_receipt = {
            "phase": "proof-runtime",
            "selectedCompiler": selected_compiler,
            "build": {
                "label": f"build-{executable_name}",
                "passed": True,
                "artifactSha256": "0" * 64,
                "command": [
                    "<acceptance-control>",
                    "--compile",
                    f"--target={expected_target}",
                    f"--outfile={expected_artifact_path}",
                ],
            },
            "run": {
                "label": expected_run_label,
                "command": expected_runtime_command,
                "exit": exit_code,
                "passed": exit_code == 0,
                "timedOutOrInterrupted": timed_out,
                "probe": None,
                "processCompleted": exit_code is not None and not timed_out,
            },
            "assertionFailure": failure,
            "buildReceiptSourceUnchanged": True,
            "runnerErrorMatchesFailedRuntime": False,
            "runnerStatus": exit_code,
        }
    rejection_reasons = mutation_rejection_reasons(
        control_receipt,
        witness,
        expected_artifact_path,
        expected_runtime_command,
        expected_run_label,
        expected_target,
        executable_name,
        selected_compiler,
    )
    return {
        "controlOnlySyntheticReceipt": True,
        "phase": phase,
        "command": command,
        "exit": exit_code,
        "timedOut": timed_out,
        "logOutput": log_text,
        "printedAssertionLookingWitness": f"AssertionError: {witness}" in log_text,
        "parsedFailure": failure,
        "receiptRejectionReasons": rejection_reasons,
        "acceptedAsMutationRejection": not rejection_reasons,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mutation", choices=sorted(MUTATIONS), required=True)
    parser.add_argument("--bun-label", choices=sorted(BUN_VERSIONS), required=True)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--bun-1311", type=Path, required=True)
    parser.add_argument("--bun-current", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--linux-arm64-image", required=True)
    parser.add_argument("--linux-x64-image", required=True)
    parser.add_argument("--runtime-temp-base", type=Path, required=True)
    args = parser.parse_args()

    selected_binary = args.bun_1311 if args.bun_label == "1311" else args.bun_current
    selected_resolved = selected_binary.resolve(strict=True)
    if not selected_resolved.is_file() or not os.access(selected_resolved, os.X_OK):
        raise ValueError("selected Bun label does not resolve to an executable file")
    selected_compiler_before = {
        "label": args.bun_label,
        "expectedVersion": BUN_VERSIONS[args.bun_label],
        "requestedPath": str(selected_binary),
        "resolvedPath": str(selected_resolved),
        "size": selected_resolved.stat().st_size,
        "sha256": digest(selected_resolved),
    }

    source_root = require_private_s1_source(args.source_root)
    output = require_fresh_s1_output(args.out)
    if not args.runtime_temp_base.is_absolute() or args.runtime_temp_base.is_symlink():
        raise ValueError("runtime temporary base must be an absolute non-symlink S1 path")
    runtime_temp_base = args.runtime_temp_base.resolve()
    if not runtime_temp_base.is_relative_to(S1_ROOT):
        raise ValueError("runtime temporary base must be under S1")
    mutant_root = output.with_name(output.name + "-source")
    if mutant_root.exists() or mutant_root.is_symlink():
        raise ValueError(
            "mutation needs an existing frozen source and fresh S1 output paths"
        )
    frozen_runner = source_root / "scripts/tunnel-storage-proof/storage-approval-mutations.py"
    if (
        frozen_runner.is_symlink()
        or not frozen_runner.is_file()
        or digest(frozen_runner) != digest(Path(__file__).resolve())
    ):
        raise ValueError("executed mutation runner must match the frozen source snapshot")
    repository_root = approval.reserved.reservation.REPO.resolve()
    for runtime_module in (
        approval,
        approval.reserved,
        approval.reserved.reservation,
        approval.storage,
    ):
        runtime_file = Path(runtime_module.__file__).resolve()
        try:
            relative = runtime_file.relative_to(repository_root)
        except ValueError as error:
            raise ValueError("loaded mutation support module is outside the source snapshot") from error
        frozen_file = source_root / relative
        if (
            frozen_file.is_symlink()
            or not frozen_file.is_file()
            or digest(frozen_file) != digest(runtime_file)
        ):
            raise ValueError(f"loaded mutation support module differs from the snapshot: {relative}")
    shutil.copytree(source_root, mutant_root, symlinks=True)
    mutation = MUTATIONS[args.mutation]
    relative = Path(mutation["file"])
    base_file = source_root / relative
    mutant_file = mutant_root / relative
    base_before = digest(base_file)
    original_repo_file = ROOT.parents[1] / relative
    original_before = digest(original_repo_file)
    mutation_before, mutation_after = replace_once(
        mutant_file, mutation["old"], mutation["new"]
    )

    sys.argv = [
        sys.argv[0],
        "--bun-1311",
        str(args.bun_1311),
        "--bun-current",
        str(args.bun_current),
        "--out",
        str(output),
        "--linux-arm64-image",
        args.linux_arm64_image,
        "--linux-x64-image",
        args.linux_x64_image,
        "--linux-memory-mib",
        "512",
        "--linux-pids-limit",
        "64",
        "--runtime-temp-base",
        str(runtime_temp_base),
        "--canary-only",
    ]
    selected_proof = approval.proof_for(mutant_root)
    selected_proof["compiler_labels"] = (args.bun_label,)
    runner_error = None
    try:
        status = approval.storage.main(selected_proof)
    except (OSError, RuntimeError, ValueError) as error:
        status = None
        runner_error = f"{type(error).__name__}: {error}"

    executable_name = f"{args.bun_label}-bun-darwin-arm64"
    run_log = output / f"run-{executable_name}.log"
    log_text = run_log.read_text(errors="replace") if run_log.exists() else ""
    runner_receipt_path = output / "receipt.json"
    runner_receipt = json.loads(runner_receipt_path.read_text()) if runner_receipt_path.exists() else {}
    build_label = f"build-{executable_name}"
    run_label = f"run-{executable_name}"
    build_row = next(
        (row for row in runner_receipt.get("results", []) if row.get("label") == build_label),
        None,
    )
    run_row = next(
        (row for row in runner_receipt.get("results", []) if row.get("label") == run_label),
        None,
    )
    build_sha256 = build_row.get("artifactSha256") if build_row else None
    artifact_path = str((output / executable_name).resolve())
    build_command = build_row.get("command", []) if build_row else []
    observed_version = runner_receipt.get("compilerVersions", {}).get(args.bun_label)
    selected_resolved_after = selected_binary.resolve(strict=True)
    selected_compiler = {
        **selected_compiler_before,
        "observedVersion": observed_version,
        "runtimeVersionInFailureLog": (
            selected_compiler_before["expectedVersion"]
            if f"Bun v{selected_compiler_before['expectedVersion']} (macOS arm64)" in log_text
            else None
        ),
        "binaryUnchanged": (
            str(selected_resolved_after) == selected_compiler_before["resolvedPath"]
            and digest(selected_resolved_after) == selected_compiler_before["sha256"]
        ),
    }
    build_passed = (
        build_row is not None
        and build_row.get("passed") is True
        and isinstance(build_sha256, str)
        and re.fullmatch(r"[a-f0-9]{64}", build_sha256) is not None
        and isinstance(build_command, list)
        and all(isinstance(value, str) for value in build_command)
        and build_row.get("label") == build_label
        and bool(build_command)
        and build_command[0] == selected_compiler["resolvedPath"]
        and observed_version == selected_compiler["expectedVersion"]
        and selected_compiler["binaryUnchanged"] is True
        and "--compile" in build_command
        and "--target=bun-darwin-arm64" in build_command
        and f"--outfile={artifact_path}" in build_command
    )
    proof = approval.proof_for(mutant_root)
    proof["compiler_labels"] = (args.bun_label,)
    expected_runtime_args = list(proof.get("runtime_args", ("--owned-spike",)))
    expected_command = [artifact_path, *expected_runtime_args]
    runtime_command_matches = run_row is not None and run_row.get("command") == expected_command
    runtime_exit = run_row.get("exit") if run_row else None
    runtime_timeout_value = run_row.get("timedOutOrInterrupted", False) if run_row else None
    runtime_passed = run_row.get("passed") if run_row else None
    assertion_failure = named_assertion_failure(
        log_text,
        mutation["witness"],
        executable_name,
    )
    runtime_phase = (
        "proof-runtime"
        if build_passed and runtime_command_matches and run_row is not None
        else "setup"
    )
    runner_runtime_error = (
        runner_error == f"RuntimeError: {run_label} failed; inspect its retained log"
    )
    runtime_evidence = {
        "phase": runtime_phase,
        "expectedArtifactPath": artifact_path,
        "expectedRuntimeCommand": expected_command,
        "expectedRunLabel": run_label,
        "expectedBuildTarget": "bun-darwin-arm64",
        "selectedCompiler": selected_compiler,
        "build": {
            "label": build_row.get("label") if build_row else None,
            "passed": build_row.get("passed") if build_row else None,
            "artifactSha256": build_sha256,
            "command": build_command,
        },
        "run": {
            "label": run_row.get("label") if run_row else None,
            "command": run_row.get("command") if run_row else None,
            "exit": runtime_exit,
            "passed": runtime_passed,
            "timedOutOrInterrupted": runtime_timeout_value,
            "probe": run_row.get("probe") if run_row else None,
            "processCompleted": (
                run_row is not None
                and isinstance(runtime_exit, int)
                and not isinstance(runtime_exit, bool)
                and runtime_timeout_value is False
                and isinstance(run_row.get("startedAt"), str)
                and bool(run_row.get("startedAt"))
            ),
        },
        "assertionFailure": assertion_failure,
        "buildReceiptSourceUnchanged": runner_receipt.get("sourceUnchanged") is True,
        "runnerErrorMatchesFailedRuntime": runner_runtime_error,
        "runnerStatus": status,
    }
    expected_build_target = "bun-darwin-arm64"
    private_source_rejection_reasons = mutation_rejection_reasons(
        runtime_evidence,
        mutation["witness"],
        artifact_path,
        expected_command,
        run_label,
        expected_build_target,
        executable_name,
        selected_compiler,
    )
    success_control = run_acceptance_control(
        mutation["witness"],
        artifact_path,
        expected_command,
        run_label,
        expected_build_target,
        executable_name,
        selected_compiler,
        setup_failure=False,
    )
    setup_failure_control = run_acceptance_control(
        mutation["witness"],
        artifact_path,
        expected_command,
        run_label,
        expected_build_target,
        executable_name,
        selected_compiler,
        setup_failure=True,
    )
    controls_rejected = (
        success_control["exit"] == 0
        and not success_control["timedOut"]
        and success_control["printedAssertionLookingWitness"]
        and not success_control["acceptedAsMutationRejection"]
        and "runtime exit is not a positive nonzero process exit"
        in success_control["receiptRejectionReasons"]
        and "runtime result is not a failed execution"
        in success_control["receiptRejectionReasons"]
        and setup_failure_control["exit"] == 2
        and not setup_failure_control["timedOut"]
        and setup_failure_control["printedAssertionLookingWitness"]
        and not setup_failure_control["acceptedAsMutationRejection"]
        and "phase is not proof-runtime" in setup_failure_control["receiptRejectionReasons"]
        and "compiled runtime result is missing"
        in setup_failure_control["receiptRejectionReasons"]
    )
    source_snapshot_unchanged = digest(base_file) == base_before
    original_source_unchanged = digest(original_repo_file) == original_before
    witness = mutation["witness"]
    private_source_rejected = not private_source_rejection_reasons
    control = {
        "mutation": args.mutation,
        "selectedBunLabel": args.bun_label,
        "selectedCompiler": selected_compiler,
        "mutationFile": relative.as_posix(),
        "mutationBaselineSha256": mutation_before,
        "mutationSha256": mutation_after,
        "expectedWitness": witness,
        "observedWitness": assertion_failure.get("message") if assertion_failure else None,
        "runLog": str(run_log),
        "runnerReceipt": str(runner_receipt_path),
        "runnerReceiptSourceUnchanged": runner_receipt.get("sourceUnchanged") is True,
        "buildArtifact": {
            "label": build_row.get("label") if build_row else None,
            "passed": build_row.get("passed") if build_row else None,
            "artifactSha256": build_sha256,
            "command": build_command,
        },
        "runnerError": runner_error,
        "runnerStatus": status,
        "runtimeEvidence": runtime_evidence,
        "privateSourceRejectionReasons": private_source_rejection_reasons,
        "receiptAcceptanceControls": {
            "successfulWitnessOutput": success_control,
            "setupFailureWithWitnessText": setup_failure_control,
            "bothRejected": controls_rejected,
        },
        "privateSourceRejected": private_source_rejected,
        "baseSnapshotUnchanged": source_snapshot_unchanged,
        "repositorySourceUnchanged": original_source_unchanged,
        "passed": (
            private_source_rejected
            and controls_rejected
            and source_snapshot_unchanged
            and original_source_unchanged
            and mutation_before != mutation_after
        ),
    }
    output.mkdir(mode=0o700, parents=True, exist_ok=True)
    (output / "mutation-control.json").write_text(json.dumps(control, indent=2) + "\n")
    print(json.dumps(control, indent=2))
    return 0 if control["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
