#!/usr/bin/env python3
"""Codex's sandbox-only entry point: temp configuration, no agent or model."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

with tempfile.TemporaryDirectory(prefix='clover-codex-') as tmp:
    root = Path(tmp).resolve()
    config = root / 'config'
    config.mkdir()
    hidden = root / 'hidden'
    hidden.mkdir()
    (hidden / 'public-sentinel').write_text('public fixture, not a secret')
    allowed = root / 'allowed'
    allowed.mkdir()
    (config / 'config.toml').write_text(
        '[permissions.clover.filesystem]\n' +
        '":root" = "read"\n' + json.dumps(str(allowed)) + ' = "write"\n' +
        json.dumps(str(hidden)) + ' = "deny"\n' +
        '[permissions.clover.network]\nenabled = false\n')
    env = {'PATH': os.environ['PATH'], 'HOME': str(root), 'CODEX_HOME': str(config), 'TMPDIR': str(root)}
    print('Running sandbox-only Codex checks', flush=True)
    command = ['codex', 'sandbox', '-C', str(allowed), '-P', 'clover', '--', '/bin/sh', '-c',
        'test -r /etc/hosts && ! cat "$1/public-sentinel" >/dev/null 2>&1 && '
        'touch "$2/ok" && ! touch "$1/blocked" 2>/dev/null', 'probe', str(hidden), str(allowed)]
    if Path('/usr/local/libexec/clover-spike-bwrap').exists() and shutil.which('aa-exec'):
        command=['aa-exec','-p','clover-spike-bwrap','--']+command
    result = subprocess.run(command, env=env, cwd=allowed, capture_output=True, text=True, timeout=30)
    print(json.dumps({'test': 'codex-own-sandbox', 'exit': result.returncode,
        'allowed_write_observed': (allowed / 'ok').exists(),
        'hidden_write_observed': (hidden / 'blocked').exists(),
        'diagnostic': result.stderr[:1600]}))
    raise SystemExit(result.returncode)
