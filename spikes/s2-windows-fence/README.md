# S2 Windows compatibility measurements

Run from the repository root. These are disposable-VM experiments, **not a production fence**.
Windows Server 2025 build 26100 is a surrogate; Windows 11 remains live gate 3.

Install prerequisites in the named Windows VM (Git for Windows must already be installed):

```sh
python3 spikes/s2-windows-fence/remote.py windows spikes/s2-windows-fence/install-tools.ps1
```

Measure five token postures, seven operations each:

```sh
python3 spikes/s2-windows-fence/remote.py windows spikes/s2-windows-fence/check.ps1
```

On a disposable Windows runner with Git, Node and Bun at the paths in `check.ps1`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File spikes/s2-windows-fence/check.ps1
```

The native source defaults to the sibling uploaded by `remote.py`; on a checkout it falls
back to `native/sandbox/windows-probe.cs`. The transport accepts only the two named VMs
and uses SSH, not additional cloud operations. Its payload is public source only.

`privileges` removes privileges, but does **not** confine filesystem writes. `privileges-low`
adds low integrity. `restricted` and `low` also use `WRITES_RESTRICTED` and the well-known
Restricted Code SID. `appcontainer` has no capabilities. The fixture grants its directory
to the two test identities and removes its AppContainer profile and files afterwards.
Results are JSON lines interspersed with public command diagnostics. A zero script exit
means measurements completed; the individual `exit` fields determine compatibility.

The helper does not provision a private object namespace, job object, service/RPC policy,
network enforcement, or a persistent escape floor. No caller may use it to run untrusted
commands. Fixed native launch failures cannot establish that all designs fail.

See [the report](../../docs/research/2026-11-05-s2-s8-fence-and-secrets.md) and
[`results/windows-compatibility.txt`](results/windows-compatibility.txt).

Controlled original-user token/default-DACL/private-desktop comparison:

```sh
python3 spikes/s2-windows-fence/remote.py windows spikes/s2-windows-fence/diagnostics.ps1
```

Install the pinned standalone native candidate and required VC runtime in the disposable VM:

```sh
python3 spikes/s2-windows-fence/remote.py windows spikes/s2-windows-fence/setup-candidate.ps1
```

```sh
python3 spikes/s2-windows-fence/remote.py windows spikes/s2-windows-fence/install-vcrt.ps1
```

Provision only the test principal, its WFP policy and no user-profile read grant:

```sh
python3 spikes/s2-windows-fence/remote.py windows spikes/s2-windows-fence/provision-candidate.ps1
```

The unmodified Session 0 launch is a separate failure measurement:

```sh
python3 spikes/s2-windows-fence/remote.py windows spikes/s2-windows-fence/run-candidate.ps1
```

Evaluate the candidate with a temporary Session 0 namespace diagnostic, including broker routes,
aliases, normal/approved-escape floors and network, plus detached-child cleanup:

```sh
python3 spikes/s2-windows-fence/remote.py windows spikes/s2-windows-fence/run-session0-candidate.ps1
```

The namespace alias is not an admitted production fix. The out-of-process COM result is
inconclusive; scripts print measurements, not a release-admission verdict. Use the S8 cleanup
command after the disposable VM experiments. `remote.py` uploads public source in bounded
chunks, preventing cmd.exe length limits and overlapping stdin transports.

Review follow-up: paired unfenced/local-admin controls, prepared Startup directories,
COM child receipts and deliberate inherited/duplicated public-canary handles:

```sh
python3 spikes/s2-windows-fence/remote.py windows spikes/s2-windows-fence/review-routes.ps1
```

The tests record both outcomes. A failed unfenced control is not counted as a fence denial.
The user-Startup write was accepted after its directory was materialized; the original
missing-directory denial must not be used as security evidence. `handle-probe.cs` deliberately
passes inheritable canary handles to the first broker hop, bypassing Node's own filtering, then
tests the actual sandbox child. Only public fixture contents are used.

Normalize result files before committing; CI checks that normalization is current:

```sh
python3 spikes/s2-windows-fence/normalize-results.py
```
