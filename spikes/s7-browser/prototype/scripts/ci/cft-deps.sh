#!/bin/bash
# What a bare Ubuntu server lacks for a browser binary (Chrome for Testing, or Electron): list the missing shared
# libraries in a clean ubuntu:24.04 container, install the packages we think provide them, list again, and start the
# binary once. CI only (docker).
#   scripts/ci/cft-deps.sh <dir with the unpacked browser> <binary path inside it> <out file> [extra packages]
set -u
dir="$(realpath "$1")"; rel="$2"; out="$3"; extra="${4:-}"
# ubuntu:24.04 as it was on November 5, 2026 (round eight: pinned, so a later image can't change the answer)
image="ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852"
pkgs="libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libatspi2.0-0t64 libdbus-1-3 libexpat1 libgbm1 libglib2.0-0t64 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libxext6 libx11-6 libxcb1 libasound2t64 fonts-liberation ca-certificates $extra"
docker run --rm -v "$dir:/b:ro" "$image" bash -c "
  echo '== missing on a bare $image'; ldd '/b/$rel' | grep 'not found' | sort -u
  apt-get update -qq >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends $pkgs >/dev/null 2>&1
  echo '== missing after installing: $pkgs'; ldd '/b/$rel' | grep 'not found' | sort -u; echo '(end)'
  echo '== packages installed for them'; dpkg-query -W -f='\${binary:Package}\n' | wc -l
  echo '== a start (as root in a container: --no-sandbox)'
  timeout 30 '/b/$rel' --headless --no-sandbox --disable-gpu --dump-dom 'data:text/html,<p>ok</p>' 2>&1 | tail -n 5
" > "$out" 2>&1
cat "$out"
