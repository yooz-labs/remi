"""Run the real wrapper under an owned shell's job control (#375).

No signal/stdin seams: input enters the OS PTY and `fg` is executed by the
interactive shell. Only PIDs created by this probe may be signalled.
"""

import argparse
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
    print("SUSPEND_PROBE_READY", flush=True)
    with (root / "input.hex").open("a", buffering=1) as receipt:
        while True:
            data = os.read(0, 4096)
            if not data:
                break
            receipt.write(data.hex() + "\n")
    sys.exit(0)

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--root", type=Path, required=True)
parser.add_argument("--bun", required=True)
parser.add_argument("--cli", type=Path)
args = parser.parse_args()
root = args.root.resolve()
root.mkdir(parents=True, exist_ok=True)
home = root / "home"
home.mkdir()
bin_dir = root / "bin"
bin_dir.mkdir()
child_script = Path(__file__).resolve()
(bin_dir / "claude").write_text(
    "#!/bin/sh\nexec " + shlex.join([sys.executable, str(child_script), "--child"]) + " \"$@\"\n"
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
deadline = started + 25
shell_pid, master = pty.fork()
if shell_pid == 0:
    os.chdir(root)
    os.execve(shell, shell_args, env)

transcript = bytearray()
owned = []
states = []
cycles = []
expected = bytearray()
result = {"shell": shell, "cycles": cycles, "states": states}


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
    return {int(fields[0]): fields[1:] for line in output.splitlines() if (fields := line.split())}


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
    command = [args.bun, *([str(args.cli.resolve())] if args.cli else []), "--no-relay"]
    os.write(master, (shlex.join(command) + "\n").encode())
    wait_for(lambda: b"SUSPEND_PROBE_READY" in transcript, "inert child ready")
    metadata = json.loads((root / "pids.json").read_text())
    wrapper, child = metadata["wrapper"], metadata["child"]
    assert wrapper > 1 and child > 1 and wrapper != shell_pid and child != shell_pid
    initial = processes([wrapper, child])
    assert int(initial[wrapper][0]) == shell_pid, "wrapper is not our shell's child"
    owned.append(wrapper)
    assert int(initial[child][0]) == wrapper, "PTY child is not our wrapper's child"
    owned.append(child)
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
    # A wrapper may fail before the child emits its ready marker. Recover its
    # foreground PID only after proving that it belongs to this owned shell.
    foreground = os.tcgetpgrp(master)
    if foreground != shell_pid and foreground not in owned:
        entry = processes([foreground]).get(foreground)
        if entry is not None and int(entry[0]) == shell_pid:
            owned.append(foreground)
    metadata_path = root / "pids.json"
    if metadata_path.exists():
        metadata = json.loads(metadata_path.read_text())
        candidate = metadata["child"]
        entry = processes([candidate]).get(candidate)
        if candidate not in owned and entry is not None and int(entry[0]) in owned:
            owned.append(candidate)
    # Even a stopped wrapper must be ended. SIGCONT/TERM target only the owned
    # PIDs; after a short teardown window SIGKILL is the bounded fallback.
    cleanup_deadline = time.monotonic() + 2
    for pid in owned:
        for sig in (signal.SIGCONT, signal.SIGTERM):
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                pass
    drain(0.2, cleanup_deadline)
    for pid in owned:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    drain(0.1, cleanup_deadline)
    try:
        os.kill(shell_pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    os.waitpid(shell_pid, 0)
    os.close(master)
    result["remainingPids"] = [pid for pid in owned if subprocess.run(
        ["/bin/ps", "-p", str(pid), "-o", "pid="], stdout=subprocess.PIPE
    ).stdout.strip()]
    result["seconds"] = time.monotonic() - started
    (root / "transcript.bin").write_bytes(transcript)
    (root / "result.json").write_text(json.dumps(result, indent=2))
    print(json.dumps(result))
sys.exit(1 if result.get("error") or result["remainingPids"] else 0)
