## Spike S7 results

### Chrome for Testing · linux-arm64 (cft-linux-arm64-apparmor.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 0 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 121 MiB archive, 277 MiB unpacked, 287 files, 0 symlinks; download 557 ms, unpack 966 ms; sha256 `5bb6a00a4285c13303d3f72c5afdb70f144ea7a93eed462365a52b69631c9607` (trust on first use; server MD5 true)
- start: cold 58 ms, warm 54 ms over the pipe; port 63 ms

### Chrome for Testing · linux-arm64 (cft-linux-arm64.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 231 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox off (--no-sandbox: the sandboxed start failed) (sandboxed start failed: browser exited (SIGTRAP) during Browser.getVersion)

- install: 121 MiB archive, 277 MiB unpacked, 287 files, 0 symlinks; download 557 ms, unpack 966 ms; sha256 `5bb6a00a4285c13303d3f72c5afdb70f144ea7a93eed462365a52b69631c9607` (trust on first use; server MD5 true)
- start: cold 1208 ms, warm 32 ms over the pipe; port 53 ms
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 175 MiB, per idle tab 23 MiB, 4 browser contexts +95 MiB, a second bot's browser 113 MiB (6 processes), animated tab 52.1% CPU
  - steps: 0 tabs 175 MiB pss / 0.0%, 1 tabs 210 MiB pss / 2.2%, 2 tabs 234 MiB pss / 4.2%, 4 tabs 276 MiB pss / 8.7%, 8 tabs 361 MiB pss / 16.9%
- errors: tabs: Runtime.evaluate timed out; screenshots: browser gone (Page.captureScreenshot)

**chrome** — Chrome/156.0.8078.80; sandbox off (--no-sandbox: the sandboxed start failed) (sandboxed start failed: browser exited (SIGABRT) during Browser.getVersion)

- install: 191 MiB archive, 401 MiB unpacked, 301 files, 0 symlinks; download 860 ms, unpack 1360 ms; sha256 `1f496a826c9ba4d6a5f5bf2de686145fe718528c2cc3dbeb96b5893b89653724` (trust on first use; server MD5 true)
- start: cold 266 ms, warm 205 ms over the pipe; port 234 ms
- per-bot profiles: isolated true, persisted across a restart true
- errors: tabs: Runtime.evaluate timed out; screenshots: browser exited (0) during Page.captureScreenshot; cost: Target.createTarget timed out

### Chrome for Testing · linux-x64 (cft-linux-x64-apparmor.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 0 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 121 MiB archive, 274 MiB unpacked, 287 files, 0 symlinks; download 899 ms, unpack 1379 ms; sha256 `547dcd374e02961bf998f6046a267644f8502225c36bb78ca307dab32a0b3eb4` (trust on first use; server MD5 true)
- start: cold 67 ms, warm 65 ms over the pipe; port 61 ms

### Chrome for Testing · linux-x64 (cft-linux-x64.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 151 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox off (--no-sandbox: the sandboxed start failed) (sandboxed start failed: browser exited (SIGTRAP) during Browser.getVersion)

- install: 121 MiB archive, 274 MiB unpacked, 287 files, 0 symlinks; download 899 ms, unpack 1379 ms; sha256 `547dcd374e02961bf998f6046a267644f8502225c36bb78ca307dab32a0b3eb4` (trust on first use; server MD5 true)
- start: cold 188 ms, warm 35 ms over the pipe; port 46 ms
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 172 MiB, per idle tab 23 MiB, 4 browser contexts +94 MiB, a second bot's browser 113 MiB (6 processes), animated tab 27.7% CPU
  - steps: 0 tabs 172 MiB pss / 0.0%, 1 tabs 207 MiB pss / 1.5%, 2 tabs 229 MiB pss / 3.2%, 4 tabs 272 MiB pss / 5.5%, 8 tabs 357 MiB pss / 10.0%
- errors: tabs: Runtime.evaluate timed out; screenshots: browser gone (Page.captureScreenshot)

**chrome** — Chrome/156.0.8078.80; sandbox off (--no-sandbox: the sandboxed start failed) (sandboxed start failed: browser exited (SIGABRT) during Browser.getVersion)

- install: 192 MiB archive, 403 MiB unpacked, 301 files, 0 symlinks; download 1144 ms, unpack 1962 ms; sha256 `b711c720f774be355197f32edf37e0651418ba036d92446ee2da19ac017540a7` (trust on first use; server MD5 true)
- start: cold 296 ms, warm 220 ms over the pipe; port 266 ms
- screenshots: png 242 / 252 ms (536 KiB, CPU 296 ms), jpeg 74 / 77 ms (143 KiB, stale -43 / -39 ms, CPU 103 ms)
- per-bot profiles: isolated true, persisted across a restart true
- errors: tabs: Runtime.evaluate timed out; screenshots: browser exited (0) during Page.stopScreencast; cost: Target.createTarget timed out

### Chrome for Testing · darwin-arm64 (cft-macos.json)

25.6.0, 3 CPUs, 7 GiB, Bun 1.3.14, status **done**, 187 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 99 MiB archive, 204 MiB unpacked, 16 files, 0 symlinks; download 2184 ms, unpack 2473 ms; sha256 `ea615baa2e9caf0d02d1898a6562b5f8fa9c35239707dae0f592178df5b986ac` (trust on first use; server MD5 true)
- start: cold 400 ms, warm 183 ms over the pipe; port 215 ms
- per-bot profiles: isolated true, persisted across a restart true
- errors: tabs: Runtime.evaluate timed out; screenshots: browser exited (0) during Page.captureScreenshot; cost: browser gone (Target.createBrowserContext)

**chrome** — Chrome/156.0.8078.80; sandbox on

- install: 186 MiB archive, 366 MiB unpacked, 344 files, 5 symlinks; download 2463 ms, unpack 2995 ms; sha256 `8bc590d1b1acac042a000234c768f31830f25a3983a83ed5e067114c87c4cad1` (trust on first use; server MD5 true)
- start: cold 3549 ms, warm 1439 ms over the pipe; port 825 ms
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 266 MiB, per idle tab 24 MiB, 4 browser contexts +520 MiB, a second bot's browser 271 MiB (10 processes), animated tab 16.3% CPU
  - steps: 0 tabs 266 MiB footprint / 8.9%, 1 tabs 313 MiB footprint / 4.4%, 2 tabs 341 MiB footprint / 5.3%, 4 tabs 396 MiB footprint / 5.7%, 8 tabs 456 MiB footprint / 6.4%
- errors: tabs: Runtime.evaluate timed out; screenshots: browser exited (0) during Page.captureScreenshot

### Chrome for Testing · win32-x64 (cft-windows.json)

10.0.26100, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 98 s

**chrome-headless-shell** — ; sandbox – (sandboxed start failed: Browser.getVersion timed out)

- install: 120 MiB archive, 282 MiB unpacked, 288 files, 0 symlinks; download 1675 ms, unpack 1774 ms; sha256 `10a77466005e7f64e00f1a75fd1ea81f4a38a60093c65fea6895843b26e60a9a` (trust on first use; server MD5 true)
- errors: start: Browser.getVersion timed out

**chrome** — ; sandbox – (sandboxed start failed: Browser.getVersion timed out)

- install: 199 MiB archive, 439 MiB unpacked, 305 files, 0 symlinks; download 1354 ms, unpack 2555 ms; sha256 `16edb57d6107bf1c48a7c149b8d78b155fe614410093796dd72441fd6640540f` (trust on first use; server MD5 true)
- errors: start: browser exited (21) during Browser.getVersion

### Electron · linux-arm64-ozone-headless (electron-linux-arm64-ozone-headless.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-arm64 7.0.0-1017-azure, ozone headless, displays 1x1@1, status **done**, 412 s

**Q1 hidden ⇄ shown** (5 cycles; times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | →shown resize | first rAF | fresh picture | →hidden resize | layout hidden → shown | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1 opens) | 0.92 | 27.6 | 0 / 1 | 1 / 5 | 1543 / 1558 | – | 1280x800@1 → 1000x700@1 |  |
| hiddenWindow | true | true | true | true (1 opens) | 0.96 | 28.6 | 1 / 1 | 5 / 5 | 1529 / 1534 | – | 1280x800@1 → 1000x700@1 |  |

