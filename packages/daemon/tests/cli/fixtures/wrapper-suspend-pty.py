"""Run the real wrapper under an owned shell's job control (#375).

No signal/stdin seams: input enters the OS PTY and `fg` is executed by the
interactive shell. Cleanup uses captured start identities and ancestry;
initial pidfd correlation and numeric signalling retain narrow race windows.
"""

import argparse
import ctypes
import errno
import json
import os
from pathlib import Path
import pty
import select
import shlex
import signal
import socket
import subprocess
import sys
import time
import tty


# The same fixture is also the inert PTY child, selected only by the owned PATH.
if "--child" in sys.argv:
    root = Path(os.environ["SUSPEND_PROBE_ROOT"])
    (root / "pids.json").write_text(json.dumps({"wrapper": os.getppid(), "child": os.getpid()}))
    tty.setraw(0)
    if "--hold-before-ready" not in sys.argv:
        print("SUSPEND_PROBE_READY", flush=True)
    with (root / "input.hex").open("a", buffering=1) as receipt:
        while True:
            data = os.read(0, 4096)
            if not data:
                break
            receipt.write(data.hex() + "\n")
    sys.exit(0)

if sys.platform == "darwin":
    # Darwin's public proc_bsdinfo layout (sys/proc_info.h). Its start time
    # includes microseconds; ps lstart's whole seconds cannot distinguish a
    # rapid PID reuse. No environment, arguments, or credential data is read.
    class BsdInfo(ctypes.Structure):
        _fields_ = [
            (name, ctypes.c_uint32) for name in
            ("flags", "status", "xstatus", "pid", "ppid", "uid", "gid", "ruid",
             "rgid", "svuid", "svgid", "reserved")
        ] + [
            ("comm", ctypes.c_char * 16), ("name", ctypes.c_char * 32),
            ("nfiles", ctypes.c_uint32), ("pgid", ctypes.c_uint32),
            ("jobc", ctypes.c_uint32), ("tdev", ctypes.c_uint32),
            ("tpgid", ctypes.c_uint32), ("nice", ctypes.c_int32),
            ("start_sec", ctypes.c_uint64), ("start_usec", ctypes.c_uint64),
        ]

    libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    libproc.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64,
                                   ctypes.c_void_p, ctypes.c_int]
    libproc.proc_pidinfo.restype = ctypes.c_int


def process_identity(pid):
    if sys.platform == "darwin":
        info = BsdInfo()
        ctypes.set_errno(0)
        size = libproc.proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info))
        if size != ctypes.sizeof(info):
            code = ctypes.get_errno()
            if size == 0 and code == errno.ESRCH:
                return None
            raise OSError(code or errno.EIO, f"proc_pidinfo({pid}) returned {size} bytes")
        return {"start": [info.start_sec, info.start_usec], "parent": info.ppid, "group": info.pgid}
    try:
        # Fields after the final comm ')' start at field 3; starttime is field 22.
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
    except FileNotFoundError:
        return None
    try:
        return {"start": [int(fields[19])], "parent": int(fields[1]), "group": int(fields[2])}
    except (ValueError, IndexError) as error:
        raise OSError(errno.EIO, f"cannot parse process identity for {pid}") from error


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--root", type=Path, required=True)
parser.add_argument("--bun", required=True)
parser.add_argument("--cli", type=Path)
parser.add_argument("--hold-before-ready", action="store_true")
parser.add_argument("--deadline-seconds", type=float, default=25)
args = parser.parse_args()
if not 0 < args.deadline_seconds <= 25:
    parser.error("deadline-seconds must be positive and at most 25")
root = args.root.resolve()
root.mkdir(parents=True, exist_ok=True)
home = root / "home"
home.mkdir()
bin_dir = root / "bin"
bin_dir.mkdir()
child_script = Path(__file__).resolve()
(bin_dir / "claude").write_text(
    "#!/bin/sh\nexec " + shlex.join([
        sys.executable, str(child_script), "--child",
        *(["--hold-before-ready"] if args.hold_before_ready else []),
    ]) + " \"$@\"\n"
)
(bin_dir / "claude").chmod(0o700)
with socket.socket() as reservation:
    reservation.bind(("127.0.0.1", 0))
    port = reservation.getsockname()[1]

