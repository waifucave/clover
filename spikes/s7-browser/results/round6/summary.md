## Spike S7 results

### Chrome for Testing · linux-arm64 (cft-linux-arm64-apparmor.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 0 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 121 MiB archive, 277 MiB unpacked, 287 files, 0 symlinks; download 1226 ms, unpack 995 ms; sha256 `5bb6a00a4285c13303d3f72c5afdb70f144ea7a93eed462365a52b69631c9607` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 55 ms, warm 57 ms; the port for comparison 65 ms
- start attempts: fdpipe ok 55 ms

### Chrome for Testing · linux-arm64 (cft-linux-arm64-worker.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 197 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox off (--no-sandbox: every sandboxed start failed)

- install: 121 MiB archive, 277 MiB unpacked, 287 files, 0 symlinks; download 1226 ms, unpack 995 ms; sha256 `5bb6a00a4285c13303d3f72c5afdb70f144ea7a93eed462365a52b69631c9607` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 60 ms, warm 55 ms; the port for comparison 38 ms
- start attempts: fdpipe failed (fdpipe start failed: browser exited (SIGTRAP) during Browser.getVersion (exit SIGTRAP); stderr: [1105/020200.990866:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:130] No usable sandbox! If you are running o); pipe failed (pipe start failed: browser exited (SIGTRAP) during Browser.getVersion (exit SIGTRAP); stderr: [1105/020201.133906:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:130] No usable sandbox! If you are running on ); port failed (port start failed: browser exited before listening (exit SIGTRAP); stderr: [1105/020201.272906:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:130] No usable sandbox! If you are running on Ubuntu 23.10+ or an); fdpipe --no-sandbox ok 60 ms
- after a tab stopped answering: the browser answers no: browser gone (Browser.getVersion); opens a tab no: browser gone (Target.createTarget)
- media (video with sound, an AudioContext): default flags: visible, interval 99.9 Hz, rAF 60.2 Hz, media ×0.94, decoded 29.0 fps, audio running, set up in 41 ms, browser answers in 1 ms
- screenshots: png 222 / 232 ms (648 KiB, CPU 346 ms), jpeg 79 / 81 ms (163 KiB, stale -45 / -39 ms, CPU 144 ms)
- screencast: 60.3 fps, 66702 kbit/s, 135 KiB/frame, latency 33 / 35 ms, browser CPU 152%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 175 MiB, per idle tab 23 MiB, 4 browser contexts +95 MiB, a second bot's browser 118 MiB (6 processes), animated tab 54.3% CPU
  - steps: 0 tabs 175 MiB pss / 0.0%, 1 tabs 210 MiB pss / 2.5%, 2 tabs 234 MiB pss / 4.5%, 4 tabs 276 MiB pss / 10.2%, 8 tabs 361 MiB pss / 17.4%
- errors: tabs: browser gone (Runtime.evaluate) — the browser exited (0); stderr: [1105/020201.736763:ERROR:dbus/bus.cc:405] Failed to connect to the bus: Could not parse server address: Unknown address type (examples of valid types are "tcp" and on UNIX "unix") | [1105/020201.756356:ERROR:dbus/object_proxy.cc:572] Failed to call method: org.freedesktop.DBus.NameHasOwner: object_path= /org/freedesktop/DBus: unknown error type:  | [1105/020201.757607:ERROR:dbus/bus.cc:405] Failed to connect to the bus: Could not parse server address: Unknown address type (examples of valid types are "tcp" and on UNIX "unix") | [1105/020201.762138:ERROR:dbus/object_proxy.cc:572] Failed to call method: org.freedesktop.DBus.NameHasOwner: object_path= /org/freedesktop/DBus: unknown error type:  | [1105/020201.763376:WARNING:media/gpu/vaapi/vaapi_wrapper.cc:1655] drmGetDevices2() has not found any devices | [1105/020201.765263:WARNING:sandbox/policy/linux/sandbox_linux.cc:405] InitializeSandbox() called with multiple threads in process gpu-process. | [1105/020204.926133:ERROR:content/browser/devtools/devtools_pipe_handler.cc:188] Connection terminated while reading from pipe

**chrome** — Chrome/156.0.8078.80; sandbox off (--no-sandbox: every sandboxed start failed)

