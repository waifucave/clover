# Clover S9 layers

Standalone package: `prototype/` sits below the root `spikes/*` workspace glob and has its own npm lockfile, so the root workspaces and lockfiles are untouched. Electron is pinned to **45.2.3 (Chromium 156.0.8078.80)**, the stable release when the spike started; keeping it fixed keeps every rerun comparable. See the [report](../../docs/research/2026-11-05-s9-layers.md) and the [retained evidence](evidence/README.md).

## Local checks: launch nothing

From `spikes/s9-layers/prototype`:

```sh
npm ci --ignore-scripts --workspaces=false
npm run typecheck
npm test
node netlog-extract.mjs <downloaded-artifact-dir> [run-id] > netlog-extract.json
```

Strict TypeScript checking and the Node tests need no Electron runtime. `netlog-extract.mjs` reads a downloaded CI artifact and prints socket and resolver counts per variant; it keeps loopback fixture ports and counts only. Never require Electron, run its install script, launch browsers or run the spike locally: both launcher guards refuse to run outside the S9 CI job before they load Electron. The harness has no secret store and no credentials; TURN uses dummy fixture strings. Each Electron process gets a fresh temporary home and in-memory sessions.

## One command per CI check

The workflow downloads Electron explicitly with `node node_modules/electron/install.js`. These commands are **CI only**; Linux wraps each in `xvfb-run -a`:

```sh
npm run process
npm run memory
npm run crossing
npm run network
```

`npm run all` runs them in order. Each Electron child has a three-minute deadline; the network matrix has seven minutes. All listeners bind **127.0.0.1**. CI host-resolver rules map the distinct `*.s9.test` fixture names to loopback; DNS, STUN, TURN and remote-candidate fixtures use unique `*.localhost` names. The probes contact no outside account or service. Installing dependencies, Electron, the actions and Ubuntu's xdotool is ordinary CI traffic, and Electron's own spellcheck dictionary download on Linux is recorded as a finding, not a probe.

The workflow runs on pushes to `main`, `lane/e-m0` and `lane/e-m1` that touch the spike, the workflow or the desktop app's manifests, and by dispatch on those branches only. Its actions are pinned by SHA. Every Electron upgrade updates this spike's pin and reruns it; `run.mjs` refuses to run if the desktop app's Electron pin differs.

## What each check records

* **Process:** Electron's frame and process listings; a child origin and a repeated origin; core and sealed documents on their own schemes; an independent and a related second window. The measurement-only sandboxed preload exposes no callable bridge, and samples are joined by Electron's OS process IDs, not Linux namespace PIDs.
* **Memory:** three private-memory samples at 1, 5, 10 and 20 plugin layers. Renderer totals include the trusted root; main is separate. GPU and utility private memory isn't exposed uniformly, and RSS is not substituted. The fixture has no React, transcript, avatar or audio.
* **Input:** CDP through `webContents.debugger` (`Input.dispatchKeyEvent`, `insertText`, `imeSetComposition`, `setInterceptDrags` and the target drop); Tab and Shift-Tab; the host returning focus after its own overlay; an OS-level Ctrl+K with a plugin field focused (XTEST on Ubuntu, SendKeys on Windows), watched by `before-input-event`; IntersectionObserver v2 in a nested frame. These are CI checks, not hardware approval, native IME windows or OS file drags.
* **Network:** control, CSP, filter, combined, **combined plus `Connection-Allowlist`**, the per-webContents IP-handling policy, and a non-plugin control. Every vector and context has its own name and port: fetch, XHR, images, CSS, fonts, scripts, media, WebSocket, WebTransport, EventSource, beacons, keepalive, `fetchLater`, `<a ping>`, redirects, workers, popups, forms, navigation, `top.location`, downloads, every hint, STUN, TURN over TCP, and remote ICE candidates. Two plugins with different grants share one session. Listener records (STUN cookie, source ports, TURN bytes), session `preconnect` events, CSP violations, filter decisions, mount-token refusals, hostile embeds and the netlogs, decoded inside the harness, attribute each result. Positive controls are required for a passing verdict, and an API that exists is not a failure.

Plugin documents load only through single-use mount tokens issued by the core, with `frame-ancestors` and `frame-src` restricted. Worker scripts carry the same `Connection-Allowlist` and can't be framed. The nested, srcdoc, sandboxed srcdoc and about:blank contexts and a worker are probed separately. Service workers are deliberately not granted to the plugin scheme. All closures are per document or per webContents; the process-wide resolver rules only route fixtures, and site isolation stays on.

## Result in one line

`Connection-Allowlist` takes effect on `clover-plugin:` documents in stock Electron 45. With CSP and the `initiatorOrigin` filter it stops every request-based way out, DNS prefetch and ICE servers on all three OSes. It does not stop a remote ICE candidate: a directly mounted plugin document, or a sandboxed srcdoc inside it, still sends connectivity checks to any address. In frames that stay in a restricted parent document's process, Chromium 156 enforces it by killing the plugin's renderer. The report's recommendation, a lane-M Electron patch that needs the owner's agreement, covers both.
