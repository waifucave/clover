#!/bin/bash
# Start a headless Weston (a Wayland compositor with no screen) and run a command against it, then stop it.
# CI only.   scripts/ci/weston.sh <command…>
set -u
export XDG_RUNTIME_DIR="$(mktemp -d)"
chmod 700 "$XDG_RUNTIME_DIR"
log="${RUNNER_TEMP:-/tmp}/weston.log"
weston --version || true
pid=""
for args in "--backend=headless --renderer=pixman" "--backend=headless" "--backend=headless-backend.so"; do
  # shellcheck disable=SC2086
  weston $args --socket=wayland-s7 --width=1920 --height=1080 --idle-time=0 >"$log" 2>&1 &
  pid=$!
  for _ in $(seq 1 30); do [ -S "$XDG_RUNTIME_DIR/wayland-s7" ] && break; sleep 0.5; done
  if [ -S "$XDG_RUNTIME_DIR/wayland-s7" ]; then echo "weston up: $args (pid $pid)"; break; fi
  echo "weston did not start with: $args"; cat "$log"; kill "$pid" 2>/dev/null; pid=""
done
[ -n "$pid" ] || exit 1
export WAYLAND_DISPLAY=wayland-s7
unset DISPLAY
export XDG_SESSION_TYPE=wayland
"$@"
code=$?
kill "$pid" 2>/dev/null
echo "--- weston log (tail)"; tail -n 40 "$log"
exit $code
