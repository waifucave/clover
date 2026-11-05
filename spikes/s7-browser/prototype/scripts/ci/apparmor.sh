#!/bin/bash
# Load an AppArmor profile that lets one binary create user namespaces (what Chromium's sandbox needs on Ubuntu
# 23.10+, where kernel.apparmor_restrict_unprivileged_userns=1). This is what Clover's deb and rpm would install
# (spec §4). CI only: needs sudo.
#   scripts/ci/apparmor.sh <profile-name> <binary>
set -euo pipefail
name="$1"
bin="$(realpath "$2")"
sudo tee "/etc/apparmor.d/$name" >/dev/null <<PROFILE
abi <abi/4.0>,
include <tunables/global>

profile $name "$bin" flags=(unconfined) {
  userns,
  include if exists <local/$name>
}
PROFILE
sudo apparmor_parser -r "/etc/apparmor.d/$name"
echo "AppArmor profile $name loaded for $bin"
