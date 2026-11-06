## Spike S7 results

### Chrome for Testing · linux-arm64 (cft-linux-arm64-apparmor.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 0 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 121 MiB archive, 277 MiB unpacked, 287 files, 0 symlinks; download 682 ms, unpack 990 ms; sha256 `5bb6a00a4285c13303d3f72c5afdb70f144ea7a93eed462365a52b69631c9607` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 65 ms, warm 71 ms; the port for comparison 66 ms
- start attempts: fdpipe ok 65 ms

### Chrome for Testing · linux-arm64 (cft-linux-arm64-worker.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 204 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox off (--no-sandbox: every sandboxed start failed)

- install: 121 MiB archive, 277 MiB unpacked, 287 files, 0 symlinks; download 682 ms, unpack 990 ms; sha256 `5bb6a00a4285c13303d3f72c5afdb70f144ea7a93eed462365a52b69631c9607` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 54 ms, warm 61 ms; the port for comparison 40 ms
- start attempts: fdpipe failed (fdpipe start failed: browser exited (SIGTRAP) during Browser.getVersion (exit SIGTRAP); stderr: [1105/022626.108134:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:130] No usable sandbox! If you are running o); fdpipe --no-sandbox ok 54 ms
- tabs: own window: first (background): visible, 1280x800, interval 100.1 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x800, interval 100.0 Hz, rAF 60.0 Hz; one window: first (background): visible, 1280x800, interval 99.9 Hz, rAF 60.0 Hz; one window: second (front): visible, 1280x800, interval 100.0 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.2 Hz, media ×0.94, decoded 28.8 fps, audio running, set up in 44 ms, browser answers in 0 ms
- resize to 1000×700 and back: 6 ms / 23 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 217 / 233 ms (645 KiB, CPU 344 ms), jpeg 80 / 84 ms (165 KiB, stale -48 / -39 ms, CPU 148 ms)
- screencast: 60.4 fps, 66805 kbit/s, 135 KiB/frame, latency 33 / 37 ms, browser CPU 157%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 175 MiB, per idle tab 23 MiB, 4 browser contexts +95 MiB, a second bot's browser 112 MiB (6 processes), animated tab 55.6% CPU
  - steps: 0 tabs 175 MiB pss / 0.0%, 1 tabs 210 MiB pss / 2.7%, 2 tabs 234 MiB pss / 4.7%, 4 tabs 276 MiB pss / 10.2%, 8 tabs 361 MiB pss / 19.4%

**chrome** — Chrome/156.0.8078.80; sandbox off (--no-sandbox: every sandboxed start failed)

