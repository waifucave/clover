# Clover S9 layers

Standalone package: `prototype/` is deliberately one level below `spikes/*`, outside the root workspaces. Do not change the root lockfiles. Electron is pinned to 45.2.3, the current stable verified November 5, 2026. It includes `webRequest.initiatorOrigin` (introduced in 45 / backported stable branches), which this spike needs. See https://releases.electronjs.org/release?channel=stable and https://www.electronjs.org/docs/latest/api/web-request.

## Local checks (launch nothing)

From `spikes/s9-layers/prototype`:

```sh
npm ci --ignore-scripts --workspaces=false
npm run typecheck
npm test
```

Never require Electron, run its install script, launch a browser or launch the spike on the owner's Mac. `run.mjs` and `main.cjs` reject non-CI invocation before loading Electron. The npm installation above installs types and JavaScript only. No root scripts are used.

## CI checks

The push workflow `.github/workflows/spike-s9.yml` installs the binary explicitly using `node node_modules/electron/install.js`. The following commands are for that job only; Linux wraps each command in `xvfb-run -a`:

```sh
npm run process
npm run memory
npm run crossing
npm run network
```

`npm run all` runs all four sequentially. Every Electron child has a three-minute timeout and a fresh temp home, in-memory session and no secret-store integration. Network probes use only ephemeral loopback HTTP/WebSocket and UDP fixture listeners. No outside service or account is contacted by the runtime probes. Dependencies and Electron downloads are ordinary CI setup traffic.

Each runner uploads JSON plus menu screenshots and fixture-only Chromium netlogs as `clover-s9-<runner>`. The platform, architecture, Electron/Chromium versions and tested commit are embedded in JSON. Harness errors exit nonzero; an empirical negative verdict is still an uploaded successful experiment, not an assertion that the design passed.

## Reading results

* `process.json`: Electron frame tree (`processId`, `osProcessId`, routing IDs), app process listing, repeated same-origin p2 frames and a nested child origin. Distinct plugin hosts must have distinct OS PIDs; repeated p2 frames must share their plugin's PID. `typeof require` is checked per frame.
* `memory-{1,5,10,20}.json`: three samples per process, private KiB from Electron's `process.getProcessMemoryInfo()`, renderer totals, trusted root and main separately, app process metrics. The preload exists only for measurement, runs with sandbox and context isolation, exposes no callable bridge and samples every 500 ms. `nodeIntegrationInSubFrames` is enabled solely to run that measurement preload. These numbers are a minimal fixture baseline, not a production memory budget. Renderer-private totals are not total app RSS or total machine memory. GPU/utility metrics retain their platform-specific fields.
* `crossing.json`: focus and text input, Tab traversal and host shortcut observation, CDP drop delivery. Screenshots show a clipped child menu and a trusted-root overlay. This is synthetic CI input; native file dragging, drag initiation, accessibility and real IME composition require live gates.
* `network.json`: control, CSP-only, filter-only and combined variants with renderer outcomes, CSP violations, request decisions (including initiator), server hits, TCP counts, popup/navigation guards and UDP STUN observations. Images/fonts intentionally need request/hit evidence: decode success is not used to judge enforcement. Workers have a CSP response too. Missing/opaque initiators fail closed in filtered variants. All network destinations are rechecked, including redirect targets. Popup/navigation guards are additional host help, distinct from the four spec checks.

Candidate Chromium flags and `X-DNS-Prefetch-Control: off` are included, but are **not** proof that WebRTC or all speculative traffic is disabled. Netlogs and the UDP probe reveal gaps. A missing request or a timeout is not automatically a successful block. Controls distinguish unsupported APIs and fixture limitations. No claim is made about sealed-card hardware clicks, real themes, OS overlap or security against a compromised renderer.
