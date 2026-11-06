## Spike S7 results

### Chrome for Testing · linux-arm64 (cft-linux-arm64-apparmor.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 0 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 121 MiB archive, 277 MiB unpacked, 287 files, 0 symlinks; download 539 ms, unpack 965 ms; sha256 `5bb6a00a4285c13303d3f72c5afdb70f144ea7a93eed462365a52b69631c9607` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 50 ms, warm 44 ms; the port for comparison 56 ms
- start attempts: fdpipe ok 50 ms

### Chrome for Testing · linux-arm64 (cft-linux-arm64.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 192 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox off (--no-sandbox: every sandboxed start failed)

- install: 121 MiB archive, 277 MiB unpacked, 287 files, 0 symlinks; download 539 ms, unpack 965 ms; sha256 `5bb6a00a4285c13303d3f72c5afdb70f144ea7a93eed462365a52b69631c9607` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 1390 ms, warm 42 ms; the port for comparison 46 ms
- start attempts: fdpipe failed (fdpipe start failed: browser exited (SIGTRAP) during Browser.getVersion (exit SIGTRAP); stderr: [1105/012426.829740:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:130] No usable sandbox! If you are running o); pipe failed (pipe start failed: browser exited (SIGTRAP) during Browser.getVersion (exit SIGTRAP); stderr: [1105/012427.060267:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:130] No usable sandbox! If you are running on ); port failed (port start failed: browser exited before listening (exit SIGTRAP); stderr: [1105/012427.217513:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:130] No usable sandbox! If you are running on Ubuntu 23.10+ or an); fdpipe --no-sandbox ok 1390 ms
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 175 MiB, per idle tab 23 MiB, 4 browser contexts +95 MiB, a second bot's browser 113 MiB (6 processes), animated tab 50.1% CPU
  - steps: 0 tabs 175 MiB pss / 0.3%, 1 tabs 210 MiB pss / 1.5%, 2 tabs 234 MiB pss / 3.7%, 4 tabs 276 MiB pss / 7.5%, 8 tabs 361 MiB pss / 12.9%
- errors: tabs: Runtime.evaluate timed out; screenshots: Target.createTarget timed out

**chrome** — Chrome/156.0.8078.80; sandbox off (--no-sandbox: every sandboxed start failed)

