#!/bin/bash
# An owner's try, in one command, on the owner's Mac, from a clean checkout of the try's commit (int/try's head):
#
#   scripts/try/run.sh <commit> <out folder> [--runs N] [--cold-start N] [--work <dir>]
#
#   1. the real build: `release/build.ts --sign --no-notarize` (Developer ID signed and hardened, never notarized or
#      stapled, no update files, BUILD-COMMIT marked sign-only) into apps/desktop/out/sign-only. Its dmg, zip,
#      BUILD-COMMIT and SHA256SUMS are copied to the out folder.
#   2. its static checks (scripts/try/verify.sh --sign-only, on a copy) into <out>/verify.txt.
#   3. the test twin: the same commit as `release/build.ts --test-build` (apps/desktop/out/test-build).
#   4. the packaged acceptance on the twin, N times (default 3), each under the keychain-prompt watchdog
#      (scripts/try/watch.sh), and `--cold-start N` (default 5) once, into <out>/acceptance-test-twin/.
#   5. with --upgrade-from <commit> (the previous try's): the owner's real path, an UPGRADE. That commit's test twin is
#      built in a temporary worktree; it runs the full acceptance with --keep-state (its home, user home and test
#      keychain file kept in a short temp dir), then this try's twin runs the upgrade steps on them (--upgrade-from:
#      the app first, the old key, conversation, plugin, fence, bundled tools and setting, and no distrust), each under
#      the watchdog, into <out>/acceptance-test-twin/upgrade-old and upgrade-new. Without it, the pair is skipped and
#      the summary says so.
#   6. the per-step table (each run's status per step; a step the script can't drive on a packaged app is shown NOT
#      RUN ON PACKAGED with its reason), the upgrade pair's two tables, and how long each stage took, printed and kept
#      in <out>/SUMMARY.txt.
#
# Nothing is published, uploaded or notarized, and nothing is opened: the real build is never launched, the twin runs
# headless from copies started by their binary path (never `open`), each copy is unregistered from Launch Services
# and deleted, and the script reports that none stays registered. It stops at once if a keychain prompt (a new
# SecurityAgent process) appears. The Developer ID identity is found by Clover's team in the login keychain
# (`security find-identity`), never printed, and replaced in everything kept; NODE_AUTH_TOKEN (for the build's
# installs) is taken from `gh auth token` inline when it isn't set, and never printed or written. The build's lines
# carry the time, so a try's minutes can be read off its log. The out folder must be new or empty.
set -u
usage() { echo "usage: scripts/try/run.sh <commit> <out folder> [--runs N] [--cold-start N] [--upgrade-from <previous try's commit>] [--work <dir>]" >&2; exit 2; }
[ $# -ge 2 ] || usage
COMMIT="$1"; OUT="$2"; shift 2; RUNS=3; COLD=5; WORK=""; UPFROM=""
while [ $# -gt 0 ]; do
  case "$1" in
    --runs) RUNS="${2:-}"; shift 2 ;;
    --cold-start) COLD="${2:-}"; shift 2 ;;
    --upgrade-from) UPFROM="${2:-}"; [ -n "$UPFROM" ] || usage; shift 2 ;;
    --work) WORK="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done
[[ "$RUNS" =~ ^[0-9]+$ && "$COLD" =~ ^[0-9]+$ ]] || usage
[ "$(uname -s)" = Darwin ] || { echo "try: macOS only (the try is a Developer ID build of the Mac app)" >&2; exit 2; }
ROOT="$(git rev-parse --show-toplevel)" || exit 2; cd "$ROOT" || exit 2
DESKTOP="$ROOT/apps/desktop"
die() { echo "try: $*" >&2; exit 1; }
# The link sidecar is Rust: rustup's cargo, which a non-login shell may not have on PATH.
command -v cargo >/dev/null || { [ -x "$HOME/.cargo/bin/cargo" ] && PATH="$HOME/.cargo/bin:$PATH"; }
command -v cargo >/dev/null || die "no cargo (the link sidecar, native/link, is Rust): install rustup's toolchain first"
command -v gh >/dev/null || [ -n "${NODE_AUTH_TOKEN:-}" ] || die "no gh and no NODE_AUTH_TOKEN (the build's installs read the @waifucave packages)"

