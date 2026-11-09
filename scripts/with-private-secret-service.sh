#!/bin/bash
# Runs a command with a private D-Bus session bus and an unlocked gnome-keyring of its own (Linux), for tests that
# use the OS secret store through the harness (packages/test-harness: createThrowawaySecretStore). The keyring's
# files and runtime folder live in a temp folder that is removed afterwards, so a developer's own keyring is never
# opened, and the bus ends with the command (dbus-run-session).
#
#   scripts/with-private-secret-service.sh <command> [args...]
#
# Needs dbus-run-session and gnome-keyring-daemon (Ubuntu: `apt-get install dbus gnome-keyring`).
set -euo pipefail
[ $# -gt 0 ] || { echo "usage: scripts/with-private-secret-service.sh <command> [args...]" >&2; exit 2; }
for bin in dbus-run-session gnome-keyring-daemon; do
  command -v "$bin" >/dev/null || { echo "with-private-secret-service: needs $bin (Ubuntu: apt-get install dbus gnome-keyring)" >&2; exit 127; }
done
root="$(mktemp -d "${TMPDIR:-/tmp}/clover-secret-service.XXXXXX")"
trap 'rm -rf "$root"' EXIT
mkdir -p "$root/data" "$root/config" "$root/run"
chmod 700 "$root/run"
export XDG_DATA_HOME="$root/data" XDG_CONFIG_HOME="$root/config" XDG_RUNTIME_DIR="$root/run"
status=0
# Inside the private bus: start gnome-keyring's Secret Service with a login keyring it creates and unlocks, then run
# the command. The keyring needs a password, or the daemon creates no login collection and asks a prompter that
# has no screen: a random one, made here and kept nowhere, protects a keyring that is deleted with the temp folder.
# CLOVER_PRIVATE_SECRET_SERVICE names the private bus's own address, set inside it: a test takes the OS store as its own
# only while the session bus it would reach is that one (`DBUS_SESSION_BUS_ADDRESS` the same), never on a bare flag.
dbus-run-session -- bash -c '
  od -An -N16 -tx1 /dev/urandom | tr -d " \n" | gnome-keyring-daemon --unlock --components=secrets >/dev/null
  export CLOVER_PRIVATE_SECRET_SERVICE="$DBUS_SESSION_BUS_ADDRESS"
  exec "$@"
' with-private-secret-service "$@" || status=$?
exit "$status"
