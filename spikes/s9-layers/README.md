# Clover S9 layers

Standalone package: `prototype/` is below the root `spikes/*` workspace glob. Its own npm lockfile leaves the root workspaces and lockfiles untouched. Electron remains pinned to **45.2.3 / Chromium 156.0.8078.80**, the stable version verified for the original spike; keeping it fixed makes the review rerun comparable. See the [report](../../docs/research/2026-11-05-s9-layers.md) and [retained evidence](evidence/README.md).

## Local checks — launch nothing

From `spikes/s9-layers/prototype`:

```sh
npm ci --ignore-scripts --workspaces=false
npm run typecheck
npm test
```

Strict TypeScript checking and Node tests use no Electron runtime. Never require Electron, run its install script, launch browsers, or run the spike locally. Both launcher guards reject non-CI execution before requiring Electron. The harness has no secret-store implementation or credentials; TURN uses only dummy fixture strings. Fresh CI temporary homes and in-memory sessions isolate all processes.

## One command per CI check

The workflow downloads Electron explicitly with `node node_modules/electron/install.js`. These commands are **CI only**; Linux wraps each in `xvfb-run -a`:

```sh
npm run process
npm run memory
npm run crossing
npm run network
```

`npm run all` runs them sequentially. Individual Electron children have a three-minute deadline; the attributed network matrix has a seven-minute deadline. All listeners bind **127.0.0.1**. Distinct `*.s9.test` fixture names are mapped to loopback by CI host-resolver rules; DNS/STUN/TURN names use unique `*.localhost` labels. No outside account or network service is contacted by the probes. Dependencies, Electron, action downloads and Ubuntu's xdotool setup are normal CI installation traffic.

The branch/main push workflow uses Node 24 actions pinned by SHA. It remains a gate on `main`, `lane/e-m0` and `lane/e-m1`, and on changes to the spike or workflow. Dispatch is restricted at job level to those branches. Every Electron upgrade must update the spike's pin and run this suite.

## Results and interpretation

CI uploads JSON, screenshots and netlogs as `clover-s9-<runner>`. JSON embeds the tested commit, platform, architecture and versions. Raw results retained in `evidence/` distinguish original and revised runs. Original speculative resolver extracts are committed before netlog artifact expiry. Harness errors fail CI; a completed empirical negative experiment still uploads a negative JSON verdict. A green job alone is not boundary acceptance.

* **Process:** Electron frame/process listings; child and repeated-origin frames; separate schemes for core/sealed origins; independent and related-window PID comparisons. Measurement-only sandboxed preloads use `nodeIntegrationInSubFrames`, expose no callable bridge, and join samples by authoritative Electron OS PIDs, not Linux namespace PIDs.
* **Memory:** three private-KiB samples at 1/5/10/20 plugin layers. Renderer totals include trusted root, main is separate. GPU/utility private totals remain unavailable uniformly; RSS is not substituted. Minimal fixture numbers exclude real React, transcript, avatar and audio allocations. See the report for slopes, main growth and Windows variance.
* **Input:** CDP `dispatchKeyEvent`, `insertText`, `imeSetComposition`, source `dragIntercepted` and target drop, Tab/Shift-Tab, overlay focus restoration, and nested IntersectionObserver v2. Ubuntu adds xdotool XTEST input through the known native XID. These are synthetic CI checks, not hardware approval authorization or native IME candidate-window/file-drag tests.
* **Network:** control, CSP, filter, combined, **combined plus Connection-Allowlist**, an actual per-webContents IP-policy variant, and a non-plugin control. Every vector/context has its own name and port. Two plugins with different exact origin/port grants share one session. STUN cookie/source-port records, TURN/TCP bytes, WebTransport UDP, session preconnect events, CSP violations, filter decisions, canceled downloads, navigation/popup guards and **netlog parsing inside the harness** establish attribution. Positive controls are prerequisites for a successful verdict; constructor presence is not a failure.

Plugin documents require core-issued mount tokens and restrict `frame-ancestors` and `frame-src`. Worker responses carry the same Connection-Allowlist and cannot be framed as UI documents. Inherited nested/srcdoc/opaque/about:blank contexts are probed separately. Dedicated/shared/blob workers are tested; service-worker privileges are deliberately not granted. Missing worker APIs are reported as unsupported, never as measured suppression. Host popup/navigation guards remain separately attributed defenses.

The original report's network conclusion is superseded: link prefetch stayed within the host boundary; DNS prefetch leaked resolver intent; the command-line IP policy never applied; original STUN targeted the declared address. Candidate disabling flags were removed. All revised closures are per document or per webContents; the process-wide resolver rules are fixture routing only, and site isolation remains on. The same application tests that a non-plugin webContents keeps networking.

The report names Electron patch / intercepted https fallbacks if Connection-Allowlist does not take effect on custom-scheme documents. No fallback is implemented or assumed necessary without the attributed evidence.
