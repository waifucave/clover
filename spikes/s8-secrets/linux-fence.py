#!/usr/bin/python3
"""Bubblewrap filesystem/network/IPC probes against public fixtures only."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

with tempfile.TemporaryDirectory(prefix='clover-bwrap-') as tmp:
    root = Path(tmp)
    work = root / 'work'
    work.mkdir()
    clover = root / 'clover'
    clover.mkdir()
    (clover / 'run').mkdir()
    (clover / 'run' / 'public-marker').write_text('public run marker')
    (clover / 'secrets.enc').write_text('public placeholder, not encrypted data or a secret')
    (clover / 'settings.json').write_text('{}')
    bwrap='/usr/local/libexec/clover-spike-bwrap'
    if not Path(bwrap).exists(): bwrap='bwrap'
    common = [bwrap, '--die-with-parent', '--new-session', '--unshare-all',
        '--cap-drop', 'ALL', '--ro-bind', '/', '/', '--tmpfs', '/tmp', '--tmpfs', '/run',
        '--tmpfs', '/home', '--proc', '/proc', '--dev', '/dev',
        '--dir', '/tmp/work', '--dir', '/tmp/clover',
        '--bind', str(work), '/tmp/work', '--ro-bind', str(clover), '/tmp/clover',
        '--tmpfs', '/tmp/clover/run', '--ro-bind', '/dev/null', '/tmp/clover/secrets.enc',
        '--chdir', '/tmp/work', '--clearenv', '--setenv', 'HOME', '/tmp/work',
        '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'DBUS_SESSION_BUS_ADDRESS', 'unix:path=/run/user/0/bus']
    checks = {
        'allowed-write': 'touch /work/ok',
        'ordinary-read': 'test -r /etc/hosts',
        'settings-write-denied': '! touch /clover/settings.json 2>/dev/null',
        'run-host-content-hidden': 'test ! -e /clover/run/public-marker',
        'secrets-host-content-hidden': 'test ! -s /clover/secrets.enc',
        'ancestor-rename-denied': '! mv /clover /moved 2>/dev/null',
        'host-session-bus-hidden': 'test ! -S /run/user/1000/bus',
        'systemd-run-denied': '! systemd-run --user --wait --quiet /bin/true 2>/dev/null',
        'network-denied': "python3 -c 'import socket,sys; s=socket.socket(); s.settimeout(1); sys.exit(0 if s.connect_ex((\"169.254.169.254\",80)) != 0 else 1)'",
        'pipeline-subshell': 'test "$(printf abc | wc -c)" = 3 && (true)',
        'git': 'git init -q repo && git -C repo status --porcelain',
        'build': 'printf "int main(void){return 0;}" > main.c && cc main.c -o main && ./main',
    }
    print('Running isolated bubblewrap probes', flush=True)
    for name, command in checks.items():
        start = time.monotonic()
        command = command.replace('/work', '/tmp/work').replace('/clover', '/tmp/clover')
        r = subprocess.run(common + ['--', '/bin/bash', '--noprofile', '--norc', '-c', command],
            capture_output=True, timeout=10)
        print(json.dumps({'test': name, 'exit': r.returncode,
            'elapsed_ms': round((time.monotonic()-start)*1000, 2), 'diagnostic': r.stderr.decode()[:300]}), flush=True)
        if r.returncode:
            raise SystemExit(r.returncode)
