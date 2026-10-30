#!/usr/bin/env python3
"""Changed-condition diagnostic: targets only owned canaries, not isolation."""
import json, socket, subprocess, sys
from pathlib import Path
root=Path(sys.argv[1]).resolve(); binary=root/'sandbox-probe'; canary=root/'sandbox-canary'
profile=root/'seatbelt-targeted.sb'
profile.write_text('(version 1)\n(allow default)\n(deny network*)\n(deny file-read* (literal "'+str(canary)+'"))\n(deny file-write* (literal "'+str(root/'sandbox-targeted-write')+'"))\n')
with socket.socket() as listener:
    listener.bind(('127.0.0.1',0)); listener.listen(1)
    result=subprocess.run(['/usr/bin/sandbox-exec','-f',str(profile),str(binary),str(canary),str(root/'sandbox-targeted-write'),str(listener.getsockname()[1])],capture_output=True,text=True,timeout=5)
report={'condition':'allow default then deny ONLY owned canary and network; not general filesystem isolation', 'exit':result.returncode,'stdout':result.stdout,'stderr':result.stderr}
(root/'sandbox-targeted-control.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