- detached: while hidden, interval 100.0 Hz, rAF 0.0 Hz, media ×0.93, decoded 27.0 fps, visibility visible; while shown, rAF 60.0 Hz, visibility visible; initial (hidden) rAF 0.0 Hz
- hiddenWindow: while hidden, interval 100.1 Hz, rAF 1.0 Hz, media ×0.98, decoded 28.7 fps, visibility visible; while shown, rAF 60.0 Hz, visibility visible; initial (hidden) rAF 0.0 Hz

**Q2 throttling** (5 s windows)

| config | visibility | interval Hz | chain Hz | rAF Hz | max rAF gap ms | media × | decoded fps | audio | renderer CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 99.9 | 99.1 | 60.0 | 17 | 0.94 | 28.8 | running | 8.0 |  |
| detached, throttling on (default) | hidden | 100.0 | 99.4 | 0.0 | 0 | 0.85 | 25.8 | running | 2.6 |  |
| detached, throttling off | visible | 99.9 | 99.3 | 0.0 | 0 | 0.85 | 25.8 | running | 2.6 |  |
| own hidden window, throttling on (default) | hidden | 100.0 | 99.4 | 0.0 | 0 | 0.85 | 25.8 | running | 2.4 |  |
| own hidden window, throttling off | visible | 100.0 | 99.2 | 0.0 | 0 | 0.85 | 25.8 | running | 2.4 |  |
| osr, throttling on (default) | visible | 100.0 | 99.2 | 30.0 | 34 | 0.85 | 24.8 | running | 3.6 |  |
| osr, throttling off | visible | 99.9 | 99.1 | 30.0 | 34 | 0.85 | 25.2 | running | 3.8 |  |
| shared hidden window: tab A, throttling off | visible | 99.9 | 99.1 | 0.0 | 0 | – | – | – | – |  |
| shared hidden window: tab B, throttling on | hidden | 2.0 | 1.0 | 0.0 | 0 | – | – | – | – |  |
| own hidden window, on then setBackgroundThrottling(false): before | hidden | 2.0 | 1.0 | 0.0 | 0 | – | – | – | 0.0 |  |
| own hidden window, on then setBackgroundThrottling(false): after | visible | 99.9 | 99.4 | 1.0 | 1017 | – | – | – | 1.5 |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | CPU ms/picture | frames/s | visibility events | errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 8/8 | 8 | 15 / 16 | -6 / -5 | 1000x700 | 53 | – |  |  |
| shown | true | capturePage | 8/8 | 8 | 15 / 15 | -6 / -3 | 1000x700 | 48 | – |  |  |
| shown | true | cdpPng | 8/8 | 8 | 154 / 167 | -42 / -37 | 1000x700 | 200 | – |  |  |
| shown | true | cdpJpeg | 8/8 | 8 | 65 / 65 | -46 / -41 | 1000x700 | 73 | – |  |  |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/8 | 0 | – | – | - | 1 | – |  | Current display surface not available for capture |
| detached | false | capturePage | 0/8 | 0 | – | – | - | 3 | – |  | Current display surface not available for capture |
| detached | false | cdpPng | 0/8 | 0 | – | – | - | 50 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| detached | false | cdpJpeg | 0/8 | 0 | – | – | - | 44 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/8 | 0 | – | – | - | 3 | – |  | Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/8 | 0 | – | – | - | 1 | – |  | Current display surface not available for capture |
| hiddenWindow | false | cdpPng | 8/8 | 8 | 4044 / 4058 | -2849 / -39 | 1280x800 | 283 | – |  |  |
| hiddenWindow | false | cdpJpeg | 8/8 | 8 | 4047 / 4049 | -2995 / -2853 | 1280x800 | 138 | – |  |  |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.5 |  |  |
| ownHiddenWindow | true | capturePageHidden | 0/8 | 0 | – | – | - | 1 | – |  | Current display surface not available for capture |
| ownHiddenWindow | true | capturePage | 0/8 | 0 | – | – | - | 1 | – |  | Current display surface not available for capture |
| ownHiddenWindow | true | cdpPng | 8/8 | 8 | 3026 / 3047 | -2849 / -49 | 1280x800 | 286 | – |  |  |
| ownHiddenWindow | true | cdpJpeg | 8/8 | 8 | 81 / 2889 | -45 / -44 | 1280x800 | 86 | – |  |  |
| ownHiddenWindow | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.5 |  |  |
| osr | false | osrPaint | 8/8 | 0 | 0 / 0 | – | 1x1 | 4 | – |  |  |
| osr | false | capturePage | 8/8 | 0 | 1 / 1 | – | 1x1 | 6 | – |  |  |
| osr | false | cdpJpeg | 8/8 | 0 | 66 / 99 | – | 1x1 | 9 | – |  |  |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 204 | pss | 462 | 4 | 0.0 |
| 1 | 232 | pss | 578 | 5 | 0.3 |
| 2 | 248 | pss | 696 | 6 | 0.0 |
| 4 | 277 | pss | 919 | 8 | 0.8 |
| 8 | 330 | pss | 1352 | 12 | 0.5 |

Per idle hidden tab: **16 MiB**, 0.06% CPU. Four tabs: one partition +66 MiB, four partitions +69 MiB.

| animated tab | all CPU % | renderer % | GPU % |
| :- | :- | :- | :- |
| animated, shown | 30.5 | 28.7 | 1.5 |
| animated, hidden window, throttling off | 1.0 | 0.8 | 0.0 |
| animated, hidden window, throttling on | 0.0 | 0.0 | 0.0 |
| animated, osr 30 fps, throttling off | 3.3 | 2.8 | 0.5 |

### Electron · linux-wayland (electron-linux-wayland.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone wayland, displays 1920x1080@1, status **done**, 741 s

**Q1 hidden ⇄ shown** (5 cycles; times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | →shown resize | first rAF | fresh picture | →hidden resize | layout hidden → shown | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1 opens) | 0.92 | 27.5 | 0 / 1 | 1 / 125 | 1559 / 1664 | – | 1280x800@1 → 1000x700@1 |  |
| hiddenWindow | true | true | true | true (1 opens) | 0.93 | 27.6 | 1 / 1 | 1 / 2 | 1534 / 1561 | – | 1280x800@1 → 1000x700@1 |  |

- detached: while hidden, interval 100.0 Hz, rAF 0.0 Hz, media ×0.91, decoded 26.5 fps, visibility visible; while shown, rAF 39.5 Hz, visibility visible; initial (hidden) rAF 0.0 Hz
- hiddenWindow: while hidden, interval 100.1 Hz, rAF 0.0 Hz, media ×0.96, decoded 27.0 fps, visibility visible; while shown, rAF 39.6 Hz, visibility visible; initial (hidden) rAF 0.0 Hz

**Q2 throttling** (5 s windows)

