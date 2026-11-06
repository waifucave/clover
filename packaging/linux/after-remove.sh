#!/bin/bash
# The deb's and the rpm's after-remove script, electron-builder's own for the `clover` link after-install.sh makes and
# the AppArmor profile. electron-builder fills in the executable's and the product's names.
#
# A user's login start (a systemd user unit running clover-core supervise, lane C's) is out of reach here: this runs
# as root, outside every user's session. The unit has to stay inert once its binary is gone (packaging/installer-
# hooks.ts), and `clover autostart remove` removes it for good.

# Only on a real removal. An upgrade runs the old package's script too: the deb's postrm with `upgrade`, and the rpm's
# %postun with 1 after the new package's %post, which would delete the link and the profile the new version just made.
case "${1:-}" in
  remove|purge|0) ;;
  *) exit 0 ;;
esac

CLI='/opt/${sanitizedProductName}/resources/daemon/clover-core'

if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove 'clover' "$CLI"
else
    rm -f '/usr/bin/clover'
fi

# The install marker after-install.sh wrote beside the binary (no package owns it).
rm -f "$(dirname "$CLI")/install.json"

APPARMOR_PROFILE_DEST='/etc/apparmor.d/${executable}'

# Unload the profile before deleting it, so it isn't left enforced until the next reboot; not inside a chroot.
if [ -f "$APPARMOR_PROFILE_DEST" ]; then
  if apparmor_status --enabled > /dev/null 2>&1; then
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --remove "$APPARMOR_PROFILE_DEST" || true
    fi
  fi
  rm -f "$APPARMOR_PROFILE_DEST"
fi