# ── the checkout, the folders, the identity ──────────────────────────────────────────────────────────────────────
want="$(git rev-parse --verify --quiet "$COMMIT^{commit}")" || die "$COMMIT isn't a commit here (fetch it first)"
if [ -n "$UPFROM" ]; then UPWANT="$(git rev-parse --verify --quiet "$UPFROM^{commit}")" || die "--upgrade-from $UPFROM isn't a commit here (fetch it first)"; fi
[ "$(git rev-parse HEAD)" = "$want" ] || die "this checkout is at $(git rev-parse --short HEAD), not $COMMIT: check the try's commit out first"
[ -z "$(git status --porcelain)" ] || die "the checkout isn't clean (a try builds from a fully clean checkout of its commit)"
if [ -e "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then die "$OUT isn't empty: a try's folder is new"; fi
mkdir -p "$OUT" && OUT="$(cd "$OUT" && pwd -P)" || exit 2
[ -n "$WORK" ] || WORK="$(mktemp -d "${TMPDIR:-/tmp}/clover-try.XXXXXX")"
mkdir -p "$WORK" && WORK="$(cd "$WORK" && pwd -P)" || exit 2
export CLOVER_TRY_WORK="$WORK"
TEAM="$(scripts/pinned-bun -e 'console.log((await import("./packages/core/src/bundled-identities.ts")).CLOVER_TEAM_ID)' 2>/dev/null | tail -1)"
[[ "$TEAM" =~ ^[A-Z0-9]{10}$ ]] || die "couldn't read Clover's team id from packages/core/src/bundled-identities.ts"
ID="$(security find-identity -v -p codesigning | sed -nE "s/.*\"(Developer ID Application: .* \\($TEAM\\))\".*/\\1/p" | head -1)"
[ -n "$ID" ] || die "no Developer ID Application identity of team $TEAM in the keychain"
NAME="${ID#Developer ID Application: }"; NAME="${NAME% ($TEAM)}"
LSR=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

# Every kept line: the identity and its name replaced, the time in front.
redact() { IDN="$ID" NM="$NAME" awk '{ for (k = 0; k < 2; k++) { n = (k == 0 ? ENVIRON["IDN"] : ENVIRON["NM"]); r = (k == 0 ? "<Developer ID identity>" : "<name>"); while (n != "" && (i = index($0, n)) > 0) $0 = substr($0, 1, i - 1) r substr($0, i + length(n)) } print; fflush() }'; }
stamp() { perl -MPOSIX -ne 'BEGIN { $| = 1 } print strftime("%H:%M:%S ", localtime), $_'; }
TIMES=()
timed() { local name="$1"; shift; local t0; t0=$(date +%s); "$@"; local rc=$?; TIMES+=("$name|$(( $(date +%s) - t0 ))|$rc"); return $rc; }
build() {
  local log="$1"; shift
  NODE_AUTH_TOKEN="${NODE_AUTH_TOKEN:-$(gh auth token 2>/dev/null)}" CLOVER_MAC_IDENTITY="$ID" \
    scripts/heavy bun scripts/release/build.ts "$@" 2>&1 | redact | stamp | tee "$log"
  return "${PIPESTATUS[0]}"
}
unregister_under() { while IFS= read -r p; do $LSR -u "$p" 2>/dev/null; done < <($LSR -dump 2>/dev/null | grep -E '^path:' | grep -F "$1/" | sed -E 's/^path: *//; s/ \(0x[0-9a-f]+\)$//'); }
registered_under() { $LSR -dump 2>/dev/null | grep -E '^path:' | grep -cF "$1/"; }
UPSTATE=""
cleanup() {
  for d in "$WORK" "$DESKTOP/out/sign-only" "$DESKTOP/out/test-build"; do [ -d "$d" ] && unregister_under "$d"; done
  # The previous try's worktree (under WORK) is let go of, and the upgrade's state dir (temp homes and a throwaway
  # keychain FILE that was never in the search list) goes.
  [ -d "$WORK/old" ] && git worktree remove --force "$WORK/old" 2>/dev/null; git worktree prune 2>/dev/null
  [ -n "$UPSTATE" ] && rm -rf "$UPSTATE"
  rm -rf "$WORK" "$DESKTOP/out/sign-only" "$DESKTOP/out/test-build"
}
trap cleanup EXIT
echo "try: $COMMIT ($(git rev-parse --short HEAD)) into $OUT; the identity: team $TEAM's Developer ID (found)"

