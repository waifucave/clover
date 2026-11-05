## Spike S7 results

### Chrome for Testing · linux-arm64 (cft-linux-arm64-apparmor.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 0 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 121 MiB archive, 277 MiB unpacked, 287 files, 0 symlinks; download 1155 ms, unpack 965 ms; sha256 `5bb6a00a4285c13303d3f72c5afdb70f144ea7a93eed462365a52b69631c9607` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 53 ms, warm 62 ms; the port for comparison 60 ms
- start attempts: fdpipe ok 53 ms

### Chrome for Testing · linux-arm64 (cft-linux-arm64-worker.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 203 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox off (--no-sandbox: every sandboxed start failed)

- install: 121 MiB archive, 277 MiB unpacked, 287 files, 0 symlinks; download 1155 ms, unpack 965 ms; sha256 `5bb6a00a4285c13303d3f72c5afdb70f144ea7a93eed462365a52b69631c9607` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 42 ms, warm 56 ms; the port for comparison 40 ms
- start attempts: fdpipe failed (fdpipe start failed: browser exited (SIGTRAP) during Browser.getVersion (exit SIGTRAP); stderr: [1105/021337.511140:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:130] No usable sandbox! If you are running o); fdpipe --no-sandbox ok 42 ms
- tabs: own window: first (background): visible, 1280x800, interval 100.0 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x800, interval 100.2 Hz, rAF 60.0 Hz; one window: first (background): visible, 1280x800, interval 99.9 Hz, rAF 60.0 Hz; one window: second (front): visible, 1280x800, interval 99.9 Hz, rAF 60.2 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.2 Hz, rAF 60.0 Hz, media ×0.94, decoded 29.0 fps, audio running, set up in 30 ms, browser answers in 1 ms
- resize to 1000×700 and back: 2 ms / 22 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 233 / 242 ms (648 KiB, CPU 334 ms), jpeg 84 / 100 ms (164 KiB, stale -43 / -34 ms, CPU 141 ms)
- screencast: 60.3 fps, 66525 kbit/s, 135 KiB/frame, latency 48 / 49 ms, browser CPU 144%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 175 MiB, per idle tab 23 MiB, 4 browser contexts +95 MiB, a second bot's browser 112 MiB (6 processes), animated tab 50.1% CPU
  - steps: 0 tabs 175 MiB pss / 0.0%, 1 tabs 210 MiB pss / 1.8%, 2 tabs 234 MiB pss / 3.7%, 4 tabs 276 MiB pss / 8.5%, 8 tabs 361 MiB pss / 13.9%

**chrome** — Chrome/156.0.8078.80; sandbox off (--no-sandbox: every sandboxed start failed)

