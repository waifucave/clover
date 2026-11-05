#!/usr/bin/env bash
# Live gate 2, the macOS part of spike S6: the clovertree FSKit module, for real.
#
# The owner runs this himself, at his Mac, in a terminal. An agent never runs it: it signs with
# the owner's team (Xcode may ask for his login password or Keychain access), and it needs one click
# in System Settings to turn the module on.
#
#   CLOVER_TEAM_ID=<your team id> spikes/s6-mounts/native/macos/gate.sh [--keep]
#
# What it changes, and what it puts back:
#   - Files: ~/.clover-dev/s6-gate (about 2 GB: a clone of this repo with node_modules, the
#     build, the results) and ~/Applications/CloverTree.app. At the end, and whenever a step
#     fails or you press Ctrl-C, it stops what it started, unmounts, unregisters and removes the
#     app (unless --keep), and offers to delete the gate folder, keeping results/.
#   - This Mac: Launch Services and pluginkit registrations for the app, and its id in FSKit's
#     enabled list (the System Settings switch). The clean-up removes all three.
#   - Your developer account: -allowProvisioningUpdates with automatic signing creates two App
#     IDs, com.waifucave.clover.tree.dev and com.waifucave.clover.tree.dev.fs, with the FSKit
#     Module capability, plus a development profile for each, and registers this Mac as a
#     development device if it isn't one yet. Those stay after the gate; remove them at
#     developer.apple.com (Certificates, Identifiers & Profiles) if you don't want them.
#
# It answers what CI cannot (CI stops at "Module ... is disabled!"):
#   1. does the module mount, read and write on this Mac's macOS;
#   2. does this macOS still have FSKit's short-read bug (coherence with the guard off);
#   3. speed against local disk at 0/20/80 ms, and the fail-fast scenarios, on FSKit;
#   4. the NFS loopback backend on this Mac: a dead helper, a 2 Mbit/s link, and sleep and wake
#      with a read in flight, and whether any of them shows a dialog.
set -euo pipefail
[ -t 0 ] && [ -t 1 ] || { echo "gate.sh is for a person at a terminal, not for scripts or agents" >&2; exit 2; }
: "${CLOVER_TEAM_ID:?set CLOVER_TEAM_ID to the Apple Developer team that has the FSKit Module capability}"
keep=0; [ "${1:-}" = "--keep" ] && keep=1

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../../.." && pwd)"
s6="$repo/spikes/s6-mounts"
gate="$HOME/.clover-dev/s6-gate"
dd="$gate/DerivedData"
app="$HOME/Applications/CloverTree.app"
id="com.waifucave.clover.tree.dev.fs"
results="$gate/results/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$gate" "$results"
step() { printf '\n== %s\n' "$*"; }

step "1/10 build, signed by team $CLOVER_TEAM_ID (Xcode may ask you for access)"
command -v xcodegen >/dev/null || { echo "brew install xcodegen first"; exit 1; }
( cd "$here" && xcodegen generate >/dev/null )
xcodebuild -project "$here/CloverTree.xcodeproj" -scheme CloverTree -configuration Release \
  -destination 'platform=macOS,arch=arm64' -derivedDataPath "$dd" -allowProvisioningUpdates \
  CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM="$CLOVER_TEAM_ID" CODE_SIGNING_ALLOWED=YES CODE_SIGNING_REQUIRED=YES CODE_SIGN_IDENTITY="Apple Development" \
  build > "$results/xcodebuild.log" 2>&1 || { tail -30 "$results/xcodebuild.log"; exit 1; }
codesign -dv --entitlements - "$dd/Build/Products/Release/CloverTree.app/Contents/Extensions/CloverTreeFS.appex" 2>&1 | tee "$results/codesign.txt" | grep -E "Authority|TeamIdentifier|fskit"

# From here on, one trap puts everything back, whichever step fails (set -e) or is interrupted.
svc=""
settings="$HOME/Library/Group Containers/group.com.apple.fskit.settings/enabledModules.plist"
cleanup() {
  local status=$?
  set +e
  trap - EXIT INT TERM
  step "clean up"
  [ -n "$svc" ] && kill "$svc" 2>/dev/null
  # whatever a bench script left running if it was interrupted: only this checkout's scripts
  pkill -f "$s6/server/serve.ts" 2>/dev/null; pkill -f "$s6/link/proxy.ts" 2>/dev/null; pkill -9 -f "$gate/clover-nfs" 2>/dev/null
  for m in "$gate/tree" "$gate/nfs-tree"; do
    if /sbin/mount | grep -q " on $m "; then /sbin/umount "$m" 2>/dev/null || /sbin/umount -f "$m"; fi
  done
  if [ $keep = 0 ]; then
    pluginkit -r "$app/Contents/Extensions/CloverTreeFS.appex" 2>/dev/null
    [ -d "$app" ] && /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u "$app" 2>/dev/null
    rm -rf "$app"
    # the System Settings switch's entry: only this module's id comes out of the list
    if [ -f "$settings" ]; then
      python3 - "$settings" "$id" <<'PY'
import plistlib, sys
p, mod = sys.argv[1], sys.argv[2]
with open(p, "rb") as f: mods = plistlib.load(f)
if mod in mods:
    with open(p, "wb") as f: plistlib.dump([m for m in mods if m != mod], f, fmt=plistlib.FMT_BINARY)
    print("removed", mod, "from FSKit's enabled list")
PY
    fi
    echo "unregistered and removed $app"
  else
    echo "--keep: $app stays installed, registered and enabled"
  fi
  echo "results: $results"
  if [ -t 0 ]; then
    read -r -p "Delete the rest of $gate (the clone, the build; about 2 GB), keeping results/? [y/N] " yn
    if [ "$yn" = y ]; then
      find "$gate" -mindepth 1 -maxdepth 1 ! -name results -exec rm -rf {} +
      echo "deleted; $gate/results stays"
    fi
  fi
  exit $status
}
trap cleanup EXIT
trap 'exit 130' INT TERM

