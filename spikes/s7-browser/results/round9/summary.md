## Spike S7 results

### Chrome for Testing · linux-arm64 (cft-linux-arm64-install.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 5 s

**chrome-headless-shell** — ; sandbox –

- install: 121 MiB archive, 277 MiB unpacked, 287 files, 0 symlinks; download 859 ms, unpack 977 ms; sha256 `5bb6a00a4285c13303d3f72c5afdb70f144ea7a93eed462365a52b69631c9607` (matches the pin; server MD5 true)

**chrome** — ; sandbox –

- install: 191 MiB archive, 401 MiB unpacked, 301 files, 0 symlinks; download 1529 ms, unpack 1358 ms; sha256 `1f496a826c9ba4d6a5f5bf2de686145fe718528c2cc3dbeb96b5893b89653724` (matches the pin; server MD5 true)

**Assertions:** PASS the headless shell installs from its pin

### Chrome for Testing · linux-arm64 (cft-linux-arm64-worker.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 203 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 121 MiB archive, 277 MiB unpacked, 287 files, 0 symlinks; download 859 ms, unpack 977 ms; sha256 `5bb6a00a4285c13303d3f72c5afdb70f144ea7a93eed462365a52b69631c9607` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 58 ms, warm 55 ms; the port for comparison 57 ms
- start attempts: fdpipe ok 58 ms
- tabs: own window: first (background): visible, 1280x800, interval 100.1 Hz, rAF 60.2 Hz; own window: second (front): visible, 1280x800, interval 99.9 Hz, rAF 60.0 Hz; one window: first (background): visible, 1280x800, interval 99.9 Hz, rAF 60.0 Hz; one window: second (front): visible, 1280x800, interval 100.0 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.0 Hz, media ×0.94, decoded 28.8 fps, audio running, set up in 40 ms, browser answers in 0 ms
- resize to 1000×700 and back: 2 ms / 22 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 218 / 229 ms (645 KiB, CPU 334 ms), jpeg 67 / 78 ms (165 KiB, stale -35 / -34 ms, CPU 131 ms)
- screencast: 60.3 fps, 66772 kbit/s, 135 KiB/frame, latency 32 / 33 ms, browser CPU 144%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 175 MiB, per idle tab 30 MiB, 4 browser contexts +119 MiB, a second bot's browser 119 MiB (7 processes), animated tab 52.3% CPU
  - steps: 0 tabs 175 MiB pss / 0.0%, 1 tabs 217 MiB pss / 3.0%, 2 tabs 247 MiB pss / 6.0%, 4 tabs 302 MiB pss / 12.4%, 8 tabs 413 MiB pss / 23.6%

**chrome** — Chrome/156.0.8078.80; sandbox on

- install: 191 MiB archive, 401 MiB unpacked, 301 files, 0 symlinks; download 1529 ms, unpack 1358 ms; sha256 `1f496a826c9ba4d6a5f5bf2de686145fe718528c2cc3dbeb96b5893b89653724` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 216 ms, warm 208 ms; the port for comparison 261 ms
- start attempts: fdpipe ok 216 ms
- tabs: own window: first (background): visible, 1280x657, interval 100.0 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x657, interval 100.0 Hz, rAF 60.0 Hz; one window: first (background): hidden, 1280x657, interval 1.0 Hz, rAF 0.0 Hz; one window: second (front): visible, 1280x657, interval 99.9 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.0 Hz, media ×0.94, decoded 28.8 fps, audio running, set up in 57 ms, browser answers in 0 ms
- resize to 1000×700 and back: 2 ms / 22 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 184 / 192 ms (526 KiB, CPU 296 ms), jpeg 72 / 74 ms (143 KiB, stale -41 / -38 ms, CPU 135 ms)
- screencast: 60.4 fps, 58185 kbit/s, 118 KiB/frame, latency 31 / 31 ms, browser CPU 132%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 424 MiB, per idle tab 57 MiB, 4 browser contexts +338 MiB, a second bot's browser 259 MiB (10 processes), animated tab 55.8% CPU
  - steps: 0 tabs 424 MiB pss / 0.8%, 1 tabs 503 MiB pss / 3.0%, 2 tabs 581 MiB pss / 6.5%, 4 tabs 656 MiB pss / 13.4%, 8 tabs 881 MiB pss / 24.5%

**Assertions:** PASS the headless shell installs from its pin; PASS it starts over the native DevTools pipe; PASS it runs sandboxed; PASS no step failed; PASS every tab is visible and draws (rAF above 10 Hz); PASS screenshots and a screencast arrive, fresh; PASS per-bot profiles are apart and survive a restart

### Chrome for Testing · linux-arm64 (cft-linux-arm64.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 205 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 121 MiB archive, 277 MiB unpacked, 287 files, 0 symlinks; download 859 ms, unpack 977 ms; sha256 `5bb6a00a4285c13303d3f72c5afdb70f144ea7a93eed462365a52b69631c9607` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 1560 ms, warm 46 ms; the port for comparison 55 ms
- start attempts: fdpipe ok 1560 ms
- tabs: own window: first (background): visible, 1280x800, interval 100.1 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x800, interval 100.0 Hz, rAF 60.0 Hz; one window: first (background): visible, 1280x800, interval 99.9 Hz, rAF 60.0 Hz; one window: second (front): visible, 1280x800, interval 100.1 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.0 Hz, media ×0.94, decoded 29.0 fps, audio running, set up in 79 ms, browser answers in 0 ms
- resize to 1000×700 and back: 2 ms / 23 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 232 / 238 ms (634 KiB, CPU 336 ms), jpeg 84 / 99 ms (164 KiB, stale -43 / -34 ms, CPU 141 ms)
- screencast: 60.4 fps, 66696 kbit/s, 135 KiB/frame, latency 48 / 50 ms, browser CPU 144%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 175 MiB, per idle tab 30 MiB, 4 browser contexts +119 MiB, a second bot's browser 118 MiB (7 processes), animated tab 52.3% CPU
  - steps: 0 tabs 175 MiB pss / 0.3%, 1 tabs 217 MiB pss / 3.0%, 2 tabs 247 MiB pss / 6.7%, 4 tabs 302 MiB pss / 13.4%, 8 tabs 413 MiB pss / 25.4%

**chrome** — Chrome/156.0.8078.80; sandbox on

- install: 191 MiB archive, 401 MiB unpacked, 301 files, 0 symlinks; download 1529 ms, unpack 1358 ms; sha256 `1f496a826c9ba4d6a5f5bf2de686145fe718528c2cc3dbeb96b5893b89653724` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 385 ms, warm 202 ms; the port for comparison 261 ms
- start attempts: fdpipe ok 385 ms
- tabs: own window: first (background): visible, 1280x657, interval 100.1 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x657, interval 99.9 Hz, rAF 60.0 Hz; one window: first (background): hidden, 1280x657, interval 2.0 Hz, rAF 0.0 Hz; one window: second (front): visible, 1280x657, interval 99.9 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.0 Hz, media ×0.94, decoded 28.8 fps, audio running, set up in 66 ms, browser answers in 0 ms
- resize to 1000×700 and back: 2 ms / 22 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 183 / 195 ms (508 KiB, CPU 291 ms), jpeg 72 / 75 ms (145 KiB, stale -40 / -36 ms, CPU 136 ms)
- screencast: 60.5 fps, 58336 kbit/s, 118 KiB/frame, latency 31 / 32 ms, browser CPU 134%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 450 MiB, per idle tab 54 MiB, 4 browser contexts +335 MiB, a second bot's browser 288 MiB (12 processes), animated tab 56.8% CPU
  - steps: 0 tabs 450 MiB pss / 1.0%, 1 tabs 526 MiB pss / 3.5%, 2 tabs 606 MiB pss / 7.0%, 4 tabs 681 MiB pss / 13.9%, 8 tabs 884 MiB pss / 25.8%

**Assertions:** PASS the headless shell installs from its pin; PASS it starts over the native DevTools pipe; PASS it runs sandboxed; PASS no step failed; PASS every tab is visible and draws (rAF above 10 Hz); PASS screenshots and a screencast arrive, fresh; PASS per-bot profiles are apart and survive a restart

### Chrome for Testing · linux-x64 (cft-linux-x64-install.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 6 s

**chrome-headless-shell** — ; sandbox –

- install: 121 MiB archive, 274 MiB unpacked, 287 files, 0 symlinks; download 1106 ms, unpack 1417 ms; sha256 `547dcd374e02961bf998f6046a267644f8502225c36bb78ca307dab32a0b3eb4` (matches the pin; server MD5 true)

**chrome** — ; sandbox –

- install: 192 MiB archive, 403 MiB unpacked, 301 files, 0 symlinks; download 844 ms, unpack 1966 ms; sha256 `b711c720f774be355197f32edf37e0651418ba036d92446ee2da19ac017540a7` (matches the pin; server MD5 true)

**Assertions:** PASS the headless shell installs from its pin

### Chrome for Testing · linux-x64 (cft-linux-x64-worker.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 206 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 121 MiB archive, 274 MiB unpacked, 287 files, 0 symlinks; download 1106 ms, unpack 1417 ms; sha256 `547dcd374e02961bf998f6046a267644f8502225c36bb78ca307dab32a0b3eb4` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 71 ms, warm 82 ms; the port for comparison 67 ms
- start attempts: fdpipe ok 71 ms
- tabs: own window: first (background): visible, 1280x800, interval 99.9 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x800, interval 100.1 Hz, rAF 60.0 Hz; one window: first (background): visible, 1280x800, interval 99.9 Hz, rAF 60.2 Hz; one window: second (front): visible, 1280x800, interval 100.1 Hz, rAF 60.1 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.0 Hz, media ×0.94, decoded 28.8 fps, audio running, set up in 42 ms, browser answers in 0 ms
- resize to 1000×700 and back: 2 ms / 23 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 296 / 313 ms (633 KiB, CPU 394 ms), jpeg 82 / 88 ms (154 KiB, stale -46 / -34 ms, CPU 124 ms)
- screencast: 59.5 fps, 65063 kbit/s, 133 KiB/frame, latency 38 / 40 ms, browser CPU 165%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 172 MiB, per idle tab 29 MiB, 4 browser contexts +117 MiB, a second bot's browser 114 MiB (7 processes), animated tab 43.4% CPU
  - steps: 0 tabs 172 MiB pss / 0.3%, 1 tabs 213 MiB pss / 4.0%, 2 tabs 242 MiB pss / 7.0%, 4 tabs 297 MiB pss / 13.7%, 8 tabs 407 MiB pss / 24.1%

**chrome** — Chrome/156.0.8078.80; sandbox on

- install: 192 MiB archive, 403 MiB unpacked, 301 files, 0 symlinks; download 844 ms, unpack 1966 ms; sha256 `b711c720f774be355197f32edf37e0651418ba036d92446ee2da19ac017540a7` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 260 ms, warm 262 ms; the port for comparison 263 ms
- start attempts: fdpipe ok 260 ms
- tabs: own window: first (background): visible, 1280x657, interval 100.1 Hz, rAF 60.2 Hz; own window: second (front): visible, 1280x657, interval 99.9 Hz, rAF 60.0 Hz; one window: first (background): hidden, 1280x657, interval 1.0 Hz, rAF 0.0 Hz; one window: second (front): visible, 1280x657, interval 99.9 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.0 Hz, media ×0.95, decoded 28.8 fps, audio running, set up in 75 ms, browser answers in 0 ms
- resize to 1000×700 and back: 2 ms / 22 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 247 / 273 ms (527 KiB, CPU 360 ms), jpeg 74 / 83 ms (143 KiB, stale -40 / -36 ms, CPU 113 ms)
- screencast: 60.3 fps, 57622 kbit/s, 117 KiB/frame, latency 34 / 37 ms, browser CPU 142%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 412 MiB, per idle tab 60 MiB, 4 browser contexts +328 MiB, a second bot's browser 259 MiB (10 processes), animated tab 35.9% CPU
  - steps: 0 tabs 412 MiB pss / 1.3%, 1 tabs 492 MiB pss / 4.2%, 2 tabs 550 MiB pss / 7.7%, 4 tabs 650 MiB pss / 13.9%, 8 tabs 890 MiB pss / 26.1%

**Assertions:** PASS the headless shell installs from its pin; PASS it starts over the native DevTools pipe; PASS it runs sandboxed; PASS no step failed; PASS every tab is visible and draws (rAF above 10 Hz); PASS screenshots and a screencast arrive, fresh; PASS per-bot profiles are apart and survive a restart

### Chrome for Testing · linux-x64 (cft-linux-x64.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 210 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 121 MiB archive, 274 MiB unpacked, 287 files, 0 symlinks; download 1106 ms, unpack 1417 ms; sha256 `547dcd374e02961bf998f6046a267644f8502225c36bb78ca307dab32a0b3eb4` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 1524 ms, warm 69 ms; the port for comparison 73 ms
- start attempts: fdpipe ok 1524 ms
- tabs: own window: first (background): visible, 1280x800, interval 99.9 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x800, interval 100.1 Hz, rAF 60.0 Hz; one window: first (background): visible, 1280x800, interval 99.9 Hz, rAF 60.0 Hz; one window: second (front): visible, 1280x800, interval 100.1 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.2 Hz, rAF 60.0 Hz, media ×0.92, decoded 29.0 fps, audio running, set up in 201 ms, browser answers in 1 ms
- resize to 1000×700 and back: 3 ms / 21 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 301 / 315 ms (650 KiB, CPU 404 ms), jpeg 85 / 88 ms (153 KiB, stale -47 / -38 ms, CPU 130 ms)
- screencast: 58.4 fps, 63790 kbit/s, 133 KiB/frame, latency 38 / 42 ms, browser CPU 171%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 172 MiB, per idle tab 29 MiB, 4 browser contexts +117 MiB, a second bot's browser 113 MiB (7 processes), animated tab 43.9% CPU
  - steps: 0 tabs 172 MiB pss / 0.0%, 1 tabs 213 MiB pss / 3.7%, 2 tabs 242 MiB pss / 7.5%, 4 tabs 297 MiB pss / 13.5%, 8 tabs 406 MiB pss / 26.1%

**chrome** — Chrome/156.0.8078.80; sandbox on

- install: 192 MiB archive, 403 MiB unpacked, 301 files, 0 symlinks; download 844 ms, unpack 1966 ms; sha256 `b711c720f774be355197f32edf37e0651418ba036d92446ee2da19ac017540a7` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 440 ms, warm 259 ms; the port for comparison 304 ms
- start attempts: fdpipe ok 440 ms
- tabs: own window: first (background): visible, 1280x657, interval 100.1 Hz, rAF 60.1 Hz; own window: second (front): visible, 1280x657, interval 100.0 Hz, rAF 60.2 Hz; one window: first (background): hidden, 1280x657, interval 1.0 Hz, rAF 0.0 Hz; one window: second (front): visible, 1280x657, interval 99.9 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.0 Hz, media ×0.94, decoded 29.0 fps, audio running, set up in 100 ms, browser answers in 0 ms
- resize to 1000×700 and back: 2 ms / 22 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 273 / 278 ms (530 KiB, CPU 369 ms), jpeg 89 / 92 ms (137 KiB, stale -40 / -35 ms, CPU 114 ms)
- screencast: 60.1 fps, 57284 kbit/s, 116 KiB/frame, latency 50 / 54 ms, browser CPU 142%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 436 MiB, per idle tab 60 MiB, 4 browser contexts +325 MiB, a second bot's browser 285 MiB (12 processes), animated tab 36.4% CPU
  - steps: 0 tabs 436 MiB pss / 1.3%, 1 tabs 516 MiB pss / 3.7%, 2 tabs 572 MiB pss / 7.2%, 4 tabs 675 MiB pss / 13.7%, 8 tabs 917 MiB pss / 24.1%

**Assertions:** PASS the headless shell installs from its pin; PASS it starts over the native DevTools pipe; PASS it runs sandboxed; PASS no step failed; PASS every tab is visible and draws (rAF above 10 Hz); PASS screenshots and a screencast arrive, fresh; PASS per-bot profiles are apart and survive a restart

### Chrome for Testing · darwin-arm64 (cft-macos-install.json)

25.6.0, 3 CPUs, 7 GiB, Bun 1.3.14, status **done**, 5 s

**chrome-headless-shell** — ; sandbox –

- install: 99 MiB archive, 204 MiB unpacked, 16 files, 0 symlinks; download 621 ms, unpack 1000 ms; sha256 `ea615baa2e9caf0d02d1898a6562b5f8fa9c35239707dae0f592178df5b986ac` (matches the pin; server MD5 true)

**chrome** — ; sandbox –

- install: 186 MiB archive, 366 MiB unpacked, 344 files, 5 symlinks; download 949 ms, unpack 1797 ms; sha256 `8bc590d1b1acac042a000234c768f31830f25a3983a83ed5e067114c87c4cad1` (matches the pin; server MD5 true)

**Assertions:** PASS the headless shell installs from its pin

### Chrome for Testing · darwin-arm64 (cft-macos.json)

