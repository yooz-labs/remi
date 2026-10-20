#!/usr/bin/env python3
"""Prepare architecture-specific Linux FFI assets in an owned S1 snapshot."""

import argparse
import base64
import datetime
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import time
import uuid
from pathlib import Path

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parent
S1_ROOT = Path('/Volumes/S1/yooz/remi')
ARTIFACTS_ROOT = S1_ROOT / 'artifacts'
COMPILER_INDEX_REFERENCE = (
    'docker.io/library/golang@sha256:'
    '0f063af2d465d8dcae54cce04278ada488b96f77b42449c8d071e47d016cc65a'
)
COMPILER_INDEX_DIGEST = 'sha256:0f063af2d465d8dcae54cce04278ada488b96f77b42449c8d071e47d016cc65a'
PLATFORMS = {
    'arm64': {
        'platform': 'linux/arm64',
        'manifestDigest': 'sha256:4364967143356b3498a4bcec1f1a2a2129495333f85f8f05b4e4dbb9ef70d287',
        'uname': 'aarch64',
        'target': 'aarch64-linux-gnu',
        'elfMachine': 'AArch64',
    },
    'x64': {
        'platform': 'linux/amd64',
        'manifestDigest': 'sha256:af00f232205a01baf323bddc5bb4a4ea2e4cbf49e8ccc988beb2558d0f9c882a',
        'uname': 'x86_64',
        'target': 'x86_64-linux-gnu',
        'elfMachine': 'Advanced Micro Devices X86-64',
    },
}
SOURCE_FILES = ('openat.c', 'storage-approval-native.c')
GENERATED_MODULE = 'storage-approval-native.generated.ts'
MAX_LIBRARY_BYTES = 4 * 1024 * 1024
MAX_OUTPUT_BYTES = 64 * 1024
CONTAINER_TIMEOUT_SECONDS = 120
CLEANUP_BUDGET_SECONDS = 20
CLEANUP_COMMAND_TIMEOUT_SECONDS = 5
CONTAINER_RUN_LABEL = 'org.remi.storage-approval.run'
CONTAINER_OUTPUT_LABEL = 'org.remi.storage-approval.output-sha256'

CONTAINER_SCRIPT = r'''set -eu
umask 077
compiler="$(readlink -f /usr/bin/cc)"
case "$compiler" in
  /usr/bin/*gcc-14) ;;
  *) printf 'compiler path is not the pinned GCC 14 executable: %s\n' "$compiler" >&2; exit 21 ;;
esac
compiler_version="$("$compiler" --version 2>&1 | sed -n '1p')"
compiler_target="$("$compiler" -dumpmachine)"
compiler_sha256="$(sha256sum "$compiler" | cut -d' ' -f1)"
libc_version="$(ldd --version 2>&1 | sed -n '1p')"
os_release_b64="$(base64 -w0 /etc/os-release)"
runtime_arch="$(uname -m)"
source_openat_sha256="$(sha256sum /src/openat.c | cut -d' ' -f1)"
source_ops_sha256="$(sha256sum /src/storage-approval-native.c | cut -d' ' -f1)"
start_ns="$(date +%s%N)"
"$compiler" -shared -fPIC -nostdlib -o /out/libremi-openat.so /src/openat.c /src/storage-approval-native.c -lc
chmod 0600 /out/libremi-openat.so
end_ns="$(date +%s%N)"
library_sha256="$(sha256sum /out/libremi-openat.so | cut -d' ' -f1)"
library_size="$(wc -c < /out/libremi-openat.so | tr -d ' ')"
elf_machine="$(readelf -h /out/libremi-openat.so | sed -n 's/^[[:space:]]*Machine:[[:space:]]*//p')"
needed="$(readelf -d /out/libremi-openat.so | sed -n 's/.*Shared library: \[\(.*\)\].*/\1/p' | sort -u | paste -sd, -)"
glibc_versions="$(readelf --version-info /out/libremi-openat.so | grep -Eo 'GLIBC_[0-9]+(\.[0-9]+)+' | sort -Vu | paste -sd, -)"
if readelf --version-info /out/libremi-openat.so | grep -q 'GLIBC_PRIVATE'; then
  glibc_private=true
else
  glibc_private=false
fi
printf 'REMI_PREP:compiler_path=%s\n' "$compiler"
printf 'REMI_PREP:compiler_version=%s\n' "$compiler_version"
printf 'REMI_PREP:compiler_target=%s\n' "$compiler_target"
printf 'REMI_PREP:compiler_sha256=%s\n' "$compiler_sha256"
printf 'REMI_PREP:libc_version=%s\n' "$libc_version"
printf 'REMI_PREP:os_release_b64=%s\n' "$os_release_b64"
printf 'REMI_PREP:runtime_arch=%s\n' "$runtime_arch"
printf 'REMI_PREP:source_openat_sha256=%s\n' "$source_openat_sha256"
printf 'REMI_PREP:source_ops_sha256=%s\n' "$source_ops_sha256"
printf 'REMI_PREP:container_compile_duration_ms=%s\n' "$(( (end_ns - start_ns) / 1000000 ))"
printf 'REMI_PREP:library_sha256=%s\n' "$library_sha256"
printf 'REMI_PREP:library_size=%s\n' "$library_size"
printf 'REMI_PREP:elf_machine=%s\n' "$elf_machine"
printf 'REMI_PREP:needed=%s\n' "$needed"
printf 'REMI_PREP:glibc_versions=%s\n' "$glibc_versions"
printf 'REMI_PREP:glibc_private=%s\n' "$glibc_private"
'''


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open('rb') as source:
        for part in iter(lambda: source.read(1024 * 1024), b''):
            hasher.update(part)
    return hasher.hexdigest()