| config | visibility | interval Hz | chain Hz | rAF Hz | max rAF gap ms | media × | decoded fps | audio | renderer CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 100.0 | 99.4 | 39.8 | 26 | 0.94 | 29.0 | running | 5.4 |  |
| detached, throttling on (default) | hidden | 100.0 | 99.4 | 0.0 | 0 | 0.85 | 25.8 | running | 1.8 |  |
| detached, throttling off | visible | 100.1 | 99.1 | 0.0 | 0 | 0.85 | 25.8 | running | 2.0 |  |
| own hidden window, throttling on (default) | hidden | 100.0 | 99.2 | 0.0 | 0 | 0.85 | 25.8 | running | 1.6 |  |
| own hidden window, throttling off | visible | 100.0 | 99.2 | 0.0 | 0 | 0.85 | 25.8 | running | 2.0 |  |
| osr, throttling on (default) | visible | 100.0 | 99.2 | 30.0 | 34 | 0.94 | 29.0 | running | 4.2 |  |
| osr, throttling off | visible | 100.0 | 99.2 | 30.0 | 34 | 0.94 | 29.0 | running | 4.6 |  |
| shared hidden window: tab A, throttling off | visible | 100.0 | 99.0 | 0.0 | 0 | – | – | – | – |  |
| shared hidden window: tab B, throttling on | hidden | 1.0 | 1.0 | 0.0 | 0 | – | – | – | – |  |
| own hidden window, on then setBackgroundThrottling(false): before | hidden | 1.0 | 1.0 | 0.0 | 0 | – | – | – | 0.0 |  |
| own hidden window, on then setBackgroundThrottling(false): after | visible | 99.8 | 99.1 | 0.0 | 0 | – | – | – | 1.0 |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | CPU ms/picture | frames/s | visibility events | errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 8/8 | 8 | 26 / 27 | 31 / 33 | 1000x700 | 36 | – |  |  |
| shown | true | capturePage | 8/8 | 8 | 27 / 33 | 30 / 36 | 1000x700 | 35 | – |  |  |
| shown | true | cdpPng | 8/8 | 8 | 249 / 262 | -66 / -64 | 1000x700 | 181 | – |  |  |
| shown | true | cdpJpeg | 8/8 | 8 | 130 / 131 | -63 / -62 | 1000x700 | 59 | – |  |  |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/8 | 0 | – | – | - | 1 | – |  | Current display surface not available for capture |
| detached | false | capturePage | 0/8 | 0 | – | – | - | 1 | – |  | Current display surface not available for capture |
| detached | false | cdpPng | 0/8 | 0 | – | – | - | 68 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| detached | false | cdpJpeg | 0/8 | 0 | – | – | - | 56 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/8 | 0 | – | – | - | 1 | – |  | Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/8 | 0 | – | – | - | 3 | – |  | Current display surface not available for capture |
| hiddenWindow | false | cdpPng | 0/8 | 0 | – | – | - | 61 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| hiddenWindow | false | cdpJpeg | 0/8 | 0 | – | – | - | 56 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| ownHiddenWindow | true | capturePageHidden | 0/8 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| ownHiddenWindow | true | capturePage | 0/8 | 0 | – | – | - | 3 | – |  | Current display surface not available for capture |
| ownHiddenWindow | true | cdpPng | 0/8 | 0 | – | – | - | 59 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| ownHiddenWindow | true | cdpJpeg | 0/8 | 0 | – | – | - | 56 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| ownHiddenWindow | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| osr | false | osrPaint | 8/8 | 8 | 0 / 1 | 25 / 33 | 1280x800 | 26 | – |  |  |
| osr | false | capturePage | 8/8 | 8 | 31 / 40 | -20 / -18 | 1280x800 | 43 | – |  |  |
| osr | false | cdpJpeg | 8/8 | 8 | 98 / 110 | -74 / -73 | 1280x800 | 68 | – |  |  |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | 30.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 362 | pss | 631 | 4 | 0.0 |
| 1 | 334 | pss | 680 | 5 | 0.0 |
| 2 | 349 | pss | 788 | 6 | 0.0 |
| 4 | 377 | pss | 1003 | 8 | 0.5 |
| 8 | 429 | pss | 1434 | 12 | 0.8 |

Per idle hidden tab: **8 MiB**, 0.09% CPU. Four tabs: one partition +67 MiB, four partitions +70 MiB.

| animated tab | all CPU % | renderer % | GPU % |
| :- | :- | :- | :- |
| animated, shown | 15.0 | 9.3 | 4.8 |
| animated, hidden window, throttling off | 1.5 | 1.0 | 0.3 |
| animated, hidden window, throttling on | 0.5 | 0.0 | 0.3 |
| animated, osr 30 fps, throttling off | 20.0 | 8.3 | 4.0 |

**Q6 streamed view** (10 s at the viewer; latency p50 / p95 ms)

| road | content | source | fps | decoded fps | latency | gap p95 | kbit/s | bytes/frame | sender CPU % | viewer CPU % | notes |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| screencast | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 |  |
| capturePoll | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | [object Object] |
| webrtc-h264 | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | [object Object] |
| webcodecs-vp8 | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | [object Object] |
| webcodecs-h264 | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | [object Object] |
| screencast | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 |  |
| capturePoll | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | [object Object] |
| webrtc-h264 | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | [object Object] |
| webcodecs-vp8 | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | [object Object] |
| webcodecs-h264 | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | [object Object] |
| screencast | anim | shown | 38.9 | 38.9 | 66 / 67 | 27 | 35592 | 114666 | 64 | 16 |  |
| webrtc-vp8 | anim | shown | 20.5 | 0.0 | – | 79 | 2462 | 15015 | 71 | 14 | libvpx; video/VP8 |

### Electron · linux-x11-long (electron-linux-x11-long.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone x11, displays 1920x1080@1, status **done**, 401 s

**Long run** (rates in each window)

| config | at | visibility | interval Hz | chain Hz | rAF Hz | max chain gap ms |
| :- | :- | :- | :- | :- | :- | :- |
| own hidden window, throttling on | 0.5 min | hidden | 2.00 | 1.00 | 0.00 | 1000 |
| own hidden window, throttling off | 0.5 min | visible | 100.01 | 99.21 | 0.00 | 11 |
| detached, throttling off | 0.5 min | visible | 100.02 | 99.22 | 0.00 | 11 |
| own hidden window, throttling on | 5 min | hidden | 0.19 | 0.09 | 0.00 | 60000 |
| own hidden window, throttling off | 5 min | visible | 100.00 | 99.12 | 0.00 | 11 |
| detached, throttling off | 5 min | visible | 100.00 | 99.12 | 0.00 | 11 |
| own hidden window, throttling on | 6.5 min | hidden | 0.02 | 0.01 | 0.00 | 0 |
| own hidden window, throttling off | 6.5 min | visible | 100.01 | 99.11 | 0.00 | 11 |
| detached, throttling off | 6.5 min | visible | 100.00 | 99.11 | 0.00 | 11 |

### Electron · linux-x11 (electron-linux-x11.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone x11, displays 1920x1080@1, status **done**, 606 s

**Q1 hidden ⇄ shown** (5 cycles; times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | →shown resize | first rAF | fresh picture | →hidden resize | layout hidden → shown | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1 opens) | 0.94 | 28.3 | 1 / 2 | 1 / 12 | 1540 / 1554 | – | 1280x800@1 → 1000x700@1 |  |
| hiddenWindow | true | true | true | true (1 opens) | 0.96 | 28.6 | 2 / 2 | 6 / 13 | 1519 / 1531 | – | 1280x800@1 → 1000x700@1 |  |

- detached: while hidden, interval 100.0 Hz, rAF 0.0 Hz, media ×0.90, decoded 27.1 fps, visibility visible; while shown, rAF 60.0 Hz, visibility visible; initial (hidden) rAF 0.0 Hz
- hiddenWindow: while hidden, interval 100.0 Hz, rAF 1.0 Hz, media ×0.98, decoded 28.4 fps, visibility visible; while shown, rAF 60.0 Hz, visibility visible; initial (hidden) rAF 0.0 Hz

**Q2 throttling** (5 s windows)

