## Spike S7 results

### Chrome for Testing · linux-arm64 (cft-linux-arm64-apparmor.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 0 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 121 MiB archive, 277 MiB unpacked, 287 files, 0 symlinks; download 1265 ms, unpack 988 ms; sha256 `5bb6a00a4285c13303d3f72c5afdb70f144ea7a93eed462365a52b69631c9607` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 55 ms, warm 56 ms; the port for comparison 54 ms
- start attempts: fdpipe ok 55 ms

### Chrome for Testing · linux-arm64 (cft-linux-arm64.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 215 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox off (--no-sandbox: every sandboxed start failed)

- install: 121 MiB archive, 277 MiB unpacked, 287 files, 0 symlinks; download 1265 ms, unpack 988 ms; sha256 `5bb6a00a4285c13303d3f72c5afdb70f144ea7a93eed462365a52b69631c9607` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 142 ms, warm 44 ms; the port for comparison 38 ms
- start attempts: fdpipe failed (fdpipe start failed: browser exited (SIGTRAP) during Browser.getVersion (exit SIGTRAP); stderr: [1105/015116.241070:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:130] No usable sandbox! If you are running o); pipe failed (pipe start failed: browser exited (SIGTRAP) during Browser.getVersion (exit SIGTRAP); stderr: [1105/015116.411205:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:130] No usable sandbox! If you are running on ); port failed (port start failed: browser exited before listening (exit SIGTRAP); stderr: [1105/015116.557183:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:130] No usable sandbox! If you are running on Ubuntu 23.10+ or an); fdpipe --no-sandbox ok 142 ms
- tabs: one window: first (background): visible, 1280x800, interval 99.9 Hz, rAF 60.2 Hz; one window: second (front): visible, 1280x800, interval 99.9 Hz, rAF 60.0 Hz; own window: first (background): visible, 1280x800, interval 99.9 Hz, rAF 60.1 Hz; own window: second (front): visible, 1280x800, interval 100.1 Hz, rAF 60.2 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.2 Hz, rAF 60.0 Hz, media ×0.95, decoded 29.0 fps, audio running, set up in 119 ms, browser answers in 0 ms
- resize to 1000×700 and back: 3 ms / 22 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 218 / 229 ms (646 KiB, CPU 348 ms), jpeg 81 / 85 ms (164 KiB, stale -48 / -38 ms, CPU 149 ms)
- screencast: 60.3 fps, 66627 kbit/s, 135 KiB/frame, latency 33 / 36 ms, browser CPU 152%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 175 MiB, per idle tab 23 MiB, 4 browser contexts +95 MiB, a second bot's browser 113 MiB (6 processes), animated tab 52.3% CPU
  - steps: 0 tabs 175 MiB pss / 0.0%, 1 tabs 211 MiB pss / 2.0%, 2 tabs 234 MiB pss / 4.2%, 4 tabs 276 MiB pss / 9.5%, 8 tabs 362 MiB pss / 18.2%

**chrome** — Chrome/156.0.8078.80; sandbox off (--no-sandbox: every sandboxed start failed)

