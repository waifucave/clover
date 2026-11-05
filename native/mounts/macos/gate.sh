#!/usr/bin/env bash
# Live gate 2, the macOS part of spike S6: the clovertree FSKit module, for real.
#
# The owner runs this himself, at his Mac, in a terminal. An agent never runs it: it signs with
# the owner's team (Xcode may ask for his login password or Keychain access), and it needs one click
# in System Settings to turn the module on. Everything it writes stays under ~/.clover-dev/s6-gate
# and ~/Applications/CloverTree.app; it never touches Winter or ~/.winter*.
#
#   CLOVER_TEAM_ID=<your team id> native/mounts/macos/gate.sh [--keep]
#
# It answers what CI cannot (CI stops at "Module ... is disabled!"):
#   1. does the module mount, read and write on this Mac's macOS;
#   2. does this macOS still have FSKit's short-read bug (coherence with the guard off);
#   3. speed against local disk at 0/20/80 ms, and the fail-fast scenarios, on FSKit.
set -euo pipefail
[ -t 0 ] && [ -t 1 ] || { echo "gate.sh is for a person at a terminal, not for scripts or agents" >&2; exit 2; }
: "${CLOVER_TEAM_ID:?set CLOVER_TEAM_ID to the Apple Developer team that has the FSKit Module capability}"
keep=0; [ "${1:-}" = "--keep" ] && keep=1

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
s6="$repo/spikes/s6-mounts"
gate="$HOME/.clover-dev/s6-gate"
dd="$gate/DerivedData"
app="$HOME/Applications/CloverTree.app"
id="com.waifucave.clover.tree.dev.fs"
results="$gate/results/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$gate" "$results"
step() { printf '\n== %s\n' "$*"; }

step "1/8 build, signed by team $CLOVER_TEAM_ID (Xcode may ask you for access)"
command -v xcodegen >/dev/null || { echo "brew install xcodegen first"; exit 1; }
( cd "$here" && xcodegen generate >/dev/null )
xcodebuild -project "$here/CloverTree.xcodeproj" -scheme CloverTree -configuration Release \
  -destination 'platform=macOS,arch=arm64' -derivedDataPath "$dd" -allowProvisioningUpdates \
  CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM="$CLOVER_TEAM_ID" CODE_SIGNING_ALLOWED=YES CODE_SIGNING_REQUIRED=YES CODE_SIGN_IDENTITY="Apple Development" \
  build > "$results/xcodebuild.log" 2>&1 || { tail -30 "$results/xcodebuild.log"; exit 1; }
codesign -dv --entitlements - "$dd/Build/Products/Release/CloverTree.app/Contents/Extensions/CloverTreeFS.appex" 2>&1 | tee "$results/codesign.txt" | grep -E "Authority|TeamIdentifier|fskit"

step "2/8 install to ~/Applications and register"
rm -rf "$app"
ditto "$dd/Build/Products/Release/CloverTree.app" "$app"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f -R -trusted "$app"
sleep 2
pluginkit -m -v -i "$id" | tee "$results/pluginkit.txt"

step "3/8 turn it on: System Settings > General > Login Items & Extensions > File System Extensions > CloverTree"
enabled() { plutil -p "$HOME/Library/Group Containers/group.com.apple.fskit.settings/enabledModules.plist" 2>/dev/null | grep -q "$id"; }
if ! enabled; then
  open "x-apple.systempreferences:com.apple.LoginItems-Settings.extension" || true
  read -r -p "Turn on CloverTree there, then press Enter here. " _
fi
enabled && echo "enabled" || echo "not in FSKit's enabled list yet; the mount below will say"

step "4/8 the other computer's home: a clone of this repo with node_modules, under $gate/export"
bash "$s6/ci/prepare.sh" "$gate/export"

step "5/8 coherence: the short-read case with the guard on, then off"
bun "$s6/server/serve.ts" --root "$gate/export" --port 7400 > "$results/service.log" 2>&1 &
svc=$!
trap 'kill $svc 2>/dev/null; /sbin/umount "$gate/tree" 2>/dev/null || true' EXIT
sleep 2
mkdir -p "$gate/tree"
for guard in on off; do
  q=""; [ $guard = off ] && q="?mitigate=0"
  /sbin/mount -F -t clovertree "clovertree://127.0.0.1:7400/Desktop1$q" "$gate/tree"
  ls "$gate/tree" | head -5
  bun "$s6/bench/coherence.ts" --root "$gate/export" --external "$gate/tree" --label "fskit, guard $guard" --out "$results/coherence-guard-$guard.json"
  /sbin/umount "$gate/tree"
done
kill $svc; trap - EXIT

step "6/8 speed against local disk (0/20/80 ms), cold and warm"
bun "$s6/bench/speed.ts" --root "$gate/export" --tree "$gate/tree" --helper none --policies fskit --rtts 0,20,80 \
  --fskit-url "clovertree://127.0.0.1:7500/Desktop1" --fskit-mountpoint "$gate/tree" \
  --copy-src "$repo/packages/protocol" --scratch "$gate/scratch" --out "$results/macos-speed-fskit.json"

step "7/8 fail fast when the computer drops (+20 ms)"
bun "$s6/bench/failfast.ts" --root "$gate/export" --tree "$gate/tree" --helper none --rtt 20 --policy fskit \
  --fskit-url "clovertree://127.0.0.1:7500/Desktop1" --fskit-mountpoint "$gate/tree" --out "$results/macos-failfast-fskit.json"

step "8/8 (optional) the module itself dies with a read in flight"
echo "If FSKit leaves the reader stuck, it can stay unkillable until fskitd is restarted (sudo killall fskitd) or a reboot."
read -r -p "Run it? [y/N] " yn
if [ "$yn" = y ]; then
  bun "$s6/server/serve.ts" --root "$gate/export" --port 7400 > "$results/service-crash.log" 2>&1 &
  svc=$!; sleep 2
  /sbin/mount -F -t clovertree "clovertree://127.0.0.1:7400/Desktop1" "$gate/tree"
  [ -f "$gate/export/big1g.bin" ] || bun "$s6/bench/rw.ts" make "$gate/export/big1g.bin" 1024 >/dev/null
  ( time bun "$s6/bench/rw.ts" read "$gate/tree/big1g.bin" ) > "$results/module-crash.txt" 2>&1 &
  reader=$!; sleep 1
  pkill -9 -f CloverTreeFS.appex/Contents/MacOS/CloverTreeFS && echo "module killed" | tee -a "$results/module-crash.txt"
  for _ in $(seq 1 30); do kill -0 $reader 2>/dev/null || break; sleep 1; done
  kill -0 $reader 2>/dev/null && echo "READER STILL STUCK after 30 s" | tee -a "$results/module-crash.txt"
  ( ls "$gate/tree" ; echo "ls exit $?" ) >> "$results/module-crash.txt" 2>&1 &
  sleep 5; /sbin/umount -f "$gate/tree" >> "$results/module-crash.txt" 2>&1 || true
  kill $svc 2>/dev/null
  cat "$results/module-crash.txt"
fi

if [ $keep = 0 ]; then
  step "clean up: unregister and remove the app (the results stay)"
  pluginkit -r "$app/Contents/Extensions/CloverTreeFS.appex" 2>/dev/null || true
  rm -rf "$app" "$dd"
fi
step "done: results in $results"