# ── 1-2. the real build and its checks ──────────────────────────────────────────────────────────────────────────
timed "real build (sign-only: app, plugins, daemon, package, sign)" build "$OUT/build-sign-only.log" --sign --no-notarize || die "the sign-only build failed (build-sign-only.log)"
SO="$DESKTOP/out/sign-only"
cp "$SO"/Clover-*.dmg "$SO"/Clover-*-mac.zip "$SO/BUILD-COMMIT-mac.txt" "$SO/SHA256SUMS-mac.txt" "$OUT/" || die "the sign-only build's files are missing"
ditto "$SO" "$WORK/sign-only"
timed "verify (static checks)" bash -c 'scripts/try/verify.sh "$1" "$2" --sign-only 2>&1 | tee "$3"; exit "${PIPESTATUS[0]}"' _ "$WORK/sign-only" "$ROOT" "$OUT/verify.txt"
VERIFY=$?
unregister_under "$WORK/sign-only"; rm -rf "$WORK/sign-only"

# ── 3. the test twin ─────────────────────────────────────────────────────────────────────────────────────────────
timed "twin build (test-marked, same commit)" build "$OUT/build-test-twin.log" --test-build || die "the test twin's build failed (build-test-twin.log)"
mkdir -p "$WORK/twin" && ditto "$DESKTOP/out/test-build/mac-arm64/Clover.app" "$WORK/twin/Clover.app"
unregister_under "$DESKTOP/out/test-build"; rm -rf "$DESKTOP/out/test-build"

# ── 4. the packaged acceptance ───────────────────────────────────────────────────────────────────────────────────
ACC="$OUT/acceptance-test-twin"; mkdir -p "$ACC"; COLS=(); PROMPT=false
# The app a run takes (this try's twin, or the previous try's for the upgrade's first half).
RUNAPP="$WORK/twin/Clover.app"
accept() {
  local label="$1"; shift
  timed "acceptance $label" scripts/try/watch.sh "$RUNAPP" "$ROOT" "$WORK/acc/$label" "$@" > "$WORK/$label.watch" 2>&1
  local rc=$?
  mkdir -p "$ACC/$label"; cp -R "$WORK/acc/$label/logs" "$WORK/acc/$label/run.out" "$ACC/$label/" 2>/dev/null; cp "$WORK/$label.watch" "$ACC/$label/watchdog.txt"
  sed 's/^/  /' "$WORK/$label.watch"
  COLS+=("$label")
  [ "$rc" = 4 ] && PROMPT=true
  return 0
}
for k in $(seq 1 "$RUNS"); do [ "$PROMPT" = false ] && accept "run$k"; done
[ "$COLD" -gt 0 ] && [ "$PROMPT" = false ] && accept "cold-start-x$COLD" --cold-start "$COLD"
[ "$PROMPT" = false ] || echo "try: A KEYCHAIN PROMPT APPEARED: the run was killed and no further run started"