25.6.0, 3 CPUs, 7 GiB, Bun 1.3.14, status **done**, 244 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 99 MiB archive, 204 MiB unpacked, 16 files, 0 symlinks; download 621 ms, unpack 1000 ms; sha256 `ea615baa2e9caf0d02d1898a6562b5f8fa9c35239707dae0f592178df5b986ac` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 1048 ms, warm 124 ms; the port for comparison 117 ms
- start attempts: fdpipe ok 1048 ms
- tabs: own window: first (background): visible, 1280x800, interval 70.4 Hz, rAF 46.1 Hz; own window: second (front): visible, 1280x800, interval 71.2 Hz, rAF 42.9 Hz; one window: first (background): visible, 1280x800, interval 68.3 Hz, rAF 44.5 Hz; one window: second (front): visible, 1280x800, interval 69.3 Hz, rAF 46.2 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 62.1 Hz, rAF 28.2 Hz, media ×0.92, decoded 28.6 fps, audio running, set up in 225 ms, browser answers in 0 ms
- resize to 1000×700 and back: 15 ms / 28 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 410 / 483 ms (613 KiB, CPU 531 ms), jpeg 140 / 222 ms (141 KiB, stale -53 / -38 ms, CPU 165 ms)
- screencast: 36.8 fps, 35126 kbit/s, 117 KiB/frame, latency 65 / 106 ms, browser CPU 97%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 44 MiB, per idle tab 46 MiB, 4 browser contexts +179 MiB, a second bot's browser 44 MiB (4 processes), animated tab 23.5% CPU
  - steps: 0 tabs 44 MiB footprint / 1.0%, 1 tabs 90 MiB footprint / 3.0%, 2 tabs 136 MiB footprint / 6.9%, 4 tabs 227 MiB footprint / 11.9%, 8 tabs 409 MiB footprint / 22.6%

**chrome** — Chrome/156.0.8078.80; sandbox on

- install: 186 MiB archive, 366 MiB unpacked, 344 files, 5 symlinks; download 949 ms, unpack 1797 ms; sha256 `8bc590d1b1acac042a000234c768f31830f25a3983a83ed5e067114c87c4cad1` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 2886 ms, warm 1071 ms; the port for comparison 1602 ms
- start attempts: fdpipe ok 2886 ms
- tabs: own window: first (background): visible, 1280x657, interval 57.9 Hz, rAF 24.8 Hz; own window: second (front): hidden, 1280x657, interval 1.0 Hz, rAF 0.0 Hz; one window: first (background): hidden, 1280x657, interval 1.2 Hz, rAF 0.0 Hz; one window: second (front): visible, 1280x657, interval 60.8 Hz, rAF 23.3 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 63.1 Hz, rAF 25.8 Hz, media ×0.97, decoded 29.4 fps, audio running, set up in 535 ms, browser answers in 0 ms
- resize to 1000×700 and back: 11 ms / 45 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 262 / 332 ms (460 KiB, CPU 206 ms), jpeg 160 / 222 ms (115 KiB, stale -75 / -35 ms, CPU 74 ms)
- screencast: 24.6 fps, 20583 kbit/s, 102 KiB/frame, latency 80 / 127 ms, browser CPU 35%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 265 MiB, per idle tab 58 MiB, 4 browser contexts +435 MiB, a second bot's browser 269 MiB (10 processes), animated tab 8.8% CPU
  - steps: 0 tabs 265 MiB footprint / 3.2%, 1 tabs 369 MiB footprint / 4.7%, 2 tabs 425 MiB footprint / 5.0%, 4 tabs 518 MiB footprint / 6.4%, 8 tabs 729 MiB footprint / 6.3%

**Assertions:** PASS the headless shell installs from its pin; PASS it starts over the native DevTools pipe; PASS it runs sandboxed; PASS no step failed; PASS every tab is visible and draws (rAF above 10 Hz); PASS screenshots and a screencast arrive, fresh; PASS per-bot profiles are apart and survive a restart

### Chrome for Testing · win32-x64 (cft-windows-install.json)

10.0.26100, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 7 s

**chrome-headless-shell** — ; sandbox –

- install: 120 MiB archive, 282 MiB unpacked, 288 files, 0 symlinks; download 1526 ms, unpack 1590 ms; sha256 `10a77466005e7f64e00f1a75fd1ea81f4a38a60093c65fea6895843b26e60a9a` (matches the pin; server MD5 true)

**chrome** — ; sandbox –

- install: 199 MiB archive, 439 MiB unpacked, 305 files, 0 symlinks; download 1365 ms, unpack 2298 ms; sha256 `16edb57d6107bf1c48a7c149b8d78b155fe614410093796dd72441fd6640540f` (matches the pin; server MD5 true)

**Assertions:** PASS the headless shell installs from its pin

### Chrome for Testing · win32-x64 (cft-windows.json)

10.0.26100, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 222 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 120 MiB archive, 282 MiB unpacked, 288 files, 0 symlinks; download 1526 ms, unpack 1590 ms; sha256 `10a77466005e7f64e00f1a75fd1ea81f4a38a60093c65fea6895843b26e60a9a` (matches the pin; server MD5 true)
- start: over **winpipe**, cold 151 ms, warm 70 ms; the port for comparison 90 ms
- start attempts: winpipe ok 151 ms
- tabs: own window: first (background): visible, 1280x800, interval 100.0 Hz, rAF 59.9 Hz; own window: second (front): visible, 1280x800, interval 99.9 Hz, rAF 60.0 Hz; one window: first (background): visible, 1280x800, interval 100.1 Hz, rAF 60.0 Hz; one window: second (front): visible, 1280x800, interval 99.9 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 99.9 Hz, rAF 60.1 Hz, media ×0.99, decoded 29.2 fps, audio running, set up in 49 ms, browser answers in 5 ms
- resize to 1000×700 and back: 8 ms / 9 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 212 / 219 ms (581 KiB, CPU 277 ms), jpeg 72 / 84 ms (142 KiB, stale -40 / -38 ms, CPU 64 ms)
- screencast: 60.6 fps, 56182 kbit/s, 113 KiB/frame, latency 31 / 33 ms, browser CPU 85%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 68 MiB, per idle tab 30 MiB, 4 browser contexts +124 MiB, a second bot's browser 72 MiB (5 processes), animated tab 27.5% CPU
  - steps: 0 tabs 68 MiB privateBytes / 0.0%, 1 tabs 99 MiB privateBytes / 5.1%, 2 tabs 130 MiB privateBytes / 6.9%, 4 tabs 189 MiB privateBytes / 3.3%, 8 tabs 311 MiB privateBytes / 13.4%

**chrome** — Chrome/156.0.8078.80; sandbox on

- install: 199 MiB archive, 439 MiB unpacked, 305 files, 0 symlinks; download 1365 ms, unpack 2298 ms; sha256 `16edb57d6107bf1c48a7c149b8d78b155fe614410093796dd72441fd6640540f` (matches the pin; server MD5 true)
- start: over **winpipe**, cold 512 ms, warm 293 ms; the port for comparison 327 ms
- start attempts: winpipe ok 512 ms
- tabs: own window: first (background): visible, 1264x649, interval 100.0 Hz, rAF 60.1 Hz; own window: second (front): visible, 1264x649, interval 100.0 Hz, rAF 59.9 Hz; one window: first (background): hidden, 1264x649, interval 1.0 Hz, rAF 0.0 Hz; one window: second (front): visible, 1264x649, interval 100.0 Hz, rAF 60.1 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 99.8 Hz, rAF 59.9 Hz, media ×0.99, decoded 29.1 fps, audio running, set up in 36 ms, browser answers in 4 ms
- resize to 1000×700 and back: 10 ms / 35 ms, same document true (1264 → 1000 → 1264)
- screenshots: png 182 / 196 ms (459 KiB, CPU 281 ms), jpeg 74 / 82 ms (114 KiB, stale -49 / -36 ms, CPU 63 ms)
- screencast: 60.8 fps, 47613 kbit/s, 96 KiB/frame, latency 27 / 31 ms, browser CPU 70%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 272 MiB, per idle tab 51 MiB, 4 browser contexts +480 MiB, a second bot's browser 270 MiB (12 processes), animated tab 23.9% CPU
  - steps: 0 tabs 272 MiB privateBytes / 0.0%, 1 tabs 348 MiB privateBytes / 2.9%, 2 tabs 405 MiB privateBytes / 4.7%, 4 tabs 451 MiB privateBytes / 6.2%, 8 tabs 677 MiB privateBytes / 9.1%

**Assertions:** PASS the headless shell installs from its pin; PASS it starts over the native DevTools pipe; PASS it runs sandboxed; PASS no step failed; PASS every tab is visible and draws (rAF above 10 Hz); PASS screenshots and a screencast arrive, fresh; PASS per-bot profiles are apart and survive a restart

### Electron · linux-arm64-ozone-headless (electron-linux-arm64-ozone-headless.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-arm64 7.0.0-1017-azure, ozone headless, displays 1920x1080@1, status **done**, 573 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.94 | 28.5 | 43 / 82 | 1 / 5 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.95 | 28.4 | 27 / 49 | 4 / 5 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.4 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.96 | 28.4 | 32 / 42 | 5 / 18 | 1280x800@1 → 1000x700@1 → 1280x800 | 1 / 1 | 2.4 |  |
| invisibleWindow | true | true | true | true (1) | 0.96 | 28.7 | 25 / 41 | 1 / 5 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.0 |  |
| tinyWindow | true | true | true | true (1) | 0.96 | 28.6 | 28 / 41 | 0 / 4 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.0 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | IO / RO Hz | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 100.1 | 99.1 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 4.8 | 6.8 |  |
| detached, throttling on (default) | hidden | 1280x800 | 1.4 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.4 |  |
| detached, throttling off | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.8 | 0.8 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 1.4 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.0 |  |
| never-shown window, throttling off | visible | 1280x800 | 100.1 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.8 | 1.2 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 100.1 | 99.3 | 1.0 | 1017 | 0.0 / 0.0 | – | – | – | 1.0 | 1.4 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 100.1 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 1.0 | 1.6 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 100.1 | 99.3 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 1.0 | 1.0 |  |
| invisible shown window, throttling off | visible | 1280x800 | 100.0 | 99.2 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 5.0 | 7.4 |  |
| 1x1 shown window, throttling off | visible | 1280x800 | 100.0 | 99.2 | 60.2 | 17 | 2.2 / 2.2 | – | – | – | 4.8 | 6.2 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 100.0 | 99.4 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 5.0 | 6.6 | cover 0,0 1920x1080 over host 0,0 1x1 |
| 1x1 shown window kept above a cover window (always on top) | visible | 1280x800 | 99.9 | 99.1 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 5.0 | 6.2 | cover 0,0 1920x1080 over host 0,0 1x1 |
| invisible shown window, covered by another window | visible | 1280x800 | 100.0 | 99.2 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 5.0 | 7.0 | cover -1480,-1000 1920x1080 over host -1480,-1000 1280x800 |
| 1x1 shown window, throttling on (control) | visible | 1280x800 | 99.9 | 99.1 | 60.2 | 17 | 2.2 / 2.2 | – | – | – | 4.6 | 6.2 |  |
| 1x1 shown window, throttling on, covered by another window (control) | visible | 1280x800 | 99.9 | 99.3 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 4.8 | 6.2 | cover 0,0 1920x1080 over host 0,0 1x1 |
| invisible shown window, throttling on, covered by another window (control) | visible | 1280x800 | 100.0 | 99.2 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 4.8 | 6.8 | cover -1480,-1000 1920x1080 over host -1480,-1000 1280x800 |
| osr window 30 fps, throttling off | visible | 1280x800 | 100.0 | 99.2 | 30.0 | 34 | 2.0 / 2.0 | – | – | – | 3.8 | 12.4 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 100.2 | 99.2 | 30.0 | 34 | 0.0 / 2.2 | – | – | – | 2.0 | 2.4 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 99.9 | 99.3 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 25.4 | – | 2.6 | 3.6 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 100.0 | 99.4 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 26.0 | – | 2.4 | 3.0 |  |
| detached, throttling off, playing media | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 25.8 | – | 2.4 | 3.0 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 100.1 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | to 1280×800 + JPEG ms | CPU ms/picture | frames/s | visibility events | geometry; errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 17 / 18 | 4 / 6 | 1000x700 | 14 / 15 | 80 | – |  | view 0,0 1000x700 in content 40,65 1000x700; page 1000x700 at 1x |
| shown | true | capturePage | 6/6 | 6 | 18 / 19 | 4 / 6 | 1000x700 | 14 / 14 | 80 | – |  | view 0,0 1000x700 in content 40,65 1000x700; page 1000x700 at 1x |
| shown | true | cdpJpeg | 6/6 | 6 | 68 / 81 | -45 / -33 | 1000x700 | – | 88 | – |  | view 0,0 1000x700 in content 40,65 1000x700; page 1000x700 at 1x |
| shown | true | frameSub | 6/6 | 6 | 15 / 19 | 8 / 10 | 1000x700 | – | 53 | – |  | view 0,0 1000x700 in content 40,65 1000x700; page 1000x700 at 1x |
| shown | true | cdpPng | 6/6 | 6 | 172 / 184 | -46 / -35 | 1000x700 | – | 218 | – |  | view 0,0 1000x700 in content 40,65 1000x700; page 1000x700 at 1x |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 65 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | – | 55 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | – | 3 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 4047 / 4049 | -2995 / -41 | 1280x800 | – | 130 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x |
| hiddenWindow | false | frameSub | 6/6 | 6 | 7 / 8 | 61 / 75 | 1280x800 | – | 45 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.5 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 98 / 99 | -61 / -30 | 1280x800 | – | 148 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 15 / 16 | 8 / 9 | 1280x800 | – | 83 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 6/6 | 6 | 14 / 16 | 9 / 12 | 1280x800 | – | 73 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | capturePage | 6/6 | 6 | 15 / 15 | 9 / 11 | 1280x800 | – | 68 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 78 / 86 | -45 / -39 | 1280x800 | – | 118 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | frameSub | 6/6 | 6 | 15 / 19 | 11 / 12 | 1280x800 | – | 70 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 14 / 17 | 10 / 17 | 1280x800 | – | 60 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | capturePage | 6/6 | 6 | 15 / 15 | 9 / 15 | 1280x800 | – | 60 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 79 / 85 | -44 / -39 | 1280x800 | – | 103 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | frameSub | 6/6 | 6 | 15 / 20 | 11 / 12 | 1280x800 | – | 60 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 14 / 15 | 9 / 13 | 1280x800 | – | 60 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 14 / 16 | 9 / 13 | 1280x800 | – | 60 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 80 / 87 | -44 / -37 | 1280x800 | – | 105 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 15 / 19 | 11 / 12 | 1280x800 | – | 57 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePageHidden | 6/6 | 6 | 14 / 16 | 9 / 14 | 1280x800 | – | 62 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | capturePage | 6/6 | 6 | 14 / 15 | 10 / 12 | 1280x800 | – | 63 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | cdpJpeg | 6/6 | 6 | 81 / 84 | -44 / -38 | 1280x800 | – | 102 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | frameSub | 6/6 | 6 | 15 / 19 | 11 / 12 | 1280x800 | – | 62 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 54 / 60 | 1280x800 | – | 37 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | capturePage | 6/6 | 6 | 31 / 32 | 9 / 31 | 1280x800 | – | 55 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | cdpJpeg | 6/6 | 6 | 131 / 141 | -79 / -78 | 1280x800 | – | 107 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | – | 160 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 135 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 240 | pss | 511 | 4 | 0.0 |
| 1 | 269 | pss | 628 | 5 | 0.5 |
| 2 | 284 | pss | 748 | 6 | 0.0 |
| 4 | 315 | pss | 987 | 8 | 0.0 |
| 8 | 372 | pss | 1462 | 12 | 0.5 |

Per idle tab resting in the never-shown window (a still page): **17 MiB**, 0.06% CPU. Four tabs: one partition +66 MiB, four partitions +73 MiB.

Quiet tabs working in one shared 1×1 host (no rAF loop; the page repaints twice a second): **29 MiB** and 0.94% CPU a tab (0: 265 MiB / 0.0%, 1: 307 MiB / 1.0%, 4: 388 MiB / 3.5%, 8: 494 MiB / 7.5%).

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 34.7 | 27.7 | 6.8 | 60 |
| animated, never-shown window, throttling off | 0.8 | 0.8 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.0 | 0.0 | 0.0 | 0 |
| animated, never-shown window, throttling off + frame pump | 1.8 | 1.0 | 0.5 | 0 |
| animated, invisible shown window | 47.5 | 37.7 | 9.8 | 60 |
| animated, 1x1 shown window | 39.0 | 37.5 | 1.5 | 60 |
| animated, osr 30 fps | 32.5 | 20.0 | 5.5 | 30 |

**Waking a resting tab into the host** (never-shown window, throttling on, 4 cycles): first rAF 1 / 2 ms, fresh picture 16 / 28 ms; resting rates 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0; awake rAF 60, 60, 60, 60

**One host, 4 tabs (each held at 1280×800, 1×):** tab 1 rAF 60 Hz, capturePage 4/4 in 13 / 16 ms (1280x800); tab 2 rAF 60 Hz, capturePage 4/4 in 14 / 15 ms (1280x800); tab 3 rAF 60 Hz, capturePage 4/4 in 14 / 17 ms (1280x800); tab 4 rAF 60 Hz, capturePage 4/4 in 14 / 17 ms (1280x800)

**The host's invariants:** host 0,0 1x1, focused at start false, after its page grabs focus false (focused window "S7 browser view"); Windows styles –; click-through not testable here (macOS needs Accessibility for synthetic clicks; Wayland and no display have no global input)

**Assertions:** PASS no reload when moving from detached; PASS no reload when moving from hiddenWindow; PASS no reload when moving from hiddenWindowFit; PASS no reload when moving from invisibleWindow; PASS no reload when moving from tinyWindow; PASS the 1x1 host draws (rAF above 10 Hz); PASS a never-shown window draws nothing (rAF below 1 Hz); PASS capturePage works in the 1x1 host; PASS capturePage works in the 1x1 host with the agent's 1280x800 at 1x held; PASS the host never takes focus, even when its page asks; PASS a resting tab draws within 2 s of moving into the host, every cycle; PASS every tab in one shared host draws and is pictured

