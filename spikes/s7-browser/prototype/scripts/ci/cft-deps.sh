#!/bin/bash
# What a bare Ubuntu server lacks for Chrome for Testing: list the missing shared libraries in a clean ubuntu:24.04
# container, install the packages we think provide them, list again, and start the browser once. CI only (docker).
#   scripts/ci/cft-deps.sh <dir with the unpacked browser> <binary path inside it> <out file>
set -u
dir="$(realpath "$1")"; rel="$2"; out="$3"
pkgs="libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2t64 libdbus-1-3 libexpat1 libxcb1 libx11-6 libxext6 libglib2.0-0t64 libudev1 fonts-liberation ca-certificates"
docker run --rm -v "$dir:/b:ro" ubuntu:24.04 bash -c "
  echo '== missing on a bare ubuntu:24.04'; ldd '/b/$rel' | grep 'not found' | sort -u
  apt-get update -qq >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends $pkgs >/dev/null 2>&1
  echo '== missing after installing: $pkgs'; ldd '/b/$rel' | grep 'not found' | sort -u; echo '(end)'
  echo '== a start (as root in a container: --no-sandbox)'
  timeout 30 '/b/$rel' --headless --no-sandbox --disable-gpu --dump-dom 'data:text/html,<p>ok</p>' 2>&1 | tail -n 5
" > "$out" 2>&1
cat "$out"
