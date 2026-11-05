# S9 retained CI evidence

Three GitHub Actions runs are kept here, so the report's numbers can be rechecked after the CI artifacts expire (14 days). JSON files are the run's own output, unedited. Interpret them with the [report](../../../docs/research/2026-11-05-s9-layers.md). A green job only means the experiment completed; the outcome is each file's `verdict` and, for the network check, its `assertions`.

## `run-42018941532/`: the belt and stub run

[Run 42018941532](https://github.com/waifucave/clover/actions/runs/42018941532), tested commit `115ca242f`, Electron 45.2.3 (Chromium 156.0.8078.80), all three jobs green. This is the run that adds the two containment probes for M0. Per runner (`macos-15`, `ubuntu-24.04`, `windows-2025`):

* `network.json`: all nine variants, including **belt** (black-hole PAC + `disable_non_proxied_udp` + `Connection-Allowlist`) and **stub** (preload that strips the WebRTC constructors), each with its listener records, webRequest log, mount-token checks, inherited contexts and the harness's resolver extract; then the cross-variant `assertions`, `probes` and `verdict`.
* `netlog-extract.json`: per variant, WebRTC P2P sockets and datagrams, TCP connects and resolver lookups from that variant's raw netlog, labeled by fixture. Made from the downloaded artifact with `node netlog-extract.mjs <artifact-dir> 42018941532` in `prototype/`, which launches nothing.
* `process.json`, `memory-*.json`, `crossing.json`: the same checks as the earlier run, kept complete so this run is self-contained.

Not committed: the menu screenshots, the raw netlogs (they hold the runner's own addresses), and the `network-variant-*.json` files, each a copy of one entry in `network.json`.

## `run-41991516521/`: the seven-variant run

[Run 41991516521](https://github.com/waifucave/clover/actions/runs/41991516521), tested commit `d2fc33e8f`, Electron 45.2.3 (Chromium 156.0.8078.80), all three jobs green. Per runner (`macos-15`, `ubuntu-24.04`, `windows-2025`):

* `process.json`: frame and process listings, Node exposure, and the independent and related second windows.
* `memory-1.json`, `memory-5.json`, `memory-10.json`, `memory-20.json`: three private-memory samples per renderer, joined by Electron's OS process IDs.
* `crossing.json`: CDP typing, Tab and Shift-Tab, composition, the host's focus return, the OS-level shortcut (XTEST on Ubuntu, SendKeys on Windows, none on macOS), the source-to-target drag and IntersectionObserver v2.
* `network.json`: all seven variants (control, CSP, filter, combined, combined plus `Connection-Allowlist`, IP-handling policy, non-plugin), each with its listener records, webRequest log, CSP violations, mount-token checks, hostile embeds, inherited contexts, and the harness's resolver extract; then the cross-variant `assertions` and `verdict`.
* `netlog-extract.json`: per variant, WebRTC P2P sockets and datagrams, QUIC datagrams, TCP connects and resolver lookups from that variant's raw netlog, labeled by fixture. Made from the downloaded artifact with `node netlog-extract.mjs <artifact-dir> 41991516521` in `prototype/`, which launches nothing.

Not committed: the menu screenshots, the raw netlogs (they hold the runner's own addresses), and the `network-variant-*.json` files, each a copy of one entry in `network.json`.

## `run-41942765712/`: the original run

[Run 41942765712](https://github.com/waifucave/clover/actions/runs/41942765712), tested commit `12ca3e48fc2ee614d699d45092f1c87d3e83291b`. Its process and memory results stand and match the final run. Its network reading was corrected in review (report §4.1): DNS prefetch leaked resolver intent, link prefetch stayed inside the boundary, the command-line WebRTC switch never applied, and STUN went to a declared address. `original-resolver-extract.json` keeps the speculative resolver events decoded from that run's netlogs.

## Reading notes

* Mount tokens, fixture ports and process IDs are random per run.
* The Linux preload reports a PID-namespace ID; joins use Electron's `senderFrame.osProcessId`.
* Values such as `15.6.75.27-electron.0` are version strings (V8, zlib), not addresses.
* Ubuntu's `network.json` names Google CDN hosts and addresses: Electron's Hunspell dictionary download, made by the browser process for the plugin session (report §4.3). It happens on Windows too, for any language the Windows spellchecker lacks, and is not confined to the plugin session, so every session (the default included) must have spellcheck off or redirected before a no-off-machine-traffic assertion holds.