### Electron · linux-wayland (electron-linux-wayland.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone wayland, displays 1920x1080@1, status **done**, 837 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.90 | 27.5 | 46 / 217 | 1 / 181 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.93 | 27.9 | 39 / 45 | 0 / 2 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.1 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.93 | 27.8 | 44 / 49 | 1 / 4 | 1280x800@1 → 1000x700@1 → 1280x800 | 1 / 1 | 0.1 |  |
| tinyWindow | true | true | true | true (1) | 0.96 | 28.6 | 46 / 51 | 4 / 21 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 40.7 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | IO / RO Hz | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 100.1 | 99.1 | 39.8 | 26 | 2.0 / 2.0 | – | – | – | 3.8 | 7.6 |  |
| detached, throttling on (default) | hidden | 1280x800 | 2.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.2 | 0.8 |  |
| detached, throttling off | visible | 1280x800 | 100.0 | 99.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 1.0 | 1.2 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 2.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.2 | 0.6 |  |
| never-shown window, throttling off | visible | 1280x800 | 100.1 | 98.9 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.8 | 1.0 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 100.1 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 1.2 | 1.8 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 100.1 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 1.2 | 1.4 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 100.0 | 99.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 1.0 | 1.2 |  |
| invisible shown window, throttling off | – | – | – | – | – | – | – | – | – | – | – | – | not possible here |
| 1x1 shown window, throttling off | visible | 1280x800 | 100.2 | 99.2 | 39.8 | 26 | 2.0 / 2.0 | – | – | – | 4.0 | 6.6 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 99.9 | 99.1 | 39.8 | 26 | 2.0 / 2.0 | – | – | – | 4.2 | 7.0 | cover -10,-10 1940x1100 over host 0,0 1x1 |
| 1x1 shown window kept above a cover window (always on top) | visible | 1280x800 | 100.0 | 99.2 | 39.8 | 26 | 2.0 / 1.8 | – | – | – | 4.4 | 7.4 | cover -10,-10 1940x1100 over host 0,0 1x1 |
| invisible shown window, covered by another window | – | – | – | – | – | – | – | – | – | – | – | – | not possible here |
| 1x1 shown window, throttling on (control) | visible | 1280x800 | 100.0 | 99.2 | 40.0 | 26 | 2.2 / 2.2 | – | – | – | 4.0 | 6.4 |  |
| 1x1 shown window, throttling on, covered by another window (control) | visible | 1280x800 | 100.0 | 99.2 | 40.0 | 26 | 2.2 / 2.2 | – | – | – | 4.2 | 6.8 | cover -10,-10 1940x1100 over host 0,0 1x1 |
| invisible shown window, throttling on, covered by another window (control) | – | – | – | – | – | – | – | – | – | – | – | – | not possible here |
| osr window 30 fps, throttling off | visible | 1280x800 | 100.0 | 99.2 | 30.0 | 34 | 2.0 / 2.0 | – | – | – | 3.6 | 14.2 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 99.9 | 99.1 | 30.0 | 34 | 0.0 / 2.0 | – | – | – | 2.0 | 2.4 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 26.0 | – | 2.2 | 3.0 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 26.0 | – | 2.4 | 3.4 |  |
| detached, throttling off, playing media | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 26.0 | – | 2.4 | 3.6 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | to 1280×800 + JPEG ms | CPU ms/picture | frames/s | visibility events | geometry; errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 11 / 15 | 46 / 51 | 1000x700 | 16 / 20 | 68 | – |  | view 0,0 1000x700 in content 40,104 1000x700; page 1000x700 at 1x |
| shown | true | capturePage | 6/6 | 6 | 12 / 13 | 46 / 50 | 1000x700 | 16 / 17 | 58 | – |  | view 0,0 1000x700 in content 40,104 1000x700; page 1000x700 at 1x |
| shown | true | cdpJpeg | 6/6 | 6 | 131 / 137 | -61 / -55 | 1000x700 | – | 80 | – |  | view 0,0 1000x700 in content 40,104 1000x700; page 1000x700 at 1x |
| shown | true | frameSub | 6/6 | 6 | 27 / 29 | 35 / 52 | 1000x700 | – | 40 | – |  | view 0,0 1000x700 in content 40,104 1000x700; page 1000x700 at 1x |
| shown | true | cdpPng | 6/6 | 6 | 264 / 280 | -66 / -65 | 1000x700 | – | 218 | – |  | view 0,0 1000x700 in content 40,104 1000x700; page 1000x700 at 1x |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 29.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | – | 3 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 80 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | – | 75 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content 320,185 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 320,185 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 85 | – |  | view 0,0 1280x800 in content 320,185 1280x800; page 1280x800 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| hiddenWindow | false | frameSub | 0/2 | 0 | – | – | - | – | 60 | – |  | view 0,0 1280x800 in content 320,185 1280x800; page 1280x800 at 1x; frame subscription: timed out after 5000 ms |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 320,185 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 320,185 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 80 | – |  | view 0,0 1280x800 in content 320,185 1280x800; page 1280x800 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| hiddenWindow + pump | false | frameSub | 0/2 | 0 | – | – | - | – | 60 | – |  | view 0,0 1280x800 in content 320,185 1280x800; page 1280x800 at 1x; frame subscription: timed out after 5000 ms |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| invisibleWindow | false | - | 0/0 | 0 | – | – | - | – | – | – |  | not possible here |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 22 / 24 | 37 / 40 | 1280x800 | – | 52 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | capturePage | 6/6 | 6 | 23 / 26 | 38 / 42 | 1280x800 | – | 50 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 137 / 149 | -73 / -51 | 1280x800 | – | 85 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | frameSub | 6/6 | 6 | 24 / 34 | 40 / 42 | 1280x800 | – | 47 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.5 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 22 / 24 | 37 / 47 | 1280x800 | – | 47 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 22 / 23 | 37 / 39 | 1280x800 | – | 43 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 136 / 153 | -70 / -50 | 1280x800 | – | 82 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 22 / 34 | 41 / 42 | 1280x800 | – | 45 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.5 |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePageHidden | 6/6 | 6 | 22 / 25 | 38 / 42 | 1280x800 | – | 48 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | capturePage | 6/6 | 6 | 22 / 24 | 36 / 38 | 1280x800 | – | 40 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | cdpJpeg | 6/6 | 6 | 147 / 153 | -74 / -63 | 1280x800 | – | 85 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | frameSub | 6/6 | 6 | 23 / 32 | 40 / 41 | 1280x800 | – | 48 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.5 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 28 / 35 | 1280x800 | – | 27 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | capturePage | 6/6 | 6 | 30 / 41 | -18 / -16 | 1280x800 | – | 55 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | cdpJpeg | 6/6 | 6 | 98 / 128 | -70 / -68 | 1280x800 | – | 87 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | – | 183 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | – | 5 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 130 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 331 | pss | 600 | 4 | 0.5 |
| 1 | 360 | pss | 706 | 5 | 0.3 |
| 2 | 375 | pss | 812 | 6 | 0.8 |
| 4 | 404 | pss | 1026 | 8 | 0.8 |
| 8 | 458 | pss | 1455 | 12 | 1.3 |

Per idle tab resting in the never-shown window (a still page): **16 MiB**, 0.09% CPU. Four tabs: one partition +66 MiB, four partitions +70 MiB.

Quiet tabs working in one shared 1×1 host (no rAF loop; the page repaints twice a second): **28 MiB** and 1.06% CPU a tab (0: 356 MiB / 1.0%, 1: 396 MiB / 1.5%, 4: 475 MiB / 5.0%, 8: 580 MiB / 9.5%).

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 21.5 | 14.0 | 6.5 | 39 |
| animated, never-shown window, throttling off | 1.3 | 1.0 | 0.3 | 0 |
| animated, never-shown window, throttling on | 0.3 | 0.0 | 0.3 | 0 |
| animated, never-shown window, throttling off + frame pump | 1.3 | 1.0 | 0.3 | 0 |
| animated, 1x1 shown window | 18.5 | 15.3 | 1.8 | 40 |
| animated, osr 30 fps | 27.2 | 13.7 | 4.3 | 30 |

**Waking a resting tab into the host** (never-shown window, throttling on, 4 cycles): first rAF 1 / 2 ms, fresh picture 18 / 34 ms; resting rates 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0; awake rAF 41, 41, 40, 40

**One host, 4 tabs (each held at 1280×800, 1×):** tab 1 rAF 40 Hz, capturePage 4/4 in 21 / 26 ms (1280x800); tab 2 rAF 40 Hz, capturePage 4/4 in 22 / 24 ms (1280x800); tab 3 rAF 40 Hz, capturePage 4/4 in 22 / 23 ms (1280x800); tab 4 rAF 40 Hz, capturePage 4/4 in 23 / 26 ms (1280x800)

**The host's invariants:** host 0,0 1x1, focused at start false, after its page grabs focus false (focused window "(none)"); Windows styles –; click-through not testable here (macOS needs Accessibility for synthetic clicks; Wayland and no display have no global input)

**Assertions:** PASS no reload when moving from detached; PASS no reload when moving from hiddenWindow; PASS no reload when moving from hiddenWindowFit; PASS no reload when moving from tinyWindow; PASS the 1x1 host draws (rAF above 10 Hz); PASS a never-shown window draws nothing (rAF below 1 Hz); PASS capturePage works in the 1x1 host; PASS capturePage works in the 1x1 host with the agent's 1280x800 at 1x held; PASS the host never takes focus, even when its page asks; PASS a resting tab draws within 2 s of moving into the host, every cycle; PASS every tab in one shared host draws and is pictured

**Q6 streamed view** (10 s at the viewer; latency p50 / p95 ms)

| road | content | source | fps | decoded fps | latency | gap p95 | kbit/s | bytes/frame | sender CPU % | viewer CPU % | source rAF | notes |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| screencast | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | 0 |  |
| capturePoll | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | getUserMedia(tab): AbortError: Timeout starting video source; then getDisplayMedia: AbortError: Timeout starting video source |
| webrtc-h264 | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | getUserMedia(tab): AbortError: Timeout starting video source; then getDisplayMedia: AbortError: Timeout starting video source |
| webcodecs-vp8 | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | getUserMedia(tab): AbortError: Timeout starting video source; then getDisplayMedia: AbortError: Timeout starting video source |
| webcodecs-h264 | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | getUserMedia(tab): AbortError: Timeout starting video source; then getDisplayMedia: AbortError: Timeout starting video source |
| screencast | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | 0 |  |
| capturePoll | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | getUserMedia(tab): AbortError: Timeout starting video source; then getDisplayMedia: AbortError: Timeout starting video source |
| webrtc-h264 | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | getUserMedia(tab): AbortError: Timeout starting video source; then getDisplayMedia: AbortError: Timeout starting video source |
| webcodecs-vp8 | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | getUserMedia(tab): AbortError: Timeout starting video source; then getDisplayMedia: AbortError: Timeout starting video source |
| webcodecs-h264 | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | getUserMedia(tab): AbortError: Timeout starting video source; then getDisplayMedia: AbortError: Timeout starting video source |
| screencast | anim | invisibleWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | not possible here |
| capturePoll | anim | invisibleWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | not possible here |
| webcodecs-h264 | anim | invisibleWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | not possible here |
| screencast | anim | tinyWindow | 39.8 | 39.8 | 73 / 74 | 27 | 43938 | 137649 | 104 | 26 | 40 |  |
| webcodecs-h264 | anim | tinyWindow | 30.1 | 30.1 | 68 / 70 | 52 | 2375 | 9864 | 83 | 18 | 40 |  |
| screencast | anim | shown | 38.5 | 38.5 | 70 / 71 | 28 | 35204 | 114596 | 78 | 20 | 38 |  |
| webrtc-vp8 | anim | shown | 20.5 | 20.5 | 87 / 95 | 80 | 2505 | 15275 | 92 | 18 | 38 | libvpx; video/VP8 |
| webcodecs-h264 | anim | shown | 30.1 | 30.1 | 75 / 78 | 54 | 2408 | 10002 | 96 | 19 | 38 |  |

### Electron · linux-x11-dsf2 (electron-linux-x11-dsf2.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone x11, displays 960x540@2, status **done**, 282 s

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | to 1280×800 + JPEG ms | CPU ms/picture | frames/s | visibility events | geometry; errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 27 / 29 | 30 / 33 | 2000x1400 | 18 / 19 | 135 | – |  | view 0,0 1000x700 in content 40,67 960x540; page 1000x700 at 2x |
| shown | true | capturePage | 6/6 | 6 | 25 / 28 | 32 / 33 | 2000x1400 | 18 / 22 | 143 | – |  | view 0,0 1000x700 in content 40,67 960x540; page 1000x700 at 2x |
| shown | true | cdpJpeg | 6/6 | 6 | 127 / 134 | -47 / -36 | 2000x1400 | – | 183 | – |  | view 0,0 1000x700 in content 40,67 960x540; page 1000x700 at 2x |
| shown | true | frameSub | 6/6 | 6 | 45 / 47 | 19 / 23 | 2000x1400 | – | 117 | – |  | view 0,0 1000x700 in content 40,67 960x540; page 1000x700 at 2x |
| shown | true | cdpPng | 6/6 | 6 | 292 / 307 | -39 / -35 | 2000x1400 | – | 452 | – |  | view 0,0 1000x700 in content 40,67 960x540; page 1000x700 at 2x |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 29.5 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 25 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | – | 45 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content 0,27 960x540; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content 0,27 960x540; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 4043 / 4044 | -2949 / -49 | 2560x1600 | – | 125 | – |  | view 0,0 1280x800 in content 0,27 960x540; page 1280x800 at 2x |
| hiddenWindow | false | frameSub | 6/6 | 6 | 33 / 34 | 63 / 117 | 2560x1600 | – | 82 | – |  | view 0,0 1280x800 in content 0,27 960x540; page 1280x800 at 2x |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.5 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content 0,27 960x540; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content 0,27 960x540; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 129 / 160 | -51 / -35 | 2560x1600 | – | 308 | – |  | view 0,0 1280x800 in content 0,27 960x540; page 1280x800 at 2x |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 52 / 61 | 6 / 27 | 2560x1600 | – | 187 | – |  | view 0,0 1280x800 in content 0,27 960x540; page 1280x800 at 2x |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 29.5 |  |  |
| invisibleWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content -1480,-1000 960x540; page 1280x800 at 2x; Current display surface not available for capture |
| invisibleWindow | false | capturePage | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content -1480,-1000 960x540; page 1280x800 at 2x; Current display surface not available for capture |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 127 / 130 | -41 / -38 | 2560x1600 | – | 220 | – |  | view 0,0 1280x800 in content -1480,-1000 960x540; page 1280x800 at 2x |
| invisibleWindow | false | frameSub | 6/6 | 6 | 59 / 61 | 1 / 16 | 2560x1600 | – | 145 | – |  | view 0,0 1280x800 in content -1480,-1000 960x540; page 1280x800 at 2x |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 29.5 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 36 / 40 | 12 / 17 | 2560x1600 | 22 / 27 | 100 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 2x |
| tinyWindow | false | capturePage | 6/6 | 6 | 38 / 40 | 11 / 16 | 2560x1600 | 20 / 26 | 97 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 2x |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 127 / 133 | -44 / -39 | 2560x1600 | – | 113 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 2x |
| tinyWindow | false | frameSub | 6/6 | 6 | 45 / 58 | 15 / 16 | 2560x1600 | – | 102 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 2x |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 29.5 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 41 / 51 | 28 / 31 | 2560x1600 | 21 / 26 | 97 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 2x |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 39 / 39 | 29 / 33 | 2560x1600 | 21 / 27 | 102 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 2x |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 143 / 148 | -44 / -37 | 2560x1600 | – | 115 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 2x |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 45 / 58 | 32 / 33 | 2560x1600 | – | 102 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 2x |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 29.5 |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePageHidden | 6/6 | 6 | 38 / 39 | 12 / 17 | 2560x1600 | 21 / 26 | 98 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | capturePage | 6/6 | 6 | 39 / 47 | 11 / 14 | 2560x1600 | 21 / 28 | 100 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | cdpJpeg | 6/6 | 6 | 64 / 65 | -47 / -36 | 1280x800 | – | 52 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | frameSub | 6/6 | 6 | 57 / 61 | -14 / 0 | 2560x1600 | – | 102 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 29.5 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 38 / 40 | 960x540 | – | 12 | – |  | view - in content 0,0 960x540; page 960x540 at 1x |
| osr | false | capturePage | 6/6 | 6 | 23 / 28 | 13 / 14 | 960x540 | 9 / 9 | 25 | – |  | view - in content 0,0 960x540; page 960x540 at 1x |
| osr | false | cdpJpeg | 6/6 | 6 | 132 / 133 | -90 / -84 | 960x540 | – | 35 | – |  | view - in content 0,0 960x540; page 960x540 at 1x |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | – | 78 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 55 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 287 | pss | 481 | 3 | 0.0 |
| 1 | 318 | pss | 589 | 4 | 0.0 |
| 2 | 334 | pss | 698 | 5 | 0.3 |
| 4 | 365 | pss | 918 | 7 | 0.0 |
| 8 | 421 | pss | 1354 | 11 | 0.0 |

Per idle tab resting in the never-shown window (a still page): **17 MiB**, 0.00% CPU. Four tabs: one partition +70 MiB, four partitions +76 MiB.

