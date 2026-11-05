#!/usr/bin/env python3
"""Cursor's sandbox-only command: isolated home, no login or prompt."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

binary=shutil.which('cursor-agent') or shutil.which('agent')
if not binary: raise SystemExit('Cursor CLI unavailable')
with tempfile.TemporaryDirectory(prefix='clover-cursor-') as t:
    root=Path(t).resolve();work=root/'work';work.mkdir();hidden=root/'control';hidden.mkdir()
    (hidden/'public').write_text('public fixture')
    (work/'.cursor').mkdir()
    (work/'.cursor/cli.json').write_text(json.dumps({'permissions':{'allow':[],'deny':[
        'Read('+str(hidden)+'/**)','Write('+str(hidden)+'/**)']}}))
    env={'HOME':str(root),'PATH':os.environ['PATH'],'TMPDIR':str(root),'XDG_CONFIG_HOME':str(root/'config'),
        'XDG_CACHE_HOME':str(root/'cache'),'DO_NOT_TRACK':'1','NO_COLOR':'1','CI':'1'}
    checks={'allowed-write':'touch "$2/ok"','hidden-read':'! cat "$1/public" >/dev/null 2>&1',
        'hidden-write':'! touch "$1/bad" 2>/dev/null','encoded-retry':'! /bin/sh -c \'cat "$1/public"\' retry "$1" >/dev/null 2>&1'}
    for test,command in checks.items():
        script=work/(test+'.sh')
        script.write_text('#!/bin/sh\n'+command.replace('"$1','"'+str(hidden)).replace('"$2','"'+str(work))+'\n')
        r=subprocess.run([binary,'sandbox','run','--blocked-patterns',str(hidden)+'/**','--',
            '/bin/sh',str(script)],cwd=work,env=env,
            stdin=subprocess.DEVNULL,capture_output=True,text=True,timeout=25)
        print(json.dumps({'test':'cursor-'+test,'exit':r.returncode,'diagnostic':(r.stdout+r.stderr).replace(str(root),'<isolated-home>')[:800]}),flush=True)
    print(json.dumps({'test':'cursor-host-state','allowed_write':(work/'ok').exists(),'hidden_write':(hidden/'bad').exists()}))
