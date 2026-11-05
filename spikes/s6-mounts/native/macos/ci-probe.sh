#!/usr/bin/env bash
# CI only (a disposable macOS runner, never a person's Mac): build the clovertree FSKit module
# ad-hoc signed, then try every unattended way to register and turn it on, and record what
# stops a mount. Answers "can FSKit be tested at all without the System Settings step?"
#   ci-probe.sh <out dir>
set -uo pipefail
# It installs and registers a module, edits FSKit's enabled list and kills fskitd: never on a person's Mac.
[ "${GITHUB_ACTIONS:-}" = true ] || { echo "ci-probe.sh runs only on a disposable CI runner (GITHUB_ACTIONS=true)" >&2; exit 2; }
out="$(cd "$1" && pwd)"
here="$(cd "$(dirname "$0")" && pwd)"
s6="$(cd "$here/../.." && pwd)"
dd="$RUNNER_TEMP/dd-fskit"
note() { echo "== $*" | tee -a "$out/probe.txt"; }

sw_vers | tee "$out/sw_vers.txt"
xcodebuild -version | tee -a "$out/sw_vers.txt"
sdk="$(xcrun --sdk macosx --show-sdk-path)"
note "SDK $sdk"
# What FSKit offers in this SDK: the headers (kept as an artifact) and every symbol newer than 26.
mkdir -p "$out/FSKit-headers"
cp "$sdk/System/Library/Frameworks/FSKit.framework/Headers/"*.h "$out/FSKit-headers/"
grep -n "FSKIT_API_AVAILABILITY_V3\|macos(27\|macOS(27\|API_AVAILABLE(macos(27" "$out/FSKit-headers/"*.h > "$out/fskit-new-in-27.txt" || true
grep -h "define FSKIT_API_AVAILABILITY" "$sdk/System/Library/Frameworks/FSKit.framework/Headers/FSKitDefines.h" | tee -a "$out/probe.txt"
note "symbols marked newer than macOS 26: $(wc -l < "$out/fskit-new-in-27.txt" | tr -d ' ')"

note "build (ad-hoc signature, entitlements embedded)"
cd "$here"
xcodegen generate >/dev/null
xcodebuild -project CloverTree.xcodeproj -scheme CloverTree -configuration Release \
  -destination 'platform=macOS,arch=arm64' -derivedDataPath "$dd" \
  CODE_SIGNING_ALLOWED=YES CODE_SIGNING_REQUIRED=YES CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual \
  OTHER_CODE_SIGN_FLAGS=--timestamp=none build > "$out/xcodebuild.log" 2>&1
status=$?
tail -3 "$out/xcodebuild.log" | tee -a "$out/probe.txt"
[ $status -eq 0 ] || { note "BUILD FAILED"; grep -E "error:" "$out/xcodebuild.log" | head -20; exit 1; }
app="$dd/Build/Products/Release/CloverTree.app"
appex="$app/Contents/Extensions/CloverTreeFS.appex"
codesign -dv --entitlements - "$appex" > "$out/codesign.txt" 2>&1
cat "$out/codesign.txt" | tee -a "$out/probe.txt"
(cd "$dd/Build/Products/Release" && ditto -c -k --keepParent CloverTree.app "$out/CloverTree-adhoc.zip")

note "register with Launch Services and pluginkit"
mkdir -p "$HOME/Applications"
rm -rf "$HOME/Applications/CloverTree.app"
ditto "$app" "$HOME/Applications/CloverTree.app"
lsreg=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
"$lsreg" -f -R -trusted "$HOME/Applications/CloverTree.app" 2>&1 | tee -a "$out/probe.txt"
pluginkit -a "$HOME/Applications/CloverTree.app/Contents/Extensions/CloverTreeFS.appex" 2>&1 | tee -a "$out/probe.txt"
sleep 2
pluginkit -m -v -p com.apple.fskit.fsmodule 2>&1 | tee -a "$out/probe.txt"
note "pluginkit -e use (the only command-line switch there is)"
pluginkit -e use -i com.waifucave.clover.tree.dev.fs 2>&1 | tee -a "$out/probe.txt"
sleep 1
pluginkit -m -v -i com.waifucave.clover.tree.dev.fs 2>&1 | tee -a "$out/probe.txt"
note "fskit enabled-modules settings (read only)"
ls -la "$HOME/Library/Group Containers/group.com.apple.fskit.settings/" 2>&1 | tee -a "$out/probe.txt"
plutil -p "$HOME/Library/Group Containers/group.com.apple.fskit.settings/enabledModules.plist" 2>&1 | tee -a "$out/probe.txt"