Quiet tabs working in one shared 1×1 host (no rAF loop; the page repaints twice a second): **60 MiB** and 1.00% CPU a tab (0: 313 MiB / 0.0%, 1: 388 MiB / 1.0%, 4: 562 MiB / 4.8%, 8: 793 MiB / 8.0%).

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 47.0 | 8.0 | 38.5 | 60 |
| animated, never-shown window, throttling off | 0.8 | 0.5 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.3 | 0.0 | 0.0 | 0 |
| animated, never-shown window, throttling off + frame pump | 0.3 | 0.3 | 0.0 | 0 |
| animated, invisible shown window | 0.8 | 0.5 | 0.3 | 0 |
| animated, 1x1 shown window | 8.5 | 7.8 | 0.8 | 60 |
| animated, osr 30 fps | 8.8 | 3.8 | 1.3 | 30 |

**One host, 4 tabs (each held at 1280×800, 1×):** tab 1 rAF 60 Hz, capturePage 4/4 in 50 / 56 ms (2560x1600); tab 2 rAF 59 Hz, capturePage 4/4 in 38 / 54 ms (2560x1600); tab 3 rAF 59 Hz, capturePage 4/4 in 38 / 45 ms (2560x1600); tab 4 rAF 59 Hz, capturePage 4/4 in 39 / 50 ms (2560x1600)

**Assertions:** PASS capturePage works in the 1x1 host with the agent's 1280x800 at 1x held; PASS every tab in one shared host draws and is pictured

### Electron · linux-x11 (electron-linux-x11.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone x11, displays 1920x1080@1, status **done**, 868 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.93 | 27.5 | 30 / 53 | 0 / 11 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.95 | 28.4 | 29 / 31 | 12 / 14 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.4 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.95 | 28.5 | 27 / 33 | 9 / 14 | 1280x800@1 → 1000x700@1 → 1280x800 | 0 / 1 | 2.4 |  |
| invisibleWindow | true | true | true | true (1) | 0.95 | 28.4 | 29 / 38 | 9 / 11 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.0 |  |
| tinyWindow | true | true | true | true (1) | 0.96 | 28.6 | 29 / 33 | 11 / 16 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.0 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | IO / RO Hz | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 100.0 | 99.4 | 60.0 | 18 | 2.0 / 2.0 | – | – | – | 2.0 | 3.0 |  |
| detached, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.0 |  |
| detached, throttling off | visible | 1280x800 | 100.0 | 99.4 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.4 | 0.4 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.4 | 0.4 |  |
| never-shown window, throttling off | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.4 | 0.4 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 100.1 | 99.3 | 1.0 | 1017 | 0.0 / 0.0 | – | – | – | 0.6 | 0.6 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 100.0 | 99.4 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 0.4 | 0.6 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 100.0 | 99.4 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 0.4 | 0.4 |  |
| invisible shown window, throttling off | visible | 1280x800 | 100.0 | 99.4 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.4 | 0.4 |  |
| 1x1 shown window, throttling off | visible | 1280x800 | 100.0 | 99.4 | 60.0 | 18 | 2.0 / 2.0 | – | – | – | 2.2 | 3.0 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 100.2 | 99.4 | 60.0 | 18 | 2.0 / 2.0 | – | – | – | 2.0 | 2.8 | cover 0,0 1919x1079 over host 0,0 1x1 |
| 1x1 shown window kept above a cover window (always on top) | visible | 1280x800 | 100.2 | 99.4 | 60.0 | 18 | 2.0 / 2.0 | – | – | – | 2.2 | 3.0 | cover 0,0 1919x1079 over host 0,0 1x1 |
| invisible shown window, covered by another window | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.4 | 0.4 | cover -1480,-1000 1919x1079 over host -1480,-1000 1280x800 |
| 1x1 shown window, throttling on (control) | visible | 1280x800 | 100.0 | 99.4 | 60.0 | 18 | 2.0 / 2.0 | – | – | – | 2.0 | 2.8 |  |
| 1x1 shown window, throttling on, covered by another window (control) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.0 | cover 0,0 1919x1079 over host 0,0 1x1 |
| invisible shown window, throttling on, covered by another window (control) | hidden | 1280x800 | 2.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.0 | cover -1480,-1000 1919x1079 over host -1480,-1000 1280x800 |
| osr window 30 fps, throttling off | visible | 1280x800 | 100.0 | 99.2 | 30.0 | 34 | 2.0 / 2.0 | – | – | – | 1.6 | 8.4 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 100.0 | 99.2 | 30.0 | 35 | 0.0 / 2.0 | – | – | – | 1.0 | 1.2 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 100.0 | 99.4 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 25.8 | – | 1.0 | 1.2 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 100.0 | 99.4 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 25.8 | – | 1.0 | 1.2 |  |
| detached, throttling off, playing media | visible | 1280x800 | 100.0 | 99.4 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 25.8 | – | 1.2 | 1.6 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | to 1280×800 + JPEG ms | CPU ms/picture | frames/s | visibility events | geometry; errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 5 / 21 | -13 / 1 | 1000x700 | 10 / 11 | 37 | – |  | view 0,0 1000x700 in content 40,67 1000x700; page 1000x700 at 1x |
| shown | true | capturePage | 6/6 | 6 | 5 / 19 | 0 / 0 | 1000x700 | 10 / 11 | 37 | – |  | view 0,0 1000x700 in content 40,67 1000x700; page 1000x700 at 1x |
| shown | true | cdpJpeg | 6/6 | 6 | 49 / 62 | -36 / -34 | 1000x700 | – | 35 | – |  | view 0,0 1000x700 in content 40,67 1000x700; page 1000x700 at 1x |
| shown | true | frameSub | 6/6 | 6 | 15 / 17 | -8 / 0 | 1000x700 | – | 20 | – |  | view 0,0 1000x700 in content 40,67 1000x700; page 1000x700 at 1x |
| shown | true | cdpPng | 6/6 | 6 | 146 / 155 | -41 / -36 | 1000x700 | – | 140 | – |  | view 0,0 1000x700 in content 40,67 1000x700; page 1000x700 at 1x |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 35 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | – | 25 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content 320,167 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 320,167 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 3029 / 3033 | -3000 / -29 | 1280x800 | – | 57 | – |  | view 0,0 1280x800 in content 320,167 1280x800; page 1280x800 at 1x |
| hiddenWindow | false | frameSub | 6/6 | 6 | 6 / 6 | 42 / 51 | 1280x800 | – | 22 | – |  | view 0,0 1280x800 in content 320,167 1280x800; page 1280x800 at 1x |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.5 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content 320,167 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content 320,167 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 66 / 81 | -34 / -33 | 1280x800 | – | 70 | – |  | view 0,0 1280x800 in content 320,167 1280x800; page 1280x800 at 1x |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 15 / 21 | 7 / 8 | 1280x800 | – | 40 | – |  | view 0,0 1280x800 in content 320,167 1280x800; page 1280x800 at 1x |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| invisibleWindow | false | capturePage | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 81 / 84 | -49 / -18 | 1280x800 | – | 53 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | frameSub | 6/6 | 6 | 16 / 24 | 10 / 11 | 1280x800 | – | 28 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 15 / 16 | 8 / 9 | 1280x800 | – | 20 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | capturePage | 6/6 | 6 | 15 / 15 | 8 / 10 | 1280x800 | – | 28 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 79 / 84 | -49 / -41 | 1280x800 | – | 40 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | frameSub | 6/6 | 6 | 15 / 23 | 10 / 12 | 1280x800 | – | 25 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 14 / 16 | 9 / 13 | 1280x800 | – | 22 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 15 / 16 | 9 / 9 | 1280x800 | – | 25 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 82 / 83 | -50 / -39 | 1280x800 | – | 42 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 15 / 23 | 9 / 11 | 1280x800 | – | 23 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePageHidden | 6/6 | 6 | 14 / 19 | 8 / 10 | 1280x800 | – | 23 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | capturePage | 6/6 | 6 | 15 / 16 | 8 / 9 | 1280x800 | – | 22 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | cdpJpeg | 6/6 | 6 | 80 / 83 | -48 / -34 | 1280x800 | – | 45 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | frameSub | 6/6 | 6 | 15 / 21 | 10 / 10 | 1280x800 | – | 23 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 43 / 48 | 1280x800 | – | 17 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | capturePage | 6/6 | 6 | 31 / 32 | 8 / 17 | 1280x800 | – | 30 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | cdpJpeg | 6/6 | 6 | 132 / 140 | -83 / -81 | 1280x800 | – | 57 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | – | 78 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 55 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 327 | pss | 589 | 4 | 0.0 |
| 1 | 356 | pss | 695 | 5 | 0.0 |
| 2 | 371 | pss | 802 | 6 | 0.0 |
| 4 | 400 | pss | 1017 | 8 | 0.5 |
| 8 | 455 | pss | 1447 | 12 | 0.0 |

Per idle tab resting in the never-shown window (a still page): **16 MiB**, 0.00% CPU. Four tabs: one partition +66 MiB, four partitions +71 MiB.

Quiet tabs working in one shared 1×1 host (no rAF loop; the page repaints twice a second): **28 MiB** and 0.56% CPU a tab (0: 352 MiB / 0.0%, 1: 392 MiB / 0.5%, 4: 472 MiB / 2.0%, 8: 576 MiB / 4.5%).

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 9.0 | 6.3 | 2.8 | 60 |
| animated, never-shown window, throttling off | 0.5 | 0.5 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.3 | 0.0 | 0.0 | 0 |
| animated, never-shown window, throttling off + frame pump | 0.5 | 0.5 | 0.0 | 0 |
| animated, invisible shown window | 0.5 | 0.5 | 0.0 | 0 |
| animated, 1x1 shown window | 8.0 | 7.3 | 0.8 | 60 |
| animated, osr 30 fps | 14.0 | 5.0 | 2.5 | 30 |

**Waking a resting tab into the host** (never-shown window, throttling on, 4 cycles): first rAF 0 / 1 ms, fresh picture 12 / 32 ms; resting rates 2.0 Hz / rAF 0.0, 2.0 Hz / rAF 0.0, 2.0 Hz / rAF 0.0, 2.0 Hz / rAF 0.0; awake rAF 60, 60, 60, 60

**One host, 4 tabs (each held at 1280×800, 1×):** tab 1 rAF 60 Hz, capturePage 4/4 in 14 / 17 ms (1280x800); tab 2 rAF 60 Hz, capturePage 4/4 in 15 / 15 ms (1280x800); tab 3 rAF 60 Hz, capturePage 4/4 in 15 / 16 ms (1280x800); tab 4 rAF 60 Hz, capturePage 4/4 in 14 / 15 ms (1280x800)

**The host's invariants:** host 0,0 1x1, focused at start false, after its page grabs focus false (focused window "S7 probe"); Windows styles –; click-through {"at":"0,0","tool":"xdotool","belowClicks":0,"hostClicks":1}; X11 {"id":"0x200156","size":"1x1","mapState":"IsViewable","overrideRedirect":"yes","shape":"No window shape defined; No border shape defined"}

**X11, the host with an empty window shape:** {"id":"0x200163","size":"1x1","mapState":"IsViewable","overrideRedirect":"yes","shape":"Window shape extents:  0x0+0+0; No border shape defined"}; rAF 60 Hz (visible), capturePage 4/4 in 14 / 15 ms (1280x800); click-through {"at":"0,0","tool":"xdotool","belowClicks":0,"hostClicks":0}; with throttling on: 1.0 Hz / rAF 0 (hidden)

**Assertions:** PASS no reload when moving from detached; PASS no reload when moving from hiddenWindow; PASS no reload when moving from hiddenWindowFit; PASS no reload when moving from invisibleWindow; PASS no reload when moving from tinyWindow; PASS the 1x1 host draws (rAF above 10 Hz); PASS a never-shown window draws nothing (rAF below 1 Hz); PASS capturePage works in the 1x1 host; PASS capturePage works in the 1x1 host with the agent's 1280x800 at 1x held; PASS the host never takes focus, even when its page asks; PASS X11: the host with an empty window shape draws and is pictured; **FAIL** X11: a real click at the shaped host's point reaches the window below; PASS a resting tab draws within 2 s of moving into the host, every cycle; PASS every tab in one shared host draws and is pictured

**Q6 streamed view** (10 s at the viewer; latency p50 / p95 ms)

| road | content | source | fps | decoded fps | latency | gap p95 | kbit/s | bytes/frame | sender CPU % | viewer CPU % | source rAF | notes |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| screencast | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 |  |
| capturePoll | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | anim | hiddenWindow | 20.8 | 20.8 | 36 / 43 | 78 | 2499 | 15017 | 37 | 11 | 60 | libvpx; video/VP8 |
| webrtc-h264 | anim | hiddenWindow | 12.6 | 12.6 | 51 / 62 | 110 | 2508 | 24879 | 33 | 6 | 60 | OpenH264; video/H264 |
| webcodecs-vp8 | anim | hiddenWindow | 30.0 | 30.0 | 28 / 29 | 35 | 2420 | 10082 | 51 | 14 | 60 |  |
| webcodecs-h264 | anim | hiddenWindow | 30.0 | 30.0 | 27 / 28 | 35 | 2406 | 10025 | 42 | 12 | 60 |  |
| screencast | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | 0 |  |
| capturePoll | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | static | hiddenWindow | 2.0 | 2.0 | 68 / 114 | 547 | 825 | 51569 | 4 | 2 | 60 | libvpx; video/VP8 |
| webrtc-h264 | static | hiddenWindow | 1.0 | 1.0 | 17 / 18 | 1001 | 17 | 2168 | 3 | 1 | 60 | OpenH264; video/H264 |
| webcodecs-vp8 | static | hiddenWindow | 2.0 | 2.0 | 19 / 20 | 502 | 127 | 7919 | 4 | 1 | 60 |  |
| webcodecs-h264 | static | hiddenWindow | 2.0 | 2.0 | 17 / 19 | 502 | 75 | 4681 | 3 | 1 | 60 |  |
| screencast | anim | invisibleWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 |  |
| capturePoll | anim | invisibleWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 | toJPEG 0.0 ms |
| webcodecs-h264 | anim | invisibleWindow | 30.0 | 30.0 | 29 / 30 | 35 | 2410 | 10040 | 59 | 12 | 60 |  |
| screencast | anim | tinyWindow | 60.1 | 60.1 | 31 / 32 | 18 | 66109 | 137726 | 89 | 25 | 60 |  |
| webcodecs-h264 | anim | tinyWindow | 30.0 | 30.0 | 28 / 29 | 35 | 2405 | 10019 | 53 | 12 | 60 |  |
| screencast | anim | shown | 60.0 | 60.0 | 28 / 29 | 18 | 54999 | 114581 | 70 | 20 | 60 |  |
| webrtc-vp8 | anim | shown | 20.2 | 20.2 | 43 / 50 | 78 | 2507 | 15512 | 59 | 11 | 60 | libvpx; video/VP8 |
| webcodecs-h264 | anim | shown | 30.0 | 30.0 | 16 / 17 | 35 | 2453 | 10220 | 63 | 13 | 60 |  |

