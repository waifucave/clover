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
export CLOVER_PRIVATE_SECRET_SERVICE=1
status=0
# Inside the private bus: create and unlock a login keyring with an empty password (it dies with the bus), start
# its Secret Service, then run the command.
dbus-run-session -- bash -c '
  printf "" | gnome-keyring-daemon --unlock --components=secrets >/dev/null
  gnome-keyring-daemon --start --components=secrets >/dev/null
  exec "$@"
' with-private-secret-service "$@" || status=$?
exit "$status"
