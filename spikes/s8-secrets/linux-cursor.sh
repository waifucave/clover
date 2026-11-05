#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
printf 'Downloading pinned headless Cursor CLI into the disposable probe directory\n'
mkdir cursor
curl -fsSL https://downloads.cursor.com/lab/2026.10.22-27dcf5f/linux/x64/agent-cli-package.tar.gz | tar --strip-components=1 -xz -C cursor
export PATH="$PWD/cursor:$PATH"
python3 cursor-probe.py
