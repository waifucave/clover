#!/usr/bin/env bash
# Makes "the other computer's home" for the S6 checks: a clone of this repo (3.8k tracked files)
# with its node_modules installed (8k more files), as a developer's checkout would be.
#   prepare.sh <export dir>
set -euo pipefail
export_dir="$1"
src="${GITHUB_WORKSPACE:-$(git rev-parse --show-toplevel)}"
mkdir -p "$export_dir"
rm -rf "$export_dir/clover"
echo "cloning $src into $export_dir/clover"
git clone --quiet --no-hardlinks "$src" "$export_dir/clover"
cd "$export_dir/clover"
echo "installing node_modules"
bun install --frozen-lockfile >/dev/null
git -c core.fsmonitor=false status --porcelain >/dev/null # the holder refreshes its own index
echo "tracked files: $(git ls-files | wc -l | tr -d ' '), all files: $(find . -type f | wc -l | tr -d ' '), dirs: $(find . -type d | wc -l | tr -d ' ')"