### Electron · linux-x64-ozone-headless (electron-linux-x64-ozone-headless.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone headless, displays 1920x1080@1, status **done**, 571 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.93 | 27.4 | 32 / 59 | 1 / 4 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.95 | 28.4 | 30 / 33 | 12 / 13 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.4 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.95 | 28.4 | 28 / 39 | 8 / 13 | 1280x800@1 → 1000x700@1 → 1280x800 | 0 / 1 | 2.4 |  |
| invisibleWindow | true | true | true | true (1) | 0.96 | 28.6 | 28 / 33 | 10 / 15 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.0 |  |
| tinyWindow | true | true | true | true (1) | 0.96 | 28.6 | 28 / 33 | 10 / 16 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.0 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | IO / RO Hz | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 100.0 | 99.2 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 2.0 | 2.8 |  |
| detached, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.2 | 0.2 |  |
| detached, throttling off | visible | 1280x800 | 100.0 | 99.4 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.6 | 0.8 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.2 |  |
| never-shown window, throttling off | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.4 | 0.4 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 99.9 | 99.3 | 1.0 | 1017 | 0.0 / 0.0 | – | – | – | 0.8 | 1.2 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 0.6 | 0.6 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 0.4 | 0.4 |  |
| invisible shown window, throttling off | visible | 1280x800 | 100.0 | 99.4 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 2.2 | 3.0 |  |
| 1x1 shown window, throttling off | visible | 1280x800 | 100.0 | 99.4 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 1.8 | 2.2 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 100.0 | 99.4 | 60.2 | 17 | 2.0 / 2.2 | – | – | – | 2.2 | 2.8 | cover 0,0 1920x1080 over host 0,0 1x1 |
| 1x1 shown window kept above a cover window (always on top) | visible | 1280x800 | 100.0 | 99.4 | 60.2 | 17 | 2.0 / 2.0 | – | – | – | 2.0 | 2.6 | cover 0,0 1920x1080 over host 0,0 1x1 |
| invisible shown window, covered by another window | visible | 1280x800 | 100.0 | 99.2 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 2.2 | 3.0 | cover -1480,-1000 1920x1080 over host -1480,-1000 1280x800 |
| 1x1 shown window, throttling on (control) | visible | 1280x800 | 100.0 | 99.4 | 60.2 | 17 | 2.2 / 2.2 | – | – | – | 1.8 | 2.4 |  |
| 1x1 shown window, throttling on, covered by another window (control) | visible | 1280x800 | 100.0 | 99.2 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 2.0 | 2.6 | cover 0,0 1920x1080 over host 0,0 1x1 |
| invisible shown window, throttling on, covered by another window (control) | visible | 1280x800 | 100.0 | 99.4 | 60.0 | 17 | 1.8 / 1.8 | – | – | – | 2.2 | 3.0 | cover -1480,-1000 1920x1080 over host -1480,-1000 1280x800 |
| osr window 30 fps, throttling off | visible | 1280x800 | 100.0 | 99.2 | 30.0 | 34 | 2.0 / 2.0 | – | – | – | 1.4 | 8.0 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 100.0 | 99.2 | 30.0 | 34 | 0.0 / 2.0 | – | – | – | 1.0 | 1.0 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 99.9 | 99.3 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 25.8 | – | 1.2 | 1.2 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 99.9 | 99.3 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 25.8 | – | 1.0 | 1.4 |  |
| detached, throttling off, playing media | visible | 1280x800 | 100.0 | 99.4 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 25.8 | – | 0.8 | 1.2 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 100.0 | 99.4 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | to 1280×800 + JPEG ms | CPU ms/picture | frames/s | visibility events | geometry; errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 5 / 21 | -3 / 1 | 1000x700 | 11 / 11 | 37 | – |  | view 0,0 1000x700 in content 40,65 1000x700; page 1000x700 at 1x |
| shown | true | capturePage | 6/6 | 6 | 6 / 21 | -1 / 0 | 1000x700 | 10 / 12 | 35 | – |  | view 0,0 1000x700 in content 40,65 1000x700; page 1000x700 at 1x |
| shown | true | cdpJpeg | 6/6 | 6 | 49 / 61 | -37 / -36 | 1000x700 | – | 33 | – |  | view 0,0 1000x700 in content 40,65 1000x700; page 1000x700 at 1x |
| shown | true | frameSub | 6/6 | 6 | 16 / 22 | -9 / -8 | 1000x700 | – | 20 | – |  | view 0,0 1000x700 in content 40,65 1000x700; page 1000x700 at 1x |
| shown | true | cdpPng | 6/6 | 6 | 144 / 155 | -41 / -40 | 1000x700 | – | 133 | – |  | view 0,0 1000x700 in content 40,65 1000x700; page 1000x700 at 1x |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 40 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | – | 35 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 4048 / 4048 | -3000 / -41 | 1280x800 | – | 63 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x |
| hiddenWindow | false | frameSub | 6/6 | 6 | 6 / 6 | 60 / 69 | 1280x800 | – | 18 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.5 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 65 / 80 | -34 / -32 | 1280x800 | – | 62 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 15 / 20 | 7 / 8 | 1280x800 | – | 43 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 6/6 | 6 | 15 / 15 | -8 / -2 | 1280x800 | – | 27 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | capturePage | 6/6 | 6 | 15 / 15 | -8 / -7 | 1280x800 | – | 23 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 65 / 66 | -49 / -40 | 1280x800 | – | 48 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | frameSub | 6/6 | 6 | 15 / 23 | -5 / -5 | 1280x800 | – | 27 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 14 / 15 | 8 / 12 | 1280x800 | – | 20 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | capturePage | 6/6 | 6 | 15 / 16 | 8 / 9 | 1280x800 | – | 25 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 81 / 85 | -49 / -40 | 1280x800 | – | 40 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | frameSub | 6/6 | 6 | 15 / 23 | 10 / 10 | 1280x800 | – | 27 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 15 / 21 | 8 / 9 | 1280x800 | – | 23 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 15 / 15 | 8 / 9 | 1280x800 | – | 25 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 81 / 84 | -49 / -40 | 1280x800 | – | 42 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 15 / 23 | 10 / 11 | 1280x800 | – | 23 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePageHidden | 6/6 | 6 | 15 / 21 | 8 / 9 | 1280x800 | – | 22 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | capturePage | 6/6 | 6 | 15 / 16 | 8 / 10 | 1280x800 | – | 22 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | cdpJpeg | 6/6 | 6 | 81 / 82 | -49 / -40 | 1280x800 | – | 40 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | frameSub | 6/6 | 6 | 15 / 23 | 10 / 11 | 1280x800 | – | 23 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 8 / 12 | 1280x800 | – | 17 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | capturePage | 6/6 | 6 | 31 / 32 | -23 / -17 | 1280x800 | – | 27 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | cdpJpeg | 6/6 | 6 | 98 / 107 | -81 / -80 | 1280x800 | – | 50 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | – | 75 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 60 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 243 | pss | 497 | 4 | 0.0 |
| 1 | 270 | pss | 599 | 5 | 0.0 |
| 2 | 286 | pss | 704 | 6 | 0.0 |
| 4 | 314 | pss | 910 | 8 | 0.8 |
| 8 | 368 | pss | 1326 | 12 | 0.3 |

Per idle tab resting in the never-shown window (a still page): **16 MiB**, 0.03% CPU. Four tabs: one partition +64 MiB, four partitions +69 MiB.

Quiet tabs working in one shared 1×1 host (no rAF loop; the page repaints twice a second): **28 MiB** and 0.41% CPU a tab (0: 267 MiB / 0.0%, 1: 307 MiB / 0.5%, 4: 386 MiB / 1.8%, 8: 491 MiB / 3.3%).

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 9.5 | 6.5 | 2.8 | 60 |
| animated, never-shown window, throttling off | 0.5 | 0.5 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.0 | 0.0 | 0.0 | 0 |
| animated, never-shown window, throttling off + frame pump | 0.5 | 0.5 | 0.0 | 0 |
| animated, invisible shown window | 11.8 | 7.8 | 4.0 | 60 |
| animated, 1x1 shown window | 8.0 | 7.3 | 0.5 | 60 |
| animated, osr 30 fps | 13.8 | 5.0 | 2.3 | 30 |

**Waking a resting tab into the host** (never-shown window, throttling on, 4 cycles): first rAF 0 / 2 ms, fresh picture 11 / 33 ms; resting rates 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0; awake rAF 60, 60, 60, 60

**One host, 4 tabs (each held at 1280×800, 1×):** tab 1 rAF 60 Hz, capturePage 4/4 in 13 / 15 ms (1280x800); tab 2 rAF 60 Hz, capturePage 4/4 in 15 / 15 ms (1280x800); tab 3 rAF 60 Hz, capturePage 4/4 in 14 / 15 ms (1280x800); tab 4 rAF 60 Hz, capturePage 4/4 in 15 / 15 ms (1280x800)

**The host's invariants:** host 0,0 1x1, focused at start false, after its page grabs focus false (focused window "S7 browser view"); Windows styles –; click-through not testable here (macOS needs Accessibility for synthetic clicks; Wayland and no display have no global input)

**Assertions:** PASS no reload when moving from detached; PASS no reload when moving from hiddenWindow; PASS no reload when moving from hiddenWindowFit; PASS no reload when moving from invisibleWindow; PASS no reload when moving from tinyWindow; PASS the 1x1 host draws (rAF above 10 Hz); PASS a never-shown window draws nothing (rAF below 1 Hz); PASS capturePage works in the 1x1 host; PASS capturePage works in the 1x1 host with the agent's 1280x800 at 1x held; PASS the host never takes focus, even when its page asks; PASS a resting tab draws within 2 s of moving into the host, every cycle; PASS every tab in one shared host draws and is pictured

### Electron · macos-dsf2 (electron-macos-dsf2.json)

Electron 45.2.2 (Chromium 156.0.8078.80), darwin-arm64 25.6.0, ozone (default), displays 1024x768@2, status **done**, 270 s

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | to 1280×800 + JPEG ms | CPU ms/picture | frames/s | visibility events | geometry; errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 32 / 89 | 3 / 17 | 2000x1400 | 20 / 26 | 82 | – |  | view 0,0 1000x700 in content 24,63 1000x645; page 1000x700 at 2x |
| shown | true | capturePage | 6/6 | 6 | 23 / 36 | 10 / 16 | 2000x1400 | 20 / 26 | 66 | – |  | view 0,0 1000x700 in content 24,63 1000x645; page 1000x700 at 2x |
| shown | true | cdpJpeg | 6/6 | 6 | 107 / 111 | -43 / -38 | 2000x1400 | – | 81 | – |  | view 0,0 1000x700 in content 24,63 1000x645; page 1000x700 at 2x |
| shown | true | frameSub | 6/6 | 6 | 23 / 36 | 6 / 17 | 2000x1400 | – | 34 | – |  | view 0,0 1000x700 in content 24,63 1000x645; page 1000x700 at 2x |
| shown | true | cdpPng | 6/6 | 6 | 283 / 297 | -49 / -41 | 2000x1400 | – | 265 | – |  | view 0,0 1000x700 in content 24,63 1000x645; page 1000x700 at 2x |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 18 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 2x; Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | – | 20 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 2x; Current display surface not available for capture |
| detached | false | cdpJpeg | 1/3 | 1 | 136 / 136 | -44 / -44 | 2560x1600 | – | 220 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 2x; Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | – | 246 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 2x; frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 11 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | – | 16 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 139 / 266 | -50 / -39 | 2560x1600 | – | 172 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 2x |
| hiddenWindow | false | frameSub | 6/6 | 6 | 42 / 64 | 19 / 23 | 2560x1600 | – | 89 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 2x |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 15 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | – | 16 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 112 / 132 | -53 / -39 | 2560x1600 | – | 144 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 2x |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 31 / 35 | 10 / 17 | 2560x1600 | – | 85 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 2x |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 6/6 | 6 | 29 / 41 | -9 / 0 | 2560x1600 | 22 / 24 | 87 | – |  | view 0,0 1280x800 in content 0,31 1280x800; page 1280x800 at 2x |
| invisibleWindow | false | capturePage | 6/6 | 6 | 27 / 33 | -7 / -2 | 2560x1600 | 15 / 18 | 76 | – |  | view 0,0 1280x800 in content 0,31 1280x800; page 1280x800 at 2x |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 93 / 105 | -40 / -38 | 2560x1600 | – | 100 | – |  | view 0,0 1280x800 in content 0,31 1280x800; page 1280x800 at 2x |
| invisibleWindow | false | frameSub | 6/6 | 6 | 31 / 43 | -3 / 0 | 2560x1600 | – | 75 | – |  | view 0,0 1280x800 in content 0,31 1280x800; page 1280x800 at 2x |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 25 / 60 | 5 / 16 | 2560x1600 | 17 / 19 | 79 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 2x |
| tinyWindow | false | capturePage | 6/6 | 6 | 23 / 29 | 8 / 17 | 2560x1600 | 14 / 19 | 56 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 2x |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 111 / 129 | -47 / -38 | 2560x1600 | – | 114 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 2x |
| tinyWindow | false | frameSub | 6/6 | 6 | 35 / 60 | 2 / 16 | 2560x1600 | – | 79 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 2x |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 25 / 40 | 7 / 14 | 2560x1600 | 12 / 17 | 73 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 2x |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 29 / 49 | 6 / 19 | 2560x1600 | 13 / 16 | 86 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 2x |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 123 / 128 | -44 / -39 | 2560x1600 | – | 124 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 2x |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 26 / 39 | 10 / 15 | 2560x1600 | – | 57 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 2x |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePageHidden | 6/6 | 6 | 26 / 58 | 6 / 14 | 2560x1600 | 13 / 16 | 82 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | capturePage | 6/6 | 6 | 24 / 52 | 7 / 19 | 2560x1600 | 12 / 15 | 77 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | cdpJpeg | 6/6 | 6 | 67 / 202 | -40 / -34 | 1280x800 | – | 92 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | frameSub | 6/6 | 6 | 30 / 46 | -3 / 1 | 2560x1600 | – | 73 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 1 | 77 / 150 | 1280x800 | – | 19 | – |  | view - in content 0,-33 1280x800; page 1280x800 at 1x |
| osr | false | capturePage | 6/6 | 6 | 86 / 124 | 30 / 114 | 1280x800 | – | 57 | – |  | view - in content 0,-33 1280x800; page 1280x800 at 1x |
| osr | false | cdpJpeg | 6/6 | 6 | 322 / 411 | -195 / -96 | 1280x800 | – | 124 | – |  | view - in content 0,-33 1280x800; page 1280x800 at 1x |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | – | 13.5 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | – | 536 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | – | 11 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 446 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 184 | footprint | 332 | 3 | 0.1 |
| 1 | 206 | footprint | 424 | 4 | 0.6 |
| 2 | 226 | footprint | 518 | 5 | 0.7 |
| 4 | 267 | footprint | 705 | 7 | 1.3 |
| 8 | 351 | footprint | 1079 | 11 | 3.3 |

Per idle tab resting in the never-shown window (a still page): **21 MiB**, 0.40% CPU. Four tabs: one partition +80 MiB, four partitions +82 MiB.

Quiet tabs working in one shared 1×1 host (no rAF loop; the page repaints twice a second): **67 MiB** and 2.43% CPU a tab (0: 210 MiB / 0.1%, 1: 320 MiB / 4.5%, 4: 498 MiB / 12.7%, 8: 744 MiB / 19.5%).

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 28.6 | 9.8 | 18.4 | 60 |
| animated, never-shown window, throttling off | 12.4 | 3.6 | 8.0 | 0 |
| animated, never-shown window, throttling on | 0.6 | 0.1 | 0.3 | 0 |
| animated, never-shown window, throttling off + frame pump | 15.1 | 4.8 | 10.0 | 0 |
| animated, invisible shown window | 39.4 | 13.2 | 25.8 | 60 |
| animated, 1x1 shown window | 47.5 | 15.3 | 32.1 | 60 |
| animated, osr 30 fps | 17.6 | 4.0 | 9.4 | 14 |

**One host, 4 tabs (each held at 1280×800, 1×):** tab 1 rAF 60 Hz, capturePage 4/4 in 28 / 44 ms (2560x1600); tab 2 rAF 60 Hz, capturePage 4/4 in 19 / 37 ms (2560x1600); tab 3 rAF 60 Hz, capturePage 4/4 in 21 / 26 ms (2560x1600); tab 4 rAF 60 Hz, capturePage 4/4 in 22 / 33 ms (2560x1600)

**Assertions:** PASS capturePage works in the 1x1 host with the agent's 1280x800 at 1x held; PASS every tab in one shared host draws and is pictured

### Electron · macos (electron-macos.json)

