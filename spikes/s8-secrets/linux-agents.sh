#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
printf 'Installing pinned sandbox-only agent tools in the disposable probe directory\n'
npm install --prefix .deps --cache .cache --no-audit --no-fund --ignore-scripts @anthropic-ai/sandbox-runtime@0.0.81 @openai/codex@0.166.0 >/dev/null
export PATH="$PWD/.deps/node_modules/.bin:$PATH"
set +e
python3 srt-probe.py
srt_exit=$?
python3 codex-probe.py
codex_exit=$?
python3 agent-floor-gates.py srt
srt_gates=$?
python3 agent-floor-gates.py codex
codex_gates=$?
printf 'srt_exit=%s codex_exit=%s\n' "$srt_exit" "$codex_exit"
test "$srt_exit" -eq 0 && test "$codex_exit" -eq 0 && test "$srt_gates" -eq 0 && test "$codex_gates" -eq 0