- install: 191 MiB archive, 401 MiB unpacked, 301 files, 0 symlinks; download 737 ms, unpack 1351 ms; sha256 `1f496a826c9ba4d6a5f5bf2de686145fe718528c2cc3dbeb96b5893b89653724` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 305 ms, warm 197 ms; the port for comparison 251 ms
- start attempts: fdpipe failed (fdpipe start failed: browser exited (SIGABRT) during Browser.getVersion (exit SIGABRT); stderr: #10 0xab4bfff39138 (/home/runner/work/_temp/clover-s7-home/browsers/cft/156.0.8078.80/chrome-linux-arm64/chrome-linux-arm64/); pipe failed (pipe start failed: browser exited (SIGABRT) during Browser.getVersion (exit SIGABRT); stderr: #10 0xab1a1fbf9138 (/home/runner/work/_temp/clover-s7-home/browsers/cft/156.0.8078.80/chrome-linux-arm64/chrome-linux-arm64/ch); port failed (port start failed: browser exited before listening (exit SIGABRT); stderr: #10 0xaaaff48d9138 (/home/runner/work/_temp/clover-s7-home/browsers/cft/156.0.8078.80/chrome-linux-arm64/chrome-linux-arm64/chrome+0xa869137) | #); fdpipe --no-sandbox ok 305 ms
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 451 MiB, per idle tab 48 MiB, 4 browser contexts +313 MiB, a second bot's browser 283 MiB (11 processes), animated tab 54.1% CPU
  - steps: 0 tabs 451 MiB pss / 1.2%, 1 tabs 520 MiB pss / 1.7%, 2 tabs 593 MiB pss / 4.2%, 4 tabs 657 MiB pss / 8.4%, 8 tabs 836 MiB pss / 14.9%
- errors: tabs: Page.navigate timed out; screenshots: Target.createTarget timed out

### Chrome for Testing · linux-x64 (cft-linux-x64-apparmor.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 1 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 121 MiB archive, 274 MiB unpacked, 287 files, 0 symlinks; download 2124 ms, unpack 1226 ms; sha256 `547dcd374e02961bf998f6046a267644f8502225c36bb78ca307dab32a0b3eb4` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 78 ms, warm 73 ms; the port for comparison 83 ms
- start attempts: fdpipe ok 78 ms

### Chrome for Testing · linux-x64 (cft-linux-x64.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 99 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox off (--no-sandbox: every sandboxed start failed)

- install: 121 MiB archive, 274 MiB unpacked, 287 files, 0 symlinks; download 2124 ms, unpack 1226 ms; sha256 `547dcd374e02961bf998f6046a267644f8502225c36bb78ca307dab32a0b3eb4` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 192 ms, warm 41 ms; the port for comparison 60 ms
- start attempts: fdpipe failed (fdpipe start failed: browser exited (SIGTRAP) during Browser.getVersion (exit SIGTRAP); stderr: [1105/012430.000812:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:130] No usable sandbox! If you are running o); pipe failed (pipe start failed: browser exited (SIGTRAP) during Browser.getVersion (exit SIGTRAP); stderr: [1105/012430.192258:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:130] No usable sandbox! If you are running on ); port failed (port start failed: browser exited before listening (exit SIGTRAP); stderr: [1105/012430.374308:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:130] No usable sandbox! If you are running on Ubuntu 23.10+ or an); fdpipe --no-sandbox ok 192 ms
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 171 MiB, per idle tab 23 MiB, 4 browser contexts +94 MiB, a second bot's browser 113 MiB (6 processes), animated tab 32.3% CPU
  - steps: 0 tabs 171 MiB pss / 0.0%, 1 tabs 206 MiB pss / 2.0%, 2 tabs 228 MiB pss / 3.7%, 4 tabs 271 MiB pss / 6.5%, 8 tabs 356 MiB pss / 11.4%
- errors: tabs: Runtime.evaluate timed out; screenshots: Target.createTarget timed out

**chrome** — ; sandbox –

- install: 192 MiB archive, 403 MiB unpacked, 301 files, 0 symlinks; download 2961 ms, unpack 1753 ms; sha256 `b711c720f774be355197f32edf37e0651418ba036d92446ee2da19ac017540a7` (matches the pin; server MD5 true)
- start attempts: fdpipe failed (fdpipe start failed: browser exited (SIGABRT) during Browser.getVersion (exit SIGABRT); stderr: #16 0x5574b9ec503a (/home/runner/work/_temp/clover-s7-home/browsers/cft/156.0.8078.80/chrome-linux64/chrome-linux64/chrome+0); pipe failed (pipe start failed: browser exited (SIGABRT) during Browser.getVersion (exit SIGABRT); stderr: #16 0x5581c49e403a (/home/runner/work/_temp/clover-s7-home/browsers/cft/156.0.8078.80/chrome-linux64/chrome-linux64/chrome+0x7); port failed (port start failed: browser exited before listening (exit SIGABRT); stderr: #16 0x55d6be97303a (/home/runner/work/_temp/clover-s7-home/browsers/cft/156.0.8078.80/chrome-linux64/chrome-linux64/chrome+0x7646039) |   r8: 000); fdpipe --no-sandbox ok 302 ms
- errors: start: browser exited (0) during Browser.getVersion

### Chrome for Testing · darwin-arm64 (cft-macos.json)

25.6.0, 3 CPUs, 7 GiB, Bun 1.3.14, status **done**, 231 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 99 MiB archive, 204 MiB unpacked, 16 files, 0 symlinks; download 1406 ms, unpack 1876 ms; sha256 `ea615baa2e9caf0d02d1898a6562b5f8fa9c35239707dae0f592178df5b986ac` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 1070 ms, warm 187 ms; the port for comparison 239 ms
- start attempts: fdpipe ok 1070 ms
- tabs: one window: first (background): visible, 1280x800, interval 70.5 Hz, rAF 42.5 Hz, media ×0.97, decoded 29.5 fps, audio running; one window: second (front): visible, 1280x800, interval 71.1 Hz, rAF 45.3 Hz, media ×0.99, decoded 29.8 fps, audio running; own window: first (background): visible, 1280x800, interval 66.3 Hz, rAF 29.0 Hz, media ×1.00, decoded 29.8 fps, audio running; own window: second (front): visible, 1280x800, interval 67.5 Hz, rAF 30.8 Hz, media ×0.98, decoded 29.8 fps, audio running
- resize to 1000×700 and back: 9 ms / 56 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 327 / 362 ms (635 KiB, CPU 271 ms), jpeg 132 / 209 ms (131 KiB, stale -87 / -46 ms, CPU 79 ms)
- screencast: 30.9 fps, 29621 kbit/s, 117 KiB/frame, latency 54 / 90 ms, browser CPU 49%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 44 MiB, per idle tab 33 MiB, 4 browser contexts +132 MiB, a second bot's browser 44 MiB (4 processes), animated tab 36.9% CPU
  - steps: 0 tabs 44 MiB footprint / 0.5%, 1 tabs 78 MiB footprint / 3.0%, 2 tabs 111 MiB footprint / 5.4%, 4 tabs 178 MiB footprint / 8.6%, 8 tabs 311 MiB footprint / 21.5%

**chrome** — Chrome/156.0.8078.80; sandbox on

- install: 186 MiB archive, 366 MiB unpacked, 344 files, 5 symlinks; download 1193 ms, unpack 2013 ms; sha256 `8bc590d1b1acac042a000234c768f31830f25a3983a83ed5e067114c87c4cad1` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 2882 ms, warm 1023 ms; the port for comparison 1469 ms
- start attempts: fdpipe ok 2882 ms
- tabs: one window: first (background): hidden, 1280x657, interval 1.2 Hz, rAF 0.0 Hz, media ×0.00, decoded 0.0 fps, audio running; one window: second (front): visible, 1280x657, interval 68.9 Hz, rAF 26.9 Hz, media ×0.97, decoded 29.7 fps, audio running; own window: first (background): visible, 1280x657, interval 66.3 Hz, rAF 27.1 Hz, media ×0.96, decoded 29.1 fps, audio running; own window: second (front): hidden, 1280x657, interval 1.6 Hz, rAF 0.0 Hz, media ×0.95, decoded 27.9 fps, audio running
- resize to 1000×700 and back: 10 ms / 45 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 262 / 440 ms (471 KiB, CPU 190 ms), jpeg 145 / 229 ms (113 KiB, stale -106 / -4 ms, CPU 73 ms)
- screencast: 27.0 fps, 22505 kbit/s, 102 KiB/frame, latency 83 / 158 ms, browser CPU 35%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 270 MiB, per idle tab 57 MiB, 4 browser contexts +437 MiB, a second bot's browser 273 MiB (10 processes), animated tab 12.4% CPU
  - steps: 0 tabs 270 MiB footprint / 5.4%, 1 tabs 361 MiB footprint / 3.7%, 2 tabs 414 MiB footprint / 4.0%, 4 tabs 506 MiB footprint / 5.2%, 8 tabs 728 MiB footprint / 6.9%

### Chrome for Testing · win32-x64 (cft-windows.json)

10.0.26100, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 218 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 120 MiB archive, 282 MiB unpacked, 288 files, 0 symlinks; download 979 ms, unpack 1471 ms; sha256 `10a77466005e7f64e00f1a75fd1ea81f4a38a60093c65fea6895843b26e60a9a` (matches the pin; server MD5 true)
- start: over **winpipe**, cold 228 ms, warm 97 ms; the port for comparison 90 ms
- start attempts: winpipe ok 228 ms
- tabs: one window: first (background): visible, 1280x800, interval 100.2 Hz, rAF 60.1 Hz, media ×0.99, decoded 29.3 fps, audio running; one window: second (front): visible, 1280x800, interval 100.0 Hz, rAF 60.1 Hz, media ×0.94, decoded 29.1 fps, audio running; own window: first (background): visible, 1280x800, interval 100.0 Hz, rAF 59.9 Hz, media ×0.98, decoded 29.3 fps, audio running; own window: second (front): visible, 1280x800, interval 100.1 Hz, rAF 59.9 Hz, media ×0.98, decoded 29.2 fps, audio running
- resize to 1000×700 and back: 13 ms / 9 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 193 / 207 ms (578 KiB, CPU 232 ms), jpeg 56 / 63 ms (141 KiB, stale -43 / -40 ms, CPU 72 ms)
- screencast: 60.6 fps, 56222 kbit/s, 113 KiB/frame, latency 15 / 18 ms, browser CPU 81%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 69 MiB, per idle tab 29 MiB, 4 browser contexts +115 MiB, a second bot's browser 71 MiB (5 processes), animated tab 28.1% CPU
  - steps: 0 tabs 69 MiB privateBytes / 0.0%, 1 tabs 99 MiB privateBytes / 1.8%, 2 tabs 131 MiB privateBytes / 2.5%, 4 tabs 188 MiB privateBytes / 3.3%, 8 tabs 301 MiB privateBytes / 13.0%

**chrome** — Chrome/156.0.8078.80; sandbox on

- install: 199 MiB archive, 439 MiB unpacked, 305 files, 0 symlinks; download 874 ms, unpack 2864 ms; sha256 `16edb57d6107bf1c48a7c149b8d78b155fe614410093796dd72441fd6640540f` (matches the pin; server MD5 true)
- start: over **winpipe**, cold 504 ms, warm 218 ms; the port for comparison 399 ms
- start attempts: winpipe ok 504 ms
- tabs: one window: first (background): hidden, 1264x649, interval 1.0 Hz, rAF 0.0 Hz, media ×0.00, decoded 0.0 fps, audio running; one window: second (front): visible, 1264x649, interval 100.0 Hz, rAF 59.9 Hz, media ×0.93, decoded 28.9 fps, audio running; own window: first (background): visible, 1264x649, interval 100.0 Hz, rAF 59.9 Hz, media ×0.98, decoded 29.3 fps, audio running; own window: second (front): visible, 1264x649, interval 100.0 Hz, rAF 60.1 Hz, media ×0.98, decoded 29.3 fps, audio running
- resize to 1000×700 and back: 9 ms / 9 ms, same document true (1264 → 1000 → 1264)
- screenshots: png 181 / 186 ms (460 KiB, CPU 240 ms), jpeg 75 / 80 ms (109 KiB, stale -48 / -43 ms, CPU 98 ms)
- screencast: 60.6 fps, 47533 kbit/s, 96 KiB/frame, latency 28 / 31 ms, browser CPU 85%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 263 MiB, per idle tab 52 MiB, 4 browser contexts +477 MiB, a second bot's browser 263 MiB (12 processes), animated tab 32.4% CPU
  - steps: 0 tabs 263 MiB privateBytes / 0.0%, 1 tabs 342 MiB privateBytes / 4.3%, 2 tabs 398 MiB privateBytes / 8.9%, 4 tabs 455 MiB privateBytes / 8.6%, 8 tabs 681 MiB privateBytes / 22.1%

### Electron · linux-arm64-ozone-headless (electron-linux-arm64-ozone-headless.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-arm64 7.0.0-1017-azure, ozone headless, displays 1920x1080@1, status **done**, 459 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.91 | 27.9 | 27 / 73 | 1 / 7 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.95 | 28.4 | 27 / 31 | 4 / 18 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.4 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.95 | 28.4 | 25 / 31 | 4 / 17 | 1280x800@1 → 1000x700@1 → 1280x800 | 1 / 1 | 2.4 |  |
| invisibleWindow | true | true | true | true (1) | 0.96 | 28.6 | 18 / 27 | 1 / 12 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.1 |  |
| tinyWindow | true | true | true | true (1) | 0.96 | 28.6 | 23 / 29 | 1 / 13 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.0 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 99.9 | 99.3 | 60.2 | 17 | – | – | – | 4.4 | 6.2 |  |
| detached, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | – | – | – | 0.0 | 0.0 |  |
| detached, throttling off | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | – | – | – | 1.0 | 1.0 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 1.8 | 1.0 | 0.0 | 0 | – | – | – | 0.0 | 0.2 |  |
| never-shown window, throttling off | visible | 1280x800 | 100.1 | 99.3 | 0.0 | 0 | – | – | – | 0.8 | 1.0 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 100.0 | 99.4 | 1.0 | 1017 | – | – | – | 1.2 | 1.4 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 100.1 | 99.1 | 0.0 | 0 | – | – | 0.0 | 1.0 | 1.0 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 100.1 | 99.1 | 0.0 | 0 | – | – | 0.0 | 0.8 | 1.0 |  |
| invisible shown window, throttling off | visible | 1280x800 | 99.9 | 99.3 | 60.0 | 17 | – | – | – | 4.6 | 6.4 |  |
| 1x1 shown window, throttling off | visible | 1280x800 | 100.0 | 99.4 | 60.0 | 17 | – | – | – | 4.4 | 6.0 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 99.9 | 99.1 | 60.1 | 17 | – | – | – | 4.6 | 6.0 | cover 0,0 1920x1080 over host 0,0 1x1 |
| 1x1 shown window, always on top, under a cover | visible | 1280x800 | 100.0 | 99.4 | 60.0 | 17 | – | – | – | 4.8 | 6.2 | cover 0,0 1920x1080 over host 0,0 1x1 |
| invisible shown window, covered by another window | visible | 1280x800 | 100.2 | 99.2 | 60.0 | 17 | – | – | – | 4.4 | 5.8 | cover -1480,-1000 1920x1080 over host -1480,-1000 1280x800 |
| osr window 30 fps, throttling off | visible | 1280x800 | 100.1 | 98.9 | 30.0 | 34 | – | – | – | 3.4 | 11.8 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 100.1 | 99.1 | 30.0 | 37 | – | – | – | 2.2 | 2.6 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 100.0 | 99.4 | 0.0 | 0 | 0.85 | 24.8 | – | 2.4 | 3.0 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.85 | 25.8 | – | 2.6 | 3.4 |  |
| detached, throttling off, playing media | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.85 | 24.8 | – | 2.8 | 3.6 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 100.1 | 99.1 | 0.0 | 0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 2.0 | 1.0 | 0.0 | 0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | CPU ms/picture | frames/s | visibility events | errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 15 / 16 | 7 / 12 | 1000x700 | 57 | – |  |  |
| shown | true | capturePage | 6/6 | 6 | 14 / 16 | 7 / 9 | 1000x700 | 53 | – |  |  |
| shown | true | cdpJpeg | 6/6 | 6 | 75 / 82 | -48 / -34 | 1000x700 | 85 | – |  |  |
| shown | true | frameSub | 6/6 | 6 | 16 / 19 | 8 / 9 | 1000x700 | 50 | – |  |  |
| shown | true | cdpPng | 6/6 | 6 | 170 / 178 | -40 / -34 | 1000x700 | 220 | – |  |  |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | 3 | – |  | Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | 70 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | 40 | – |  | frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | 3 | – |  | Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 4046 / 4050 | -2995 / -46 | 1280x800 | 137 | – |  |  |
| hiddenWindow | false | frameSub | 6/6 | 6 | 7 / 8 | 60 / 74 | 1280x800 | 43 | – |  |  |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.5 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | 5 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 97 / 100 | -61 / -27 | 1280x800 | 150 | – |  |  |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 15 / 16 | 8 / 9 | 1280x800 | 85 | – |  |  |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 6/6 | 6 | 15 / 16 | 9 / 10 | 1280x800 | 70 | – |  |  |
| invisibleWindow | false | capturePage | 6/6 | 6 | 14 / 16 | 10 / 11 | 1280x800 | 67 | – |  |  |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 80 / 87 | -45 / -38 | 1280x800 | 125 | – |  |  |
| invisibleWindow | false | frameSub | 6/6 | 6 | 15 / 20 | 12 / 14 | 1280x800 | 70 | – |  |  |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 15 / 15 | 9 / 14 | 1280x800 | 63 | – |  |  |
| tinyWindow | false | capturePage | 6/6 | 6 | 15 / 16 | 9 / 13 | 1280x800 | 63 | – |  |  |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 81 / 86 | -45 / -39 | 1280x800 | 103 | – |  |  |
| tinyWindow | false | frameSub | 6/6 | 6 | 15 / 20 | 11 / 12 | 1280x800 | 62 | – |  |  |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 14 / 15 | 9 / 13 | 1280x800 | 65 | – |  |  |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 13 / 16 | 10 / 12 | 1280x800 | 60 | – |  |  |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 80 / 83 | -45 / -39 | 1280x800 | 108 | – |  |  |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 15 / 18 | 11 / 12 | 1280x800 | 60 | – |  |  |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 1 | 30 / 35 | 1280x800 | 37 | – |  |  |
| osr | false | capturePage | 6/6 | 6 | 31 / 39 | -19 / -18 | 1280x800 | 58 | – |  |  |
| osr | false | cdpJpeg | 6/6 | 6 | 99 / 110 | -73 / -71 | 1280x800 | 98 | – |  |  |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | 160 | – |  | no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | 3 | – |  | empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | 140 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 234 | pss | 505 | 4 | 0.0 |
| 1 | 262 | pss | 621 | 5 | 0.3 |
| 2 | 277 | pss | 739 | 6 | 0.0 |
| 4 | 307 | pss | 975 | 8 | 0.3 |
| 8 | 360 | pss | 1409 | 12 | 0.5 |

Per idle hidden tab: **16 MiB**, 0.06% CPU. Four tabs: one partition +65 MiB, four partitions +69 MiB.

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 36.5 | 28.7 | 7.5 | 60 |
| animated, never-shown window, throttling off | 1.3 | 1.0 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.5 | 0.0 | 0.0 | 0 |
| animated, never-shown window, throttling off + frame pump | 1.3 | 1.0 | 0.0 | 0 |
| animated, invisible shown window | 48.0 | 37.7 | 10.0 | 60 |
| animated, 1x1 shown window | 39.0 | 37.7 | 1.3 | 60 |
| animated, osr 30 fps | 32.3 | 20.0 | 5.5 | 30 |

### Electron · linux-wayland (electron-linux-wayland.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone wayland, displays 1920x1080@1, status **done**, 728 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.90 | 27.6 | 27 / 294 | 0 / 279 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.92 | 27.5 | 28 / 37 | 1 / 1 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.93 | 27.5 | 28 / 32 | 1 / 3 | 1280x800@1 → 1000x700@1 → 1280x800 | 1 / 1 | 0.0 |  |
| tinyWindow | true | true | true | true (1) | 0.96 | 28.6 | 22 / 31 | 11 / 15 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 40.6 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 100.0 | 99.4 | 40.0 | 26 | – | – | – | 2.8 | 5.2 |  |
| detached, throttling on (default) | hidden | 1280x800 | 2.0 | 1.0 | 0.0 | 0 | – | – | – | 0.2 | 0.8 |  |
| detached, throttling off | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | – | – | – | 1.0 | 1.2 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | – | – | – | 0.0 | 0.0 |  |
| never-shown window, throttling off | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | – | – | – | 0.8 | 0.8 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 100.1 | 99.1 | 0.0 | 0 | – | – | – | 1.0 | 1.4 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | – | – | 0.0 | 1.0 | 1.2 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 99.9 | 98.9 | 0.0 | 0 | – | – | 0.0 | 1.0 | 1.2 |  |
| invisible shown window, throttling off | – | – | – | – | – | – | – | – | – | – | – | not possible here |
| 1x1 shown window, throttling off | visible | 1280x800 | 100.0 | 99.2 | 40.0 | 26 | – | – | – | 2.6 | 4.6 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 100.2 | 99.4 | 40.0 | 26 | – | – | – | 2.6 | 4.4 | cover -10,-10 1940x1100 over host 0,0 1x1 |
| 1x1 shown window, always on top, under a cover | visible | 1280x800 | 100.1 | 99.1 | 40.0 | 26 | – | – | – | 2.8 | 5.0 | cover -10,-10 1940x1100 over host 0,0 1x1 |
| invisible shown window, covered by another window | – | – | – | – | – | – | – | – | – | – | – | not possible here |
| osr window 30 fps, throttling off | visible | 1280x800 | 100.0 | 99.2 | 30.0 | 34 | – | – | – | 2.4 | 10.6 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 100.0 | 99.2 | 30.0 | 34 | – | – | – | 1.6 | 1.8 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 100.1 | 99.3 | 0.0 | 0 | 0.85 | 25.8 | – | 2.0 | 2.6 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.85 | 25.8 | – | 1.8 | 3.0 |  |
| detached, throttling off, playing media | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.85 | 25.8 | – | 2.2 | 3.0 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 100.0 | 99.0 | 0.0 | 0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | CPU ms/picture | frames/s | visibility events | errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 26 / 27 | 31 / 46 | 1000x700 | 37 | – |  |  |
| shown | true | capturePage | 6/6 | 6 | 26 / 26 | 30 / 32 | 1000x700 | 30 | – |  |  |
| shown | true | cdpJpeg | 6/6 | 6 | 129 / 138 | -63 / -61 | 1000x700 | 58 | – |  |  |
| shown | true | frameSub | 6/6 | 6 | 26 / 27 | 33 / 42 | 1000x700 | 27 | – |  |  |
| shown | true | cdpPng | 6/6 | 6 | 235 / 255 | -66 / -63 | 1000x700 | 172 | – |  |  |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 29.5 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | 90 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | 55 | – |  | frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 0/2 | 0 | – | – | - | 65 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| hiddenWindow | false | frameSub | 0/2 | 0 | – | – | - | 60 | – |  | frame subscription: timed out after 5000 ms |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | 3 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 0/2 | 0 | – | – | - | 65 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| hiddenWindow + pump | false | frameSub | 0/2 | 0 | – | – | - | 60 | – |  | frame subscription: timed out after 5000 ms |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| invisibleWindow | false | - | 0/0 | 0 | – | – | - | – | – |  | not possible here |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 23 / 25 | 35 / 37 | 1280x800 | 35 | – |  |  |
| tinyWindow | false | capturePage | 6/6 | 6 | 23 / 24 | 35 / 36 | 1280x800 | 37 | – |  |  |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 124 / 134 | -54 / -53 | 1280x800 | 55 | – |  |  |
| tinyWindow | false | frameSub | 6/6 | 6 | 23 / 25 | 37 / 49 | 1280x800 | 35 | – |  |  |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 22 / 23 | 60 / 68 | 1280x800 | 33 | – |  |  |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 23 / 25 | 60 / 61 | 1280x800 | 28 | – |  |  |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 148 / 159 | -55 / -50 | 1280x800 | 57 | – |  |  |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 23 / 25 | 63 / 72 | 1280x800 | 37 | – |  |  |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 17 / 23 | 1280x800 | 25 | – |  |  |
| osr | false | capturePage | 6/6 | 6 | 31 / 32 | -21 / -7 | 1280x800 | 37 | – |  |  |
| osr | false | cdpJpeg | 6/6 | 6 | 98 / 110 | -75 / -73 | 1280x800 | 67 | – |  |  |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | 145 | – |  | no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | 105 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 325 | pss | 591 | 4 | 0.3 |
| 1 | 353 | pss | 696 | 5 | 0.0 |
| 2 | 368 | pss | 803 | 6 | 0.3 |
| 4 | 396 | pss | 1017 | 8 | 0.3 |
| 8 | 448 | pss | 1443 | 12 | 1.0 |

Per idle hidden tab: **15 MiB**, 0.09% CPU. Four tabs: one partition +65 MiB, four partitions +69 MiB.

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 13.8 | 8.8 | 4.3 | 39 |
| animated, never-shown window, throttling off | 1.0 | 0.8 | 0.3 | 0 |
| animated, never-shown window, throttling on | 0.3 | 0.0 | 0.3 | 0 |
| animated, never-shown window, throttling off + frame pump | 1.0 | 0.8 | 0.0 | 0 |
| animated, 1x1 shown window | 12.0 | 9.5 | 1.5 | 40 |
| animated, osr 30 fps | 18.8 | 8.0 | 3.5 | 30 |

**Q6 streamed view** (10 s at the viewer; latency p50 / p95 ms)

| road | content | source | fps | decoded fps | latency | gap p95 | kbit/s | bytes/frame | sender CPU % | viewer CPU % | source rAF | notes |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| screencast | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | 0 |  |
| capturePoll | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | {} |
| webrtc-h264 | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | {} |
| webcodecs-vp8 | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | {} |
| webcodecs-h264 | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | {} |
| screencast | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | 0 |  |
| capturePoll | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | {} |
| webrtc-h264 | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | {} |
| webcodecs-vp8 | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | {} |
| webcodecs-h264 | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | {} |
| screencast | anim | invisibleWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | not possible here |
| capturePoll | anim | invisibleWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | not possible here |
| webcodecs-h264 | anim | invisibleWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | not possible here |
| screencast | anim | tinyWindow | 39.9 | 39.9 | 69 / 70 | 26 | 43993 | 137821 | 82 | 21 | 40 |  |
| webcodecs-h264 | anim | tinyWindow | 30.1 | 30.1 | 65 / 67 | 52 | 2411 | 10011 | 67 | 16 | 40 |  |
| screencast | anim | shown | 38.9 | 38.9 | 67 / 68 | 27 | 35663 | 114598 | 66 | 17 | 39 |  |
| webrtc-vp8 | anim | shown | 20.7 | 20.7 | 81 / 88 | 79 | 2507 | 15138 | 74 | 14 | 39 | libvpx; video/VP8 |
| webcodecs-h264 | anim | shown | 30.0 | 30.0 | 71 / 73 | 53 | 2412 | 10050 | 80 | 16 | 39 |  |

### Electron · linux-x11 (electron-linux-x11.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone x11, displays 1920x1080@1, status **done**, 748 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.93 | 27.9 | 30 / 32 | 1 / 14 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.95 | 28.4 | 15 / 29 | 4 / 19 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.3 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.95 | 28.4 | 16 / 26 | 4 / 17 | 1280x800@1 → 1000x700@1 → 1280x800 | 1 / 1 | 2.4 |  |
| invisibleWindow | true | true | true | true (1) | 0.95 | 28.4 | 24 / 30 | 2 / 15 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.0 |  |
| tinyWindow | true | true | true | true (1) | 0.96 | 28.6 | 24 / 30 | 15 / 17 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.0 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 100.0 | 99.2 | 60.0 | 18 | – | – | – | 3.6 | 5.4 |  |
| detached, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | – | – | – | 0.0 | 0.2 |  |
| detached, throttling off | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | – | – | – | 1.0 | 1.0 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | – | – | – | 0.0 | 0.0 |  |
| never-shown window, throttling off | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | – | – | – | 1.2 | 1.2 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 100.1 | 99.1 | 1.0 | 1017 | – | – | – | 1.2 | 1.8 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | – | – | 0.0 | 1.2 | 1.4 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | – | – | 0.0 | 1.0 | 1.2 |  |
| invisible shown window, throttling off | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | – | – | – | 1.0 | 1.0 |  |
| 1x1 shown window, throttling off | visible | 1280x800 | 100.0 | 99.4 | 60.0 | 18 | – | – | – | 3.6 | 5.0 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 100.0 | 99.2 | 60.0 | 18 | – | – | – | 3.6 | 5.2 | cover 0,0 1919x1079 over host 0,0 1x1 |
| 1x1 shown window, always on top, under a cover | visible | 1280x800 | 100.1 | 99.1 | 60.0 | 20 | – | – | – | 3.4 | 5.2 | cover 0,0 1919x1079 over host 0,0 1x1 |
| invisible shown window, covered by another window | visible | 1280x800 | 100.1 | 99.1 | 0.0 | 0 | – | – | – | 1.0 | 1.2 | cover -1480,-1000 1919x1079 over host -1480,-1000 1280x800 |
| osr window 30 fps, throttling off | visible | 1280x800 | 100.0 | 99.2 | 30.0 | 35 | – | – | – | 2.4 | 11.0 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 100.0 | 99.2 | 30.0 | 34 | – | – | – | 2.0 | 2.8 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 100.0 | 99.4 | 0.0 | 0 | 0.85 | 25.6 | – | 2.0 | 3.0 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 100.2 | 99.2 | 0.0 | 0 | 0.85 | 25.8 | – | 2.4 | 3.2 |  |
| detached, throttling off, playing media | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.85 | 25.8 | – | 1.8 | 2.6 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 100.0 | 99.0 | 0.0 | 0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | CPU ms/picture | frames/s | visibility events | errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 14 / 15 | -7 / 1 | 1000x700 | 37 | – |  |  |
| shown | true | capturePage | 6/6 | 6 | 15 / 16 | -7 / -6 | 1000x700 | 35 | – |  |  |
| shown | true | cdpJpeg | 6/6 | 6 | 64 / 66 | -48 / -39 | 1000x700 | 55 | – |  |  |
| shown | true | frameSub | 6/6 | 6 | 15 / 24 | -6 / -4 | 1000x700 | 30 | – |  |  |
| shown | true | cdpPng | 6/6 | 6 | 176 / 192 | -45 / -37 | 1000x700 | 197 | – |  |  |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | 3 | – |  | Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | 80 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | 70 | – |  | frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 4046 / 4048 | -2995 / -42 | 1280x800 | 110 | – |  |  |
| hiddenWindow | false | frameSub | 6/6 | 6 | 7 / 8 | 60 / 74 | 1280x800 | 28 | – |  |  |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.5 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | 5 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 97 / 100 | -61 / -25 | 1280x800 | 105 | – |  |  |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 15 / 17 | 9 / 10 | 1280x800 | 58 | – |  |  |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| invisibleWindow | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 80 / 85 | -43 / -23 | 1280x800 | 83 | – |  |  |
| invisibleWindow | false | frameSub | 6/6 | 6 | 14 / 21 | 14 / 15 | 1280x800 | 43 | – |  |  |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 14 / 24 | 10 / 11 | 1280x800 | 38 | – |  |  |
| tinyWindow | false | capturePage | 6/6 | 6 | 14 / 16 | 11 / 12 | 1280x800 | 33 | – |  |  |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 80 / 83 | -44 / -38 | 1280x800 | 63 | – |  |  |
| tinyWindow | false | frameSub | 6/6 | 6 | 15 / 21 | 13 / 14 | 1280x800 | 37 | – |  |  |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 14 / 22 | -4 / -3 | 1280x800 | 38 | – |  |  |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 14 / 15 | -4 / -4 | 1280x800 | 35 | – |  |  |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 65 / 65 | -42 / -36 | 1280x800 | 60 | – |  |  |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 15 / 20 | -2 / 0 | 1280x800 | 37 | – |  |  |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.5 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 49 / 56 | 1280x800 | 22 | – |  |  |
| osr | false | capturePage | 6/6 | 6 | 31 / 32 | 12 / 26 | 1280x800 | 45 | – |  |  |
| osr | false | cdpJpeg | 6/6 | 6 | 131 / 142 | -77 / -75 | 1280x800 | 80 | – |  |  |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | 173 | – |  | no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | 150 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 320 | pss | 584 | 4 | 0.0 |
| 1 | 348 | pss | 688 | 5 | 0.3 |
| 2 | 363 | pss | 795 | 6 | 0.0 |
| 4 | 391 | pss | 1009 | 8 | 1.0 |
| 8 | 442 | pss | 1435 | 12 | 0.3 |

Per idle hidden tab: **15 MiB**, 0.03% CPU. Four tabs: one partition +65 MiB, four partitions +68 MiB.

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 17.0 | 12.0 | 5.0 | 60 |
| animated, never-shown window, throttling off | 1.0 | 1.0 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.5 | 0.3 | 0.0 | 0 |
| animated, never-shown window, throttling off + frame pump | 1.3 | 1.3 | 0.0 | 0 |
| animated, invisible shown window | 1.0 | 1.0 | 0.0 | 0 |
| animated, 1x1 shown window | 17.3 | 15.0 | 2.0 | 60 |
| animated, osr 30 fps | 22.7 | 9.8 | 5.3 | 30 |

**Q6 streamed view** (10 s at the viewer; latency p50 / p95 ms)

| road | content | source | fps | decoded fps | latency | gap p95 | kbit/s | bytes/frame | sender CPU % | viewer CPU % | source rAF | notes |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| screencast | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 |  |
| capturePoll | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | anim | hiddenWindow | 20.9 | 20.9 | 40 / 47 | 78 | 2514 | 15035 | 52 | 13 | 60 | libvpx; video/VP8 |
| webrtc-h264 | anim | hiddenWindow | 12.5 | 12.5 | 65 / 85 | 112 | 2501 | 25008 | 48 | 8 | 60 | OpenH264; video/H264 |
| webcodecs-vp8 | anim | hiddenWindow | 30.0 | 30.0 | 31 / 33 | 35 | 2420 | 10082 | 74 | 16 | 60 |  |
| webcodecs-h264 | anim | hiddenWindow | 30.0 | 30.0 | 30 / 31 | 35 | 2403 | 10013 | 60 | 15 | 60 |  |
| screencast | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | 0 |  |
| capturePoll | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | static | hiddenWindow | 2.0 | 2.0 | 23 / 24 | 502 | 58 | 3598 | 5 | 1 | 60 | libvpx; video/VP8 |
| webrtc-h264 | static | hiddenWindow | 1.0 | 1.0 | 22 / 23 | 1001 | 18 | 2190 | 5 | 1 | 60 | OpenH264; video/H264 |
| webcodecs-vp8 | static | hiddenWindow | 2.0 | 2.0 | 28 / 31 | 504 | 116 | 7249 | 6 | 1 | 60 |  |
| webcodecs-h264 | static | hiddenWindow | 2.0 | 2.0 | 24 / 29 | 509 | 35 | 2173 | 4 | 1 | 60 |  |
| screencast | anim | invisibleWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 |  |
| capturePoll | anim | invisibleWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | 0 | toJPEG 0.0 ms |
| webcodecs-h264 | anim | invisibleWindow | 30.0 | 30.0 | 32 / 33 | 35 | 2403 | 10013 | 80 | 15 | 60 |  |
| screencast | anim | tinyWindow | 60.0 | 60.0 | 36 / 38 | 18 | 66145 | 137803 | 123 | 35 | 60 |  |
| webcodecs-h264 | anim | tinyWindow | 30.0 | 30.0 | 32 / 33 | 35 | 2406 | 10023 | 74 | 15 | 60 |  |
| screencast | anim | shown | 60.0 | 60.0 | 32 / 34 | 18 | 55028 | 114642 | 99 | 25 | 60 |  |
| webrtc-vp8 | anim | shown | 20.2 | 20.2 | 47 / 55 | 78 | 2515 | 15565 | 78 | 14 | 60 | libvpx; video/VP8 |
| webcodecs-h264 | anim | shown | 30.0 | 30.0 | 21 / 23 | 36 | 2448 | 10198 | 84 | 16 | 60 |  |

### Electron · linux-x64-ozone-headless (electron-linux-x64-ozone-headless.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone headless, displays 1920x1080@1, status **done**, 460 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.91 | 27.5 | 27 / 84 | 1 / 6 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.95 | 28.4 | 27 / 30 | 14 / 18 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.1 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.95 | 28.4 | 25 / 29 | 12 / 13 | 1280x800@1 → 1000x700@1 → 1280x800 | 0 / 2 | 1.9 |  |
| invisibleWindow | true | true | true | true (1) | 0.96 | 28.6 | 24 / 29 | 0 / 9 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.3 |  |
| tinyWindow | true | true | true | true (1) | 0.96 | 28.6 | 26 / 28 | 12 / 14 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.0 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 100.0 | 99.2 | 60.0 | 17 | – | – | – | 3.8 | 5.2 |  |
| detached, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | – | – | – | 0.0 | 0.2 |  |
| detached, throttling off | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | – | – | – | 1.4 | 1.4 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 2.0 | 1.0 | 0.0 | 0 | – | – | – | 0.2 | 0.2 |  |
| never-shown window, throttling off | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | – | – | – | 1.2 | 1.4 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 100.1 | 99.1 | 1.0 | 1017 | – | – | – | 1.6 | 2.0 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | – | – | 0.0 | 1.0 | 1.0 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | – | – | 0.0 | 1.2 | 1.2 |  |
| invisible shown window, throttling off | visible | 1280x800 | 100.1 | 99.1 | 60.0 | 17 | – | – | – | 5.6 | 8.0 |  |
| 1x1 shown window, throttling off | visible | 1280x800 | 100.2 | 99.2 | 60.2 | 17 | – | – | – | 5.6 | 7.6 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 100.1 | 99.1 | 60.0 | 17 | – | – | – | 5.6 | 7.8 | cover 0,0 1920x1080 over host 0,0 1x1 |
| 1x1 shown window, always on top, under a cover | visible | 1280x800 | 100.1 | 99.1 | 60.2 | 17 | – | – | – | 5.6 | 7.8 | cover 0,0 1920x1080 over host 0,0 1x1 |
| invisible shown window, covered by another window | visible | 1280x800 | 100.0 | 99.2 | 60.0 | 17 | – | – | – | 5.4 | 7.6 | cover -1480,-1000 1920x1080 over host -1480,-1000 1280x800 |
| osr window 30 fps, throttling off | visible | 1280x800 | 100.0 | 99.2 | 30.0 | 34 | – | – | – | 3.8 | 15.0 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 99.9 | 99.1 | 30.0 | 34 | – | – | – | 2.8 | 3.2 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 99.9 | 98.9 | 0.0 | 0 | 0.85 | 25.8 | – | 3.2 | 4.6 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.85 | 26.0 | – | 3.4 | 4.6 |  |
| detached, throttling off, playing media | visible | 1280x800 | 100.1 | 98.9 | 0.0 | 0 | 0.85 | 26.0 | – | 2.8 | 3.6 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 99.9 | 98.9 | 0.0 | 0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | CPU ms/picture | frames/s | visibility events | errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 14 / 15 | 9 / 14 | 1000x700 | 47 | – |  |  |
| shown | true | capturePage | 6/6 | 6 | 14 / 16 | 10 / 11 | 1000x700 | 48 | – |  |  |
| shown | true | cdpJpeg | 6/6 | 6 | 81 / 82 | -45 / -39 | 1000x700 | 83 | – |  |  |
| shown | true | frameSub | 6/6 | 6 | 15 / 20 | 11 / 12 | 1000x700 | 42 | – |  |  |
| shown | true | cdpPng | 6/6 | 6 | 215 / 227 | -42 / -37 | 1000x700 | 262 | – |  |  |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | 75 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | 60 | – |  | frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 4047 / 4048 | -2990 / -51 | 1280x800 | 127 | – |  |  |
| hiddenWindow | false | frameSub | 6/6 | 6 | 9 / 10 | 60 / 79 | 1280x800 | 40 | – |  |  |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.5 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 96 / 99 | -56 / -29 | 1280x800 | 140 | – |  |  |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 14 / 15 | 13 / 15 | 1280x800 | 80 | – |  |  |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 6/6 | 6 | 13 / 17 | 13 / 14 | 1280x800 | 62 | – |  |  |
| invisibleWindow | false | capturePage | 6/6 | 6 | 13 / 15 | 12 / 17 | 1280x800 | 53 | – |  |  |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 81 / 93 | -38 / -36 | 1280x800 | 102 | – |  |  |
| invisibleWindow | false | frameSub | 6/6 | 6 | 16 / 29 | 15 / 16 | 1280x800 | 58 | – |  |  |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 15 / 22 | 14 / 15 | 1280x800 | 52 | – |  |  |
| tinyWindow | false | capturePage | 6/6 | 6 | 14 / 26 | 12 / 14 | 1280x800 | 45 | – |  |  |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 83 / 91 | -40 / -35 | 1280x800 | 87 | – |  |  |
| tinyWindow | false | frameSub | 6/6 | 6 | 16 / 31 | 11 / 16 | 1280x800 | 48 | – |  |  |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 13 / 26 | 12 / 16 | 1280x800 | 52 | – |  |  |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 14 / 16 | 13 / 14 | 1280x800 | 52 | – |  |  |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 80 / 93 | -38 / -36 | 1280x800 | 85 | – |  |  |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 14 / 17 | 16 / 16 | 1280x800 | 53 | – |  |  |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 14 / 22 | 1280x800 | 30 | – |  |  |
| osr | false | capturePage | 6/6 | 6 | 30 / 33 | -17 / -7 | 1280x800 | 52 | – |  |  |
| osr | false | cdpJpeg | 6/6 | 6 | 98 / 111 | -70 / -68 | 1280x800 | 83 | – |  |  |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | 160 | – |  | no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | 3 | – |  | empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | 110 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 236 | pss | 490 | 4 | 0.3 |
| 1 | 263 | pss | 594 | 5 | 0.3 |
| 2 | 278 | pss | 701 | 6 | 0.3 |
| 4 | 306 | pss | 914 | 8 | 0.3 |
| 8 | 359 | pss | 1341 | 12 | 1.0 |

Per idle hidden tab: **15 MiB**, 0.09% CPU. Four tabs: one partition +67 MiB, four partitions +69 MiB.

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 27.2 | 20.0 | 7.3 | 60 |
| animated, never-shown window, throttling off | 1.5 | 1.5 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.5 | 0.3 | 0.3 | 0 |
| animated, never-shown window, throttling off + frame pump | 1.5 | 1.0 | 0.3 | 0 |
| animated, invisible shown window | 32.5 | 23.0 | 9.5 | 60 |
| animated, 1x1 shown window | 24.2 | 22.5 | 1.8 | 60 |
| animated, osr 30 fps | 25.7 | 12.2 | 4.8 | 30 |

### Electron · macos (electron-macos.json)

Electron 45.2.2 (Chromium 156.0.8078.80), darwin-arm64 25.6.0, ozone (default), displays 1024x768@1, status **done**, 750 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.94 | 28.1 | 31 / 1267 | 14 / 289 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 1.8 |  |
| hiddenWindow | true | true | true | true (1) | 0.97 | 29.2 | 47 / 79 | 13 / 18 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.1 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.97 | 29.1 | 52 / 60 | 12 / 27 | 1280x800@1 → 1000x700@1 → 1280x800 | 3 / 3 | 1.6 |  |
| invisibleWindow | true | true | true | true (1) | 0.97 | 28.9 | 51 / 79 | 13 / 30 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 56.1 |  |
| tinyWindow | true | true | true | true (1) | 0.96 | 28.9 | 38 / 109 | 9 / 24 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 58.9 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 81.4 | 61.1 | 59.9 | 39 | – | – | – | 7.1 | 19.9 |  |
| detached, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | – | – | – | 0.2 | 0.9 |  |
| detached, throttling off | visible | 1280x800 | 99.3 | 81.1 | 0.0 | 0 | – | – | – | 3.9 | 10.2 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | – | – | – | 0.1 | 1.0 |  |
| never-shown window, throttling off | visible | 1280x800 | 97.5 | 79.6 | 0.0 | 0 | – | – | – | 3.9 | 11.5 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 78.3 | 60.9 | 59.7 | 26 | – | – | – | 6.9 | 18.7 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 98.6 | 80.8 | 0.0 | 0 | – | – | 0.0 | 3.2 | 8.6 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 91.0 | 75.2 | 0.0 | 0 | – | – | 0.0 | 2.7 | 7.0 |  |
| invisible shown window, throttling off | visible | 1280x800 | 74.5 | 60.3 | 59.9 | 24 | – | – | – | 6.4 | 18.2 |  |
| 1x1 shown window, throttling off | visible | 1280x800 | 75.9 | 60.3 | 60.1 | 40 | – | – | – | 6.4 | 17.5 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 81.9 | 61.3 | 59.9 | 19 | – | – | – | 6.4 | 17.6 | cover 0,31 1024x677 over host 0,31 1x1 |
| 1x1 shown window, always on top, under a cover | visible | 1280x800 | 72.4 | 56.6 | 56.6 | 247 | – | – | – | 7.3 | 19.7 | cover 0,31 1024x677 over host 0,31 1x1 |
| invisible shown window, covered by another window | visible | 1280x800 | 75.8 | 60.5 | 60.1 | 25 | – | – | – | 8.0 | 22.9 | cover 0,31 1024x677 over host 0,31 1280x800 |
| osr window 30 fps, throttling off | visible | 1280x800 | 57.3 | 46.9 | 19.0 | 105 | – | – | – | 3.3 | 17.9 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 62.1 | 49.7 | 23.8 | 109 | – | – | – | 2.6 | 6.3 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 56.1 | 43.1 | 0.0 | 0 | 0.84 | 24.8 | – | 4.6 | 10.1 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 47.7 | 39.1 | 0.0 | 0 | 0.89 | 25.6 | – | 3.5 | 7.8 |  |
| detached, throttling off, playing media | visible | 1280x800 | 33.7 | 26.1 | 0.0 | 0 | 0.88 | 26.1 | – | 3.3 | 6.7 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 93.2 | 74.0 | 0.0 | 0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 1.6 | 1.0 | 0.0 | 0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | CPU ms/picture | frames/s | visibility events | errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 23 / 30 | 5 / 16 | 1000x700 | 28 | – |  |  |
| shown | true | capturePage | 6/6 | 6 | 21 / 31 | 3 / 12 | 1000x700 | 26 | – |  |  |
| shown | true | cdpJpeg | 6/6 | 6 | 81 / 85 | -44 / -38 | 1000x700 | 45 | – |  |  |
| shown | true | frameSub | 6/6 | 6 | 20 / 30 | 9 / 18 | 1000x700 | 32 | – |  |  |
| shown | true | cdpPng | 6/6 | 6 | 185 / 209 | -44 / -34 | 1000x700 | 167 | – |  |  |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | 7 | – |  | Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | 6 | – |  | Current display surface not available for capture |
| detached | false | cdpJpeg | 1/3 | 1 | 73 / 73 | -52 / -52 | 1280x800 | 185 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | 172 | – |  | frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | 16 | – |  | Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | 18 | – |  | Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 85 / 167 | -50 / -38 | 1280x800 | 84 | – |  |  |
| hiddenWindow | false | frameSub | 6/6 | 6 | 29 / 37 | 6 / 11 | 1280x800 | 73 | – |  |  |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | 15 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | 16 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 85 / 103 | -48 / -41 | 1280x800 | 132 | – |  |  |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 24 / 34 | 8 / 14 | 1280x800 | 79 | – |  |  |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 6/6 | 6 | 24 / 29 | 4 / 23 | 1280x800 | 77 | – |  |  |
| invisibleWindow | false | capturePage | 6/6 | 6 | 26 / 30 | 8 / 14 | 1280x800 | 85 | – |  |  |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 93 / 98 | -45 / -40 | 1280x800 | 109 | – |  |  |
| invisibleWindow | false | frameSub | 6/6 | 6 | 30 / 39 | 9 / 10 | 1280x800 | 81 | – |  |  |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 26 / 34 | 5 / 10 | 1280x800 | 47 | – |  |  |
| tinyWindow | false | capturePage | 6/6 | 6 | 25 / 32 | 7 / 11 | 1280x800 | 54 | – |  |  |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 89 / 124 | -49 / -38 | 1280x800 | 89 | – |  |  |
| tinyWindow | false | frameSub | 6/6 | 6 | 29 / 31 | 6 / 14 | 1280x800 | 42 | – |  |  |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 25 / 31 | 8 / 17 | 1280x800 | 38 | – |  |  |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 19 / 26 | 8 / 16 | 1280x800 | 46 | – |  |  |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 88 / 98 | -47 / -33 | 1280x800 | 74 | – |  |  |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 30 / 34 | 5 / 7 | 1280x800 | 44 | – |  |  |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 41 / 102 | 1280x800 | 39 | – |  |  |
| osr | false | capturePage | 6/6 | 6 | 32 / 177 | 58 / 119 | 1280x800 | 46 | – |  |  |
| osr | false | cdpJpeg | 6/6 | 6 | 321 / 397 | -159 / -66 | 1280x800 | 123 | – |  |  |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | 15.5 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | 477 | – |  | no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | 9 | – |  | empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | 369 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 145 | footprint | 375 | 4 | 0.2 |
| 1 | 166 | footprint | 465 | 5 | 0.5 |
| 2 | 185 | footprint | 558 | 6 | 0.8 |
| 4 | 227 | footprint | 743 | 8 | 1.6 |
| 8 | 305 | footprint | 1112 | 12 | 2.3 |

Per idle hidden tab: **20 MiB**, 0.26% CPU. Four tabs: one partition +74 MiB, four partitions +81 MiB.

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 22.7 | 7.9 | 14.7 | 60 |
| animated, never-shown window, throttling off | 10.8 | 3.3 | 7.3 | 0 |
| animated, never-shown window, throttling on | 0.6 | 0.1 | 0.3 | 0 |
| animated, never-shown window, throttling off + frame pump | 10.9 | 3.4 | 7.3 | 0 |
| animated, invisible shown window | 47.9 | 15.0 | 32.7 | 60 |
| animated, 1x1 shown window | 25.3 | 8.5 | 16.6 | 60 |
| animated, osr 30 fps | 19.6 | 4.0 | 10.1 | 13 |

**Q6 streamed view** (10 s at the viewer; latency p50 / p95 ms)

| road | content | source | fps | decoded fps | latency | gap p95 | kbit/s | bytes/frame | sender CPU % | viewer CPU % | source rAF | notes |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| screencast | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 13 | 0 | 0 |  |
| capturePoll | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 13 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | anim | hiddenWindow | 23.5 | 23.5 | 80 / 123 | 86 | 2509 | 13346 | 60 | 14 | 60 | libvpx; video/VP8 |
| webrtc-h264 | anim | hiddenWindow | 14.1 | 14.1 | 133 / 195 | 124 | 2480 | 21990 | 64 | 6 | 60 | OpenH264; video/H264 |
| webcodecs-vp8 | anim | hiddenWindow | 30.2 | 30.2 | 58 / 100 | 49 | 2264 | 9372 | 71 | 14 | 60 |  |
| webcodecs-h264 | anim | hiddenWindow | 29.9 | 29.9 | 57 / 66 | 47 | 2223 | 9295 | 75 | 14 | 60 |  |
| screencast | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | 0 |  |
| capturePoll | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | static | hiddenWindow | 2.0 | 2.0 | 223 / 337 | 606 | 98 | 6123 | 10 | 2 | 42 | libvpx; video/VP8 |
| webrtc-h264 | static | hiddenWindow | 1.1 | 1.1 | 74 / 1473 | 1238 | 18 | 2042 | 11 | 1 | 42 | OpenH264; video/H264 |
| webcodecs-vp8 | static | hiddenWindow | 2.0 | 2.0 | 60 / 71 | 537 | 103 | 6432 | 11 | 1 | 40 |  |
| webcodecs-h264 | static | hiddenWindow | 2.0 | 2.0 | 45 / 62 | 533 | 9 | 540 | 8 | 1 | 40 |  |
| screencast | anim | invisibleWindow | 60.0 | 60.0 | 35 / 48 | 33 | 58383 | 121428 | 65 | 21 | 60 |  |
| capturePoll | anim | invisibleWindow | 32.1 | 32.1 | 41 / 51 | 47 | 31239 | 121646 | 48 | 12 | 60 | toJPEG 5.0 ms |
| webcodecs-h264 | anim | invisibleWindow | 30.0 | 30.0 | 42 / 53 | 52 | 2231 | 9294 | 77 | 10 | 60 |  |
| screencast | anim | tinyWindow | 60.1 | 60.1 | 57 / 63 | 28 | 58404 | 121472 | 76 | 25 | 60 |  |
| webcodecs-h264 | anim | tinyWindow | 30.1 | 30.1 | 41 / 47 | 43 | 2230 | 9290 | 68 | 10 | 60 |  |
| screencast | anim | shown | 59.9 | 59.9 | 40 / 43 | 26 | 48903 | 101882 | 59 | 18 | 60 |  |
| webrtc-vp8 | anim | shown | 3.0 | 3.0 | 278 / 438 | 473 | 468 | 19486 | 37 | 2 | 60 | libvpx; video/VP8 |
| webcodecs-h264 | anim | shown | 30.0 | 30.0 | 42 / 47 | 42 | 2108 | 8782 | 67 | 11 | 60 |  |

### Electron · windows (electron-windows.json)

Electron 45.2.2 (Chromium 156.0.8078.80), win32-x64 10.0.26100, ozone (default), displays 1024x768@1, status **done**, 750 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.92 | 27.4 | 26 / 90 | 1 / 60 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.96 | 28.6 | 23 / 29 | 12 / 16 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.0 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.96 | 28.5 | 21 / 36 | 9 / 23 | 1280x800@1 → 1000x700@1 → 1280x800 | 1 / 2 | 2.0 |  |
| invisibleWindow | true | true | true | true (1) | 0.96 | 28.8 | 21 / 27 | 12 / 15 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 64.0 |  |
| tinyWindow | true | true | true | true (1) | 0.96 | 28.8 | 22 / 22 | 10 / 15 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 64.0 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 99.9 | 92.7 | 64.2 | 18 | – | – | – | 4.5 | 8.2 |  |
| detached, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | – | – | – | 0.0 | 0.3 |  |
| detached, throttling off | visible | 1280x800 | 100.0 | 97.4 | 0.0 | 0 | – | – | – | 1.3 | 1.4 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | – | – | – | 0.0 | 0.2 |  |
| never-shown window, throttling off | visible | 1280x800 | 100.0 | 97.2 | 0.0 | 0 | – | – | – | 1.3 | 1.4 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 100.0 | 90.4 | 1.0 | 1001 | – | – | – | 1.0 | 1.2 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 100.0 | 97.0 | 0.0 | 0 | – | – | 0.0 | 1.3 | 1.4 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 100.0 | 97.4 | 0.0 | 0 | – | – | 0.0 | 1.3 | 1.5 |  |
| invisible shown window, throttling off | visible | 1280x800 | 100.0 | 93.0 | 64.0 | 18 | – | – | – | 4.4 | 8.0 |  |
| 1x1 shown window, throttling off | visible | 1280x800 | 100.0 | 91.6 | 64.0 | 17 | – | – | – | 4.0 | 6.9 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 100.0 | 92.6 | 64.0 | 18 | – | – | – | 4.1 | 7.3 | cover 0,0 1024x720 over host 0,0 32x31 |
| 1x1 shown window, always on top, under a cover | visible | 1280x800 | 100.0 | 91.6 | 64.0 | 17 | – | – | – | 4.4 | 7.6 | cover 0,0 1024x720 over host 0,0 32x31 |
| invisible shown window, covered by another window | visible | 1280x800 | 100.0 | 91.6 | 64.0 | 18 | – | – | – | 4.1 | 7.5 | cover 0,0 1024x720 over host 0,0 1024x720 |
| osr window 30 fps, throttling off | visible | 1024x720 | 100.0 | 91.4 | 30.0 | 35 | – | – | – | 2.7 | 8.4 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 100.0 | 91.6 | 30.0 | 35 | – | – | – | 1.7 | 2.1 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 100.2 | 91.4 | 0.0 | 0 | 0.85 | 24.8 | – | 2.2 | 3.0 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 100.0 | 91.8 | 0.0 | 0 | 0.84 | 24.8 | – | 2.1 | 2.9 |  |
| detached, throttling off, playing media | visible | 1280x800 | 100.0 | 92.2 | 0.0 | 0 | 0.85 | 24.8 | – | 2.2 | 3.0 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 100.0 | 97.2 | 0.0 | 0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 1.2 | 1.0 | 0.0 | 0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | CPU ms/picture | frames/s | visibility events | errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 6 / 14 | 15 / 16 | 1000x700 | 65 | – |  |  |
| shown | true | capturePage | 6/6 | 6 | 7 / 8 | 13 / 16 | 1000x700 | 62 | – |  |  |
| shown | true | cdpJpeg | 6/6 | 6 | 71 / 76 | -39 / -38 | 1000x700 | 103 | – |  |  |
| shown | true | frameSub | 6/6 | 6 | 18 / 22 | 3 / 15 | 1000x700 | 60 | – |  |  |
| shown | true | cdpPng | 6/6 | 6 | 215 / 226 | -42 / -38 | 1000x700 | 310 | – |  |  |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | 97 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | 75 | – |  | frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 3974 / 3979 | -2942 / -38 | 1280x800 | 123 | – |  |  |
| hiddenWindow | false | frameSub | 6/6 | 6 | 8 / 9 | 60 / 75 | 1280x800 | 45 | – |  |  |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.5 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 82 / 99 | -49 / -35 | 1280x800 | 153 | – |  |  |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 23 / 26 | 1 / 9 | 1280x800 | 91 | – |  |  |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 6/6 | 6 | 18 / 25 | 5 / 15 | 1280x800 | 95 | – |  |  |
| invisibleWindow | false | capturePage | 6/6 | 6 | 20 / 24 | 3 / 6 | 1280x800 | 99 | – |  |  |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 81 / 87 | -42 / -35 | 1280x800 | 153 | – |  |  |
| invisibleWindow | false | frameSub | 6/6 | 6 | 22 / 26 | 5 / 10 | 1280x800 | 94 | – |  |  |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 19 / 23 | 3 / 17 | 1280x800 | 71 | – |  |  |
| tinyWindow | false | capturePage | 6/6 | 6 | 20 / 24 | 3 / 7 | 1280x800 | 69 | – |  |  |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 76 / 89 | -42 / -32 | 1280x800 | 116 | – |  |  |
| tinyWindow | false | frameSub | 6/6 | 6 | 23 / 26 | 6 / 15 | 1280x800 | 63 | – |  |  |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 21 / 23 | 2 / 14 | 1280x800 | 55 | – |  |  |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 8 / 24 | 2 / 17 | 1280x800 | 56 | – |  |  |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 71 / 77 | -36 / -32 | 1280x800 | 91 | – |  |  |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 23 / 26 | 4 / 13 | 1280x800 | 56 | – |  |  |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 8 / 39 | 1024x720 | 21 | – |  |  |
| osr | false | capturePage | 6/6 | 6 | 31 / 32 | -23 / -15 | 1024x720 | 42 | – |  |  |
| osr | false | cdpJpeg | 6/6 | 6 | 100 / 105 | -82 / -79 | 1024x720 | 65 | – |  |  |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | 170 | – |  | no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | 3 | – |  | empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | 130 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 137 | privateBytes | 159 | 4 | 0.0 |
| 1 | 163 | privateBytes | 233 | 5 | 0.1 |
| 2 | 188 | privateBytes | 304 | 6 | 0.2 |
| 4 | 241 | privateBytes | 452 | 8 | 0.3 |
| 8 | 349 | privateBytes | 751 | 12 | 0.4 |

Per idle hidden tab: **27 MiB**, 0.05% CPU. Four tabs: one partition +99 MiB, four partitions +101 MiB.

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 42.1 | 23.6 | 18.0 | 64 |
| animated, never-shown window, throttling off | 1.5 | 1.3 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.1 | 0.0 | 0.0 | 0 |
| animated, never-shown window, throttling off + frame pump | 1.4 | 1.3 | 0.0 | 0 |
| animated, invisible shown window | 52.0 | 30.1 | 21.8 | 64 |
| animated, 1x1 shown window | 30.7 | 27.4 | 3.1 | 64 |
| animated, osr 30 fps | 22.8 | 11.4 | 7.2 | 30 |

**Q6 streamed view** (10 s at the viewer; latency p50 / p95 ms)

| road | content | source | fps | decoded fps | latency | gap p95 | kbit/s | bytes/frame | sender CPU % | viewer CPU % | source rAF | notes |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| screencast | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | 0 |  |
| capturePoll | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | anim | hiddenWindow | 25.7 | 25.7 | 39 / 41 | 65 | 2494 | 12128 | 85 | 18 | 64 | libvpx; video/VP8 |
| webrtc-h264 | anim | hiddenWindow | 14.8 | 14.8 | 58 / 71 | 80 | 2486 | 20997 | 83 | 11 | 64 | OpenH264; video/H264 |
| webcodecs-vp8 | anim | hiddenWindow | 30.1 | 30.1 | 33 / 36 | 49 | 2178 | 9074 | 101 | 18 | 64 |  |
| webcodecs-h264 | anim | hiddenWindow | 30.0 | 30.0 | 31 / 34 | 49 | 2153 | 8970 | 96 | 16 | 64 |  |
| screencast | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | 0 |  |
| capturePoll | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | static | hiddenWindow | 2.0 | 2.0 | 24 / 24 | 501 | 50 | 3128 | 6 | 1 | 64 | libvpx; video/VP8 |
| webrtc-h264 | static | hiddenWindow | 1.0 | 1.0 | 27 / 31 | 1003 | 18 | 2191 | 7 | 1 | 64 | OpenH264; video/H264 |
| webcodecs-vp8 | static | hiddenWindow | 2.0 | 2.0 | 16 / 32 | 519 | 107 | 6698 | 6 | 1 | 64 |  |
| webcodecs-h264 | static | hiddenWindow | 2.0 | 2.0 | 12 / 13 | 502 | 9 | 550 | 5 | 1 | 64 |  |
| screencast | anim | invisibleWindow | 64.0 | 64.0 | 40 / 43 | 20 | 60577 | 118314 | 179 | 39 | 64 |  |
| capturePoll | anim | invisibleWindow | 31.4 | 31.4 | 38 / 42 | 38 | 29943 | 118822 | 125 | 19 | 64 | toJPEG 8.2 ms |
| webcodecs-h264 | anim | invisibleWindow | 30.0 | 30.0 | 38 / 62 | 51 | 2149 | 8953 | 144 | 20 | 64 |  |
| screencast | anim | tinyWindow | 64.0 | 64.0 | 42 / 44 | 19 | 60577 | 118314 | 193 | 38 | 64 |  |
| webcodecs-h264 | anim | tinyWindow | 30.1 | 30.1 | 38 / 41 | 48 | 2179 | 9051 | 134 | 20 | 64 |  |
| screencast | anim | shown | 64.0 | 64.0 | 35 / 38 | 18 | 50850 | 99317 | 146 | 31 | 64 |  |
| webrtc-vp8 | anim | shown | 24.6 | 24.6 | 56 / 58 | 75 | 2495 | 12676 | 150 | 20 | 64 | libvpx; video/VP8 |
| webcodecs-h264 | anim | shown | 30.0 | 30.0 | 46 / 49 | 49 | 2195 | 9147 | 148 | 17 | 64 |  |

### The pair · linux-x64 (pair-linux.json)

7.0.0-1017-azure, 36 s, state **done**

- **login start**: {"daemonUpMs":117,"daemonUp":true,"appConnectedMs":3220,"appStartedBy":"daemon","appStart":{"at":1793841887044,"safeMode":false,"reason":"daemon start","ok":true,"how":"systemctl --user start clover-s7-app-61ef28c3.service","out":""},"daemonParent":1162}
- **second daemon on the same home**: {"exitCode":0,"ms":42,"said":"2026-11-05T01:24:48.002Z [core 2799] another daemon holds this home (flock: held by another process); exiting","firstStillServing":true}
- **app crash**: {"killed":2759,"kill":{"ok":true,"how":"kill -9 2759","code":0,"out":""},"restartedMs":1225,"newPid":2819,"startedBy":"daemon","safeMode":false,"how":"systemctl --user start clover-s7-app-61ef28c3.service","eventsSinceKill":["start","tray","connected"]}
- **app crash loop → safe mode**: {"rounds":[{"killed":2819,"restartedMs":2223,"safeMode":false,"crashesInDaemon":2},{"killed":2870,"restartedMs":4240,"safeMode":true,"crashesInDaemon":3}],"thirdRestartInSafeMode":true}
- **daemon crash, restarted by the OS alone**: {"killed":2747,"kill":{"ok":true,"how":"kill -9 2747","code":0,"out":""},"daemonBackMs":1408,"newDaemonPid":2970,"appSurvived":true,"appPidAfter":2922,"samePid":true,"appStartedTheDaemon":false,"appEvents":["4ms daemon-lost","1507ms connected","1508ms reconnected"]}
- **daemon crash, the app helps after 3 s**: {"killed":2970,"kill":{"ok":true,"how":"kill -9 2970","code":0,"out":""},"daemonBackMs":1407,"newDaemonPid":2989,"appSurvived":true,"appPidAfter":2922,"samePid":true,"appStartedTheDaemon":false,"appEvents":["2ms daemon-lost","1507ms connected","1507ms reconnected"]}
- **tray Quit stops both, and they stay down**: {"forwarded":{"forwarded":true},"bothDownMs":402,"restartedWithin12s":false,"appEvents":["quit","quit-acked","daemon-quitting"]}
- **a user starts the app → it starts the daemon**: {"start":{"ok":true,"how":"spawn detached (as from a launcher)","code":0,"out":"3008"},"bothUpMs":510,"startedBy":"user","appStartedTheDaemon":[{"ok":true,"how":"systemctl --user start clover-s7-core-61ef28c3.service","out":""}],"appEvents":["start","tray","start-daemon","connected"]}
- **the daemon side's Quit stops both**: {"bothDownMs":401,"restartedWithin8s":false}

### The pair · darwin-arm64 (pair-macos.json)

25.6.0, 39 s, state **done**

- **login start**: {"daemonUpMs":236,"daemonUp":true,"appConnectedMs":3924,"appStartedBy":"daemon","appStart":{"at":1793841884079,"safeMode":false,"reason":"daemon start","ok":true,"how":"open -n -g -a /Users/runner/work/clover/clover/spikes/s7-browser/prototype/node_modules/electron/dist/Electron.app --args /Users/runner/work/clover/clover/spikes/s7-browser/prototype/out/pair/app --home=/var/folders/h5/t85nd63d71x27_8gl5gw3l_w0000gn/T/clover-s7-pair-5yuKRx","out":""},"daemonParent":1}
- **second daemon on the same home**: {"exitCode":0,"ms":285,"said":"2026-11-05T01:24:45.538Z [core 2285] another daemon holds this home (flock: held by another process); exiting","firstStillServing":true}
- **app crash**: {"killed":2275,"kill":{"ok":true,"how":"kill -9 2275","code":0,"out":""},"restartedMs":1936,"newPid":2288,"startedBy":"daemon","safeMode":false,"how":"open -n -g -a /Users/runner/work/clover/clover/spikes/s7-browser/prototype/node_modules/electron/dist/Electron.app --args /Users/runner/work/clover/clover/spikes/s7-browser/prototype/out/pair/app --home=/var/folders/h5/t85nd63d71x27_8gl5gw3l_w0000gn/T/clover-s7-pair-5yuKRx","eventsSinceKill":["start","tray","connected"]}
- **app crash loop → safe mode**: {"rounds":[{"killed":2288,"restartedMs":2942,"safeMode":false,"crashesInDaemon":2},{"killed":2302,"restartedMs":4787,"safeMode":true,"crashesInDaemon":3}],"thirdRestartInSafeMode":true}
- **daemon crash, restarted by the OS alone**: {"killed":2261,"kill":{"ok":true,"how":"kill -9 2261","code":0,"out":""},"daemonBackMs":488,"newDaemonPid":2437,"appSurvived":true,"appPidAfter":2433,"samePid":true,"appStartedTheDaemon":false,"appEvents":["3ms daemon-lost","531ms connected","532ms reconnected"]}
- **daemon crash, the app helps after 3 s**: {"killed":2437,"kill":{"ok":true,"how":"kill -9 2437","code":0,"out":""},"daemonBackMs":1219,"newDaemonPid":2445,"appSurvived":true,"appPidAfter":2433,"samePid":true,"appStartedTheDaemon":false,"appEvents":["3ms daemon-lost","1518ms connected","1518ms reconnected"]}
- **tray Quit stops both, and they stay down**: {"forwarded":{"forwarded":true},"bothDownMs":348,"restartedWithin12s":false,"appEvents":["quit","quit-acked"]}
- **a user starts the app → it starts the daemon**: {"start":{"ok":true,"how":"open -n -g -a /Users/runner/work/clover/clover/spikes/s7-browser/prototype/node_modules/electron/dist/Electron.app --args /Users/runner/work/clover/clover/spikes/s7-browser/prototype/out/pair/app --home=/var/folders/h5/t85nd63d71x27_8gl5gw3l_w0000gn/T/clover-s7-pair-5yuKRx","code":0,"out":""},"bothUpMs":1157,"startedBy":"user","appStartedTheDaemon":[{"ok":true,"how":"launchctl kickstart gui/501/com.waifucave.clover.s7.core.48ce4b15","out":""}],"appEvents":["start","tray","start-daemon","connected"]}
- **the daemon side's Quit stops both**: {"bothDownMs":309,"restartedWithin8s":false}

### The pair · win32-x64 (pair-windows-spawn.json)

10.0.26100, 187 s, state **done**, Windows app start: spawn

- **login start**: {"daemonUpMs":355,"daemonUp":true,"appConnectedMs":3000,"appStartedBy":"daemon","appStart":{"at":1793841894823,"safeMode":false,"reason":"daemon start","ok":true,"how":"spawn detached","out":"6660"},"daemonParent":2732}
- **second daemon on the same home**: {"exitCode":0,"ms":79,"said":"2026-11-05T01:24:55.158Z [core 9160] another daemon holds this home (CreateFileW: error 32 (sharing violation: another daemon holds it)); exiting","firstStillServing":true}
- **app crash**: {"killed":6660,"kill":{"ok":true,"how":"taskkill /F /T /PID 6660","code":0,"out":"SUCCESS: The process with PID 1336 (child process of PID 6660) has been terminated.\r\nSUCCESS: The process with PID 3508 (child process of PID 6660) has been ter"},"restartedMs":1202,"newPid":500,"startedBy":"daemon","safeMode":false,"how":"spawn detached","eventsSinceKill":["start","tray","connected"]}
- **app crash loop → safe mode**: {"rounds":[{"killed":500,"restartedMs":2198,"safeMode":false,"crashesInDaemon":2},{"killed":2488,"restartedMs":4172,"safeMode":true,"crashesInDaemon":3}],"thirdRestartInSafeMode":true}
- **daemon crash, restarted by the OS alone**: {"killed":5340,"kill":{"ok":true,"how":"taskkill /F /PID 5340","code":0,"out":"SUCCESS: The process with PID 5340 has been terminated."},"appSurvived":true,"appPidAfter":5860,"samePid":true,"appStartedTheDaemon":{"atMs":150539,"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-d7eb8374"},"appEvents":["57ms daemon-lost","150539ms start-daemon","151041ms connected","151041ms reconnected"]}
- **daemon crash, the app helps after 3 s**: {"killed":504,"kill":{"ok":true,"how":"taskkill /F /PID 504","code":0,"out":"SUCCESS: The process with PID 504 has been terminated."},"daemonBackMs":3289,"newDaemonPid":5668,"appSurvived":true,"appPidAfter":5860,"samePid":true,"appStartedTheDaemon":{"atMs":3100,"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-d7eb8374"},"appEvents":["61ms daemon-lost","3100ms start-daemon","3602ms connected","3603ms reconnected"]}
- **tray Quit stops both, and they stay down**: {"forwarded":{"forwarded":true},"bothDownMs":326,"restartedWithin12s":false,"appEvents":["quit-acked"]}
- **a user starts the app → it starts the daemon**: {"start":{"ok":true,"how":"spawn detached","code":0,"out":"7580"},"bothUpMs":542,"startedBy":"user","appStartedTheDaemon":[{"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-d7eb8374","out":"SUCCESS: Attempted to run the scheduled task \"\\Clover S7\\core-d7eb8374\"."}],"appEvents":["start","tray","start-daemon","connected"]}
- **the daemon side's Quit stops both**: {"bothDownMs":325,"restartedWithin8s":false}

### The pair · win32-x64 (pair-windows-supervise.json)

10.0.26100, 36 s, state **done**, Windows app start: task, daemon under the supervisor

- **login start**: {"daemonUpMs":465,"daemonUp":true,"appConnectedMs":3063,"appStartedBy":"daemon","appStart":{"at":1793841943194,"safeMode":false,"reason":"daemon start","ok":true,"how":"schtasks /Run /TN \\Clover S7\\app-cdb853ec","out":"SUCCESS: Attempted to run the scheduled task \"\\Clover S7\\app-cdb853ec\"."},"daemonParent":5024}
- **second daemon on the same home**: {"exitCode":0,"ms":84,"said":"2026-11-05T01:25:43.772Z [core 6332] another daemon holds this home (CreateFileW: error 32 (sharing violation: another daemon holds it)); exiting","firstStillServing":true}
- **app crash**: {"killed":4188,"kill":{"ok":true,"how":"taskkill /F /T /PID 4188","code":0,"out":"SUCCESS: The process with PID 7864 (child process of PID 4188) has been terminated.\r\nSUCCESS: The process with PID 7872 (child process of PID 4188) has been ter"},"restartedMs":1214,"newPid":2844,"startedBy":"daemon","safeMode":false,"how":"schtasks /Run /TN \\Clover S7\\app-cdb853ec","eventsSinceKill":["start","tray","connected"]}
- **app crash loop → safe mode**: {"rounds":[{"killed":2844,"restartedMs":2226,"safeMode":false,"crashesInDaemon":2},{"killed":8120,"restartedMs":4224,"safeMode":true,"crashesInDaemon":3}],"thirdRestartInSafeMode":true}
- **daemon crash, restarted by the OS alone**: {"killed":9036,"kill":{"ok":true,"how":"taskkill /F /PID 9036","code":0,"out":"SUCCESS: The process with PID 9036 has been terminated."},"daemonBackMs":619,"newDaemonPid":1820,"appSurvived":true,"appPidAfter":4372,"samePid":true,"appStartedTheDaemon":false,"appEvents":["54ms daemon-lost","1059ms connected","1059ms reconnected"]}
- **daemon crash, the app helps after 3 s**: {"killed":1820,"kill":{"ok":true,"how":"taskkill /F /PID 1820","code":0,"out":"SUCCESS: The process with PID 1820 has been terminated."},"daemonBackMs":1242,"newDaemonPid":8296,"appSurvived":true,"appPidAfter":4372,"samePid":true,"appStartedTheDaemon":false,"appEvents":["53ms daemon-lost","1561ms connected","1562ms reconnected"]}
- **tray Quit stops both, and they stay down**: {"forwarded":{"forwarded":true},"bothDownMs":341,"restartedWithin12s":false,"appEvents":["quit","quit-acked"]}
- **a user starts the app → it starts the daemon**: {"start":{"ok":true,"how":"spawn detached","code":0,"out":"8776"},"bothUpMs":554,"startedBy":"user","appStartedTheDaemon":[{"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-cdb853ec","out":"SUCCESS: Attempted to run the scheduled task \"\\Clover S7\\core-cdb853ec\"."}],"appEvents":["start","tray","start-daemon","connected"]}
- **the daemon side's Quit stops both**: {"bothDownMs":414,"restartedWithin8s":false}

### The pair · win32-x64 (pair-windows-task.json)

10.0.26100, 187 s, state **done**, Windows app start: task

- **login start**: {"daemonUpMs":361,"daemonUp":true,"appConnectedMs":2941,"appStartedBy":"daemon","appStart":{"at":1793842004370,"safeMode":false,"reason":"daemon start","ok":true,"how":"schtasks /Run /TN \\Clover S7\\app-aa21ec1b","out":"SUCCESS: Attempted to run the scheduled task \"\\Clover S7\\app-aa21ec1b\"."},"daemonParent":2528}
- **second daemon on the same home**: {"exitCode":0,"ms":79,"said":"2026-11-05T01:26:44.958Z [core 4016] another daemon holds this home (CreateFileW: error 32 (sharing violation: another daemon holds it)); exiting","firstStillServing":true}
- **app crash**: {"killed":8872,"kill":{"ok":true,"how":"taskkill /F /T /PID 8872","code":0,"out":"SUCCESS: The process with PID 7304 (child process of PID 8872) has been terminated.\r\nSUCCESS: The process with PID 7904 (child process of PID 8872) has been ter"},"restartedMs":1213,"newPid":9184,"startedBy":"daemon","safeMode":false,"how":"schtasks /Run /TN \\Clover S7\\app-aa21ec1b","eventsSinceKill":["start","tray","connected"]}
- **app crash loop → safe mode**: {"rounds":[{"killed":9184,"restartedMs":2202,"safeMode":false,"crashesInDaemon":2},{"killed":8080,"restartedMs":4196,"safeMode":true,"crashesInDaemon":3}],"thirdRestartInSafeMode":true}
- **daemon crash, restarted by the OS alone**: {"killed":4380,"kill":{"ok":true,"how":"taskkill /F /PID 4380","code":0,"out":"SUCCESS: The process with PID 4380 has been terminated."},"appSurvived":true,"appPidAfter":8248,"samePid":true,"appStartedTheDaemon":{"atMs":150293,"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-aa21ec1b"},"appEvents":["56ms daemon-lost","150293ms start-daemon","150796ms connected","150797ms reconnected"]}
- **daemon crash, the app helps after 3 s**: {"killed":7172,"kill":{"ok":true,"how":"taskkill /F /PID 7172","code":0,"out":"SUCCESS: The process with PID 7172 has been terminated."},"daemonBackMs":3311,"newDaemonPid":8420,"appSurvived":true,"appPidAfter":8248,"samePid":true,"appStartedTheDaemon":{"atMs":3124,"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-aa21ec1b"},"appEvents":["90ms daemon-lost","3124ms start-daemon","3635ms connected","3635ms reconnected"]}
- **tray Quit stops both, and they stay down**: {"forwarded":{"forwarded":true},"bothDownMs":423,"restartedWithin12s":false,"appEvents":["quit","quit-acked"]}
- **a user starts the app → it starts the daemon**: {"start":{"ok":true,"how":"spawn detached","code":0,"out":"8416"},"bothUpMs":571,"startedBy":"user","appStartedTheDaemon":[{"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-aa21ec1b","out":"SUCCESS: Attempted to run the scheduled task \"\\Clover S7\\core-aa21ec1b\"."}],"appEvents":["start","tray","start-daemon","connected"]}
- **the daemon side's Quit stops both**: {"bothDownMs":330,"restartedWithin8s":false}

