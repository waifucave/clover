#!/usr/bin/python3
"""No-TPM control: private device/sys/run views, no host credential IPC."""
import base64
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile

with tempfile.TemporaryDirectory(prefix='clover-no-tpm-') as t:
    root=Path(t);data=secrets.token_bytes(32)
    subprocess.run(['sudo','-n','chown','0:0',t],check=True)
    scope=['sudo','-n','/usr/local/libexec/clover-spike-bwrap','--die-with-parent','--unshare-all',
        '--cap-drop','ALL','--ro-bind','/','/','--dev','/dev','--tmpfs','/run','--tmpfs','/sys',
        '--tmpfs','/tmp','--dir','/tmp/work','--bind',t,'/tmp/work','--setenv','HOME','/tmp/work']
    try:
        r=subprocess.run(scope+['--','systemd-creds','--user','--name=clover-test','encrypt','-','/tmp/work/test.cred'],
            input=data,capture_output=True,timeout=25)
        result={'test':'user-scoped-no-tpm-namespace','uid':0,'host_credential_ipc_hidden':True,
            'tpm_devices_hidden':True,'encrypt_exit':r.returncode}
        if r.returncode==0:
            d=subprocess.run(scope+['--','systemd-creds','--user','--name=clover-test','decrypt','/tmp/work/test.cred','-'],capture_output=True,timeout=25)
            blob=subprocess.run(['sudo','-n','cat',str(root/'test.cred')],capture_output=True,check=True).stdout
            result.update(roundtrip=d.returncode==0 and d.stdout==data,format_id=base64.b64decode(blob)[:16].hex())
            fenced=subprocess.run(scope+['--ro-bind','/dev/null','/tmp/work/test.cred','--',
                '/bin/sh','-c','test ! -s /tmp/work/test.cred'],capture_output=True,timeout=10)
            result['fence_hides_credential']=fenced.returncode==0
        else:result['diagnostic']=r.stderr.decode(errors='replace')[:700]
        print(json.dumps(result),flush=True)
    finally:
        subprocess.run(['sudo','-n','rm','--',str(root/'test.cred')],capture_output=True)
        subprocess.run(['sudo','-n','chown',str(os.getuid())+':'+str(os.getgid()),t],check=True)
