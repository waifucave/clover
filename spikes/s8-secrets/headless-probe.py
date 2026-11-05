#!/usr/bin/python3
"""Authorized generated test keys only; isolated owner-only fallback and sealing."""
import json
import base64
import os
from pathlib import Path
import secrets
import stat
import subprocess
import tempfile
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

with tempfile.TemporaryDirectory(prefix='clover-headless-') as temp:
    root = Path(temp)
    os.chmod(root, 0o700)
    env = dict(os.environ, HOME=temp, XDG_CONFIG_HOME=temp+'/config', XDG_DATA_HOME=temp+'/data')
    data = secrets.token_bytes(32)
    print(json.dumps({'test':'tpm-inventory','tpm0':Path('/dev/tpm0').exists(),
        'tpmrm0':Path('/dev/tpmrm0').exists()}), flush=True)
    files=[]
    for mode, extra in [('tpm2',[]), ('host+tpm2',[]), ('auto',[]), ('tpm-unavailable',['--tpm2-device=/dev/clover-no-tpm']), ('host+tpm2-unavailable',['--tpm2-device=/dev/clover-no-tpm']), ('host',[])]:
        name = root / (mode+'.cred')
        key = 'host+tpm2' if mode=='host+tpm2-unavailable' else 'tpm2' if mode.startswith('tpm') else mode
        args=['systemd-creds','--user','--name=clover-test','--with-key='+key]+extra+['encrypt','-',str(name)]
        r=subprocess.run(args, input=data, env=env, capture_output=True, timeout=20)
        result={'test':'systemd-creds-'+mode,'encrypt_exit':r.returncode}
        if r.returncode==0:
            d=subprocess.run(['systemd-creds','--user','--name=clover-test','decrypt',str(name),'-'],
                env=env, capture_output=True, timeout=20)
            result.update(decrypt_exit=d.returncode,roundtrip=d.returncode==0 and d.stdout==data)
            result['format_id']=base64.b64decode(name.read_bytes())[:16].hex()
            files.append(name)
        else:
            # Diagnostics contain only fixed paths/errors, never input bytes.
            result['diagnostic']=r.stderr.decode(errors='replace')[:600]
        print(json.dumps(result),flush=True)
    # Hardware control: user-scoped mode can choose a different wrapping mechanism;
    # prove that an actual TPM-backed system credential works, then reject a missing device.
    for label,device in [('actual','/dev/tpmrm0'),('unavailable','/dev/clover-no-tpm')]:
        target=root/('system-tpm-'+label+'.cred')
        r=subprocess.run(['sudo','-n','systemd-creds','--name=clover-test','--with-key=tpm2',
            '--tpm2-device='+device,'encrypt','-',str(target)],input=data,capture_output=True,timeout=25)
        value={'test':'system-scope-tpm-control-'+label,'encrypt_exit':r.returncode}
        if r.returncode==0:
            d=subprocess.run(['sudo','-n','systemd-creds','--name=clover-test','decrypt',str(target),'-'],capture_output=True,timeout=25)
            value['roundtrip']=d.returncode==0 and d.stdout==data
        else:value['diagnostic']=r.stderr.decode(errors='replace')[:350]
        print(json.dumps(value),flush=True)
        if target.exists():subprocess.run(['sudo','-n','rm',str(target)],check=True)
    keyfile=root/'plaintext.key'
    fd=os.open(keyfile,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    with os.fdopen(fd,'wb') as f: f.write(data)
    nonce=secrets.token_bytes(12)
    plaintext=secrets.token_bytes(64)
    encrypted=root/'secrets.enc'
    encrypted.write_bytes(nonce+AESGCM(data).encrypt(nonce,plaintext,b'clover.test'))
    os.chmod(encrypted,0o600)
    assert AESGCM(keyfile.read_bytes()).decrypt(nonce,encrypted.read_bytes()[12:],b'clover.test')==plaintext
    files.extend([keyfile,encrypted])
    bwrap='/usr/local/libexec/clover-spike-bwrap'
    if not Path(bwrap).exists(): bwrap='bwrap'
    args=[bwrap,'--die-with-parent','--unshare-all','--cap-drop','ALL','--ro-bind','/','/',
        '--tmpfs','/tmp','--tmpfs','/run','--proc','/proc','--dev','/dev',
        '--dir','/tmp/store','--ro-bind',str(root),'/tmp/store']
    for p in files: args += ['--ro-bind','/dev/null','/tmp/store/'+p.name]
    command=' && '.join('test ! -s /tmp/store/'+p.name for p in files)
    fenced=subprocess.run(args+['--','/bin/sh','-c',command],capture_output=True,timeout=10)
    print(json.dumps({'test':'plaintext-fallback','mode':oct(stat.S_IMODE(keyfile.stat().st_mode)),
        'roundtrip':True,'label':'plaintext','fence_masks_all_store_files':fenced.returncode==0,
        'masked_file_count':len(files),'fence_exit':fenced.returncode}),flush=True)
    assert fenced.returncode==0
