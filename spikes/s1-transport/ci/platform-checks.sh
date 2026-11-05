#!/usr/bin/env bash
# S1 question 2 on one OS: iroh (napi), WebRTC (node-datachannel) and the link sidecar under Bun,
# and the same checks compiled with `bun build --compile`; native quinn and iroh for reference.
#
#   spikes/s1-transport/ci/platform-checks.sh [results.jsonl]
#
# Run from the repo root after `cargo build --release --manifest-path native/link-sidecar/Cargo.toml`
# and `bun install --frozen-lockfile` in spikes/s1-transport/bun. Each check prints one
# `S1RESULT <json>` line; this script collects them. It exits non-zero if a required check fails.

set -uo pipefail
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
run required iroh-napi bun src/iroh-napi.ts
run required iroh-napi-yield bun src/iroh-napi.ts --yield-every 1 --rpc 200 --rpc-streams 50 --shots 5
run required webrtc-dc bun src/webrtc-dc.ts
run required sidecar-ipc bun src/sidecar-ipc.ts --sidecar "$SIDECAR"

# The same napi binding under Node, for comparison (Bun's event loop starves timers; Node's doesn't).
if command -v node >/dev/null; then
  run optional iroh-napi-node node src/iroh-napi.ts --rpc 500 --rpc-streams 100 --bulk-mb 32 --shots 5 --load-mb 16
fi

# Compiled with `bun build --compile`, then run from a folder outside the source tree.
run required compile bun scripts/compile.ts
BIN_DIR="$(mktemp -d)"
cp "$SPIKE"/out/* "$BIN_DIR"/
run required iroh-napi-compiled "$BIN_DIR/iroh-napi$EXE" --quick
run required webrtc-dc-compiled "$BIN_DIR/webrtc-dc$EXE" --quick
run required sidecar-ipc-compiled "$BIN_DIR/sidecar-ipc$EXE" --sidecar "$SIDECAR"

# Native QUIC in one process over loopback, for reference.
run required native-quinn "$SIDECAR" local-bench --transport quinn
run required native-iroh "$SIDECAR" local-bench --transport iroh
run optional native-quinn-bbr "$SIDECAR" local-bench --transport quinn --cc bbr --rpc 200 --rpc-streams 50 --shots 5
run optional native-iroh-bbr "$SIDECAR" local-bench --transport iroh --cc bbr --rpc 200 --rpc-streams 50 --shots 5

# A browser to the Bun side (question 5), headless. Chrome is required where the runner has it.
if [ "${S1_SKIP_BROWSER:-0}" = 1 ]; then
  echo "S1_SKIP_BROWSER=1; skipping the browser check"
elif [ "$(uname -m)" = aarch64 ] && [ "$(uname -s)" = Linux ]; then
  echo "no Chrome build for Linux arm64; skipping the browser check"
else
  run required webrtc-chrome bun src/webrtc-browser.ts --browser chrome
  run optional webrtc-chrome-compiled "$BIN_DIR/webrtc-browser$EXE" --browser chrome
  run optional webrtc-firefox bun src/webrtc-browser.ts --browser firefox
fi

echo "results in $OUT"
if [ "${#FAILED[@]}" -gt 0 ]; then
  echo "required checks failed: ${FAILED[*]}"
  exit 1
fi
