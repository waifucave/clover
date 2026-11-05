#!/usr/bin/env python3
"""Inventory sandbox-only CLI surfaces with isolated homes; never agent prompts."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

actual_home=str(Path.home())
for name in ('cursor-agent','agy','devin'):
    binary=shutil.which(name)
    if not binary:
        print(json.dumps({'agent':name,'available':False}),flush=True);continue
    with tempfile.TemporaryDirectory(prefix='clover-agent-surface-') as temp:
        root=Path(temp)
        (root/'.gemini/antigravity-cli').mkdir(parents=True)
        (root/'.gemini/antigravity-cli/settings.json').write_text('{"enableTelemetry":false}')
        env={'PATH':os.environ['PATH'],'HOME':temp,'TMPDIR':temp,'XDG_CONFIG_HOME':temp+'/config',
            'XDG_DATA_HOME':temp+'/data','XDG_CACHE_HOME':temp+'/cache','DO_NOT_TRACK':'1',
            'NO_COLOR':'1','CI':'1','CODEX_HOME':temp+'/codex'}
        for args in (['--help'],['sandbox','--help']):
            print('Reading isolated CLI surface: '+name+' '+' '.join(args),flush=True)
            try:
                r=subprocess.run([binary]+args,cwd=temp,env=env,stdin=subprocess.DEVNULL,
                    capture_output=True,text=True,timeout=20)
                text=(r.stdout+r.stderr).replace(actual_home,'<host-home>').replace(temp,'<isolated-home>')
                print(json.dumps({'agent':name,'args':args,'exit':r.returncode,'help':text[:14000]}),flush=True)
            except subprocess.TimeoutExpired:
                print(json.dumps({'agent':name,'args':args,'timeout':True}),flush=True)
