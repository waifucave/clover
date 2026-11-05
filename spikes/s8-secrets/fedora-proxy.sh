#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
printf 'Testing the private-bus proxy on Fedora; the kernel and SELinux host remain Ubuntu\n'
sudo podman run --rm -i docker.io/library/fedora:45 sh -c '
set -eu
cat /etc/fedora-release
dnf install -y xdg-dbus-proxy dbus-daemon python3-dbus python3-gobject-base >/tmp/clover-install.log 2>&1
xdg-dbus-proxy --version
cat > /tmp/clover-proxy-probe.py
exec python3 /tmp/clover-proxy-probe.py
' < proxy-probe.py