| config | visibility | interval Hz | chain Hz | rAF Hz | max rAF gap ms | media × | decoded fps | audio | renderer CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 100.1 | 99.3 | 60.2 | 17 | 0.94 | 28.8 | running | 6.0 |  |
| detached, throttling on (default) | hidden | 100.0 | 99.4 | 0.0 | 0 | 0.85 | 25.8 | running | 1.2 |  |
| detached, throttling off | visible | 100.0 | 99.4 | 0.0 | 0 | 0.85 | 25.8 | running | 1.6 |  |
| own hidden window, throttling on (default) | hidden | 100.0 | 99.4 | 0.0 | 0 | 0.85 | 25.8 | running | 1.4 |  |
| own hidden window, throttling off | visible | 99.9 | 99.1 | 0.0 | 0 | 0.85 | 25.8 | running | 2.0 |  |
| osr, throttling on (default) | visible | 100.0 | 99.4 | 30.0 | 36 | 0.94 | 29.0 | running | 4.2 |  |
| osr, throttling off | visible | 100.0 | 99.2 | 30.0 | 34 | 0.94 | 29.0 | running | 4.2 |  |
| shared hidden window: tab A, throttling off | visible | 100.0 | 99.4 | 0.0 | 0 | – | – | – | – |  |
| shared hidden window: tab B, throttling on | hidden | 1.0 | 1.0 | 0.0 | 0 | – | – | – | – |  |
| own hidden window, on then setBackgroundThrottling(false): before | hidden | 1.0 | 1.0 | 0.0 | 0 | – | – | – | 0.0 |  |
| own hidden window, on then setBackgroundThrottling(false): after | visible | 99.9 | 99.4 | 1.0 | 1017 | – | – | – | 0.8 |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | CPU ms/picture | frames/s | visibility events | errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 8/8 | 8 | 15 / 16 | -9 / -5 | 1000x700 | 33 | – |  |  |
| shown | true | capturePage | 8/8 | 8 | 15 / 17 | -9 / -6 | 1000x700 | 28 | – |  |  |
| shown | true | cdpPng | 8/8 | 8 | 151 / 165 | -44 / -34 | 1000x700 | 156 | – |  |  |
| shown | true | cdpJpeg | 8/8 | 8 | 57 / 65 | -49 / -34 | 1000x700 | 44 | – |  |  |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.5 |  |  |
| detached | false | capturePageHidden | 0/8 | 0 | – | – | - | 1 | – |  | Current display surface not available for capture |
| detached | false | capturePage | 0/8 | 0 | – | – | - | 3 | – |  | Current display surface not available for capture |
| detached | false | cdpPng | 0/8 | 0 | – | – | - | 38 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| detached | false | cdpJpeg | 0/8 | 0 | – | – | - | 26 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/8 | 0 | – | – | - | 1 | – |  | Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/8 | 0 | – | – | - | 1 | – |  | Current display surface not available for capture |
| hiddenWindow | false | cdpPng | 8/8 | 8 | 4043 / 4055 | -2847 / -38 | 1280x800 | 224 | – |  |  |
| hiddenWindow | false | cdpJpeg | 8/8 | 8 | 4047 / 4048 | -2998 / -2855 | 1280x800 | 79 | – |  |  |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.5 |  |  |
| ownHiddenWindow | true | capturePageHidden | 0/8 | 0 | – | – | - | 1 | – |  | Current display surface not available for capture |
| ownHiddenWindow | true | capturePage | 0/8 | 0 | – | – | - | 1 | – |  | Current display surface not available for capture |
| ownHiddenWindow | true | cdpPng | 8/8 | 8 | 3024 / 3054 | -2848 / -34 | 1280x800 | 248 | – |  |  |
| ownHiddenWindow | true | cdpJpeg | 8/8 | 8 | 66 / 2889 | -44 / -42 | 1280x800 | 58 | – |  |  |
| ownHiddenWindow | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.5 |  |  |
| osr | false | osrPaint | 8/8 | 8 | 0 / 0 | 20 / 27 | 1280x800 | 16 | – |  |  |
| osr | false | capturePage | 8/8 | 8 | 31 / 33 | -21 / -2 | 1280x800 | 38 | – |  |  |
| osr | false | cdpJpeg | 8/8 | 8 | 98 / 112 | -78 / -74 | 1280x800 | 59 | – |  |  |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | 30.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 353 | pss | 615 | 4 | 0.0 |
| 1 | 327 | pss | 667 | 5 | 0.0 |
| 2 | 341 | pss | 773 | 6 | 0.3 |
| 4 | 369 | pss | 987 | 8 | 0.5 |
| 8 | 421 | pss | 1415 | 12 | 0.5 |

Per idle hidden tab: **9 MiB**, 0.06% CPU. Four tabs: one partition +65 MiB, four partitions +69 MiB.

| animated tab | all CPU % | renderer % | GPU % |
| :- | :- | :- | :- |
| animated, shown | 15.0 | 10.3 | 4.8 |
| animated, hidden window, throttling off | 0.5 | 0.5 | 0.0 |
| animated, hidden window, throttling on | 0.3 | 0.0 | 0.0 |
| animated, osr 30 fps, throttling off | 19.5 | 7.8 | 4.5 |

**Q6 streamed view** (10 s at the viewer; latency p50 / p95 ms)

| road | content | source | fps | decoded fps | latency | gap p95 | kbit/s | bytes/frame | sender CPU % | viewer CPU % | notes |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| screencast | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 |  |
| capturePoll | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | anim | hiddenWindow | 20.7 | 20.7 | 36 / 44 | 78 | 2473 | 14932 | 45 | 12 | libvpx; video/VP8 |
| webrtc-h264 | anim | hiddenWindow | 12.5 | 12.5 | 59 / 90 | 110 | 2450 | 24505 | 43 | 7 | OpenH264; video/H264 |
| webcodecs-vp8 | anim | hiddenWindow | 30.0 | 30.0 | 29 / 31 | 34 | 2419 | 10080 | 62 | 15 |  |
| webcodecs-h264 | anim | hiddenWindow | 30.0 | 30.0 | 28 / 30 | 35 | 2405 | 10020 | 52 | 14 |  |
| screencast | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 |  |
| capturePoll | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | static | hiddenWindow | 2.0 | 2.0 | 16 / 43 | 533 | 121 | 7554 | 5 | 1 | libvpx; video/VP8 |
| webrtc-h264 | static | hiddenWindow | 0.9 | 0.9 | 17 / 157 | 1001 | 100 | 13927 | 4 | 1 | OpenH264; video/H264 |
| webcodecs-vp8 | static | hiddenWindow | 2.0 | 2.0 | 14 / 16 | 504 | 119 | 7413 | 5 | 1 |  |
| webcodecs-h264 | static | hiddenWindow | 2.0 | 2.0 | 12 / 25 | 529 | 35 | 2162 | 4 | 1 |  |
| screencast | anim | shown | 60.0 | 60.0 | 14 / 16 | 18 | 55033 | 114652 | 81 | 23 |  |
| webrtc-vp8 | anim | shown | 20.0 | 0.0 | – | 78 | 2457 | 15356 | 66 | 12 | libvpx; video/VP8 |

### Electron · linux-x64-ozone-headless (electron-linux-x64-ozone-headless.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone headless, displays 1x1@1, status **done**, 396 s

**Q1 hidden ⇄ shown** (5 cycles; times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | →shown resize | first rAF | fresh picture | →hidden resize | layout hidden → shown | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1 opens) | 0.94 | 28.1 | 0 / 1 | 1 / 4 | 1550 / 1567 | – | 1280x800@1 → 1000x700@1 |  |
| hiddenWindow | true | true | true | true (1 opens) | 0.96 | 28.6 | 1 / 1 | 13 / 16 | 1536 / 1539 | – | 1280x800@1 → 1000x700@1 |  |

- detached: while hidden, interval 100.0 Hz, rAF 0.0 Hz, media ×0.96, decoded 27.9 fps, visibility visible; while shown, rAF 60.0 Hz, visibility visible; initial (hidden) rAF 0.0 Hz
- hiddenWindow: while hidden, interval 100.0 Hz, rAF 1.0 Hz, media ×0.95, decoded 28.4 fps, visibility visible; while shown, rAF 60.0 Hz, visibility visible; initial (hidden) rAF 0.0 Hz

**Q2 throttling** (5 s windows)

