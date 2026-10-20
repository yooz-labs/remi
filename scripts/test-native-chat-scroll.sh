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
swift run --package-path "$probe_work" RemiScrollProbe "$artifact_dir/result.json" \
  > "$artifact_dir/renderer.log" 2>&1 || probe_status=$?
cat "$artifact_dir/renderer.log"
exit "$probe_status"
