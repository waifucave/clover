#!/usr/bin/env python3
"""No-model filesystem, alias and retry probes through vendor sandbox-only APIs."""
import argparse
import json
import os
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile

parser=argparse.ArgumentParser();parser.add_argument('backend',choices=['codex','srt']);args=parser.parse_args()
cli=Path(__file__).with_name('.deps')/'node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js'
with tempfile.TemporaryDirectory(prefix='cg-') as t:
    root=Path(t).resolve();work=root/'work';control=root/'control';config=root/'config'
    for p in [work,control,control/'run',config]:p.mkdir()
    for name in ['secret','key','run/token','settings']: (control/name).write_text('public fixture')
    (work/'alias').symlink_to(control,target_is_directory=True)
    worker=work/'worker.py'
    worker.write_text('''import os,sys,pathlib,subprocess
test,work,control,config=sys.argv[1:]; w=pathlib.Path(work);c=pathlib.Path(control)
def denied(f):
 try:f();return False
 except OSError:return True
ok=False
if test=='allowed-write':(w/'ok').write_text('public');ok=True
elif test=='secret-read':ok=denied(lambda:(c/'secret').read_bytes())
elif test=='key-read':ok=denied(lambda:(c/'key').read_bytes())
elif test=='run-read':ok=denied(lambda:(c/'run/token').read_bytes())
elif test=='alias-read':ok=denied(lambda:(w/'alias/secret').read_bytes())
elif test=='link-create':ok=denied(lambda:os.link(c/'secret',w/'new-hardlink'))
elif test=='settings-write':
 try:(c/'settings').write_text('changed')
 except OSError:pass
 ok=True
elif test=='policy-write':ok=denied(lambda:(pathlib.Path(config)/'attack').write_text('public'))
elif test=='nested-retry':
 r=subprocess.run([sys.executable,'-c','import pathlib,sys;pathlib.Path(sys.argv[1]).read_bytes()',str(c/'secret')],capture_output=True);ok=r.returncode!=0
elif test=='nested-userns':
 r=subprocess.run(['unshare','-Ur','-m','/bin/sh','-c','umount "$1" 2>/dev/null; cat "$1/secret" >/dev/null','probe',str(c)],capture_output=True);ok=r.returncode!=0
sys.exit(0 if ok else 9)
''')
    if args.backend=='codex':
        (config/'config.toml').write_text('[permissions.clover.filesystem]\n":root"="read"\n'+json.dumps(str(work))+'="write"\n'+json.dumps(str(control))+'="deny"\n[permissions.clover.network]\nenabled=false\n')
        prefix=['codex','sandbox','-C',str(work),'-P','clover','--']
        if Path('/usr/local/libexec/clover-spike-bwrap').exists() and shutil.which('aa-exec'):
            prefix=['aa-exec','-p','clover-spike-bwrap','--']+prefix
    else:
        settings={'filesystem':{'allowWrite':[str(work)],'denyRead':[str(control)],'denyWrite':[str(control)]},'network':{'allowedDomains':[],'deniedDomains':[]}}
        bwrap=Path('/usr/local/libexec/clover-spike-bwrap')
        if bwrap.exists():settings['bwrapPath']=str(bwrap)
        file=config/'settings.json';file.write_text(json.dumps(settings));prefix=['node',str(cli),'--settings',str(file),'--']
    env={'HOME':str(root),'PATH':os.environ['PATH'],'CODEX_HOME':str(config),'TMPDIR':str(root),'DO_NOT_TRACK':'1'}
    tests=['allowed-write','secret-read','key-read','run-read','alias-read','link-create','settings-write','policy-write','nested-retry']
    if sys.platform=='linux':tests.append('nested-userns')
    failed=False
    for test in tests:
        r=subprocess.run(prefix+[sys.executable,str(worker),test,str(work),str(control),str(config)],env=env,cwd=work,
            capture_output=True,text=True,timeout=30)
        host_ok=(control/'settings').read_text()=='public fixture' and not (config/'attack').exists() and not (work/'new-hardlink').exists()
        passed=r.returncode==0 and host_ok
        print(json.dumps({'backend':args.backend,'test':test,'pass':passed,'exit':r.returncode,'host_unchanged':host_ok,
            'diagnostic':r.stderr.replace(str(root),'<isolated-home>')[:350]}),flush=True)
        failed |= not passed
    raise SystemExit(int(failed))