| config | visibility | interval Hz | chain Hz | rAF Hz | max rAF gap ms | media × | decoded fps | audio | renderer CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 99.9 | 99.3 | 60.0 | 18 | 0.94 | 28.8 | running | 3.4 |  |
| detached, throttling on (default) | hidden | 100.0 | 99.4 | 0.0 | 0 | 0.85 | 25.8 | running | 1.4 |  |
| detached, throttling off | visible | 100.0 | 99.4 | 0.0 | 0 | 0.85 | 25.8 | running | 1.4 |  |
| own hidden window, throttling on (default) | hidden | 100.0 | 99.4 | 0.0 | 0 | 0.85 | 25.8 | running | 1.0 |  |
| own hidden window, throttling off | visible | 100.0 | 99.4 | 0.0 | 0 | 0.85 | 25.8 | running | 1.2 |  |
| osr, throttling on (default) | visible | 100.0 | 99.4 | 30.0 | 34 | 0.85 | 25.8 | running | 1.8 |  |
| osr, throttling off | visible | 99.9 | 99.3 | 30.0 | 34 | 0.85 | 25.8 | running | 2.0 |  |
| shared hidden window: tab A, throttling off | visible | 100.0 | 99.2 | 0.0 | 0 | – | – | – | – |  |
| shared hidden window: tab B, throttling on | hidden | 1.0 | 1.0 | 0.0 | 0 | – | – | – | – |  |
| own hidden window, on then setBackgroundThrottling(false): before | hidden | 1.0 | 1.0 | 0.0 | 0 | – | – | – | 0.0 |  |
| own hidden window, on then setBackgroundThrottling(false): after | visible | 100.1 | 99.4 | 1.0 | 1017 | – | – | – | 0.8 |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | CPU ms/picture | frames/s | visibility events | errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 8/8 | 8 | 15 / 19 | -10 / -9 | 1000x700 | 20 | – |  |  |
| shown | true | capturePage | 8/8 | 8 | 15 / 16 | -10 / -9 | 1000x700 | 19 | – |  |  |
| shown | true | cdpPng | 8/8 | 8 | 141 / 159 | -42 / -36 | 1000x700 | 126 | – |  |  |
| shown | true | cdpJpeg | 8/8 | 8 | 49 / 55 | -37 / -36 | 1000x700 | 26 | – |  |  |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/8 | 0 | – | – | - | 3 | – |  | Current display surface not available for capture |
| detached | false | capturePage | 0/8 | 0 | – | – | - | 1 | – |  | Current display surface not available for capture |
| detached | false | cdpPng | 0/8 | 0 | – | – | - | 28 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| detached | false | cdpJpeg | 0/8 | 0 | – | – | - | 26 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/8 | 0 | – | – | - | 1 | – |  | Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/8 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| hiddenWindow | false | cdpPng | 8/8 | 8 | 3029 / 3054 | -2861 / -33 | 1280x800 | 205 | – |  |  |
| hiddenWindow | false | cdpJpeg | 8/8 | 8 | 3031 / 3031 | -2999 / -2870 | 1280x800 | 64 | – |  |  |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.5 |  |  |
| ownHiddenWindow | true | capturePageHidden | 0/8 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| ownHiddenWindow | true | capturePage | 0/8 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| ownHiddenWindow | true | cdpPng | 8/8 | 8 | 3024 / 3061 | -2862 / -38 | 1280x800 | 231 | – |  |  |
| ownHiddenWindow | true | cdpJpeg | 8/8 | 8 | 64 / 2892 | -45 / -42 | 1280x800 | 55 | – |  |  |
| ownHiddenWindow | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.5 |  |  |
| osr | false | osrPaint | 8/8 | 0 | 0 / 0 | – | 1x1 | 1 | – |  |  |
| osr | false | capturePage | 8/8 | 0 | 0 / 1 | – | 1x1 | 5 | – |  |  |
| osr | false | cdpJpeg | 8/8 | 0 | 66 / 100 | – | 1x1 | 8 | – |  |  |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 207 | pss | 460 | 4 | 0.0 |
| 1 | 235 | pss | 565 | 5 | 0.5 |
| 2 | 250 | pss | 671 | 6 | 0.5 |
| 4 | 279 | pss | 885 | 8 | 0.0 |
| 8 | 331 | pss | 1310 | 12 | 0.3 |

Per idle hidden tab: **16 MiB**, 0.03% CPU. Four tabs: one partition +65 MiB, four partitions +69 MiB.

| animated tab | all CPU % | renderer % | GPU % |
| :- | :- | :- | :- |
| animated, shown | 7.3 | 6.8 | 0.5 |
| animated, hidden window, throttling off | 0.8 | 0.5 | 0.0 |
| animated, hidden window, throttling on | 0.0 | 0.0 | 0.0 |
| animated, osr 30 fps, throttling off | 1.8 | 1.5 | 0.3 |

### Electron · macos (electron-macos.json)

Electron 45.2.2 (Chromium 156.0.8078.80), darwin-arm64 25.6.0, ozone (default), displays 1024x768@1, status **done**, 535 s

**Q1 hidden ⇄ shown** (5 cycles; times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | →shown resize | first rAF | fresh picture | →hidden resize | layout hidden → shown | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1 opens) | 0.92 | 27.9 | – | 35 / 319 | 1583 / 2231 | – | 1280x800@1 → 1000x700@1 |  |
| hiddenWindow | true | true | true | true (1 opens) | 0.97 | 29.1 | – | 15 / 71 | 1557 / 1617 | – | 1280x800@1 → 1000x700@1 |  |

- detached: while hidden, interval 53.4 Hz, rAF 1.0 Hz, media ×0.94, decoded 29.2 fps, visibility visible; while shown, rAF 52.0 Hz, visibility visible; initial (hidden) rAF 0.0 Hz
- hiddenWindow: while hidden, interval 53.8 Hz, rAF 1.0 Hz, media ×0.99, decoded 29.0 fps, visibility visible; while shown, rAF 58.8 Hz, visibility visible; initial (hidden) rAF 0.0 Hz

**Q2 throttling** (5 s windows)

| config | visibility | interval Hz | chain Hz | rAF Hz | max rAF gap ms | media × | decoded fps | audio | renderer CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 81.7 | 61.9 | 60.1 | 36 | 1.00 | 29.4 | running | 11.2 |  |
| detached, throttling on (default) | hidden | 51.8 | 41.2 | 0.0 | 0 | 0.95 | 27.6 | running | 3.8 |  |
| detached, throttling off | visible | 55.0 | 42.6 | 0.0 | 0 | 0.89 | 26.2 | running | 3.6 |  |
| own hidden window, throttling on (default) | hidden | 55.8 | 43.2 | 0.0 | 0 | 0.93 | 28.8 | running | 3.2 |  |
| own hidden window, throttling off | visible | 56.4 | 45.0 | 0.0 | 0 | 0.94 | 27.2 | running | 4.0 |  |
| osr, throttling on (default) | visible | 58.4 | 46.6 | 13.8 | 111 | 0.94 | 28.8 | running | 6.9 |  |
| osr, throttling off | visible | 59.6 | 48.4 | 14.8 | 127 | 0.95 | 29.0 | running | 6.3 |  |
| shared hidden window: tab A, throttling off | visible | 98.9 | 84.9 | 0.0 | 0 | – | – | – | – |  |
| shared hidden window: tab B, throttling on | hidden | 1.0 | 1.0 | 0.0 | 0 | – | – | – | – |  |
| own hidden window, on then setBackgroundThrottling(false): before | hidden | 1.5 | 1.0 | 0.0 | 0 | – | – | – | 0.1 |  |
| own hidden window, on then setBackgroundThrottling(false): after | visible | 77.6 | 61.8 | 59.3 | 53 | – | – | – | 7.5 |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | CPU ms/picture | frames/s | visibility events | errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 8/8 | 8 | 26 / 69 | 25 / 28 | 1000x700 | 70 | – |  |  |
| shown | true | capturePage | 8/8 | 8 | 30 / 36 | 23 / 29 | 1000x700 | 57 | – |  |  |
| shown | true | cdpPng | 8/8 | 8 | 254 / 359 | -46 / -40 | 1000x700 | 239 | – |  |  |
| shown | true | cdpJpeg | 8/8 | 8 | 79 / 99 | -41 / -36 | 1000x700 | 73 | – |  |  |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/8 | 0 | – | – | - | 11 | – |  | Current display surface not available for capture |
| detached | false | capturePage | 0/8 | 0 | – | – | - | 9 | – |  | Current display surface not available for capture |
| detached | false | cdpPng | 1/8 | 1 | 240 / 240 | -50 / -50 | 1280x800 | 253 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| detached | false | cdpJpeg | 0/8 | 0 | – | – | - | 234 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/8 | 0 | – | – | - | 10 | – |  | Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/8 | 0 | – | – | - | 10 | – |  | Current display surface not available for capture |
| hiddenWindow | false | cdpPng | 8/8 | 8 | 268 / 348 | -53 / -41 | 1280x800 | 294 | – |  |  |
| hiddenWindow | false | cdpJpeg | 8/8 | 8 | 106 / 152 | -59 / -45 | 1280x800 | 63 | – |  |  |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 25.0 |  |  |
| ownHiddenWindow | true | capturePageHidden | 0/8 | 0 | – | – | - | 1 | – |  | Current display surface not available for capture |
| ownHiddenWindow | true | capturePage | 0/8 | 0 | – | – | - | 1 | – |  | Current display surface not available for capture |
| ownHiddenWindow | true | cdpPng | 8/8 | 8 | 263 / 432 | -41 / -24 | 1280x800 | 353 | – |  |  |
| ownHiddenWindow | true | cdpJpeg | 8/8 | 8 | 63 / 102 | -27 / -20 | 1280x800 | 59 | – |  |  |
| ownHiddenWindow | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.5 |  |  |
| osr | false | osrPaint | 8/8 | 8 | 0 / 0 | 112 / 192 | 1280x800 | 27 | – |  |  |
| osr | false | capturePage | 8/8 | 8 | 34 / 148 | 8 / 109 | 1280x800 | 50 | – |  |  |
| osr | false | cdpJpeg | 8/8 | 8 | 278 / 388 | -219 / -39 | 1280x800 | 88 | – |  |  |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | 14.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 133 | footprint | 354 | 4 | 0.3 |
| 1 | 144 | footprint | 437 | 5 | 0.8 |
| 2 | 164 | footprint | 530 | 6 | 0.7 |
| 4 | 205 | footprint | 714 | 8 | 1.3 |
| 8 | 289 | footprint | 1084 | 12 | 2.4 |

