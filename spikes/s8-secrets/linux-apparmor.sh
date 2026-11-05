#!/bin/bash
# Dedicated, packaged-helper-style exception; never change the global userns sysctls.
set -euo pipefail
printf 'Installing a path-scoped AppArmor profile for the trusted Clover test launcher\n'
sudo install -D -m 0755 /usr/bin/bwrap /usr/local/libexec/clover-spike-bwrap
sudo tee /etc/apparmor.d/clover-spike-bwrap >/dev/null <<'PROFILE'
abi <abi/4.0>,
include <tunables/global>
profile clover-spike-bwrap /usr/local/libexec/clover-spike-bwrap flags=(unconfined) {
  userns,
}
PROFILE
sudo apparmor_parser -r /etc/apparmor.d/clover-spike-bwrap
/usr/local/libexec/clover-spike-bwrap --unshare-all --ro-bind / / --proc /proc --dev /dev -- /bin/sh -c 'cat /proc/self/attr/current'