def require_owned_directory(path: Path, label: str) -> None:
    info = path.lstat()
    if path.is_symlink() or not stat.S_ISDIR(info.st_mode):
        raise ValueError(f'{label} must be a real directory')
    if info.st_uid != os.getuid() or (info.st_mode & 0o777) != 0o700:
        raise ValueError(f'{label} must be current-uid-owned with mode 0700')
    if path.resolve(strict=True) != path:
        raise ValueError(f'{label} path must be canonical')


def source_manifest(root: Path) -> dict:
    entries = {}
    for item in (root, *sorted(root.rglob('*'))):
        relative = item.relative_to(root)
        name = '.' if relative == Path('.') else relative.as_posix()
        info = item.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise ValueError(f'source snapshot refuses symlink: {name}')
        if stat.S_ISDIR(info.st_mode):
            entries[name] = {'type': 'directory'}
        elif stat.S_ISREG(info.st_mode):
            entries[name] = {'type': 'file', 'sha256': sha256_file(item)}
        else:
            raise ValueError(f'source snapshot has unsupported entry: {name}')
    return entries


def copy_snapshot(source: Path, destination: Path, before: dict) -> None:
    destination.mkdir(mode=0o700)
    for name, entry in before.items():
        if name == '.':
            continue
        source_path = source / name
        target = destination / name
        if entry['type'] == 'directory':
            target.mkdir(mode=0o700, parents=True, exist_ok=False)
        else:
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            with source_path.open('rb') as input_file, target.open('xb') as output_file:
                shutil.copyfileobj(input_file, output_file, length=1024 * 1024)
            target.chmod(0o600)
    if source_manifest(source) != before or source_manifest(destination) != before:
        raise RuntimeError('source changed while freezing the S1 preparation snapshot')


def copy_c_inputs(source: Path, output: Path) -> dict:
    input_dir = output / 'native-input'
    input_dir.mkdir(mode=0o700)
    result = {}
    for name in SOURCE_FILES:
        source_file = source / 'scripts' / 'tunnel-storage-proof' / name
        if source_file.is_symlink() or not source_file.is_file():
            raise ValueError(f'missing owned C source input: {name}')
        target = input_dir / name
        shutil.copyfile(source_file, target)
        target.chmod(0o600)
        digest = sha256_file(target)
        if digest != sha256_file(source_file):
            raise RuntimeError(f'C source changed while preparing input: {name}')
        result[name] = digest
    return result


def parse_container_output(stdout: str) -> dict:
    values = {}
    for line in stdout.splitlines():
        if not line.startswith('REMI_PREP:'):
            continue
        key, separator, value = line[len('REMI_PREP:'):].partition('=')
        if not separator or key in values:
            raise ValueError('compiler container emitted malformed or duplicate metadata')
        values[key] = value
    required = {
        'compiler_path', 'compiler_version', 'compiler_target', 'compiler_sha256',
        'libc_version', 'os_release_b64', 'runtime_arch', 'source_openat_sha256',
        'source_ops_sha256', 'container_compile_duration_ms', 'library_sha256',
        'library_size', 'elf_machine', 'needed', 'glibc_versions', 'glibc_private',
    }
    missing = sorted(required - values.keys())
    if missing:
        raise ValueError('compiler container metadata missing: ' + ', '.join(missing))
    return values


def require_digest(value: str, label: str) -> None:
    if re.fullmatch(r'[a-f0-9]{64}', value) is None:
        raise ValueError(f'{label} is not a canonical SHA-256')


