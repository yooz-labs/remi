#!/usr/bin/env python3
"""Use only owned local canaries and an ephemeral loopback listener."""
import json, socket, subprocess, sys
from pathlib import Path
root=Path(sys.argv[1]).resolve()
binary=root/'sandbox-probe'
canary=root/'sandbox-canary'
canary.write_text('owned synthetic canary\n')
profile=root/'seatbelt.sb'
profile.write_text('(version 1)\n(deny default)\n(allow process*)\n(allow sysctl-read)\n(allow file-read* (subpath "/usr/lib") (subpath "/System/Library") (literal "'+str(binary)+'"))\n')
with socket.socket() as listener:
    listener.bind(('127.0.0.1',0)); listener.listen(3); port=listener.getsockname()[1]
    cases=[]
    for name,argv in [('positive',[str(binary)]),('sandboxed',['/usr/bin/sandbox-exec','-f',str(profile),str(binary)])]:
        dest=root/('sandbox-'+name+'-write')
        result=subprocess.run(argv+[str(canary),str(dest),str(port)],capture_output=True,text=True,timeout=5)
        cases.append({'name':name,'exit':result.returncode,'stdout':result.stdout,'stderr':result.stderr,'file_exists':dest.exists()})
        if dest.exists(): dest.unlink()
    result={'scope':'owned canaries only; not renderer containment, process-tree limit or portable acceptance', 'cases':cases}
    (root/'sandbox-control.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result,indent=2))