shell = "/bin/zsh" if sys.platform == "darwin" else "/bin/bash"
shell_args = [shell, "-dfi"] if sys.platform == "darwin" else [shell, "--noprofile", "--norc", "-i"]
env = {
    "HOME": str(home), "PATH": str(bin_dir) + ":/usr/bin:/bin", "TERM": "xterm-256color",
    "PS1": "SUSPEND_SHELL> ", "REMI_HOME": str(home / "remi"), "REMI_PORT": str(port),
    "TMPDIR": str(root), "SUSPEND_PROBE_ROOT": str(root), "PYTHONDONTWRITEBYTECODE": "1",
}
started = time.monotonic()
deadline = started + args.deadline_seconds
shell_pid, master = pty.fork()
if shell_pid == 0:
    os.chdir(root)
    os.execve(shell, shell_args, env)

transcript = bytearray()
owned = []
identities = {}
handles = {}
known_exited = set()
cleanup_signals = []
cleanup_attempts = []
cleanup_skipped = []
cleanup_errors = []
pidfd_fallbacks = []
unverified_candidates = set()
states = []
cycles = []
expected = bytearray()
result = {"shell": shell, "shellPid": shell_pid, "cycles": cycles, "states": states,
          "cleanupSignals": cleanup_signals, "cleanupSkipped": cleanup_skipped}
result["cleanupAttempts"] = cleanup_attempts
result["cleanupErrors"] = cleanup_errors
result["pidfdFallbacks"] = pidfd_fallbacks


def remember_owned(pid, parent):
    identity = process_identity(pid)
    assert identity is not None and identity["parent"] == parent, "process is not our descendant"
    assert parent in identities and process_identity(parent) == identities[parent], "parent identity changed"
    # Capture ownership before an optional capability can fail. An unavailable
    # pidfd must not leave this independently verified process outside cleanup.
    identities[pid] = identity
    owned.append(pid)
    # Linux pidfds bind later signals to the opened incarnation. Recheck its
    # initial correlation; /proc start ticks still have finite granularity.
    if hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal"):
        try:
            handle = os.pidfd_open(pid)
        except ProcessLookupError:
            known_exited.add(pid)
        except OSError as error:
            pidfd_fallbacks.append({"pid": pid, "errno": error.errno, "error": str(error)})
        else:
            try:
                if process_identity(pid) != identity:
                    raise AssertionError("process changed while opening pidfd")
            except (OSError, AssertionError):
                os.close(handle)
                raise
            handles[pid] = handle


def same_process(pid):
    if pid in known_exited:
        return False
    current = process_identity(pid)
    captured = identities[pid]
    if current is None or current["start"] != captured["start"]:
        known_exited.add(pid)
        return False
    parent = captured["parent"]
    # A child may be reparented after its owned wrapper exits. Its unchanged
    # kernel start identity plus the captured ancestry still identifies it.
    if parent in identities and parent != shell_pid:
        same_process(parent)
    return (pid == shell_pid or current["group"] == captured["group"]) and (
        current["parent"] == parent or current["parent"] == 1 and parent in known_exited
    )


def cleanup_signal(pid, sig):
    try:
        # An opened/revalidated pidfd is independently bound to the captured
        # incarnation, even if a later procfs inspection is unavailable.
        if pid in known_exited or pid not in handles and not same_process(pid):
            cleanup_skipped.append({"pid": pid, "signal": sig.name, "reason": "exited-or-changed"})
            return
        cleanup_attempts.append({"pid": pid, "signal": sig.name, "start": identities[pid]["start"]})
        if pid in handles:
            signal.pidfd_send_signal(handles[pid], sig)
        else:
            # macOS has no pidfd API: revalidate kernel start identity and
            # ancestry immediately before every remaining numeric-PID signal.
            os.kill(pid, sig)
        cleanup_signals.append({"pid": pid, "signal": sig.name})
    except ProcessLookupError:
        known_exited.add(pid)
    except OSError as error:
        cleanup_errors.append({"stage": sig.name, "pid": pid, "error": str(error)})


def drain(seconds=0.02, limit=None):
    end = min(time.monotonic() + seconds, deadline if limit is None else limit)
    while time.monotonic() < end:
        ready, _, _ = select.select([master], [], [], max(0, end - time.monotonic()))
        if ready:
            try:
                transcript.extend(os.read(master, 65536))
            except OSError:
                return


