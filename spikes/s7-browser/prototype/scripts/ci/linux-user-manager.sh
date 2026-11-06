#!/bin/bash
# Give the CI user a systemd --user manager (lingering), as a desktop login would, and export its environment for
# later steps. CI only.
set -euo pipefail
sudo loginctl enable-linger "$USER"
uid="$(id -u)"
for _ in $(seq 1 60); do [ -S "/run/user/$uid/bus" ] && break; sleep 0.5; done
ls -la "/run/user/$uid" || true
echo "XDG_RUNTIME_DIR=/run/user/$uid" >> "$GITHUB_ENV"
echo "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus" >> "$GITHUB_ENV"
XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" systemctl --user is-system-running || true