Per idle hidden tab: **20 MiB**, 0.26% CPU. Four tabs: one partition +76 MiB, four partitions +80 MiB.

| animated tab | all CPU % | renderer % | GPU % |
| :- | :- | :- | :- |
| animated, shown | 27.1 | 9.5 | 17.4 |
| animated, hidden window, throttling off | 12.5 | 3.8 | 8.4 |
| animated, hidden window, throttling on | 0.6 | 0.1 | 0.3 |
| animated, osr 30 fps, throttling off | 23.6 | 4.8 | 11.7 |

**Q6 streamed view** (10 s at the viewer; latency p50 / p95 ms)

| road | content | source | fps | decoded fps | latency | gap p95 | kbit/s | bytes/frame | sender CPU % | viewer CPU % | notes |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| screencast | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 14 | 0 |  |
| capturePoll | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 13 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | anim | hiddenWindow | 2.3 | 2.3 | 374 / 585 | 617 | 412 | 22374 | 54 | 3 | libvpx; video/VP8 |
| webrtc-h264 | anim | hiddenWindow | 7.9 | 7.9 | 203 / 306 | 198 | 1560 | 24678 | 80 | 5 | OpenH264; video/H264 |
| webcodecs-vp8 | anim | hiddenWindow | 30.4 | 30.4 | 45 / 201 | 51 | 2279 | 9371 | 96 | 16 |  |
| webcodecs-h264 | anim | hiddenWindow | 30.1 | 30.1 | 48 / 59 | 48 | 2243 | 9314 | 107 | 18 |  |
| screencast | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 |  |
| capturePoll | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | static | hiddenWindow | 2.0 | 2.0 | 258 / 400 | 827 | 120 | 7470 | 8 | 2 | libvpx; video/VP8 |
| webrtc-h264 | static | hiddenWindow | 0.9 | 0.9 | 72 / 527 | 1018 | 56 | 7787 | 10 | 1 | OpenH264; video/H264 |
| webcodecs-vp8 | static | hiddenWindow | 2.0 | 2.0 | 53 / 65 | 553 | 103 | 6461 | 10 | 2 |  |
| webcodecs-h264 | static | hiddenWindow | 2.0 | 2.0 | 42 / 62 | 552 | 9 | 546 | 9 | 1 |  |
| screencast | anim | shown | 60.0 | 60.0 | 40 / 49 | 29 | 49001 | 101915 | 85 | 24 |  |
| webrtc-vp8 | anim | shown | 20.0 | 0.0 | – | 98 | 2103 | 13141 | 59 | 14 | libvpx; video/VP8 |

### Electron · windows (electron-windows.json)

Electron 45.2.2 (Chromium 156.0.8078.80), win32-x64 10.0.26100, ozone (default), displays 1024x768@1, status **done**, 603 s

**Q1 hidden ⇄ shown** (5 cycles; times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | →shown resize | first rAF | fresh picture | →hidden resize | layout hidden → shown | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1 opens) | 0.93 | 27.6 | 1 / 1 | 1 / 39 | 1544 / 1566 | – | 1280x800@1 → 1000x700@1 |  |
| hiddenWindow | true | true | true | true (1 opens) | 0.96 | 28.7 | – | 9 / 16 | 1532 / 1544 | – | 1280x800@1 → 1000x700@1 |  |

- detached: while hidden, interval 100.1 Hz, rAF 0.0 Hz, media ×0.88, decoded 26.8 fps, visibility visible; while shown, rAF 64.0 Hz, visibility visible; initial (hidden) rAF 0.0 Hz
- hiddenWindow: while hidden, interval 99.9 Hz, rAF 1.0 Hz, media ×0.98, decoded 28.8 fps, visibility visible; while shown, rAF 64.0 Hz, visibility visible; initial (hidden) rAF 0.0 Hz

**Q2 throttling** (5 s windows)

| config | visibility | interval Hz | chain Hz | rAF Hz | max rAF gap ms | media × | decoded fps | audio | renderer CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 100.0 | 90.8 | 64.2 | 17 | 0.94 | 29.0 | running | 8.1 |  |
| detached, throttling on (default) | hidden | 100.0 | 92.8 | 0.0 | 0 | 0.85 | 24.8 | running | 2.4 |  |
| detached, throttling off | visible | 100.0 | 91.6 | 0.0 | 0 | 0.84 | 24.8 | running | 2.2 |  |
| own hidden window, throttling on (default) | hidden | 99.2 | 91.8 | 0.0 | 0 | 0.85 | 26.0 | running | 2.5 |  |
| own hidden window, throttling off | visible | 100.0 | 90.4 | 0.0 | 0 | 0.85 | 24.8 | running | 2.5 |  |
| osr, throttling on (default) | visible | 100.0 | 90.6 | 30.0 | 35 | 0.93 | 29.4 | running | 6.4 |  |
| osr, throttling off | visible | 100.0 | 90.2 | 30.0 | 35 | 0.93 | 29.2 | running | 5.5 |  |
| shared hidden window: tab A, throttling off | visible | 100.0 | 97.8 | 0.0 | 0 | – | – | – | – |  |
| shared hidden window: tab B, throttling on | hidden | 1.8 | 1.0 | 0.0 | 0 | – | – | – | – |  |
| own hidden window, on then setBackgroundThrottling(false): before | hidden | 1.0 | 1.0 | 0.0 | 0 | – | – | – | 0.0 |  |
| own hidden window, on then setBackgroundThrottling(false): after | visible | 100.2 | 90.7 | 1.0 | 1000 | – | – | – | 0.9 |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | CPU ms/picture | frames/s | visibility events | errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 8/8 | 8 | 7 / 14 | 12 / 14 | 1000x700 | 50 | – |  |  |
| shown | true | capturePage | 8/8 | 8 | 7 / 9 | 12 / 14 | 1000x700 | 47 | – |  |  |
| shown | true | cdpPng | 8/8 | 8 | 185 / 206 | -45 / -34 | 1000x700 | 239 | – |  |  |
| shown | true | cdpJpeg | 8/8 | 8 | 71 / 72 | -42 / -32 | 1000x700 | 76 | – |  |  |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/8 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| detached | false | capturePage | 0/8 | 0 | – | – | - | 1 | – |  | Current display surface not available for capture |
| detached | false | cdpPng | 0/8 | 0 | – | – | - | 66 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| detached | false | cdpJpeg | 0/8 | 0 | – | – | - | 57 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/8 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/8 | 0 | – | – | - | 1 | – |  | Current display surface not available for capture |
| hiddenWindow | false | cdpPng | 8/8 | 8 | 3974 / 3994 | -2768 / -43 | 1280x800 | 266 | – |  |  |
| hiddenWindow | false | cdpJpeg | 8/8 | 8 | 3977 / 3978 | -2945 / -2777 | 1280x800 | 96 | – |  |  |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.5 |  |  |
| ownHiddenWindow | true | capturePageHidden | 0/8 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| ownHiddenWindow | true | capturePage | 0/8 | 0 | – | – | - | 1 | – |  | Current display surface not available for capture |
| ownHiddenWindow | true | cdpPng | 8/8 | 8 | 2967 / 3034 | -2764 / -38 | 1280x800 | 279 | – |  |  |
| ownHiddenWindow | true | cdpJpeg | 8/8 | 8 | 86 / 2800 | -36 / -33 | 1280x800 | 68 | – |  |  |
| ownHiddenWindow | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.5 |  |  |
| osr | false | osrPaint | 8/8 | 8 | 0 / 0 | 41 / 44 | 1024x720 | 22 | – |  |  |
| osr | false | capturePage | 8/8 | 8 | 32 / 33 | 6 / 14 | 1024x720 | 35 | – |  |  |
| osr | false | cdpJpeg | 8/8 | 8 | 132 / 139 | -87 / -86 | 1024x720 | 59 | – |  |  |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | 30.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 199 | privateBytes | 218 | 4 | 0.1 |
| 1 | 138 | privateBytes | 203 | 5 | 0.1 |
| 2 | 163 | privateBytes | 275 | 6 | 0.2 |
| 4 | 217 | privateBytes | 425 | 8 | 0.3 |
| 8 | 324 | privateBytes | 720 | 12 | 0.5 |