def wait_for(check, description):
    while not check():
        if time.monotonic() >= deadline:
            raise AssertionError("Timed out: " + description)
        drain()


def processes(candidates=None):
    output = subprocess.check_output(
        ["/bin/ps", "-o", "pid=,ppid=,pgid=,tpgid=,state=", "-p",
         ",".join(str(pid) for pid in [shell_pid, *(owned if candidates is None else candidates)])],
        text=True
    )
    observed = {int(fields[0]): fields[1:] for line in output.splitlines() if (fields := line.split())}
    for pid in owned:
        if pid not in observed or observed[pid][-1].startswith("Z"):
            known_exited.add(pid)
    return observed


def snapshot(stage):
    state = {"stage": stage, "foreground": os.tcgetpgrp(master), "processes": processes()}
    states.append(state)
    return state


def stopped(pid):
    entry = processes().get(pid)
    return entry is not None and entry[-1].startswith("T")


def input_bytes():
    path = root / "input.hex"
    return bytes.fromhex(path.read_text().replace("\n", "")) if path.exists() else b""


def suspend_logs():
    path = home / "remi" / "remi.log"
    return [line.split("[suspend] ", 1)[1] for line in path.read_text().splitlines()
            if "[suspend] " in line] if path.exists() else []


def resume_cycle(name, trigger):
    trigger()
    wait_for(lambda: stopped(wrapper) and os.tcgetpgrp(master) == shell_pid, name + " stopped")
    state = snapshot(name + "-stopped")
    assert not state["processes"][child][-1].startswith("T"), "child stopped with wrapper"
    os.write(master, b"fg\n")
    wait_for(lambda: os.tcgetpgrp(master) == wrapper and not stopped(wrapper), name + " fg")
    # Check a quiet interval before sending any further input; a buffered control
    # replay would stop the wrapper here, without a second genuine Ctrl+Z.
    drain(0.15)
    state = snapshot(name + "-foreground")
    assert state["foreground"] == wrapper and not stopped(wrapper), "fg immediately re-suspended"
    marker = (name + "-input").encode()
    expected.extend(marker)
    os.write(master, marker)
    wait_for(lambda: input_bytes() == bytes(expected), name + " input forwarded exactly once")
    logs = suspend_logs()
    assert len(logs) == (len(cycles) + 1) * 2, "extra/missing suspend or continue log"
    assert "SIGTSTP received" in logs[-2] and "SIGCONT received" in logs[-1], "signal order"
    cycles.append(name)


try:
    wait_for(lambda: b"SUSPEND_SHELL> " in transcript, "shell ready")
    identities[shell_pid] = process_identity(shell_pid)
    assert identities[shell_pid] is not None, "shell identity unavailable"
    command = [args.bun, *([str(args.cli.resolve())] if args.cli else []), "--no-relay"]
    os.write(master, (shlex.join(command) + "\n").encode())
    wait_for(lambda: b"SUSPEND_PROBE_READY" in transcript, "inert child ready")
    metadata = json.loads((root / "pids.json").read_text())
    wrapper, child = metadata["wrapper"], metadata["child"]
    assert wrapper > 1 and child > 1 and wrapper != shell_pid and child != shell_pid
    initial = processes([wrapper, child])
    assert int(initial[wrapper][0]) == shell_pid, "wrapper is not our shell's child"
    remember_owned(wrapper, shell_pid)
    assert int(initial[child][0]) == wrapper, "PTY child is not our wrapper's child"
    remember_owned(child, wrapper)
    state = snapshot("ready")
    assert int(state["processes"][wrapper][1]) == wrapper, "wrapper has no distinct job group"
    assert int(state["processes"][child][1]) == child, "PTY child has no distinct process group"
    drain(0.1)
    for index in range(3):
        resume_cycle("ctrl-z-" + str(index), lambda: os.write(master, b"\x1a"))
    resume_cycle("external", lambda: os.kill(wrapper, signal.SIGTSTP))
    # The scanner must preserve ordinary bytes surrounding the consumed control.
    expected.extend(b"beforeafter")
    resume_cycle("surrounded", lambda: os.write(master, b"before\x1aafter"))
    assert b"\x1a" not in input_bytes(), "Ctrl+Z reached the child"
    os.write(master, b"\x02d")
    wait_for(lambda: wrapper not in processes() and child not in processes(), "detach and child exit")
    wait_for(lambda: os.tcgetpgrp(master) == shell_pid, "shell foreground after detach")
    result.update(inputHex=input_bytes().hex(), signalLogs=suspend_logs(), detached=True)
