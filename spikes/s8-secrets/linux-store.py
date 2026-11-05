#!/usr/bin/python3
"""Private Secret Service + AES-GCM; plaintext values remain in process memory."""
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time
import dbus
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

with tempfile.TemporaryDirectory(prefix='clover-secret-store-') as tmp:
    private = subprocess.Popen(['dbus-daemon', '--session', '--nofork', '--print-address'], stdout=subprocess.PIPE, text=True)
    address = private.stdout.readline().strip()
    env = {'PATH': '/usr/bin:/bin', 'HOME': tmp, 'XDG_DATA_HOME': tmp + '/data',
        'XDG_CONFIG_HOME': tmp + '/config', 'XDG_RUNTIME_DIR': tmp,
        'DBUS_SESSION_BUS_ADDRESS': address, 'GNOME_KEYRING_CONTROL': tmp + '/control'}
    keyring = subprocess.Popen(['gnome-keyring-daemon', '--foreground', '--unlock', '--components=secrets',
        '--control-directory=' + tmp + '/control'], env=env, stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    # New keyring's password exists only in memory and the daemon's stdin.
    keyring.stdin.write(secrets.token_urlsafe(32).encode())
    keyring.stdin.close()
    try:
        bus = dbus.bus.BusConnection(address)
        for _ in range(100):
            if bus.name_has_owner('org.freedesktop.secrets'):
                break
            time.sleep(.05)
        key = AESGCM.generate_key(bit_length=256)
        encoded = key.hex().encode()
        def tool(args, value=None):
            return subprocess.run(['secret-tool'] + args, env=env, input=value,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
        print('Running private Secret Service encrypted-file roundtrip', flush=True)
        store = tool(['store', '--label=Clover isolated test', 'application', 'com.waifucave.clover.test'], encoded)
        if store.returncode:
            print(json.dumps({'test': 'private-secret-service', 'store_exit': store.returncode}))
            raise SystemExit(1)
        lookup = tool(['lookup', 'application', 'com.waifucave.clover.test'])
        assert lookup.returncode == 0 and lookup.stdout.strip() == encoded
        plain = secrets.token_bytes(64)
        nonce = secrets.token_bytes(12)
        ciphertext = AESGCM(key).encrypt(nonce, plain, b'com.waifucave.clover.test.v1')
        path = Path(tmp) / 'secrets.enc'
        path.write_bytes(nonce + ciphertext)
        recovered = bytes.fromhex(lookup.stdout.strip().decode())
        assert AESGCM(recovered).decrypt(nonce, path.read_bytes()[12:], b'com.waifucave.clover.test.v1') == plain
        tamper = bytearray(ciphertext)
        tamper[-1] ^= 1
        try:
            AESGCM(recovered).decrypt(nonce, bytes(tamper), b'com.waifucave.clover.test.v1')
            rejected = False
        except Exception:
            rejected = True
        tool(['clear', 'application', 'com.waifucave.clover.test'])
        print(json.dumps({'test': 'private-secret-service', 'key_roundtrip': True,
            'encrypted_file_roundtrip': True, 'ciphertext_bytes': path.stat().st_size,
            'tamper_rejected': rejected, 'real_login_bus_used': False}))
        assert rejected
    finally:
        for proc in (keyring, private):
            proc.terminate()
            proc.wait(timeout=5)