def compiler_image_preflight(platform: dict) -> dict:
    index_command = [
        'docker', 'image', 'inspect', '--format', '{{.Id}}',
        '--', COMPILER_INDEX_REFERENCE,
    ]
    index_completed = subprocess.run(
        index_command, capture_output=True, text=True, timeout=30, check=False,
    )
    if index_completed.returncode != 0:
        raise RuntimeError(
            f'pinned compiler image index is not locally available: {index_completed.stderr.strip()}'
        )
    index_id = index_completed.stdout.strip()
    if index_id != COMPILER_INDEX_DIGEST:
        raise RuntimeError(
            f'pinned compiler image index ID is not the approved digest: {index_id}'
        )
    command = [
        'docker', 'image', 'inspect', '--platform', platform['platform'],
        '--format', '{{.Id}} {{.Os}}/{{.Architecture}}', '--', index_id,
    ]
    completed = subprocess.run(
        command, capture_output=True, text=True, timeout=30, check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(
            f"pinned compiler image platform is not locally available: {platform['platform']}: "
            f"{completed.stderr.strip()}"
        )
    parts = completed.stdout.strip().split()
    expected_platform = platform['platform']
    if (
        len(parts) != 2
        or parts[0] != platform['manifestDigest']
        or parts[1] != expected_platform
    ):
        raise RuntimeError(
            f"pinned compiler image did not resolve to the accepted platform digest: "
            f"{platform['platform']}: {completed.stdout.strip()}"
        )
    return {
        'imageIndexReference': COMPILER_INDEX_REFERENCE,
        'imageIndexId': index_id,
        'indexCommand': index_command,
        'indexExit': index_completed.returncode,
        'indexStdout': index_completed.stdout,
        'indexStderr': index_completed.stderr,
        'command': command,
        'exit': completed.returncode,
        'stdout': completed.stdout,
        'stderr': completed.stderr,
        'platformImageId': parts[0],
        'platformManifestDigest': platform['manifestDigest'],
        'platform': expected_platform,
    }


def write_control_receipt(path: Path, value: dict) -> None:
    if path.is_symlink():
        raise ValueError(f'container lifecycle receipt must not be a symlink: {path}')
    if path.exists():
        info = path.stat()
        if info.st_uid != os.getuid() or info.st_mode & 0o777 != 0o600:
            raise ValueError(f'container lifecycle receipt has unsafe ownership or mode: {path}')
    with path.open('w') as handle:
        json.dump(value, handle, indent=2)
        handle.write('\n')
    path.chmod(0o600)


def docker_cleanup_call(arguments: list[str], deadline: float) -> dict:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return {
            'command': ['docker', *arguments],
            'exit': None,
            'timeout': True,
            'stdout': '',
            'stderr': 'cleanup time budget exhausted before command start',
        }
    timeout = min(CLEANUP_COMMAND_TIMEOUT_SECONDS, remaining)
    command = ['docker', *arguments]
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        return {
            'command': command,
            'exit': completed.returncode,
            'timeout': False,
            'stdout': completed.stdout,
            'stderr': completed.stderr,
        }
    except subprocess.TimeoutExpired as error:
        stdout = error.stdout.decode(errors='replace') if isinstance(error.stdout, bytes) else (error.stdout or '')
        stderr = error.stderr.decode(errors='replace') if isinstance(error.stderr, bytes) else (error.stderr or '')
        return {
            'command': command,
            'exit': None,
            'timeout': True,
            'stdout': stdout,
            'stderr': stderr,
        }


def inspect_container(target: str, deadline: float) -> dict:
    template = (
        '{{.Id}}|{{.Image}}|{{.Name}}|'
        '{{index .Config.Labels "' + CONTAINER_RUN_LABEL + '"}}|'
        '{{index .Config.Labels "' + CONTAINER_OUTPUT_LABEL + '"}}'
    )
    return docker_cleanup_call(
        ['container', 'inspect', '--format', template, target], deadline,
    )


def listed_containers(filters: list[str], deadline: float) -> dict:
    return docker_cleanup_call(
        [
            'container', 'ls', '--all', '--no-trunc',
            '--format', '{{.ID}}|{{.Names}}',
            *[item for value in filters for item in ('--filter', value)],
        ],
        deadline,
    )


def parse_container_inspection(result: dict) -> dict | None:
    if result['exit'] != 0 or result['timeout']:
        return None
    parts = result['stdout'].strip().split('|')
    if len(parts) != 5:
        return None
    return {
        'id': parts[0],
        'imageId': parts[1],
        'name': parts[2],
        'runLabel': parts[3],
        'outputLabel': parts[4],
    }


def cleanup_owned_container(
    name: str,
    cidfile: Path,
    run_token: str,
    output_binding: str,
    image_id: str,
) -> dict:
    started = time.monotonic()
    deadline = started + CLEANUP_BUDGET_SECONDS
    result = {
        'containerName': name,
        'containerIdFile': str(cidfile),
        'expectedContainerImageDotImageId': image_id,
        'cleanupBudgetSeconds': CLEANUP_BUDGET_SECONDS,
        'commands': [],
        'verifiedAbsent': False,
    }
    cid = None
    if cidfile.is_symlink():
        result['cidFileError'] = 'cidfile became a symlink; it was not followed'
    elif cidfile.exists():
        info = cidfile.stat()
        if info.st_uid != os.getuid() or not stat.S_ISREG(info.st_mode):
            result['cidFileError'] = 'cidfile is not a current-uid-owned regular file'
        else:
            candidate = cidfile.read_text().strip()
            if re.fullmatch(r'[0-9a-f]{64}', candidate):
                cid = candidate
            else:
                result['cidFileError'] = 'cidfile did not contain one full lowercase container ID'
    else:
        result['cidFileState'] = 'not-created'

    inspected = None
    inspection = None
    inspection_mismatches = []
    targets = [cid, name] if cid else [name]
    for target in targets:
        inspection = inspect_container(target, deadline)
        result['commands'].append(inspection)
        candidate = parse_container_inspection(inspection)
        if candidate is not None:
            identity_matches = bool(
                re.fullmatch(r'[0-9a-f]{64}', candidate['id'])
                and candidate['name'] == f'/{name}'
                and candidate['imageId'] == image_id
                and candidate['runLabel'] == run_token
                and candidate['outputLabel'] == output_binding
            )
            if identity_matches and (target == name or candidate['id'] == cid):
                inspected = candidate
                break
            inspection_mismatches.append({
                'target': target,
                'containerId': candidate['id'],
                'name': candidate['name'],
                'identityMatches': identity_matches,
            })
            continue
        if inspection['timeout'] or inspection['exit'] not in (0, 1):
            break
    if inspection_mismatches:
        result['inspectionMismatches'] = inspection_mismatches

    ownership_matches = bool(
        inspected
        and re.fullmatch(r'[0-9a-f]{64}', inspected['id'])
        and inspected['name'] == f'/{name}'
        and inspected['imageId'] == image_id
        and inspected['runLabel'] == run_token
        and inspected['outputLabel'] == output_binding
    )
    if inspected is not None:
        result['containerImageDotImageIdObserved'] = inspected['imageId']
        result['containerNameObserved'] = inspected['name']
    if inspected and not ownership_matches:
        result['ownershipError'] = 'inspected container identity did not match the private run receipt'

    owned_id = inspected['id'] if ownership_matches else None
    if owned_id:
        removal = docker_cleanup_call(
            ['container', 'rm', '--force', owned_id], deadline,
        )
        result['commands'].append(removal)
        result['removalExit'] = removal['exit']

    name_listing = listed_containers([f'name={name}'], deadline)
    result['commands'].append(name_listing)
    named_rows = []
    if name_listing['exit'] == 0 and not name_listing['timeout']:
        for line in name_listing['stdout'].splitlines():
            parts = line.split('|', 1)
            if len(parts) == 2 and parts[1].removeprefix('/') == name:
                named_rows.append({'id': parts[0], 'name': parts[1]})

    id_rows = []
    id_listing = None
    if owned_id:
        id_listing = listed_containers([f'id={owned_id}'], deadline)
        result['commands'].append(id_listing)
        if id_listing['exit'] == 0 and not id_listing['timeout']:
            for line in id_listing['stdout'].splitlines():
                parts = line.split('|', 1)
                if len(parts) == 2:
                    id_rows.append({'id': parts[0], 'name': parts[1]})

    # The name query proves absence even when Docker never created a cidfile.
    # If an owned ID was observed, its independent ID query must also be empty.
    id_query_succeeded = not owned_id or (
        id_listing is not None
        and id_listing['exit'] == 0
        and not id_listing['timeout']
        and not id_rows
    )
    name_query_succeeded = name_listing['exit'] == 0 and not name_listing['timeout']
    result['verifiedAbsent'] = (
        name_query_succeeded
        and not named_rows
        and id_query_succeeded
        and not result.get('ownershipError')
        and (owned_id is not None or inspected is None)
    )
    result['status'] = 'verified-absent' if result['verifiedAbsent'] else 'cleanup-unverified'
    result['durationMs'] = round((time.monotonic() - started) * 1000, 3)
    return result


def _prepare_architecture(
    key: str,
    input_dir: Path,
    prep_dir: Path,
    name: str,
    cidfile: Path,
    run_token: str,
    output_binding: str,
    preflight: dict,
) -> dict:
    platform = PLATFORMS[key]
    if (
        preflight['imageIndexId'] != COMPILER_INDEX_DIGEST
        or preflight['platformImageId'] != platform['manifestDigest']
    ):
        raise ValueError('compiler image preflight did not bind the expected index and platform child')
    container_command = [
        'docker', 'run', '--pull=never',
        '--name', name, '--cidfile', str(cidfile),
        '--label', f'{CONTAINER_RUN_LABEL}={run_token}',
        '--label', f'{CONTAINER_OUTPUT_LABEL}={output_binding}',
        '--platform', platform['platform'],
        '--network=none', '--read-only', '--memory=512m', '--cpus=1',
        '--pids-limit=64', '--tmpfs', '/tmp:rw,nosuid,size=32m',
        '--workdir', '/tmp', '--env', 'TMPDIR=/tmp', '--env', 'LANG=C',
        '--mount', f'type=bind,src={input_dir},dst=/src,readonly',
        '--mount', f'type=bind,src={prep_dir},dst=/out',
        '--user', f'{os.getuid()}:{os.getgid()}',
        '--entrypoint', '/bin/sh', COMPILER_INDEX_REFERENCE,
        '-c', CONTAINER_SCRIPT,
    ]
    start = time.monotonic()
    try:
        completed = subprocess.run(
            container_command,
            capture_output=True,
            text=True,
            timeout=CONTAINER_TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        stdout = error.stdout.decode(errors='replace') if isinstance(error.stdout, bytes) else (error.stdout or '')
        stderr = error.stderr.decode(errors='replace') if isinstance(error.stderr, bytes) else (error.stderr or '')
        log_path = prep_dir / 'compiler-container.log'
        log_path.write_text(stdout + stderr)
        log_path.chmod(0o600)
        raise RuntimeError(
            f"compiler-only preparation timed out for {platform['platform']}; "
            f"partial log retained at {log_path}"
        ) from error
    duration_ms = (time.monotonic() - start) * 1000
    log_path = prep_dir / 'compiler-container.log'
    log_path.write_text(completed.stdout + completed.stderr)
    log_path.chmod(0o600)
    output_bytes = len(completed.stdout.encode()) + len(completed.stderr.encode())
    if output_bytes > MAX_OUTPUT_BYTES:
        raise RuntimeError(f'compiler-only preparation output exceeded {MAX_OUTPUT_BYTES} bytes')
    if completed.returncode != 0:
        raise RuntimeError(
            f"compiler-only preparation container failed for {platform['platform']} "
            f"with exit {completed.returncode}; log retained at {log_path}"
        )
    values = parse_container_output(completed.stdout)
    require_digest(values['compiler_sha256'], 'compiler binary hash')
    require_digest(values['source_openat_sha256'], 'prepared openat.c source hash')
    require_digest(values['source_ops_sha256'], 'prepared syscall wrapper source hash')
    require_digest(values['library_sha256'], 'prepared library hash')
    if values['runtime_arch'] != platform['uname']:
        raise ValueError(f"container runtime architecture mismatch: {values['runtime_arch']}")
    if values['compiler_target'] != platform['target']:
        raise ValueError(f"compiler target mismatch: {values['compiler_target']}")
    if values['source_openat_sha256'] != sha256_file(input_dir / 'openat.c'):
        raise ValueError('compiler container observed different openat.c bytes')
    if values['source_ops_sha256'] != sha256_file(input_dir / 'storage-approval-native.c'):
        raise ValueError('compiler container observed different syscall wrapper bytes')
    if (
        not values['compiler_path'].startswith('/usr/bin/')
        or not values['compiler_path'].endswith('gcc-14')
    ):
        raise ValueError('compiler path did not resolve to GCC 14 under /usr/bin')
    if '(Debian 14.2.0-' not in values['compiler_version']:
        raise ValueError('compiler version is not the pinned Debian GCC 14.2 family')
    if 'VERSION_CODENAME=trixie' not in base64.b64decode(values['os_release_b64']).decode():
        raise ValueError('compiler image is not Debian Trixie')
    if 'GLIBC 2.41' not in values['libc_version']:
        raise ValueError('compiler image libc is outside the approved GLIBC ABI family')
    if values['elf_machine'] != platform['elfMachine']:
        raise ValueError(f"ELF machine mismatch: {values['elf_machine']}")
    needed = [value for value in values['needed'].split(',') if value]
    if needed != ['libc.so.6']:
        raise ValueError(f"unexpected prepared helper DT_NEEDED entries: {needed}")
    glibc_versions = [value for value in values['glibc_versions'].split(',') if value]
    if not glibc_versions or any(
        re.fullmatch(r'GLIBC_[0-9]+(\.[0-9]+)+', value) is None
        for value in glibc_versions
    ):
        raise ValueError(f"invalid prepared helper GLIBC requirements: {glibc_versions}")
    if values['glibc_private'] != 'false':
        raise ValueError('prepared helper references GLIBC_PRIVATE')
    if any(
        int(value.split('_', 1)[1].split('.')[0]) != 2
        or int(value.split('_', 1)[1].split('.')[1]) > 41
        for value in glibc_versions
    ):
        raise ValueError('prepared helper requires a GLIBC minor newer than 2.41')
    library_path = prep_dir / 'libremi-openat.so'
    if library_path.is_symlink() or not library_path.is_file():
        raise ValueError('compiler container did not create an owned regular library')
    library_stat = library_path.stat()
    if library_stat.st_uid != os.getuid() or library_stat.st_nlink != 1:
        raise ValueError('prepared library is not a current-uid-owned single-link file')
    if library_stat.st_mode & 0o777 != 0o600:
        raise ValueError('prepared S1 library must have mode 0600')
    if library_stat.st_size <= 0 or library_stat.st_size > MAX_LIBRARY_BYTES:
        raise ValueError('prepared S1 library is empty or exceeds 4 MiB')
    library_bytes = library_path.read_bytes()
    library_sha256 = sha256_bytes(library_bytes)
    if library_sha256 != values['library_sha256']:
        raise ValueError('parent library hash disagrees with compiler container hash')
    if int(values['library_size']) != len(library_bytes):
        raise ValueError('parent library size disagrees with compiler container size')
    compiler_path = values['compiler_path']
    compile_command = [
        compiler_path, '-shared', '-fPIC', '-nostdlib',
        '-o', '/out/libremi-openat.so', '/src/openat.c',
        '/src/storage-approval-native.c', '-lc',
    ]
    return {
        'platform': platform['platform'],
        'platformManifestDigest': platform['manifestDigest'],
        'osRelease': base64.b64decode(values['os_release_b64']).decode(),
        'libcVersion': values['libc_version'],
        'compilerPath': compiler_path,
        'compilerVersion': values['compiler_version'],
        'compilerSha256': values['compiler_sha256'],
        'compilerTargetTriple': values['compiler_target'],
        'compilerPreparationDurationMs': float(values['container_compile_duration_ms']),
        'compilerPreparationContainerDurationMs': duration_ms,
        'compileCommand': compile_command,
        'sourceSha256': values['source_openat_sha256'],
        'opsSourceSha256': values['source_ops_sha256'],
        'library': {
            'name': 'libremi-openat.so',
            'sha256': library_sha256,
            'base64': base64.b64encode(library_bytes).decode('ascii'),
            'size': len(library_bytes),
            'elfMachine': values['elf_machine'],
            'needed': needed,
            'requiredGlibcVersions': glibc_versions,
        },
        'imagePreflight': preflight,
        'containerPolicy': {
            'pull': 'never',
            'automaticRemoval': False,
            'network': 'none',
            'readOnly': True,
            'cpuLimit': 1,
            'memoryMiB': 512,
            'pidsLimit': 64,
            'tmpfsMiB': 32,
            'ownerBinding': 'same uid/gid as the frozen source snapshot owner',
            'sourceMount': 'two frozen C inputs only; read-only',
            'outputMount': 'one owned architecture-specific S1 directory',
        },
        'containerOutputLog': str(log_path),
        'containerOutputLogSha256': sha256_file(log_path),
    }


def prepare_architecture(key: str, input_dir: Path, prep_dir: Path) -> dict:
    platform = PLATFORMS[key]
    prep_dir.mkdir(mode=0o700)
    output_root = prep_dir.parent
    name = f'remi-storage-approval-{uuid.uuid4().hex}'
    run_token = uuid.uuid4().hex
    output_binding = sha256_bytes(str(prep_dir.resolve()).encode('utf-8'))
    cidfile = output_root / f'{key}.container.cid'
    control_path = output_root / f'{key}.container-control.json'
    if cidfile.exists() or cidfile.is_symlink():
        raise ValueError(f'fresh private output unexpectedly contains the Docker cidfile: {cidfile}')
    control = {
        'schemaVersion': 1,
        'status': 'not-started',
        'createdAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'imageIndex': COMPILER_INDEX_REFERENCE,
        'imageIndexDigest': COMPILER_INDEX_DIGEST,
        'imageIndexId': COMPILER_INDEX_DIGEST,
        'expectedContainerImageDotImageId': COMPILER_INDEX_DIGEST,
        'platform': platform['platform'],
        'platformManifestDigest': platform['manifestDigest'],
        'containerName': name,
        'containerIdFile': str(cidfile),
        'runToken': run_token,
        'outputDirectory': str(prep_dir.resolve()),
        'outputDirectorySha256': output_binding,
        'cleanupBudgetSeconds': CLEANUP_BUDGET_SECONDS,
        'policy': 'only this UUID-named, receipt-labeled container may be removed',
    }
    write_control_receipt(control_path, control)
    value = None
    run_error = None
    try:
        preflight_started = time.monotonic()
        preflight = compiler_image_preflight(platform)
        control['preflight'] = preflight
        control['preflightDurationMs'] = round((time.monotonic() - preflight_started) * 1000, 3)
        write_control_receipt(control_path, control)
        control['status'] = 'launching'
        write_control_receipt(control_path, control)
        value = _prepare_architecture(
            key, input_dir, prep_dir, name, cidfile, run_token, output_binding,
            preflight,
        )
    except Exception as error:  # noqa: BLE001 - retain every preparation failure before cleanup
        run_error = error
        control['runError'] = {
            'type': type(error).__name__,
            'message': str(error),
        }
    finally:
        control['status'] = 'cleaning-owned-container'
        try:
            control['cleanup'] = cleanup_owned_container(
                name, cidfile, run_token, output_binding,
                COMPILER_INDEX_DIGEST,
            )
        except Exception as cleanup_error:  # noqa: BLE001 - preserve cleanup failures for the receipt
            control['cleanup'] = {
                'status': 'cleanup-unverified',
                'verifiedAbsent': False,
                'containerName': name,
                'containerIdFile': str(cidfile),
                'cleanupError': {
                    'type': type(cleanup_error).__name__,
                    'message': str(cleanup_error),
                },
            }
        control['status'] = control['cleanup']['status']
        write_control_receipt(control_path, control)

    if not control['cleanup']['verifiedAbsent']:
        error = RuntimeError(
            f"compiler container cleanup is unverified; preserved lifecycle receipt at "
            f"{control_path}"
        )
        if run_error:
            raise error from run_error
        raise error
    observed_container_image = control['cleanup'].get('containerImageDotImageIdObserved')
    if run_error is None and observed_container_image != COMPILER_INDEX_DIGEST:
        run_error = RuntimeError(
            'successful preparation did not retain and verify the actual container .Image index ID'
        )
        control['runError'] = {'type': type(run_error).__name__, 'message': str(run_error)}
        control['status'] = 'failed-image-provenance'
        write_control_receipt(control_path, control)
    if run_error:
        raise run_error
    assert value is not None
    value['containerLifecycle'] = {
        'containerName': name,
        'containerIdFile': str(cidfile),
        'expectedContainerImageDotImageId': COMPILER_INDEX_DIGEST,
        'containerImageDotImageIdObserved': observed_container_image,
        'receipt': str(control_path),
        'verifiedAbsent': True,
        'cleanupDurationMs': control['cleanup']['durationMs'],
    }
    value['compilerImageIndexId'] = control['preflight']['imageIndexId']
    value['containerImageDotImageId'] = observed_container_image
    return value


def main() -> int:
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument('--source-root', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()

    if args.source_root.is_symlink():
        parser.error('--source-root must not be a symlink')
    source = args.source_root.resolve(strict=True)
    if not source.is_relative_to(ARTIFACTS_ROOT.resolve()):
        parser.error('--source-root must be an immutable S1 source snapshot')
    require_owned_directory(source, 'source snapshot')
    frozen_packager = (
        source / 'scripts' / 'tunnel-storage-proof' / 'storage-approval-prepare-linux.py'
    )
    if (
        frozen_packager.is_symlink()
        or not frozen_packager.is_file()
        or frozen_packager.read_bytes() != Path(__file__).resolve().read_bytes()
    ):
        parser.error('executed Linux packager must match the frozen source snapshot')
    source_tree = source_manifest(source)
    output = args.out.absolute()
    if output.exists() or output.is_symlink():
        parser.error('--out must be a fresh S1 path')
    output_parent = output.parent.resolve(strict=True)
    if not output_parent.is_relative_to(ARTIFACTS_ROOT.resolve()):
        parser.error('--out must be under S1 artifacts')
    output = output_parent / output.name
    output.mkdir(mode=0o700)
    require_owned_directory(output, 'preparation output')

    frozen_source = output / 'source'
    copy_snapshot(source, frozen_source, source_tree)
    input_hashes = copy_c_inputs(frozen_source, output)
    prep_root = output / 'prepared'
    prep_root.mkdir(mode=0o700)
    assets = {}
    external_receipts = {}
    for arch in ('arm64', 'x64'):
        prep_dir = prep_root / arch
        try:
            assets[arch] = prepare_architecture(arch, output / 'native-input', prep_dir)
        except Exception as error:
            failure = {
                'createdAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'status': 'failed',
                'phase': 'linux-helper-preparation',
                'architecture': arch,
                'errorType': type(error).__name__,
                'error': str(error),
                'sourceRoot': str(source),
                'frozenSourceRoot': str(frozen_source),
                'completedArchitectures': external_receipts,
            }
            failure_path = output / 'preparation-failure.json'
            with failure_path.open('x') as handle:
                json.dump(failure, handle, indent=2)
                handle.write('\n')
            raise
        external_receipts[arch] = {
            **{
                key: value for key, value in assets[arch].items()
                if key not in ('library', 'containerPolicy')
            },
            'library': {
                key: value for key, value in assets[arch]['library'].items()
                if key != 'base64'
            },
            'containerPolicy': assets[arch]['containerPolicy'],
        }
        compiler_receipt_path = prep_dir / 'compiler-receipt.json'
        with compiler_receipt_path.open('x') as handle:
            json.dump(external_receipts[arch], handle, indent=2)
            handle.write('\n')

    embedded_assets = {
        arch: {
            key: asset[key] for key in (
                'compilerImageIndexId', 'platform', 'platformManifestDigest',
                'containerImageDotImageId', 'osRelease', 'libcVersion',
                'compilerPath', 'compilerVersion', 'compilerSha256',
                'compilerTargetTriple', 'compilerPreparationDurationMs',
                'compilerPreparationContainerDurationMs',
                'compileCommand', 'sourceSha256', 'opsSourceSha256', 'library',
            )
        }
        for arch, asset in assets.items()
    }
    manifest = {
        'schemaVersion': 1,
        'compilerImageIndexReference': COMPILER_INDEX_REFERENCE,
        'compilerImageIndexDigest': COMPILER_INDEX_DIGEST,
        'assets': embedded_assets,
    }
    canonical_manifest = json.dumps(manifest, sort_keys=True, separators=(',', ':'))
    manifest_sha256 = sha256_bytes(canonical_manifest.encode('utf-8'))
    generated_path = frozen_source / 'scripts' / 'tunnel-storage-proof' / GENERATED_MODULE
    if generated_path.is_symlink() or not generated_path.is_file():
        raise ValueError('frozen source is missing the generated helper module placeholder')
    generated_path.write_text(
        'export const linuxNativeHelperManifestJson = '
        + json.dumps(canonical_manifest)
        + ';\nexport const linuxNativeHelperManifestSha256 = '
        + json.dumps(manifest_sha256)
        + ';\n'
    )
    generated_path.chmod(0o600)
    derived_tree = source_manifest(frozen_source)
    receipt = {
        'createdAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'scope': 'proof-only Linux helper preparation; no production adoption',
        'sourceRoot': str(source),
        'frozenSourceRoot': str(frozen_source),
        'sourceTreeBeforeCopy': source_tree,
        'sourceTreeAfterPreparation': derived_tree,
        'nativeInputHashes': input_hashes,
        'compilerImageIndexReference': COMPILER_INDEX_REFERENCE,
        'compilerImageIndexDigest': COMPILER_INDEX_DIGEST,
        'supportManifestSha256': manifest_sha256,
        'generatedModuleSha256': sha256_file(generated_path),
        'architectures': external_receipts,
        'status': 'prepared-source-awaits-runtime-matrix',
    }
    receipt_path = output / 'preparation-receipt.json'
    with receipt_path.open('x') as handle:
        json.dump(receipt, handle, indent=2)
        handle.write('\n')
    print(json.dumps({
        'output': str(output),
        'sourceRoot': str(frozen_source),
        'supportManifestSha256': manifest_sha256,
        'receipt': str(receipt_path),
        'status': receipt['status'],
    }, indent=2))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired) as error:
        print(f'{type(error).__name__}: {error}', file=sys.stderr)
        sys.exit(1)
