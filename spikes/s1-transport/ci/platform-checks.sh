#!/usr/bin/env bash
# S1 question 2 on one OS: iroh (napi), WebRTC (node-datachannel) and the link sidecar under Bun,
# and the same checks compiled with `bun build --compile`; native quinn and iroh for reference.
#
#   spikes/s1-transport/ci/platform-checks.sh [results.jsonl]
#
# Run from the repo root after `cargo build --release --manifest-path native/link-sidecar/Cargo.toml`
# and `bun install --frozen-lockfile` in spikes/s1-transport/bun. Each check prints one
# `S1RESULT <json>` line; this script collects them. It exits non-zero if a required check fails.
#
# Outside CI two groups are off unless asked for, because they reach past the process:
#   S1_SKIP_BROWSER=0    the browser checks start Chrome, Firefox or Safari
#   S1_SKIP_IROH_NAPI=0  n0's napi binding keeps iroh's port mapper on (it has no switch), whose
#                        UPnP/NAT-PMP/PCP probing can raise a firewall prompt on macOS

set -uo pipefail
if [ -z "${CI:-}" ]; then
  : "${S1_SKIP_BROWSER:=1}"
  : "${S1_SKIP_IROH_NAPI:=1}"
fi
S1_SKIP_BROWSER="${S1_SKIP_BROWSER:-0}"
S1_SKIP_IROH_NAPI="${S1_SKIP_IROH_NAPI:-0}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SPIKE="$ROOT/spikes/s1-transport/bun"
EXE=""
case "$(uname -s)" in MINGW* | MSYS* | CYGWIN*) EXE=".exe" ;; esac
SIDECAR="${S1_SIDECAR:-$ROOT/native/link-sidecar/target/release/clover-link-sidecar$EXE}"
OUT="${1:-$ROOT/spikes/s1-transport/results/local.jsonl}"
mkdir -p "$(dirname "$OUT")"
: >"$OUT"
FAILED=()

# run <required|optional> <name> <command...>
run() {
  local need="$1" name="$2"
  shift 2
  echo "::group::$name"
  echo "+ $*"
  local log
  log="$(mktemp)"
  (cd "$SPIKE" && "$@") >"$log" 2>&1
  local code=$?
  cat "$log"
  local lines
  lines="$(grep '^S1RESULT ' "$log" | sed 's/^S1RESULT //')"
  if [ -n "$lines" ]; then
    printf '%s\n' "$lines" >>"$OUT"
  else
    printf '{"check":"%s","ok":false,"error":"no result line, exit %s"}\n' "$name" "$code" >>"$OUT"
  fi
  if [ "$code" -ne 0 ] || [ -z "$lines" ] || echo "$lines" | grep -q '"ok":false'; then
    if [ "$need" = required ]; then FAILED+=("$name"); fi
    echo "::warning title=$name::failed (exit $code)"
  fi
  rm -f "$log"
  echo "::endgroup::"
}

echo "bun $(bun --version), node $(node --version 2>/dev/null || echo none), $(uname -sm)"

# Under Bun, from source.
if [ "$S1_SKIP_IROH_NAPI" = 1 ]; then
  echo "S1_SKIP_IROH_NAPI=1; skipping n0's napi binding (its port mapper can't be turned off)"
else
  run required iroh-napi bun src/iroh-napi.ts
  run required iroh-napi-yield bun src/iroh-napi.ts --yield-every 1 --rpc 200 --rpc-streams 50 --shots 5
fi
run required webrtc-dc bun src/webrtc-dc.ts
run required sidecar-ipc bun src/sidecar-ipc.ts --sidecar "$SIDECAR"

# The same napi binding under Node, for comparison (Bun's event loop starves timers; Node's doesn't).
if command -v node >/dev/null && [ "$S1_SKIP_IROH_NAPI" != 1 ]; then
  run optional iroh-napi-node node src/iroh-napi.ts --rpc 500 --rpc-streams 100 --bulk-mb 32 --shots 5 --load-mb 16