Per idle hidden tab: **16 MiB**, 0.05% CPU. Four tabs: one partition +97 MiB, four partitions +102 MiB.

| animated tab | all CPU % | renderer % | GPU % |
| :- | :- | :- | :- |
| animated, shown | 32.2 | 17.2 | 14.5 |
| animated, hidden window, throttling off | 1.3 | 1.1 | 0.0 |
| animated, hidden window, throttling on | 0.1 | 0.0 | 0.0 |
| animated, osr 30 fps, throttling off | 19.1 | 8.9 | 6.3 |

**Q6 streamed view** (10 s at the viewer; latency p50 / p95 ms)

| road | content | source | fps | decoded fps | latency | gap p95 | kbit/s | bytes/frame | sender CPU % | viewer CPU % | notes |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| screencast | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 |  |
| capturePoll | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | anim | hiddenWindow | 24.8 | 24.8 | 37 / 39 | 64 | 2476 | 12477 | 67 | 15 | libvpx; video/VP8 |
| webrtc-h264 | anim | hiddenWindow | 14.7 | 14.7 | 54 / 56 | 80 | 2456 | 20881 | 66 | 10 | OpenH264; video/H264 |
| webcodecs-vp8 | anim | hiddenWindow | 30.0 | 30.0 | 32 / 36 | 48 | 2182 | 9092 | 85 | 17 |  |
| webcodecs-h264 | anim | hiddenWindow | 30.0 | 30.0 | 29 / 31 | 48 | 2159 | 8994 | 78 | 14 |  |
| screencast | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 |  |
| capturePoll | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | static | hiddenWindow | 2.0 | 2.0 | 26 / 36 | 502 | 101 | 6316 | 7 | 2 | libvpx; video/VP8 |
| webrtc-h264 | static | hiddenWindow | 0.9 | 0.9 | 22 / 166 | 1005 | 82 | 11357 | 7 | 1 | OpenH264; video/H264 |
| webcodecs-vp8 | static | hiddenWindow | 2.0 | 2.0 | 17 / 20 | 503 | 110 | 6903 | 6 | 1 |  |
| webcodecs-h264 | static | hiddenWindow | 2.0 | 2.0 | 22 / 26 | 525 | 9 | 553 | 5 | 1 |  |
| screencast | anim | shown | 64.0 | 64.0 | 29 / 31 | 17 | 50856 | 99327 | 99 | 24 |  |
| webrtc-vp8 | anim | shown | 24.7 | 0.0 | – | 77 | 2505 | 12678 | 99 | 16 | libvpx; video/VP8 |

### The pair · linux-x64 (pair-linux.json)

7.0.0-1017-azure, 35 s, state **done**, Windows app start: task

- **login start**: {"daemonUpMs":114,"daemonUp":true,"appConnectedMs":2610,"appStartedBy":"daemon","appStart":{"at":1793839269130,"safeMode":false,"reason":"daemon start","ok":true,"how":"systemctl --user start clover-s7-app-7f07b71e.service","out":""},"daemonParent":1312}
- **second daemon on the same home**: {"exitCode":0,"ms":50,"said":"2026-11-05T00:41:09.490Z [core 2690] another daemon holds this home (flock: held by another process); exiting","firstStillServing":true}
- **app crash**: {"killed":2648,"kill":{"ok":true,"how":"kill -9 2648","code":0,"out":""},"restartedMs":1222,"newPid":2710,"startedBy":"daemon","safeMode":false,"how":"systemctl --user start clover-s7-app-7f07b71e.service","eventsSinceKill":["start","tray","connected"]}
- **app crash loop → safe mode**: {"rounds":[{"killed":2710,"restartedMs":2226,"safeMode":false,"crashesInDaemon":2},{"killed":2761,"restartedMs":4248,"safeMode":true,"crashesInDaemon":3}],"thirdRestartInSafeMode":true}
- **daemon crash, restarted by the OS alone**: {"killed":2637,"kill":{"ok":true,"how":"kill -9 2637","code":0,"out":""},"daemonBackMs":1208,"newDaemonPid":2877,"appSurvived":true,"appPidAfter":2812,"samePid":true,"appStartedTheDaemon":false,"appEvents":["4ms daemon-lost","1510ms connected","1510ms reconnected"]}
- **daemon crash, the app helps after 3 s**: {"killed":2877,"kill":{"ok":true,"how":"kill -9 2877","code":0,"out":""},"daemonBackMs":1207,"newDaemonPid":2887,"appSurvived":true,"appPidAfter":2812,"samePid":true,"appStartedTheDaemon":false,"appEvents":["2ms daemon-lost","1506ms connected","1506ms reconnected"]}
- **tray Quit stops both, and they stay down**: {"forwarded":{"forwarded":true},"bothDownMs":402,"restartedWithin12s":false,"appEvents":["quit","quit-acked","daemon-quitting"]}
- **a user starts the app → it starts the daemon**: {"start":{"ok":true,"how":"spawn detached (as from a launcher)","code":0,"out":"2903"},"bothUpMs":513,"startedBy":"user","appStartedTheDaemon":[{"ok":true,"how":"systemctl --user start clover-s7-core-7f07b71e.service","out":""}],"appEvents":["start","tray","start-daemon","connected"]}
- **the daemon side's Quit stops both**: {"bothDownMs":402,"restartedWithin8s":false}

### The pair · darwin-arm64 (pair-macos.json)

25.6.0, 37 s, state **done**, Windows app start: task