step "2/10 install to ~/Applications and register"
rm -rf "$app"
ditto "$dd/Build/Products/Release/CloverTree.app" "$app"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f -R -trusted "$app"
sleep 2
pluginkit -m -v -i "$id" | tee "$results/pluginkit.txt"

step "3/10 turn it on: System Settings > General > Login Items & Extensions > File System Extensions > CloverTree"
enabled() { plutil -p "$HOME/Library/Group Containers/group.com.apple.fskit.settings/enabledModules.plist" 2>/dev/null | grep -q "$id"; }
if ! enabled; then
  open "x-apple.systempreferences:com.apple.LoginItems-Settings.extension" || true
  read -r -p "Turn on CloverTree there, then press Enter here. " _
fi
enabled && echo "enabled" || echo "not in FSKit's enabled list yet; the mount below will say"

step "4/10 the other computer's home: a clone of this repo with node_modules, under $gate/export"
bash "$s6/ci/prepare.sh" "$gate/export"

step "5/10 coherence: the short-read case with the guard on, then off"
bun "$s6/server/serve.ts" --root "$gate/export" --port 7400 > "$results/service.log" 2>&1 &
svc=$!
sleep 2
mkdir -p "$gate/tree"
for guard in on off; do
  q=""; [ $guard = off ] && q="?mitigate=0"
  /sbin/mount -F -t clovertree "clovertree://127.0.0.1:7400/Desktop1$q" "$gate/tree"
  ls "$gate/tree" | head -5
  bun "$s6/bench/coherence.ts" --root "$gate/export" --external "$gate/tree" --label "fskit, guard $guard" --out "$results/coherence-guard-$guard.json"
  /sbin/umount "$gate/tree"
done
kill $svc; svc=""

step "6/10 speed against local disk (0/20/80 ms), cold and warm"
bun "$s6/bench/speed.ts" --root "$gate/export" --tree "$gate/tree" --helper none --policies fskit --rtts 0,20,80 \
  --fskit-url "clovertree://127.0.0.1:7500/Desktop1" --fskit-mountpoint "$gate/tree" \
  --copy-src "$repo/packages/protocol" --scratch "$gate/scratch" --out "$results/macos-speed-fskit.json"

step "7/10 fail fast when the computer drops (+20 ms)"
bun "$s6/bench/failfast.ts" --root "$gate/export" --tree "$gate/tree" --helper none --rtt 20 --policy fskit \
  --fskit-url "clovertree://127.0.0.1:7500/Desktop1" --fskit-mountpoint "$gate/tree" --out "$results/macos-failfast-fskit.json"

step "8/10 NFS loopback, the macOS backend the report proposes (mounted as you, never with sudo)"
echo "Watch the screen during the helper-crash scenario: does macOS show 'Server connections interrupted'?"
( cd "$here/.." && CGO_ENABLED=0 go build -o "$gate/clover-nfs" ./cmd/clover-nfs )
mkdir -p "$gate/nfs-tree"
nfs=(--root "$gate/export" --tree "$gate/nfs-tree" --helper none --nfs-helper "$gate/clover-nfs")
bun "$s6/bench/coherence.ts" "${nfs[@]}" --policies cached --nfs-ac noac --out "$results/macos-nfs-noac-coherence.json"
bun "$s6/bench/failfast.ts" "${nfs[@]}" --copy-src "$repo/packages/protocol" --rtt 20 --policy plain --out "$results/macos-nfs-failfast.json"
read -r -p "Did a 'Server connections interrupted' dialog appear (the run includes a 2 Mbit/s link)? [y/N] " dlg; echo "dialog: ${dlg:-n}" > "$results/nfs-dialog.txt"

step "9/10 sleep and wake with an NFS mount active and a read in flight"
read -r -p "Run it? You put the Mac to sleep and wake it when asked. [y/N] " yn
if [ "$yn" = y ]; then
  bun "$s6/bench/failfast.ts" "${nfs[@]}" --rtt 20 --policy cached --only sleep-wake --out "$results/macos-nfs-sleep-wake.json"
  read -r -p "After waking: any dialog about the server or the volume? [y/N] " dlg; echo "dialog after wake: ${dlg:-n}" >> "$results/nfs-dialog.txt"
fi

step "10/10 (optional) the module itself dies with a read in flight"
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
  kill $svc 2>/dev/null; svc=""
  cat "$results/module-crash.txt"
fi

step "done: results in $results"