fi

# What byte passing costs across napi: Vec<u8> (as @number0/iroh does) against Buffer.
PROBE_DIR="$ROOT/spikes/s1-transport/napi-probe"
if cargo build --release --quiet --manifest-path "$PROBE_DIR/Cargo.toml"; then
  for lib in libs1_napi_probe.dylib libs1_napi_probe.so s1_napi_probe.dll; do
    [ -f "$PROBE_DIR/target/release/$lib" ] && cp "$PROBE_DIR/target/release/$lib" "$PROBE_DIR/s1-napi-probe.node"
  done
  run optional napi-probe bun src/napi-probe.ts --mb 32
  if command -v node >/dev/null; then run optional napi-probe-node node src/napi-probe.ts --mb 16; fi
else
  echo "::warning title=napi-probe::the probe addon did not build"
fi

# Compiled with `bun build --compile`, then run from a folder outside the source tree.
run required compile bun scripts/compile.ts
BIN_DIR="$(mktemp -d)"
cp "$SPIKE"/out/* "$BIN_DIR"/
# bun build --compile leaves a copy of the Bun executable per binary in the working directory.
rm -f "$SPIKE"/.*.bun-build
if [ "$S1_SKIP_IROH_NAPI" != 1 ]; then run required iroh-napi-compiled "$BIN_DIR/iroh-napi$EXE" --quick; fi
run required webrtc-dc-compiled "$BIN_DIR/webrtc-dc$EXE" --quick
run required sidecar-ipc-compiled "$BIN_DIR/sidecar-ipc$EXE" --sidecar "$SIDECAR"

# The iOS app's iroh (iroh-ffi 1.1.0, iroh 1.0.2) against ours (iroh 1.4.1), both directions.
if [ "$S1_SKIP_IROH_NAPI" != 1 ] && [ -d "$ROOT/spikes/s1-transport/interop/node_modules/@number0/iroh" ]; then
  run optional iroh-ffi-interop bun ../interop/interop.ts --sidecar "$SIDECAR"
fi

# Native QUIC in one process over loopback, for reference.
run required native-quinn "$SIDECAR" local-bench --transport quinn
run required native-iroh "$SIDECAR" local-bench --transport iroh
run optional native-quinn-bbr "$SIDECAR" local-bench --transport quinn --cc bbr --rpc 200 --rpc-streams 50 --shots 5
run optional native-iroh-bbr "$SIDECAR" local-bench --transport iroh --cc bbr --rpc 200 --rpc-streams 50 --shots 5

# A browser to the Bun side (question 5). Chrome is required where the runner has it. Each
# browser runs with its mDNS hiding of host addresses turned off ("reveal", the lab's setting
# so far) and left on ("hide", as a real page runs); Safari, on macOS, has no switch.
if [ "$S1_SKIP_BROWSER" = 1 ]; then
  echo "S1_SKIP_BROWSER=1; skipping the browser checks"
elif [ "$(uname -m)" = aarch64 ] && [ "$(uname -s)" = Linux ]; then
  echo "no Chrome build for Linux arm64; skipping the browser checks"
else
  run required webrtc-chrome bun src/webrtc-browser.ts --browser chrome
  run optional webrtc-chrome-compiled "$BIN_DIR/webrtc-browser$EXE" --browser chrome
  run optional webrtc-chrome-mdns bun src/webrtc-browser.ts --browser chrome --mdns hide
  run optional webrtc-firefox bun src/webrtc-browser.ts --browser firefox
  run optional webrtc-firefox-mdns bun src/webrtc-browser.ts --browser firefox --mdns hide
  if [ "$(uname -s)" = Darwin ]; then
    run optional webrtc-safari bun src/webrtc-browser.ts --browser safari
  fi
fi

echo "results in $OUT"
if [ "${#FAILED[@]}" -gt 0 ]; then
  echo "required checks failed: ${FAILED[*]}"
  exit 1
fi