- install: 191 MiB archive, 401 MiB unpacked, 301 files, 0 symlinks; download 1421 ms, unpack 1378 ms; sha256 `1f496a826c9ba4d6a5f5bf2de686145fe718528c2cc3dbeb96b5893b89653724` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 289 ms, warm 231 ms; the port for comparison 274 ms
- start attempts: fdpipe failed (fdpipe start failed: browser exited (SIGABRT) during Browser.getVersion (exit SIGABRT); stderr: #10 0xaaf7111d9138 (/home/runner/work/_temp/clover-s7-home/browsers/cft/156.0.8078.80/chrome-linux-arm64/chrome-linux-arm64/); pipe failed (pipe start failed: browser exited (SIGABRT) during Browser.getVersion (exit SIGABRT); stderr: #10 0xaab576a59138 (/home/runner/work/_temp/clover-s7-home/browsers/cft/156.0.8078.80/chrome-linux-arm64/chrome-linux-arm64/ch); port failed (port start failed: browser exited before listening (exit SIGABRT); stderr: #10 0xaac10a109138 (/home/runner/work/_temp/clover-s7-home/browsers/cft/156.0.8078.80/chrome-linux-arm64/chrome-linux-arm64/chrome+0xa869137) | #); fdpipe --no-sandbox ok 289 ms
- tabs: one window: first (background): hidden, 1280x657, interval 1.0 Hz, rAF 0.0 Hz; one window: second (front): visible, 1280x657, interval 99.9 Hz, rAF 60.1 Hz; own window: first (background): visible, 1280x657, interval 100.1 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x657, interval 100.1 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.2 Hz, media ×0.95, decoded 28.8 fps, audio running, set up in 55 ms, browser answers in 0 ms
- resize to 1000×700 and back: 2 ms / 21 ms, same document true (1280 → 1000 → 1280)
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 450 MiB, per idle tab 52 MiB, 4 browser contexts +313 MiB, a second bot's browser 289 MiB (11 processes), animated tab 59.1% CPU
  - steps: 0 tabs 450 MiB pss / 1.2%, 1 tabs 521 MiB pss / 3.0%, 2 tabs 593 MiB pss / 5.2%, 4 tabs 656 MiB pss / 10.4%, 8 tabs 867 MiB pss / 19.3%
- errors: screenshots: Page.enable timed out (last bytes from the browser 15000 ms ago (747 in all); trace: 0 → 1 Browser.getVersion, 207 ← 1, 208 → 2 Target.createTarget, 306 ← 2, 306 → 3 Target.attachToTarget, 358 ← Target.attachedToTarget, 358 ← 3, 358 → 4 Page.enable) — the browser is still running; stderr: [4036:4036:1105/015320.220139:ERROR:dbus/object_proxy.cc:572] Failed to call method: org.freedesktop.DBus.NameHasOwner: object_path= /org/freedesktop/DBus: unknown error type:  | [4036:4036:1105/015320.307447:ERROR:dbus/object_proxy.cc:572] Failed to call method: org.freedesktop.DBus.NameHasOwner: object_path= /org/freedesktop/DBus: unknown error type:  | [4036:4036:1105/015320.307530:ERROR:dbus/object_proxy.cc:572] Failed to call method: org.freedesktop.DBus.Properties.GetAll: object_path= /org/freedesktop/UPower/devices/DisplayDevice: org.freedesktop.DBus.Error.ServiceUnknown: The name org.freedesktop.UPower was not provided by any .service files | [4036:4048:1105/015320.307544:ERROR:dbus/bus.cc:405] Failed to connect to the bus: Could not parse server address: Unknown address type (examples of valid types are "tcp" and on UNIX "unix") | [4036:4036:1105/015320.350975:ERROR:dbus/object_proxy.cc:572] Failed to call method: org.freedesktop.DBus.NameHasOwner: object_path= /org/freedesktop/DBus: unknown error type:  | [4036:4048:1105/015320.351068:ERROR:dbus/bus.cc:405] Failed to connect to the bus: Could not parse server address: Unknown address type (examples of valid types are "tcp" and on UNIX "unix") | [4036:4036:1105/015320.376916:ERROR:dbus/object_proxy.cc:572] Failed to call method: org.freedesktop.DBus.NameHasOwner: object_path= /org/freedesktop/DBus: unknown error type:  | [4036:4036:1105/015320.384053:ERROR:dbus/object_proxy.cc:572] Failed to call method: org.freedesktop.NetworkManager.GetDevices: object_path= /org/freedesktop/NetworkManager: org.freedesktop.DBus.Error.ServiceUnknown: The name org.freedesktop.NetworkManager was not provided by any .service files | [4036:4110:1105/015320.384168:ERROR:content/browser/devtools/devtools_pipe_handler.cc:274] Could not write into pipe | [4036:4110:1105/015320.384179:ERROR:content/browser/devtools/devtools_pipe_handler.cc:274] Could not write into pipe

### Chrome for Testing · linux-x64 (cft-linux-x64-apparmor.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 0 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 121 MiB archive, 274 MiB unpacked, 287 files, 0 symlinks; download 911 ms, unpack 1074 ms; sha256 `547dcd374e02961bf998f6046a267644f8502225c36bb78ca307dab32a0b3eb4` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 64 ms, warm 60 ms; the port for comparison 67 ms
- start attempts: fdpipe ok 64 ms

### Chrome for Testing · linux-x64 (cft-linux-x64.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 125 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox off (--no-sandbox: every sandboxed start failed)

- install: 121 MiB archive, 274 MiB unpacked, 287 files, 0 symlinks; download 911 ms, unpack 1074 ms; sha256 `547dcd374e02961bf998f6046a267644f8502225c36bb78ca307dab32a0b3eb4` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 1469 ms, warm 48 ms; the port for comparison 43 ms
- start attempts: fdpipe failed (fdpipe start failed: browser exited (SIGTRAP) during Browser.getVersion (exit SIGTRAP); stderr: [1105/015020.928585:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:130] No usable sandbox! If you are running o); pipe failed (pipe start failed: browser exited (SIGTRAP) during Browser.getVersion (exit SIGTRAP); stderr: [1105/015021.126273:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:130] No usable sandbox! If you are running on ); port failed (port start failed: browser exited before listening (exit SIGTRAP); stderr: [1105/015021.288836:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:130] No usable sandbox! If you are running on Ubuntu 23.10+ or an); fdpipe --no-sandbox ok 1469 ms
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.0 Hz, media ×0.95, decoded 29.0 fps, audio running, set up in 122 ms, browser answers in 0 ms
- screenshots: png 245 / 257 ms (644 KiB, CPU 288 ms), jpeg 80 / 83 ms (164 KiB, stale -46 / -34 ms, CPU 80 ms)
- screencast: 60.3 fps, 66406 kbit/s, 135 KiB/frame, latency 32 / 33 ms, browser CPU 127%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 171 MiB, per idle tab 23 MiB, 4 browser contexts +94 MiB, a second bot's browser 114 MiB (6 processes), animated tab 23.4% CPU
  - steps: 0 tabs 171 MiB pss / 0.0%, 1 tabs 206 MiB pss / 2.2%, 2 tabs 229 MiB pss / 4.0%, 4 tabs 272 MiB pss / 5.7%, 8 tabs 357 MiB pss / 9.7%
- errors: tabs: Runtime.evaluate timed out (last bytes from the browser 10000 ms ago (9061 in all); trace: 343 ← 13, 2343 → 14 Runtime.evaluate, 2344 ← 14, 2344 → 15 Runtime.evaluate, 2344 ← 15, 2345 → 16 Runtime.evaluate, 2345 ← 16, 2345 → 17 Runtime.evaluate, 2346 ← 17, 7347 → 18 Runtime.evaluate, 7348 ← 18, 7348 → 19 Runtime.evaluate) — the browser is still running; stderr: [1105/015023.526545:ERROR:dbus/bus.cc:405] Failed to connect to the bus: Could not parse server address: Unknown address type (examples of valid types are "tcp" and on UNIX "unix") | [1105/015023.539992:ERROR:dbus/object_proxy.cc:572] Failed to call method: org.freedesktop.DBus.NameHasOwner: object_path= /org/freedesktop/DBus: unknown error type:  | [1105/015023.540597:ERROR:dbus/bus.cc:405] Failed to connect to the bus: Could not parse server address: Unknown address type (examples of valid types are "tcp" and on UNIX "unix") | [1105/015023.546957:ERROR:dbus/object_proxy.cc:572] Failed to call method: org.freedesktop.DBus.NameHasOwner: object_path= /org/freedesktop/DBus: unknown error type:  | [1105/015023.554930:WARNING:media/gpu/vaapi/vaapi_wrapper.cc:1655] drmGetDevices2() has not found any devices | [1105/015023.556840:WARNING:sandbox/policy/linux/sandbox_linux.cc:405] InitializeSandbox() called with multiple threads in process gpu-process.

**chrome** — ; sandbox –

- install: 192 MiB archive, 403 MiB unpacked, 301 files, 0 symlinks; download 1508 ms, unpack 1532 ms; sha256 `b711c720f774be355197f32edf37e0651418ba036d92446ee2da19ac017540a7` (matches the pin; server MD5 true)
- start attempts: fdpipe failed (fdpipe start failed: browser exited (SIGABRT) during Browser.getVersion (exit SIGABRT); stderr: #16 0x565262f3103a (/home/runner/work/_temp/clover-s7-home/browsers/cft/156.0.8078.80/chrome-linux64/chrome-linux64/chrome+0); pipe failed (pipe start failed: browser exited (SIGABRT) during Browser.getVersion (exit SIGABRT); stderr: #16 0x561d15cdf03a (/home/runner/work/_temp/clover-s7-home/browsers/cft/156.0.8078.80/chrome-linux64/chrome-linux64/chrome+0x7); port failed (port start failed: browser exited before listening (exit SIGABRT); stderr: #16 0x55beea8ec03a (/home/runner/work/_temp/clover-s7-home/browsers/cft/156.0.8078.80/chrome-linux64/chrome-linux64/chrome+0x7646039) |   r8: 000); fdpipe --no-sandbox ok 282 ms
- errors: start: Browser.getVersion timed out (last bytes from the browser 15001 ms ago (281 in all); trace: 1 → 1 Browser.getVersion, 282 ← 1, 282 → 2 Browser.getVersion)

### Chrome for Testing · win32-x64 (cft-windows.json)

10.0.26100, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 235 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 120 MiB archive, 282 MiB unpacked, 288 files, 0 symlinks; download 2155 ms, unpack 1613 ms; sha256 `10a77466005e7f64e00f1a75fd1ea81f4a38a60093c65fea6895843b26e60a9a` (matches the pin; server MD5 true)
- start: over **winpipe**, cold 150 ms, warm 86 ms; the port for comparison 87 ms
- start attempts: winpipe ok 150 ms
- tabs: one window: first (background): visible, 1280x800, interval 100.1 Hz, rAF 60.0 Hz; one window: second (front): visible, 1280x800, interval 100.0 Hz, rAF 60.1 Hz; own window: first (background): visible, 1280x800, interval 99.9 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x800, interval 99.8 Hz, rAF 59.9 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.2 Hz, media ×0.94, decoded 29.2 fps, audio running, set up in 52 ms, browser answers in 6 ms
- resize to 1000×700 and back: 11 ms / 39 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 224 / 232 ms (574 KiB, CPU 352 ms), jpeg 79 / 82 ms (148 KiB, stale -47 / -36 ms, CPU 109 ms)
- screencast: 60.6 fps, 57105 kbit/s, 115 KiB/frame, latency 32 / 35 ms, browser CPU 99%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 68 MiB, per idle tab 29 MiB, 4 browser contexts +115 MiB, a second bot's browser 68 MiB (5 processes), animated tab 31.3% CPU
  - steps: 0 tabs 68 MiB privateBytes / 0.0%, 1 tabs 99 MiB privateBytes / 0.4%, 2 tabs 129 MiB privateBytes / 0.0%, 4 tabs 187 MiB privateBytes / 3.9%, 8 tabs 301 MiB privateBytes / 9.3%

**chrome** — Chrome/156.0.8078.80; sandbox on

- install: 199 MiB archive, 439 MiB unpacked, 305 files, 0 symlinks; download 867 ms, unpack 2715 ms; sha256 `16edb57d6107bf1c48a7c149b8d78b155fe614410093796dd72441fd6640540f` (matches the pin; server MD5 true)
- start: over **winpipe**, cold 610 ms, warm 317 ms; the port for comparison 364 ms
- start attempts: winpipe ok 610 ms
- tabs: one window: first (background): hidden, 1264x649, interval 1.0 Hz, rAF 0.0 Hz; one window: second (front): visible, 1264x649, interval 100.0 Hz, rAF 59.9 Hz; own window: first (background): visible, 1264x649, interval 100.0 Hz, rAF 60.1 Hz; own window: second (front): visible, 1264x649, interval 100.1 Hz, rAF 59.9 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.0 Hz, media ×0.94, decoded 29.2 fps, audio running, set up in 47 ms, browser answers in 5 ms
- resize to 1000×700 and back: 10 ms / 8 ms, same document true (1264 → 1000 → 1264)
- screenshots: png 178 / 193 ms (457 KiB, CPU 273 ms), jpeg 75 / 79 ms (109 KiB, stale -47 / -41 ms, CPU 96 ms)
- screencast: 60.6 fps, 47528 kbit/s, 96 KiB/frame, latency 28 / 30 ms, browser CPU 79%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 262 MiB, per idle tab 51 MiB, 4 browser contexts +471 MiB, a second bot's browser 263 MiB (11 processes), animated tab 34.0% CPU
  - steps: 0 tabs 262 MiB privateBytes / 0.0%, 1 tabs 339 MiB privateBytes / 4.7%, 2 tabs 400 MiB privateBytes / 6.5%, 4 tabs 448 MiB privateBytes / 10.4%, 8 tabs 670 MiB privateBytes / 14.3%

### Electron · linux-arm64-ozone-headless (electron-linux-arm64-ozone-headless.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-arm64 7.0.0-1017-azure, ozone headless, displays 1920x1080@1, status **done**, 459 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.93 | 27.8 | 28 / 52 | 1 / 7 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.95 | 28.4 | 22 / 28 | 4 / 18 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.4 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.95 | 28.4 | 26 / 28 | 16 / 19 | 1280x800@1 → 1000x700@1 → 1280x800 | 0 / 1 | 2.4 |  |
| invisibleWindow | true | true | true | true (1) | 0.97 | 28.6 | 14 / 23 | 3 / 14 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.1 |  |
| tinyWindow | true | true | true | true (1) | 0.96 | 28.6 | 22 / 28 | 2 / 17 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.0 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 99.9 | 99.3 | 60.2 | 17 | – | – | – | 4.8 | 6.6 |  |
| detached, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | – | – | – | 0.0 | 0.2 |  |
| detached, throttling off | visible | 1280x800 | 99.9 | 99.3 | 0.0 | 0 | – | – | – | 1.0 | 1.0 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 2.0 | 1.0 | 0.0 | 0 | – | – | – | 0.0 | 0.0 |  |
| never-shown window, throttling off | visible | 1280x800 | 100.1 | 99.3 | 0.0 | 0 | – | – | – | 1.0 | 1.0 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 100.1 | 99.3 | 1.0 | 1017 | – | – | – | 1.4 | 1.6 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 100.1 | 99.1 | 0.0 | 0 | – | – | 0.0 | 1.0 | 1.4 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 100.1 | 99.1 | 0.0 | 0 | – | – | 0.0 | 0.8 | 0.8 |  |
| invisible shown window, throttling off | visible | 1280x800 | 100.1 | 99.1 | 60.0 | 17 | – | – | – | 4.6 | 6.4 |  |
| 1x1 shown window, throttling off | visible | 1280x800 | 99.9 | 99.3 | 60.0 | 17 | – | – | – | 4.8 | 6.2 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 100.2 | 99.2 | 60.0 | 17 | – | – | – | 4.6 | 6.2 | cover 0,0 1920x1080 over host 0,0 1x1 |
| 1x1 shown window, always on top, under a cover | visible | 1280x800 | 99.9 | 99.1 | 60.0 | 17 | – | – | – | 4.4 | 5.6 | cover 0,0 1920x1080 over host 0,0 1x1 |
| invisible shown window, covered by another window | visible | 1280x800 | 100.1 | 99.3 | 60.2 | 17 | – | – | – | 4.6 | 6.0 | cover -1480,-1000 1920x1080 over host -1480,-1000 1280x800 |
| osr window 30 fps, throttling off | visible | 1280x800 | 100.0 | 99.2 | 30.0 | 34 | – | – | – | 3.4 | 12.0 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 100.1 | 99.1 | 30.0 | 36 | – | – | – | 2.0 | 2.6 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | 0.85 | 25.8 | – | 2.4 | 3.4 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 99.9 | 99.3 | 0.0 | 0 | 0.85 | 25.8 | – | 2.4 | 2.8 |  |
| detached, throttling off, playing media | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | 0.85 | 26.0 | – | 2.6 | 3.4 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 100.1 | 99.1 | 0.0 | 0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 1.8 | 1.0 | 0.0 | 0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | CPU ms/picture | frames/s | visibility events | errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 15 / 16 | -5 / -3 | 1000x700 | 58 | – |  |  |
| shown | true | capturePage | 6/6 | 6 | 15 / 17 | -6 / -3 | 1000x700 | 57 | – |  |  |
| shown | true | cdpJpeg | 6/6 | 6 | 65 / 67 | -46 / -37 | 1000x700 | 87 | – |  |  |
| shown | true | frameSub | 6/6 | 6 | 15 / 23 | -5 / -3 | 1000x700 | 52 | – |  |  |
| shown | true | cdpPng | 6/6 | 6 | 160 / 168 | -44 / -34 | 1000x700 | 222 | – |  |  |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | 70 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | 45 | – |  | frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 4047 / 4050 | -2995 / -43 | 1280x800 | 135 | – |  |  |
| hiddenWindow | false | frameSub | 6/6 | 6 | 7 / 8 | 61 / 73 | 1280x800 | 47 | – |  |  |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.5 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | 3 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 98 / 99 | -61 / -30 | 1280x800 | 147 | – |  |  |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 15 / 16 | 9 / 9 | 1280x800 | 83 | – |  |  |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 6/6 | 6 | 15 / 17 | 9 / 10 | 1280x800 | 67 | – |  |  |
| invisibleWindow | false | capturePage | 6/6 | 6 | 14 / 16 | 9 / 12 | 1280x800 | 68 | – |  |  |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 82 / 87 | -46 / -39 | 1280x800 | 122 | – |  |  |
| invisibleWindow | false | frameSub | 6/6 | 6 | 16 / 19 | 11 / 12 | 1280x800 | 73 | – |  |  |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 15 / 24 | 9 / 11 | 1280x800 | 67 | – |  |  |
| tinyWindow | false | capturePage | 6/6 | 6 | 14 / 17 | 10 / 12 | 1280x800 | 60 | – |  |  |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 82 / 86 | -45 / -36 | 1280x800 | 107 | – |  |  |
| tinyWindow | false | frameSub | 6/6 | 6 | 15 / 19 | 11 / 12 | 1280x800 | 60 | – |  |  |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 14 / 16 | 11 / 15 | 1280x800 | 63 | – |  |  |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 14 / 16 | 9 / 13 | 1280x800 | 58 | – |  |  |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 81 / 82 | -44 / -38 | 1280x800 | 105 | – |  |  |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 15 / 19 | 11 / 12 | 1280x800 | 62 | – |  |  |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 15 / 24 | 1280x800 | 35 | – |  |  |
| osr | false | capturePage | 6/6 | 6 | 31 / 32 | -19 / -5 | 1280x800 | 60 | – |  |  |
| osr | false | cdpJpeg | 6/6 | 6 | 99 / 109 | -73 / -72 | 1280x800 | 93 | – |  |  |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | 173 | – |  | no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | 140 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 232 | pss | 491 | 4 | 0.0 |
| 1 | 260 | pss | 607 | 5 | 0.0 |
| 2 | 276 | pss | 726 | 6 | 0.3 |
| 4 | 306 | pss | 950 | 8 | 0.3 |
| 8 | 358 | pss | 1381 | 12 | 0.5 |

Per idle hidden tab: **16 MiB**, 0.06% CPU. Four tabs: one partition +66 MiB, four partitions +70 MiB.

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 36.2 | 28.7 | 7.5 | 60 |
| animated, never-shown window, throttling off | 1.0 | 1.0 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.0 | 0.0 | 0.0 | 0 |
| animated, never-shown window, throttling off + frame pump | 1.0 | 0.8 | 0.3 | 0 |
| animated, invisible shown window | 48.5 | 38.0 | 10.5 | 60 |
| animated, 1x1 shown window | 39.0 | 37.8 | 1.3 | 60 |
| animated, osr 30 fps | 32.7 | 20.0 | 5.8 | 30 |

### Electron · linux-wayland (electron-linux-wayland.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone wayland, displays 1920x1080@1, status **done**, 729 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.93 | 28.2 | 32 / 142 | 0 / 126 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.92 | 27.5 | 26 / 37 | 1 / 2 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.93 | 27.5 | 24 / 28 | 0 / 2 | 1280x800@1 → 1000x700@1 → 1280x800 | 1 / 2 | 0.0 |  |
| tinyWindow | true | true | true | true (1) | 0.96 | 28.7 | 29 / 30 | 13 / 18 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 40.5 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 100.1 | 99.1 | 39.8 | 26 | – | – | – | 3.6 | 6.6 |  |
| detached, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | – | – | – | 0.0 | 0.2 |  |
| detached, throttling off | visible | 1280x800 | 99.9 | 98.9 | 0.0 | 0 | – | – | – | 1.0 | 1.6 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 2.0 | 1.0 | 0.0 | 0 | – | – | – | 0.0 | 0.6 |  |
| never-shown window, throttling off | visible | 1280x800 | 99.9 | 98.9 | 0.0 | 0 | – | – | – | 1.4 | 1.6 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 100.2 | 99.0 | 0.0 | 0 | – | – | – | 1.6 | 2.0 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | – | – | 0.0 | 1.2 | 1.4 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 100.0 | 99.4 | 0.0 | 0 | – | – | 0.0 | 0.8 | 0.8 |  |
| invisible shown window, throttling off | – | – | – | – | – | – | – | – | – | – | – | not possible here |
| 1x1 shown window, throttling off | visible | 1280x800 | 100.0 | 99.2 | 39.8 | 26 | – | – | – | 3.8 | 6.8 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 100.1 | 99.1 | 39.8 | 26 | – | – | – | 3.6 | 6.8 | cover -10,-10 1940x1100 over host 0,0 1x1 |
| 1x1 shown window, always on top, under a cover | visible | 1280x800 | 99.9 | 99.1 | 39.8 | 26 | – | – | – | 3.6 | 6.6 | cover -10,-10 1940x1100 over host 0,0 1x1 |
| invisible shown window, covered by another window | – | – | – | – | – | – | – | – | – | – | – | not possible here |
| osr window 30 fps, throttling off | visible | 1280x800 | 100.0 | 99.2 | 30.0 | 34 | – | – | – | 3.0 | 12.6 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 100.1 | 99.1 | 30.0 | 34 | – | – | – | 2.4 | 3.2 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 100.1 | 99.3 | 0.0 | 0 | 0.85 | 25.8 | – | 2.2 | 3.2 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 100.2 | 99.2 | 0.0 | 0 | 0.85 | 25.8 | – | 2.2 | 3.2 |  |
| detached, throttling off, playing media | visible | 1280x800 | 100.2 | 99.2 | 0.0 | 0 | 0.85 | 25.8 | – | 2.2 | 3.4 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 2.0 | 1.0 | 0.0 | 0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | CPU ms/picture | frames/s | visibility events | errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 26 / 27 | 31 / 38 | 1000x700 | 35 | – |  |  |
| shown | true | capturePage | 6/6 | 6 | 26 / 32 | 31 / 48 | 1000x700 | 42 | – |  |  |
| shown | true | cdpJpeg | 6/6 | 6 | 130 / 139 | -64 / -61 | 1000x700 | 60 | – |  |  |
| shown | true | frameSub | 6/6 | 6 | 27 / 28 | 33 / 42 | 1000x700 | 32 | – |  |  |
| shown | true | cdpPng | 6/6 | 6 | 244 / 263 | -65 / -64 | 1000x700 | 182 | – |  |  |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 29.5 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | 5 | – |  | Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | 3 | – |  | Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | 85 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | 85 | – |  | frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | 3 | – |  | Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | 3 | – |  | Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 0/2 | 0 | – | – | - | 85 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| hiddenWindow | false | frameSub | 0/2 | 0 | – | – | - | 80 | – |  | frame subscription: timed out after 5000 ms |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | 5 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 0/2 | 0 | – | – | - | 80 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| hiddenWindow + pump | false | frameSub | 0/2 | 0 | – | – | - | 80 | – |  | frame subscription: timed out after 5000 ms |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| invisibleWindow | false | - | 0/0 | 0 | – | – | - | – | – |  | not possible here |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 22 / 25 | 36 / 40 | 1280x800 | 38 | – |  |  |
| tinyWindow | false | capturePage | 6/6 | 6 | 23 / 24 | 35 / 37 | 1280x800 | 33 | – |  |  |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 123 / 135 | -53 / -52 | 1280x800 | 63 | – |  |  |
| tinyWindow | false | frameSub | 6/6 | 6 | 23 / 33 | 38 / 39 | 1280x800 | 38 | – |  |  |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 23 / 30 | 35 / 36 | 1280x800 | 33 | – |  |  |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 23 / 24 | 36 / 37 | 1280x800 | 37 | – |  |  |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 124 / 135 | -53 / -50 | 1280x800 | 62 | – |  |  |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 23 / 24 | 38 / 51 | 1280x800 | 37 | – |  |  |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 11 / 17 | 1280x800 | 23 | – |  |  |
| osr | false | capturePage | 6/6 | 6 | 31 / 32 | -20 / -12 | 1280x800 | 42 | – |  |  |
| osr | false | cdpJpeg | 6/6 | 6 | 98 / 110 | -75 / -69 | 1280x800 | 68 | – |  |  |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | 145 | – |  | no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | 3 | – |  | empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | 125 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 328 | pss | 596 | 4 | 0.3 |
| 1 | 354 | pss | 701 | 5 | 0.5 |
| 2 | 369 | pss | 808 | 6 | 0.3 |
| 4 | 397 | pss | 1022 | 8 | 0.0 |
| 8 | 449 | pss | 1450 | 12 | 0.0 |

Per idle hidden tab: **15 MiB**, -0.03% CPU. Four tabs: one partition +65 MiB, four partitions +68 MiB.

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 15.8 | 9.5 | 5.3 | 39 |
| animated, never-shown window, throttling off | 1.5 | 1.3 | 0.3 | 0 |
| animated, never-shown window, throttling on | 0.3 | 0.0 | 0.3 | 0 |
| animated, never-shown window, throttling off + frame pump | 1.3 | 1.0 | 0.3 | 0 |
| animated, 1x1 shown window | 13.8 | 11.0 | 1.8 | 40 |
| animated, osr 30 fps | 22.3 | 9.5 | 5.3 | 30 |

**Q6 streamed view** (10 s at the viewer; latency p50 / p95 ms)

| road | content | source | fps | decoded fps | latency | gap p95 | kbit/s | bytes/frame | sender CPU % | viewer CPU % | source rAF | notes |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| screencast | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 |  |
| capturePoll | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | {} |
| webrtc-h264 | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | {} |
| webcodecs-vp8 | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | {} |
| webcodecs-h264 | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | {} |
| screencast | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 |  |
| capturePoll | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | {} |
| webrtc-h264 | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | {} |
| webcodecs-vp8 | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | {} |
| webcodecs-h264 | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | {} |
| screencast | anim | invisibleWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | not possible here |
| capturePoll | anim | invisibleWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | not possible here |
| webcodecs-h264 | anim | invisibleWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | not possible here |
| screencast | anim | tinyWindow | 39.9 | 39.9 | 44 / 69 | 26 | 43885 | 137830 | 85 | 22 | 40 |  |
| webcodecs-h264 | anim | tinyWindow | 30.0 | 30.0 | 65 / 67 | 52 | 2357 | 9820 | 69 | 15 | 40 |  |
| screencast | anim | shown | 38.9 | 38.9 | 67 / 68 | 27 | 35579 | 114624 | 66 | 17 | 39 |  |
| webrtc-vp8 | anim | shown | 20.4 | 20.4 | 81 / 88 | 79 | 2497 | 15301 | 75 | 15 | 39 | libvpx; video/VP8 |
| webcodecs-h264 | anim | shown | 29.9 | 29.9 | 72 / 74 | 53 | 2406 | 10058 | 81 | 16 | 39 |  |

### Electron · linux-x11 (electron-linux-x11.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone x11, displays 1920x1080@1, status **done**, 752 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.92 | 27.6 | 29 / 38 | 0 / 18 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.95 | 28.4 | 27 / 35 | 14 / 18 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.1 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.95 | 28.4 | 26 / 31 | 13 / 19 | 1280x800@1 → 1000x700@1 → 1280x800 | 0 / 1 | 2.3 |  |
| invisibleWindow | true | true | true | true (1) | 0.95 | 28.4 | 28 / 31 | 3 / 14 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.1 |  |
| tinyWindow | true | true | true | true (1) | 0.96 | 28.6 | 24 / 27 | 12 / 12 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.0 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 100.2 | 99.2 | 60.0 | 18 | – | – | – | 6.0 | 9.2 |  |
| detached, throttling on (default) | hidden | 1280x800 | 2.0 | 1.0 | 0.0 | 0 | – | – | – | 0.2 | 0.2 |  |
| detached, throttling off | visible | 1280x800 | 99.9 | 98.9 | 0.0 | 0 | – | – | – | 1.8 | 2.2 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | – | – | – | 0.0 | 0.2 |  |
| never-shown window, throttling off | visible | 1280x800 | 100.1 | 98.9 | 0.0 | 0 | – | – | – | 1.4 | 1.6 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 100.1 | 99.1 | 1.0 | 1018 | – | – | – | 1.4 | 2.2 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 100.1 | 98.9 | 0.0 | 0 | – | – | 0.0 | 1.6 | 1.8 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 100.1 | 99.1 | 0.0 | 0 | – | – | 0.0 | 1.4 | 1.6 |  |
| invisible shown window, throttling off | visible | 1280x800 | 100.1 | 99.1 | 0.0 | 0 | – | – | – | 1.6 | 1.6 |  |
| 1x1 shown window, throttling off | visible | 1280x800 | 100.1 | 99.1 | 60.0 | 18 | – | – | – | 5.8 | 8.0 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 100.2 | 99.0 | 60.2 | 18 | – | – | – | 6.4 | 9.4 | cover 0,0 1919x1079 over host 0,0 1x1 |
| 1x1 shown window, always on top, under a cover | visible | 1280x800 | 99.9 | 98.9 | 60.0 | 18 | – | – | – | 6.6 | 9.6 | cover 0,0 1919x1079 over host 0,0 1x1 |
| invisible shown window, covered by another window | visible | 1280x800 | 100.1 | 98.9 | 0.0 | 0 | – | – | – | 1.6 | 1.6 | cover -1480,-1000 1919x1079 over host -1480,-1000 1280x800 |
| osr window 30 fps, throttling off | visible | 1280x800 | 100.0 | 99.0 | 30.0 | 34 | – | – | – | 4.0 | 15.4 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 100.1 | 98.9 | 30.0 | 34 | – | – | – | 2.2 | 3.0 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.85 | 26.0 | – | 2.4 | 3.2 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | 0.85 | 26.0 | – | 2.8 | 3.8 |  |
| detached, throttling off, playing media | visible | 1280x800 | 100.1 | 98.9 | 0.0 | 0 | 0.85 | 26.0 | – | 3.2 | 4.2 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 100.2 | 98.8 | 0.0 | 0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | CPU ms/picture | frames/s | visibility events | errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 14 / 16 | 11 / 12 | 1000x700 | 53 | – |  |  |
| shown | true | capturePage | 6/6 | 6 | 14 / 16 | 9 / 13 | 1000x700 | 53 | – |  |  |
| shown | true | cdpJpeg | 6/6 | 6 | 81 / 83 | -45 / -39 | 1000x700 | 88 | – |  |  |
| shown | true | frameSub | 6/6 | 6 | 14 / 21 | 12 / 13 | 1000x700 | 48 | – |  |  |
| shown | true | cdpPng | 6/6 | 6 | 216 / 223 | -38 / -34 | 1000x700 | 260 | – |  |  |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | 5 | – |  | Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | 110 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | 105 | – |  | frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 4045 / 4049 | -2989 / -51 | 1280x800 | 148 | – |  |  |
| hiddenWindow | false | frameSub | 6/6 | 6 | 10 / 11 | 59 / 79 | 1280x800 | 38 | – |  |  |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.5 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | 5 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 96 / 100 | -55 / -36 | 1280x800 | 145 | – |  |  |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 14 / 26 | 12 / 14 | 1280x800 | 83 | – |  |  |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.5 |  |  |
| invisibleWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| invisibleWindow | false | capturePage | 0/6 | 0 | – | – | - | 3 | – |  | Current display surface not available for capture |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 80 / 85 | -38 / -29 | 1280x800 | 115 | – |  |  |
| invisibleWindow | false | frameSub | 6/6 | 6 | 30 / 32 | 1 / 16 | 1280x800 | 73 | – |  |  |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 15 / 21 | 13 / 15 | 1280x800 | 50 | – |  |  |
| tinyWindow | false | capturePage | 6/6 | 6 | 13 / 15 | 14 / 16 | 1280x800 | 57 | – |  |  |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 80 / 92 | -39 / -35 | 1280x800 | 88 | – |  |  |
| tinyWindow | false | frameSub | 6/6 | 6 | 15 / 30 | 15 / 16 | 1280x800 | 53 | – |  |  |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.5 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 16 / 20 | 12 / 15 | 1280x800 | 53 | – |  |  |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 14 / 15 | 14 / 18 | 1280x800 | 52 | – |  |  |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 82 / 94 | -39 / -37 | 1280x800 | 97 | – |  |  |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 29 / 31 | 2 / 16 | 1280x800 | 57 | – |  |  |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 16 / 23 | 1280x800 | 33 | – |  |  |
| osr | false | capturePage | 6/6 | 6 | 30 / 33 | -15 / -5 | 1280x800 | 62 | – |  |  |
| osr | false | cdpJpeg | 6/6 | 6 | 112 / 132 | -99 / -68 | 1280x800 | 102 | – |  |  |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | 213 | – |  | no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | 7 | – |  | empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | 165 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 319 | pss | 576 | 4 | 0.0 |
| 1 | 347 | pss | 681 | 5 | 0.0 |
| 2 | 362 | pss | 789 | 6 | 0.0 |
| 4 | 390 | pss | 1003 | 8 | 0.3 |
| 8 | 442 | pss | 1431 | 12 | 0.3 |

Per idle hidden tab: **15 MiB**, 0.03% CPU. Four tabs: one partition +65 MiB, four partitions +69 MiB.

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 28.0 | 20.0 | 8.0 | 60 |
| animated, never-shown window, throttling off | 1.3 | 1.3 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.0 | 0.0 | 0.0 | 0 |
| animated, never-shown window, throttling off + frame pump | 1.5 | 1.5 | 0.0 | 0 |
| animated, invisible shown window | 2.0 | 2.0 | 0.0 | 0 |
| animated, 1x1 shown window | 31.5 | 28.5 | 2.8 | 60 |
| animated, osr 30 fps | 29.5 | 14.5 | 5.8 | 30 |

**Q6 streamed view** (10 s at the viewer; latency p50 / p95 ms)

| road | content | source | fps | decoded fps | latency | gap p95 | kbit/s | bytes/frame | sender CPU % | viewer CPU % | source rAF | notes |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| screencast | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | 0 |  |
| capturePoll | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | anim | hiddenWindow | 20.7 | 20.7 | 44 / 51 | 78 | 2509 | 15154 | 73 | 17 | 60 | libvpx; video/VP8 |
| webrtc-h264 | anim | hiddenWindow | 12.6 | 12.6 | 87 / 97 | 110 | 2487 | 24672 | 74 | 11 | 60 | OpenH264; video/H264 |
| webcodecs-vp8 | anim | hiddenWindow | 30.0 | 30.0 | 35 / 38 | 36 | 2426 | 10074 | 100 | 21 | 60 |  |
| webcodecs-h264 | anim | hiddenWindow | 30.0 | 30.0 | 32 / 35 | 36 | 2401 | 10004 | 79 | 18 | 60 |  |
| screencast | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 |  |
| capturePoll | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | static | hiddenWindow | 2.0 | 2.0 | 32 / 34 | 503 | 59 | 3673 | 8 | 2 | 60 | libvpx; video/VP8 |
| webrtc-h264 | static | hiddenWindow | 1.0 | 1.0 | 24 / 25 | 1001 | 18 | 2188 | 7 | 2 | 60 | OpenH264; video/H264 |
| webcodecs-vp8 | static | hiddenWindow | 2.0 | 2.0 | 26 / 30 | 505 | 116 | 7254 | 7 | 1 | 60 |  |
| webcodecs-h264 | static | hiddenWindow | 2.0 | 2.0 | 19 / 21 | 504 | 35 | 2160 | 5 | 1 | 60 |  |
| screencast | anim | invisibleWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | 0 |  |
| capturePoll | anim | invisibleWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | 0 | toJPEG 0.0 ms |
| webcodecs-h264 | anim | invisibleWindow | 30.0 | 30.0 | 37 / 40 | 36 | 2402 | 10008 | 115 | 21 | 60 |  |
| screencast | anim | tinyWindow | 60.1 | 60.1 | 44 / 47 | 20 | 66137 | 137784 | 174 | 45 | 60 |  |
| webcodecs-h264 | anim | tinyWindow | 30.0 | 30.0 | 35 / 38 | 36 | 2399 | 9996 | 98 | 19 | 60 |  |
| screencast | anim | shown | 60.0 | 60.0 | 36 / 40 | 19 | 55030 | 114646 | 128 | 35 | 60 |  |
| webrtc-vp8 | anim | shown | 20.4 | 20.4 | 55 / 62 | 79 | 2511 | 15386 | 111 | 18 | 60 | libvpx; video/VP8 |
| webcodecs-h264 | anim | shown | 30.0 | 30.0 | 42 / 45 | 36 | 2494 | 10357 | 122 | 21 | 60 |  |

### Electron · linux-x64-ozone-headless (electron-linux-x64-ozone-headless.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone headless, displays 1920x1080@1, status **done**, 458 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.94 | 28.6 | 28 / 71 | 0 / 4 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.95 | 28.4 | 15 / 21 | 5 / 12 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.3 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.95 | 28.4 | 12 / 15 | 3 / 5 | 1280x800@1 → 1000x700@1 → 1280x800 | 0 / 1 | 2.4 |  |
| invisibleWindow | true | true | true | true (1) | 0.97 | 28.6 | 12 / 28 | 3 / 13 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.0 |  |
| tinyWindow | true | true | true | true (1) | 0.96 | 28.6 | 13 / 29 | 3 / 9 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.0 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 99.9 | 99.3 | 60.0 | 17 | – | – | – | 2.2 | 3.0 |  |
| detached, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | – | – | – | 0.0 | 0.2 |  |
| detached, throttling off | visible | 1280x800 | 99.9 | 99.3 | 0.0 | 0 | – | – | – | 0.6 | 0.8 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 2.0 | 1.0 | 0.0 | 0 | – | – | – | 0.0 | 0.0 |  |
| never-shown window, throttling off | visible | 1280x800 | 99.9 | 99.3 | 0.0 | 0 | – | – | – | 0.6 | 0.6 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 100.1 | 99.3 | 1.0 | 1017 | – | – | – | 0.8 | 1.0 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | – | – | 0.0 | 0.6 | 0.6 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | – | – | 0.0 | 0.4 | 0.4 |  |
| invisible shown window, throttling off | visible | 1280x800 | 100.0 | 99.2 | 60.0 | 17 | – | – | – | 2.2 | 3.0 |  |
| 1x1 shown window, throttling off | visible | 1280x800 | 100.0 | 99.4 | 60.0 | 17 | – | – | – | 2.0 | 2.8 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 99.9 | 99.1 | 60.0 | 17 | – | – | – | 2.0 | 2.8 | cover 0,0 1920x1080 over host 0,0 1x1 |
| 1x1 shown window, always on top, under a cover | visible | 1280x800 | 100.2 | 99.4 | 60.0 | 17 | – | – | – | 2.0 | 2.6 | cover 0,0 1920x1080 over host 0,0 1x1 |
| invisible shown window, covered by another window | visible | 1280x800 | 100.0 | 99.4 | 60.0 | 17 | – | – | – | 2.2 | 3.0 | cover -1480,-1000 1920x1080 over host -1480,-1000 1280x800 |
| osr window 30 fps, throttling off | visible | 1280x800 | 100.0 | 99.2 | 30.2 | 34 | – | – | – | 2.2 | 10.0 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 100.0 | 99.2 | 30.0 | 34 | – | – | – | 1.2 | 1.6 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 100.0 | 99.4 | 0.0 | 0 | 0.85 | 25.8 | – | 1.4 | 1.8 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 100.1 | 99.3 | 0.0 | 0 | 0.85 | 25.8 | – | 1.8 | 2.4 |  |
| detached, throttling off, playing media | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | 0.85 | 25.8 | – | 1.8 | 2.2 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 100.1 | 99.1 | 0.0 | 0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | CPU ms/picture | frames/s | visibility events | errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 14 / 19 | -8 / 0 | 1000x700 | 35 | – |  |  |
| shown | true | capturePage | 6/6 | 6 | 15 / 15 | -8 / -7 | 1000x700 | 28 | – |  |  |
| shown | true | cdpJpeg | 6/6 | 6 | 49 / 64 | -34 / -33 | 1000x700 | 45 | – |  |  |
| shown | true | frameSub | 6/6 | 6 | 15 / 23 | -7 / -6 | 1000x700 | 27 | – |  |  |
| shown | true | cdpPng | 6/6 | 6 | 157 / 166 | -44 / -35 | 1000x700 | 165 | – |  |  |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | 3 | – |  | Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | 55 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | 35 | – |  | frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | 3 | – |  | Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 4047 / 4048 | -2998 / -37 | 1280x800 | 78 | – |  |  |
| hiddenWindow | false | frameSub | 6/6 | 6 | 7 / 8 | 62 / 70 | 1280x800 | 23 | – |  |  |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.5 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 80 / 87 | -48 / -34 | 1280x800 | 88 | – |  |  |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 15 / 22 | 9 / 9 | 1280x800 | 50 | – |  |  |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 6/6 | 6 | 14 / 15 | 10 / 13 | 1280x800 | 33 | – |  |  |
| invisibleWindow | false | capturePage | 6/6 | 6 | 14 / 15 | 10 / 11 | 1280x800 | 35 | – |  |  |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 80 / 83 | -46 / -39 | 1280x800 | 65 | – |  |  |
| invisibleWindow | false | frameSub | 6/6 | 6 | 15 / 22 | 12 / 13 | 1280x800 | 35 | – |  |  |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 14 / 15 | 10 / 15 | 1280x800 | 27 | – |  |  |
| tinyWindow | false | capturePage | 6/6 | 6 | 14 / 17 | 9 / 11 | 1280x800 | 28 | – |  |  |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 80 / 90 | -46 / -35 | 1280x800 | 53 | – |  |  |
| tinyWindow | false | frameSub | 6/6 | 6 | 15 / 22 | 12 / 12 | 1280x800 | 33 | – |  |  |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 14 / 15 | -6 / 1 | 1280x800 | 32 | – |  |  |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 14 / 16 | -6 / -5 | 1280x800 | 25 | – |  |  |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 64 / 69 | -46 / -38 | 1280x800 | 53 | – |  |  |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 17 / 29 | -4 / -3 | 1280x800 | 42 | – |  |  |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 11 / 16 | 1280x800 | 18 | – |  |  |
| osr | false | capturePage | 6/6 | 6 | 30 / 33 | -21 / -13 | 1280x800 | 42 | – |  |  |
| osr | false | cdpJpeg | 6/6 | 6 | 97 / 107 | -78 / -77 | 1280x800 | 57 | – |  |  |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | 135 | – |  | no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | 3 | – |  | empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | 110 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 236 | pss | 489 | 4 | 0.0 |
| 1 | 263 | pss | 593 | 5 | 0.3 |
| 2 | 279 | pss | 700 | 6 | 0.0 |
| 4 | 306 | pss | 911 | 8 | 0.0 |
| 8 | 358 | pss | 1334 | 12 | 0.5 |

Per idle hidden tab: **15 MiB**, 0.06% CPU. Four tabs: one partition +65 MiB, four partitions +68 MiB.

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 12.5 | 8.8 | 3.8 | 60 |
| animated, never-shown window, throttling off | 0.8 | 0.8 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.3 | 0.0 | 0.0 | 0 |
| animated, never-shown window, throttling off + frame pump | 0.8 | 0.8 | 0.0 | 0 |
| animated, invisible shown window | 17.8 | 11.3 | 6.5 | 60 |
| animated, 1x1 shown window | 10.3 | 9.3 | 1.0 | 60 |
| animated, osr 30 fps | 17.2 | 6.8 | 3.5 | 30 |

### Electron · windows (electron-windows.json)

Electron 45.2.2 (Chromium 156.0.8078.80), win32-x64 10.0.26100, ozone (default), displays 1024x768@1, status **done**, 750 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.92 | 27.3 | 31 / 88 | 2 / 60 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.96 | 28.6 | 22 / 31 | 13 / 14 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.0 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.96 | 28.6 | 21 / 29 | 9 / 13 | 1280x800@1 → 1000x700@1 → 1280x800 | 1 / 3 | 1.9 |  |
| invisibleWindow | true | true | true | true (1) | 0.96 | 28.8 | 22 / 30 | 10 / 14 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 64.0 |  |
| tinyWindow | true | true | true | true (1) | 0.96 | 28.8 | 21 / 30 | 12 / 16 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 64.0 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 100.0 | 93.0 | 64.0 | 18 | – | – | – | 5.7 | 10.5 |  |
| detached, throttling on (default) | hidden | 1280x800 | 1.4 | 1.4 | 0.0 | 0 | – | – | – | 0.0 | 0.3 |  |
| detached, throttling off | visible | 1280x800 | 100.0 | 97.0 | 0.0 | 0 | – | – | – | 1.6 | 1.8 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | – | – | – | 0.0 | 0.2 |  |
| never-shown window, throttling off | visible | 1280x800 | 100.0 | 97.0 | 0.0 | 0 | – | – | – | 1.6 | 1.7 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 100.0 | 90.6 | 1.0 | 1001 | – | – | – | 1.2 | 1.6 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 100.0 | 97.4 | 0.0 | 0 | – | – | 0.0 | 1.4 | 1.6 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 100.0 | 97.2 | 0.0 | 0 | – | – | 0.0 | 1.5 | 1.7 |  |
| invisible shown window, throttling off | visible | 1280x800 | 100.0 | 92.8 | 64.2 | 18 | – | – | – | 5.0 | 9.1 |  |
| 1x1 shown window, throttling off | visible | 1280x800 | 100.0 | 92.2 | 64.0 | 18 | – | – | – | 5.0 | 8.7 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 100.0 | 92.8 | 64.2 | 18 | – | – | – | 5.4 | 9.6 | cover 0,0 1024x720 over host 0,0 32x31 |
| 1x1 shown window, always on top, under a cover | visible | 1280x800 | 100.0 | 92.8 | 64.0 | 18 | – | – | – | 5.4 | 9.6 | cover 0,0 1024x720 over host 0,0 32x31 |
| invisible shown window, covered by another window | visible | 1280x800 | 100.0 | 92.8 | 64.0 | 18 | – | – | – | 5.5 | 10.1 | cover 0,0 1024x720 over host 0,0 1024x720 |
| osr window 30 fps, throttling off | visible | 1024x720 | 100.2 | 91.2 | 30.0 | 35 | – | – | – | 3.2 | 9.6 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 100.0 | 90.8 | 30.0 | 35 | – | – | – | 1.9 | 2.4 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 99.9 | 91.3 | 0.0 | 0 | 0.84 | 24.8 | – | 2.3 | 3.2 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 100.0 | 90.8 | 0.0 | 0 | 0.85 | 24.8 | – | 2.4 | 3.3 |  |
| detached, throttling off, playing media | visible | 1280x800 | 100.0 | 90.6 | 0.0 | 0 | 0.85 | 24.8 | – | 2.3 | 3.2 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 100.0 | 97.0 | 0.0 | 0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 1.4 | 1.0 | 0.0 | 0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | CPU ms/picture | frames/s | visibility events | errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 7 / 21 | 7 / 14 | 1000x700 | 69 | – |  |  |
| shown | true | capturePage | 6/6 | 6 | 8 / 20 | 13 / 14 | 1000x700 | 64 | – |  |  |
| shown | true | cdpJpeg | 6/6 | 6 | 70 / 81 | -39 / -37 | 1000x700 | 106 | – |  |  |
| shown | true | frameSub | 6/6 | 6 | 22 / 24 | 0 / 13 | 1000x700 | 65 | – |  |  |
| shown | true | cdpPng | 6/6 | 6 | 215 / 227 | -44 / -35 | 1000x700 | 320 | – |  |  |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | 108 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | 83 | – |  | frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | 3 | – |  | Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | 3 | – |  | Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 3966 / 3984 | -2938 / -59 | 1280x800 | 150 | – |  |  |
| hiddenWindow | false | frameSub | 6/6 | 6 | 9 / 9 | 63 / 77 | 1280x800 | 40 | – |  |  |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.5 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 82 / 102 | -63 / -33 | 1280x800 | 150 | – |  |  |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 23 / 24 | 0 / 14 | 1280x800 | 82 | – |  |  |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 6/6 | 6 | 19 / 23 | 4 / 7 | 1280x800 | 93 | – |  |  |
| invisibleWindow | false | capturePage | 6/6 | 6 | 19 / 23 | 3 / 5 | 1280x800 | 84 | – |  |  |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 73 / 91 | -42 / -32 | 1280x800 | 136 | – |  |  |
| invisibleWindow | false | frameSub | 6/6 | 6 | 24 / 25 | 7 / 10 | 1280x800 | 93 | – |  |  |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 20 / 22 | 2 / 15 | 1280x800 | 66 | – |  |  |
| tinyWindow | false | capturePage | 6/6 | 6 | 19 / 24 | 2 / 15 | 1280x800 | 60 | – |  |  |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 71 / 83 | -34 / -33 | 1280x800 | 98 | – |  |  |
| tinyWindow | false | frameSub | 6/6 | 6 | 23 / 25 | 6 / 14 | 1280x800 | 62 | – |  |  |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 20 / 22 | 2 / 15 | 1280x800 | 60 | – |  |  |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 22 / 23 | 2 / 5 | 1280x800 | 60 | – |  |  |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 78 / 88 | -44 / -33 | 1280x800 | 104 | – |  |  |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 24 / 26 | 5 / 6 | 1280x800 | 60 | – |  |  |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 27 / 30 | 1024x720 | 23 | – |  |  |
| osr | false | capturePage | 6/6 | 6 | 31 / 32 | -23 / -1 | 1024x720 | 47 | – |  |  |
| osr | false | cdpJpeg | 6/6 | 6 | 100 / 108 | -82 / -80 | 1024x720 | 71 | – |  |  |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | 175 | – |  | no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | 3 | – |  | empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | 134 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 138 | privateBytes | 167 | 4 | 0.0 |
| 1 | 165 | privateBytes | 238 | 5 | 0.1 |
| 2 | 188 | privateBytes | 310 | 6 | 0.2 |
| 4 | 244 | privateBytes | 462 | 8 | 0.3 |
| 8 | 352 | privateBytes | 764 | 12 | 0.5 |

Per idle hidden tab: **27 MiB**, 0.06% CPU. Four tabs: one partition +101 MiB, four partitions +104 MiB.

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 45.6 | 25.5 | 19.6 | 64 |
| animated, never-shown window, throttling off | 1.7 | 1.5 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.1 | 0.0 | 0.0 | 0 |
| animated, never-shown window, throttling off + frame pump | 1.8 | 1.6 | 0.1 | 0 |
| animated, invisible shown window | 59.7 | 34.2 | 25.4 | 64 |
| animated, 1x1 shown window | 40.6 | 35.9 | 4.6 | 64 |
| animated, osr 30 fps | 28.9 | 14.7 | 9.4 | 30 |

**Q6 streamed view** (10 s at the viewer; latency p50 / p95 ms)

| road | content | source | fps | decoded fps | latency | gap p95 | kbit/s | bytes/frame | sender CPU % | viewer CPU % | source rAF | notes |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| screencast | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | 0 |  |
| capturePoll | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | anim | hiddenWindow | 25.6 | 25.6 | 57 / 62 | 77 | 2513 | 12269 | 111 | 22 | 64 | libvpx; video/VP8 |
| webrtc-h264 | anim | hiddenWindow | 14.9 | 14.9 | 71 / 75 | 83 | 2485 | 20849 | 99 | 13 | 64 | OpenH264; video/H264 |
| webcodecs-vp8 | anim | hiddenWindow | 30.1 | 30.1 | 38 / 41 | 48 | 2184 | 9098 | 117 | 21 | 64 |  |
| webcodecs-h264 | anim | hiddenWindow | 30.0 | 30.0 | 32 / 34 | 49 | 2147 | 8947 | 100 | 17 | 64 |  |
| screencast | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | 0 |  |
| capturePoll | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | static | hiddenWindow | 2.0 | 2.0 | 29 / 30 | 502 | 52 | 3231 | 7 | 2 | 64 | libvpx; video/VP8 |
| webrtc-h264 | static | hiddenWindow | 1.0 | 1.0 | 23 / 25 | 1001 | 17 | 2177 | 7 | 1 | 64 | OpenH264; video/H264 |
| webcodecs-vp8 | static | hiddenWindow | 2.0 | 2.0 | 28 / 32 | 506 | 106 | 6594 | 7 | 1 | 64 |  |
| webcodecs-h264 | static | hiddenWindow | 2.0 | 2.0 | 19 / 20 | 501 | 8 | 509 | 5 | 1 | 64 |  |
| screencast | anim | invisibleWindow | 64.0 | 64.0 | 40 / 44 | 20 | 60584 | 118328 | 184 | 40 | 64 |  |
| capturePoll | anim | invisibleWindow | 31.4 | 31.4 | 39 / 42 | 38 | 29847 | 118818 | 126 | 19 | 64 | toJPEG 8.2 ms |
| webcodecs-h264 | anim | invisibleWindow | 30.0 | 30.0 | 37 / 42 | 48 | 2163 | 9013 | 141 | 20 | 64 |  |
| screencast | anim | tinyWindow | 64.0 | 64.0 | 38 / 41 | 19 | 60571 | 118303 | 170 | 40 | 64 |  |
| webcodecs-h264 | anim | tinyWindow | 30.0 | 30.0 | 34 / 37 | 48 | 2161 | 9005 | 114 | 18 | 64 |  |
| screencast | anim | shown | 64.1 | 64.1 | 33 / 35 | 18 | 50850 | 99317 | 131 | 32 | 64 |  |
| webrtc-vp8 | anim | shown | 24.6 | 24.6 | 56 / 58 | 78 | 2500 | 12704 | 139 | 20 | 64 | libvpx; video/VP8 |
| webcodecs-h264 | anim | shown | 30.0 | 30.0 | 43 / 46 | 48 | 2207 | 9195 | 140 | 19 | 64 |  |