- install: 191 MiB archive, 401 MiB unpacked, 301 files, 0 symlinks; download 934 ms, unpack 1376 ms; sha256 `1f496a826c9ba4d6a5f5bf2de686145fe718528c2cc3dbeb96b5893b89653724` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 241 ms, warm 234 ms; the port for comparison 245 ms
- start attempts: fdpipe failed (fdpipe start failed: browser exited (SIGABRT) during Browser.getVersion (exit SIGABRT); stderr: #10 0xab4b1b739138 (/home/runner/work/_temp/clover-s7-home/browsers/cft/156.0.8078.80/chrome-linux-arm64/chrome-linux-arm64/); fdpipe --no-sandbox ok 241 ms
- tabs: own window: first (background): visible, 1280x657, interval 100.1 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x657, interval 100.0 Hz, rAF 60.0 Hz; one window: first (background): hidden, 1280x657, interval 1.0 Hz, rAF 0.0 Hz; one window: second (front): visible, 1280x657, interval 99.9 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.2 Hz, rAF 60.0 Hz, media ×0.95, decoded 28.8 fps, audio running, set up in 67 ms, browser answers in 0 ms
- resize to 1000×700 and back: 4 ms / 24 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 189 / 198 ms (532 KiB, CPU 314 ms), jpeg 72 / 73 ms (145 KiB, stale -40 / -37 ms, CPU 144 ms)
- screencast: 60.4 fps, 58199 kbit/s, 118 KiB/frame, latency 32 / 33 ms, browser CPU 143%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 424 MiB, per idle tab 55 MiB, 4 browser contexts +302 MiB, a second bot's browser 303 MiB (9 processes), animated tab 59.3% CPU
  - steps: 0 tabs 424 MiB pss / 1.7%, 1 tabs 496 MiB pss / 2.5%, 2 tabs 567 MiB pss / 5.2%, 4 tabs 632 MiB pss / 11.4%, 8 tabs 867 MiB pss / 21.5%

### Chrome for Testing · linux-arm64 (cft-linux-arm64.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 209 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox off (--no-sandbox: every sandboxed start failed)

- install: 121 MiB archive, 277 MiB unpacked, 287 files, 0 symlinks; download 682 ms, unpack 990 ms; sha256 `5bb6a00a4285c13303d3f72c5afdb70f144ea7a93eed462365a52b69631c9607` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 143 ms, warm 59 ms; the port for comparison 50 ms
- start attempts: fdpipe failed (fdpipe start failed: browser exited (SIGTRAP) during Browser.getVersion (exit SIGTRAP); stderr: [1105/022259.159015:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:130] No usable sandbox! If you are running o); fdpipe --no-sandbox ok 143 ms
- tabs: own window: first (background): visible, 1280x800, interval 99.9 Hz, rAF 60.2 Hz; own window: second (front): visible, 1280x800, interval 99.9 Hz, rAF 60.2 Hz; one window: first (background): visible, 1280x800, interval 100.1 Hz, rAF 60.2 Hz; one window: second (front): visible, 1280x800, interval 100.0 Hz, rAF 60.2 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.2 Hz, rAF 60.2 Hz, media ×0.95, decoded 29.0 fps, audio running, set up in 103 ms, browser answers in 0 ms
- resize to 1000×700 and back: 2 ms / 23 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 216 / 229 ms (644 KiB, CPU 343 ms), jpeg 80 / 84 ms (163 KiB, stale -49 / -38 ms, CPU 148 ms)
- screencast: 60.4 fps, 66395 kbit/s, 134 KiB/frame, latency 33 / 37 ms, browser CPU 154%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 179 MiB, per idle tab 23 MiB, 4 browser contexts +95 MiB, a second bot's browser 112 MiB (6 processes), animated tab 54.1% CPU
  - steps: 0 tabs 179 MiB pss / 0.0%, 1 tabs 215 MiB pss / 2.2%, 2 tabs 238 MiB pss / 4.7%, 4 tabs 280 MiB pss / 9.7%, 8 tabs 365 MiB pss / 19.1%

**chrome** — Chrome/156.0.8078.80; sandbox off (--no-sandbox: every sandboxed start failed)

- install: 191 MiB archive, 401 MiB unpacked, 301 files, 0 symlinks; download 934 ms, unpack 1376 ms; sha256 `1f496a826c9ba4d6a5f5bf2de686145fe718528c2cc3dbeb96b5893b89653724` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 282 ms, warm 220 ms; the port for comparison 255 ms
- start attempts: fdpipe failed (fdpipe start failed: browser exited (SIGABRT) during Browser.getVersion (exit SIGABRT); stderr: #10 0xaaf743c09138 (/home/runner/work/_temp/clover-s7-home/browsers/cft/156.0.8078.80/chrome-linux-arm64/chrome-linux-arm64/); fdpipe --no-sandbox ok 282 ms
- tabs: own window: first (background): visible, 1280x657, interval 99.9 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x657, interval 100.0 Hz, rAF 60.0 Hz; one window: first (background): hidden, 1280x657, interval 1.8 Hz, rAF 0.0 Hz; one window: second (front): visible, 1280x657, interval 99.9 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.0 Hz, media ×0.95, decoded 28.8 fps, audio running, set up in 62 ms, browser answers in 0 ms
- resize to 1000×700 and back: 5 ms / 23 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 195 / 205 ms (531 KiB, CPU 313 ms), jpeg 72 / 87 ms (144 KiB, stale -39 / -34 ms, CPU 146 ms)
- screencast: 60.5 fps, 58183 kbit/s, 117 KiB/frame, latency 32 / 33 ms, browser CPU 138%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 455 MiB, per idle tab 48 MiB, 4 browser contexts +311 MiB, a second bot's browser 288 MiB (11 processes), animated tab 60.7% CPU
  - steps: 0 tabs 455 MiB pss / 1.0%, 1 tabs 526 MiB pss / 3.0%, 2 tabs 599 MiB pss / 5.0%, 4 tabs 664 MiB pss / 10.7%, 8 tabs 843 MiB pss / 21.3%

### Chrome for Testing · linux-x64 (cft-linux-x64-apparmor.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 0 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 121 MiB archive, 274 MiB unpacked, 287 files, 0 symlinks; download 499 ms, unpack 1079 ms; sha256 `547dcd374e02961bf998f6046a267644f8502225c36bb78ca307dab32a0b3eb4` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 74 ms, warm 68 ms; the port for comparison 64 ms
- start attempts: fdpipe ok 74 ms

### Chrome for Testing · linux-x64 (cft-linux-x64-worker.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 203 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox off (--no-sandbox: every sandboxed start failed)

- install: 121 MiB archive, 274 MiB unpacked, 287 files, 0 symlinks; download 499 ms, unpack 1079 ms; sha256 `547dcd374e02961bf998f6046a267644f8502225c36bb78ca307dab32a0b3eb4` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 67 ms, warm 74 ms; the port for comparison 41 ms
- start attempts: fdpipe failed (fdpipe start failed: browser exited (SIGTRAP) during Browser.getVersion (exit SIGTRAP); stderr: [1105/022625.811979:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:130] No usable sandbox! If you are running o); fdpipe --no-sandbox ok 67 ms
- tabs: own window: first (background): visible, 1280x800, interval 100.0 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x800, interval 100.2 Hz, rAF 60.2 Hz; one window: first (background): visible, 1280x800, interval 99.9 Hz, rAF 60.1 Hz; one window: second (front): visible, 1280x800, interval 100.0 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.0 Hz, media ×0.94, decoded 28.8 fps, audio running, set up in 45 ms, browser answers in 0 ms
- resize to 1000×700 and back: 2 ms / 21 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 244 / 261 ms (651 KiB, CPU 285 ms), jpeg 79 / 83 ms (163 KiB, stale -45 / -38 ms, CPU 80 ms)
- screencast: 60.4 fps, 66482 kbit/s, 134 KiB/frame, latency 32 / 35 ms, browser CPU 125%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 171 MiB, per idle tab 23 MiB, 4 browser contexts +95 MiB, a second bot's browser 113 MiB (6 processes), animated tab 27.4% CPU
  - steps: 0 tabs 171 MiB pss / 0.0%, 1 tabs 207 MiB pss / 2.2%, 2 tabs 230 MiB pss / 5.0%, 4 tabs 273 MiB pss / 8.2%, 8 tabs 358 MiB pss / 11.4%

**chrome** — Chrome/156.0.8078.80; sandbox off (--no-sandbox: every sandboxed start failed)

- install: 192 MiB archive, 403 MiB unpacked, 301 files, 0 symlinks; download 599 ms, unpack 1514 ms; sha256 `b711c720f774be355197f32edf37e0651418ba036d92446ee2da19ac017540a7` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 230 ms, warm 217 ms; the port for comparison 216 ms
- start attempts: fdpipe failed (fdpipe start failed: browser exited (SIGABRT) during Browser.getVersion (exit SIGABRT); stderr: #16 0x5613e69b203a (/home/runner/work/_temp/clover-s7-home/browsers/cft/156.0.8078.80/chrome-linux64/chrome-linux64/chrome+0); fdpipe --no-sandbox ok 230 ms
- tabs: own window: first (background): visible, 1280x657, interval 99.9 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x657, interval 100.1 Hz, rAF 60.0 Hz; one window: first (background): hidden, 1280x657, interval 1.8 Hz, rAF 0.0 Hz; one window: second (front): visible, 1280x657, interval 99.9 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.0 Hz, media ×0.95, decoded 28.8 fps, audio running, set up in 66 ms, browser answers in 0 ms
- resize to 1000×700 and back: 2 ms / 22 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 215 / 226 ms (525 KiB, CPU 273 ms), jpeg 71 / 74 ms (144 KiB, stale -40 / -34 ms, CPU 88 ms)
- screencast: 60.6 fps, 58313 kbit/s, 117 KiB/frame, latency 30 / 32 ms, browser CPU 112%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 412 MiB, per idle tab 55 MiB, 4 browser contexts +306 MiB, a second bot's browser 256 MiB (9 processes), animated tab 33.3% CPU
  - steps: 0 tabs 412 MiB pss / 1.0%, 1 tabs 488 MiB pss / 3.2%, 2 tabs 539 MiB pss / 5.2%, 4 tabs 624 MiB pss / 8.4%, 8 tabs 849 MiB pss / 14.3%

### Chrome for Testing · linux-x64 (cft-linux-x64.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 208 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox off (--no-sandbox: every sandboxed start failed)

- install: 121 MiB archive, 274 MiB unpacked, 287 files, 0 symlinks; download 499 ms, unpack 1079 ms; sha256 `547dcd374e02961bf998f6046a267644f8502225c36bb78ca307dab32a0b3eb4` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 201 ms, warm 38 ms; the port for comparison 46 ms
- start attempts: fdpipe failed (fdpipe start failed: browser exited (SIGTRAP) during Browser.getVersion (exit SIGTRAP); stderr: [1105/022259.071479:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:130] No usable sandbox! If you are running o); fdpipe --no-sandbox ok 201 ms
- tabs: own window: first (background): visible, 1280x800, interval 100.0 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x800, interval 100.0 Hz, rAF 60.0 Hz; one window: first (background): visible, 1280x800, interval 100.0 Hz, rAF 60.0 Hz; one window: second (front): visible, 1280x800, interval 100.2 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.0 Hz, media ×0.93, decoded 29.0 fps, audio running, set up in 277 ms, browser answers in 0 ms
- resize to 1000×700 and back: 3 ms / 24 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 245 / 261 ms (637 KiB, CPU 275 ms), jpeg 79 / 81 ms (163 KiB, stale -46 / -34 ms, CPU 74 ms)
- screencast: 60.4 fps, 66521 kbit/s, 134 KiB/frame, latency 31 / 33 ms, browser CPU 123%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 171 MiB, per idle tab 23 MiB, 4 browser contexts +94 MiB, a second bot's browser 113 MiB (6 processes), animated tab 23.6% CPU
  - steps: 0 tabs 171 MiB pss / 0.0%, 1 tabs 206 MiB pss / 2.2%, 2 tabs 229 MiB pss / 4.0%, 4 tabs 271 MiB pss / 6.2%, 8 tabs 356 MiB pss / 10.4%

**chrome** — Chrome/156.0.8078.80; sandbox off (--no-sandbox: every sandboxed start failed)

- install: 192 MiB archive, 403 MiB unpacked, 301 files, 0 symlinks; download 599 ms, unpack 1514 ms; sha256 `b711c720f774be355197f32edf37e0651418ba036d92446ee2da19ac017540a7` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 361 ms, warm 193 ms; the port for comparison 221 ms
- start attempts: fdpipe failed (fdpipe start failed: browser exited (SIGABRT) during Browser.getVersion (exit SIGABRT); stderr: #16 0x559fe2f8503a (/home/runner/work/_temp/clover-s7-home/browsers/cft/156.0.8078.80/chrome-linux64/chrome-linux64/chrome+0); fdpipe --no-sandbox ok 361 ms
- tabs: own window: first (background): visible, 1280x657, interval 100.2 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x657, interval 100.0 Hz, rAF 60.0 Hz; one window: first (background): hidden, 1280x657, interval 1.0 Hz, rAF 0.0 Hz; one window: second (front): visible, 1280x657, interval 99.9 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.0 Hz, media ×0.94, decoded 29.0 fps, audio running, set up in 76 ms, browser answers in 0 ms
- resize to 1000×700 and back: 1 ms / 21 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 213 / 235 ms (529 KiB, CPU 264 ms), jpeg 72 / 79 ms (145 KiB, stale -42 / -37 ms, CPU 86 ms)
- screencast: 60.6 fps, 58214 kbit/s, 117 KiB/frame, latency 30 / 32 ms, browser CPU 110%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 437 MiB, per idle tab 52 MiB, 4 browser contexts +320 MiB, a second bot's browser 285 MiB (11 processes), animated tab 32.3% CPU
  - steps: 0 tabs 437 MiB pss / 1.0%, 1 tabs 513 MiB pss / 2.2%, 2 tabs 571 MiB pss / 5.2%, 4 tabs 660 MiB pss / 6.9%, 8 tabs 856 MiB pss / 13.3%

### Chrome for Testing · darwin-arm64 (cft-macos.json)

25.6.0, 3 CPUs, 7 GiB, Bun 1.3.14, status **done**, 255 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 99 MiB archive, 204 MiB unpacked, 16 files, 0 symlinks; download 1295 ms, unpack 2225 ms; sha256 `ea615baa2e9caf0d02d1898a6562b5f8fa9c35239707dae0f592178df5b986ac` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 590 ms, warm 162 ms; the port for comparison 141 ms
- start attempts: fdpipe ok 590 ms
- tabs: own window: first (background): visible, 1280x800, interval 72.7 Hz, rAF 48.4 Hz; own window: second (front): visible, 1280x800, interval 71.0 Hz, rAF 44.2 Hz; one window: first (background): visible, 1280x800, interval 60.9 Hz, rAF 32.5 Hz; one window: second (front): visible, 1280x800, interval 61.5 Hz, rAF 34.2 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 44.4 Hz, rAF 21.5 Hz, media ×0.94, decoded 29.9 fps, audio running, set up in 596 ms, browser answers in 0 ms
- resize to 1000×700 and back: 12 ms / 26 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 284 / 372 ms (620 KiB, CPU 358 ms), jpeg 125 / 208 ms (130 KiB, stale -82 / -43 ms, CPU 120 ms)
- screencast: 42.8 fps, 40917 kbit/s, 117 KiB/frame, latency 46 / 90 ms, browser CPU 97%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 45 MiB, per idle tab 33 MiB, 4 browser contexts +132 MiB, a second bot's browser 44 MiB (4 processes), animated tab 35.6% CPU
  - steps: 0 tabs 45 MiB footprint / 1.5%, 1 tabs 79 MiB footprint / 2.7%, 2 tabs 112 MiB footprint / 5.9%, 4 tabs 178 MiB footprint / 9.8%, 8 tabs 311 MiB footprint / 17.7%

**chrome** — Chrome/156.0.8078.80; sandbox on

- install: 186 MiB archive, 366 MiB unpacked, 344 files, 5 symlinks; download 1795 ms, unpack 2381 ms; sha256 `8bc590d1b1acac042a000234c768f31830f25a3983a83ed5e067114c87c4cad1` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 2751 ms, warm 1143 ms; the port for comparison 1334 ms
- start attempts: fdpipe ok 2751 ms
- tabs: own window: first (background): visible, 1280x657, interval 45.5 Hz, rAF 25.5 Hz; own window: second (front): hidden, 1280x657, interval 1.0 Hz, rAF 0.0 Hz; one window: first (background): hidden, 1280x657, interval 1.0 Hz, rAF 0.0 Hz; one window: second (front): visible, 1280x657, interval 36.3 Hz, rAF 16.5 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 46.9 Hz, rAF 14.8 Hz, media ×0.96, decoded 29.1 fps, audio running, set up in 544 ms, browser answers in 0 ms
- resize to 1000×700 and back: 12 ms / 25 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 354 / 460 ms (484 KiB, CPU 224 ms), jpeg 356 / 929 ms (121 KiB, stale -171 / -118 ms, CPU 101 ms)
- screencast: 21.1 fps, 17358 kbit/s, 100 KiB/frame, latency 135 / 199 ms, browser CPU 34%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 266 MiB, per idle tab 53 MiB, 4 browser contexts +481 MiB, a second bot's browser 254 MiB (9 processes), animated tab 20.3% CPU
  - steps: 0 tabs 266 MiB footprint / 5.7%, 1 tabs 359 MiB footprint / 5.4%, 2 tabs 412 MiB footprint / 5.2%, 4 tabs 502 MiB footprint / 8.9%, 8 tabs 687 MiB footprint / 9.1%

### Chrome for Testing · win32-x64 (cft-windows.json)

10.0.26100, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 248 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 120 MiB archive, 282 MiB unpacked, 288 files, 0 symlinks; download 1647 ms, unpack 2392 ms; sha256 `10a77466005e7f64e00f1a75fd1ea81f4a38a60093c65fea6895843b26e60a9a` (matches the pin; server MD5 true)
- start: over **winpipe**, cold 284 ms, warm 113 ms; the port for comparison 138 ms
- start attempts: winpipe ok 284 ms
- tabs: own window: first (background): visible, 1280x800, interval 100.0 Hz, rAF 60.1 Hz; own window: second (front): visible, 1280x800, interval 100.0 Hz, rAF 60.1 Hz; one window: first (background): visible, 1280x800, interval 100.0 Hz, rAF 60.1 Hz; one window: second (front): visible, 1280x800, interval 100.0 Hz, rAF 60.1 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 99.9 Hz, rAF 60.1 Hz, media ×0.99, decoded 29.2 fps, audio running, set up in 62 ms, browser answers in 4 ms
- resize to 1000×700 and back: 10 ms / 13 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 293 / 307 ms (584 KiB, CPU 477 ms), jpeg 82 / 89 ms (151 KiB, stale -41 / -34 ms, CPU 145 ms)
- screencast: 55.9 fps, 52428 kbit/s, 115 KiB/frame, latency 40 / 47 ms, browser CPU 157%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 68 MiB, per idle tab 29 MiB, 4 browser contexts +114 MiB, a second bot's browser 68 MiB (5 processes), animated tab 41.6% CPU
  - steps: 0 tabs 68 MiB privateBytes / 0.0%, 1 tabs 98 MiB privateBytes / 4.2%, 2 tabs 127 MiB privateBytes / 3.9%, 4 tabs 186 MiB privateBytes / 8.8%, 8 tabs 304 MiB privateBytes / 16.4%

**chrome** — Chrome/156.0.8078.80; sandbox on

- install: 199 MiB archive, 439 MiB unpacked, 305 files, 0 symlinks; download 1320 ms, unpack 3375 ms; sha256 `16edb57d6107bf1c48a7c149b8d78b155fe614410093796dd72441fd6640540f` (matches the pin; server MD5 true)
- start: over **winpipe**, cold 847 ms, warm 441 ms; the port for comparison 475 ms
- start attempts: winpipe ok 847 ms
- tabs: own window: first (background): visible, 1264x649, interval 99.9 Hz, rAF 60.0 Hz; own window: second (front): visible, 1264x649, interval 100.0 Hz, rAF 60.1 Hz; one window: first (background): hidden, 1264x649, interval 1.2 Hz, rAF 0.0 Hz; one window: second (front): visible, 1264x649, interval 99.9 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 59.9 Hz, media ×0.99, decoded 29.1 fps, audio running, set up in 60 ms, browser answers in 5 ms
- resize to 1000×700 and back: 8 ms / 36 ms, same document true (1264 → 1000 → 1264)
- screenshots: png 256 / 302 ms (459 KiB, CPU 443 ms), jpeg 92 / 104 ms (105 KiB, stale -39 / -32 ms, CPU 145 ms)
- screencast: 60.3 fps, 47267 kbit/s, 96 KiB/frame, latency 54 / 60 ms, browser CPU 130%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 259 MiB, per idle tab 49 MiB, 4 browser contexts +475 MiB, a second bot's browser 271 MiB (12 processes), animated tab 41.9% CPU
  - steps: 0 tabs 259 MiB privateBytes / 1.4%, 1 tabs 343 MiB privateBytes / 4.6%, 2 tabs 398 MiB privateBytes / 7.4%, 4 tabs 453 MiB privateBytes / 18.6%, 8 tabs 651 MiB privateBytes / 25.8%

### Electron · linux-arm64-ozone-headless (electron-linux-arm64-ozone-headless.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-arm64 7.0.0-1017-azure, ozone headless, displays 1920x1080@1, status **done**, 459 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.90 | 27.4 | 27 / 75 | 1 / 6 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.95 | 28.4 | 27 / 30 | 4 / 18 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.4 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.95 | 28.4 | 27 / 31 | 13 / 17 | 1280x800@1 → 1000x700@1 → 1280x800 | 0 / 1 | 2.3 |  |
| invisibleWindow | true | true | true | true (1) | 0.96 | 28.6 | 25 / 27 | 13 / 16 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.2 |  |
| tinyWindow | true | true | true | true (1) | 0.97 | 28.6 | 12 / 23 | 1 / 14 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.1 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 100.0 | 99.2 | 60.0 | 17 | – | – | – | 4.6 | 6.2 |  |
| detached, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | – | – | – | 0.4 | 0.8 |  |
| detached, throttling off | visible | 1280x800 | 100.1 | 99.1 | 0.0 | 0 | – | – | – | 0.8 | 0.8 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | – | – | – | 0.0 | 0.0 |  |
| never-shown window, throttling off | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | – | – | – | 0.8 | 0.8 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 99.9 | 99.3 | 1.0 | 1017 | – | – | – | 1.4 | 1.6 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 100.1 | 99.3 | 0.0 | 0 | – | – | 0.0 | 1.0 | 1.2 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | – | – | 0.0 | 1.0 | 1.0 |  |
| invisible shown window, throttling off | visible | 1280x800 | 100.2 | 99.2 | 60.0 | 17 | – | – | – | 4.6 | 6.4 |  |
| 1x1 shown window, throttling off | visible | 1280x800 | 100.0 | 99.4 | 60.0 | 17 | – | – | – | 4.8 | 6.2 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 100.1 | 99.3 | 60.2 | 17 | – | – | – | 5.2 | 6.8 | cover 0,0 1920x1080 over host 0,0 1x1 |
| 1x1 shown window, always on top, under a cover | visible | 1280x800 | 100.0 | 99.2 | 60.2 | 17 | – | – | – | 4.8 | 6.2 | cover 0,0 1920x1080 over host 0,0 1x1 |
| invisible shown window, covered by another window | visible | 1280x800 | 100.0 | 99.4 | 60.0 | 17 | – | – | – | 4.8 | 6.4 | cover -1480,-1000 1920x1080 over host -1480,-1000 1280x800 |
| osr window 30 fps, throttling off | visible | 1280x800 | 100.2 | 99.2 | 30.0 | 34 | – | – | – | 3.6 | 12.4 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 100.1 | 99.1 | 30.0 | 37 | – | – | – | 2.0 | 2.2 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 99.9 | 99.3 | 0.0 | 0 | 0.85 | 24.8 | – | 2.8 | 3.4 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 99.9 | 99.3 | 0.0 | 0 | 0.85 | 25.8 | – | 2.4 | 3.4 |  |
| detached, throttling off, playing media | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.85 | 24.8 | – | 2.4 | 3.2 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 99.9 | 99.3 | 0.0 | 0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | CPU ms/picture | frames/s | visibility events | errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 15 / 16 | 7 / 12 | 1000x700 | 60 | – |  |  |
| shown | true | capturePage | 6/6 | 6 | 15 / 16 | 7 / 9 | 1000x700 | 57 | – |  |  |
| shown | true | cdpJpeg | 6/6 | 6 | 81 / 82 | -50 / -35 | 1000x700 | 92 | – |  |  |
| shown | true | frameSub | 6/6 | 6 | 15 / 19 | 9 / 9 | 1000x700 | 52 | – |  |  |
| shown | true | cdpPng | 6/6 | 6 | 178 / 184 | -47 / -40 | 1000x700 | 230 | – |  |  |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | 3 | – |  | Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | 65 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | 55 | – |  | frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 4047 / 4049 | -2994 / -45 | 1280x800 | 138 | – |  |  |
| hiddenWindow | false | frameSub | 6/6 | 6 | 7 / 8 | 60 / 75 | 1280x800 | 47 | – |  |  |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.5 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | 3 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 98 / 99 | -62 / -28 | 1280x800 | 150 | – |  |  |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 15 / 16 | 8 / 9 | 1280x800 | 85 | – |  |  |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 6/6 | 6 | 15 / 17 | 9 / 10 | 1280x800 | 73 | – |  |  |
| invisibleWindow | false | capturePage | 6/6 | 6 | 14 / 16 | 9 / 13 | 1280x800 | 72 | – |  |  |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 80 / 87 | -45 / -39 | 1280x800 | 125 | – |  |  |
| invisibleWindow | false | frameSub | 6/6 | 6 | 15 / 19 | 12 / 12 | 1280x800 | 70 | – |  |  |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 14 / 15 | 9 / 13 | 1280x800 | 63 | – |  |  |
| tinyWindow | false | capturePage | 6/6 | 6 | 14 / 15 | 9 / 11 | 1280x800 | 63 | – |  |  |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 80 / 87 | -45 / -40 | 1280x800 | 105 | – |  |  |
| tinyWindow | false | frameSub | 6/6 | 6 | 15 / 19 | 11 / 12 | 1280x800 | 60 | – |  |  |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 14 / 16 | 10 / 15 | 1280x800 | 60 | – |  |  |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 15 / 16 | 11 / 13 | 1280x800 | 65 | – |  |  |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 80 / 85 | -44 / -38 | 1280x800 | 103 | – |  |  |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 15 / 18 | 11 / 12 | 1280x800 | 63 | – |  |  |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 13 / 41 | 1280x800 | 33 | – |  |  |
| osr | false | capturePage | 6/6 | 6 | 31 / 32 | -19 / -12 | 1280x800 | 55 | – |  |  |
| osr | false | cdpJpeg | 6/6 | 6 | 97 / 110 | -73 / -70 | 1280x800 | 100 | – |  |  |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | 157 | – |  | no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | 3 | – |  | empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | 130 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 235 | pss | 504 | 4 | 0.0 |
| 1 | 262 | pss | 607 | 5 | 0.0 |
| 2 | 277 | pss | 713 | 6 | 0.0 |
| 4 | 305 | pss | 923 | 8 | 0.8 |
| 8 | 359 | pss | 1345 | 12 | 0.3 |

Per idle hidden tab: **15 MiB**, 0.03% CPU. Four tabs: one partition +65 MiB, four partitions +68 MiB.

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 37.0 | 29.2 | 7.5 | 60 |
| animated, never-shown window, throttling off | 1.0 | 1.0 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.3 | 0.0 | 0.0 | 0 |
| animated, never-shown window, throttling off + frame pump | 1.3 | 1.0 | 0.0 | 0 |
| animated, invisible shown window | 47.2 | 37.2 | 10.0 | 60 |
| animated, 1x1 shown window | 38.2 | 36.7 | 1.5 | 60 |
| animated, osr 30 fps | 33.0 | 20.0 | 5.8 | 30 |

### Electron · linux-wayland (electron-linux-wayland.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone wayland, displays 1920x1080@1, status **done**, 730 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.91 | 27.7 | 32 / 163 | 1 / 144 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.92 | 27.4 | 33 / 35 | 1 / 2 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.92 | 27.5 | 23 / 32 | 1 / 2 | 1280x800@1 → 1000x700@1 → 1280x800 | 1 / 2 | 0.0 |  |
| tinyWindow | true | true | true | true (1) | 0.96 | 28.6 | 25 / 32 | 12 / 18 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 40.5 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 99.9 | 99.1 | 39.8 | 26 | – | – | – | 4.0 | 7.4 |  |
| detached, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | – | – | – | 0.0 | 0.4 |  |
| detached, throttling off | visible | 1280x800 | 100.0 | 99.4 | 0.0 | 0 | – | – | – | 1.0 | 1.2 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | – | – | – | 0.0 | 0.2 |  |
| never-shown window, throttling off | visible | 1280x800 | 100.1 | 98.9 | 0.0 | 0 | – | – | – | 1.0 | 1.2 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | – | – | – | 1.2 | 1.6 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | – | – | 0.0 | 1.0 | 1.2 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 100.1 | 99.1 | 0.0 | 0 | – | – | 0.0 | 1.0 | 1.4 |  |
| invisible shown window, throttling off | – | – | – | – | – | – | – | – | – | – | – | not possible here |
| 1x1 shown window, throttling off | visible | 1280x800 | 100.1 | 99.1 | 39.8 | 26 | – | – | – | 3.4 | 5.8 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 100.2 | 99.2 | 39.8 | 26 | – | – | – | 4.0 | 6.8 | cover -10,-10 1940x1100 over host 0,0 1x1 |
| 1x1 shown window, always on top, under a cover | visible | 1280x800 | 100.0 | 99.2 | 39.8 | 26 | – | – | – | 3.4 | 6.2 | cover -10,-10 1940x1100 over host 0,0 1x1 |
| invisible shown window, covered by another window | – | – | – | – | – | – | – | – | – | – | – | not possible here |
| osr window 30 fps, throttling off | visible | 1280x800 | 100.2 | 99.2 | 30.0 | 34 | – | – | – | 3.2 | 14.2 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 100.2 | 99.2 | 30.0 | 34 | – | – | – | 2.2 | 3.0 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | 0.85 | 25.8 | – | 2.4 | 3.2 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.85 | 26.0 | – | 2.2 | 3.2 |  |
| detached, throttling off, playing media | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.85 | 26.0 | – | 2.6 | 4.0 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | CPU ms/picture | frames/s | visibility events | errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 26 / 28 | 31 / 51 | 1000x700 | 48 | – |  |  |
| shown | true | capturePage | 6/6 | 6 | 26 / 28 | 31 / 34 | 1000x700 | 38 | – |  |  |
| shown | true | cdpJpeg | 6/6 | 6 | 130 / 140 | -60 / -59 | 1000x700 | 77 | – |  |  |
| shown | true | frameSub | 6/6 | 6 | 27 / 28 | 34 / 46 | 1000x700 | 37 | – |  |  |
| shown | true | cdpPng | 6/6 | 6 | 262 / 268 | -66 / -64 | 1000x700 | 210 | – |  |  |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | 90 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | 70 | – |  | frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 0/2 | 0 | – | – | - | 75 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| hiddenWindow | false | frameSub | 0/2 | 0 | – | – | - | 80 | – |  | frame subscription: timed out after 5000 ms |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | 3 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 0/2 | 0 | – | – | - | 90 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| hiddenWindow + pump | false | frameSub | 0/2 | 0 | – | – | - | 80 | – |  | frame subscription: timed out after 5000 ms |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| invisibleWindow | false | - | 0/0 | 0 | – | – | - | – | – |  | not possible here |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 22 / 24 | 38 / 38 | 1280x800 | 45 | – |  |  |
| tinyWindow | false | capturePage | 6/6 | 6 | 22 / 24 | 37 / 39 | 1280x800 | 50 | – |  |  |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 148 / 151 | -73 / -62 | 1280x800 | 85 | – |  |  |
| tinyWindow | false | frameSub | 6/6 | 6 | 24 / 33 | 40 / 41 | 1280x800 | 48 | – |  |  |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.5 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 22 / 24 | 37 / 48 | 1280x800 | 48 | – |  |  |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 23 / 24 | 37 / 40 | 1280x800 | 43 | – |  |  |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 148 / 150 | -73 / -61 | 1280x800 | 92 | – |  |  |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 23 / 34 | 41 / 42 | 1280x800 | 45 | – |  |  |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.5 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 31 / 38 | 1280x800 | 28 | – |  |  |
| osr | false | capturePage | 6/6 | 6 | 31 / 39 | -17 / -16 | 1280x800 | 55 | – |  |  |
| osr | false | cdpJpeg | 6/6 | 6 | 99 / 129 | -70 / -68 | 1280x800 | 88 | – |  |  |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | 185 | – |  | no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | 8 | – |  | empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | 155 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 325 | pss | 595 | 4 | 0.3 |
| 1 | 352 | pss | 698 | 5 | 0.5 |
| 2 | 367 | pss | 805 | 6 | 0.0 |
| 4 | 395 | pss | 1018 | 8 | 0.0 |
| 8 | 448 | pss | 1445 | 12 | 1.5 |

Per idle hidden tab: **15 MiB**, 0.16% CPU. Four tabs: one partition +66 MiB, four partitions +69 MiB.

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 20.5 | 13.5 | 6.0 | 39 |
| animated, never-shown window, throttling off | 1.0 | 1.0 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.3 | 0.0 | 0.3 | 0 |
| animated, never-shown window, throttling off + frame pump | 1.0 | 0.8 | 0.3 | 0 |
| animated, 1x1 shown window | 17.3 | 15.0 | 1.5 | 40 |
| animated, osr 30 fps | 25.3 | 12.3 | 4.3 | 30 |

**Q6 streamed view** (10 s at the viewer; latency p50 / p95 ms)

| road | content | source | fps | decoded fps | latency | gap p95 | kbit/s | bytes/frame | sender CPU % | viewer CPU % | source rAF | notes |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| screencast | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | 0 |  |
| capturePoll | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | 0 | toJPEG 0.0 ms |
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
| screencast | anim | tinyWindow | 39.8 | 39.8 | 73 / 74 | 27 | 43948 | 137681 | 103 | 26 | 40 |  |
| webcodecs-h264 | anim | tinyWindow | 30.1 | 30.1 | 68 / 70 | 53 | 2375 | 9862 | 83 | 18 | 40 |  |
| screencast | anim | shown | 38.7 | 38.7 | 70 / 71 | 27 | 35386 | 114593 | 81 | 20 | 39 |  |
| webrtc-vp8 | anim | shown | 20.5 | 20.5 | 86 / 93 | 80 | 2506 | 15280 | 93 | 18 | 39 | libvpx; video/VP8 |
| webcodecs-h264 | anim | shown | 29.9 | 29.9 | 75 / 78 | 54 | 2417 | 10073 | 97 | 18 | 39 |  |

### Electron · linux-x11 (electron-linux-x11.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone x11, displays 1920x1080@1, status **done**, 748 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.93 | 27.5 | 27 / 30 | 1 / 11 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.95 | 28.4 | 13 / 21 | 5 / 8 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.4 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.95 | 28.4 | 12 / 29 | 4 / 6 | 1280x800@1 → 1000x700@1 → 1280x800 | 0 / 0 | 2.4 |  |
| invisibleWindow | true | true | true | true (1) | 0.95 | 28.4 | 14 / 34 | 5 / 7 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.0 |  |
| tinyWindow | true | true | true | true (1) | 0.97 | 28.6 | 12 / 18 | 5 / 9 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.0 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 100.0 | 99.4 | 60.2 | 18 | – | – | – | 2.0 | 3.0 |  |
| detached, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | – | – | – | 0.0 | 0.2 |  |
| detached, throttling off | visible | 1280x800 | 100.0 | 99.4 | 0.0 | 0 | – | – | – | 0.4 | 0.6 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | – | – | – | 0.0 | 0.0 |  |
| never-shown window, throttling off | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | – | – | – | 0.4 | 0.4 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 100.0 | 99.4 | 1.0 | 1017 | – | – | – | 0.8 | 0.8 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | – | – | 0.0 | 0.4 | 0.6 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 100.0 | 99.4 | 0.0 | 0 | – | – | 0.0 | 0.8 | 1.2 |  |
| invisible shown window, throttling off | visible | 1280x800 | 99.9 | 99.3 | 0.0 | 0 | – | – | – | 0.6 | 0.6 |  |
| 1x1 shown window, throttling off | visible | 1280x800 | 100.0 | 99.4 | 60.0 | 18 | – | – | – | 1.8 | 2.6 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 100.0 | 99.4 | 60.2 | 18 | – | – | – | 2.0 | 2.6 | cover 0,0 1919x1079 over host 0,0 1x1 |
| 1x1 shown window, always on top, under a cover | visible | 1280x800 | 100.0 | 99.4 | 60.0 | 18 | – | – | – | 2.2 | 3.0 | cover 0,0 1919x1079 over host 0,0 1x1 |
| invisible shown window, covered by another window | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | – | – | – | 0.6 | 0.6 | cover -1480,-1000 1919x1079 over host -1480,-1000 1280x800 |
| osr window 30 fps, throttling off | visible | 1280x800 | 100.0 | 99.4 | 30.0 | 35 | – | – | – | 1.6 | 8.8 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 100.0 | 99.4 | 30.0 | 35 | – | – | – | 1.0 | 1.2 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 100.0 | 99.4 | 0.0 | 0 | 0.85 | 25.8 | – | 1.4 | 1.6 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 100.0 | 99.4 | 0.0 | 0 | 0.85 | 25.8 | – | 1.2 | 1.6 |  |
| detached, throttling off, playing media | visible | 1280x800 | 100.0 | 99.4 | 0.0 | 0 | 0.85 | 25.8 | – | 1.6 | 2.2 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 100.0 | 99.4 | 0.0 | 0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 2.0 | 1.0 | 0.0 | 0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | CPU ms/picture | frames/s | visibility events | errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 15 / 19 | -10 / -8 | 1000x700 | 28 | – |  |  |
| shown | true | capturePage | 6/6 | 6 | 15 / 16 | -9 / -8 | 1000x700 | 25 | – |  |  |
| shown | true | cdpJpeg | 6/6 | 6 | 48 / 55 | -36 / -35 | 1000x700 | 37 | – |  |  |
| shown | true | frameSub | 6/6 | 6 | 15 / 16 | -8 / 0 | 1000x700 | 23 | – |  |  |
| shown | true | cdpPng | 6/6 | 6 | 147 / 152 | -41 / -37 | 1000x700 | 143 | – |  |  |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | 45 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | 30 | – |  | frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 4046 / 4048 | -2999 / -42 | 1280x800 | 72 | – |  |  |
| hiddenWindow | false | frameSub | 6/6 | 6 | 6 / 7 | 60 / 70 | 1280x800 | 20 | – |  |  |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.5 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 97 / 99 | -64 / -20 | 1280x800 | 85 | – |  |  |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 19 / 22 | 6 / 10 | 1280x800 | 70 | – |  |  |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| invisibleWindow | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 79 / 84 | -47 / -30 | 1280x800 | 67 | – |  |  |
| invisibleWindow | false | frameSub | 6/6 | 6 | 15 / 23 | 11 / 12 | 1280x800 | 35 | – |  |  |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 14 / 16 | 9 / 13 | 1280x800 | 28 | – |  |  |
| tinyWindow | false | capturePage | 6/6 | 6 | 14 / 16 | 9 / 11 | 1280x800 | 32 | – |  |  |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 81 / 83 | -48 / -41 | 1280x800 | 48 | – |  |  |
| tinyWindow | false | frameSub | 6/6 | 6 | 15 / 21 | 11 / 11 | 1280x800 | 30 | – |  |  |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 15 / 15 | 9 / 16 | 1280x800 | 33 | – |  |  |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 14 / 16 | 10 / 10 | 1280x800 | 27 | – |  |  |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 81 / 83 | -47 / -40 | 1280x800 | 52 | – |  |  |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 15 / 19 | 10 / 12 | 1280x800 | 30 | – |  |  |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 38 / 66 | 1280x800 | 20 | – |  |  |
| osr | false | capturePage | 6/6 | 6 | 31 / 33 | 9 / 11 | 1280x800 | 33 | – |  |  |
| osr | false | cdpJpeg | 6/6 | 6 | 131 / 141 | -81 / -75 | 1280x800 | 65 | – |  |  |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | 112 | – |  | no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | 0 | – |  | empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | 70 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 320 | pss | 583 | 4 | 0.0 |
| 1 | 348 | pss | 688 | 5 | 0.3 |
| 2 | 363 | pss | 796 | 6 | 0.5 |
| 4 | 391 | pss | 1008 | 8 | 0.8 |
| 8 | 443 | pss | 1436 | 12 | 0.0 |

Per idle hidden tab: **15 MiB**, 0.00% CPU. Four tabs: one partition +65 MiB, four partitions +69 MiB.

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 13.0 | 8.5 | 4.3 | 60 |
| animated, never-shown window, throttling off | 0.5 | 0.5 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.0 | 0.0 | 0.0 | 0 |
| animated, never-shown window, throttling off + frame pump | 1.0 | 0.8 | 0.3 | 0 |
| animated, invisible shown window | 0.8 | 0.8 | 0.0 | 0 |
| animated, 1x1 shown window | 10.0 | 8.8 | 1.3 | 60 |
| animated, osr 30 fps | 17.0 | 6.3 | 3.5 | 30 |

**Q6 streamed view** (10 s at the viewer; latency p50 / p95 ms)

| road | content | source | fps | decoded fps | latency | gap p95 | kbit/s | bytes/frame | sender CPU % | viewer CPU % | source rAF | notes |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| screencast | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 |  |
| capturePoll | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | anim | hiddenWindow | 20.9 | 20.9 | 39 / 46 | 78 | 2513 | 15030 | 47 | 13 | 60 | libvpx; video/VP8 |
| webrtc-h264 | anim | hiddenWindow | 12.6 | 12.6 | 59 / 80 | 110 | 2492 | 24724 | 46 | 7 | 60 | OpenH264; video/H264 |
| webcodecs-vp8 | anim | hiddenWindow | 30.0 | 30.0 | 30 / 32 | 35 | 2417 | 10072 | 67 | 16 | 60 |  |
| webcodecs-h264 | anim | hiddenWindow | 30.0 | 30.0 | 29 / 30 | 35 | 2400 | 9999 | 56 | 14 | 60 |  |
| screencast | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | 0 |  |
| capturePoll | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | static | hiddenWindow | 2.0 | 2.0 | 26 / 28 | 512 | 59 | 3700 | 4 | 1 | 60 | libvpx; video/VP8 |
| webrtc-h264 | static | hiddenWindow | 1.0 | 1.0 | 19 / 35 | 1016 | 18 | 2192 | 4 | 1 | 60 | OpenH264; video/H264 |
| webcodecs-vp8 | static | hiddenWindow | 2.0 | 2.0 | 22 / 25 | 504 | 116 | 7272 | 4 | 1 | 60 |  |
| webcodecs-h264 | static | hiddenWindow | 2.0 | 2.0 | 16 / 17 | 502 | 35 | 2162 | 3 | 1 | 60 |  |
| screencast | anim | invisibleWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 |  |
| capturePoll | anim | invisibleWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 | toJPEG 0.0 ms |
| webcodecs-h264 | anim | invisibleWindow | 30.0 | 30.0 | 30 / 31 | 35 | 2399 | 9997 | 66 | 14 | 60 |  |
| screencast | anim | tinyWindow | 60.1 | 60.1 | 32 / 33 | 18 | 66228 | 137744 | 95 | 26 | 60 |  |
| webcodecs-h264 | anim | tinyWindow | 30.0 | 30.0 | 29 / 32 | 35 | 2408 | 10031 | 61 | 13 | 60 |  |
| screencast | anim | shown | 60.0 | 60.0 | 14 / 15 | 18 | 55016 | 114617 | 80 | 22 | 60 |  |
| webrtc-vp8 | anim | shown | 20.4 | 20.4 | 44 / 51 | 78 | 2511 | 15389 | 70 | 13 | 60 | libvpx; video/VP8 |
| webcodecs-h264 | anim | shown | 30.0 | 30.0 | 34 / 35 | 35 | 2454 | 10226 | 76 | 14 | 60 |  |

### Electron · linux-x64-ozone-headless (electron-linux-x64-ozone-headless.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone headless, displays 1920x1080@1, status **done**, 458 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.91 | 27.4 | 27 / 76 | 1 / 5 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.95 | 28.4 | 13 / 18 | 2 / 6 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.4 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.95 | 28.4 | 12 / 16 | 3 / 5 | 1280x800@1 → 1000x700@1 → 1280x800 | 0 / 0 | 2.4 |  |
| invisibleWindow | true | true | true | true (1) | 0.97 | 28.5 | 12 / 24 | 4 / 16 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.1 |  |
| tinyWindow | true | true | true | true (1) | 0.97 | 28.6 | 14 / 27 | 5 / 16 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.1 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 100.0 | 99.4 | 60.0 | 17 | – | – | – | 2.0 | 3.0 |  |
| detached, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | – | – | – | 0.0 | 0.0 |  |
| detached, throttling off | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | – | – | – | 0.6 | 0.6 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | – | – | – | 0.0 | 0.2 |  |
| never-shown window, throttling off | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | – | – | – | 0.6 | 0.6 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 100.1 | 99.3 | 1.0 | 1017 | – | – | – | 0.6 | 0.6 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | – | – | 0.0 | 0.6 | 0.6 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | – | – | 0.0 | 0.6 | 0.6 |  |
| invisible shown window, throttling off | visible | 1280x800 | 100.0 | 99.2 | 60.0 | 17 | – | – | – | 2.4 | 3.2 |  |
| 1x1 shown window, throttling off | visible | 1280x800 | 100.0 | 99.4 | 60.0 | 18 | – | – | – | 2.4 | 3.2 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 100.0 | 99.4 | 60.0 | 17 | – | – | – | 3.4 | 4.8 | cover 0,0 1920x1080 over host 0,0 1x1 |
| 1x1 shown window, always on top, under a cover | visible | 1280x800 | 100.0 | 99.2 | 60.2 | 17 | – | – | – | 3.6 | 5.2 | cover 0,0 1920x1080 over host 0,0 1x1 |
| invisible shown window, covered by another window | visible | 1280x800 | 100.0 | 99.2 | 60.0 | 17 | – | – | – | 3.8 | 5.6 | cover -1480,-1000 1920x1080 over host -1480,-1000 1280x800 |
| osr window 30 fps, throttling off | visible | 1280x800 | 100.0 | 99.2 | 30.0 | 34 | – | – | – | 2.6 | 10.6 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 100.0 | 99.2 | 30.2 | 34 | – | – | – | 1.6 | 1.8 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.85 | 25.8 | – | 1.8 | 2.8 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 100.2 | 99.4 | 0.0 | 0 | 0.85 | 25.8 | – | 1.8 | 2.6 |  |
| detached, throttling off, playing media | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.85 | 25.8 | – | 1.6 | 2.0 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 100.2 | 99.2 | 0.0 | 0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | CPU ms/picture | frames/s | visibility events | errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 15 / 16 | -9 / -3 | 1000x700 | 32 | – |  |  |
| shown | true | capturePage | 6/6 | 6 | 15 / 16 | -9 / -7 | 1000x700 | 28 | – |  |  |
| shown | true | cdpJpeg | 6/6 | 6 | 49 / 55 | -36 / -34 | 1000x700 | 42 | – |  |  |
| shown | true | frameSub | 6/6 | 6 | 15 / 16 | -8 / 0 | 1000x700 | 27 | – |  |  |
| shown | true | cdpPng | 6/6 | 6 | 150 / 154 | -41 / -33 | 1000x700 | 148 | – |  |  |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | 65 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | 35 | – |  | frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 4047 / 4049 | -2999 / -43 | 1280x800 | 73 | – |  |  |
| hiddenWindow | false | frameSub | 6/6 | 6 | 7 / 7 | 61 / 69 | 1280x800 | 20 | – |  |  |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.5 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 97 / 99 | -65 / -20 | 1280x800 | 80 | – |  |  |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 15 / 18 | 8 / 8 | 1280x800 | 48 | – |  |  |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 6/6 | 6 | 14 / 22 | 9 / 10 | 1280x800 | 37 | – |  |  |
| invisibleWindow | false | capturePage | 6/6 | 6 | 15 / 16 | 8 / 10 | 1280x800 | 28 | – |  |  |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 81 / 86 | -48 / -40 | 1280x800 | 57 | – |  |  |
| invisibleWindow | false | frameSub | 6/6 | 6 | 15 / 23 | 11 / 11 | 1280x800 | 32 | – |  |  |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 14 / 15 | 9 / 13 | 1280x800 | 28 | – |  |  |
| tinyWindow | false | capturePage | 6/6 | 6 | 15 / 16 | 8 / 10 | 1280x800 | 25 | – |  |  |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 81 / 82 | -48 / -40 | 1280x800 | 45 | – |  |  |
| tinyWindow | false | frameSub | 6/6 | 6 | 16 / 24 | 10 / 11 | 1280x800 | 25 | – |  |  |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 14 / 15 | 9 / 12 | 1280x800 | 23 | – |  |  |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 14 / 16 | 9 / 10 | 1280x800 | 25 | – |  |  |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 80 / 83 | -48 / -40 | 1280x800 | 45 | – |  |  |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 15 / 23 | 10 / 11 | 1280x800 | 27 | – |  |  |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 8 / 34 | 1280x800 | 22 | – |  |  |
| osr | false | capturePage | 6/6 | 6 | 31 / 33 | -23 / -15 | 1280x800 | 32 | – |  |  |
| osr | false | cdpJpeg | 6/6 | 6 | 99 / 125 | -80 / -80 | 1280x800 | 57 | – |  |  |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | 78 | – |  | no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | 0 | – |  | empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | 105 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 236 | pss | 491 | 4 | 0.0 |
| 1 | 263 | pss | 594 | 5 | 0.3 |
| 2 | 279 | pss | 701 | 6 | 0.5 |
| 4 | 306 | pss | 912 | 8 | 0.3 |
| 8 | 358 | pss | 1336 | 12 | 0.5 |

Per idle hidden tab: **15 MiB**, 0.06% CPU. Four tabs: one partition +65 MiB, four partitions +67 MiB.

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 13.3 | 9.0 | 4.3 | 60 |
| animated, never-shown window, throttling off | 1.3 | 1.0 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.0 | 0.0 | 0.0 | 0 |
| animated, never-shown window, throttling off + frame pump | 0.8 | 0.8 | 0.0 | 0 |
| animated, invisible shown window | 18.0 | 11.3 | 6.8 | 60 |
| animated, 1x1 shown window | 10.8 | 9.5 | 1.3 | 60 |
| animated, osr 30 fps | 15.3 | 5.8 | 3.0 | 30 |

### Electron · macos (electron-macos.json)

Electron 45.2.2 (Chromium 156.0.8078.80), darwin-arm64 25.6.0, ozone (default), displays 1024x768@1, status **done**, 756 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.94 | 28.0 | 41 / 1305 | 12 / 307 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.1 |  |
| hiddenWindow | true | true | true | true (1) | 0.98 | 29.1 | 40 / 46 | 10 / 19 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.0 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.97 | 29.0 | 29 / 57 | 14 / 15 | 1280x800@1 → 1000x700@1 → 1280x800 | 1 / 3 | 2.1 |  |
| invisibleWindow | true | true | true | true (1) | 0.98 | 28.9 | 35 / 64 | 9 / 22 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 59.9 |  |
| tinyWindow | true | true | true | true (1) | 0.98 | 28.9 | 31 / 39 | 3 / 11 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 59.7 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 78.3 | 60.1 | 59.9 | 34 | – | – | – | 6.8 | 19.1 |  |
| detached, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | – | – | – | 0.1 | 0.6 |  |
| detached, throttling off | visible | 1280x800 | 99.1 | 81.3 | 0.0 | 0 | – | – | – | 2.9 | 7.8 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 1.4 | 1.0 | 0.0 | 0 | – | – | – | 0.1 | 0.8 |  |
| never-shown window, throttling off | visible | 1280x800 | 92.9 | 78.2 | 0.0 | 0 | – | – | – | 2.5 | 7.2 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 81.0 | 61.2 | 60.0 | 23 | – | – | – | 8.1 | 22.7 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 99.7 | 84.6 | 0.0 | 0 | – | – | 0.0 | 3.5 | 9.3 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 92.4 | 76.1 | 0.0 | 0 | – | – | 0.0 | 2.5 | 6.9 |  |
| invisible shown window, throttling off | visible | 1280x800 | 75.8 | 60.7 | 59.3 | 54 | – | – | – | 6.1 | 16.7 |  |
| 1x1 shown window, throttling off | visible | 1280x800 | 82.5 | 61.5 | 60.1 | 31 | – | – | – | 9.0 | 25.3 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 73.1 | 59.7 | 59.3 | 46 | – | – | – | 7.6 | 21.5 | cover 0,31 1024x677 over host 0,31 1x1 |
| 1x1 shown window, always on top, under a cover | visible | 1280x800 | 74.9 | 60.7 | 60.1 | 24 | – | – | – | 8.3 | 23.6 | cover 0,31 1024x677 over host 0,31 1x1 |
| invisible shown window, covered by another window | visible | 1280x800 | 79.4 | 60.6 | 60.0 | 23 | – | – | – | 7.7 | 22.0 | cover 0,31 1024x677 over host 0,31 1280x800 |
| osr window 30 fps, throttling off | visible | 1280x800 | 58.1 | 47.2 | 21.0 | 128 | – | – | – | 4.1 | 19.6 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 62.1 | 49.0 | 23.6 | 100 | – | – | – | 3.3 | 8.0 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 57.5 | 46.1 | 0.0 | 0 | 0.91 | 27.8 | – | 5.6 | 12.0 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 42.2 | 34.6 | 0.0 | 0 | 0.88 | 26.4 | – | 4.3 | 8.9 |  |
| detached, throttling off, playing media | visible | 1280x800 | 39.4 | 32.0 | 0.0 | 0 | 0.88 | 27.6 | – | 4.2 | 8.7 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 62.0 | 44.2 | 0.0 | 0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | CPU ms/picture | frames/s | visibility events | errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 27 / 60 | 5 / 15 | 1000x700 | 52 | – |  |  |
| shown | true | capturePage | 6/6 | 6 | 29 / 41 | 8 / 17 | 1000x700 | 38 | – |  |  |
| shown | true | cdpJpeg | 6/6 | 6 | 89 / 108 | -47 / -37 | 1000x700 | 59 | – |  |  |
| shown | true | frameSub | 6/6 | 6 | 24 / 47 | 4 / 12 | 1000x700 | 36 | – |  |  |
| shown | true | cdpPng | 6/6 | 6 | 239 / 249 | -46 / -42 | 1000x700 | 237 | – |  |  |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 29.5 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | 16 | – |  | Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | 19 | – |  | Current display surface not available for capture |
| detached | false | cdpJpeg | 1/3 | 1 | 104 / 104 | -55 / -55 | 1280x800 | 198 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | 163 | – |  | frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | 11 | – |  | Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | 12 | – |  | Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 95 / 217 | -47 / -37 | 1280x800 | 116 | – |  |  |
| hiddenWindow | false | frameSub | 6/6 | 6 | 27 / 38 | 7 / 19 | 1280x800 | 75 | – |  |  |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | 14 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | 14 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 91 / 181 | -48 / -38 | 1280x800 | 178 | – |  |  |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 17 / 41 | 11 / 16 | 1280x800 | 76 | – |  |  |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 6/6 | 6 | 32 / 46 | 11 / 16 | 1280x800 | 86 | – |  |  |
| invisibleWindow | false | capturePage | 6/6 | 6 | 29 / 48 | 7 / 12 | 1280x800 | 77 | – |  |  |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 97 / 147 | -45 / -37 | 1280x800 | 113 | – |  |  |
| invisibleWindow | false | frameSub | 6/6 | 6 | 31 / 40 | 1 / 15 | 1280x800 | 72 | – |  |  |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 23 / 37 | 6 / 15 | 1280x800 | 57 | – |  |  |
| tinyWindow | false | capturePage | 6/6 | 6 | 34 / 62 | 8 / 78 | 1280x800 | 82 | – |  |  |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 90 / 207 | -41 / -35 | 1280x800 | 102 | – |  |  |
| tinyWindow | false | frameSub | 6/6 | 6 | 16 / 57 | 8 / 17 | 1280x800 | 55 | – |  |  |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 27 / 32 | 25 / 32 | 1280x800 | 68 | – |  |  |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 26 / 38 | 19 / 32 | 1280x800 | 68 | – |  |  |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 98 / 110 | -50 / -38 | 1280x800 | 114 | – |  |  |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 31 / 38 | 5 / 17 | 1280x800 | 72 | – |  |  |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 1 | 51 / 141 | 1280x800 | 31 | – |  |  |
| osr | false | capturePage | 6/6 | 6 | 14 / 82 | 21 / 109 | 1280x800 | 24 | – |  |  |
| osr | false | cdpJpeg | 6/6 | 6 | 307 / 471 | -130 / -66 | 1280x800 | 104 | – |  |  |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | 13.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | 508 | – |  | no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | 10 | – |  | empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | 436 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 134 | footprint | 375 | 4 | 0.1 |
| 1 | 156 | footprint | 466 | 5 | 0.5 |
| 2 | 174 | footprint | 559 | 6 | 1.0 |
| 4 | 216 | footprint | 744 | 8 | 1.5 |
| 8 | 298 | footprint | 1110 | 12 | 2.6 |

Per idle hidden tab: **20 MiB**, 0.30% CPU. Four tabs: one partition +76 MiB, four partitions +83 MiB.

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 30.0 | 10.6 | 19.1 | 60 |
| animated, never-shown window, throttling off | 12.3 | 4.3 | 7.7 | 0 |
| animated, never-shown window, throttling on | 0.7 | 0.1 | 0.4 | 0 |
| animated, never-shown window, throttling off + frame pump | 9.5 | 3.3 | 6.0 | 0 |
| animated, invisible shown window | 40.5 | 13.5 | 26.7 | 60 |
| animated, 1x1 shown window | 39.6 | 12.7 | 26.4 | 60 |
| animated, osr 30 fps | 26.9 | 4.2 | 9.0 | 17 |

**Q6 streamed view** (10 s at the viewer; latency p50 / p95 ms)

| road | content | source | fps | decoded fps | latency | gap p95 | kbit/s | bytes/frame | sender CPU % | viewer CPU % | source rAF | notes |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| screencast | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 10 | 0 | 0 |  |
| capturePoll | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 10 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | anim | hiddenWindow | 2.9 | 2.9 | 298 / 449 | 515 | 495 | 21325 | 40 | 3 | 60 | libvpx; video/VP8 |
| webrtc-h264 | anim | hiddenWindow | 13.3 | 13.3 | 178 / 208 | 115 | 2368 | 22256 | 71 | 8 | 60 | OpenH264; video/H264 |
| webcodecs-vp8 | anim | hiddenWindow | 30.0 | 30.0 | 44 / 57 | 49 | 2252 | 9382 | 88 | 14 | 60 |  |
| webcodecs-h264 | anim | hiddenWindow | 30.1 | 30.1 | 44 / 54 | 48 | 2233 | 9305 | 95 | 12 | 60 |  |
| screencast | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 |  |
| capturePoll | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | static | hiddenWindow | 2.0 | 2.0 | 34 / 68 | 546 | 33 | 2073 | 10 | 2 | 44 | libvpx; video/VP8 |
| webrtc-h264 | static | hiddenWindow | 1.0 | 1.0 | 75 / 92 | 1048 | 3 | 353 | 11 | 1 | 43 | OpenH264; video/H264 |
| webcodecs-vp8 | static | hiddenWindow | 2.0 | 2.0 | 56 / 75 | 529 | 100 | 6223 | 10 | 1 | 43 |  |
| webcodecs-h264 | static | hiddenWindow | 2.0 | 2.0 | 45 / 74 | 530 | 9 | 540 | 9 | 1 | 42 |  |
| screencast | anim | invisibleWindow | 59.3 | 59.3 | 52 / 68 | 35 | 57706 | 121435 | 84 | 25 | 60 |  |
| capturePoll | anim | invisibleWindow | 31.0 | 31.0 | 59 / 66 | 46 | 30295 | 121766 | 51 | 13 | 60 | toJPEG 5.3 ms |
| webcodecs-h264 | anim | invisibleWindow | 30.1 | 30.1 | 45 / 56 | 49 | 2272 | 9433 | 99 | 14 | 60 |  |
| screencast | anim | tinyWindow | 58.8 | 58.8 | 45 / 64 | 34 | 57312 | 121630 | 116 | 34 | 60 |  |
| webcodecs-h264 | anim | tinyWindow | 30.1 | 30.1 | 62 / 77 | 51 | 2282 | 9446 | 110 | 17 | 60 |  |
| screencast | anim | shown | 60.0 | 60.0 | 56 / 64 | 27 | 48903 | 101881 | 67 | 21 | 60 |  |
| webrtc-vp8 | anim | shown | 2.9 | 2.9 | 271 / 426 | 484 | 458 | 19733 | 42 | 3 | 60 | libvpx; video/VP8 |
| webcodecs-h264 | anim | shown | 30.0 | 30.0 | 26 / 30 | 43 | 2118 | 8824 | 69 | 11 | 60 |  |

### Electron · windows (electron-windows.json)

Electron 45.2.2 (Chromium 156.0.8078.80), win32-x64 10.0.26100, ozone (default), displays 1024x768@1, status **done**, 750 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.92 | 27.4 | 25 / 89 | 2 / 59 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.96 | 28.6 | 22 / 34 | 11 / 14 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 1.9 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.96 | 28.6 | 22 / 23 | 12 / 14 | 1280x800@1 → 1000x700@1 → 1280x800 | 1 / 3 | 1.9 |  |
| invisibleWindow | true | true | true | true (1) | 0.96 | 28.8 | 22 / 31 | 10 / 14 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 64.0 |  |
| tinyWindow | true | true | true | true (1) | 0.97 | 28.9 | 21 / 23 | 10 / 13 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 64.0 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 100.0 | 91.8 | 64.0 | 18 | – | – | – | 4.0 | 7.3 |  |
| detached, throttling on (default) | hidden | 1280x800 | 1.8 | 1.4 | 0.0 | 0 | – | – | – | 0.0 | 0.3 |  |
| detached, throttling off | visible | 1280x800 | 100.0 | 97.2 | 0.0 | 0 | – | – | – | 1.3 | 1.4 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | – | – | – | 0.0 | 0.2 |  |
| never-shown window, throttling off | visible | 1280x800 | 100.0 | 97.2 | 0.0 | 0 | – | – | – | 1.3 | 1.5 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 100.0 | 91.2 | 1.0 | 1001 | – | – | – | 1.0 | 1.3 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 100.0 | 97.2 | 0.0 | 0 | – | – | 0.0 | 1.5 | 1.6 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 100.0 | 96.8 | 0.0 | 0 | – | – | 0.0 | 1.8 | 1.9 |  |
| invisible shown window, throttling off | visible | 1280x800 | 100.0 | 93.2 | 64.0 | 18 | – | – | – | 4.7 | 8.7 |  |
| 1x1 shown window, throttling off | visible | 1280x800 | 100.0 | 92.8 | 64.0 | 18 | – | – | – | 4.3 | 7.5 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 100.0 | 92.0 | 64.0 | 17 | – | – | – | 4.2 | 7.3 | cover 0,0 1024x720 over host 0,0 32x31 |
| 1x1 shown window, always on top, under a cover | visible | 1280x800 | 100.0 | 92.8 | 64.0 | 18 | – | – | – | 4.7 | 8.2 | cover 0,0 1024x720 over host 0,0 32x31 |
| invisible shown window, covered by another window | visible | 1280x800 | 100.2 | 92.4 | 64.0 | 18 | – | – | – | 4.9 | 8.8 | cover 0,0 1024x720 over host 0,0 1024x720 |
| osr window 30 fps, throttling off | visible | 1024x720 | 100.0 | 91.2 | 30.0 | 35 | – | – | – | 2.8 | 8.3 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 100.0 | 91.0 | 30.0 | 36 | – | – | – | 1.9 | 2.8 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 100.2 | 92.0 | 0.0 | 0 | 0.85 | 24.8 | – | 2.6 | 3.5 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 100.0 | 95.8 | 0.0 | 0 | 0.85 | 24.8 | – | 2.7 | 3.7 |  |
| detached, throttling off, playing media | visible | 1280x800 | 100.2 | 92.8 | 0.0 | 0 | 0.85 | 24.8 | – | 2.2 | 3.0 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 100.2 | 97.2 | 0.0 | 0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | CPU ms/picture | frames/s | visibility events | errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 8 / 19 | 12 / 15 | 1000x700 | 63 | – |  |  |
| shown | true | capturePage | 6/6 | 6 | 8 / 22 | 13 / 15 | 1000x700 | 63 | – |  |  |
| shown | true | cdpJpeg | 6/6 | 6 | 70 / 81 | -39 / -37 | 1000x700 | 100 | – |  |  |
| shown | true | frameSub | 6/6 | 6 | 21 / 24 | 2 / 13 | 1000x700 | 61 | – |  |  |
| shown | true | cdpPng | 6/6 | 6 | 210 / 230 | -43 / -40 | 1000x700 | 299 | – |  |  |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | 96 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | 71 | – |  | frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 3976 / 3979 | -2941 / -53 | 1280x800 | 117 | – |  |  |
| hiddenWindow | false | frameSub | 6/6 | 6 | 8 / 9 | 62 / 78 | 1280x800 | 37 | – |  |  |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.5 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 70 / 86 | -35 / -32 | 1280x800 | 128 | – |  |  |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 23 / 25 | 0 / 12 | 1280x800 | 78 | – |  |  |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 6/6 | 6 | 20 / 24 | 2 / 6 | 1280x800 | 82 | – |  |  |
| invisibleWindow | false | capturePage | 6/6 | 6 | 21 / 23 | 1 / 4 | 1280x800 | 86 | – |  |  |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 71 / 79 | -34 / -33 | 1280x800 | 126 | – |  |  |
| invisibleWindow | false | frameSub | 6/6 | 6 | 23 / 24 | 5 / 6 | 1280x800 | 83 | – |  |  |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 21 / 23 | 2 / 6 | 1280x800 | 60 | – |  |  |
| tinyWindow | false | capturePage | 6/6 | 6 | 19 / 23 | 2 / 16 | 1280x800 | 54 | – |  |  |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 71 / 84 | -35 / -34 | 1280x800 | 89 | – |  |  |
| tinyWindow | false | frameSub | 6/6 | 6 | 24 / 25 | 4 / 12 | 1280x800 | 55 | – |  |  |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 21 / 22 | 3 / 16 | 1280x800 | 56 | – |  |  |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 21 / 23 | 2 / 17 | 1280x800 | 54 | – |  |  |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 71 / 80 | -36 / -32 | 1280x800 | 91 | – |  |  |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 23 / 24 | 5 / 12 | 1280x800 | 55 | – |  |  |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 61 / 64 | 1024x720 | 22 | – |  |  |
| osr | false | capturePage | 6/6 | 6 | 30 / 34 | 8 / 32 | 1024x720 | 47 | – |  |  |
| osr | false | cdpJpeg | 6/6 | 6 | 133 / 141 | -84 / -83 | 1024x720 | 76 | – |  |  |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | 131 | – |  | no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | 100 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 139 | privateBytes | 169 | 4 | 0.0 |
| 1 | 165 | privateBytes | 244 | 5 | 0.1 |
| 2 | 192 | privateBytes | 319 | 6 | 0.2 |
| 4 | 246 | privateBytes | 468 | 8 | 0.3 |
| 8 | 352 | privateBytes | 770 | 12 | 0.5 |

Per idle hidden tab: **27 MiB**, 0.05% CPU. Four tabs: one partition +96 MiB, four partitions +104 MiB.

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 42.6 | 23.8 | 18.2 | 64 |
| animated, never-shown window, throttling off | 1.5 | 1.3 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.1 | 0.0 | 0.0 | 0 |
| animated, never-shown window, throttling off + frame pump | 1.5 | 1.4 | 0.0 | 0 |
| animated, invisible shown window | 53.8 | 31.0 | 22.8 | 64 |
| animated, 1x1 shown window | 35.9 | 32.2 | 3.5 | 64 |
| animated, osr 30 fps | 23.6 | 11.8 | 7.3 | 30 |

**Q6 streamed view** (10 s at the viewer; latency p50 / p95 ms)

| road | content | source | fps | decoded fps | latency | gap p95 | kbit/s | bytes/frame | sender CPU % | viewer CPU % | source rAF | notes |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| screencast | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | 0 |  |
| capturePoll | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | anim | hiddenWindow | 25.9 | 25.9 | 39 / 41 | 66 | 2506 | 12092 | 87 | 19 | 64 | libvpx; video/VP8 |
| webrtc-h264 | anim | hiddenWindow | 14.8 | 14.8 | 57 / 73 | 81 | 2489 | 21023 | 87 | 12 | 64 | OpenH264; video/H264 |
| webcodecs-vp8 | anim | hiddenWindow | 30.0 | 30.0 | 33 / 36 | 48 | 2178 | 9074 | 102 | 18 | 64 |  |
| webcodecs-h264 | anim | hiddenWindow | 30.0 | 30.0 | 32 / 34 | 49 | 2159 | 8994 | 97 | 17 | 64 |  |
| screencast | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | 0 |  |
| capturePoll | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | static | hiddenWindow | 2.0 | 2.0 | 19 / 20 | 502 | 51 | 3182 | 6 | 1 | 64 | libvpx; video/VP8 |
| webrtc-h264 | static | hiddenWindow | 1.0 | 1.0 | 22 / 27 | 1003 | 17 | 2180 | 6 | 1 | 64 | OpenH264; video/H264 |
| webcodecs-vp8 | static | hiddenWindow | 2.0 | 2.0 | 23 / 25 | 503 | 106 | 6617 | 6 | 1 | 64 |  |
| webcodecs-h264 | static | hiddenWindow | 2.0 | 2.0 | 19 / 20 | 501 | 9 | 569 | 5 | 1 | 64 |  |
| screencast | anim | invisibleWindow | 64.0 | 64.0 | 39 / 42 | 20 | 60552 | 118266 | 174 | 38 | 64 |  |
| capturePoll | anim | invisibleWindow | 31.5 | 31.5 | 38 / 41 | 38 | 29817 | 118699 | 120 | 19 | 64 | toJPEG 7.9 ms |
| webcodecs-h264 | anim | invisibleWindow | 30.0 | 30.0 | 36 / 40 | 48 | 2149 | 8953 | 135 | 19 | 64 |  |
| screencast | anim | tinyWindow | 64.0 | 64.0 | 37 / 39 | 19 | 60551 | 118264 | 161 | 38 | 64 |  |
| webcodecs-h264 | anim | tinyWindow | 30.0 | 30.0 | 33 / 36 | 48 | 2152 | 8968 | 109 | 18 | 64 |  |
| screencast | anim | shown | 64.0 | 64.0 | 32 / 35 | 18 | 50816 | 99250 | 125 | 29 | 64 |  |
| webrtc-vp8 | anim | shown | 24.8 | 24.8 | 56 / 58 | 77 | 2503 | 12615 | 135 | 20 | 64 | libvpx; video/VP8 |
| webcodecs-h264 | anim | shown | 30.0 | 30.0 | 42 / 46 | 47 | 2208 | 9202 | 136 | 19 | 64 |  |

### The pair · linux-x64 (pair-linux.json)

7.0.0-1017-azure, 39 s, state **done**

- **login start**: {"daemonUpMs":121,"daemonUp":true,"appConnectedMs":5876,"appStartedBy":"daemon","appStart":{"at":1793845453109,"safeMode":false,"reason":"daemon start","ok":true,"how":"systemctl --user start clover-s7-app-dad23861.service","out":""},"daemonParent":1336}
- **second daemon on the same home**: {"exitCode":0,"ms":33,"said":"2026-11-05T02:24:16.698Z [core 2840] another daemon holds this home (flock: held by another process); exiting","firstStillServing":true}
- **app crash**: {"killed":2789,"kill":{"ok":true,"how":"kill -9 2789","code":0,"out":""},"restartedMs":1524,"newPid":2851,"startedBy":"daemon","safeMode":false,"how":"systemctl --user start clover-s7-app-dad23861.service","eventsSinceKill":["start","tray","connected"]}
- **app crash loop → safe mode**: {"rounds":[{"killed":2851,"restartedMs":2230,"safeMode":false,"crashesInDaemon":2},{"killed":2901,"restartedMs":4246,"safeMode":true,"crashesInDaemon":3}],"thirdRestartInSafeMode":true}
- **daemon crash, restarted by the OS alone**: {"killed":2777,"kill":{"ok":true,"how":"kill -9 2777","code":0,"out":""},"daemonBackMs":1409,"newDaemonPid":3000,"appSurvived":true,"appPidAfter":2952,"samePid":true,"appStartedTheDaemon":false,"appEvents":["4ms daemon-lost","1509ms connected","1509ms reconnected"]}
- **daemon crash, the app helps after 3 s**: {"killed":3000,"kill":{"ok":true,"how":"kill -9 3000","code":0,"out":""},"daemonBackMs":1405,"newDaemonPid":3009,"appSurvived":true,"appPidAfter":2952,"samePid":true,"appStartedTheDaemon":false,"appEvents":["2ms daemon-lost","1507ms connected","1507ms reconnected"]}
- **tray Quit stops both, and they stay down**: {"forwarded":{"forwarded":true},"bothDownMs":402,"restartedWithin12s":false,"appEvents":["quit","quit-acked"]}
- **a user starts the app → it starts the daemon**: {"start":{"ok":true,"how":"spawn detached (as from a launcher)","code":0,"out":"3025"},"bothUpMs":514,"startedBy":"user","appStartedTheDaemon":[{"ok":true,"how":"systemctl --user start clover-s7-core-dad23861.service","out":""}],"appEvents":["start","tray","start-daemon","connected"]}
- **the daemon side's Quit stops both**: {"bothDownMs":402,"restartedWithin8s":false}

### The pair · darwin-arm64 (pair-macos.json)

25.6.0, 38 s, state **done**

- **login start**: {"daemonUpMs":131,"daemonUp":true,"appConnectedMs":4015,"appStartedBy":"daemon","appStart":{"at":1793846101196,"safeMode":false,"reason":"daemon start","ok":true,"how":"open -n -g -a /Users/runner/work/clover/clover/spikes/s7-browser/prototype/node_modules/electron/dist/Electron.app --args /Users/runner/work/clover/clover/spikes/s7-browser/prototype/out/pair/app --home=/var/folders/n6/hn37q6pj7sj_9dmqqc2113800000gn/T/clover-s7-pair-sfCDP5","out":""},"daemonParent":1}
- **second daemon on the same home**: {"exitCode":0,"ms":479,"said":"2026-11-05T02:35:03.291Z [core 8557] another daemon holds this home (flock: held by another process); exiting","firstStillServing":true}
- **app crash**: {"killed":8415,"kill":{"ok":true,"how":"kill -9 8415","code":0,"out":""},"restartedMs":1581,"newPid":8561,"startedBy":"daemon","safeMode":false,"how":"open -n -g -a /Users/runner/work/clover/clover/spikes/s7-browser/prototype/node_modules/electron/dist/Electron.app --args /Users/runner/work/clover/clover/spikes/s7-browser/prototype/out/pair/app --home=/var/folders/n6/hn37q6pj7sj_9dmqqc2113800000gn/T/clover-s7-pair-sfCDP5","eventsSinceKill":["start","tray","connected"]}
- **app crash loop → safe mode**: {"rounds":[{"killed":8561,"restartedMs":2431,"safeMode":false,"crashesInDaemon":2},{"killed":8577,"restartedMs":4443,"safeMode":true,"crashesInDaemon":3}],"thirdRestartInSafeMode":true}
- **daemon crash, restarted by the OS alone**: {"killed":8309,"kill":{"ok":true,"how":"kill -9 8309","code":0,"out":""},"daemonBackMs":1222,"newDaemonPid":8624,"appSurvived":true,"appPidAfter":8621,"samePid":true,"appStartedTheDaemon":false,"appEvents":["3ms daemon-lost","19ms daemon-lost","19ms connected","19ms reconnected","525ms connected","525ms reconnected"]}
- **daemon crash, the app helps after 3 s**: {"killed":8624,"kill":{"ok":true,"how":"kill -9 8624","code":0,"out":""},"daemonBackMs":1208,"newDaemonPid":8781,"appSurvived":true,"appPidAfter":8621,"samePid":true,"appStartedTheDaemon":false,"appEvents":["3ms daemon-lost","508ms connected","508ms reconnected"]}
- **tray Quit stops both, and they stay down**: {"forwarded":{"forwarded":true},"bothDownMs":415,"restartedWithin12s":false,"appEvents":["quit","quit-acked"]}
- **a user starts the app → it starts the daemon**: {"start":{"ok":true,"how":"open -n -g -a /Users/runner/work/clover/clover/spikes/s7-browser/prototype/node_modules/electron/dist/Electron.app --args /Users/runner/work/clover/clover/spikes/s7-browser/prototype/out/pair/app --home=/var/folders/n6/hn37q6pj7sj_9dmqqc2113800000gn/T/clover-s7-pair-sfCDP5","code":0,"out":""},"bothUpMs":849,"startedBy":"user","appStartedTheDaemon":[{"ok":true,"how":"launchctl kickstart gui/501/com.waifucave.clover.s7.core.c93db77d","out":""}],"appEvents":["start","tray","start-daemon","connected"]}
- **the daemon side's Quit stops both**: {"bothDownMs":319,"restartedWithin8s":false}

### The pair · win32-x64 (pair-windows-spawn.json)

10.0.26100, 188 s, state **done**, Windows app start: spawn

- **login start**: {"daemonUpMs":453,"daemonUp":true,"appConnectedMs":3679,"appStartedBy":"daemon","appStart":{"at":1793845402352,"safeMode":false,"reason":"daemon start","ok":true,"how":"spawn detached","out":"1916"},"daemonParent":2660}
- **second daemon on the same home**: {"exitCode":0,"ms":81,"said":"2026-11-05T02:23:22.700Z [core 4920] another daemon holds this home (CreateFileW: error 32 (sharing violation: another daemon holds it)); exiting","firstStillServing":true}
- **app crash**: {"killed":1916,"kill":{"ok":true,"how":"taskkill /F /T /PID 1916","code":0,"out":"SUCCESS: The process with PID 10156 (child process of PID 1916) has been terminated.\r\nSUCCESS: The process with PID 3452 (child process of PID 1916) has been te"},"restartedMs":1196,"newPid":6888,"startedBy":"daemon","safeMode":false,"how":"spawn detached","eventsSinceKill":["start","tray","connected"]}
- **app crash loop → safe mode**: {"rounds":[{"killed":6888,"restartedMs":2203,"safeMode":false,"crashesInDaemon":2},{"killed":7332,"restartedMs":4177,"safeMode":true,"crashesInDaemon":3}],"thirdRestartInSafeMode":true}
- **daemon crash, restarted by the OS alone**: {"killed":6232,"kill":{"ok":true,"how":"taskkill /F /PID 6232","code":0,"out":"SUCCESS: The process with PID 6232 has been terminated."},"appSurvived":true,"appPidAfter":2564,"samePid":true,"appStartedTheDaemon":{"atMs":150364,"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-09295620"},"appEvents":["57ms daemon-lost","150364ms start-daemon","150877ms connected","150877ms reconnected"]}
- **daemon crash, the app helps after 3 s**: {"killed":2088,"kill":{"ok":true,"how":"taskkill /F /PID 2088","code":0,"out":"SUCCESS: The process with PID 2088 has been terminated."},"daemonBackMs":3297,"newDaemonPid":8464,"appSurvived":true,"appPidAfter":2564,"samePid":true,"appStartedTheDaemon":{"atMs":3155,"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-09295620"},"appEvents":["92ms daemon-lost","3155ms start-daemon","3658ms connected","3658ms reconnected"]}
- **tray Quit stops both, and they stay down**: {"forwarded":{"forwarded":true},"bothDownMs":330,"restartedWithin12s":false,"appEvents":[]}
- **a user starts the app → it starts the daemon**: {"start":{"ok":true,"how":"spawn detached","code":0,"out":"6200"},"bothUpMs":544,"startedBy":"user","appStartedTheDaemon":[{"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-09295620","out":"SUCCESS: Attempted to run the scheduled task \"\\Clover S7\\core-09295620\"."}],"appEvents":["start","tray","start-daemon","connected"]}
- **the daemon side's Quit stops both**: {"bothDownMs":326,"restartedWithin8s":false}

### The pair · win32-x64 (pair-windows-supervise.json)

10.0.26100, 36 s, state **done**, Windows app start: task, daemon under the supervisor

- **login start**: {"daemonUpMs":452,"daemonUp":true,"appConnectedMs":3228,"appStartedBy":"daemon","appStart":{"at":1793845399885,"safeMode":false,"reason":"daemon start","ok":true,"how":"schtasks /Run /TN \\Clover S7\\app-6111bd74","out":"SUCCESS: Attempted to run the scheduled task \"\\Clover S7\\app-6111bd74\"."},"daemonParent":4468}
- **second daemon on the same home**: {"exitCode":0,"ms":77,"said":"2026-11-05T02:23:20.669Z [core 2760] another daemon holds this home (CreateFileW: error 32 (sharing violation: another daemon holds it)); exiting","firstStillServing":true}
- **app crash**: {"killed":2656,"kill":{"ok":true,"how":"taskkill /F /T /PID 2656","code":0,"out":"SUCCESS: The process with PID 6600 (child process of PID 2656) has been terminated.\r\nSUCCESS: The process with PID 9108 (child process of PID 2656) has been ter"},"restartedMs":1227,"newPid":6980,"startedBy":"daemon","safeMode":false,"how":"schtasks /Run /TN \\Clover S7\\app-6111bd74","eventsSinceKill":["start","tray","connected"]}
- **app crash loop → safe mode**: {"rounds":[{"killed":6980,"restartedMs":2205,"safeMode":false,"crashesInDaemon":2},{"killed":2948,"restartedMs":4146,"safeMode":true,"crashesInDaemon":3}],"thirdRestartInSafeMode":true}
- **daemon crash, restarted by the OS alone**: {"killed":8260,"kill":{"ok":true,"how":"taskkill /F /PID 8260","code":0,"out":"SUCCESS: The process with PID 8260 has been terminated."},"daemonBackMs":617,"newDaemonPid":8728,"appSurvived":true,"appPidAfter":920,"samePid":true,"appStartedTheDaemon":false,"appEvents":["66ms daemon-lost","1078ms connected","1078ms reconnected"]}
- **daemon crash, the app helps after 3 s**: {"killed":8728,"kill":{"ok":true,"how":"taskkill /F /PID 8728","code":0,"out":"SUCCESS: The process with PID 8728 has been terminated."},"daemonBackMs":1238,"newDaemonPid":8808,"appSurvived":true,"appPidAfter":920,"samePid":true,"appStartedTheDaemon":false,"appEvents":["48ms daemon-lost","1564ms connected","1564ms reconnected"]}
- **tray Quit stops both, and they stay down**: {"forwarded":{"forwarded":true},"bothDownMs":430,"restartedWithin12s":false,"appEvents":[]}
- **a user starts the app → it starts the daemon**: {"start":{"ok":true,"how":"spawn detached","code":0,"out":"7020"},"bothUpMs":551,"startedBy":"user","appStartedTheDaemon":[{"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-6111bd74","out":"SUCCESS: Attempted to run the scheduled task \"\\Clover S7\\core-6111bd74\"."}],"appEvents":["start","tray","start-daemon","connected"]}
- **the daemon side's Quit stops both**: {"bothDownMs":330,"restartedWithin8s":false}

### The pair · win32-x64 (pair-windows-task.json)

10.0.26100, 188 s, state **done**, Windows app start: task

- **login start**: {"daemonUpMs":345,"daemonUp":true,"appConnectedMs":3095,"appStartedBy":"daemon","appStart":{"at":1793845459488,"safeMode":false,"reason":"daemon start","ok":true,"how":"schtasks /Run /TN \\Clover S7\\app-5990c89f","out":"SUCCESS: Attempted to run the scheduled task \"\\Clover S7\\app-5990c89f\"."},"daemonParent":2620}
- **second daemon on the same home**: {"exitCode":0,"ms":88,"said":"2026-11-05T02:24:20.170Z [core 8864] another daemon holds this home (CreateFileW: error 32 (sharing violation: another daemon holds it)); exiting","firstStillServing":true}
- **app crash**: {"killed":7104,"kill":{"ok":true,"how":"taskkill /F /T /PID 7104","code":0,"out":"SUCCESS: The process with PID 4272 (child process of PID 7104) has been terminated.\r\nSUCCESS: The process with PID 7560 (child process of PID 7104) has been ter"},"restartedMs":1210,"newPid":552,"startedBy":"daemon","safeMode":false,"how":"schtasks /Run /TN \\Clover S7\\app-5990c89f","eventsSinceKill":["start","tray","connected"]}
- **app crash loop → safe mode**: {"rounds":[{"killed":552,"restartedMs":2203,"safeMode":false,"crashesInDaemon":2},{"killed":7308,"restartedMs":4200,"safeMode":true,"crashesInDaemon":3}],"thirdRestartInSafeMode":true}
- **daemon crash, restarted by the OS alone**: {"killed":3632,"kill":{"ok":true,"how":"taskkill /F /PID 3632","code":0,"out":"SUCCESS: The process with PID 3632 has been terminated."},"appSurvived":true,"appPidAfter":1300,"samePid":true,"appStartedTheDaemon":{"atMs":150501,"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-5990c89f"},"appEvents":["57ms daemon-lost","150501ms start-daemon","151005ms connected","151005ms reconnected"]}
- **daemon crash, the app helps after 3 s**: {"killed":9068,"kill":{"ok":true,"how":"taskkill /F /PID 9068","code":0,"out":"SUCCESS: The process with PID 9068 has been terminated."},"daemonBackMs":3445,"newDaemonPid":6744,"appSurvived":true,"appPidAfter":1300,"samePid":true,"appStartedTheDaemon":{"atMs":3140,"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-5990c89f"},"appEvents":["107ms daemon-lost","3140ms start-daemon","3643ms connected","3643ms reconnected"]}
- **tray Quit stops both, and they stay down**: {"forwarded":{"forwarded":true},"bothDownMs":406,"restartedWithin12s":false,"appEvents":["quit","quit-acked"]}
- **a user starts the app → it starts the daemon**: {"start":{"ok":true,"how":"spawn detached","code":0,"out":"7776"},"bothUpMs":553,"startedBy":"user","appStartedTheDaemon":[{"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-5990c89f","out":"SUCCESS: Attempted to run the scheduled task \"\\Clover S7\\core-5990c89f\"."}],"appEvents":["start","tray","start-daemon","connected"]}
- **the daemon side's Quit stops both**: {"bothDownMs":343,"restartedWithin8s":false}

