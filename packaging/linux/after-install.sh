#!/bin/bash
# The deb's and the rpm's after-install script. electron-builder fills in the executable's and the product's names
# (every dollar-brace macro here must be one it knows, or the build fails).
# It does what electron-builder's own does (the Chromium sandbox helper, the MIME and desktop databases, and the
# AppArmor profile Ubuntu needs for Electron's sandbox, spec §4), except for one thing: `clover` on the PATH is
# the daemon's command line, `resources/daemon/clover-core`, as on macOS. The app itself starts from its desktop entry.
#
# It never turns on login start: it runs as root, outside every user's session. The app does that at its first
# launch (spec §3.1, packaging/installer-hooks.ts).

CLI='/opt/${sanitizedProductName}/resources/daemon/clover-core'

if type update-alternatives >/dev/null 2>&1; then
    # Remove a previous link that doesn't use update-alternatives
    if [ -L '/usr/bin/clover' -a -e '/usr/bin/clover' -a "`readlink '/usr/bin/clover'`" != '/etc/alternatives/clover' ]; then
        rm -f '/usr/bin/clover'
    fi
    update-alternatives --install '/usr/bin/clover' 'clover' "$CLI" 100 || ln -sf "$CLI" '/usr/bin/clover'
else
    ln -sf "$CLI" '/usr/bin/clover'
fi

# The SUID Chromium sandbox helper only where the kernel has no working user namespaces.
if ! { [[ -L /proc/self/ns/user ]] && unshare --user true; }; then
    chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
else
    chmod 0755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

# The AppArmor profile (Ubuntu 24.04 and later restrict unprivileged user namespaces, which Electron's sandbox
# needs). Installed only where this AppArmor can parse it (abi/4.0), and loaded only outside a chroot.
if apparmor_status --enabled > /dev/null 2>&1; then
  APPARMOR_PROFILE_SOURCE='/opt/${sanitizedProductName}/resources/apparmor-profile'
  APPARMOR_PROFILE_TARGET='/etc/apparmor.d/${executable}'
  if apparmor_parser --skip-kernel-load --debug "$APPARMOR_PROFILE_SOURCE" > /dev/null 2>&1; then
    cp -f "$APPARMOR_PROFILE_SOURCE" "$APPARMOR_PROFILE_TARGET"
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      # A profile that parses can still fail to load (a nested container): the package installs regardless.
      apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE_TARGET" || true
    fi
  else
    echo "Skipping the AppArmor profile: this AppArmor can't parse it"
  fi
fi