Electron 45.2.2 (Chromium 156.0.8078.80), darwin-arm64 25.6.0, ozone (default), displays 1024x768@1, status **done**, 866 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.95 | 28.7 | 49 / 1845 | 10 / 656 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 1.9 |  |
| hiddenWindow | true | true | true | true (1) | 0.97 | 28.9 | 54 / 84 | 14 / 21 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 1.9 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.97 | 29.2 | 62 / 81 | 15 / 32 | 1280x800@1 → 1000x700@1 → 1280x800 | 0 / 3 | 2.1 |  |
| invisibleWindow | true | true | true | true (1) | 0.97 | 29.0 | 47 / 49 | 3 / 19 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 59.9 |  |
| tinyWindow | true | true | true | true (1) | 0.97 | 28.8 | 58 / 64 | 7 / 14 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.0 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | IO / RO Hz | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 73.5 | 60.1 | 60.0 | 26 | 2.0 / 2.0 | – | – | – | 10.8 | 31.2 |  |
| detached, throttling on (default) | hidden | 1280x800 | 1.6 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.2 | 0.8 |  |
| detached, throttling off | visible | 1280x800 | 99.7 | 72.7 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 4.2 | 13.5 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.1 | 0.9 |  |
| never-shown window, throttling off | visible | 1280x800 | 100.1 | 80.3 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 3.0 | 8.4 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 71.1 | 60.3 | 60.1 | 29 | 2.0 / 2.0 | – | – | – | 12.1 | 35.5 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 99.9 | 76.1 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 3.0 | 9.8 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 100.0 | 74.1 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 3.6 | 10.2 |  |
| invisible shown window, throttling off | visible | 1280x800 | 57.4 | 48.0 | 48.2 | 440 | 1.9 / 1.9 | – | – | – | 8.1 | 23.9 |  |
| 1x1 shown window, throttling off | visible | 1280x800 | 69.3 | 60.5 | 60.1 | 26 | 2.2 / 2.2 | – | – | – | 10.5 | 30.3 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 68.9 | 59.9 | 60.1 | 37 | 2.0 / 2.0 | – | – | – | 9.6 | 28.0 | cover 0,0 1024x768 over host 0,31 1x1 |
| 1x1 shown window kept above a cover window (always on top) | visible | 1280x800 | 69.3 | 60.0 | 60.0 | 26 | 2.0 / 2.0 | – | – | – | 8.8 | 25.5 | cover 0,0 1024x768 over host 0,31 1x1 |
| invisible shown window, covered by another window | visible | 1280x800 | 67.9 | 59.9 | 59.9 | 26 | 2.0 / 2.0 | – | – | – | 8.5 | 23.7 | cover 0,0 1280x831 over host 0,31 1280x800 |
| 1x1 shown window, throttling on (control) | visible | 1280x800 | 72.9 | 60.3 | 59.9 | 25 | 2.0 / 2.0 | – | – | – | 10.2 | 29.9 |  |
| 1x1 shown window, throttling on, covered by another window (control) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.1 | 0.9 | cover 0,0 1024x768 over host 0,31 1x1 |
| invisible shown window, throttling on, covered by another window (control) | hidden | 1280x800 | 1.2 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.2 | 1.0 | cover 0,0 1280x831 over host 0,31 1280x800 |
| osr window 30 fps, throttling off | visible | 1280x800 | 45.8 | 38.4 | 19.2 | 171 | 2.2 / 2.2 | – | – | – | 4.5 | 21.5 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 38.7 | 31.7 | 13.0 | 181 | 0.0 / 2.0 | – | – | – | 3.0 | 9.2 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 36.8 | 31.0 | 0.0 | 0 | 0.0 / 0.0 | 0.94 | 28.8 | – | 4.8 | 9.9 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 41.8 | 33.0 | 0.0 | 0 | 0.0 / 0.0 | 0.92 | 27.4 | – | 4.8 | 10.2 |  |
| detached, throttling off, playing media | visible | 1280x800 | 39.3 | 32.4 | 0.0 | 0 | 0.0 / 0.0 | 0.88 | 25.0 | – | 5.0 | 10.5 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 100.1 | 71.9 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 1.2 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | to 1280×800 + JPEG ms | CPU ms/picture | frames/s | visibility events | geometry; errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 26 / 27 | 24 / 33 | 1000x700 | 11 / 21 | 59 | – |  | view 0,0 1000x700 in content 24,63 1000x645; page 1000x700 at 1x |
| shown | true | capturePage | 6/6 | 6 | 20 / 35 | 27 / 31 | 1000x700 | 9 / 12 | 51 | – |  | view 0,0 1000x700 in content 24,63 1000x645; page 1000x700 at 1x |
| shown | true | cdpJpeg | 6/6 | 6 | 97 / 112 | -41 / -37 | 1000x700 | – | 60 | – |  | view 0,0 1000x700 in content 24,63 1000x645; page 1000x700 at 1x |
| shown | true | frameSub | 6/6 | 6 | 27 / 35 | 23 / 30 | 1000x700 | – | 46 | – |  | view 0,0 1000x700 in content 24,63 1000x645; page 1000x700 at 1x |
| shown | true | cdpPng | 6/6 | 6 | 204 / 230 | -49 / -35 | 1000x700 | – | 188 | – |  | view 0,0 1000x700 in content 24,63 1000x645; page 1000x700 at 1x |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 13 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | – | 13 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | cdpJpeg | 1/3 | 1 | 94 / 94 | -46 / -46 | 1280x800 | – | 194 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | – | 179 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 7 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | – | 18 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 95 / 118 | -47 / -37 | 1280x800 | – | 125 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 1x |
| hiddenWindow | false | frameSub | 6/6 | 6 | 25 / 38 | 8 / 14 | 1280x800 | – | 81 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 1x |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 15 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | – | 16 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 89 / 104 | -44 / -19 | 1280x800 | – | 125 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 1x |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 17 / 30 | 10 / 17 | 1280x800 | – | 89 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 1x |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 6/6 | 6 | 24 / 35 | 6 / 17 | 1280x800 | – | 84 | – |  | view 0,0 1280x800 in content 0,31 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | capturePage | 6/6 | 6 | 32 / 39 | 18 / 23 | 1280x800 | – | 88 | – |  | view 0,0 1280x800 in content 0,31 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 92 / 106 | -47 / -40 | 1280x800 | – | 97 | – |  | view 0,0 1280x800 in content 0,31 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | frameSub | 6/6 | 6 | 27 / 36 | 4 / 13 | 1280x800 | – | 73 | – |  | view 0,0 1280x800 in content 0,31 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 14 / 22 | 8 / 25 | 1280x800 | – | 26 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow | false | capturePage | 6/6 | 6 | 26 / 30 | 5 / 19 | 1280x800 | – | 75 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 101 / 113 | -50 / -36 | 1280x800 | – | 128 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow | false | frameSub | 6/6 | 6 | 24 / 33 | 8 / 20 | 1280x800 | – | 85 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 22 / 29 | -6 / 1 | 1280x800 | – | 70 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 20 / 29 | -13 / -1 | 1280x800 | – | 72 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 82 / 89 | -46 / -41 | 1280x800 | – | 104 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 21 / 31 | -8 / -1 | 1280x800 | – | 68 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePageHidden | 6/6 | 6 | 13 / 25 | -4 / 0 | 1280x800 | – | 40 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | capturePage | 6/6 | 6 | 23 / 29 | -10 / 0 | 1280x800 | – | 81 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | cdpJpeg | 6/6 | 6 | 79 / 94 | -47 / -35 | 1280x800 | – | 101 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | frameSub | 6/6 | 6 | 19 / 33 | -11 / 1 | 1280x800 | – | 71 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 29.5 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 1 | 76 / 206 | 1280x800 | – | 12 | – |  | view - in content 0,-33 1280x800; page 1280x800 at 1x |
| osr | false | capturePage | 6/6 | 6 | 26 / 43 | 112 / 133 | 1280x800 | – | 40 | – |  | view - in content 0,-33 1280x800; page 1280x800 at 1x |
| osr | false | cdpJpeg | 6/6 | 6 | 351 / 502 | -181 / -100 | 1280x800 | – | 117 | – |  | view - in content 0,-33 1280x800; page 1280x800 at 1x |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | – | 13.5 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | – | 572 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | – | 16 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 483 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 150 | footprint | 394 | 4 | 0.2 |
| 1 | 171 | footprint | 486 | 5 | 0.6 |
| 2 | 191 | footprint | 579 | 6 | 1.1 |
| 4 | 232 | footprint | 766 | 8 | 1.4 |
| 8 | 317 | footprint | 1139 | 12 | 1.5 |

Per idle tab resting in the never-shown window (a still page): **21 MiB**, 0.17% CPU. Four tabs: one partition +78 MiB, four partitions +84 MiB.

Quiet tabs working in one shared 1×1 host (no rAF loop; the page repaints twice a second): **35 MiB** and 2.28% CPU a tab (0: 176 MiB / 0.2%, 1: 224 MiB / 2.8%, 4: 323 MiB / 7.6%, 8: 454 MiB / 18.5%).

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 26.9 | 9.2 | 17.1 | 60 |
| animated, never-shown window, throttling off | 12.0 | 3.5 | 7.9 | 0 |
| animated, never-shown window, throttling on | 0.7 | 0.1 | 0.4 | 0 |
| animated, never-shown window, throttling off + frame pump | 11.6 | 3.6 | 7.8 | 0 |
| animated, invisible shown window | 39.4 | 13.0 | 26.1 | 60 |
| animated, 1x1 shown window | 44.6 | 14.3 | 30.1 | 60 |
| animated, osr 30 fps | 21.6 | 4.9 | 11.3 | 18 |

**Waking a resting tab into the host** (never-shown window, throttling on, 4 cycles): first rAF 8 / 27 ms, fresh picture 66 / 79 ms; resting rates 1.1 Hz / rAF 0.0, 1.2 Hz / rAF 0.0, 1.1 Hz / rAF 0.0, 1.1 Hz / rAF 0.0; awake rAF 60, 60, 60, 60

**One host, 4 tabs (each held at 1280×800, 1×):** tab 1 rAF 60 Hz, capturePage 4/4 in 15 / 24 ms (1280x800); tab 2 rAF 60 Hz, capturePage 4/4 in 8 / 21 ms (1280x800); tab 3 rAF 60 Hz, capturePage 4/4 in 12 / 18 ms (1280x800); tab 4 rAF 60 Hz, capturePage 4/4 in 9 / 18 ms (1280x800)

**The host's invariants:** host 0,31 1x1, focused at start false, after its page grabs focus false (focused window "S7 probe"); Windows styles –; click-through not testable here (macOS needs Accessibility for synthetic clicks; Wayland and no display have no global input)

**Assertions:** PASS no reload when moving from detached; PASS no reload when moving from hiddenWindow; PASS no reload when moving from hiddenWindowFit; PASS no reload when moving from invisibleWindow; PASS no reload when moving from tinyWindow; PASS the 1x1 host draws (rAF above 10 Hz); PASS a never-shown window draws nothing (rAF below 1 Hz); PASS capturePage works in the 1x1 host; PASS capturePage works in the 1x1 host with the agent's 1280x800 at 1x held; PASS the host never takes focus, even when its page asks; PASS a resting tab draws within 2 s of moving into the host, every cycle; PASS every tab in one shared host draws and is pictured

**Q6 streamed view** (10 s at the viewer; latency p50 / p95 ms)

| road | content | source | fps | decoded fps | latency | gap p95 | kbit/s | bytes/frame | sender CPU % | viewer CPU % | source rAF | notes |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| screencast | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 11 | 0 | 0 |  |
| capturePoll | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 12 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | anim | hiddenWindow | 23.1 | 23.1 | 124 / 189 | 84 | 2435 | 13177 | 79 | 19 | 60 | libvpx; video/VP8 |
| webrtc-h264 | anim | hiddenWindow | 13.9 | 13.9 | 161 / 209 | 118 | 2494 | 22426 | 81 | 9 | 60 | OpenH264; video/H264 |
| webcodecs-vp8 | anim | hiddenWindow | 30.0 | 30.0 | 41 / 52 | 50 | 2257 | 9406 | 71 | 14 | 60 |  |
| webcodecs-h264 | anim | hiddenWindow | 30.1 | 30.1 | 42 / 52 | 50 | 2227 | 9278 | 79 | 9 | 60 |  |
| screencast | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 |  |
| capturePoll | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | static | hiddenWindow | 2.0 | 2.0 | 45 / 74 | 535 | 43 | 2662 | 11 | 2 | 43 | libvpx; video/VP8 |
| webrtc-h264 | static | hiddenWindow | 1.0 | 1.0 | 71 / 240 | 1024 | 12 | 1503 | 12 | 1 | 42 | OpenH264; video/H264 |
| webcodecs-vp8 | static | hiddenWindow | 2.0 | 2.0 | 54 / 75 | 547 | 101 | 6318 | 12 | 1 | 42 |  |
| webcodecs-h264 | static | hiddenWindow | 2.0 | 2.0 | 47 / 75 | 539 | 9 | 586 | 10 | 1 | 41 |  |
| screencast | anim | invisibleWindow | 60.0 | 60.0 | 36 / 49 | 32 | 58242 | 121337 | 66 | 21 | 60 |  |
| capturePoll | anim | invisibleWindow | 29.1 | 29.1 | 59 / 66 | 48 | 28432 | 121710 | 48 | 12 | 60 | toJPEG 5.1 ms |
| webcodecs-h264 | anim | invisibleWindow | 29.9 | 29.9 | 55 / 65 | 48 | 2233 | 9302 | 72 | 11 | 60 |  |
| screencast | anim | tinyWindow | 60.0 | 60.0 | 36 / 48 | 33 | 58378 | 121419 | 61 | 20 | 60 |  |
| webcodecs-h264 | anim | tinyWindow | 29.9 | 29.9 | 40 / 50 | 48 | 2228 | 9284 | 73 | 10 | 60 |  |
| screencast | anim | shown | 59.9 | 59.9 | 40 / 43 | 27 | 48794 | 101824 | 55 | 17 | 60 |  |
| webrtc-vp8 | anim | shown | 3.1 | 3.1 | 269 / 410 | 476 | 479 | 19311 | 40 | 4 | 60 | libvpx; video/VP8 |
| webcodecs-h264 | anim | shown | 30.1 | 30.1 | 25 / 30 | 41 | 2111 | 8797 | 68 | 10 | 60 |  |

### Electron · windows-dsf2 (electron-windows-dsf2.json)

Electron 45.2.2 (Chromium 156.0.8078.80), win32-x64 10.0.26100, ozone (default), displays 256x192@2, status **done**, 353 s

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | to 1280×800 + JPEG ms | CPU ms/picture | frames/s | visibility events | geometry; errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 33 / 43 | 24 / 28 | 2000x1400 | 21 / 40 | 346 | – |  | view 0,0 1000x700 in content 44,82 504x342; page 1000x700 at 2x |
| shown | true | capturePage | 6/6 | 6 | 29 / 38 | 25 / 28 | 2000x1400 | 20 / 24 | 153 | – |  | view 0,0 1000x700 in content 44,82 504x342; page 1000x700 at 2x |
| shown | true | cdpJpeg | 6/6 | 6 | 132 / 141 | -36 / -32 | 2000x1400 | – | 208 | – |  | view 0,0 1000x700 in content 44,82 504x342; page 1000x700 at 2x |
| shown | true | frameSub | 6/6 | 6 | 52 / 54 | 18 / 30 | 2000x1400 | – | 133 | – |  | view 0,0 1000x700 in content 44,82 504x342; page 1000x700 at 2x |
| shown | true | cdpPng | 6/6 | 6 | 396 / 403 | -43 / -34 | 2000x1400 | – | 613 | – |  | view 0,0 1000x700 in content 44,82 504x342; page 1000x700 at 2x |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 31.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 89 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | – | 96 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 4,42 504x342; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 4,42 504x342; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 4975 / 4980 | -2882 / -40 | 2560x1600 | – | 211 | – |  | view 0,0 1280x800 in content 4,42 504x342; page 1280x800 at 2x |
| hiddenWindow | false | frameSub | 6/6 | 6 | 39 / 39 | 71 / 147 | 2560x1600 | – | 105 | – |  | view 0,0 1280x800 in content 4,42 504x342; page 1280x800 at 2x |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 4,42 504x342; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 4,42 504x342; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 193 / 216 | -84 / -27 | 2560x1600 | – | 507 | – |  | view 0,0 1280x800 in content 4,42 504x342; page 1280x800 at 2x |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 50 / 65 | 18 / 20 | 2560x1600 | – | 231 | – |  | view 0,0 1280x800 in content 4,42 504x342; page 1280x800 at 2x |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 6/6 | 6 | 46 / 51 | 19 / 27 | 2560x1600 | 24 / 30 | 199 | – |  | view 0,0 1280x800 in content 1,0 511x362; page 1280x800 at 2x |
| invisibleWindow | false | capturePage | 6/6 | 6 | 44 / 49 | 21 / 30 | 2560x1600 | 25 / 29 | 207 | – |  | view 0,0 1280x800 in content 1,0 511x362; page 1280x800 at 2x |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 145 / 164 | -43 / -40 | 2560x1600 | – | 262 | – |  | view 0,0 1280x800 in content 1,0 511x362; page 1280x800 at 2x |
| invisibleWindow | false | frameSub | 6/6 | 6 | 69 / 70 | 5 / 6 | 2560x1600 | – | 175 | – |  | view 0,0 1280x800 in content 1,0 511x362; page 1280x800 at 2x |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 23.0 |  |  |
| tinyWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 1,0 0x17; page 0x0 at 2x; empty image |
| tinyWindow | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 1,0 0x17; page 0x0 at 2x; empty image |
| tinyWindow | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 231 | – |  | view 0,0 1280x800 in content 1,0 0x17; page 0x0 at 2x; Page.captureScreenshot: timed out after 5000 ms |
| tinyWindow | false | frameSub | 0/2 | 0 | – | – | - | – | 192 | – |  | view 0,0 1280x800 in content 1,0 0x17; page 0x0 at 2x; frame subscription: timed out after 5000 ms |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 1,0 0x17; page 0x0 at 2x; empty image |
| tinyWindow, covered | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 1,0 0x17; page 0x0 at 2x; empty image |
| tinyWindow, covered | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 209 | – |  | view 0,0 1280x800 in content 1,0 0x17; page 0x0 at 2x; Page.captureScreenshot: timed out after 5000 ms |
| tinyWindow, covered | false | frameSub | 0/2 | 0 | – | – | - | – | 194 | – |  | view 0,0 1280x800 in content 1,0 0x17; page 0x0 at 2x; frame subscription: timed out after 5000 ms |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePageHidden | 5/6 | 5 | 34 / 40 | 119 / 129 | 2560x1600 | 21 / 27 | 102 | – |  | view 0,0 1280x800 in content 1,0 0x17; page 1280x800 at 1x; UnknownVizError |
| tinyWindow, fit 1280x800 at 1x | false | capturePage | 6/6 | 6 | 33 / 34 | 112 / 122 | 2560x1600 | 20 / 26 | 101 | – |  | view 0,0 1280x800 in content 1,0 0x17; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | cdpJpeg | 6/6 | 6 | 2969 / 2977 | -2940 / -2901 | 1280x800 | – | 122 | – |  | view 0,0 1280x800 in content 1,0 0x17; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | frameSub | 6/6 | 6 | 38 / 39 | 31 / 61 | 2560x1600 | – | 104 | – |  | view 0,0 1280x800 in content 1,0 0x17; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 0 | 0 / 1 | – | 512x360 | – | 16 | – |  | view - in content 1,0 511x360; page 512x360 at 1x |
| osr | false | capturePage | 6/6 | 0 | 22 / 23 | – | 512x360 | 10 / 11 | 29 | – |  | view - in content 1,0 511x360; page 512x360 at 1x |
| osr | false | cdpJpeg | 6/6 | 0 | 133 / 134 | – | 512x360 | – | 32 | – |  | view - in content 1,0 511x360; page 512x360 at 1x |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | – | 146 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 109 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 105 | privateBytes | 150 | 3 | 0.0 |
| 1 | 130 | privateBytes | 221 | 4 | 0.1 |
| 2 | 158 | privateBytes | 293 | 5 | 0.2 |
| 4 | 210 | privateBytes | 440 | 7 | 0.4 |
| 8 | 313 | privateBytes | 734 | 11 | 0.6 |

Per idle tab resting in the never-shown window (a still page): **26 MiB**, 0.07% CPU. Four tabs: one partition +96 MiB, four partitions +105 MiB.

Quiet tabs working in one shared 1×1 host (no rAF loop; the page repaints twice a second): **27 MiB** and -0.05% CPU a tab (0: 134 MiB / 0.9%, 1: 163 MiB / 0.2%, 4: 245 MiB / 0.4%, 8: 352 MiB / 0.6%).

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 50.9 | 24.6 | 26.0 | 64 |
| animated, never-shown window, throttling off | 2.1 | 1.5 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.2 | 0.0 | 0.0 | 0 |
| animated, never-shown window, throttling off + frame pump | 1.7 | 1.5 | 0.0 | 0 |
| animated, invisible shown window | 58.7 | 30.6 | 28.0 | 64 |
| animated, 1x1 shown window | 1.6 | 1.5 | 0.0 | 0 |
| animated, osr 30 fps | 11.8 | 6.5 | 2.8 | 30 |