- **login start**: {"daemonUpMs":130,"daemonUp":true,"appConnectedMs":3555,"appStartedBy":"daemon","appStart":{"at":1793839267058,"safeMode":false,"reason":"daemon start","ok":true,"how":"open -n -g -a /Users/runner/work/clover/clover/spikes/s7-browser/prototype/node_modules/electron/dist/Electron.app --args /Users/runner/work/clover/clover/spikes/s7-browser/prototype/out/pair/app --home=/var/folders/n6/hn37q6pj7sj_9dmqqc2113800000gn/T/clover-s7-pair-mmpjyK","out":""},"daemonParent":1}
- **second daemon on the same home**: {"exitCode":0,"ms":119,"said":"2026-11-05T00:41:08.181Z [core 1936] another daemon holds this home (flock: held by another process); exiting","firstStillServing":true}
- **app crash**: {"killed":1927,"kill":{"ok":true,"how":"kill -9 1927","code":0,"out":""},"restartedMs":1406,"newPid":1941,"startedBy":"daemon","safeMode":false,"how":"open -n -g -a /Users/runner/work/clover/clover/spikes/s7-browser/prototype/node_modules/electron/dist/Electron.app --args /Users/runner/work/clover/clover/spikes/s7-browser/prototype/out/pair/app --home=/var/folders/n6/hn37q6pj7sj_9dmqqc2113800000gn/T/clover-s7-pair-mmpjyK","eventsSinceKill":["start","tray","connected"]}
- **app crash loop → safe mode**: {"rounds":[{"killed":1941,"restartedMs":2550,"safeMode":false,"crashesInDaemon":2},{"killed":1953,"restartedMs":4488,"safeMode":true,"crashesInDaemon":3}],"thirdRestartInSafeMode":true}
- **daemon crash, restarted by the OS alone**: {"killed":1835,"kill":{"ok":true,"how":"kill -9 1835","code":0,"out":""},"daemonBackMs":1228,"newDaemonPid":2068,"appSurvived":true,"appPidAfter":2044,"samePid":true,"appStartedTheDaemon":false,"appEvents":["4ms daemon-lost","526ms connected","527ms reconnected"]}
- **daemon crash, the app helps after 3 s**: {"killed":2068,"kill":{"ok":true,"how":"kill -9 2068","code":0,"out":""},"daemonBackMs":1210,"newDaemonPid":2073,"appSurvived":true,"appPidAfter":2044,"samePid":true,"appStartedTheDaemon":false,"appEvents":["3ms daemon-lost","534ms connected","534ms reconnected"]}
- **tray Quit stops both, and they stay down**: {"forwarded":{"forwarded":true},"bothDownMs":409,"restartedWithin12s":false,"appEvents":["quit","quit-acked"]}
- **a user starts the app → it starts the daemon**: {"start":{"ok":true,"how":"open -n -g -a /Users/runner/work/clover/clover/spikes/s7-browser/prototype/node_modules/electron/dist/Electron.app --args /Users/runner/work/clover/clover/spikes/s7-browser/prototype/out/pair/app --home=/var/folders/n6/hn37q6pj7sj_9dmqqc2113800000gn/T/clover-s7-pair-mmpjyK","code":0,"out":""},"bothUpMs":995,"startedBy":"user","appStartedTheDaemon":[{"ok":true,"how":"launchctl kickstart gui/501/com.waifucave.clover.s7.core.edaaa651","out":""}],"appEvents":["start","tray","start-daemon","connected"]}
- **the daemon side's Quit stops both**: {"bothDownMs":409,"restartedWithin8s":false}

### The pair · win32-x64 (pair-windows-spawn.json)

10.0.26100, 187 s, state **done**, Windows app start: spawn

- **login start**: {"daemonUpMs":237,"daemonUp":true,"appConnectedMs":3301,"appStartedBy":"daemon","appStart":{"at":1793839278704,"safeMode":false,"reason":"daemon start","ok":true,"how":"spawn detached","out":"208"},"daemonParent":2672}
- **second daemon on the same home**: {"exitCode":0,"ms":62,"said":"2026-11-05T00:41:18.908Z [core 9112] another daemon holds this home (CreateFileW: error 32 (sharing violation: another daemon holds it)); exiting","firstStillServing":true}
- **app crash**: {"killed":208,"kill":{"ok":true,"how":"taskkill /F /T /PID 208","code":0,"out":"SUCCESS: The process with PID 8496 (child process of PID 208) has been terminated.\r\nSUCCESS: The process with PID 5432 (child process of PID 208) has been termi"},"restartedMs":1210,"newPid":8960,"startedBy":"daemon","safeMode":false,"how":"spawn detached","eventsSinceKill":["start","tray","connected"]}
- **app crash loop → safe mode**: {"rounds":[{"killed":8960,"restartedMs":2157,"safeMode":false,"crashesInDaemon":2},{"killed":3604,"restartedMs":4127,"safeMode":true,"crashesInDaemon":3}],"thirdRestartInSafeMode":true}
- **daemon crash, restarted by the OS alone**: {"killed":8952,"kill":{"ok":true,"how":"taskkill /F /PID 8952","code":0,"out":"SUCCESS: The process with PID 8952 has been terminated."},"appSurvived":true,"appPidAfter":8544,"samePid":true,"appStartedTheDaemon":{"atMs":150128,"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-e0e796e2"},"appEvents":["43ms daemon-lost","150128ms start-daemon","150632ms connected","150632ms reconnected"]}
- **daemon crash, the app helps after 3 s**: {"killed":7848,"kill":{"ok":true,"how":"taskkill /F /PID 7848","code":0,"out":"SUCCESS: The process with PID 7848 has been terminated."},"daemonBackMs":3276,"newDaemonPid":8900,"appSurvived":true,"appPidAfter":8544,"samePid":true,"appStartedTheDaemon":{"atMs":3102,"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-e0e796e2"},"appEvents":["54ms daemon-lost","3102ms start-daemon","3619ms connected","3619ms reconnected"]}
- **tray Quit stops both, and they stay down**: {"forwarded":{"forwarded":true},"bothDownMs":336,"restartedWithin12s":false,"appEvents":["quit","quit-acked"]}
- **a user starts the app → it starts the daemon**: {"start":{"ok":true,"how":"spawn detached","code":0,"out":"8704"},"bothUpMs":440,"startedBy":"user","appStartedTheDaemon":[{"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-e0e796e2","out":"SUCCESS: Attempted to run the scheduled task \"\\Clover S7\\core-e0e796e2\"."}],"appEvents":["start","tray","start-daemon","connected"]}
- **the daemon side's Quit stops both**: {"bothDownMs":326,"restartedWithin8s":false}

### The pair · win32-x64 (pair-windows-task.json)

10.0.26100, 187 s, state **done**, Windows app start: task

- **login start**: {"daemonUpMs":359,"daemonUp":true,"appConnectedMs":3064,"appStartedBy":"daemon","appStart":{"at":1793839282806,"safeMode":false,"reason":"daemon start","ok":true,"how":"schtasks /Run /TN \\Clover S7\\app-08c0d5bc","out":"SUCCESS: Attempted to run the scheduled task \"\\Clover S7\\app-08c0d5bc\"."},"daemonParent":2384}
- **second daemon on the same home**: {"exitCode":0,"ms":83,"said":"2026-11-05T00:41:23.465Z [core 8620] another daemon holds this home (CreateFileW: error 32 (sharing violation: another daemon holds it)); exiting","firstStillServing":true}
- **app crash**: {"killed":3676,"kill":{"ok":true,"how":"taskkill /F /T /PID 3676","code":0,"out":"SUCCESS: The process with PID 8144 (child process of PID 3676) has been terminated.\r\nSUCCESS: The process with PID 2696 (child process of PID 3676) has been ter"},"restartedMs":1220,"newPid":9096,"startedBy":"daemon","safeMode":false,"how":"schtasks /Run /TN \\Clover S7\\app-08c0d5bc","eventsSinceKill":["start","tray","connected"]}
- **app crash loop → safe mode**: {"rounds":[{"killed":9096,"restartedMs":2222,"safeMode":false,"crashesInDaemon":2},{"killed":8268,"restartedMs":4255,"safeMode":true,"crashesInDaemon":3}],"thirdRestartInSafeMode":true}
- **daemon crash, restarted by the OS alone**: {"killed":5996,"kill":{"ok":true,"how":"taskkill /F /PID 5996","code":0,"out":"SUCCESS: The process with PID 5996 has been terminated."},"appSurvived":true,"appPidAfter":7596,"samePid":true,"appStartedTheDaemon":{"atMs":150285,"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-08c0d5bc"},"appEvents":["53ms daemon-lost","150285ms start-daemon","150803ms connected","150804ms reconnected"]}
- **daemon crash, the app helps after 3 s**: {"killed":7636,"kill":{"ok":true,"how":"taskkill /F /PID 7636","code":0,"out":"SUCCESS: The process with PID 7636 has been terminated."},"daemonBackMs":3293,"newDaemonPid":3576,"appSurvived":true,"appPidAfter":7596,"samePid":true,"appStartedTheDaemon":{"atMs":3128,"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-08c0d5bc"},"appEvents":["95ms daemon-lost","3128ms start-daemon","3635ms connected","3636ms reconnected"]}
- **tray Quit stops both, and they stay down**: {"forwarded":{"forwarded":true},"bothDownMs":335,"restartedWithin12s":false,"appEvents":["quit-acked"]}
- **a user starts the app → it starts the daemon**: {"start":{"ok":true,"how":"spawn detached","code":0,"out":"1716"},"bothUpMs":555,"startedBy":"user","appStartedTheDaemon":[{"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-08c0d5bc","out":"SUCCESS: Attempted to run the scheduled task \"\\Clover S7\\core-08c0d5bc\"."}],"appEvents":["start","tray","start-daemon","connected"]}
- **the daemon side's Quit stops both**: {"bothDownMs":331,"restartedWithin8s":false}

