#!/bin/bash
# A try build's static checks, read-only on its artifact folder (a copy of apps/desktop/out/sign-only, or of out/dist
# for a notarized build). Never launches the app; the dmg is mounted read-only with nobrowse and detached again; the
# core runs only its probes, on a temp home. Prints no secret and no identity name (only the team id).
#
# Usage: scripts/try/verify.sh <artifact folder> <checkout the build came from> [--sign-only]
# --sign-only (explicit, never inferred): a `release/build.ts --sign --no-notarize` try. Gatekeeper's verdict and the
# staples are not applicable; the build must really be unnotarized (no staple), carry no update file, and its
# BUILD-COMMIT must carry the sign-only mark (CLOVER-SIGN-ONLY-BUILD) on its second line; every other check is the
# notarized build's. CLOVER_TRY_WORK (scripts/try/run.sh sets it) names the folder whose copies are unregistered from
# Launch Services at the end; nothing under it may stay registered.
set -u
[ $# -ge 2 ] || { echo "usage: scripts/try/verify.sh <artifact folder> <checkout> [--sign-only]"; exit 2; }
T="$(cd "$1" && pwd -P)" || exit 2; W="$(cd "$2" && pwd -P)" || exit 2; A="$T/mac-arm64/Clover.app"; R="$A/Contents/Resources"; fail=0
SIGN_ONLY=false; [ "${3:-}" = "--sign-only" ] && SIGN_ONLY=true; [ -n "${3:-}" ] && [ "$SIGN_ONLY" = false ] && { echo "unknown option ${3}"; exit 2; }
note() { echo "$1"; }
bad() { echo "FAIL: $1"; fail=1; }
cd "$T" || exit 2
note "commit: $(head -1 BUILD-COMMIT-mac.txt)"
if [ "$SIGN_ONLY" = true ]; then
  case "$(cd "$T" && pwd -P)" in */out/dist|*/out/dist/*) bad "sign-only: the artifact folder is an out/dist (a sign-only build goes to out/sign-only)";; *) note "sign-only: the artifact folder is not an out/dist";; esac
fi
n=$(shasum -a 256 -c SHA256SUMS-mac.txt 2>&1 | grep -vc ': OK$'); [ "$n" = 0 ] && note "sha256sums: all OK" || bad "sha256sums: $n lines not OK"
if [ "$SIGN_ONLY" = true ]; then
  for f in Clover-*.dmg Clover-*-mac.zip; do note "  $f $(shasum -a 256 "$f" | cut -d' ' -f1)"; done
  extra=$(ls | grep -E '\.(yml|blockmap)$|^clover-(core|plugin-bun|plugins)-' | tr '\n' ' ')
  [ -z "$extra" ] && note "sign-only: no update files" || bad "sign-only: update files present: $extra"
else
  for f in Clover-*.dmg Clover-*-mac.zip clover-core-*-darwin-arm64 clover-plugin-bun-*-darwin-arm64 clover-plugins-*.tar.gz; do note "  $f $(shasum -a 256 "$f" | cut -d' ' -f1)"; done
fi
gk() { o=$(spctl -a -vvv "$@" 2>&1); echo "$o" | grep -q "source=Notarized Developer ID" && note "gatekeeper $(basename "${@: -1}"): Notarized Developer ID" || bad "gatekeeper $(basename "${@: -1}"): $(echo "$o" | tail -1)"; }
DMG="$(ls Clover-*.dmg)"
if [ "$SIGN_ONLY" = true ]; then
  for p in "$A" "$DMG"; do note "gatekeeper $(basename "$p"): not applicable: not notarized"; done
  for p in "$A" "$DMG"; do
    note "staple $(basename "$p"): not applicable: not notarized"
    xcrun stapler validate "$p" >/dev/null 2>&1 && bad "sign-only: $(basename "$p") carries a notarization staple, so it isn't a sign-only build" || note "sign-only: $(basename "$p") has no staple (really not notarized)"
  done
else
  gk -t exec "$A"; gk -t open --context context:primary-signature "$DMG"
  for p in "$A" "$DMG"; do xcrun stapler validate "$p" >/dev/null 2>&1 && note "staple $(basename "$p"): valid" || bad "staple $(basename "$p")"; done
fi
codesign --verify --deep --strict "$A" 2>/dev/null && note "codesign deep strict: valid" || bad "codesign deep strict"
for f in "$R"/daemon/* "$A"; do o=$(codesign -dvvv "$f" 2>&1)
  note "  $(basename "$f") | $(echo "$o" | sed -n 's/^Identifier=//p') | $(echo "$o" | grep -oE 'flags=0x[0-9a-f]+\([^)]*\)' | head -1) | team $(echo "$o" | sed -n 's/^TeamIdentifier=//p') | timestamp $(echo "$o" | grep -c '^Timestamp=') | $(codesign -d --entitlements - --xml "$f" 2>/dev/null | grep -oE 'cs\.[a-z-]+' | tr '\n' ' ')"
done
M=$(mktemp -d "${TMPDIR:-/tmp}/clover-try-mnt.XXXX")
if hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$M" "$(ls Clover-*.dmg)" >/dev/null; then
  [ -L "$M/Applications" ] && note "dmg: Applications link present" || bad "dmg: no Applications link"
  a=$(codesign -dvvv "$M/Clover.app" 2>&1 | grep ^CDHash=); b=$(codesign -dvvv "$A" 2>&1 | grep ^CDHash=)
  [ "$a" = "$b" ] && note "dmg app == built app ($a)" || bad "dmg app differs from built app"
  hdiutil detach -quiet "$M"
else bad "dmg mount"; fi
rmdir "$M" 2>/dev/null
C="$R/daemon/clover-core"; H=$(mktemp -d "${TMPDIR:-/tmp}/clover-try-home.XXXX")
for p in __worker-entry-probe __fd-receiver-probe __host-bundles __bundled-manifest; do
  out=$(cd "$H" && env -i PATH=/usr/bin:/bin HOME="$HOME" CLOVER_HOME="$H/home" "$C" $p 2>&1 | tail -1 | cut -c1-220); st=$?
  echo "$out" | grep -qE '"ok":true|host-bundles: host|bundled-manifest: [0-9]' && note "core $p: $out" || bad "core $p: $out"
done
rm -rf "$H"
if [ "$SIGN_ONLY" = true ]; then note "feed core: not applicable: a sign-only build has no update files"
else cmp -s "$C" clover-core-*-darwin-arm64 && note "feed core == app core" || bad "feed core differs from app core"; fi
F=$(ls -d "$W"/node_modules/.bun/@electron+fuses@*/node_modules/@electron/fuses/dist/bin.js 2>/dev/null | tail -1)
if [ -n "$F" ]; then
  FU=$("$W/scripts/pinned-bun" "$F" read --app "$A" 2>&1)
  echo "$FU" | grep -E " is (Enabled|Disabled)" | sed 's/^ */fuse: /'
  for want in "RunAsNode is Disabled" "EnableNodeOptionsEnvironmentVariable is Disabled" "EnableNodeCliInspectArguments is Disabled" "EnableEmbeddedAsarIntegrityValidation is Enabled" "OnlyLoadAppFromAsar is Enabled"; do
    echo "$FU" | grep -q "$want" && note "fuse ok: $want" || bad "fuse: wanted '$want'"
  done