**One host, 4 tabs (each held at 1280×800, 1×):** tab 1 rAF 0 Hz, capturePage 3/4 in 37 / 40 ms (2560x1600); tab 2 rAF 0 Hz, capturePage 3/4 in 35 / 41 ms (2560x1600); tab 3 rAF 0 Hz, capturePage 3/4 in 36 / 45 ms (2560x1600); tab 4 rAF 0 Hz, capturePage 3/4 in 36 / 44 ms (2560x1600)

**Assertions:** PASS capturePage works in the 1x1 host with the agent's 1280x800 at 1x held; **FAIL** every tab in one shared host draws and is pictured

### Electron · windows (electron-windows.json)

Electron 45.2.2 (Chromium 156.0.8078.80), win32-x64 10.0.26100, ozone (default), displays 1024x768@1, status **done**, 881 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.91 | 26.9 | 42 / 101 | 1 / 57 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.96 | 28.6 | 39 / 40 | 17 / 18 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.3 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.96 | 28.6 | 35 / 45 | 13 / 14 | 1280x800@1 → 1000x700@1 → 1280x800 | 1 / 2 | 1.9 |  |
| invisibleWindow | true | true | true | true (1) | 0.96 | 28.8 | 33 / 42 | 10 / 15 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 64.1 |  |
| tinyWindow | true | true | true | true (1) | 0.96 | 28.8 | 34 / 37 | 13 / 13 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 64.0 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | IO / RO Hz | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 100.0 | 92.8 | 64.0 | 18 | 2.0 / 2.0 | – | – | – | 5.0 | 9.3 |  |
| detached, throttling on (default) | hidden | 1280x800 | 1.2 | 1.2 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.3 |  |
| detached, throttling off | visible | 1280x800 | 100.1 | 97.1 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 1.6 | 1.7 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.2 |  |
| never-shown window, throttling off | visible | 1280x800 | 100.0 | 97.4 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 1.4 | 1.6 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 100.0 | 91.2 | 1.0 | 1000 | 0.0 / 0.0 | – | – | – | 1.0 | 1.3 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 100.0 | 97.4 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 1.4 | 1.6 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 100.0 | 97.6 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 1.4 | 1.6 |  |
| invisible shown window, throttling off | visible | 1280x800 | 100.0 | 92.8 | 64.2 | 18 | 2.2 / 2.2 | – | – | – | 5.2 | 9.5 |  |
| 1x1 shown window, throttling off | visible | 1280x800 | 100.0 | 92.2 | 64.0 | 18 | 2.0 / 2.0 | – | – | – | 5.0 | 8.3 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 100.0 | 92.8 | 64.0 | 18 | 2.0 / 2.0 | – | – | – | 5.1 | 8.5 | cover 0,0 1024x720 over host 0,0 4x31 |
| 1x1 shown window kept above a cover window (always on top) | visible | 1280x800 | 100.0 | 91.6 | 64.0 | 17 | 2.2 / 2.2 | – | – | – | 4.7 | 7.8 | cover 0,0 1024x720 over host 0,0 4x31 |
| invisible shown window, covered by another window | visible | 1280x800 | 100.0 | 92.8 | 64.0 | 18 | 1.8 / 1.8 | – | – | – | 5.0 | 9.3 | cover 0,0 1024x720 over host 0,0 1024x720 |
| 1x1 shown window, throttling on (control) | visible | 1280x800 | 100.0 | 92.6 | 64.2 | 18 | 2.0 / 2.2 | – | – | – | 5.1 | 8.4 |  |
| 1x1 shown window, throttling on, covered by another window (control) | hidden | 1280x800 | 1.8 | 1.2 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.1 | 0.2 | cover 0,0 1024x720 over host 0,0 4x31 |
| invisible shown window, throttling on, covered by another window (control) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.3 | cover 0,0 1024x720 over host 0,0 1024x720 |
| osr window 30 fps, throttling off | visible | 1024x720 | 100.0 | 90.6 | 30.0 | 35 | 1.8 / 1.8 | – | – | – | 3.1 | 9.1 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 100.2 | 91.2 | 30.0 | 35 | 0.0 / 2.0 | – | – | – | 1.7 | 2.2 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 100.2 | 91.6 | 0.0 | 0 | 0.0 / 0.0 | 0.84 | 26.0 | – | 2.2 | 3.0 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 100.2 | 92.2 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 24.8 | – | 2.2 | 3.0 |  |
| detached, throttling off, playing media | visible | 1280x800 | 100.2 | 91.4 | 0.0 | 0 | 0.0 / 0.0 | 0.84 | 24.8 | – | 2.1 | 2.9 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 100.0 | 97.6 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 2.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | to 1280×800 + JPEG ms | CPU ms/picture | frames/s | visibility events | geometry; errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 7 / 12 | 13 / 15 | 1000x700 | 14 / 16 | 86 | – |  | view 0,0 1000x700 in content 48,97 1000x681; page 1000x700 at 1x |
| shown | true | capturePage | 6/6 | 6 | 9 / 11 | 12 / 14 | 1000x700 | 13 / 15 | 85 | – |  | view 0,0 1000x700 in content 48,97 1000x681; page 1000x700 at 1x |
| shown | true | cdpJpeg | 6/6 | 6 | 69 / 81 | -39 / -37 | 1000x700 | – | 100 | – |  | view 0,0 1000x700 in content 48,97 1000x681; page 1000x700 at 1x |
| shown | true | frameSub | 6/6 | 6 | 22 / 24 | 2 / 13 | 1000x700 | – | 65 | – |  | view 0,0 1000x700 in content 48,97 1000x681; page 1000x700 at 1x |
| shown | true | cdpPng | 6/6 | 6 | 220 / 228 | -42 / -34 | 1000x700 | – | 309 | – |  | view 0,0 1000x700 in content 48,97 1000x681; page 1000x700 at 1x |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 98 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | – | 73 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 8,57 1008x681; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 8,57 1008x681; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 3974 / 3978 | -2940 / -48 | 1280x800 | – | 123 | – |  | view 0,0 1280x800 in content 8,57 1008x681; page 1280x800 at 1x |
| hiddenWindow | false | frameSub | 6/6 | 6 | 8 / 9 | 62 / 79 | 1280x800 | – | 37 | – |  | view 0,0 1280x800 in content 8,57 1008x681; page 1280x800 at 1x |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.5 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 8,57 1008x681; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 8,57 1008x681; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 75 / 104 | -44 / -33 | 1280x800 | – | 137 | – |  | view 0,0 1280x800 in content 8,57 1008x681; page 1280x800 at 1x |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 23 / 25 | 0 / 13 | 1280x800 | – | 80 | – |  | view 0,0 1280x800 in content 8,57 1008x681; page 1280x800 at 1x |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 6/6 | 6 | 20 / 22 | 3 / 15 | 1280x800 | – | 81 | – |  | view 0,0 1280x800 in content 0,0 1024x720; page 1280x800 at 1x |
| invisibleWindow | false | capturePage | 6/6 | 6 | 19 / 22 | 5 / 18 | 1280x800 | – | 80 | – |  | view 0,0 1280x800 in content 0,0 1024x720; page 1280x800 at 1x |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 70 / 80 | -34 / -33 | 1280x800 | – | 127 | – |  | view 0,0 1280x800 in content 0,0 1024x720; page 1280x800 at 1x |
| invisibleWindow | false | frameSub | 6/6 | 6 | 21 / 23 | 6 / 12 | 1280x800 | – | 83 | – |  | view 0,0 1280x800 in content 0,0 1024x720; page 1280x800 at 1x |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 21 / 25 | 1 / 11 | 1280x800 | – | 55 | – |  | view 0,0 1280x800 in content 0,0 4x31; page 1280x800 at 1x |
| tinyWindow | false | capturePage | 6/6 | 6 | 21 / 22 | 2 / 5 | 1280x800 | – | 60 | – |  | view 0,0 1280x800 in content 0,0 4x31; page 1280x800 at 1x |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 70 / 79 | -34 / -33 | 1280x800 | – | 94 | – |  | view 0,0 1280x800 in content 0,0 4x31; page 1280x800 at 1x |
| tinyWindow | false | frameSub | 6/6 | 6 | 23 / 27 | 5 / 8 | 1280x800 | – | 56 | – |  | view 0,0 1280x800 in content 0,0 4x31; page 1280x800 at 1x |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 21 / 23 | 2 / 15 | 1280x800 | – | 60 | – |  | view 0,0 1280x800 in content 0,0 4x31; page 1280x800 at 1x |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 18 / 24 | 2 / 15 | 1280x800 | – | 56 | – |  | view 0,0 1280x800 in content 0,0 4x31; page 1280x800 at 1x |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 71 / 80 | -35 / -32 | 1280x800 | – | 92 | – |  | view 0,0 1280x800 in content 0,0 4x31; page 1280x800 at 1x |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 22 / 26 | 5 / 15 | 1280x800 | – | 56 | – |  | view 0,0 1280x800 in content 0,0 4x31; page 1280x800 at 1x |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePageHidden | 6/6 | 6 | 20 / 24 | 2 / 9 | 1280x800 | – | 57 | – |  | view 0,0 1280x800 in content 0,0 4x31; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | capturePage | 6/6 | 6 | 18 / 22 | 3 / 16 | 1280x800 | – | 55 | – |  | view 0,0 1280x800 in content 0,0 4x31; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | cdpJpeg | 6/6 | 6 | 70 / 80 | -34 / -32 | 1280x800 | – | 93 | – |  | view 0,0 1280x800 in content 0,0 4x31; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | frameSub | 6/6 | 6 | 24 / 25 | 4 / 13 | 1280x800 | – | 57 | – |  | view 0,0 1280x800 in content 0,0 4x31; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 59 / 62 | 1024x720 | – | 26 | – |  | view - in content 0,0 1024x720; page 1024x720 at 1x |
| osr | false | capturePage | 6/6 | 6 | 19 / 21 | 20 / 29 | 1024x720 | 12 / 13 | 59 | – |  | view - in content 0,0 1024x720; page 1024x720 at 1x |
| osr | false | cdpJpeg | 6/6 | 6 | 132 / 133 | -84 / -80 | 1024x720 | – | 76 | – |  | view - in content 0,0 1024x720; page 1024x720 at 1x |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | – | 140 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 108 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 146 | privateBytes | 159 | 4 | 0.0 |
| 1 | 174 | privateBytes | 238 | 5 | 0.1 |
| 2 | 200 | privateBytes | 310 | 6 | 0.2 |
| 4 | 251 | privateBytes | 458 | 8 | 0.4 |
| 8 | 355 | privateBytes | 759 | 12 | 0.5 |

Per idle tab resting in the never-shown window (a still page): **26 MiB**, 0.06% CPU. Four tabs: one partition +100 MiB, four partitions +104 MiB.

Quiet tabs working in one shared 1×1 host (no rAF loop; the page repaints twice a second): **28 MiB** and 0.79% CPU a tab (0: 173 MiB / 0.8%, 1: 199 MiB / 1.1%, 4: 285 MiB / 3.7%, 8: 399 MiB / 7.2%).

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 42.8 | 24.1 | 18.4 | 64 |
| animated, never-shown window, throttling off | 1.9 | 1.4 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.2 | 0.0 | 0.0 | 0 |
| animated, never-shown window, throttling off + frame pump | 1.8 | 1.6 | 0.1 | 0 |
| animated, invisible shown window | 64.2 | 36.0 | 28.0 | 64 |
| animated, 1x1 shown window | 36.3 | 32.3 | 3.9 | 64 |
| animated, osr 30 fps | 23.6 | 11.9 | 7.4 | 30 |

**Waking a resting tab into the host** (never-shown window, throttling on, 4 cycles): first rAF 2 / 5 ms, fresh picture 37 / 43 ms; resting rates 1.9 Hz / rAF 0.0, 2.1 Hz / rAF 0.0, 1.8 Hz / rAF 0.0, 1.7 Hz / rAF 0.0; awake rAF 64, 64, 64, 64

**One host, 4 tabs (each held at 1280×800, 1×):** tab 1 rAF 64 Hz, capturePage 4/4 in 18 / 19 ms (1280x800); tab 2 rAF 64 Hz, capturePage 4/4 in 14 / 21 ms (1280x800); tab 3 rAF 64 Hz, capturePage 4/4 in 16 / 19 ms (1280x800); tab 4 rAF 64 Hz, capturePage 4/4 in 18 / 19 ms (1280x800)

**The host's invariants:** host 0,0 4x31, focused at start false, after its page grabs focus false (focused window "S7 probe"); Windows styles {"style":"0x14c00000","exStyle":"0x82801a0","toolWindow":true,"noActivate":true,"transparent":true,"layered":true,"appWindow":false}; click-through {"at":"2,15","tool":"SendInput via user32 SetCursorPos and mouse_event","belowClicks":1,"hostClicks":0}

**Assertions:** PASS no reload when moving from detached; PASS no reload when moving from hiddenWindow; PASS no reload when moving from hiddenWindowFit; PASS no reload when moving from invisibleWindow; PASS no reload when moving from tinyWindow; PASS the 1x1 host draws (rAF above 10 Hz); PASS a never-shown window draws nothing (rAF below 1 Hz); PASS capturePage works in the 1x1 host; PASS capturePage works in the 1x1 host with the agent's 1280x800 at 1x held; PASS the host never takes focus, even when its page asks; PASS Windows: the host is a no-activate, click-through tool window, not an app window; PASS Windows: a real click at the host's point reaches the window below; PASS a resting tab draws within 2 s of moving into the host, every cycle; PASS every tab in one shared host draws and is pictured

**Q6 streamed view** (10 s at the viewer; latency p50 / p95 ms)

| road | content | source | fps | decoded fps | latency | gap p95 | kbit/s | bytes/frame | sender CPU % | viewer CPU % | source rAF | notes |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| screencast | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | 0 |  |
| capturePoll | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | anim | hiddenWindow | 25.7 | 25.7 | 58 / 64 | 77 | 2497 | 12146 | 109 | 21 | 64 | libvpx; video/VP8 |
| webrtc-h264 | anim | hiddenWindow | 14.8 | 14.8 | 56 / 58 | 82 | 2488 | 21015 | 86 | 12 | 64 | OpenH264; video/H264 |
| webcodecs-vp8 | anim | hiddenWindow | 30.0 | 30.0 | 34 / 36 | 49 | 2173 | 9053 | 103 | 18 | 64 |  |
| webcodecs-h264 | anim | hiddenWindow | 30.0 | 30.0 | 32 / 35 | 48 | 2161 | 9004 | 99 | 17 | 64 |  |
| screencast | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | 0 |  |
| capturePoll | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | static | hiddenWindow | 2.0 | 2.0 | 75 / 81 | 520 | 558 | 34856 | 7 | 2 | 64 | libvpx; video/VP8 |
| webrtc-h264 | static | hiddenWindow | 1.0 | 1.0 | 34 / 153 | 1004 | 39 | 4929 | 6 | 1 | 64 | OpenH264; video/H264 |
| webcodecs-vp8 | static | hiddenWindow | 2.0 | 2.0 | 21 / 22 | 503 | 114 | 7110 | 7 | 1 | 64 |  |
| webcodecs-h264 | static | hiddenWindow | 2.0 | 2.0 | 20 / 22 | 502 | 95 | 5911 | 5 | 1 | 64 |  |
| screencast | anim | invisibleWindow | 64.1 | 64.1 | 39 / 43 | 20 | 60508 | 118179 | 177 | 39 | 64 |  |
| capturePoll | anim | invisibleWindow | 31.0 | 31.0 | 38 / 44 | 39 | 29532 | 118699 | 120 | 19 | 64 | toJPEG 8.0 ms |
| webcodecs-h264 | anim | invisibleWindow | 30.0 | 30.0 | 36 / 40 | 48 | 2171 | 9014 | 137 | 19 | 64 |  |
| screencast | anim | tinyWindow | 64.1 | 64.1 | 41 / 44 | 19 | 60615 | 118205 | 188 | 37 | 64 |  |
| webcodecs-h264 | anim | tinyWindow | 30.0 | 30.0 | 37 / 40 | 47 | 2161 | 9005 | 129 | 19 | 64 |  |
| screencast | anim | shown | 64.0 | 64.0 | 35 / 38 | 18 | 50877 | 99214 | 145 | 31 | 64 |  |
| webrtc-vp8 | anim | shown | 24.6 | 24.6 | 56 / 58 | 77 | 2510 | 12753 | 142 | 20 | 64 | libvpx; video/VP8 |
| webcodecs-h264 | anim | shown | 30.0 | 30.0 | 44 / 59 | 48 | 2206 | 9222 | 144 | 19 | 64 |  |

### The pair · linux-x64 (pair-linux.json)

7.0.0-1017-azure, 35 s, state **done**