note "mount attempt against a live file service"
export_dir="$RUNNER_TEMP/s6probe/export"
mkdir -p "$export_dir" "$RUNNER_TEMP/s6probe/tree"
echo hello > "$export_dir/hello.txt"
bun "$s6/server/serve.ts" --root "$export_dir" --port 7400 > "$out/service.log" 2>&1 &
svc=$!
sleep 2
start=$(date +%s)
( /sbin/mount -F -t clovertree "clovertree://127.0.0.1:7400/Desktop1" "$RUNNER_TEMP/s6probe/tree" > "$out/mount.txt" 2>&1; echo "exit $?" >> "$out/mount.txt" ) &
mpid=$!
for _ in $(seq 1 30); do kill -0 $mpid 2>/dev/null || break; sleep 1; done
if kill -0 $mpid 2>/dev/null; then echo "mount still waiting after 30 s; killed" >> "$out/mount.txt"; kill -9 $mpid; fi
echo "took $(( $(date +%s) - start )) s" >> "$out/mount.txt"
cat "$out/mount.txt" | tee -a "$out/probe.txt"
/sbin/mount | grep -i clover | tee -a "$out/probe.txt"
ls -la "$RUNNER_TEMP/s6probe/tree" 2>&1 | tee -a "$out/probe.txt"
cat "$RUNNER_TEMP/s6probe/tree/hello.txt" 2>&1 | tee -a "$out/probe.txt"
/sbin/umount "$RUNNER_TEMP/s6probe/tree" 2>/dev/null
kill $svc 2>/dev/null

note "EXPERIMENT (disposable runner only, unsupported): add the module to FSKit's enabled list by hand"
settings="$HOME/Library/Group Containers/group.com.apple.fskit.settings/enabledModules.plist"
python3 - "$settings" <<'PY' 2>&1 | tee -a "$out/probe.txt"
import plistlib, sys
p = sys.argv[1]
with open(p, "rb") as f: mods = plistlib.load(f)
if "com.waifucave.clover.tree.dev.fs" not in mods: mods.append("com.waifucave.clover.tree.dev.fs")
with open(p, "wb") as f: plistlib.dump(mods, f, fmt=plistlib.FMT_BINARY)
print("enabledModules now:", mods)
PY
killall -9 fskit_agent extensionkitservice 2>/dev/null
sudo killall -9 fskitd 2>/dev/null
sleep 3
bun "$s6/server/serve.ts" --root "$export_dir" --port 7400 > "$out/service2.log" 2>&1 &
svc=$!
sleep 2
( /sbin/mount -F -t clovertree "clovertree://127.0.0.1:7400/Desktop1" "$RUNNER_TEMP/s6probe/tree" > "$out/mount2.txt" 2>&1; echo "exit $?" >> "$out/mount2.txt" ) &
mpid=$!
for _ in $(seq 1 30); do kill -0 $mpid 2>/dev/null || break; sleep 1; done
if kill -0 $mpid 2>/dev/null; then echo "mount still waiting after 30 s; killed" >> "$out/mount2.txt"; kill -9 $mpid; fi
cat "$out/mount2.txt" | tee -a "$out/probe.txt"
if /sbin/mount | grep -q "$RUNNER_TEMP/s6probe/tree"; then
  echo "FSKIT_MOUNTED=1" | tee -a "$out/probe.txt"
  /sbin/mount | grep "$RUNNER_TEMP/s6probe/tree" | tee -a "$out/probe.txt"
  ls -la "$RUNNER_TEMP/s6probe/tree" 2>&1 | tee -a "$out/probe.txt"
  cat "$RUNNER_TEMP/s6probe/tree/hello.txt" 2>&1 | tee -a "$out/probe.txt"
  echo written-through-fskit > "$RUNNER_TEMP/s6probe/tree/w.txt" 2>&1 && cat "$export_dir/w.txt" 2>&1 | tee -a "$out/probe.txt"
  bun "$s6/bench/coherence.ts" --root "$export_dir" --external "$RUNNER_TEMP/s6probe/tree" --label "fskit, guard on" --out "$out/coherence-fskit.json" 2>&1 | tail -12 | tee -a "$out/probe.txt"
  /sbin/umount "$RUNNER_TEMP/s6probe/tree" 2>&1 | tee -a "$out/probe.txt"
  # The same checks with the short-read guard off: does this macOS still have the bug?
  ( /sbin/mount -F -t clovertree "clovertree://127.0.0.1:7400/Desktop1?mitigate=0" "$RUNNER_TEMP/s6probe/tree" >> "$out/mount2.txt" 2>&1 ) &
  mpid=$!; for _ in $(seq 1 30); do kill -0 $mpid 2>/dev/null || break; sleep 1; done
  bun "$s6/bench/coherence.ts" --root "$export_dir" --external "$RUNNER_TEMP/s6probe/tree" --label "fskit, guard off" --out "$out/coherence-fskit-noguard.json" 2>&1 | tail -12 | tee -a "$out/probe.txt"
  /sbin/umount "$RUNNER_TEMP/s6probe/tree" 2>&1 | tee -a "$out/probe.txt"
else
  echo "FSKIT_MOUNTED=0" | tee -a "$out/probe.txt"
fi
kill $svc 2>/dev/null

note "system log (fskitd, extensionkit, amfi, the module)"
log show --last 3m --style compact --predicate 'process == "fskitd" OR process == "fskit_agent" OR subsystem BEGINSWITH "com.apple.fskit" OR subsystem == "com.waifucave.clover.tree" OR (process == "kernel" AND eventMessage CONTAINS[c] "AMFI") OR eventMessage CONTAINS[c] "clovertree"' > "$out/fskit-log.txt" 2>&1
grep -i -E "clover|disabled|not enabled|denied|amfi|entitle|profile|error" "$out/fskit-log.txt" | head -60 | tee -a "$out/probe.txt"
exit 0