else bad "no @electron/fuses in $W"; fi
/usr/libexec/PlistBuddy -c "Print :ElectronAsarIntegrity:Resources/app.asar:hash" "$A/Contents/Info.plist" >/dev/null 2>&1 && note "Info.plist: ElectronAsarIntegrity present" || bad "Info.plist: no ElectronAsarIntegrity"
for b in clover-core clover-plugin-bun; do codesign -dvvv "$R/daemon/$b" 2>&1 | grep -qE 'flags=0x[0-9a-f]+\([^)]*restrict' && note "restrict: $b signed restrict" || bad "restrict: $b not signed restrict"; done
# appPeer (#419), statically: the daemon holds the app to appRequirement("dist") and itself to a Developer ID of the team.
REQ=$(cd "$W" && scripts/pinned-bun -e 'const b = await import("./packages/core/src/bundled-identities.ts"); console.log(b.appRequirement("dist"))')
codesign --verify -R="$REQ" "$A" 2>/dev/null && note "appPeer: the app satisfies the daemon's dist app requirement" || bad "appPeer: the app does not satisfy: $REQ"
SELF=$(cd "$W" && scripts/pinned-bun -e 'const b = await import("./packages/core/src/bundled-identities.ts"); console.log(`anchor apple generic and ${b.DEVELOPER_ID_CLAUSES} and certificate leaf[subject.OU] = "${b.CLOVER_TEAM_ID ?? "37N77U9RSZ"}"`)')
codesign --verify -R="$SELF" "$R/daemon/clover-core" 2>/dev/null && note "appPeer: the core is a Developer ID of the team (dist form of the check)" || bad "appPeer: the core fails its own Developer ID check"
codesign -dvvv "$A" 2>&1 | grep -qE 'flags=0x[0-9a-f]+\([^)]*runtime' && note "appPeer: the app is hardened" || bad "appPeer: the app is not hardened"
open_hits=$(codesign -d --entitlements - --xml "$A" 2>/dev/null | grep -cE 'get-task-allow|allow-dyld-environment-variables|disable-library-validation')
[ "$open_hits" = 0 ] && note "appPeer: the app has none of OPENING_ENTITLEMENTS" || bad "appPeer: the app carries an opening entitlement"
# The packaged plugin Bun, measured (#422's restrictRun): environment hidden from another process, and it still works.
# The test-build marker (scripts/test-build.ts): a real build's core and app.asar carry neither the label nor the test-only code.
if [ -f "$W/scripts/test-build.ts" ]; then
  MK=$(cd "$W" && scripts/pinned-bun -e '
const { testBuildMarkerProblems, asarMarkerProblems } = await import("./scripts/test-build.ts");
const { readFileSync } = await import("node:fs");
const [core, asar] = process.argv.slice(1);
const p = [...testBuildMarkerProblems("the app core", new Uint8Array(readFileSync(core)), false), ...asarMarkerProblems("the app asar", new Uint8Array(readFileSync(asar)), false)];
console.log(p.length === 0 ? "clean" : p.join("; "));' "$R/daemon/clover-core" "$R/app.asar" 2>&1 | tail -1)
  [ "$MK" = clean ] && note "marker: no test-build label or test-only code in the app's core or app.asar" || bad "marker: $MK"
  grep -q "CLOVER-TEST-BUILD\|test build" BUILD-COMMIT-mac.txt && bad "marker: BUILD-COMMIT names a test build" || note "marker: BUILD-COMMIT names no test build"
  head -1 BUILD-COMMIT-mac.txt | grep -Eq '^[0-9a-f]{40}$' && note "marker: BUILD-COMMIT's first line is a commit" || bad "marker: BUILD-COMMIT's first line is not a commit"
  if [ "$SIGN_ONLY" = true ]; then
    [ "$(wc -l < BUILD-COMMIT-mac.txt | tr -d ' ')" = 2 ] && sed -n 2p BUILD-COMMIT-mac.txt | grep -q '^CLOVER-SIGN-ONLY-BUILD: ' && note "marker: BUILD-COMMIT carries the sign-only mark (the release step refuses it)" || bad "marker: BUILD-COMMIT does not carry the sign-only mark on its second line"
  else
    grep -qi "CLOVER-SIGN-ONLY-BUILD\|sign[- ]only" BUILD-COMMIT-mac.txt && bad "marker: a notarized build's BUILD-COMMIT carries the sign-only mark" || note "marker: BUILD-COMMIT is a plain commit"
    [ "$(wc -l < BUILD-COMMIT-mac.txt | tr -d ' ')" = 1 ] || bad "marker: a notarized build's BUILD-COMMIT has more than the commit"
  fi
else bad "no scripts/test-build.ts in $W"; fi
# The app's own native add-ons: none packed inside app.asar (a packed one loads unsigned and library validation refuses
# it); each in app.asar.unpacked signed by the team and hardened.
PM=$(cd "$W" && scripts/pinned-bun -e '
const { asarFiles } = await import("./scripts/test-build.ts");
const { readFileSync } = await import("node:fs");
const M = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);
const p = [...asarFiles(new Uint8Array(readFileSync(process.argv[1])))].filter(([, b]) => b.length >= 4 && M.has(new DataView(b.buffer, b.byteOffset, 4).getUint32(0, false))).map(([k]) => k);
console.log(p.length === 0 ? "none" : p.join(", "));' "$R/app.asar" 2>&1 | tail -1)
[ "$PM" = none ] && note "native: no Mach-O packed inside app.asar" || bad "native: packed inside app.asar (loads unsigned, refused by library validation): $PM"
nu=0
if [ -d "$R/app.asar.unpacked" ]; then
  while IFS= read -r f; do
    file "$f" | grep -q Mach-O || continue; nu=$((nu+1))
    codesign --verify -R='anchor apple generic and certificate leaf[subject.OU] = "37N77U9RSZ"' "$f" 2>/dev/null && codesign -dvvv "$f" 2>&1 | grep -qE 'flags=0x[0-9a-f]+\([^)]*runtime' \
      && note "native: ${f#$R/} is signed by team 37N77U9RSZ with the hardened runtime (library validation takes it)" \
      || bad "native: ${f#$R/} isn't signed by team 37N77U9RSZ with the hardened runtime"
  done < <(find "$R/app.asar.unpacked" -type f)
fi
[ "$nu" -gt 0 ] && note "native: $nu unpacked add-on(s)" || bad "native: no unpacked add-on (the screen add-on should be in app.asar.unpacked)"
# The restrict measurement below only means something with SIP on (the flag does nothing with SIP off): this Mac must be.
csrutil status 2>&1 | grep -qE "status:\s*enabled\.?\s*$" && note "SIP: enabled on this Mac" || bad "SIP: not enabled on this Mac, so restrict's effect can't be measured here"
if [ -f "$W/packages/cli/src/restrict-probe.ts" ]; then
  RH=$(mktemp -d "${TMPDIR:-/tmp}/clover-try-rp.XXXX")
  cat > "$RH/m.ts" <<EOT
import { restrictRun } from "$W/scripts/verify-fd-receiver-compiled";
const r = await restrictRun(["$R/daemon/clover-plugin-bun", "--no-env-file", "$W/packages/cli/src/restrict-probe.ts"], { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/" }, "$RH");
console.log(JSON.stringify({ envSet: r.ready?.envSet, dyldRemoved: r.ready?.dyldRemoved, fetch: r.ready?.fetch, ffi: r.ready?.ffi, envReadable: r.read.env, exit: r.code }));
EOT
  RJ=$("$W/scripts/pinned-bun" "$RH/m.ts" 2>&1 | tail -1); rm -rf "$RH"
  echo "$RJ" | grep -q '"envSet":true,"dyldRemoved":true,"fetch":true,"ffi":true,"envReadable":false,"exit":0' && note "restrict measured, packaged plugin Bun: $RJ" || bad "restrict measured, packaged plugin Bun: $RJ"
else bad "no restrict-probe.ts in $W (#422 missing)"; fi
# Launch Services: every Clover.app this script assessed (the built copy, and the dmg's, mounted and gone) is
# unregistered, and so is every app under CLOVER_TRY_WORK; none may stay registered under the dist bundle id.
LSR=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
$LSR -u "$A" 2>/dev/null; [ -n "${M:-}" ] && $LSR -u "$M/Clover.app" 2>/dev/null
ROOTS=("$(pwd -P)"); [ -n "${CLOVER_TRY_WORK:-}" ] && ROOTS+=("$(cd "$CLOVER_TRY_WORK" 2>/dev/null && pwd -P)")
left=0
for root in "${ROOTS[@]}"; do
  [ -n "$root" ] || continue
  while IFS= read -r p; do $LSR -u "$p" 2>/dev/null; done < <($LSR -dump 2>/dev/null | grep -E '^path:' | grep -F "$root/" | sed -E 's/^path: *//; s/ \(0x[0-9a-f]+\)$//')
  n=$($LSR -dump 2>/dev/null | grep -E '^path:' | grep -cF "$root/"); left=$((left + n))
done
[ "$left" = 0 ] && note "launch services: none of the try's copies registered: true" || bad "launch services: none of the try's copies registered: false ($left)"
echo "verify: $([ $fail = 0 ] && echo PASS || echo FAIL)"
exit $fail