- install: 191 MiB archive, 401 MiB unpacked, 301 files, 0 symlinks; download 1230 ms, unpack 1356 ms; sha256 `1f496a826c9ba4d6a5f5bf2de686145fe718528c2cc3dbeb96b5893b89653724` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 232 ms, warm 197 ms; the port for comparison 222 ms
- start attempts: fdpipe failed (fdpipe start failed: browser exited (SIGABRT) during Browser.getVersion (exit SIGABRT); stderr: #10 0xaab7043d9138 (/home/runner/work/_temp/clover-s7-home/browsers/cft/156.0.8078.80/chrome-linux-arm64/chrome-linux-arm64/); fdpipe --no-sandbox ok 232 ms
- tabs: own window: first (background): visible, 1280x657, interval 99.9 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x657, interval 99.9 Hz, rAF 60.0 Hz; one window: first (background): hidden, 1280x657, interval 1.0 Hz, rAF 0.0 Hz; one window: second (front): visible, 1280x657, interval 100.1 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 99.9 Hz, rAF 60.0 Hz, media ×0.95, decoded 28.8 fps, audio running, set up in 65 ms, browser answers in 1 ms
- resize to 1000×700 and back: 2 ms / 22 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 183 / 197 ms (520 KiB, CPU 296 ms), jpeg 72 / 75 ms (144 KiB, stale -41 / -39 ms, CPU 131 ms)
- screencast: 60.3 fps, 58091 kbit/s, 118 KiB/frame, latency 30 / 31 ms, browser CPU 130%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 480 MiB, per idle tab 50 MiB, 4 browser contexts +313 MiB, a second bot's browser 240 MiB (9 processes), animated tab 56.2% CPU
  - steps: 0 tabs 480 MiB pss / 1.5%, 1 tabs 552 MiB pss / 2.5%, 2 tabs 623 MiB pss / 4.7%, 4 tabs 686 MiB pss / 9.4%, 8 tabs 883 MiB pss / 16.8%

### Chrome for Testing · linux-arm64 (cft-linux-arm64.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 210 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox off (--no-sandbox: every sandboxed start failed)

- install: 121 MiB archive, 277 MiB unpacked, 287 files, 0 symlinks; download 1155 ms, unpack 965 ms; sha256 `5bb6a00a4285c13303d3f72c5afdb70f144ea7a93eed462365a52b69631c9607` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 417 ms, warm 35 ms; the port for comparison 49 ms
- start attempts: fdpipe failed (fdpipe start failed: browser exited (SIGTRAP) during Browser.getVersion (exit SIGTRAP); stderr: [1105/021009.718211:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:130] No usable sandbox! If you are running o); fdpipe --no-sandbox ok 417 ms
- tabs: own window: first (background): visible, 1280x800, interval 100.0 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x800, interval 100.0 Hz, rAF 60.0 Hz; one window: first (background): visible, 1280x800, interval 99.9 Hz, rAF 60.0 Hz; one window: second (front): visible, 1280x800, interval 100.0 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.0 Hz, media ×0.94, decoded 29.0 fps, audio running, set up in 29 ms, browser answers in 0 ms
- resize to 1000×700 and back: 2 ms / 22 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 214 / 220 ms (637 KiB, CPU 319 ms), jpeg 67 / 77 ms (164 KiB, stale -35 / -35 ms, CPU 126 ms)
- screencast: 60.1 fps, 66687 kbit/s, 135 KiB/frame, latency 31 / 33 ms, browser CPU 137%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 175 MiB, per idle tab 23 MiB, 4 browser contexts +95 MiB, a second bot's browser 118 MiB (6 processes), animated tab 50.1% CPU
  - steps: 0 tabs 175 MiB pss / 0.0%, 1 tabs 211 MiB pss / 1.8%, 2 tabs 234 MiB pss / 3.5%, 4 tabs 276 MiB pss / 7.0%, 8 tabs 362 MiB pss / 12.9%

**chrome** — Chrome/156.0.8078.80; sandbox off (--no-sandbox: every sandboxed start failed)

- install: 191 MiB archive, 401 MiB unpacked, 301 files, 0 symlinks; download 1230 ms, unpack 1356 ms; sha256 `1f496a826c9ba4d6a5f5bf2de686145fe718528c2cc3dbeb96b5893b89653724` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 309 ms, warm 195 ms; the port for comparison 252 ms
- start attempts: fdpipe failed (fdpipe start failed: browser exited (SIGABRT) during Browser.getVersion (exit SIGABRT); stderr: #10 0xab5a07799138 (/home/runner/work/_temp/clover-s7-home/browsers/cft/156.0.8078.80/chrome-linux-arm64/chrome-linux-arm64/); fdpipe --no-sandbox ok 309 ms
- tabs: own window: first (background): visible, 1280x657, interval 100.1 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x657, interval 100.0 Hz, rAF 60.0 Hz; one window: first (background): hidden, 1280x657, interval 1.8 Hz, rAF 0.0 Hz; one window: second (front): visible, 1280x657, interval 99.9 Hz, rAF 60.2 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.0 Hz, media ×0.95, decoded 28.8 fps, audio running, set up in 69 ms, browser answers in 1 ms
- resize to 1000×700 and back: 3 ms / 25 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 190 / 196 ms (524 KiB, CPU 298 ms), jpeg 71 / 77 ms (144 KiB, stale -41 / -35 ms, CPU 130 ms)
- screencast: 60.4 fps, 58193 kbit/s, 118 KiB/frame, latency 31 / 32 ms, browser CPU 135%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 451 MiB, per idle tab 48 MiB, 4 browser contexts +350 MiB, a second bot's browser 284 MiB (11 processes), animated tab 55.8% CPU
  - steps: 0 tabs 451 MiB pss / 1.0%, 1 tabs 521 MiB pss / 2.5%, 2 tabs 593 MiB pss / 5.0%, 4 tabs 657 MiB pss / 9.9%, 8 tabs 838 MiB pss / 18.1%

### Chrome for Testing · linux-x64 (cft-linux-x64-apparmor.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 0 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 121 MiB archive, 274 MiB unpacked, 287 files, 0 symlinks; download 1035 ms, unpack 917 ms; sha256 `547dcd374e02961bf998f6046a267644f8502225c36bb78ca307dab32a0b3eb4` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 57 ms, warm 51 ms; the port for comparison 49 ms
- start attempts: fdpipe ok 57 ms

### Chrome for Testing · linux-x64 (cft-linux-x64-worker.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 201 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox off (--no-sandbox: every sandboxed start failed)

- install: 121 MiB archive, 274 MiB unpacked, 287 files, 0 symlinks; download 1035 ms, unpack 917 ms; sha256 `547dcd374e02961bf998f6046a267644f8502225c36bb78ca307dab32a0b3eb4` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 48 ms, warm 48 ms; the port for comparison 43 ms
- start attempts: fdpipe failed (fdpipe start failed: browser exited (SIGTRAP) during Browser.getVersion (exit SIGTRAP); stderr: [1105/021329.078819:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:130] No usable sandbox! If you are running o); fdpipe --no-sandbox ok 48 ms
- tabs: own window: first (background): visible, 1280x800, interval 100.0 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x800, interval 100.0 Hz, rAF 60.0 Hz; one window: first (background): visible, 1280x800, interval 100.0 Hz, rAF 60.0 Hz; one window: second (front): visible, 1280x800, interval 100.0 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.2 Hz, rAF 60.0 Hz, media ×0.94, decoded 28.8 fps, audio running, set up in 32 ms, browser answers in 0 ms
- resize to 1000×700 and back: 1 ms / 21 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 205 / 224 ms (650 KiB, CPU 211 ms), jpeg 70 / 73 ms (165 KiB, stale -41 / -37 ms, CPU 55 ms)
- screencast: 60.5 fps, 67094 kbit/s, 135 KiB/frame, latency 28 / 29 ms, browser CPU 97%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 172 MiB, per idle tab 23 MiB, 4 browser contexts +94 MiB, a second bot's browser 114 MiB (6 processes), animated tab 13.9% CPU
  - steps: 0 tabs 172 MiB pss / 0.0%, 1 tabs 207 MiB pss / 1.0%, 2 tabs 230 MiB pss / 2.0%, 4 tabs 272 MiB pss / 4.5%, 8 tabs 357 MiB pss / 6.2%

**chrome** — Chrome/156.0.8078.80; sandbox off (--no-sandbox: every sandboxed start failed)

- install: 192 MiB archive, 403 MiB unpacked, 301 files, 0 symlinks; download 1071 ms, unpack 1271 ms; sha256 `b711c720f774be355197f32edf37e0651418ba036d92446ee2da19ac017540a7` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 191 ms, warm 167 ms; the port for comparison 171 ms
- start attempts: fdpipe failed (fdpipe start failed: browser exited (SIGABRT) during Browser.getVersion (exit SIGABRT); stderr: #16 0x5653e5f4f03a (/home/runner/work/_temp/clover-s7-home/browsers/cft/156.0.8078.80/chrome-linux64/chrome-linux64/chrome+0); fdpipe --no-sandbox ok 191 ms
- tabs: own window: first (background): visible, 1280x657, interval 100.0 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x657, interval 100.2 Hz, rAF 60.0 Hz; one window: first (background): hidden, 1280x657, interval 1.0 Hz, rAF 0.0 Hz; one window: second (front): visible, 1280x657, interval 100.0 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.0 Hz, media ×0.94, decoded 29.0 fps, audio running, set up in 66 ms, browser answers in 0 ms
- resize to 1000×700 and back: 3 ms / 22 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 183 / 193 ms (527 KiB, CPU 180 ms), jpeg 63 / 76 ms (146 KiB, stale -36 / -35 ms, CPU 51 ms)
- screencast: 60.5 fps, 58308 kbit/s, 118 KiB/frame, latency 27 / 28 ms, browser CPU 81%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 412 MiB, per idle tab 55 MiB, 4 browser contexts +314 MiB, a second bot's browser 262 MiB (9 processes), animated tab 15.4% CPU
  - steps: 0 tabs 412 MiB pss / 0.3%, 1 tabs 487 MiB pss / 1.0%, 2 tabs 536 MiB pss / 2.0%, 4 tabs 630 MiB pss / 3.2%, 8 tabs 848 MiB pss / 4.9%

### Chrome for Testing · linux-x64 (cft-linux-x64.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 206 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox off (--no-sandbox: every sandboxed start failed)

- install: 121 MiB archive, 274 MiB unpacked, 287 files, 0 symlinks; download 1035 ms, unpack 917 ms; sha256 `547dcd374e02961bf998f6046a267644f8502225c36bb78ca307dab32a0b3eb4` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 156 ms, warm 30 ms; the port for comparison 39 ms
- start attempts: fdpipe failed (fdpipe start failed: browser exited (SIGTRAP) during Browser.getVersion (exit SIGTRAP); stderr: [1105/021004.977409:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:130] No usable sandbox! If you are running o); fdpipe --no-sandbox ok 156 ms
- tabs: own window: first (background): visible, 1280x800, interval 100.0 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x800, interval 100.0 Hz, rAF 60.0 Hz; one window: first (background): visible, 1280x800, interval 99.9 Hz, rAF 60.0 Hz; one window: second (front): visible, 1280x800, interval 100.0 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.0 Hz, media ×0.95, decoded 29.0 fps, audio running, set up in 119 ms, browser answers in 0 ms
- resize to 1000×700 and back: 1 ms / 22 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 190 / 200 ms (635 KiB, CPU 189 ms), jpeg 54 / 55 ms (165 KiB, stale -40 / -36 ms, CPU 45 ms)
- screencast: 60.4 fps, 67022 kbit/s, 136 KiB/frame, latency 12 / 13 ms, browser CPU 89%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 172 MiB, per idle tab 23 MiB, 4 browser contexts +94 MiB, a second bot's browser 112 MiB (6 processes), animated tab 12.9% CPU
  - steps: 0 tabs 172 MiB pss / 0.3%, 1 tabs 208 MiB pss / 0.8%, 2 tabs 230 MiB pss / 2.0%, 4 tabs 273 MiB pss / 2.7%, 8 tabs 358 MiB pss / 5.5%

**chrome** — Chrome/156.0.8078.80; sandbox off (--no-sandbox: every sandboxed start failed)

- install: 192 MiB archive, 403 MiB unpacked, 301 files, 0 symlinks; download 1071 ms, unpack 1271 ms; sha256 `b711c720f774be355197f32edf37e0651418ba036d92446ee2da19ac017540a7` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 224 ms, warm 161 ms; the port for comparison 179 ms
- start attempts: fdpipe failed (fdpipe start failed: browser exited (SIGABRT) during Browser.getVersion (exit SIGABRT); stderr: #16 0x5623b3fd703a (/home/runner/work/_temp/clover-s7-home/browsers/cft/156.0.8078.80/chrome-linux64/chrome-linux64/chrome+0); fdpipe --no-sandbox ok 224 ms
- tabs: own window: first (background): visible, 1280x657, interval 100.0 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x657, interval 100.0 Hz, rAF 60.0 Hz; one window: first (background): hidden, 1280x657, interval 1.0 Hz, rAF 0.0 Hz; one window: second (front): visible, 1280x657, interval 100.0 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.2 Hz, media ×0.94, decoded 29.0 fps, audio running, set up in 71 ms, browser answers in 0 ms
- resize to 1000×700 and back: 2 ms / 20 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 177 / 206 ms (521 KiB, CPU 186 ms), jpeg 76 / 80 ms (145 KiB, stale -49 / -35 ms, CPU 61 ms)
- screencast: 60.8 fps, 58523 kbit/s, 118 KiB/frame, latency 27 / 28 ms, browser CPU 84%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 435 MiB, per idle tab 52 MiB, 4 browser contexts +309 MiB, a second bot's browser 291 MiB (11 processes), animated tab 21.5% CPU
  - steps: 0 tabs 435 MiB pss / 0.5%, 1 tabs 511 MiB pss / 1.5%, 2 tabs 562 MiB pss / 3.0%, 4 tabs 652 MiB pss / 4.2%, 8 tabs 852 MiB pss / 9.1%

### Chrome for Testing · win32-x64 (cft-windows.json)

10.0.26100, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 246 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 120 MiB archive, 282 MiB unpacked, 288 files, 0 symlinks; download 1142 ms, unpack 2159 ms; sha256 `10a77466005e7f64e00f1a75fd1ea81f4a38a60093c65fea6895843b26e60a9a` (matches the pin; server MD5 true)
- start: over **winpipe**, cold 199 ms, warm 128 ms; the port for comparison 153 ms
- start attempts: winpipe ok 199 ms
- tabs: own window: first (background): visible, 1280x800, interval 100.0 Hz, rAF 60.1 Hz; own window: second (front): visible, 1280x800, interval 100.0 Hz, rAF 60.1 Hz; one window: first (background): visible, 1280x800, interval 100.0 Hz, rAF 59.9 Hz; one window: second (front): visible, 1280x800, interval 100.0 Hz, rAF 59.9 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 99.9 Hz, rAF 60.1 Hz, media ×0.94, decoded 29.2 fps, audio running, set up in 63 ms, browser answers in 6 ms
- resize to 1000×700 and back: 11 ms / 10 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 296 / 322 ms (584 KiB, CPU 451 ms), jpeg 85 / 87 ms (147 KiB, stale -42 / -40 ms, CPU 135 ms)
- screencast: 55.3 fps, 51905 kbit/s, 115 KiB/frame, latency 39 / 45 ms, browser CPU 147%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 67 MiB, per idle tab 29 MiB, 4 browser contexts +120 MiB, a second bot's browser 71 MiB (5 processes), animated tab 43.0% CPU
  - steps: 0 tabs 67 MiB privateBytes / 0.0%, 1 tabs 97 MiB privateBytes / 5.3%, 2 tabs 126 MiB privateBytes / 1.1%, 4 tabs 183 MiB privateBytes / 11.9%, 8 tabs 302 MiB privateBytes / 21.4%

**chrome** — Chrome/156.0.8078.80; sandbox on

- install: 199 MiB archive, 439 MiB unpacked, 305 files, 0 symlinks; download 1283 ms, unpack 3528 ms; sha256 `16edb57d6107bf1c48a7c149b8d78b155fe614410093796dd72441fd6640540f` (matches the pin; server MD5 true)
- start: over **winpipe**, cold 827 ms, warm 444 ms; the port for comparison 493 ms
- start attempts: winpipe ok 827 ms
- tabs: own window: first (background): visible, 1264x649, interval 100.1 Hz, rAF 60.0 Hz; own window: second (front): visible, 1264x649, interval 100.1 Hz, rAF 60.0 Hz; one window: first (background): hidden, 1264x649, interval 1.0 Hz, rAF 0.0 Hz; one window: second (front): visible, 1264x649, interval 100.0 Hz, rAF 60.1 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.1 Hz, rAF 59.9 Hz, media ×0.94, decoded 29.2 fps, audio running, set up in 67 ms, browser answers in 4 ms
- resize to 1000×700 and back: 10 ms / 12 ms, same document true (1264 → 1000 → 1264)
- screenshots: png 243 / 257 ms (453 KiB, CPU 412 ms), jpeg 83 / 88 ms (105 KiB, stale -47 / -35 ms, CPU 131 ms)
- screencast: 60.1 fps, 47331 kbit/s, 96 KiB/frame, latency 38 / 42 ms, browser CPU 125%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 264 MiB, per idle tab 55 MiB, 4 browser contexts +480 MiB, a second bot's browser 257 MiB (11 processes), animated tab 40.1% CPU
  - steps: 0 tabs 264 MiB privateBytes / 1.4%, 1 tabs 342 MiB privateBytes / 4.2%, 2 tabs 398 MiB privateBytes / 5.3%, 4 tabs 450 MiB privateBytes / 11.9%, 8 tabs 701 MiB privateBytes / 15.4%