except Exception as error:
    result["error"] = str(error)
finally:
    try:
        # Recover pre-ready processes independently: one inspection failure
        # must neither label a process exited nor abort other targets' cleanup.
        candidate = None
        try:
            foreground = os.tcgetpgrp(master)
            if foreground != shell_pid and foreground not in owned:
                entry = processes([foreground]).get(foreground)
                if entry is not None and int(entry[0]) == shell_pid:
                    candidate = foreground
                    remember_owned(candidate, shell_pid)
        except (OSError, AssertionError) as error:
            if candidate is not None:
                unverified_candidates.add(candidate)
            cleanup_errors.append({"stage": "recover-wrapper", "error": str(error)})
        candidate = None
        try:
            metadata_path = root / "pids.json"
            if metadata_path.exists():
                metadata = json.loads(metadata_path.read_text())
                candidate = metadata["child"]
                entry = processes([candidate]).get(candidate)
                if candidate not in owned and entry is not None and int(entry[0]) in owned:
                    remember_owned(candidate, int(entry[0]))
        except (OSError, ValueError, KeyError, AssertionError) as error:
            if candidate is not None:
                unverified_candidates.add(candidate)
            cleanup_errors.append({"stage": "recover-child", "error": str(error)})
        cleanup_deadline = time.monotonic() + 2
        for pid in owned:
            for sig in (signal.SIGCONT, signal.SIGTERM):
                cleanup_signal(pid, sig)
        drain(0.2, cleanup_deadline)
        for pid in owned:
            cleanup_signal(pid, signal.SIGKILL)
        drain(0.1, cleanup_deadline)
    finally:
        # The shell is our unreaped direct child. waitpid proves ownership
        # independently of libproc/procfs and prevents its PID being recycled
        # before this kill/reap, even if identity inspection is unavailable.
        try:
            waited, _ = os.waitpid(shell_pid, os.WNOHANG)
            if waited == 0:
                cleanup_attempts.append({"pid": shell_pid, "signal": "SIGKILL", "directChild": True})
                try:
                    os.kill(shell_pid, signal.SIGKILL)
                    cleanup_signals.append({"pid": shell_pid, "signal": "SIGKILL"})
                except ProcessLookupError:
                    pass  # It exited after waitpid; still reap it below.
                except OSError as error:
                    cleanup_errors.append({"stage": "shell-kill", "error": str(error)})
                reap_deadline = time.monotonic() + 1
                while waited == 0 and time.monotonic() < reap_deadline:
                    waited, _ = os.waitpid(shell_pid, os.WNOHANG)
                    if waited == 0:
                        time.sleep(0.01)
            result["shellReaped"] = waited == shell_pid
            if waited == 0:
                cleanup_errors.append({"stage": "shell-reap", "error": "shell did not exit within budget"})
            else:
                try:
                    result["reapedShellAbsent"] = process_identity(shell_pid) is None
                except OSError as error:
                    cleanup_errors.append({"stage": "inspect-reaped-shell", "error": str(error)})
        except OSError as error:
            cleanup_errors.append({"stage": "shell-reap", "error": str(error)})
        for fd in [master, *handles.values()]:
            try:
                os.close(fd)
            except OSError as error:
                cleanup_errors.append({"stage": "close-fd", "error": str(error)})
    remaining = []
    unknown = []
    for pid in set(owned) | unverified_candidates:
        if pid in known_exited:
            continue
        try:
            current = process_identity(pid)
        except OSError as error:
            unknown.append(pid)
            remaining.append(pid)
            cleanup_errors.append({"stage": "remaining-inspection", "pid": pid, "error": str(error)})
            continue
        if current is not None and (pid not in identities or current["start"] == identities[pid]["start"]):
            remaining.append(pid)
    result["remainingPids"] = sorted(remaining)
    result["unknownPids"] = sorted(unknown)
    result["knownExitedPids"] = sorted(known_exited)
    result["seconds"] = time.monotonic() - started
    (root / "transcript.bin").write_bytes(transcript)
    (root / "result.json").write_text(json.dumps(result, indent=2))
    print(json.dumps(result))
sys.exit(1 if result.get("error") or result["remainingPids"] or cleanup_errors else 0)
