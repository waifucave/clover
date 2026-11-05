# S8 isolated secrets and agent sandbox probes

All commands below run from the repository root. No command invokes `claude`, signs in,
calls a model, accesses the login Keychain, or starts an application window. Public file
and D-Bus fixtures contain no secrets. Real test keys and the Windows test-user password
are generated in memory, never placed in arguments or logs. Only encrypted test-store
contents reach disk, and their temporary stores are removed.

On Ubuntu install `bubblewrap xdg-dbus-proxy dbus-daemon python3-dbus python3-gi gcc git
python3-cryptography gnome-keyring libsecret-tools`; these checks need no real keyring:

```sh
python3 spikes/s2-windows-fence/remote.py linux spikes/s8-secrets/linux-fence.py
```

```sh
python3 spikes/s2-windows-fence/remote.py linux spikes/s8-secrets/proxy-probe.py -- --bwrap
```

```sh
python3 spikes/s2-windows-fence/remote.py linux spikes/s8-secrets/linux-store.py
```

Fedora 45 userland protocol check (requires podman; **not** Fedora host security validation):

```sh
python3 spikes/s2-windows-fence/remote.py linux spikes/s8-secrets/fedora-proxy.sh
```

Windows OS store check, including password `LogonUser` type 2, loaded profile and impersonation
of a newly created local user; needs administrator rights **inside the disposable VM**:

```sh
python3 spikes/s2-windows-fence/remote.py windows spikes/s8-secrets/windows-store.ps1
```

This uses neither a desktop interaction nor a model. It compares DPAPI and Credential Manager
in memory and reports booleans/error codes only. The temporary credential targets, user and
profile are removed. It is not a scheduled-task or GUI-logon validation.

Install the pinned standalone Anthropic runtime on this Mac:

```sh
npm install --prefix spikes/s8-secrets/.deps --ignore-scripts --no-audit --no-fund @anthropic-ai/sandbox-runtime@0.0.81
```

```sh
python3 spikes/s8-secrets/srt-probe.py
```

With Codex 0.166.0 on PATH, use only its sandbox entry point and a temporary `CODEX_HOME`:

```sh
python3 spikes/s8-secrets/codex-probe.py
```

Repeat both standalone checks on Ubuntu (requires npm, node, socat, ripgrep, bubblewrap):

```sh
python3 spikes/s2-windows-fence/remote.py linux spikes/s8-secrets/linux-agents.sh
```

The proxy test deliberately demonstrates a **negative result**: a permitted root method
forwards an item path in the message body even though no method on that item is permitted.
It uses a minimal fake interface returning a public integer, not a complete Secret Service
implementation. The protocol risk, not real credential theft, is tested.

The Linux fence is a narrow disposable mount fixture, not the final home/temp policy. It
shows hiding host content, not denying every read syscall: a masked file reads as empty and
a masked run directory has private contents. It deliberately exposes no host credential,
Docker, SSH-agent, desktop, session-bus or system-bus sockets. Tool login compatibility
therefore remains unproven. Tests do not create or test the plaintext-key fallback.

See [the report](../../docs/research/2026-11-05-s2-s8-fence-and-secrets.md) for verdicts,
the stop condition, missing gates and the distinction between runtime and agent integration.
