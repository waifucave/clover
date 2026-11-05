#!/usr/bin/python3
"""Non-secret protocol fixture, on a private bus; never connects to the login bus."""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time

import dbus
import dbus.service
from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib

SERVICE = 'org.freedesktop.secrets'
ROOT = '/org/freedesktop/secrets'
ITEM = ROOT + '/collection/clover/item1'
INTERFACE = 'org.freedesktop.Secret.Service'


class Fixture(dbus.service.Object):
    # This deliberately returns public integers, never a secret or key.
    @dbus.service.method(INTERFACE, in_signature='aoo', out_signature='u')
    def GetSecrets(self, items, session):
        return dbus.UInt32(1 if ITEM in items else 0)


def main():
    DBusGMainLoop(set_as_default=True)
    if len(sys.argv) > 1 and sys.argv[1] == 'service':
        bus = dbus.SessionBus()
        name = dbus.service.BusName(SERVICE, bus)
        fixture = Fixture(bus, ROOT)
        print('fixture-ready', flush=True)
        GLib.MainLoop().run()
        return
    with tempfile.TemporaryDirectory(prefix='clover-proxy-') as tmp:
        private = subprocess.Popen(['dbus-daemon', '--session', '--nofork', '--print-address'], stdout=subprocess.PIPE, text=True)
        address = private.stdout.readline().strip()
        env = dict(os.environ, DBUS_SESSION_BUS_ADDRESS=address, HOME=tmp, XDG_RUNTIME_DIR=tmp)
        service = subprocess.Popen(['/usr/bin/python3', __file__, 'service'], env=env, stdout=subprocess.PIPE, text=True)
        proxy = None
        try:
            assert service.stdout.readline().strip() == 'fixture-ready'
            socket = tmp + '/proxy'
            # Only the common GetSecrets method at the root is admitted.
            # No Item method and no Clover collection/object path is admitted.
            proxy = subprocess.Popen(['xdg-dbus-proxy', address, socket, '--filter',
                '--call=' + SERVICE + '=' + INTERFACE + '.GetSecrets@' + ROOT])
            for _ in range(100):
                if pathlib.Path(socket).exists():
                    break
                time.sleep(.02)
            bus = dbus.bus.BusConnection('unix:path=' + socket)
            obj = bus.get_object(SERVICE, ROOT, introspect=False)
            result = int(obj.GetSecrets(dbus.Array([dbus.ObjectPath(ITEM)], signature='o'),
                dbus.ObjectPath(ROOT + '/session/public'), dbus_interface=INTERFACE))
            try:
                obj.Ping(dbus_interface='org.freedesktop.systemd1.Manager', timeout=2)
                unrelated_denied = False
            except dbus.DBusException as error:
                unrelated_denied = error.get_dbus_name() == 'org.freedesktop.DBus.Error.AccessDenied'
            output = {'test': 'xdg-dbus-proxy-body-filter', 'private_bus': True,
                'public_fixture_only': True, 'clover_item_argument_forwarded': result == 1,
                'unrelated_interface_denied': unrelated_denied,
                'verdict': 'method/path filter does not filter item paths in message bodies'}
            print(json.dumps(output, sort_keys=True))
            assert result == 1 and unrelated_denied
            if '--bwrap' in sys.argv:
                client = ('import dbus; b=dbus.bus.BusConnection("unix:path=/tmp/proxy"); '
                    'o=b.get_object("' + SERVICE + '","' + ROOT + '",introspect=False); '
                    'assert int(o.GetSecrets(dbus.Array([dbus.ObjectPath("' + ITEM + '")],signature="o"),'
                    'dbus.ObjectPath("' + ROOT + '/session/public"),dbus_interface="' + INTERFACE + '"))==1; '
                    'print("bubblewrap-proxy-item-argument-forwarded")')
                checked = subprocess.run(['bwrap', '--die-with-parent', '--new-session', '--unshare-all',
                    '--ro-bind', '/', '/', '--tmpfs', '/tmp', '--tmpfs', '/run', '--proc', '/proc',
                    '--dev', '/dev', '--ro-bind', socket, '/tmp/proxy', '--', '/usr/bin/python3', '-c', client],
                    capture_output=True, text=True, timeout=10)
                print(json.dumps({'test': 'bubblewrap-plus-proxy', 'exit': checked.returncode,
                    'item_argument_forwarded': 'bubblewrap-proxy-item-argument-forwarded' in checked.stdout,
                    'diagnostic': checked.stderr[:400]}))
                assert checked.returncode == 0
        finally:
            for process in (proxy, service, private):
                if process is not None:
                    process.terminate()
                    process.wait(timeout=5)


if __name__ == '__main__':
    main()
