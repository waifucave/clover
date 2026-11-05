#!/usr/bin/env python3
"""Exercise Anthropic's standalone runtime, never the claude executable."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

cli = Path(__file__).resolve().parent / '.deps/node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js'
with tempfile.TemporaryDirectory(prefix='clover-srt-') as tmp:
    root = Path(tmp).resolve()
    hidden = root / 'hidden'
    hidden.mkdir()
    (hidden / 'public-sentinel').write_text('public fixture, not a secret')
    allowed = root / 'allowed'
    allowed.mkdir()
    settings = root / 'settings.json'
    settings.write_text(json.dumps({'filesystem': {'denyRead': [str(hidden)],
        'allowWrite': [str(allowed)], 'denyWrite': [str(hidden)]},
        'network': {'allowedDomains': [], 'deniedDomains': []}}))
    env = {'PATH': os.environ['PATH'], 'HOME': str(root), 'TMPDIR': str(root),
        'XDG_CONFIG_HOME': str(root / 'config'), 'XDG_CACHE_HOME': str(root / 'cache')}
    print('Running standalone Anthropic sandbox checks', flush=True)
    command = ['node', str(cli), '--settings', str(settings), '--', '/bin/sh', '-c',
        'test -r /etc/hosts && ! cat "$1/public-sentinel" >/dev/null 2>&1 && '
        'touch "$2/ok" && ! touch "$1/blocked" 2>/dev/null', 'probe', str(hidden), str(allowed)]
    result = subprocess.run(command, env=env, cwd=allowed, capture_output=True, text=True, timeout=45)
    print(json.dumps({'test': 'anthropic-standalone-sandbox', 'exit': result.returncode,
        'allowed_write_observed': (allowed / 'ok').exists(),
        'hidden_write_observed': (hidden / 'blocked').exists(),
        'diagnostic': result.stderr[:1600]}))
    raise SystemExit(result.returncode)
