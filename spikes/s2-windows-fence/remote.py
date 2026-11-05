#!/usr/bin/env python3
"""Send a lane-owned script over the authorized SSH transport (no scp)."""
import argparse
import base64
import json
import gzip
from pathlib import Path
import shlex
import subprocess
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('os', choices=['windows', 'linux'])
parser.add_argument('script', type=Path)
parser.add_argument('script_args', nargs='*')
args = parser.parse_args()
data = base64.b64encode(args.script.read_bytes()).decode()
if args.os == 'windows':
    files={'probe.ps1':args.script.read_text()}
    if args.script.name=='scheduled-store.ps1': files['windows-store.ps1']=args.script.with_name('windows-store.ps1').read_text()
    if 'windows-probe.cs' in files['probe.ps1']:
        files['windows-probe.cs']=(Path(__file__).resolve().parents[2] / 'native/sandbox/windows-probe.cs').read_text()
    if 'session0-bno.cs' in files['probe.ps1']:
        files['session0-bno.cs']=(Path(__file__).resolve().parents[2] / 'native/sandbox/session0-bno.cs').read_text()
    if 'handle-probe.cs' in files['probe.ps1']:
        files['handle-probe.cs']=(Path(__file__).resolve().parents[2] / 'native/sandbox/handle-probe.cs').read_text()
    files.update({p.name:p.read_text() for p in args.script.parent.glob('*.mjs')})
    compressed = base64.b64encode(gzip.compress(json.dumps(files).encode())).decode()
    payload = None
    chunkfile='clover-transport-'+uuid.uuid4().hex+'.b64'
    for i in range(0,len(compressed),3500):
        chunk=compressed[i:i+3500]
        transfer="[IO.File]::AppendAllText((Join-Path $env:TEMP '"+chunkfile+"'),'"+chunk+"')"
        print('Uploading public source chunk '+str(i//3500+1),flush=True)
        r=subprocess.run(['gcloud','compute','ssh','clover-c-win','--zone=europe-west1-b','--quiet',
            '--command=powershell -NoProfile -NonInteractive -Command "'+transfer+'"'],timeout=60)
        if r.returncode: raise SystemExit(r.returncode)
    program = ("$ErrorActionPreference='Stop'; $global:ProgressPreference='SilentlyContinue'; "
        "$transport=Join-Path $env:TEMP '"+chunkfile+"'; "
        "$bytes=[Convert]::FromBase64String([IO.File]::ReadAllText($transport)); Remove-Item $transport -Force; "
        "$stream=New-Object IO.MemoryStream(,$bytes); "
        "$gzip=New-Object IO.Compression.GzipStream($stream,[IO.Compression.CompressionMode]::Decompress); "
        "$reader=New-Object IO.StreamReader($gzip); $payload=$reader.ReadToEnd() | ConvertFrom-Json; "
        "$p=Join-Path $env:TEMP ('clover-lane-c-'+[Guid]::NewGuid().ToString('N')); "
        "New-Item -ItemType Directory -Force $p | Out-Null; "
        "$f=Join-Path $p 'probe.ps1'; "
        "foreach($entry in $payload.PSObject.Properties) { [IO.File]::WriteAllText((Join-Path $p $entry.Name),[string]$entry.Value) }; "
        "try { & $f } finally { Remove-Item -Recurse -Force $p }")
    command = 'powershell -NoProfile -NonInteractive -OutputFormat Text -Command "' + program + '"'
    if len(command) > 8000:
        raise SystemExit('Compressed Windows command exceeds cmd.exe transport limit')
else:
    bundle = {p.name: base64.b64encode(p.read_bytes()).decode() for p in args.script.parent.glob('*.py')}
    bundle[args.script.name] = data
    payload = json.dumps(bundle)
    bootstrap = ("import base64,json,pathlib,subprocess,sys,tempfile; "
        "data=json.load(sys.stdin); "
        "scope=tempfile.TemporaryDirectory(prefix='clover-lane-c-'); "
        "root=pathlib.Path(scope.name); "
        "[(root/name).write_bytes(base64.b64decode(value)) for name,value in data.items()]; "
        "result=subprocess.run([" + repr('/usr/bin/python3' if args.script.suffix == '.py' else 'bash') + ",str(root/" + repr(args.script.name) + ")] + " + repr(args.script_args) + ",cwd=root); "
        "scope.cleanup(); sys.exit(result.returncode)")
    command = 'python3 -c ' + shlex.quote(bootstrap)
vm = 'clover-c-win' if args.os == 'windows' else 'clover-c-linux'
print('Running ' + args.script.name + ' on ' + vm, flush=True)
try:
    result = subprocess.run(['gcloud', 'compute', 'ssh', vm, '--zone=europe-west1-b', '--quiet', '--command=' + command], input=payload, text=True, timeout=420)
except subprocess.TimeoutExpired:
    print('Remote probe exceeded 420 seconds; no verdict collected', flush=True)
    raise SystemExit(124)
raise SystemExit(result.returncode)