# ── 5. the upgrade pair: the previous try's twin keeps its state, this try's twin starts on it ──────────────────────
UPCOLS=()
upgrade_pair() {
  echo "try: the upgrade pair from $UPFROM ($(git rev-parse --short "$UPWANT")): its test twin, in a temporary worktree"
  git worktree add --detach "$WORK/old" "$UPWANT" >/dev/null 2>&1 || { echo "try: the previous try's worktree couldn't be made"; return 1; }
  ( cd "$WORK/old" && scripts/pinned-bun install --frozen-lockfile >/dev/null 2>&1 && build "$OUT/build-upgrade-old-twin.log" --test-build ) || { echo "try: the previous try's twin didn't build (build-upgrade-old-twin.log)"; return 1; }
  mkdir -p "$WORK/old-twin" && ditto "$WORK/old/apps/desktop/out/test-build/mac-arm64/Clover.app" "$WORK/old-twin/Clover.app"
  unregister_under "$WORK/old"; git worktree remove --force "$WORK/old" 2>/dev/null; git worktree prune 2>/dev/null
  # Short: the daemon's socket goes under it (scripts/acceptance/state.ts).
  UPSTATE="$(mktemp -d "${TMPDIR:-/tmp}/clv-up.XXXXXX")"
  # An older app that can't draw a card offscreen for the real press answers its cards over RPC.
  local press=(); git grep -q CLOVER_TEST_SEALED_PRESS "$UPWANT" -- apps/desktop/src/main/index.ts || press=(--no-press)
  RUNAPP="$WORK/old-twin/Clover.app"; accept "upgrade-old" --keep-state "$UPSTATE" ${press[@]+"${press[@]}"}; UPCOLS+=("upgrade-old")
  [ "$PROMPT" = false ] || return 1
  [ -f "$UPSTATE/state.json" ] || { echo "try: the previous try's run left no state (upgrade-old/run.out says why)"; return 1; }
  RUNAPP="$WORK/twin/Clover.app"; accept "upgrade-new" --upgrade-from "$UPSTATE"; UPCOLS+=("upgrade-new")
}
UPGRADE="not run (no --upgrade-from)"
if [ -n "$UPFROM" ] && [ "$PROMPT" = false ]; then
  if timed "upgrade pair (previous twin build + two runs)" upgrade_pair; then UPGRADE="ran"; else UPGRADE="didn't complete (see above)"; fi
fi

# ── 6. the table, the times ──────────────────────────────────────────────────────────────────────────────────────
cleanup; trap - EXIT
LEFT=$(( $(registered_under "$DESKTOP/out") + $(registered_under "$WORK") ))
{
  echo "try $COMMIT; BUILD-COMMIT: $(head -1 "$OUT/BUILD-COMMIT-mac.txt") ($(sed -n 2p "$OUT/BUILD-COMMIT-mac.txt" | cut -d: -f1))"
  (cd "$OUT" && for f in Clover-*.dmg Clover-*-mac.zip; do echo "  $f $(shasum -a 256 "$f" | cut -d' ' -f1)"; done)
  tail -1 "$OUT/verify.txt"
  echo
  # The upgrade's two halves are their own tables (the old build's full run, the upgrade steps): their rows differ.
  COLS2=(); for c in ${COLS[@]+"${COLS[@]}"}; do case "$c" in upgrade-*) ;; *) COLS2+=("$c") ;; esac; done
  scripts/pinned-bun scripts/try/table.ts "$ACC" ${COLS2[@]+"${COLS2[@]}"}
  echo
  echo "the upgrade pair ($UPFROM → $COMMIT): $UPGRADE"
  for c in ${UPCOLS[@]+"${UPCOLS[@]}"}; do echo; scripts/pinned-bun scripts/try/table.ts "$ACC" "$c"; done
  echo
  echo "a keychain prompt appeared: $PROMPT"
  echo "none of the try's copies registered with Launch Services: $([ "$LEFT" = 0 ] && echo true || echo "false ($LEFT)")"
  echo
  echo "how long each stage took:"
  for t in "${TIMES[@]}"; do IFS='|' read -r n s rc <<< "$t"; printf '  %-58s %3dm%02ds%s\n' "$n" $((s / 60)) $((s % 60)) "$([ "$rc" = 0 ] && echo "" || echo "  (exit $rc)")"; done
  echo "  (an acceptance run exits 1 when any step is FAIL or BLOCKED, NOT RUN ON PACKAGED included: the table says which)"
  echo "  the build logs carry each line's time: build-sign-only.log, build-test-twin.log"
} | tee "$OUT/SUMMARY.txt"
[ "$VERIFY" = 0 ] && [ "$PROMPT" = false ] && [ "$LEFT" = 0 ]
