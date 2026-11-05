#!/usr/bin/env bash
# CI only (a disposable macOS runner): install macFUSE <version> and turn its FSKit module on by
# adding it to FSKit's enabled list, which is what the System Settings switch writes.
#   macfuse.sh <version> <out dir>
set -euo pipefail
# It edits FSKit's enabled list and kills fskitd: never on a person's Mac.
[ "${GITHUB_ACTIONS:-}" = true ] || { echo "macfuse.sh runs only on a disposable CI runner (GITHUB_ACTIONS=true)" >&2; exit 2; }
v="$1"; out="$2"; mkdir -p "$out"
case "$v" in # the release assets' SHA-256, as GitHub lists them
  5.4.0) sha=861814f0ac7fa8f6547ea40cdd49a36ac84bcc7d34f38a1fa74e8cf68b0401c5 ;;
  5.5.0) sha=92c21ef2db4199bcf5bddc8e6efb57b23ecb9715f74ab38cba2c77ab226d3830 ;;
  *) echo "no pinned hash for macFUSE $v" >&2; exit 1 ;;
esac
curl -fsSL -o "$RUNNER_TEMP/macfuse.dmg" "https://github.com/macfuse/macfuse/releases/download/macfuse-$v/macfuse-$v.dmg"
echo "$sha  $RUNNER_TEMP/macfuse.dmg" | shasum -a 256 -c -
hdiutil attach "$RUNNER_TEMP/macfuse.dmg" -nobrowse -mountpoint "$RUNNER_TEMP/macfuse-dmg" >/dev/null
pkg="$(find "$RUNNER_TEMP/macfuse-dmg" -maxdepth 2 -name '*.pkg' | head -1)"
sudo installer -pkg "$pkg" -target / | tail -2
hdiutil detach "$RUNNER_TEMP/macfuse-dmg" >/dev/null || true
ls /usr/local/include/fuse | head -3; ls /usr/local/lib | grep -i fuse
# Register the module (macFUSE also does this before its first mount) and find its id.
find /Library/Filesystems/macfuse.fs -name '*.appex' -maxdepth 6 | tee "$out/macfuse-appex.txt"
while read -r appex; do pluginkit -a "$appex" || true; done < "$out/macfuse-appex.txt"
app="$(find /Library/Filesystems/macfuse.fs -name '*.app' -maxdepth 4 | head -1)"
[ -n "$app" ] && /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f -R -trusted "$app"
sleep 2
pluginkit -m -v -p com.apple.fskit.fsmodule | tee "$out/macfuse-pluginkit.txt"
ids="$(pluginkit -m -p com.apple.fskit.fsmodule | grep -o 'io\.macfuse[^(]*' | sort -u)"
echo "macFUSE FSKit module ids: $ids"
settings="$HOME/Library/Group Containers/group.com.apple.fskit.settings/enabledModules.plist"
python3 - "$settings" $ids <<'PY'
import plistlib, sys, os
p, ids = sys.argv[1], sys.argv[2:]
mods = []
if os.path.exists(p):
    with open(p, "rb") as f: mods = plistlib.load(f)
for i in ids:
    if i not in mods: mods.append(i)
os.makedirs(os.path.dirname(p), exist_ok=True)
with open(p, "wb") as f: plistlib.dump(mods, f, fmt=plistlib.FMT_BINARY)
print("enabledModules:", mods)
PY
killall -9 fskit_agent extensionkitservice 2>/dev/null || true
sudo killall -9 fskitd 2>/dev/null || true
sleep 3
sw_vers | tee "$out/sw_vers.txt"
echo "macFUSE $v" >> "$out/sw_vers.txt"
