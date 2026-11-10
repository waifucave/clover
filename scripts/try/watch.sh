#!/bin/bash
# One packaged acceptance run (scripts/acceptance/run.ts --app) of a test-marked Clover.app, under a keychain-prompt
# watchdog. The app is copied (ditto) into the run's folder and run from there, headless, never through `open`. If a
# SecurityAgent process starts after the run began (the process list only; nothing is read from it), the run and
# everything it started are killed at once and the script says so. Then the copy is unregistered from Launch
# Services and deleted. The user's keychain search list is compared before and after (a hash; nothing printed).
#
# Usage: scripts/try/watch.sh <test-marked Clover.app> <checkout> <run folder> [run.ts args, e.g. --cold-start 5]
# The run folder gets run.out (the script's output), logs/ (its kept logs) and the copy while it runs.
set -u
[ $# -ge 3 ] || { echo "usage: scripts/try/watch.sh <test Clover.app> <checkout> <run folder> [run.ts args]"; exit 2; }
APP="$1"; W="$(cd "$2" && pwd -P)" || exit 2; OUT="$3"; shift 3; EXTRA=("$@")
LSR=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
mkdir -p "$OUT/logs"; OUT="$(cd "$OUT" && pwd -P)"; COPY="$OUT/Clover.app"; rm -rf "$COPY"; ditto "$APP" "$COPY"
agents() { pgrep -x SecurityAgent | sort; }
# A running SecurityAgent would be reused by a new prompt (no new process to see): start only when none runs.
for _ in $(seq 1 120); do [ -z "$(agents)" ] && break; sleep 5; done
if [ -n "$(agents)" ]; then echo "not run: a SecurityAgent is already running (a prompt couldn't be told apart)"; $LSR -u "$COPY" 2>/dev/null; rm -rf "$COPY"; exit 3; fi
before_agents=$(agents); before_list=$(security list-keychains -d user | shasum)
( cd "$W" && exec scripts/pinned-bun scripts/acceptance/run.ts --app "$COPY" --verbose --keep-logs "$OUT/logs" ${EXTRA[@]+"${EXTRA[@]}"} ) > "$OUT/run.out" 2>&1 &
RUN=$!; prompt=false
while kill -0 $RUN 2>/dev/null; do
  if [ -n "$(comm -13 <(echo "$before_agents") <(agents) | grep -v '^$')" ]; then
    prompt=true; kill -TERM $RUN 2>/dev/null; sleep 2; kill -KILL $RUN 2>/dev/null
    pgrep -f "clv-acc-|$OUT" | while read -r p; do kill -KILL "$p" 2>/dev/null; done
    break
  fi
  sleep 0.5
done
wait $RUN 2>/dev/null; code=$?
echo "a keychain prompt (SecurityAgent) started during the run: $prompt"
[ "$before_list" = "$(security list-keychains -d user | shasum)" ] && echo "search list unchanged: true" || echo "search list unchanged: false"
$LSR -u "$COPY" 2>/dev/null; rm -rf "$COPY"
left=$($LSR -dump 2>/dev/null | grep -E '^path:' | grep -cF "$OUT/")
echo "the copy unregistered and deleted: $([ "$left" = 0 ] && [ ! -e "$COPY" ] && echo true || echo false)"
n=$(cat "$OUT"/logs/*.log 2>/dev/null | grep -c "screen: no add-on")
echo "the packaged app loaded its screen add-on: $([ "$n" = 0 ] && echo true || echo "false ($n)")"
shown=$(cat "$OUT"/logs/*.log* 2>/dev/null | grep -c "window: shown while headless")
echo "no window shown while headless: $([ "$shown" = 0 ] && echo true || echo "false ($shown)")"
echo "acceptance exit: $code"
[ "$prompt" = false ] || exit 4
exit "$code"