- **login start**: {"daemonUpMs":113,"daemonUp":true,"appConnectedMs":2511,"appStartedBy":"daemon","appStart":{"at":1793853312845,"safeMode":false,"reason":"daemon start","ok":true,"how":"systemctl --user start clover-s7-app-3ef33d64.service","out":""},"daemonParent":971}
- **second daemon on the same home**: {"exitCode":0,"ms":25,"said":"2026-11-05T04:35:13.179Z [core 2336] another daemon holds this home (flock: held by another process); exiting","firstStillServing":true}
- **app crash**: {"killed":2285,"kill":{"ok":true,"how":"kill -9 2285","code":0,"out":""},"restartedMs":1220,"newPid":2350,"startedBy":"daemon","safeMode":false,"how":"systemctl --user start clover-s7-app-3ef33d64.service","eventsSinceKill":["start","tray","connected"]}
- **app crash loop → safe mode**: {"rounds":[{"killed":2350,"restartedMs":2225,"safeMode":false,"crashesInDaemon":2},{"killed":2411,"restartedMs":4144,"safeMode":true,"crashesInDaemon":3}],"thirdRestartInSafeMode":true}
- **daemon crash, restarted by the OS alone**: {"killed":2274,"kill":{"ok":true,"how":"kill -9 2274","code":0,"out":""},"daemonBackMs":1208,"newDaemonPid":2534,"appSurvived":true,"appPidAfter":2469,"samePid":true,"appStartedTheDaemon":false,"appEvents":["5ms daemon-lost","1511ms connected","1511ms reconnected"]}
- **daemon crash, the app helps after 3 s**: {"killed":2534,"kill":{"ok":true,"how":"kill -9 2534","code":0,"out":""},"daemonBackMs":1205,"newDaemonPid":2544,"appSurvived":true,"appPidAfter":2469,"samePid":true,"appStartedTheDaemon":false,"appEvents":["1ms daemon-lost","1506ms connected","1506ms reconnected"]}
- **tray Quit stops both, and they stay down**: {"forwarded":{"forwarded":true},"bothDownMs":402,"restartedWithin12s":false,"appEvents":["quit","quit-acked"]}
- **a user starts the app → it starts the daemon**: {"start":{"ok":true,"how":"spawn detached (as from a launcher)","code":0,"out":"2561"},"bothUpMs":512,"startedBy":"user","appStartedTheDaemon":[{"ok":true,"how":"systemctl --user start clover-s7-core-3ef33d64.service","out":""}],"appEvents":["start","tray","start-daemon","connected"]}
- **the daemon side's Quit stops both**: {"bothDownMs":401,"restartedWithin8s":false}

**Assertions:** PASS the login item starts the daemon, and the daemon the app; PASS a second daemon is refused and exits 0; PASS a crashed app is back within 6 s; PASS the start after the third crash in two minutes is in safe mode; PASS a crashed daemon is back within 5 s without the app's help; PASS a crashed daemon is back within 10 s, and the app lives on; PASS the tray's Quit stops both, and nothing restarts them; PASS a user's start of the app brings up both within 10 s; PASS the daemon side's Quit stops both, and nothing restarts them

### The pair · darwin-arm64 (pair-macos.json)

25.6.0, 38 s, state **done**

- **login start**: {"daemonUpMs":153,"daemonUp":true,"appConnectedMs":3826,"appStartedBy":"daemon","appStart":{"at":1793854499695,"safeMode":false,"reason":"daemon start","ok":true,"how":"open -n -g -a /Users/runner/work/clover/clover/spikes/s7-browser/prototype/node_modules/electron/dist/Electron.app --args /Users/runner/work/clover/clover/spikes/s7-browser/prototype/out/pair/app --home=/var/folders/h5/t85nd63d71x27_8gl5gw3l_w0000gn/T/clover-s7-pair-cqW6Aa","out":""},"daemonParent":1}
- **second daemon on the same home**: {"exitCode":0,"ms":137,"said":"2026-11-05T04:55:01.058Z [core 1702] another daemon holds this home (flock: held by another process); exiting","firstStillServing":true}
- **app crash**: {"killed":1690,"kill":{"ok":true,"how":"kill -9 1690","code":0,"out":""},"restartedMs":2025,"newPid":1706,"startedBy":"daemon","safeMode":false,"how":"open -n -g -a /Users/runner/work/clover/clover/spikes/s7-browser/prototype/node_modules/electron/dist/Electron.app --args /Users/runner/work/clover/clover/spikes/s7-browser/prototype/out/pair/app --home=/var/folders/h5/t85nd63d71x27_8gl5gw3l_w0000gn/T/clover-s7-pair-cqW6Aa","eventsSinceKill":["start","tray","connected"]}
- **app crash loop → safe mode**: {"rounds":[{"killed":1706,"restartedMs":2484,"safeMode":false,"crashesInDaemon":2},{"killed":1729,"restartedMs":5231,"safeMode":true,"crashesInDaemon":3}],"thirdRestartInSafeMode":true}
- **daemon crash, restarted by the OS alone**: {"killed":1652,"kill":{"ok":true,"how":"kill -9 1652","code":0,"out":""},"daemonBackMs":432,"newDaemonPid":1847,"appSurvived":true,"appPidAfter":1843,"samePid":true,"appStartedTheDaemon":false,"appEvents":["7ms daemon-lost","525ms connected","525ms reconnected"]}
- **daemon crash, the app helps after 3 s**: {"killed":1847,"kill":{"ok":true,"how":"kill -9 1847","code":0,"out":""},"daemonBackMs":1222,"newDaemonPid":1852,"appSurvived":true,"appPidAfter":1843,"samePid":true,"appStartedTheDaemon":false,"appEvents":["5ms daemon-lost","1525ms connected","1525ms reconnected"]}
- **tray Quit stops both, and they stay down**: {"forwarded":{"forwarded":true},"bothDownMs":367,"restartedWithin12s":false,"appEvents":["quit","quit-acked"]}
- **a user starts the app → it starts the daemon**: {"start":{"ok":true,"how":"open -n -g -a /Users/runner/work/clover/clover/spikes/s7-browser/prototype/node_modules/electron/dist/Electron.app --args /Users/runner/work/clover/clover/spikes/s7-browser/prototype/out/pair/app --home=/var/folders/h5/t85nd63d71x27_8gl5gw3l_w0000gn/T/clover-s7-pair-cqW6Aa","code":0,"out":""},"bothUpMs":749,"startedBy":"user","appStartedTheDaemon":[{"ok":true,"how":"launchctl kickstart gui/501/com.waifucave.clover.s7.core.d8d1e18a","out":""}],"appEvents":["start","tray","start-daemon","connected"]}
- **the daemon side's Quit stops both**: {"bothDownMs":406,"restartedWithin8s":false}

**Assertions:** PASS the login item starts the daemon, and the daemon the app; PASS a second daemon is refused and exits 0; PASS a crashed app is back within 6 s; PASS the start after the third crash in two minutes is in safe mode; PASS a crashed daemon is back within 5 s without the app's help; PASS a crashed daemon is back within 10 s, and the app lives on; PASS the tray's Quit stops both, and nothing restarts them; PASS a user's start of the app brings up both within 10 s; PASS the daemon side's Quit stops both, and nothing restarts them

### The pair · win32-x64 (pair-windows-spawn.json)

10.0.26100, 187 s, state **done**, Windows app start: spawn

- **login start**: {"daemonUpMs":343,"daemonUp":true,"appConnectedMs":3009,"appStartedBy":"daemon","appStart":{"at":1793853284815,"safeMode":false,"reason":"daemon start","ok":true,"how":"spawn detached","out":"8420"},"daemonParent":2680}
- **second daemon on the same home**: {"exitCode":0,"ms":66,"said":"2026-11-05T04:34:45.029Z [core 8496] another daemon holds this home (CreateFileW: error 32 (sharing violation: another daemon holds it)); exiting","firstStillServing":true}
- **app crash**: {"killed":8420,"kill":{"ok":true,"how":"taskkill /F /T /PID 8420","code":0,"out":"SUCCESS: The process with PID 7224 (child process of PID 8420) has been terminated.\r\nSUCCESS: The process with PID 7496 (child process of PID 8420) has been ter"},"restartedMs":1391,"newPid":3704,"startedBy":"daemon","safeMode":false,"how":"spawn detached","eventsSinceKill":["start","tray","connected"]}
- **app crash loop → safe mode**: {"rounds":[{"killed":3704,"restartedMs":2167,"safeMode":false,"crashesInDaemon":2},{"killed":3236,"restartedMs":4186,"safeMode":true,"crashesInDaemon":3}],"thirdRestartInSafeMode":true}
- **daemon crash, restarted by the OS alone**: {"killed":5196,"kill":{"ok":true,"how":"taskkill /F /PID 5196","code":0,"out":"SUCCESS: The process with PID 5196 has been terminated."},"appSurvived":true,"appPidAfter":6652,"samePid":true,"appStartedTheDaemon":{"atMs":150360,"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-dc55c61f"},"appEvents":["45ms daemon-lost","150360ms start-daemon","150865ms connected","150865ms reconnected"]}
- **daemon crash, the app helps after 3 s**: {"killed":4596,"kill":{"ok":true,"how":"taskkill /F /PID 4596","code":0,"out":"SUCCESS: The process with PID 4596 has been terminated."},"daemonBackMs":3291,"newDaemonPid":5840,"appSurvived":true,"appPidAfter":6652,"samePid":true,"appStartedTheDaemon":{"atMs":3126,"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-dc55c61f"},"appEvents":["81ms daemon-lost","3126ms start-daemon","3631ms connected","3631ms reconnected"]}
- **tray Quit stops both, and they stay down**: {"forwarded":{"forwarded":true},"bothDownMs":420,"restartedWithin12s":false,"appEvents":["quit","quit-acked"]}
- **a user starts the app → it starts the daemon**: {"start":{"ok":true,"how":"spawn detached","code":0,"out":"8884"},"bothUpMs":459,"startedBy":"user","appStartedTheDaemon":[{"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-dc55c61f","out":"SUCCESS: Attempted to run the scheduled task \"\\Clover S7\\core-dc55c61f\"."}],"appEvents":["start","tray","start-daemon","connected"]}
- **the daemon side's Quit stops both**: {"bothDownMs":320,"restartedWithin8s":false}

**Assertions:** PASS the login item starts the daemon, and the daemon the app; PASS a second daemon is refused and exits 0; PASS a crashed app is back within 6 s; PASS the start after the third crash in two minutes is in safe mode; PASS Task Scheduler alone does not restart a killed task (the finding the supervisor answers); PASS a crashed daemon is back within 10 s, and the app lives on; PASS the tray's Quit stops both, and nothing restarts them; PASS a user's start of the app brings up both within 10 s; PASS the daemon side's Quit stops both, and nothing restarts them

### The pair · win32-x64 (pair-windows-supervise.json)

10.0.26100, 36 s, state **done**, Windows app start: task, daemon under the supervisor

- **login start**: {"daemonUpMs":563,"daemonUp":true,"appConnectedMs":3802,"appStartedBy":"daemon","appStart":{"at":1793853184713,"safeMode":false,"reason":"daemon start","ok":true,"how":"schtasks /Run /TN \\Clover S7\\app-397e0d94","out":"SUCCESS: Attempted to run the scheduled task \"\\Clover S7\\app-397e0d94\"."},"daemonParent":2192}
- **second daemon on the same home**: {"exitCode":0,"ms":86,"said":"2026-11-05T04:33:05.927Z [core 4412] another daemon holds this home (CreateFileW: error 32 (sharing violation: another daemon holds it)); exiting","firstStillServing":true}
- **app crash**: {"killed":3312,"kill":{"ok":true,"how":"taskkill /F /T /PID 3312","code":0,"out":"SUCCESS: The process with PID 6948 (child process of PID 3312) has been terminated.\r\nSUCCESS: The process with PID 7644 (child process of PID 3312) has been ter"},"restartedMs":1213,"newPid":1452,"startedBy":"daemon","safeMode":false,"how":"schtasks /Run /TN \\Clover S7\\app-397e0d94","eventsSinceKill":["start","tray","connected"]}
- **app crash loop → safe mode**: {"rounds":[{"killed":1452,"restartedMs":2208,"safeMode":false,"crashesInDaemon":2},{"killed":7744,"restartedMs":4250,"safeMode":true,"crashesInDaemon":3}],"thirdRestartInSafeMode":true}
- **daemon crash, restarted by the OS alone**: {"killed":8164,"kill":{"ok":true,"how":"taskkill /F /PID 8164","code":0,"out":"SUCCESS: The process with PID 8164 has been terminated."},"daemonBackMs":619,"newDaemonPid":7916,"appSurvived":true,"appPidAfter":7912,"samePid":true,"appStartedTheDaemon":false,"appEvents":["55ms daemon-lost","1059ms connected","1059ms reconnected"]}
- **daemon crash, the app helps after 3 s**: {"killed":7916,"kill":{"ok":true,"how":"taskkill /F /PID 7916","code":0,"out":"SUCCESS: The process with PID 7916 has been terminated."},"daemonBackMs":1233,"newDaemonPid":8900,"appSurvived":true,"appPidAfter":7912,"samePid":true,"appStartedTheDaemon":false,"appEvents":["53ms daemon-lost","1564ms connected","1565ms reconnected"]}
- **tray Quit stops both, and they stay down**: {"forwarded":{"forwarded":true},"bothDownMs":335,"restartedWithin12s":false,"appEvents":["quit-acked"]}
- **a user starts the app → it starts the daemon**: {"start":{"ok":true,"how":"spawn detached","code":0,"out":"7752"},"bothUpMs":561,"startedBy":"user","appStartedTheDaemon":[{"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-397e0d94","out":"SUCCESS: Attempted to run the scheduled task \"\\Clover S7\\core-397e0d94\"."}],"appEvents":["start","tray","start-daemon","connected"]}
- **the daemon side's Quit stops both**: {"bothDownMs":319,"restartedWithin8s":false}

**Assertions:** PASS the login item starts the daemon, and the daemon the app; PASS a second daemon is refused and exits 0; PASS a crashed app is back within 6 s; PASS the start after the third crash in two minutes is in safe mode; PASS a crashed daemon is back within 5 s without the app's help; PASS a crashed daemon is back within 10 s, and the app lives on; PASS the tray's Quit stops both, and nothing restarts them; PASS a user's start of the app brings up both within 10 s; PASS the daemon side's Quit stops both, and nothing restarts them

### The pair · win32-x64 (pair-windows-task.json)

10.0.26100, 188 s, state **done**, Windows app start: task

- **login start**: {"daemonUpMs":345,"daemonUp":true,"appConnectedMs":2957,"appStartedBy":"daemon","appStart":{"at":1793853178591,"safeMode":false,"reason":"daemon start","ok":true,"how":"schtasks /Run /TN \\Clover S7\\app-2bb8a068","out":"SUCCESS: Attempted to run the scheduled task \"\\Clover S7\\app-2bb8a068\"."},"daemonParent":2648}
- **second daemon on the same home**: {"exitCode":0,"ms":82,"said":"2026-11-05T04:32:59.143Z [core 4108] another daemon holds this home (CreateFileW: error 32 (sharing violation: another daemon holds it)); exiting","firstStillServing":true}
- **app crash**: {"killed":9004,"kill":{"ok":true,"how":"taskkill /F /T /PID 9004","code":0,"out":"SUCCESS: The process with PID 7244 (child process of PID 9004) has been terminated.\r\nSUCCESS: The process with PID 7188 (child process of PID 9004) has been ter"},"restartedMs":1222,"newPid":8220,"startedBy":"daemon","safeMode":false,"how":"schtasks /Run /TN \\Clover S7\\app-2bb8a068","eventsSinceKill":["start","tray","connected"]}
- **app crash loop → safe mode**: {"rounds":[{"killed":8220,"restartedMs":2231,"safeMode":false,"crashesInDaemon":2},{"killed":4084,"restartedMs":4202,"safeMode":true,"crashesInDaemon":3}],"thirdRestartInSafeMode":true}
- **daemon crash, restarted by the OS alone**: {"killed":8568,"kill":{"ok":true,"how":"taskkill /F /PID 8568","code":0,"out":"SUCCESS: The process with PID 8568 has been terminated."},"appSurvived":true,"appPidAfter":7056,"samePid":true,"appStartedTheDaemon":{"atMs":150623,"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-2bb8a068"},"appEvents":["61ms daemon-lost","150623ms start-daemon","151126ms connected","151126ms reconnected"]}
- **daemon crash, the app helps after 3 s**: {"killed":3432,"kill":{"ok":true,"how":"taskkill /F /PID 3432","code":0,"out":"SUCCESS: The process with PID 3432 has been terminated."},"daemonBackMs":3304,"newDaemonPid":8896,"appSurvived":true,"appPidAfter":7056,"samePid":true,"appStartedTheDaemon":{"atMs":3140,"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-2bb8a068"},"appEvents":["100ms daemon-lost","3140ms start-daemon","3646ms connected","3646ms reconnected"]}
- **tray Quit stops both, and they stay down**: {"forwarded":{"forwarded":true},"bothDownMs":339,"restartedWithin12s":false,"appEvents":["quit","quit-acked"]}
- **a user starts the app → it starts the daemon**: {"start":{"ok":true,"how":"spawn detached","code":0,"out":"7232"},"bothUpMs":542,"startedBy":"user","appStartedTheDaemon":[{"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-2bb8a068","out":"SUCCESS: Attempted to run the scheduled task \"\\Clover S7\\core-2bb8a068\"."}],"appEvents":["start","tray","start-daemon","connected"]}
- **the daemon side's Quit stops both**: {"bothDownMs":329,"restartedWithin8s":false}

**Assertions:** PASS the login item starts the daemon, and the daemon the app; PASS a second daemon is refused and exits 0; PASS a crashed app is back within 6 s; PASS the start after the third crash in two minutes is in safe mode; PASS Task Scheduler alone does not restart a killed task (the finding the supervisor answers); PASS a crashed daemon is back within 10 s, and the app lives on; PASS the tray's Quit stops both, and nothing restarts them; PASS a user's start of the app brings up both within 10 s; PASS the daemon side's Quit stops both, and nothing restarts them