- install: 191 MiB archive, 401 MiB unpacked, 301 files, 0 symlinks; download 774 ms, unpack 1370 ms; sha256 `1f496a826c9ba4d6a5f5bf2de686145fe718528c2cc3dbeb96b5893b89653724` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 235 ms, warm 193 ms; the port for comparison 235 ms
- start attempts: fdpipe failed (fdpipe start failed: browser exited (SIGABRT) during Browser.getVersion (exit SIGABRT); stderr: #10 0xab1ef43e9138 (/home/runner/work/_temp/clover-s7-home/browsers/cft/156.0.8078.80/chrome-linux-arm64/chrome-linux-arm64/); pipe failed (pipe start failed: browser exited (SIGABRT) during Browser.getVersion (exit SIGABRT); stderr: #10 0xaadad4629138 (/home/runner/work/_temp/clover-s7-home/browsers/cft/156.0.8078.80/chrome-linux-arm64/chrome-linux-arm64/ch); port failed (port start failed: browser exited before listening (exit SIGABRT); stderr: #10 0xab4c0d159138 (/home/runner/work/_temp/clover-s7-home/browsers/cft/156.0.8078.80/chrome-linux-arm64/chrome-linux-arm64/chrome+0xa869137) | #); fdpipe --no-sandbox ok 235 ms
- tabs: own window: first (background): visible, 1280x657, interval 100.1 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x657, interval 99.9 Hz, rAF 60.0 Hz; one window: first (background): hidden, 1280x657, interval 1.0 Hz, rAF 0.0 Hz; one window: second (front): visible, 1280x657, interval 100.0 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.0 Hz, media ×0.95, decoded 28.8 fps, audio running, set up in 58 ms, browser answers in 0 ms
- resize to 1000×700 and back: 2 ms / 23 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 187 / 200 ms (527 KiB, CPU 308 ms), jpeg 69 / 78 ms (144 KiB, stale -38 / -35 ms, CPU 140 ms)
- screencast: 60.4 fps, 58212 kbit/s, 118 KiB/frame, latency 31 / 33 ms, browser CPU 137%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 425 MiB, per idle tab 55 MiB, 4 browser contexts +303 MiB, a second bot's browser 256 MiB (9 processes), animated tab 58.8% CPU
  - steps: 0 tabs 425 MiB pss / 0.5%, 1 tabs 497 MiB pss / 2.7%, 2 tabs 569 MiB pss / 5.2%, 4 tabs 627 MiB pss / 9.9%, 8 tabs 867 MiB pss / 20.0%

### Chrome for Testing · linux-arm64 (cft-linux-arm64.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 215 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox off (--no-sandbox: every sandboxed start failed)

- install: 121 MiB archive, 277 MiB unpacked, 287 files, 0 symlinks; download 1226 ms, unpack 995 ms; sha256 `5bb6a00a4285c13303d3f72c5afdb70f144ea7a93eed462365a52b69631c9607` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 187 ms, warm 45 ms; the port for comparison 46 ms
- start attempts: fdpipe failed (fdpipe start failed: browser exited (SIGTRAP) during Browser.getVersion (exit SIGTRAP); stderr: [1105/015828.135348:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:130] No usable sandbox! If you are running o); pipe failed (pipe start failed: browser exited (SIGTRAP) during Browser.getVersion (exit SIGTRAP); stderr: [1105/015828.325174:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:130] No usable sandbox! If you are running on ); port failed (port start failed: browser exited before listening (exit SIGTRAP); stderr: [1105/015828.460713:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:130] No usable sandbox! If you are running on Ubuntu 23.10+ or an); fdpipe --no-sandbox ok 187 ms
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.0 Hz, media ×0.94, decoded 29.0 fps, audio running, set up in 42 ms, browser answers in 0 ms
- screenshots: png 217 / 227 ms (645 KiB, CPU 345 ms), jpeg 81 / 84 ms (166 KiB, stale -48 / -42 ms, CPU 149 ms)
- screencast: 60.3 fps, 66657 kbit/s, 135 KiB/frame, latency 33 / 37 ms, browser CPU 153%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 175 MiB, per idle tab 23 MiB, 4 browser contexts +95 MiB, a second bot's browser 118 MiB (6 processes), animated tab 53.8% CPU
  - steps: 0 tabs 175 MiB pss / 0.0%, 1 tabs 210 MiB pss / 2.0%, 2 tabs 234 MiB pss / 5.2%, 4 tabs 276 MiB pss / 10.0%, 8 tabs 361 MiB pss / 17.7%
- errors: tabs: Page.enable timed out (last bytes from the browser 14968 ms ago (889 in all); our writes {"queued":0,"inFlight":false,"writes":4,"bytesOut":344}; trace: 0 → 1 Browser.getVersion, 38 ← 1, 39 → 2 Target.createTarget, 49 ← 2, 49 → 3 Target.attachToTarget, 55 ← Target.attachedToTarget, 55 ← 3, 56 → 4 Page.enable, 86 ← Page.frameStoppedLoading) — the browser is still running; stderr: [1105/015829.062323:ERROR:dbus/bus.cc:405] Failed to connect to the bus: Could not parse server address: Unknown address type (examples of valid types are "tcp" and on UNIX "unix") | [1105/015829.072519:ERROR:dbus/object_proxy.cc:572] Failed to call method: org.freedesktop.DBus.NameHasOwner: object_path= /org/freedesktop/DBus: unknown error type:  | [1105/015829.073200:ERROR:dbus/bus.cc:405] Failed to connect to the bus: Could not parse server address: Unknown address type (examples of valid types are "tcp" and on UNIX "unix") | [1105/015829.074234:ERROR:dbus/object_proxy.cc:572] Failed to call method: org.freedesktop.DBus.NameHasOwner: object_path= /org/freedesktop/DBus: unknown error type:  | [1105/015829.074243:WARNING:media/gpu/vaapi/vaapi_wrapper.cc:1655] drmGetDevices2() has not found any devices | [1105/015829.076482:WARNING:sandbox/policy/linux/sandbox_linux.cc:405] InitializeSandbox() called with multiple threads in process gpu-process.

**chrome** — Chrome/156.0.8078.80; sandbox off (--no-sandbox: every sandboxed start failed)

- install: 191 MiB archive, 401 MiB unpacked, 301 files, 0 symlinks; download 774 ms, unpack 1370 ms; sha256 `1f496a826c9ba4d6a5f5bf2de686145fe718528c2cc3dbeb96b5893b89653724` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 268 ms, warm 207 ms; the port for comparison 271 ms
- start attempts: fdpipe failed (fdpipe start failed: browser exited (SIGABRT) during Browser.getVersion (exit SIGABRT); stderr: #10 0xab8888379138 (/home/runner/work/_temp/clover-s7-home/browsers/cft/156.0.8078.80/chrome-linux-arm64/chrome-linux-arm64/); pipe failed (pipe start failed: browser exited (SIGABRT) during Browser.getVersion (exit SIGABRT); stderr: #10 0xab9e57289138 (/home/runner/work/_temp/clover-s7-home/browsers/cft/156.0.8078.80/chrome-linux-arm64/chrome-linux-arm64/ch); port failed (port start failed: browser exited before listening (exit SIGABRT); stderr: #10 0xaaff82ae9138 (/home/runner/work/_temp/clover-s7-home/browsers/cft/156.0.8078.80/chrome-linux-arm64/chrome-linux-arm64/chrome+0xa869137) | #); fdpipe --no-sandbox ok 268 ms
- tabs: own window: first (background): visible, 1280x657, interval 100.1 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x657, interval 100.2 Hz, rAF 60.0 Hz; one window: first (background): hidden, 1280x657, interval 2.0 Hz, rAF 0.0 Hz; one window: second (front): visible, 1280x657, interval 99.9 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 99.9 Hz, rAF 60.0 Hz, media ×0.95, decoded 28.8 fps, audio running, set up in 80 ms, browser answers in 0 ms
- resize to 1000×700 and back: 4 ms / 23 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 208 / 212 ms (526 KiB, CPU 311 ms), jpeg 85 / 88 ms (146 KiB, stale -37 / -35 ms, CPU 149 ms)
- screencast: 60.5 fps, 58143 kbit/s, 117 KiB/frame, latency 48 / 49 ms, browser CPU 138%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 451 MiB, per idle tab 48 MiB, 4 browser contexts +314 MiB, a second bot's browser 289 MiB (11 processes), animated tab 58.3% CPU
  - steps: 0 tabs 451 MiB pss / 2.0%, 1 tabs 523 MiB pss / 2.5%, 2 tabs 595 MiB pss / 5.7%, 4 tabs 657 MiB pss / 10.7%, 8 tabs 837 MiB pss / 19.8%

### Chrome for Testing · linux-x64 (cft-linux-x64-apparmor.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 0 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 121 MiB archive, 274 MiB unpacked, 287 files, 0 symlinks; download 698 ms, unpack 1330 ms; sha256 `547dcd374e02961bf998f6046a267644f8502225c36bb78ca307dab32a0b3eb4` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 107 ms, warm 89 ms; the port for comparison 80 ms
- start attempts: fdpipe ok 107 ms

### Chrome for Testing · linux-x64 (cft-linux-x64-worker.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 201 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox off (--no-sandbox: every sandboxed start failed)

- install: 121 MiB archive, 274 MiB unpacked, 287 files, 0 symlinks; download 698 ms, unpack 1330 ms; sha256 `547dcd374e02961bf998f6046a267644f8502225c36bb78ca307dab32a0b3eb4` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 117 ms, warm 77 ms; the port for comparison 53 ms
- start attempts: fdpipe failed (fdpipe start failed: browser exited (SIGTRAP) during Browser.getVersion (exit SIGTRAP); stderr: [1105/020232.974988:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:130] No usable sandbox! If you are running o); pipe failed (pipe start failed: browser exited (SIGTRAP) during Browser.getVersion (exit SIGTRAP); stderr: [1105/020233.152128:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:130] No usable sandbox! If you are running on ); port failed (port start failed: browser exited before listening (exit SIGTRAP); stderr: [1105/020233.335011:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:130] No usable sandbox! If you are running on Ubuntu 23.10+ or an); fdpipe --no-sandbox ok 117 ms
- after a tab stopped answering: the browser answers no: browser gone (Browser.getVersion); opens a tab no: browser gone (Target.createTarget)
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.2 Hz, media ×0.93, decoded 29.0 fps, audio running, set up in 49 ms, browser answers in 0 ms
- screenshots: png 316 / 327 ms (631 KiB, CPU 399 ms), jpeg 76 / 88 ms (148 KiB, stale -47 / -34 ms, CPU 109 ms)
- screencast: 60.5 fps, 66167 kbit/s, 134 KiB/frame, latency 36 / 39 ms, browser CPU 165%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 171 MiB, per idle tab 23 MiB, 4 browser contexts +94 MiB, a second bot's browser 114 MiB (6 processes), animated tab 32.3% CPU
  - steps: 0 tabs 171 MiB pss / 0.0%, 1 tabs 206 MiB pss / 1.7%, 2 tabs 229 MiB pss / 4.2%, 4 tabs 272 MiB pss / 6.5%, 8 tabs 357 MiB pss / 12.1%
- errors: tabs: browser gone (Runtime.evaluate) — the browser exited (0); stderr: [1105/020233.927163:ERROR:dbus/bus.cc:405] Failed to connect to the bus: Could not parse server address: Unknown address type (examples of valid types are "tcp" and on UNIX "unix") | [1105/020233.937891:ERROR:dbus/object_proxy.cc:572] Failed to call method: org.freedesktop.DBus.NameHasOwner: object_path= /org/freedesktop/DBus: unknown error type:  | [1105/020233.937970:ERROR:dbus/bus.cc:405] Failed to connect to the bus: Could not parse server address: Unknown address type (examples of valid types are "tcp" and on UNIX "unix") | [1105/020233.942918:ERROR:dbus/object_proxy.cc:572] Failed to call method: org.freedesktop.DBus.NameHasOwner: object_path= /org/freedesktop/DBus: unknown error type:  | [1105/020233.961298:WARNING:media/gpu/vaapi/vaapi_wrapper.cc:1655] drmGetDevices2() has not found any devices | [1105/020233.964043:WARNING:sandbox/policy/linux/sandbox_linux.cc:405] InitializeSandbox() called with multiple threads in process gpu-process. | [1105/020237.077348:ERROR:content/browser/devtools/devtools_pipe_handler.cc:188] Connection terminated while reading from pipe

**chrome** — Chrome/156.0.8078.80; sandbox off (--no-sandbox: every sandboxed start failed)

- install: 192 MiB archive, 403 MiB unpacked, 301 files, 0 symlinks; download 874 ms, unpack 1808 ms; sha256 `b711c720f774be355197f32edf37e0651418ba036d92446ee2da19ac017540a7` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 289 ms, warm 236 ms; the port for comparison 250 ms
- start attempts: fdpipe failed (fdpipe start failed: browser exited (SIGABRT) during Browser.getVersion (exit SIGABRT); stderr: #16 0x559fb2b8e03a (/home/runner/work/_temp/clover-s7-home/browsers/cft/156.0.8078.80/chrome-linux64/chrome-linux64/chrome+0); pipe failed (pipe start failed: browser exited (SIGABRT) during Browser.getVersion (exit SIGABRT); stderr: #16 0x555babb7603a (/home/runner/work/_temp/clover-s7-home/browsers/cft/156.0.8078.80/chrome-linux64/chrome-linux64/chrome+0x7); port failed (port start failed: browser exited before listening (exit SIGABRT); stderr: #16 0x5595d6bfb03a (/home/runner/work/_temp/clover-s7-home/browsers/cft/156.0.8078.80/chrome-linux64/chrome-linux64/chrome+0x7646039) |   r8: 000); fdpipe --no-sandbox ok 289 ms
- tabs: own window: first (background): visible, 1280x657, interval 100.1 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x657, interval 100.0 Hz, rAF 60.0 Hz; one window: first (background): hidden, 1280x657, interval 1.0 Hz, rAF 0.0 Hz; one window: second (front): visible, 1280x657, interval 100.0 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.0 Hz, media ×0.95, decoded 28.8 fps, audio running, set up in 95 ms, browser answers in 0 ms
- resize to 1000×700 and back: 2 ms / 23 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 267 / 275 ms (527 KiB, CPU 391 ms), jpeg 80 / 84 ms (141 KiB, stale -45 / -39 ms, CPU 131 ms)
- screencast: 60.8 fps, 57983 kbit/s, 117 KiB/frame, latency 33 / 36 ms, browser CPU 145%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 410 MiB, per idle tab 55 MiB, 4 browser contexts +309 MiB, a second bot's browser 259 MiB (9 processes), animated tab 39.5% CPU
  - steps: 0 tabs 410 MiB pss / 1.2%, 1 tabs 486 MiB pss / 2.7%, 2 tabs 537 MiB pss / 4.7%, 4 tabs 622 MiB pss / 6.9%, 8 tabs 847 MiB pss / 13.8%

### Chrome for Testing · linux-x64 (cft-linux-x64.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 249 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox off (--no-sandbox: every sandboxed start failed)

- install: 121 MiB archive, 274 MiB unpacked, 287 files, 0 symlinks; download 698 ms, unpack 1330 ms; sha256 `547dcd374e02961bf998f6046a267644f8502225c36bb78ca307dab32a0b3eb4` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 158 ms, warm 54 ms; the port for comparison 61 ms
- start attempts: fdpipe failed (fdpipe start failed: browser exited (SIGTRAP) during Browser.getVersion (exit SIGTRAP); stderr: [1105/015826.030226:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:130] No usable sandbox! If you are running o); pipe failed (pipe start failed: browser exited (SIGTRAP) during Browser.getVersion (exit SIGTRAP); stderr: [1105/015826.215008:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:130] No usable sandbox! If you are running on ); port failed (port start failed: browser exited before listening (exit SIGTRAP); stderr: [1105/015826.411626:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:130] No usable sandbox! If you are running on Ubuntu 23.10+ or an); fdpipe --no-sandbox ok 158 ms
- after a tab stopped answering: the browser answers no: Browser.getVersion timed out (last bytes from the browser 10002 ms ago (8934 in all); our writes {"queued":0,"inFlight":false,"writes":20,"bytesOut":2637}; trace: 2211 → 14 Runtime.evaluate, 2212 ← 14, 2212 → 15 Runtime.evaluate, 2213 ← 15, 2213 → 16 Runtime.evaluate, 2214 ← 16, 2214 → 17 Runtime.ev; opens a tab no: Target.createTarget timed out (last bytes from the browser 15002 ms ago (8934 in all); our writes {"queued":0,"inFlight":false,"writes":21,"bytesOut":2726}; trace: 2212 ← 14, 2212 → 15 Runtime.evaluate, 2213 ← 15, 2213 → 16 Runtime.evaluate, 2214 ← 16, 2214 → 17 Runtime.evaluate, 2215 ← 17, 7216 → 1
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.0 Hz, media ×0.91, decoded 29.0 fps, audio running, set up in 178 ms, browser answers in 0 ms
- screenshots: png 309 / 318 ms (643 KiB, CPU 409 ms), jpeg 79 / 87 ms (150 KiB, stale -45 / -38 ms, CPU 116 ms)
- screencast: 57.8 fps, 63326 kbit/s, 134 KiB/frame, latency 37 / 48 ms, browser CPU 169%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 172 MiB, per idle tab 23 MiB, 4 browser contexts +94 MiB, a second bot's browser 114 MiB (6 processes), animated tab 32.3% CPU
  - steps: 0 tabs 172 MiB pss / 0.0%, 1 tabs 207 MiB pss / 2.2%, 2 tabs 229 MiB pss / 4.2%, 4 tabs 272 MiB pss / 6.5%, 8 tabs 357 MiB pss / 10.9%
- errors: tabs: Runtime.evaluate timed out (last bytes from the browser 25003 ms ago (8934 in all); our writes {"queued":0,"inFlight":false,"writes":22,"bytesOut":2901}; trace: 2212 → 15 Runtime.evaluate, 2213 ← 15, 2213 → 16 Runtime.evaluate, 2214 ← 16, 2214 → 17 Runtime.evaluate, 2215 ← 17, 7216 → 18 Runtime.evaluate, 7216 ← 18, 7216 → 19 Runtime.evaluate, 12217 → 20 Browser.getVersion, 17218 → 21 Target.createTarget, 22218 → 22 Runtime.evaluate) — the browser is still running; stderr: [1105/015827.099346:ERROR:dbus/bus.cc:405] Failed to connect to the bus: Could not parse server address: Unknown address type (examples of valid types are "tcp" and on UNIX "unix") | [1105/015827.112066:ERROR:dbus/object_proxy.cc:572] Failed to call method: org.freedesktop.DBus.NameHasOwner: object_path= /org/freedesktop/DBus: unknown error type:  | [1105/015827.112724:ERROR:dbus/bus.cc:405] Failed to connect to the bus: Could not parse server address: Unknown address type (examples of valid types are "tcp" and on UNIX "unix") | [1105/015827.116934:ERROR:dbus/object_proxy.cc:572] Failed to call method: org.freedesktop.DBus.NameHasOwner: object_path= /org/freedesktop/DBus: unknown error type:  | [1105/015827.130238:WARNING:media/gpu/vaapi/vaapi_wrapper.cc:1655] drmGetDevices2() has not found any devices | [1105/015827.133036:WARNING:sandbox/policy/linux/sandbox_linux.cc:405] InitializeSandbox() called with multiple threads in process gpu-process.

**chrome** — Chrome/156.0.8078.80; sandbox off (--no-sandbox: every sandboxed start failed)

- install: 192 MiB archive, 403 MiB unpacked, 301 files, 0 symlinks; download 874 ms, unpack 1808 ms; sha256 `b711c720f774be355197f32edf37e0651418ba036d92446ee2da19ac017540a7` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 302 ms, warm 242 ms; the port for comparison 256 ms
- start attempts: fdpipe failed (fdpipe start failed: browser exited (SIGABRT) during Browser.getVersion (exit SIGABRT); stderr: #16 0x556f2c72b03a (/home/runner/work/_temp/clover-s7-home/browsers/cft/156.0.8078.80/chrome-linux64/chrome-linux64/chrome+0); pipe failed (pipe start failed: browser exited (SIGABRT) during Browser.getVersion (exit SIGABRT); stderr: #16 0x556f6222203a (/home/runner/work/_temp/clover-s7-home/browsers/cft/156.0.8078.80/chrome-linux64/chrome-linux64/chrome+0x7); port failed (port start failed: browser exited before listening (exit SIGABRT); stderr: #16 0x55754f3da03a (/home/runner/work/_temp/clover-s7-home/browsers/cft/156.0.8078.80/chrome-linux64/chrome-linux64/chrome+0x7646039) |   r8: 000); fdpipe --no-sandbox ok 302 ms
- after a tab stopped answering: the browser answers no: Browser.getVersion timed out (last bytes from the browser 10000 ms ago (8808 in all); our writes {"queued":0,"inFlight":false,"writes":20,"bytesOut":2637}; trace: 2791 → 14 Runtime.evaluate, 2791 ← 14, 2792 → 15 Runtime.evaluate, 2792 ← 15, 2792 → 16 Runtime.evaluate, 2793 ← 16, 2793 → 17 Runtime.ev; opens a tab no: Target.createTarget timed out (last bytes from the browser 15001 ms ago (8808 in all); our writes {"queued":0,"inFlight":false,"writes":21,"bytesOut":2726}; trace: 2791 ← 14, 2792 → 15 Runtime.evaluate, 2792 ← 15, 2792 → 16 Runtime.evaluate, 2793 ← 16, 2793 → 17 Runtime.evaluate, 2794 ← 17, 7795 → 1
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.0 Hz, media ×0.95, decoded 28.8 fps, audio running, set up in 110 ms, browser answers in 0 ms
- screenshots: png 261 / 276 ms (531 KiB, CPU 386 ms), jpeg 80 / 84 ms (139 KiB, stale -44 / -39 ms, CPU 128 ms)
- screencast: 60.5 fps, 57696 kbit/s, 116 KiB/frame, latency 33 / 36 ms, browser CPU 144%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 436 MiB, per idle tab 54 MiB, 4 browser contexts +303 MiB, a second bot's browser 285 MiB (11 processes), animated tab 44.8% CPU
  - steps: 0 tabs 436 MiB pss / 1.5%, 1 tabs 511 MiB pss / 2.5%, 2 tabs 561 MiB pss / 4.4%, 4 tabs 651 MiB pss / 6.9%, 8 tabs 864 MiB pss / 13.5%
- errors: tabs: Runtime.evaluate timed out (last bytes from the browser 25001 ms ago (8808 in all); our writes {"queued":0,"inFlight":false,"writes":22,"bytesOut":2901}; trace: 2792 → 15 Runtime.evaluate, 2792 ← 15, 2792 → 16 Runtime.evaluate, 2793 ← 16, 2793 → 17 Runtime.evaluate, 2794 ← 17, 7795 → 18 Runtime.evaluate, 7796 ← 18, 7796 → 19 Runtime.evaluate, 12796 → 20 Browser.getVersion, 17796 → 21 Target.createTarget, 22797 → 22 Runtime.evaluate) — the browser is still running; stderr: [3908:3908:1105/020029.744693:ERROR:dbus/object_proxy.cc:572] Failed to call method: org.freedesktop.NetworkManager.GetDevices: object_path= /org/freedesktop/NetworkManager: org.freedesktop.DBus.Error.ServiceUnknown: The name org.freedesktop.NetworkManager was not provided by any .service files | [3908:3973:1105/020037.078565:ERROR:content/browser/devtools/devtools_pipe_handler.cc:274] Could not write into pipe | [3908:3973:1105/020037.078586:ERROR:content/browser/devtools/devtools_pipe_handler.cc:274] Could not write into pipe | [3908:3973:1105/020042.078789:ERROR:content/browser/devtools/devtools_pipe_handler.cc:274] Could not write into pipe | [3908:3973:1105/020042.078810:ERROR:content/browser/devtools/devtools_pipe_handler.cc:274] Could not write into pipe | [3908:3973:1105/020047.142715:ERROR:content/browser/devtools/devtools_pipe_handler.cc:274] Could not write into pipe | [3908:3973:1105/020047.142741:ERROR:content/browser/devtools/devtools_pipe_handler.cc:274] Could not write into pipe | [3908:3908:1105/020047.173312:ERROR:dbus/object_proxy.cc:572] Failed to call method: org.freedesktop.NetworkManager.GetDevices: object_path= /org/freedesktop/NetworkManager: org.freedesktop.DBus.Error.ServiceUnknown: The name org.freedesktop.NetworkManager was not provided by any .service files | [3908:3973:1105/020052.079855:ERROR:content/browser/devtools/devtools_pipe_handler.cc:274] Could not write into pipe | [3908:3973:1105/020052.079876:ERROR:content/browser/devtools/devtools_pipe_handler.cc:274] Could not write into pipe

### Chrome for Testing · win32-x64 (cft-windows.json)

10.0.26100, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 248 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 120 MiB archive, 282 MiB unpacked, 288 files, 0 symlinks; download 1411 ms, unpack 1357 ms; sha256 `10a77466005e7f64e00f1a75fd1ea81f4a38a60093c65fea6895843b26e60a9a` (matches the pin; server MD5 true)
- start: over **winpipe**, cold 150 ms, warm 114 ms; the port for comparison 138 ms
- start attempts: winpipe ok 150 ms
- tabs: own window: first (background): visible, 1280x800, interval 100.1 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x800, interval 100.2 Hz, rAF 60.1 Hz; one window: first (background): visible, 1280x800, interval 100.0 Hz, rAF 60.1 Hz; one window: second (front): visible, 1280x800, interval 100.0 Hz, rAF 59.9 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 99.9 Hz, rAF 59.9 Hz, media ×0.99, decoded 29.2 fps, audio running, set up in 59 ms, browser answers in 5 ms
- resize to 1000×700 and back: 11 ms / 7 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 265 / 297 ms (563 KiB, CPU 484 ms), jpeg 76 / 91 ms (147 KiB, stale -45 / -34 ms, CPU 199 ms)
- screencast: 56.6 fps, 53149 kbit/s, 115 KiB/frame, latency 41 / 44 ms, browser CPU 160%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 69 MiB, per idle tab 29 MiB, 4 browser contexts +116 MiB, a second bot's browser 69 MiB (5 processes), animated tab 47.6% CPU
  - steps: 0 tabs 69 MiB privateBytes / 0.0%, 1 tabs 99 MiB privateBytes / 3.1%, 2 tabs 128 MiB privateBytes / 2.1%, 4 tabs 185 MiB privateBytes / 11.1%, 8 tabs 299 MiB privateBytes / 16.6%

**chrome** — Chrome/156.0.8078.80; sandbox on

- install: 199 MiB archive, 439 MiB unpacked, 305 files, 0 symlinks; download 1933 ms, unpack 2132 ms; sha256 `16edb57d6107bf1c48a7c149b8d78b155fe614410093796dd72441fd6640540f` (matches the pin; server MD5 true)
- start: over **winpipe**, cold 733 ms, warm 502 ms; the port for comparison 490 ms
- start attempts: winpipe ok 733 ms
- tabs: own window: first (background): visible, 1264x649, interval 99.8 Hz, rAF 59.9 Hz; own window: second (front): visible, 1264x649, interval 99.8 Hz, rAF 59.7 Hz; one window: first (background): hidden, 1264x649, interval 1.0 Hz, rAF 0.0 Hz; one window: second (front): visible, 1264x649, interval 100.0 Hz, rAF 59.9 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.1 Hz, media ×1.00, decoded 29.1 fps, audio running, set up in 93 ms, browser answers in 5 ms
- resize to 1000×700 and back: 11 ms / 12 ms, same document true (1264 → 1000 → 1264)
- screenshots: png 237 / 292 ms (455 KiB, CPU 467 ms), jpeg 79 / 87 ms (106 KiB, stale -41 / -38 ms, CPU 139 ms)
- screencast: 60.5 fps, 47441 kbit/s, 96 KiB/frame, latency 38 / 44 ms, browser CPU 137%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 307 MiB, per idle tab 50 MiB, 4 browser contexts +456 MiB, a second bot's browser 266 MiB (12 processes), animated tab 49.4% CPU
  - steps: 0 tabs 307 MiB privateBytes / 2.1%, 1 tabs 385 MiB privateBytes / 2.4%, 2 tabs 442 MiB privateBytes / 11.4%, 4 tabs 495 MiB privateBytes / 10.6%, 8 tabs 708 MiB privateBytes / 38.0%

