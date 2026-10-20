#!/usr/bin/env bash
# Render the actual Mac conversation screen with owned, local-only content.
set -euo pipefail

if [[ "$(uname -s)" != Darwin ]]; then
  echo "This renderer control requires macOS and its WindowServer." >&2
  exit 2
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
artifact_dir="${1:-$(mktemp -d "${TMPDIR:-/tmp}/remi-scroll-evidence.XXXXXX")}"
mkdir -p "$artifact_dir"
artifact_dir="$(cd "$artifact_dir" && pwd)"
probe_work="$(mktemp -d "${TMPDIR:-/tmp}/remi-scroll-renderer.XXXXXX")"
trap 'rm -rf "$probe_work"' EXIT

python3 - "$repo_root" "$probe_work" "$artifact_dir" <<'PY'
import hashlib, json, pathlib, shutil, subprocess, sys
repo, work, artifacts = map(pathlib.Path, sys.argv[1:])
target = work / 'Sources/RemiScrollProbe'
target.mkdir(parents=True)
inputs = {
    'MacSessionDetail.swift': repo / 'packages/native/Mac/MacSessionDetail.swift',
    'Probe.swift': repo / 'packages/native/Tests/TranscriptScroll/Probe.swift',
}
hashes = {}
for name, source in inputs.items():
    shutil.copyfile(source, target / name)
    raw = source.read_bytes()
    assert raw == (target / name).read_bytes()
    hashes[str(source.relative_to(repo))] = hashlib.sha256(raw).hexdigest()
dependency = json.dumps(str(repo / 'packages/native/RemiKit'))
(work / 'Package.swift').write_text('''// swift-tools-version: 6.2
import PackageDescription
let package = Package(name: "RemiScrollProbe", platforms: [.macOS(.v26)],
    dependencies: [.package(path: DEPENDENCY)],
    targets: [.executableTarget(name: "RemiScrollProbe", dependencies: [
        .product(name: "RemiKit", package: "RemiKit"),
        .product(name: "RemiUI", package: "RemiKit")])])
'''.replace('DEPENDENCY', dependency))
(artifacts / 'source.json').write_text(json.dumps({
    'head': subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip(),
    'sha256': hashes,
    'source_copy_byte_identical': True,
    'fixture_uses_owner_identity_or_sessions': False,
}, indent=2) + '\n')
PY

probe_status=0
python3 - "$probe_work" "$artifact_dir" <<'PY' || probe_status=$?
import json, os, pathlib, signal, subprocess, sys, time
work, artifacts = map(pathlib.Path, sys.argv[1:])
started = time.monotonic()
timed_out = False
status = 1
with (artifacts / 'renderer.log').open('w') as log:
    child = subprocess.Popen(['swift', 'run', '--package-path', str(work),
        'RemiScrollProbe', str(artifacts / 'result.json')],
        stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    def send_owned(sig):
        try:
            if child.poll() is None and os.getpgid(child.pid) == child.pid:
                os.killpg(child.pid, sig)
        except ProcessLookupError:
            pass

    def interrupted(signum, frame):
        raise InterruptedError(signum)

    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, interrupted)
    try:
        try:
            status = child.wait(timeout=240)
        except subprocess.TimeoutExpired:
            timed_out = True
            status = 124
        except InterruptedError as error:
            status = 128 + int(error.args[0])
    finally:
        for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            signal.signal(sig, signal.SIG_IGN)
        if child.poll() is None:
            send_owned(signal.SIGTERM)
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                send_owned(signal.SIGKILL)
                child.wait(timeout=2)
(artifacts / 'runner.json').write_text(json.dumps({
    'exit': status, 'timed_out': timed_out, 'deadline_seconds': 240,
    'seconds': round(time.monotonic() - started, 2),
    'owned_child_reaped': child.poll() is not None,
}, indent=2) + '\n')
sys.exit(status)
PY
cat "$artifact_dir/renderer.log"
exit "$probe_status"
