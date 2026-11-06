## Spike S7 results

### Chrome for Testing · linux-arm64 (cft-linux-arm64-install.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 5 s

**chrome-headless-shell** — ; sandbox –

- install: 121 MiB archive, 277 MiB unpacked, 287 files, 0 symlinks; download 852 ms, unpack 976 ms; sha256 `5bb6a00a4285c13303d3f72c5afdb70f144ea7a93eed462365a52b69631c9607` (matches the pin; server MD5 true)

**chrome** — ; sandbox –

- install: 191 MiB archive, 401 MiB unpacked, 301 files, 0 symlinks; download 1424 ms, unpack 1354 ms; sha256 `1f496a826c9ba4d6a5f5bf2de686145fe718528c2cc3dbeb96b5893b89653724` (matches the pin; server MD5 true)

**Assertions:** PASS the headless shell installs from its pin

### Chrome for Testing · linux-arm64 (cft-linux-arm64-worker.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 203 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 121 MiB archive, 277 MiB unpacked, 287 files, 0 symlinks; download 852 ms, unpack 976 ms; sha256 `5bb6a00a4285c13303d3f72c5afdb70f144ea7a93eed462365a52b69631c9607` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 58 ms, warm 47 ms; the port for comparison 54 ms
- start attempts: fdpipe ok 58 ms
- tabs: own window: first (background): visible, 1280x800, interval 100.1 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x800, interval 100.2 Hz, rAF 60.0 Hz; one window: first (background): visible, 1280x800, interval 99.9 Hz, rAF 60.0 Hz; one window: second (front): visible, 1280x800, interval 100.0 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.2 Hz, rAF 60.0 Hz, media ×0.94, decoded 28.8 fps, audio running, set up in 33 ms, browser answers in 0 ms
- resize to 1000×700 and back: 2 ms / 23 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 215 / 227 ms (639 KiB, CPU 331 ms), jpeg 70 / 83 ms (165 KiB, stale -44 / -34 ms, CPU 134 ms)
- screencast: 60.3 fps, 66789 kbit/s, 135 KiB/frame, latency 32 / 33 ms, browser CPU 144%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 207 MiB, per idle tab 29 MiB, 4 browser contexts +114 MiB, a second bot's browser 110 MiB (7 processes), animated tab 53.3% CPU
  - steps: 0 tabs 207 MiB pss / 0.3%, 1 tabs 246 MiB pss / 3.2%, 2 tabs 275 MiB pss / 6.5%, 4 tabs 330 MiB pss / 12.2%, 8 tabs 441 MiB pss / 24.6%

**chrome** — Chrome/156.0.8078.80; sandbox on

- install: 191 MiB archive, 401 MiB unpacked, 301 files, 0 symlinks; download 1424 ms, unpack 1354 ms; sha256 `1f496a826c9ba4d6a5f5bf2de686145fe718528c2cc3dbeb96b5893b89653724` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 225 ms, warm 218 ms; the port for comparison 242 ms
- start attempts: fdpipe ok 225 ms
- tabs: own window: first (background): visible, 1280x657, interval 100.1 Hz, rAF 60.2 Hz; own window: second (front): visible, 1280x657, interval 100.1 Hz, rAF 60.0 Hz; one window: first (background): hidden, 1280x657, interval 1.0 Hz, rAF 0.0 Hz; one window: second (front): visible, 1280x657, interval 99.9 Hz, rAF 60.2 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.2 Hz, media ×0.94, decoded 29.0 fps, audio running, set up in 62 ms, browser answers in 0 ms
- resize to 1000×700 and back: 2 ms / 23 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 188 / 194 ms (513 KiB, CPU 300 ms), jpeg 72 / 74 ms (144 KiB, stale -40 / -38 ms, CPU 140 ms)
- screencast: 60.4 fps, 58162 kbit/s, 118 KiB/frame, latency 32 / 33 ms, browser CPU 139%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 423 MiB, per idle tab 58 MiB, 4 browser contexts +333 MiB, a second bot's browser 261 MiB (10 processes), animated tab 59.5% CPU
  - steps: 0 tabs 423 MiB pss / 0.5%, 1 tabs 502 MiB pss / 3.7%, 2 tabs 580 MiB pss / 6.2%, 4 tabs 656 MiB pss / 14.1%, 8 tabs 884 MiB pss / 28.4%

**Assertions:** PASS the headless shell installs from its pin; PASS it starts over the native DevTools pipe; PASS it runs sandboxed; PASS no step failed; PASS every tab is visible and draws (rAF above 10 Hz); PASS screenshots and a screencast arrive, fresh; PASS per-bot profiles are apart and survive a restart

### Chrome for Testing · linux-arm64 (cft-linux-arm64.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 207 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 121 MiB archive, 277 MiB unpacked, 287 files, 0 symlinks; download 852 ms, unpack 976 ms; sha256 `5bb6a00a4285c13303d3f72c5afdb70f144ea7a93eed462365a52b69631c9607` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 1768 ms, warm 54 ms; the port for comparison 58 ms
- start attempts: fdpipe ok 1768 ms
- tabs: own window: first (background): visible, 1280x800, interval 100.1 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x800, interval 100.1 Hz, rAF 60.0 Hz; one window: first (background): visible, 1280x800, interval 100.1 Hz, rAF 60.1 Hz; one window: second (front): visible, 1280x800, interval 100.1 Hz, rAF 60.2 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 99.9 Hz, rAF 60.2 Hz, media ×0.94, decoded 29.0 fps, audio running, set up in 83 ms, browser answers in 0 ms
- resize to 1000×700 and back: 2 ms / 22 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 217 / 224 ms (641 KiB, CPU 339 ms), jpeg 74 / 86 ms (165 KiB, stale -42 / -34 ms, CPU 138 ms)
- screencast: 60.3 fps, 66789 kbit/s, 135 KiB/frame, latency 32 / 34 ms, browser CPU 147%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 175 MiB, per idle tab 30 MiB, 4 browser contexts +119 MiB, a second bot's browser 113 MiB (7 processes), animated tab 52.6% CPU
  - steps: 0 tabs 175 MiB pss / 0.0%, 1 tabs 217 MiB pss / 2.7%, 2 tabs 247 MiB pss / 6.5%, 4 tabs 303 MiB pss / 13.4%, 8 tabs 413 MiB pss / 26.4%

**chrome** — Chrome/156.0.8078.80; sandbox on

- install: 191 MiB archive, 401 MiB unpacked, 301 files, 0 symlinks; download 1424 ms, unpack 1354 ms; sha256 `1f496a826c9ba4d6a5f5bf2de686145fe718528c2cc3dbeb96b5893b89653724` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 395 ms, warm 226 ms; the port for comparison 258 ms
- start attempts: fdpipe ok 395 ms
- tabs: own window: first (background): visible, 1280x657, interval 99.9 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x657, interval 99.9 Hz, rAF 60.0 Hz; one window: first (background): hidden, 1280x657, interval 1.0 Hz, rAF 0.0 Hz; one window: second (front): visible, 1280x657, interval 100.0 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.2 Hz, media ×0.94, decoded 29.0 fps, audio running, set up in 82 ms, browser answers in 0 ms
- resize to 1000×700 and back: 2 ms / 23 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 191 / 199 ms (525 KiB, CPU 310 ms), jpeg 72 / 73 ms (145 KiB, stale -40 / -36 ms, CPU 140 ms)
- screencast: 60.5 fps, 58323 kbit/s, 118 KiB/frame, latency 31 / 32 ms, browser CPU 137%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 478 MiB, per idle tab 54 MiB, 4 browser contexts +333 MiB, a second bot's browser 278 MiB (12 processes), animated tab 57.3% CPU
  - steps: 0 tabs 478 MiB pss / 1.7%, 1 tabs 553 MiB pss / 3.2%, 2 tabs 632 MiB pss / 6.7%, 4 tabs 707 MiB pss / 14.1%, 8 tabs 913 MiB pss / 26.5%

**Assertions:** PASS the headless shell installs from its pin; PASS it starts over the native DevTools pipe; PASS it runs sandboxed; PASS no step failed; PASS every tab is visible and draws (rAF above 10 Hz); PASS screenshots and a screencast arrive, fresh; PASS per-bot profiles are apart and survive a restart

### Chrome for Testing · linux-x64 (cft-linux-x64-install.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 6 s

**chrome-headless-shell** — ; sandbox –

- install: 121 MiB archive, 274 MiB unpacked, 287 files, 0 symlinks; download 931 ms, unpack 1233 ms; sha256 `547dcd374e02961bf998f6046a267644f8502225c36bb78ca307dab32a0b3eb4` (matches the pin; server MD5 true)

**chrome** — ; sandbox –

- install: 192 MiB archive, 403 MiB unpacked, 301 files, 0 symlinks; download 1559 ms, unpack 1761 ms; sha256 `b711c720f774be355197f32edf37e0651418ba036d92446ee2da19ac017540a7` (matches the pin; server MD5 true)

**Assertions:** PASS the headless shell installs from its pin

### Chrome for Testing · linux-x64 (cft-linux-x64-worker.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 207 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 121 MiB archive, 274 MiB unpacked, 287 files, 0 symlinks; download 931 ms, unpack 1233 ms; sha256 `547dcd374e02961bf998f6046a267644f8502225c36bb78ca307dab32a0b3eb4` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 98 ms, warm 79 ms; the port for comparison 72 ms
- start attempts: fdpipe ok 98 ms
- tabs: own window: first (background): visible, 1280x800, interval 100.0 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x800, interval 100.0 Hz, rAF 60.0 Hz; one window: first (background): visible, 1280x800, interval 99.9 Hz, rAF 60.2 Hz; one window: second (front): visible, 1280x800, interval 100.0 Hz, rAF 60.2 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.0 Hz, media ×0.94, decoded 28.8 fps, audio running, set up in 41 ms, browser answers in 0 ms
- resize to 1000×700 and back: 2 ms / 22 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 292 / 308 ms (638 KiB, CPU 398 ms), jpeg 75 / 89 ms (157 KiB, stale -38 / -34 ms, CPU 113 ms)
- screencast: 60.1 fps, 65802 kbit/s, 134 KiB/frame, latency 36 / 40 ms, browser CPU 168%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 172 MiB, per idle tab 29 MiB, 4 browser contexts +117 MiB, a second bot's browser 114 MiB (7 processes), animated tab 33.6% CPU
  - steps: 0 tabs 172 MiB pss / 0.0%, 1 tabs 213 MiB pss / 3.5%, 2 tabs 242 MiB pss / 5.7%, 4 tabs 297 MiB pss / 12.4%, 8 tabs 407 MiB pss / 22.8%

**chrome** — Chrome/156.0.8078.80; sandbox on

- install: 192 MiB archive, 403 MiB unpacked, 301 files, 0 symlinks; download 1559 ms, unpack 1761 ms; sha256 `b711c720f774be355197f32edf37e0651418ba036d92446ee2da19ac017540a7` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 246 ms, warm 254 ms; the port for comparison 277 ms
- start attempts: fdpipe ok 246 ms
- tabs: own window: first (background): visible, 1280x657, interval 100.2 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x657, interval 100.0 Hz, rAF 60.0 Hz; one window: first (background): hidden, 1280x657, interval 1.8 Hz, rAF 0.0 Hz; one window: second (front): visible, 1280x657, interval 100.0 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.0 Hz, media ×0.95, decoded 28.8 fps, audio running, set up in 78 ms, browser answers in 0 ms
- resize to 1000×700 and back: 2 ms / 22 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 239 / 259 ms (520 KiB, CPU 355 ms), jpeg 73 / 84 ms (143 KiB, stale -41 / -34 ms, CPU 120 ms)
- screencast: 60.9 fps, 58214 kbit/s, 117 KiB/frame, latency 32 / 35 ms, browser CPU 140%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 410 MiB, per idle tab 63 MiB, 4 browser contexts +324 MiB, a second bot's browser 258 MiB (10 processes), animated tab 52.5% CPU
  - steps: 0 tabs 410 MiB pss / 1.2%, 1 tabs 493 MiB pss / 3.0%, 2 tabs 551 MiB pss / 6.2%, 4 tabs 651 MiB pss / 11.4%, 8 tabs 916 MiB pss / 21.1%

**Assertions:** PASS the headless shell installs from its pin; PASS it starts over the native DevTools pipe; PASS it runs sandboxed; PASS no step failed; PASS every tab is visible and draws (rAF above 10 Hz); PASS screenshots and a screencast arrive, fresh; PASS per-bot profiles are apart and survive a restart

### Chrome for Testing · linux-x64 (cft-linux-x64.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 208 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 121 MiB archive, 274 MiB unpacked, 287 files, 0 symlinks; download 931 ms, unpack 1233 ms; sha256 `547dcd374e02961bf998f6046a267644f8502225c36bb78ca307dab32a0b3eb4` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 1142 ms, warm 82 ms; the port for comparison 78 ms
- start attempts: fdpipe ok 1142 ms
- tabs: own window: first (background): visible, 1280x800, interval 100.1 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x800, interval 100.2 Hz, rAF 60.0 Hz; one window: first (background): visible, 1280x800, interval 100.1 Hz, rAF 60.0 Hz; one window: second (front): visible, 1280x800, interval 100.2 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.0 Hz, media ×0.92, decoded 29.0 fps, audio running, set up in 235 ms, browser answers in 0 ms
- resize to 1000×700 and back: 2 ms / 22 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 289 / 299 ms (632 KiB, CPU 381 ms), jpeg 74 / 89 ms (157 KiB, stale -38 / -34 ms, CPU 111 ms)
- screencast: 60.3 fps, 66035 kbit/s, 134 KiB/frame, latency 36 / 39 ms, browser CPU 160%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 171 MiB, per idle tab 29 MiB, 4 browser contexts +117 MiB, a second bot's browser 115 MiB (7 processes), animated tab 35.8% CPU
  - steps: 0 tabs 171 MiB pss / 0.0%, 1 tabs 212 MiB pss / 3.2%, 2 tabs 241 MiB pss / 6.0%, 4 tabs 296 MiB pss / 10.7%, 8 tabs 406 MiB pss / 21.3%

**chrome** — Chrome/156.0.8078.80; sandbox on

- install: 192 MiB archive, 403 MiB unpacked, 301 files, 0 symlinks; download 1559 ms, unpack 1761 ms; sha256 `b711c720f774be355197f32edf37e0651418ba036d92446ee2da19ac017540a7` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 293 ms, warm 228 ms; the port for comparison 291 ms
- start attempts: fdpipe ok 293 ms
- tabs: own window: first (background): visible, 1280x657, interval 99.9 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x657, interval 99.9 Hz, rAF 60.0 Hz; one window: first (background): hidden, 1280x657, interval 1.0 Hz, rAF 0.0 Hz; one window: second (front): visible, 1280x657, interval 99.9 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.0 Hz, media ×0.94, decoded 29.0 fps, audio running, set up in 95 ms, browser answers in 0 ms
- resize to 1000×700 and back: 1 ms / 23 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 240 / 253 ms (519 KiB, CPU 344 ms), jpeg 82 / 84 ms (141 KiB, stale -47 / -35 ms, CPU 120 ms)
- screencast: 60.5 fps, 57852 kbit/s, 117 KiB/frame, latency 32 / 37 ms, browser CPU 139%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 437 MiB, per idle tab 59 MiB, 4 browser contexts +323 MiB, a second bot's browser 284 MiB (12 processes), animated tab 44.1% CPU
  - steps: 0 tabs 437 MiB pss / 1.5%, 1 tabs 516 MiB pss / 3.0%, 2 tabs 574 MiB pss / 5.4%, 4 tabs 677 MiB pss / 10.8%, 8 tabs 906 MiB pss / 19.6%

**Assertions:** PASS the headless shell installs from its pin; PASS it starts over the native DevTools pipe; PASS it runs sandboxed; PASS no step failed; PASS every tab is visible and draws (rAF above 10 Hz); PASS screenshots and a screencast arrive, fresh; PASS per-bot profiles are apart and survive a restart

### Chrome for Testing · darwin-arm64 (cft-macos-install.json)

25.6.0, 3 CPUs, 7 GiB, Bun 1.3.14, status **done**, 8 s

**chrome-headless-shell** — ; sandbox –

- install: 99 MiB archive, 204 MiB unpacked, 16 files, 0 symlinks; download 1486 ms, unpack 1572 ms; sha256 `ea615baa2e9caf0d02d1898a6562b5f8fa9c35239707dae0f592178df5b986ac` (matches the pin; server MD5 true)

**chrome** — ; sandbox –

- install: 186 MiB archive, 366 MiB unpacked, 344 files, 5 symlinks; download 2023 ms, unpack 2367 ms; sha256 `8bc590d1b1acac042a000234c768f31830f25a3983a83ed5e067114c87c4cad1` (matches the pin; server MD5 true)

**Assertions:** PASS the headless shell installs from its pin

### Chrome for Testing · darwin-arm64 (cft-macos.json)

25.6.0, 3 CPUs, 7 GiB, Bun 1.3.14, status **done**, 242 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 99 MiB archive, 204 MiB unpacked, 16 files, 0 symlinks; download 1486 ms, unpack 1572 ms; sha256 `ea615baa2e9caf0d02d1898a6562b5f8fa9c35239707dae0f592178df5b986ac` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 337 ms, warm 125 ms; the port for comparison 384 ms
- start attempts: fdpipe ok 337 ms
- tabs: own window: first (background): visible, 1280x800, interval 71.1 Hz, rAF 42.8 Hz; own window: second (front): visible, 1280x800, interval 66.9 Hz, rAF 38.0 Hz; one window: first (background): visible, 1280x800, interval 68.3 Hz, rAF 45.0 Hz; one window: second (front): visible, 1280x800, interval 72.3 Hz, rAF 45.8 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 62.4 Hz, rAF 27.4 Hz, media ×0.94, decoded 29.6 fps, audio running, set up in 311 ms, browser answers in 0 ms
- resize to 1000×700 and back: 5 ms / 26 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 334 / 406 ms (635 KiB, CPU 278 ms), jpeg 137 / 202 ms (130 KiB, stale -72 / -40 ms, CPU 108 ms)
- screencast: 31.4 fps, 30283 kbit/s, 118 KiB/frame, latency 62 / 93 ms, browser CPU 55%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 44 MiB, per idle tab 46 MiB, 4 browser contexts +179 MiB, a second bot's browser 45 MiB (4 processes), animated tab 25.7% CPU
  - steps: 0 tabs 44 MiB footprint / 0.7%, 1 tabs 90 MiB footprint / 2.7%, 2 tabs 136 MiB footprint / 4.7%, 4 tabs 226 MiB footprint / 11.6%, 8 tabs 408 MiB footprint / 21.6%

**chrome** — Chrome/156.0.8078.80; sandbox on

- install: 186 MiB archive, 366 MiB unpacked, 344 files, 5 symlinks; download 2023 ms, unpack 2367 ms; sha256 `8bc590d1b1acac042a000234c768f31830f25a3983a83ed5e067114c87c4cad1` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 3821 ms, warm 635 ms; the port for comparison 1757 ms
- start attempts: fdpipe ok 3821 ms
- tabs: own window: first (background): visible, 1280x657, interval 61.1 Hz, rAF 27.0 Hz; own window: second (front): hidden, 1280x657, interval 1.2 Hz, rAF 0.0 Hz; one window: first (background): hidden, 1280x657, interval 1.2 Hz, rAF 0.0 Hz; one window: second (front): visible, 1280x657, interval 65.0 Hz, rAF 23.1 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 63.9 Hz, rAF 23.4 Hz, media ×1.01, decoded 29.6 fps, audio running, set up in 484 ms, browser answers in 1 ms
- resize to 1000×700 and back: 12 ms / 3 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 198 / 353 ms (475 KiB, CPU 215 ms), jpeg 159 / 296 ms (118 KiB, stale -83 / -31 ms, CPU 81 ms)
- screencast: 33.4 fps, 27758 kbit/s, 102 KiB/frame, latency 78 / 129 ms, browser CPU 45%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 270 MiB, per idle tab 55 MiB, 4 browser contexts +438 MiB, a second bot's browser 253 MiB (9 processes), animated tab 23.1% CPU
  - steps: 0 tabs 270 MiB footprint / 4.9%, 1 tabs 373 MiB footprint / 4.5%, 2 tabs 427 MiB footprint / 6.1%, 4 tabs 504 MiB footprint / 7.8%, 8 tabs 712 MiB footprint / 4.0%

**Assertions:** PASS the headless shell installs from its pin; PASS it starts over the native DevTools pipe; PASS it runs sandboxed; PASS no step failed; PASS every tab is visible and draws (rAF above 10 Hz); PASS screenshots and a screencast arrive, fresh; PASS per-bot profiles are apart and survive a restart

### Chrome for Testing · win32-x64 (cft-windows-install.json)

10.0.26100, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 5 s

**chrome-headless-shell** — ; sandbox –

- install: 120 MiB archive, 282 MiB unpacked, 288 files, 0 symlinks; download 720 ms, unpack 1300 ms; sha256 `10a77466005e7f64e00f1a75fd1ea81f4a38a60093c65fea6895843b26e60a9a` (matches the pin; server MD5 true)

**chrome** — ; sandbox –

- install: 199 MiB archive, 439 MiB unpacked, 305 files, 0 symlinks; download 1095 ms, unpack 2094 ms; sha256 `16edb57d6107bf1c48a7c149b8d78b155fe614410093796dd72441fd6640540f` (matches the pin; server MD5 true)

**Assertions:** PASS the headless shell installs from its pin

### Chrome for Testing · win32-x64 (cft-windows.json)

10.0.26100, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 242 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 120 MiB archive, 282 MiB unpacked, 288 files, 0 symlinks; download 720 ms, unpack 1300 ms; sha256 `10a77466005e7f64e00f1a75fd1ea81f4a38a60093c65fea6895843b26e60a9a` (matches the pin; server MD5 true)
- start: over **winpipe**, cold 136 ms, warm 105 ms; the port for comparison 171 ms
- start attempts: winpipe ok 136 ms
- tabs: own window: first (background): visible, 1280x800, interval 100.0 Hz, rAF 59.9 Hz; own window: second (front): visible, 1280x800, interval 99.9 Hz, rAF 59.9 Hz; one window: first (background): visible, 1280x800, interval 100.2 Hz, rAF 60.1 Hz; one window: second (front): visible, 1280x800, interval 100.0 Hz, rAF 59.9 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.1 Hz, rAF 59.9 Hz, media ×0.94, decoded 29.2 fps, audio running, set up in 63 ms, browser answers in 5 ms
- resize to 1000×700 and back: 9 ms / 9 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 287 / 290 ms (580 KiB, CPU 531 ms), jpeg 83 / 94 ms (147 KiB, stale -47 / -36 ms, CPU 203 ms)
- screencast: 58.1 fps, 54580 kbit/s, 115 KiB/frame, latency 42 / 49 ms, browser CPU 174%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 68 MiB, per idle tab 30 MiB, 4 browser contexts +117 MiB, a second bot's browser 69 MiB (5 processes), animated tab 52.3% CPU
  - steps: 0 tabs 68 MiB privateBytes / 0.0%, 1 tabs 100 MiB privateBytes / 3.8%, 2 tabs 130 MiB privateBytes / 3.8%, 4 tabs 191 MiB privateBytes / 20.3%, 8 tabs 311 MiB privateBytes / 35.1%

**chrome** — Chrome/156.0.8078.80; sandbox on

- install: 199 MiB archive, 439 MiB unpacked, 305 files, 0 symlinks; download 1095 ms, unpack 2094 ms; sha256 `16edb57d6107bf1c48a7c149b8d78b155fe614410093796dd72441fd6640540f` (matches the pin; server MD5 true)
- start: over **winpipe**, cold 746 ms, warm 440 ms; the port for comparison 609 ms
- start attempts: winpipe ok 746 ms
- tabs: own window: first (background): visible, 1264x649, interval 99.6 Hz, rAF 59.7 Hz; own window: second (front): visible, 1264x649, interval 99.6 Hz, rAF 59.7 Hz; one window: first (background): hidden, 1264x649, interval 1.0 Hz, rAF 0.0 Hz; one window: second (front): visible, 1264x649, interval 100.0 Hz, rAF 59.9 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.1 Hz, media ×0.99, decoded 29.1 fps, audio running, set up in 60 ms, browser answers in 5 ms
- resize to 1000×700 and back: 10 ms / 11 ms, same document true (1264 → 1000 → 1264)
- screenshots: png 232 / 247 ms (459 KiB, CPU 404 ms), jpeg 74 / 92 ms (104 KiB, stale -41 / -36 ms, CPU 158 ms)
- screencast: 60.4 fps, 47415 kbit/s, 96 KiB/frame, latency 35 / 41 ms, browser CPU 125%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 259 MiB, per idle tab 52 MiB, 4 browser contexts +468 MiB, a second bot's browser 244 MiB (11 processes), animated tab 52.1% CPU
  - steps: 0 tabs 259 MiB privateBytes / 2.1%, 1 tabs 339 MiB privateBytes / 3.1%, 2 tabs 396 MiB privateBytes / 4.8%, 4 tabs 422 MiB privateBytes / 24.6%, 8 tabs 672 MiB privateBytes / 34.0%

**Assertions:** PASS the headless shell installs from its pin; PASS it starts over the native DevTools pipe; PASS it runs sandboxed; PASS no step failed; PASS every tab is visible and draws (rAF above 10 Hz); PASS screenshots and a screencast arrive, fresh; PASS per-bot profiles are apart and survive a restart

### Electron · linux-arm64-ozone-headless (electron-linux-arm64-ozone-headless.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-arm64 7.0.0-1017-azure, ozone headless, displays 1920x1080@1, status **done**, 572 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.93 | 27.9 | 27 / 37 | 1 / 6 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.95 | 28.4 | 13 / 26 | 3 / 17 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.4 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.95 | 28.4 | 26 / 28 | 17 / 19 | 1280x800@1 → 1000x700@1 → 1280x800 | 1 / 1 | 2.4 |  |
| invisibleWindow | true | true | true | true (1) | 0.96 | 28.6 | 14 / 26 | 2 / 16 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.1 |  |
| tinyWindow | true | true | true | true (1) | 0.97 | 28.6 | 14 / 27 | 2 / 5 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.0 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | IO / RO Hz | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 100.1 | 99.1 | 60.2 | 17 | 2.2 / 2.2 | – | – | – | 4.4 | 6.0 |  |
| detached, throttling on (default) | hidden | 1280x800 | 2.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.0 |  |
| detached, throttling off | visible | 1280x800 | 100.1 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.8 | 0.8 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.4 |  |
| never-shown window, throttling off | visible | 1280x800 | 100.1 | 99.3 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.8 | 1.4 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 99.9 | 99.3 | 1.0 | 1018 | 0.0 / 0.0 | – | – | – | 1.2 | 1.6 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 100.1 | 99.3 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 1.0 | 1.0 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 100.1 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 0.8 | 1.0 |  |
| invisible shown window, throttling off | visible | 1280x800 | 100.2 | 99.2 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 4.0 | 5.8 |  |
| 1x1 shown window, throttling off | visible | 1280x800 | 99.9 | 99.1 | 60.0 | 17 | 2.2 / 2.2 | – | – | – | 4.2 | 5.4 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 100.0 | 99.4 | 60.2 | 17 | 2.2 / 2.2 | – | – | – | 4.2 | 5.4 | cover 0,0 1920x1080 over host 0,0 1x1 |
| 1x1 shown window kept above a cover window (always on top) | visible | 1280x800 | 100.2 | 99.2 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 4.2 | 5.4 | cover 0,0 1920x1080 over host 0,0 1x1 |
| invisible shown window, covered by another window | visible | 1280x800 | 99.9 | 99.3 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 4.2 | 6.0 | cover -1480,-1000 1920x1080 over host -1480,-1000 1280x800 |
| 1x1 shown window, throttling on (control) | visible | 1280x800 | 99.9 | 99.3 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 4.2 | 5.2 |  |
| 1x1 shown window, throttling on, covered by another window (control) | visible | 1280x800 | 100.2 | 99.2 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 4.0 | 5.4 | cover 0,0 1920x1080 over host 0,0 1x1 |
| invisible shown window, throttling on, covered by another window (control) | visible | 1280x800 | 100.1 | 99.1 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 4.0 | 5.6 | cover -1480,-1000 1920x1080 over host -1480,-1000 1280x800 |
| osr window 30 fps, throttling off | visible | 1280x800 | 100.0 | 99.2 | 30.0 | 34 | 2.0 / 2.0 | – | – | – | 3.6 | 12.0 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 100.0 | 99.4 | 30.0 | 34 | 0.0 / 2.0 | – | – | – | 1.8 | 2.2 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 100.0 | 99.4 | 0.0 | 0 | 0.0 / 0.0 | 0.84 | 25.6 | – | 2.4 | 3.0 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 100.0 | 99.4 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 25.8 | – | 2.2 | 3.0 |  |
| detached, throttling off, playing media | visible | 1280x800 | 100.0 | 99.4 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 25.8 | – | 2.2 | 3.0 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 100.0 | 99.4 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | CPU ms/picture | frames/s | visibility events | errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 15 / 16 | -6 / -3 | 1000x700 | 52 | – |  |  |
| shown | true | capturePage | 6/6 | 6 | 15 / 16 | -7 / -5 | 1000x700 | 52 | – |  |  |
| shown | true | cdpJpeg | 6/6 | 6 | 65 / 66 | -47 / -38 | 1000x700 | 80 | – |  |  |
| shown | true | frameSub | 6/6 | 6 | 15 / 22 | -5 / -4 | 1000x700 | 48 | – |  |  |
| shown | true | cdpPng | 6/6 | 6 | 157 / 164 | -44 / -35 | 1000x700 | 212 | – |  |  |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | 70 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | 45 | – |  | frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | 3 | – |  | Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 4047 / 4049 | -2996 / -43 | 1280x800 | 123 | – |  |  |
| hiddenWindow | false | frameSub | 6/6 | 6 | 7 / 7 | 65 / 73 | 1280x800 | 42 | – |  |  |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.5 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | 3 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 98 / 99 | -63 / -27 | 1280x800 | 140 | – |  |  |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 15 / 16 | 7 / 9 | 1280x800 | 73 | – |  |  |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 6/6 | 6 | 15 / 18 | 8 / 11 | 1280x800 | 65 | – |  |  |
| invisibleWindow | false | capturePage | 6/6 | 6 | 14 / 18 | 8 / 12 | 1280x800 | 63 | – |  |  |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 82 / 84 | -46 / -39 | 1280x800 | 118 | – |  |  |
| invisibleWindow | false | frameSub | 6/6 | 6 | 15 / 19 | 11 / 12 | 1280x800 | 67 | – |  |  |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 14 / 18 | 8 / 11 | 1280x800 | 52 | – |  |  |
| tinyWindow | false | capturePage | 6/6 | 6 | 14 / 16 | 9 / 11 | 1280x800 | 60 | – |  |  |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 81 / 86 | -46 / -40 | 1280x800 | 102 | – |  |  |
| tinyWindow | false | frameSub | 6/6 | 6 | 15 / 19 | 10 / 11 | 1280x800 | 60 | – |  |  |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 15 / 16 | 9 / 9 | 1280x800 | 62 | – |  |  |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 14 / 16 | 8 / 10 | 1280x800 | 58 | – |  |  |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 80 / 83 | -45 / -39 | 1280x800 | 97 | – |  |  |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 15 / 19 | 10 / 11 | 1280x800 | 57 | – |  |  |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePageHidden | 6/6 | 6 | 15 / 16 | 8 / 10 | 1280x800 | 55 | – |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePage | 6/6 | 6 | 14 / 18 | 9 / 10 | 1280x800 | 60 | – |  |  |
| tinyWindow, fit 1280x800 at 1x | false | cdpJpeg | 6/6 | 6 | 82 / 84 | -46 / -37 | 1280x800 | 100 | – |  |  |
| tinyWindow, fit 1280x800 at 1x | false | frameSub | 6/6 | 6 | 15 / 19 | 11 / 12 | 1280x800 | 58 | – |  |  |
| tinyWindow, fit 1280x800 at 1x | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 60 / 67 | 1280x800 | 35 | – |  |  |
| osr | false | capturePage | 6/6 | 6 | 32 / 33 | 8 / 17 | 1280x800 | 55 | – |  |  |
| osr | false | cdpJpeg | 6/6 | 6 | 132 / 142 | -80 / -79 | 1280x800 | 97 | – |  |  |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | 135 | – |  | no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | 3 | – |  | empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | 115 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 239 | pss | 499 | 4 | 0.0 |
| 1 | 268 | pss | 615 | 5 | 0.3 |
| 2 | 284 | pss | 734 | 6 | 0.3 |
| 4 | 316 | pss | 972 | 8 | 0.5 |
| 8 | 370 | pss | 1408 | 12 | 1.0 |

Per idle hidden tab: **16 MiB**, 0.12% CPU. Four tabs: one partition +67 MiB, four partitions +72 MiB.

Quiet tabs (no rAF loop) working in one shared 1×1 host: **28 MiB** and 0.78% CPU a tab (0: 264 MiB / 0.0%, 1: 306 MiB / 1.0%, 4: 388 MiB / 2.8%, 8: 492 MiB / 6.3%).

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 33.7 | 27.2 | 6.5 | 60 |
| animated, never-shown window, throttling off | 0.8 | 0.8 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.0 | 0.0 | 0.0 | 0 |
| animated, never-shown window, throttling off + frame pump | 0.8 | 0.8 | 0.0 | 0 |
| animated, invisible shown window | 44.7 | 36.0 | 8.5 | 60 |
| animated, 1x1 shown window | 37.2 | 35.7 | 1.3 | 60 |
| animated, osr 30 fps | 30.7 | 19.3 | 5.0 | 30 |

**Waking a resting tab into the host** (never-shown window, throttling on, 4 cycles): first rAF 1 / 2 ms, fresh picture 14 / 38 ms; resting rates 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0; awake rAF 60, 60, 60, 60

**One host, 4 tabs:** tab 1 rAF 60 Hz, capturePage 4/4 in 12 / 14 ms (1280x800); tab 2 rAF 60 Hz, capturePage 4/4 in 15 / 17 ms (1280x800); tab 3 rAF 60 Hz, capturePage 4/4 in 14 / 15 ms (1280x800); tab 4 rAF 60 Hz, capturePage 4/4 in 14 / 17 ms (1280x800)

**The host's invariants:** host 0,0 1x1, focused at start false, after its page grabs focus false (focused window "S7 browser view"); Windows styles –; click-through not testable here (macOS needs Accessibility for synthetic clicks; Wayland and no display have no global input)

**Assertions:** PASS no reload when moving from detached; PASS no reload when moving from hiddenWindow; PASS no reload when moving from hiddenWindowFit; PASS no reload when moving from invisibleWindow; PASS no reload when moving from tinyWindow; PASS the 1x1 host draws (rAF above 10 Hz); PASS a never-shown window draws nothing (rAF below 1 Hz); PASS capturePage works in the 1x1 host; PASS the host never takes focus, even when its page asks; PASS a resting tab draws within 2 s of moving into the host, every cycle; PASS every tab in one shared host draws and is pictured

### Electron · linux-wayland (electron-linux-wayland.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone wayland, displays 1920x1080@1, status **done**, 838 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.91 | 27.7 | 33 / 179 | 1 / 163 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.93 | 27.5 | 30 / 36 | 1 / 3 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.93 | 27.5 | 28 / 28 | 0 / 3 | 1280x800@1 → 1000x700@1 → 1280x800 | 1 / 2 | 0.0 |  |
| tinyWindow | true | true | true | true (1) | 0.96 | 28.6 | 24 / 28 | 6 / 13 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 40.9 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | IO / RO Hz | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 100.1 | 99.1 | 39.8 | 27 | 2.0 / 2.0 | – | – | – | 4.0 | 7.2 |  |
| detached, throttling on (default) | hidden | 1280x800 | 2.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.4 |  |
| detached, throttling off | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.6 | 1.0 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.2 |  |
| never-shown window, throttling off | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.6 | 0.8 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 100.2 | 99.4 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.8 | 0.8 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 100.2 | 99.4 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 0.6 | 0.6 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 100.2 | 99.4 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 0.6 | 0.6 |  |
| invisible shown window, throttling off | – | – | – | – | – | – | – | – | – | – | – | – | not possible here |
| 1x1 shown window, throttling off | visible | 1280x800 | 100.2 | 99.2 | 39.8 | 26 | 2.0 / 2.0 | – | – | – | 3.8 | 6.6 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 100.2 | 99.2 | 40.0 | 26 | 2.2 / 2.2 | – | – | – | 3.8 | 6.2 | cover -10,-10 1940x1100 over host 0,0 1x1 |
| 1x1 shown window kept above a cover window (always on top) | visible | 1280x800 | 99.9 | 99.1 | 39.8 | 26 | 2.0 / 2.0 | – | – | – | 3.8 | 6.4 | cover -10,-10 1940x1100 over host 0,0 1x1 |
| invisible shown window, covered by another window | – | – | – | – | – | – | – | – | – | – | – | – | not possible here |
| 1x1 shown window, throttling on (control) | visible | 1280x800 | 100.0 | 99.4 | 39.8 | 26 | 2.0 / 2.0 | – | – | – | 3.8 | 6.2 |  |
| 1x1 shown window, throttling on, covered by another window (control) | visible | 1280x800 | 100.1 | 99.1 | 40.0 | 26 | 2.2 / 2.2 | – | – | – | 3.8 | 6.4 | cover -10,-10 1940x1100 over host 0,0 1x1 |
| invisible shown window, throttling on, covered by another window (control) | – | – | – | – | – | – | – | – | – | – | – | – | not possible here |
| osr window 30 fps, throttling off | visible | 1280x800 | 100.0 | 99.2 | 30.0 | 34 | 2.0 / 2.0 | – | – | – | 3.2 | 13.8 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 100.2 | 99.4 | 30.0 | 34 | 0.0 / 2.0 | – | – | – | 1.6 | 2.0 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 100.0 | 99.4 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 25.8 | – | 2.0 | 2.8 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 100.0 | 99.4 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 25.8 | – | 2.0 | 2.4 |  |
| detached, throttling off, playing media | visible | 1280x800 | 100.2 | 99.4 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 25.8 | – | 2.0 | 3.0 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 100.2 | 99.4 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | CPU ms/picture | frames/s | visibility events | errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 27 / 28 | 31 / 49 | 1000x700 | 43 | – |  |  |
| shown | true | capturePage | 6/6 | 6 | 27 / 28 | 31 / 32 | 1000x700 | 42 | – |  |  |
| shown | true | cdpJpeg | 6/6 | 6 | 131 / 142 | -61 / -61 | 1000x700 | 75 | – |  |  |
| shown | true | frameSub | 6/6 | 6 | 28 / 29 | 34 / 42 | 1000x700 | 38 | – |  |  |
| shown | true | cdpPng | 6/6 | 6 | 260 / 289 | -68 / -65 | 1000x700 | 210 | – |  |  |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 29.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | 55 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | 35 | – |  | frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 0/2 | 0 | – | – | - | 65 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| hiddenWindow | false | frameSub | 0/2 | 0 | – | – | - | 40 | – |  | frame subscription: timed out after 5000 ms |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 0/2 | 0 | – | – | - | 60 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| hiddenWindow + pump | false | frameSub | 0/2 | 0 | – | – | - | 35 | – |  | frame subscription: timed out after 5000 ms |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| invisibleWindow | false | - | 0/0 | 0 | – | – | - | – | – |  | not possible here |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 22 / 23 | 37 / 49 | 1280x800 | 48 | – |  |  |
| tinyWindow | false | capturePage | 6/6 | 6 | 22 / 23 | 37 / 38 | 1280x800 | 37 | – |  |  |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 147 / 148 | -73 / -61 | 1280x800 | 77 | – |  |  |
| tinyWindow | false | frameSub | 6/6 | 6 | 23 / 33 | 40 / 40 | 1280x800 | 37 | – |  |  |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.5 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 23 / 29 | 37 / 37 | 1280x800 | 43 | – |  |  |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 22 / 24 | 37 / 39 | 1280x800 | 37 | – |  |  |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 136 / 148 | -72 / -50 | 1280x800 | 72 | – |  |  |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 23 / 35 | 40 / 41 | 1280x800 | 42 | – |  |  |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.5 |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePageHidden | 6/6 | 6 | 22 / 23 | 38 / 38 | 1280x800 | 42 | – |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePage | 6/6 | 6 | 22 / 25 | 37 / 39 | 1280x800 | 42 | – |  |  |
| tinyWindow, fit 1280x800 at 1x | false | cdpJpeg | 6/6 | 6 | 147 / 153 | -75 / -61 | 1280x800 | 73 | – |  |  |
| tinyWindow, fit 1280x800 at 1x | false | frameSub | 6/6 | 6 | 23 / 34 | 40 / 41 | 1280x800 | 37 | – |  |  |
| tinyWindow, fit 1280x800 at 1x | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.5 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 29 / 36 | 1280x800 | 32 | – |  |  |
| osr | false | capturePage | 6/6 | 6 | 31 / 34 | -20 / -19 | 1280x800 | 50 | – |  |  |
| osr | false | cdpJpeg | 6/6 | 6 | 98 / 111 | -72 / -70 | 1280x800 | 80 | – |  |  |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | 130 | – |  | no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | 105 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 331 | pss | 602 | 4 | 0.3 |
| 1 | 359 | pss | 707 | 5 | 0.3 |
| 2 | 375 | pss | 815 | 6 | 0.5 |
| 4 | 404 | pss | 1030 | 8 | 1.0 |
| 8 | 458 | pss | 1461 | 12 | 0.3 |

Per idle hidden tab: **16 MiB**, 0.00% CPU. Four tabs: one partition +65 MiB, four partitions +71 MiB.

Quiet tabs (no rAF loop) working in one shared 1×1 host: **28 MiB** and 1.16% CPU a tab (0: 356 MiB / 0.5%, 1: 396 MiB / 1.8%, 4: 476 MiB / 4.5%, 8: 580 MiB / 9.8%).

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 20.2 | 11.5 | 7.5 | 38 |
| animated, never-shown window, throttling off | 0.5 | 0.5 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.3 | 0.0 | 0.0 | 0 |
| animated, never-shown window, throttling off + frame pump | 0.5 | 0.5 | 0.0 | 0 |
| animated, 1x1 shown window | 15.5 | 12.5 | 2.0 | 40 |
| animated, osr 30 fps | 27.0 | 10.8 | 6.8 | 30 |

**Waking a resting tab into the host** (never-shown window, throttling on, 4 cycles): first rAF 1 / 2 ms, fresh picture 16 / 35 ms; resting rates 2.0 Hz / rAF 0.0, 2.0 Hz / rAF 0.0, 2.0 Hz / rAF 0.0, 2.0 Hz / rAF 0.0; awake rAF 41, 41, 41, 40

**One host, 4 tabs:** tab 1 rAF 40 Hz, capturePage 4/4 in 22 / 23 ms (1280x800); tab 2 rAF 40 Hz, capturePage 4/4 in 22 / 24 ms (1280x800); tab 3 rAF 40 Hz, capturePage 4/4 in 23 / 25 ms (1280x800); tab 4 rAF 40 Hz, capturePage 4/4 in 21 / 24 ms (1280x800)

**The host's invariants:** host 0,0 1x1, focused at start false, after its page grabs focus false (focused window "(none)"); Windows styles –; click-through not testable here (macOS needs Accessibility for synthetic clicks; Wayland and no display have no global input)

**Assertions:** PASS no reload when moving from detached; PASS no reload when moving from hiddenWindow; PASS no reload when moving from hiddenWindowFit; PASS no reload when moving from tinyWindow; PASS the 1x1 host draws (rAF above 10 Hz); PASS a never-shown window draws nothing (rAF below 1 Hz); PASS capturePage works in the 1x1 host; PASS the host never takes focus, even when its page asks; PASS a resting tab draws within 2 s of moving into the host, every cycle; PASS every tab in one shared host draws and is pictured

**Q6 streamed view** (10 s at the viewer; latency p50 / p95 ms)

| road | content | source | fps | decoded fps | latency | gap p95 | kbit/s | bytes/frame | sender CPU % | viewer CPU % | source rAF | notes |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| screencast | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 |  |
| capturePoll | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | getDisplayMedia: AbortError: Timeout starting video source |
| webrtc-h264 | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | getDisplayMedia: AbortError: Timeout starting video source |
| webcodecs-vp8 | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | getDisplayMedia: AbortError: Timeout starting video source |
| webcodecs-h264 | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | getDisplayMedia: AbortError: Timeout starting video source |
| screencast | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | 0 |  |
| capturePoll | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | getDisplayMedia: AbortError: Timeout starting video source |
| webrtc-h264 | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | getDisplayMedia: AbortError: Timeout starting video source |
| webcodecs-vp8 | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | getDisplayMedia: AbortError: Timeout starting video source |
| webcodecs-h264 | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | getDisplayMedia: AbortError: Timeout starting video source |
| screencast | anim | invisibleWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | not possible here |
| capturePoll | anim | invisibleWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | not possible here |
| webcodecs-h264 | anim | invisibleWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | not possible here |
| screencast | anim | tinyWindow | 39.9 | 39.9 | 73 / 74 | 27 | 43960 | 137718 | 98 | 25 | 40 |  |
| webcodecs-h264 | anim | tinyWindow | 30.1 | 30.1 | 67 / 69 | 53 | 2378 | 9874 | 78 | 15 | 40 |  |
| screencast | anim | shown | 38.3 | 38.3 | 71 / 72 | 28 | 35106 | 114575 | 77 | 19 | 38 |  |
| webrtc-vp8 | anim | shown | 20.4 | 20.4 | 87 / 94 | 80 | 2496 | 15296 | 92 | 16 | 38 | libvpx; video/VP8 |
| webcodecs-h264 | anim | shown | 30.0 | 30.0 | 76 / 79 | 55 | 2400 | 10035 | 97 | 15 | 38 |  |

### Electron · linux-x11-dsf2 (electron-linux-x11-dsf2.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone x11, displays 960x540@2, status **done**, 281 s

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | CPU ms/picture | frames/s | visibility events | errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 28 / 37 | 14 / 15 | 2000x1400 | 120 | – |  |  |
| shown | true | capturePage | 6/6 | 6 | 28 / 30 | 15 / 16 | 2000x1400 | 113 | – |  |  |
| shown | true | cdpJpeg | 6/6 | 6 | 108 / 122 | -44 / -35 | 2000x1400 | 188 | – |  |  |
| shown | true | frameSub | 6/6 | 6 | 44 / 47 | 6 / 11 | 2000x1400 | 130 | – |  |  |
| shown | true | cdpPng | 6/6 | 6 | 269 / 295 | -44 / -38 | 2000x1400 | 447 | – |  |  |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 29.5 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | 35 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | 35 | – |  | frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 4043 / 4044 | -2945 / -39 | 2560x1600 | 140 | – |  |  |
| hiddenWindow | false | frameSub | 6/6 | 6 | 36 / 64 | 59 / 123 | 2560x1600 | 98 | – |  |  |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 136 / 169 | -50 / -36 | 2560x1600 | 350 | – |  |  |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 60 / 62 | 7 / 15 | 2560x1600 | 203 | – |  |  |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| invisibleWindow | false | capturePage | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 130 / 146 | -46 / -32 | 2560x1600 | 237 | – |  |  |
| invisibleWindow | false | frameSub | 6/6 | 6 | 61 / 65 | 3 / 5 | 2560x1600 | 163 | – |  |  |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 29.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 43 / 54 | 8 / 13 | 2560x1600 | 78 | – |  |  |
| tinyWindow | false | capturePage | 6/6 | 6 | 42 / 45 | 9 / 28 | 2560x1600 | 75 | – |  |  |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 127 / 135 | -39 / -36 | 2560x1600 | 123 | – |  |  |
| tinyWindow | false | frameSub | 6/6 | 6 | 61 / 65 | 2 / 4 | 2560x1600 | 117 | – |  |  |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 29.5 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 43 / 53 | 9 / 12 | 2560x1600 | 78 | – |  |  |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 42 / 46 | 10 / 16 | 2560x1600 | 77 | – |  |  |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 143 / 148 | -40 / -38 | 2560x1600 | 133 | – |  |  |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 60 / 60 | 20 / 27 | 2560x1600 | 112 | – |  |  |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 29.5 |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePageHidden | 6/6 | 6 | 42 / 44 | 10 / 13 | 2560x1600 | 77 | – |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePage | 6/6 | 6 | 42 / 50 | 10 / 11 | 2560x1600 | 78 | – |  |  |
| tinyWindow, fit 1280x800 at 1x | false | cdpJpeg | 6/6 | 6 | 64 / 71 | -46 / -39 | 1280x800 | 53 | – |  |  |
| tinyWindow, fit 1280x800 at 1x | false | frameSub | 6/6 | 6 | 60 / 61 | -13 / -9 | 2560x1600 | 108 | – |  |  |
| tinyWindow, fit 1280x800 at 1x | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 29.5 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 10 / 12 | 960x540 | 12 | – |  |  |
| osr | false | capturePage | 6/6 | 6 | 32 / 33 | -27 / -17 | 960x540 | 20 | – |  |  |
| osr | false | cdpJpeg | 6/6 | 6 | 99 / 104 | -89 / -87 | 960x540 | 28 | – |  |  |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | 92 | – |  | no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | 3 | – |  | empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | 70 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 288 | pss | 481 | 3 | 0.3 |
| 1 | 317 | pss | 588 | 4 | 0.0 |
| 2 | 335 | pss | 699 | 5 | 0.0 |
| 4 | 364 | pss | 916 | 7 | 0.0 |
| 8 | 420 | pss | 1354 | 11 | 0.3 |

Per idle hidden tab: **17 MiB**, 0.00% CPU. Four tabs: one partition +69 MiB, four partitions +75 MiB.

Quiet tabs (no rAF loop) working in one shared 1×1 host: **60 MiB** and 1.28% CPU a tab (0: 313 MiB / 0.0%, 1: 387 MiB / 1.5%, 4: 562 MiB / 5.3%, 8: 793 MiB / 10.2%).

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 48.3 | 8.5 | 39.5 | 60 |
| animated, never-shown window, throttling off | 0.8 | 0.8 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.0 | 0.0 | 0.0 | 0 |
| animated, never-shown window, throttling off + frame pump | 0.8 | 0.8 | 0.0 | 0 |
| animated, invisible shown window | 0.5 | 0.5 | 0.0 | 0 |
| animated, 1x1 shown window | 9.3 | 8.3 | 1.0 | 60 |
| animated, osr 30 fps | 9.8 | 4.0 | 1.5 | 30 |

**One host, 4 tabs:** tab 1 rAF 60 Hz, capturePage 4/4 in 49 / 71 ms (2560x1600); tab 2 rAF 59 Hz, capturePage 4/4 in 44 / 49 ms (2560x1600); tab 3 rAF 58 Hz, capturePage 4/4 in 42 / 45 ms (2560x1600); tab 4 rAF 58 Hz, capturePage 4/4 in 42 / 46 ms (2560x1600)

**Assertions:** PASS capturePage works in the 1x1 host; PASS every tab in one shared host draws and is pictured

### Electron · linux-x11 (electron-linux-x11.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone x11, displays 1920x1080@1, status **done**, 861 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.93 | 27.9 | 28 / 30 | 0 / 12 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.95 | 28.4 | 12 / 23 | 4 / 8 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.4 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.95 | 28.4 | 15 / 25 | 6 / 18 | 1280x800@1 → 1000x700@1 → 1280x800 | 0 / 1 | 2.4 |  |
| invisibleWindow | true | true | true | true (1) | 0.95 | 28.4 | 13 / 20 | 4 / 7 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.0 |  |
| tinyWindow | true | true | true | true (1) | 0.97 | 28.6 | 12 / 19 | 5 / 11 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.0 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | IO / RO Hz | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 99.9 | 99.1 | 60.2 | 18 | 2.2 / 2.2 | – | – | – | 2.4 | 3.6 |  |
| detached, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.0 |  |
| detached, throttling off | visible | 1280x800 | 100.0 | 99.4 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.4 | 0.4 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.0 |  |
| never-shown window, throttling off | visible | 1280x800 | 99.9 | 99.3 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.6 | 0.6 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 99.9 | 99.3 | 1.0 | 1017 | 0.0 / 0.0 | – | – | – | 0.8 | 1.0 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 100.0 | 99.4 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 0.4 | 0.4 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 100.0 | 99.4 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 0.6 | 0.6 |  |
| invisible shown window, throttling off | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.6 | 0.6 |  |
| 1x1 shown window, throttling off | visible | 1280x800 | 100.0 | 99.4 | 60.0 | 18 | 2.0 / 2.0 | – | – | – | 2.4 | 3.2 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 100.0 | 99.4 | 60.0 | 18 | 2.0 / 2.0 | – | – | – | 2.0 | 2.8 | cover 0,0 1919x1079 over host 0,0 1x1 |
| 1x1 shown window kept above a cover window (always on top) | visible | 1280x800 | 99.9 | 99.1 | 60.0 | 18 | 2.0 / 2.0 | – | – | – | 2.2 | 3.2 | cover 0,0 1919x1079 over host 0,0 1x1 |
| invisible shown window, covered by another window | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.6 | 0.8 | cover -1480,-1000 1919x1079 over host -1480,-1000 1280x800 |
| 1x1 shown window, throttling on (control) | visible | 1280x800 | 99.9 | 99.1 | 60.2 | 18 | 2.2 / 2.2 | – | – | – | 2.4 | 3.4 |  |
| 1x1 shown window, throttling on, covered by another window (control) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.2 | cover 0,0 1919x1079 over host 0,0 1x1 |
| invisible shown window, throttling on, covered by another window (control) | hidden | 1280x800 | 2.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.0 | cover -1480,-1000 1919x1079 over host -1480,-1000 1280x800 |
| osr window 30 fps, throttling off | visible | 1280x800 | 100.0 | 99.4 | 30.0 | 35 | 2.0 / 2.0 | – | – | – | 1.8 | 9.0 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 100.1 | 99.1 | 30.2 | 35 | 0.0 / 2.2 | – | – | – | 0.8 | 1.0 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 100.0 | 99.4 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 25.8 | – | 1.0 | 1.4 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 100.0 | 99.4 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 25.8 | – | 1.0 | 1.2 |  |
| detached, throttling off, playing media | visible | 1280x800 | 99.9 | 99.3 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 25.8 | – | 1.2 | 1.8 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 99.9 | 99.3 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | CPU ms/picture | frames/s | visibility events | errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 15 / 16 | -10 / -5 | 1000x700 | 23 | – |  |  |
| shown | true | capturePage | 6/6 | 6 | 15 / 16 | -10 / -8 | 1000x700 | 23 | – |  |  |
| shown | true | cdpJpeg | 6/6 | 6 | 48 / 55 | -36 / -34 | 1000x700 | 38 | – |  |  |
| shown | true | frameSub | 6/6 | 6 | 16 / 17 | -8 / -1 | 1000x700 | 20 | – |  |  |
| shown | true | cdpPng | 6/6 | 6 | 146 / 154 | -41 / -38 | 1000x700 | 142 | – |  |  |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | 40 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | 30 | – |  | frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 4046 / 4049 | -2998 / -37 | 1280x800 | 72 | – |  |  |
| hiddenWindow | false | frameSub | 6/6 | 6 | 6 / 6 | 60 / 69 | 1280x800 | 17 | – |  |  |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.5 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 79 / 82 | -49 / -31 | 1280x800 | 72 | – |  |  |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 15 / 20 | 8 / 9 | 1280x800 | 45 | – |  |  |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| invisibleWindow | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 80 / 84 | -48 / -19 | 1280x800 | 53 | – |  |  |
| invisibleWindow | false | frameSub | 6/6 | 6 | 15 / 21 | 11 / 15 | 1280x800 | 33 | – |  |  |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 14 / 16 | -7 / -5 | 1280x800 | 23 | – |  |  |
| tinyWindow | false | capturePage | 6/6 | 6 | 14 / 16 | -7 / -5 | 1280x800 | 23 | – |  |  |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 64 / 68 | -48 / -39 | 1280x800 | 45 | – |  |  |
| tinyWindow | false | frameSub | 6/6 | 6 | 16 / 21 | -6 / -5 | 1280x800 | 25 | – |  |  |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 14 / 16 | 8 / 14 | 1280x800 | 23 | – |  |  |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 15 / 16 | 8 / 11 | 1280x800 | 27 | – |  |  |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 79 / 85 | -47 / -39 | 1280x800 | 43 | – |  |  |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 15 / 22 | 10 / 11 | 1280x800 | 28 | – |  |  |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePageHidden | 6/6 | 6 | 14 / 16 | 9 / 12 | 1280x800 | 25 | – |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePage | 6/6 | 6 | 14 / 16 | 8 / 11 | 1280x800 | 27 | – |  |  |
| tinyWindow, fit 1280x800 at 1x | false | cdpJpeg | 6/6 | 6 | 80 / 86 | -48 / -40 | 1280x800 | 45 | – |  |  |
| tinyWindow, fit 1280x800 at 1x | false | frameSub | 6/6 | 6 | 15 / 22 | 11 / 12 | 1280x800 | 27 | – |  |  |
| tinyWindow, fit 1280x800 at 1x | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 7 / 34 | 1280x800 | 17 | – |  |  |
| osr | false | capturePage | 6/6 | 6 | 32 / 32 | -24 / -18 | 1280x800 | 30 | – |  |  |
| osr | false | cdpJpeg | 6/6 | 6 | 98 / 107 | -80 / -78 | 1280x800 | 52 | – |  |  |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | 82 | – |  | no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | 0 | – |  | empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | 60 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 325 | pss | 584 | 4 | 0.0 |
| 1 | 355 | pss | 691 | 5 | 0.0 |
| 2 | 370 | pss | 798 | 6 | 0.3 |
| 4 | 399 | pss | 1015 | 8 | 0.3 |
| 8 | 454 | pss | 1448 | 12 | 1.0 |

Per idle hidden tab: **16 MiB**, 0.12% CPU. Four tabs: one partition +66 MiB, four partitions +71 MiB.

Quiet tabs (no rAF loop) working in one shared 1×1 host: **28 MiB** and 0.66% CPU a tab (0: 350 MiB / 0.0%, 1: 392 MiB / 0.8%, 4: 471 MiB / 3.0%, 8: 576 MiB / 5.3%).

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 14.5 | 10.0 | 4.5 | 60 |
| animated, never-shown window, throttling off | 1.3 | 1.0 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.3 | 0.0 | 0.0 | 0 |
| animated, never-shown window, throttling off + frame pump | 1.3 | 1.0 | 0.3 | 0 |
| animated, invisible shown window | 0.8 | 0.5 | 0.0 | 0 |
| animated, 1x1 shown window | 8.8 | 7.8 | 1.0 | 60 |
| animated, osr 30 fps | 13.3 | 4.8 | 2.3 | 30 |

**Waking a resting tab into the host** (never-shown window, throttling on, 4 cycles): first rAF 0 / 2 ms, fresh picture 13 / 29 ms; resting rates 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0; awake rAF 60, 60, 60, 60

**One host, 4 tabs:** tab 1 rAF 60 Hz, capturePage 4/4 in 14 / 21 ms (1280x800); tab 2 rAF 60 Hz, capturePage 4/4 in 14 / 17 ms (1280x800); tab 3 rAF 60 Hz, capturePage 4/4 in 14 / 16 ms (1280x800); tab 4 rAF 60 Hz, capturePage 4/4 in 14 / 16 ms (1280x800)

**The host's invariants:** host 0,0 1x1, focused at start false, after its page grabs focus false (focused window "S7 probe"); Windows styles –; click-through {"at":"0,0","tool":"xdotool","belowClicks":0,"hostClicks":1}

**Assertions:** PASS no reload when moving from detached; PASS no reload when moving from hiddenWindow; PASS no reload when moving from hiddenWindowFit; PASS no reload when moving from invisibleWindow; PASS no reload when moving from tinyWindow; PASS the 1x1 host draws (rAF above 10 Hz); PASS a never-shown window draws nothing (rAF below 1 Hz); PASS capturePage works in the 1x1 host; PASS the host never takes focus, even when its page asks; **FAIL** a real click at the host's point reaches the window below; PASS a resting tab draws within 2 s of moving into the host, every cycle; PASS every tab in one shared host draws and is pictured

**Q6 streamed view** (10 s at the viewer; latency p50 / p95 ms)

| road | content | source | fps | decoded fps | latency | gap p95 | kbit/s | bytes/frame | sender CPU % | viewer CPU % | source rAF | notes |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| screencast | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 |  |
| capturePoll | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | anim | hiddenWindow | 20.6 | 20.6 | 37 / 45 | 78 | 2495 | 15137 | 40 | 12 | 60 | libvpx; video/VP8 |
| webrtc-h264 | anim | hiddenWindow | 12.5 | 12.5 | 75 / 89 | 111 | 2499 | 24990 | 38 | 7 | 60 | OpenH264; video/H264 |
| webcodecs-vp8 | anim | hiddenWindow | 30.0 | 30.0 | 28 / 30 | 35 | 2411 | 10046 | 57 | 15 | 60 |  |
| webcodecs-h264 | anim | hiddenWindow | 30.0 | 30.0 | 27 / 29 | 35 | 2404 | 10018 | 46 | 13 | 60 |  |
| screencast | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | 0 |  |
| capturePoll | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | static | hiddenWindow | 2.0 | 2.0 | 75 / 94 | 516 | 825 | 51592 | 5 | 2 | 60 | libvpx; video/VP8 |
| webrtc-h264 | static | hiddenWindow | 1.0 | 1.0 | 16 / 17 | 1001 | 17 | 2166 | 4 | 1 | 60 | OpenH264; video/H264 |
| webcodecs-vp8 | static | hiddenWindow | 2.7 | 2.7 | 13 / 99 | 501 | 179 | 8268 | 6 | 1 | 60 |  |
| webcodecs-h264 | static | hiddenWindow | 2.0 | 2.0 | 14 / 15 | 501 | 76 | 4748 | 4 | 1 | 60 |  |
| screencast | anim | invisibleWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 |  |
| capturePoll | anim | invisibleWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 | toJPEG 0.0 ms |
| webcodecs-h264 | anim | invisibleWindow | 30.0 | 30.0 | 30 / 32 | 35 | 2398 | 9990 | 70 | 14 | 60 |  |
| screencast | anim | tinyWindow | 59.8 | 59.8 | 33 / 36 | 18 | 66006 | 137743 | 111 | 29 | 60 |  |
| webcodecs-h264 | anim | tinyWindow | 30.0 | 30.0 | 30 / 32 | 36 | 2409 | 10038 | 66 | 14 | 60 |  |
| screencast | anim | shown | 60.1 | 60.1 | 14 / 15 | 18 | 55086 | 114572 | 80 | 22 | 60 |  |
| webrtc-vp8 | anim | shown | 20.2 | 20.2 | 43 / 50 | 78 | 2503 | 15488 | 62 | 12 | 60 | libvpx; video/VP8 |
| webcodecs-h264 | anim | shown | 30.0 | 30.0 | 17 / 19 | 35 | 2449 | 10204 | 70 | 14 | 60 |  |

### Electron · linux-x64-ozone-headless (electron-linux-x64-ozone-headless.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone headless, displays 1920x1080@1, status **done**, 573 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.90 | 27.5 | 27 / 78 | 0 / 6 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.95 | 28.4 | 29 / 30 | 12 / 18 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.4 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.95 | 28.4 | 27 / 34 | 13 / 15 | 1280x800@1 → 1000x700@1 → 1280x800 | 1 / 2 | 2.0 |  |
| invisibleWindow | true | true | true | true (1) | 0.96 | 28.6 | 23 / 28 | 11 / 16 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.2 |  |
| tinyWindow | true | true | true | true (1) | 0.97 | 28.7 | 16 / 26 | 2 / 11 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.1 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | IO / RO Hz | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 100.0 | 99.4 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 4.2 | 6.0 |  |
| detached, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.2 | 0.4 |  |
| detached, throttling off | visible | 1280x800 | 100.2 | 99.2 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.8 | 0.8 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 2.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.2 | 0.2 |  |
| never-shown window, throttling off | visible | 1280x800 | 100.0 | 99.4 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.4 | 0.8 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 99.9 | 99.3 | 1.0 | 1017 | 0.0 / 0.0 | – | – | – | 1.0 | 1.2 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 0.6 | 0.6 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 100.2 | 99.4 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 0.6 | 0.6 |  |
| invisible shown window, throttling off | visible | 1280x800 | 100.0 | 99.2 | 60.0 | 17 | 2.2 / 2.2 | – | – | – | 4.4 | 6.6 |  |
| 1x1 shown window, throttling off | visible | 1280x800 | 100.0 | 99.4 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 4.4 | 5.4 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 100.2 | 99.2 | 60.2 | 17 | 2.2 / 2.2 | – | – | – | 4.2 | 5.2 | cover 0,0 1920x1080 over host 0,0 1x1 |
| 1x1 shown window kept above a cover window (always on top) | visible | 1280x800 | 99.9 | 99.3 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 4.2 | 5.6 | cover 0,0 1920x1080 over host 0,0 1x1 |
| invisible shown window, covered by another window | visible | 1280x800 | 100.2 | 99.2 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 4.2 | 6.2 | cover -1480,-1000 1920x1080 over host -1480,-1000 1280x800 |
| 1x1 shown window, throttling on (control) | visible | 1280x800 | 100.1 | 99.1 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 3.8 | 4.8 |  |
| 1x1 shown window, throttling on, covered by another window (control) | visible | 1280x800 | 100.0 | 99.2 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 4.4 | 5.6 | cover 0,0 1920x1080 over host 0,0 1x1 |
| invisible shown window, throttling on, covered by another window (control) | visible | 1280x800 | 99.9 | 99.1 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 4.4 | 6.4 | cover -1480,-1000 1920x1080 over host -1480,-1000 1280x800 |
| osr window 30 fps, throttling off | visible | 1280x800 | 100.0 | 99.2 | 30.0 | 34 | 2.0 / 2.0 | – | – | – | 3.8 | 14.6 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 100.2 | 99.2 | 30.0 | 34 | 0.0 / 2.0 | – | – | – | 1.8 | 2.2 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 100.0 | 99.4 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 25.8 | – | 2.0 | 3.0 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 26.0 | – | 2.2 | 3.0 |  |
| detached, throttling off, playing media | visible | 1280x800 | 100.1 | 99.3 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 25.8 | – | 2.2 | 3.0 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 99.9 | 99.3 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 2.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | CPU ms/picture | frames/s | visibility events | errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 14 / 16 | -6 / -2 | 1000x700 | 45 | – |  |  |
| shown | true | capturePage | 6/6 | 6 | 14 / 16 | -6 / -4 | 1000x700 | 42 | – |  |  |
| shown | true | cdpJpeg | 6/6 | 6 | 64 / 67 | -44 / -38 | 1000x700 | 67 | – |  |  |
| shown | true | frameSub | 6/6 | 6 | 15 / 22 | -3 / -2 | 1000x700 | 43 | – |  |  |
| shown | true | cdpPng | 6/6 | 6 | 210 / 224 | -41 / -35 | 1000x700 | 258 | – |  |  |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | 55 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | 50 | – |  | frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | 3 | – |  | Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 4046 / 4048 | -2990 / -41 | 1280x800 | 105 | – |  |  |
| hiddenWindow | false | frameSub | 6/6 | 6 | 10 / 10 | 64 / 78 | 1280x800 | 37 | – |  |  |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.5 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 98 / 100 | -55 / -34 | 1280x800 | 130 | – |  |  |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 14 / 14 | 12 / 14 | 1280x800 | 65 | – |  |  |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 6/6 | 6 | 13 / 16 | 12 / 14 | 1280x800 | 58 | – |  |  |
| invisibleWindow | false | capturePage | 6/6 | 6 | 13 / 16 | 12 / 15 | 1280x800 | 57 | – |  |  |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 79 / 87 | -39 / -35 | 1280x800 | 97 | – |  |  |
| invisibleWindow | false | frameSub | 6/6 | 6 | 30 / 32 | 1 / 15 | 1280x800 | 58 | – |  |  |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 14 / 21 | 13 / 14 | 1280x800 | 42 | – |  |  |
| tinyWindow | false | capturePage | 6/6 | 6 | 13 / 16 | 13 / 14 | 1280x800 | 45 | – |  |  |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 78 / 85 | -39 / -35 | 1280x800 | 73 | – |  |  |
| tinyWindow | false | frameSub | 6/6 | 6 | 14 / 19 | 16 / 17 | 1280x800 | 43 | – |  |  |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 14 / 25 | -3 / 0 | 1280x800 | 42 | – |  |  |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 13 / 16 | -2 / 0 | 1280x800 | 40 | – |  |  |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 65 / 76 | -39 / -23 | 1280x800 | 68 | – |  |  |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 16 / 29 | 0 / 2 | 1280x800 | 47 | – |  |  |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePageHidden | 6/6 | 6 | 14 / 24 | -3 / -2 | 1280x800 | 38 | – |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePage | 6/6 | 6 | 13 / 15 | -2 / -1 | 1280x800 | 42 | – |  |  |
| tinyWindow, fit 1280x800 at 1x | false | cdpJpeg | 6/6 | 6 | 62 / 68 | -36 / -34 | 1280x800 | 72 | – |  |  |
| tinyWindow, fit 1280x800 at 1x | false | frameSub | 6/6 | 6 | 15 / 34 | 1 / 1 | 1280x800 | 48 | – |  |  |
| tinyWindow, fit 1280x800 at 1x | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 29 / 37 | 1280x800 | 33 | – |  |  |
| osr | false | capturePage | 6/6 | 6 | 30 / 38 | -19 / -18 | 1280x800 | 52 | – |  |  |
| osr | false | cdpJpeg | 6/6 | 6 | 97 / 112 | -72 / -71 | 1280x800 | 80 | – |  |  |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | 140 | – |  | no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | 5 | – |  | empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | 100 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 240 | pss | 492 | 4 | 0.0 |
| 1 | 270 | pss | 598 | 5 | 0.0 |
| 2 | 285 | pss | 706 | 6 | 0.0 |
| 4 | 314 | pss | 921 | 8 | 0.5 |
| 8 | 369 | pss | 1353 | 12 | 0.5 |

Per idle hidden tab: **16 MiB**, 0.06% CPU. Four tabs: one partition +67 MiB, four partitions +72 MiB.

Quiet tabs (no rAF loop) working in one shared 1×1 host: **28 MiB** and 1.19% CPU a tab (0: 264 MiB / 0.0%, 1: 306 MiB / 1.0%, 4: 386 MiB / 4.8%, 8: 491 MiB / 9.5%).

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 25.0 | 16.0 | 8.8 | 60 |
| animated, never-shown window, throttling off | 0.8 | 0.8 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.3 | 0.0 | 0.0 | 0 |
| animated, never-shown window, throttling off + frame pump | 0.5 | 0.5 | 0.0 | 0 |
| animated, invisible shown window | 31.7 | 19.5 | 12.2 | 60 |
| animated, 1x1 shown window | 19.0 | 17.3 | 1.8 | 60 |
| animated, osr 30 fps | 26.5 | 10.5 | 6.8 | 30 |

**Waking a resting tab into the host** (never-shown window, throttling on, 4 cycles): first rAF 1 / 3 ms, fresh picture 30 / 48 ms; resting rates 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0; awake rAF 60, 60, 60, 60

**One host, 4 tabs:** tab 1 rAF 60 Hz, capturePage 4/4 in 15 / 22 ms (1280x800); tab 2 rAF 60 Hz, capturePage 4/4 in 15 / 28 ms (1280x800); tab 3 rAF 60 Hz, capturePage 4/4 in 15 / 25 ms (1280x800); tab 4 rAF 60 Hz, capturePage 4/4 in 12 / 18 ms (1280x800)

**The host's invariants:** host 0,0 1x1, focused at start false, after its page grabs focus false (focused window "S7 browser view"); Windows styles –; click-through not testable here (macOS needs Accessibility for synthetic clicks; Wayland and no display have no global input)

**Assertions:** PASS no reload when moving from detached; PASS no reload when moving from hiddenWindow; PASS no reload when moving from hiddenWindowFit; PASS no reload when moving from invisibleWindow; PASS no reload when moving from tinyWindow; PASS the 1x1 host draws (rAF above 10 Hz); PASS a never-shown window draws nothing (rAF below 1 Hz); PASS capturePage works in the 1x1 host; PASS the host never takes focus, even when its page asks; PASS a resting tab draws within 2 s of moving into the host, every cycle; PASS every tab in one shared host draws and is pictured

### Electron · macos-dsf2 (electron-macos-dsf2.json)

Electron 45.2.2 (Chromium 156.0.8078.80), darwin-arm64 25.6.0, ozone (default), displays 1024x768@2, status **done**, 269 s

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | CPU ms/picture | frames/s | visibility events | errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 24 / 115 | 10 / 14 | 2000x1400 | 74 | – |  |  |
| shown | true | capturePage | 6/6 | 6 | 26 / 34 | 7 / 16 | 2000x1400 | 51 | – |  |  |
| shown | true | cdpJpeg | 6/6 | 6 | 118 / 138 | -45 / -35 | 2000x1400 | 129 | – |  |  |
| shown | true | frameSub | 6/6 | 6 | 34 / 48 | 8 / 15 | 2000x1400 | 75 | – |  |  |
| shown | true | cdpPng | 6/6 | 6 | 359 / 451 | -43 / -37 | 2000x1400 | 462 | – |  |  |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | 10 | – |  | Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | 11 | – |  | Current display surface not available for capture |
| detached | false | cdpJpeg | 1/3 | 1 | 135 / 135 | -56 / -56 | 2560x1600 | 195 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | 223 | – |  | frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | 11 | – |  | Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | 14 | – |  | Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 127 / 156 | -61 / -48 | 2560x1600 | 127 | – |  |  |
| hiddenWindow | false | frameSub | 6/6 | 6 | 32 / 65 | 22 / 31 | 2560x1600 | 81 | – |  |  |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | 12 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | 10 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 107 / 132 | -50 / -34 | 2560x1600 | 159 | – |  |  |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 27 / 41 | 5 / 19 | 2560x1600 | 79 | – |  |  |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 6/6 | 6 | 33 / 46 | -2 / 0 | 2560x1600 | 77 | – |  |  |
| invisibleWindow | false | capturePage | 6/6 | 6 | 29 / 37 | -7 / -1 | 2560x1600 | 76 | – |  |  |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 115 / 122 | -45 / -39 | 2560x1600 | 121 | – |  |  |
| invisibleWindow | false | frameSub | 6/6 | 6 | 28 / 51 | 0 / 0 | 2560x1600 | 72 | – |  |  |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 26 / 47 | 26 / 31 | 2560x1600 | 75 | – |  |  |
| tinyWindow | false | capturePage | 6/6 | 6 | 28 / 42 | 30 / 35 | 2560x1600 | 74 | – |  |  |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 136 / 151 | -44 / -35 | 2560x1600 | 128 | – |  |  |
| tinyWindow | false | frameSub | 6/6 | 6 | 36 / 42 | 11 / 38 | 2560x1600 | 77 | – |  |  |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 29 / 52 | 8 / 18 | 2560x1600 | 65 | – |  |  |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 22 / 33 | 3 / 14 | 2560x1600 | 41 | – |  |  |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 113 / 118 | -46 / -38 | 2560x1600 | 104 | – |  |  |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 36 / 49 | 8 / 14 | 2560x1600 | 80 | – |  |  |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePageHidden | 6/6 | 6 | 22 / 58 | 16 / 21 | 2560x1600 | 77 | – |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePage | 6/6 | 6 | 25 / 39 | 14 / 18 | 2560x1600 | 75 | – |  |  |
| tinyWindow, fit 1280x800 at 1x | false | cdpJpeg | 6/6 | 6 | 84 / 316 | -47 / -41 | 1280x800 | 111 | – |  |  |
| tinyWindow, fit 1280x800 at 1x | false | frameSub | 6/6 | 6 | 32 / 66 | -13 / 0 | 2560x1600 | 78 | – |  |  |
| tinyWindow, fit 1280x800 at 1x | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.5 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 1 | 64 / 121 | 1280x800 | 18 | – |  |  |
| osr | false | capturePage | 6/6 | 6 | 19 / 203 | 40 / 123 | 1280x800 | 32 | – |  |  |
| osr | false | cdpJpeg | 6/6 | 6 | 314 / 330 | -180 / -85 | 1280x800 | 105 | – |  |  |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | 13.5 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | 467 | – |  | no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | 6 | – |  | empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | 356 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 175 | footprint | 334 | 3 | 0.1 |
| 1 | 195 | footprint | 426 | 4 | 0.5 |
| 2 | 216 | footprint | 520 | 5 | 0.8 |
| 4 | 256 | footprint | 706 | 7 | 1.4 |
| 8 | 341 | footprint | 1080 | 11 | 2.4 |

Per idle hidden tab: **21 MiB**, 0.29% CPU. Four tabs: one partition +76 MiB, four partitions +82 MiB.

Quiet tabs (no rAF loop) working in one shared 1×1 host: **66 MiB** and 1.88% CPU a tab (0: 200 MiB / 0.1%, 1: 292 MiB / 3.2%, 4: 485 MiB / 9.4%, 8: 730 MiB / 15.2%).

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 27.8 | 9.7 | 17.6 | 60 |
| animated, never-shown window, throttling off | 11.5 | 3.5 | 7.6 | 0 |
| animated, never-shown window, throttling on | 0.7 | 0.1 | 0.4 | 0 |
| animated, never-shown window, throttling off + frame pump | 11.0 | 3.5 | 7.3 | 0 |
| animated, invisible shown window | 32.3 | 10.7 | 21.3 | 60 |
| animated, 1x1 shown window | 34.5 | 11.3 | 22.9 | 60 |
| animated, osr 30 fps | 18.8 | 4.1 | 9.8 | 16 |

**One host, 4 tabs:** tab 1 rAF 60 Hz, capturePage 4/4 in 25 / 42 ms (2560x1600); tab 2 rAF 60 Hz, capturePage 4/4 in 22 / 32 ms (2560x1600); tab 3 rAF 60 Hz, capturePage 4/4 in 27 / 32 ms (2560x1600); tab 4 rAF 60 Hz, capturePage 4/4 in 23 / 27 ms (2560x1600)

**Assertions:** PASS capturePage works in the 1x1 host; PASS every tab in one shared host draws and is pictured

### Electron · macos (electron-macos.json)

Electron 45.2.2 (Chromium 156.0.8078.80), darwin-arm64 25.6.0, ozone (default), displays 1024x768@1, status **done**, 866 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.91 | 27.6 | 34 / 1714 | 12 / 371 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 1.9 |  |
| hiddenWindow | true | true | true | true (1) | 0.97 | 29.3 | 39 / 63 | 16 / 19 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.1 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.95 | 28.9 | 58 / 68 | 17 / 32 | 1280x800@1 → 1000x700@1 → 1280x800 | 1 / 2 | 1.9 |  |
| invisibleWindow | true | true | true | true (1) | 0.98 | 28.9 | 33 / 55 | 5 / 9 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.0 |  |
| tinyWindow | true | true | true | true (1) | 0.97 | 28.9 | 35 / 42 | 7 / 8 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.2 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | IO / RO Hz | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 68.6 | 60.4 | 60.0 | 27 | 2.0 / 2.0 | – | – | – | 10.1 | 28.4 |  |
| detached, throttling on (default) | hidden | 1280x800 | 1.6 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.2 | 1.4 |  |
| detached, throttling off | visible | 1280x800 | 100.0 | 73.7 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 3.4 | 10.3 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.1 | 0.8 |  |
| never-shown window, throttling off | visible | 1280x800 | 99.8 | 74.3 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 3.0 | 9.4 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 69.5 | 60.5 | 60.1 | 25 | 2.0 / 2.0 | – | – | – | 8.3 | 24.4 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 100.1 | 72.3 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 3.5 | 10.7 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 100.1 | 75.9 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 3.7 | 10.7 |  |
| invisible shown window, throttling off | visible | 1280x800 | 70.6 | 60.0 | 60.0 | 34 | 2.0 / 1.8 | – | – | – | 9.0 | 26.5 |  |
| 1x1 shown window, throttling off | visible | 1280x800 | 71.3 | 59.5 | 59.7 | 41 | 1.8 / 1.8 | – | – | – | 9.2 | 26.1 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 67.5 | 59.5 | 59.9 | 27 | 2.0 / 2.0 | – | – | – | 10.6 | 30.3 | cover 0,0 1024x768 over host 0,31 1x1 |
| 1x1 shown window kept above a cover window (always on top) | visible | 1280x800 | 72.7 | 60.0 | 60.0 | 37 | 2.0 / 2.0 | – | – | – | 12.5 | 35.7 | cover 0,0 1024x768 over host 0,31 1x1 |
| invisible shown window, covered by another window | visible | 1280x800 | 70.1 | 60.3 | 59.9 | 35 | 2.0 / 2.0 | – | – | – | 11.7 | 33.4 | cover 0,0 1280x831 over host 0,31 1280x800 |
| 1x1 shown window, throttling on (control) | visible | 1280x800 | 72.9 | 60.1 | 59.9 | 31 | 2.2 / 2.2 | – | – | – | 10.0 | 28.8 |  |
| 1x1 shown window, throttling on, covered by another window (control) | hidden | 1280x800 | 1.2 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.1 | 0.8 | cover 0,0 1024x768 over host 0,31 1x1 |
| invisible shown window, throttling on, covered by another window (control) | hidden | 1280x800 | 1.2 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.1 | 0.6 | cover 0,0 1280x831 over host 0,31 1280x800 |
| osr window 30 fps, throttling off | visible | 1280x800 | 39.7 | 32.5 | 13.2 | 186 | 1.8 / 1.8 | – | – | – | 3.1 | 14.1 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 37.2 | 32.4 | 13.2 | 183 | 0.0 / 2.0 | – | – | – | 2.5 | 6.9 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 38.4 | 31.2 | 0.0 | 0 | 0.0 / 0.0 | 0.84 | 26.0 | – | 5.0 | 10.5 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 37.2 | 30.8 | 0.0 | 0 | 0.0 / 0.0 | 0.88 | 27.2 | – | 4.5 | 9.4 |  |
| detached, throttling off, playing media | visible | 1280x800 | 39.2 | 32.6 | 0.0 | 0 | 0.0 / 0.0 | 0.84 | 25.2 | – | 4.3 | 9.0 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 100.1 | 72.3 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | CPU ms/picture | frames/s | visibility events | errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 22 / 29 | 6 / 12 | 1000x700 | 59 | – |  |  |
| shown | true | capturePage | 6/6 | 6 | 20 / 28 | 7 / 15 | 1000x700 | 51 | – |  |  |
| shown | true | cdpJpeg | 6/6 | 6 | 80 / 113 | -50 / -41 | 1000x700 | 87 | – |  |  |
| shown | true | frameSub | 6/6 | 6 | 23 / 49 | 4 / 14 | 1000x700 | 53 | – |  |  |
| shown | true | cdpPng | 6/6 | 6 | 221 / 248 | -44 / -39 | 1000x700 | 244 | – |  |  |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | 14 | – |  | Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | 14 | – |  | Current display surface not available for capture |
| detached | false | cdpJpeg | 1/3 | 1 | 138 / 138 | -64 / -64 | 1280x800 | 243 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | 181 | – |  | frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | 11 | – |  | Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | 10 | – |  | Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 82 / 129 | -50 / -20 | 1280x800 | 80 | – |  |  |
| hiddenWindow | false | frameSub | 6/6 | 6 | 24 / 41 | 2 / 13 | 1280x800 | 64 | – |  |  |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | 14 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | 12 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 97 / 107 | -55 / -38 | 1280x800 | 138 | – |  |  |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 24 / 41 | 9 / 14 | 1280x800 | 90 | – |  |  |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 6/6 | 6 | 17 / 28 | 6 / 18 | 1280x800 | 59 | – |  |  |
| invisibleWindow | false | capturePage | 6/6 | 6 | 25 / 31 | 6 / 13 | 1280x800 | 74 | – |  |  |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 89 / 103 | -45 / -30 | 1280x800 | 97 | – |  |  |
| invisibleWindow | false | frameSub | 6/6 | 6 | 25 / 32 | 9 / 16 | 1280x800 | 73 | – |  |  |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 24 / 28 | 21 / 30 | 1280x800 | 71 | – |  |  |
| tinyWindow | false | capturePage | 6/6 | 6 | 20 / 32 | 28 / 33 | 1280x800 | 69 | – |  |  |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 97 / 115 | -44 / -40 | 1280x800 | 83 | – |  |  |
| tinyWindow | false | frameSub | 6/6 | 6 | 28 / 36 | 20 / 32 | 1280x800 | 42 | – |  |  |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 17 / 31 | -9 / 0 | 1280x800 | 53 | – |  |  |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 30 / 32 | -15 / -10 | 1280x800 | 69 | – |  |  |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 81 / 90 | -43 / -38 | 1280x800 | 97 | – |  |  |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 20 / 31 | -5 / 0 | 1280x800 | 70 | – |  |  |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePageHidden | 6/6 | 6 | 26 / 27 | -11 / 0 | 1280x800 | 67 | – |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePage | 6/6 | 6 | 21 / 33 | -3 / 2 | 1280x800 | 64 | – |  |  |
| tinyWindow, fit 1280x800 at 1x | false | cdpJpeg | 6/6 | 6 | 77 / 89 | -42 / -40 | 1280x800 | 100 | – |  |  |
| tinyWindow, fit 1280x800 at 1x | false | frameSub | 6/6 | 6 | 23 / 35 | -9 / 1 | 1280x800 | 65 | – |  |  |
| tinyWindow, fit 1280x800 at 1x | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 109 / 239 | 1280x800 | 18 | – |  |  |
| osr | false | capturePage | 6/6 | 6 | 24 / 135 | 24 / 246 | 1280x800 | 39 | – |  |  |
| osr | false | cdpJpeg | 6/6 | 6 | 296 / 439 | -179 / -108 | 1280x800 | 83 | – |  |  |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | 14.5 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | 409 | – |  | no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | 7 | – |  | empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | 367 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 150 | footprint | 407 | 4 | 0.1 |
| 1 | 171 | footprint | 498 | 5 | 0.6 |
| 2 | 191 | footprint | 592 | 6 | 0.8 |
| 4 | 231 | footprint | 778 | 8 | 1.2 |
| 8 | 312 | footprint | 1151 | 12 | 2.4 |

Per idle hidden tab: **20 MiB**, 0.29% CPU. Four tabs: one partition +75 MiB, four partitions +81 MiB.

Quiet tabs (no rAF loop) working in one shared 1×1 host: **35 MiB** and 1.69% CPU a tab (0: 175 MiB / 0.2%, 1: 223 MiB / 2.8%, 4: 322 MiB / 8.1%, 8: 452 MiB / 13.7%).

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 30.9 | 10.1 | 20.4 | 60 |
| animated, never-shown window, throttling off | 9.7 | 3.3 | 6.0 | 0 |
| animated, never-shown window, throttling on | 0.7 | 0.1 | 0.3 | 0 |
| animated, never-shown window, throttling off + frame pump | 8.3 | 2.5 | 5.7 | 0 |
| animated, invisible shown window | 37.2 | 12.3 | 24.6 | 60 |
| animated, 1x1 shown window | 37.1 | 12.5 | 24.4 | 60 |
| animated, osr 30 fps | 17.6 | 3.7 | 8.8 | 14 |

**Waking a resting tab into the host** (never-shown window, throttling on, 4 cycles): first rAF 18 / 44 ms, fresh picture 90 / 99 ms; resting rates 1.4 Hz / rAF 0.0, 1.6 Hz / rAF 0.0, 1.7 Hz / rAF 0.0, 1.5 Hz / rAF 0.0; awake rAF 60, 60, 60, 60

**One host, 4 tabs:** tab 1 rAF 60 Hz, capturePage 4/4 in 15 / 32 ms (1280x800); tab 2 rAF 60 Hz, capturePage 4/4 in 11 / 36 ms (1280x800); tab 3 rAF 60 Hz, capturePage 4/4 in 13 / 24 ms (1280x800); tab 4 rAF 60 Hz, capturePage 4/4 in 24 / 32 ms (1280x800)

**The host's invariants:** host 0,31 1x1, focused at start false, after its page grabs focus false (focused window "S7 probe"); Windows styles –; click-through not testable here (macOS needs Accessibility for synthetic clicks; Wayland and no display have no global input)

**Assertions:** PASS no reload when moving from detached; PASS no reload when moving from hiddenWindow; PASS no reload when moving from hiddenWindowFit; PASS no reload when moving from invisibleWindow; PASS no reload when moving from tinyWindow; PASS the 1x1 host draws (rAF above 10 Hz); PASS a never-shown window draws nothing (rAF below 1 Hz); PASS capturePage works in the 1x1 host; PASS the host never takes focus, even when its page asks; PASS a resting tab draws within 2 s of moving into the host, every cycle; PASS every tab in one shared host draws and is pictured

**Q6 streamed view** (10 s at the viewer; latency p50 / p95 ms)

| road | content | source | fps | decoded fps | latency | gap p95 | kbit/s | bytes/frame | sender CPU % | viewer CPU % | source rAF | notes |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| screencast | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 10 | 0 | 0 |  |
| capturePoll | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 10 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | anim | hiddenWindow | 22.9 | 22.9 | 126 / 171 | 79 | 2466 | 13463 | 56 | 20 | 60 | libvpx; video/VP8 |
| webrtc-h264 | anim | hiddenWindow | 10.9 | 10.9 | 202 / 242 | 141 | 1991 | 22834 | 99 | 7 | 59 | OpenH264; video/H264 |
| webcodecs-vp8 | anim | hiddenWindow | 29.1 | 29.1 | 48 / 184 | 54 | 2184 | 9380 | 113 | 18 | 59 |  |
| webcodecs-h264 | anim | hiddenWindow | 30.0 | 30.0 | 44 / 56 | 49 | 2238 | 9325 | 102 | 15 | 60 |  |
| screencast | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 |  |
| capturePoll | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | static | hiddenWindow | 2.0 | 2.0 | 222 / 314 | 585 | 95 | 5916 | 11 | 2 | 44 | libvpx; video/VP8 |
| webrtc-h264 | static | hiddenWindow | 1.0 | 1.0 | 72 / 603 | 1019 | 21 | 2586 | 13 | 2 | 43 | OpenH264; video/H264 |
| webcodecs-vp8 | static | hiddenWindow | 2.0 | 2.0 | 55 / 78 | 536 | 102 | 6358 | 10 | 1 | 41 |  |
| webcodecs-h264 | static | hiddenWindow | 2.0 | 2.0 | 42 / 77 | 543 | 9 | 565 | 9 | 2 | 40 |  |
| screencast | anim | invisibleWindow | 60.1 | 60.1 | 36 / 47 | 31 | 58469 | 121607 | 75 | 24 | 60 |  |
| capturePoll | anim | invisibleWindow | 28.6 | 28.6 | 44 / 52 | 48 | 27947 | 122147 | 57 | 13 | 60 | toJPEG 5.6 ms |
| webcodecs-h264 | anim | invisibleWindow | 30.0 | 30.0 | 43 / 54 | 49 | 2281 | 9471 | 93 | 13 | 60 |  |
| screencast | anim | tinyWindow | 60.1 | 60.1 | 54 / 67 | 32 | 58413 | 121491 | 89 | 26 | 60 |  |
| webcodecs-h264 | anim | tinyWindow | 30.0 | 30.0 | 49 / 66 | 48 | 2228 | 9284 | 84 | 11 | 60 |  |
| screencast | anim | shown | 59.9 | 59.9 | 54 / 64 | 28 | 48833 | 101906 | 79 | 23 | 60 |  |
| webrtc-vp8 | anim | shown | 3.1 | 3.1 | 267 / 441 | 485 | 488 | 19689 | 42 | 3 | 60 | libvpx; video/VP8 |
| webcodecs-h264 | anim | shown | 27.8 | 27.8 | 41 / 50 | 45 | 1957 | 8801 | 67 | 12 | 55 |  |

### Electron · windows-dsf2 (electron-windows-dsf2.json)

Electron 45.2.2 (Chromium 156.0.8078.80), win32-x64 10.0.26100, ozone (default), displays 256x192@2, status **done**, 353 s

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | CPU ms/picture | frames/s | visibility events | errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 33 / 40 | 20 / 27 | 2000x1400 | 206 | – |  |  |
| shown | true | capturePage | 6/6 | 6 | 34 / 35 | 20 / 21 | 2000x1400 | 98 | – |  |  |
| shown | true | cdpJpeg | 6/6 | 6 | 118 / 131 | -35 / -32 | 2000x1400 | 160 | – |  |  |
| shown | true | frameSub | 6/6 | 6 | 39 / 43 | 23 / 24 | 2000x1400 | 101 | – |  |  |
| shown | true | cdpPng | 6/6 | 6 | 336 / 352 | -40 / -37 | 2000x1400 | 468 | – |  |  |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | 80 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | 92 | – |  | frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 4974 / 4979 | -2892 / -40 | 2560x1600 | 189 | – |  |  |
| hiddenWindow | false | frameSub | 6/6 | 6 | 37 / 38 | 65 / 144 | 2560x1600 | 94 | – |  |  |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.5 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 153 / 186 | -59 / -15 | 2560x1600 | 410 | – |  |  |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 56 / 68 | 12 / 41 | 2560x1600 | 211 | – |  |  |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 6/6 | 6 | 45 / 48 | 19 / 30 | 2560x1600 | 132 | – |  |  |
| invisibleWindow | false | capturePage | 6/6 | 6 | 45 / 47 | 2 / 21 | 2560x1600 | 139 | – |  |  |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 132 / 135 | -43 / -38 | 2560x1600 | 209 | – |  |  |
| invisibleWindow | false | frameSub | 6/6 | 6 | 53 / 55 | 7 / 8 | 2560x1600 | 142 | – |  |  |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 29.5 |  |  |
| tinyWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | 3 | – |  | empty image |
| tinyWindow | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | empty image |
| tinyWindow | false | cdpJpeg | 0/2 | 0 | – | – | - | 262 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| tinyWindow | false | frameSub | 0/2 | 0 | – | – | - | 237 | – |  | frame subscription: timed out after 5000 ms |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | empty image |
| tinyWindow, covered | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | empty image |
| tinyWindow, covered | false | cdpJpeg | 0/2 | 0 | – | – | - | 269 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| tinyWindow, covered | false | frameSub | 0/2 | 0 | – | – | - | 245 | – |  | frame subscription: timed out after 5000 ms |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePageHidden | 5/6 | 5 | 32 / 40 | 96 / 101 | 2560x1600 | 69 | – |  | UnknownVizError |
| tinyWindow, fit 1280x800 at 1x | false | capturePage | 6/6 | 6 | 31 / 33 | 93 / 96 | 2560x1600 | 65 | – |  |  |
| tinyWindow, fit 1280x800 at 1x | false | cdpJpeg | 6/6 | 6 | 2976 / 2978 | -2944 / -2925 | 1280x800 | 101 | – |  |  |
| tinyWindow, fit 1280x800 at 1x | false | frameSub | 6/6 | 6 | 36 / 37 | 41 / 58 | 2560x1600 | 93 | – |  |  |
| tinyWindow, fit 1280x800 at 1x | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.5 |  |  |
| osr | false | osrPaint | 6/6 | 0 | 0 / 0 | – | 512x360 | 14 | – |  |  |
| osr | false | capturePage | 6/6 | 0 | 32 / 33 | – | 512x360 | 16 | – |  |  |
| osr | false | cdpJpeg | 6/6 | 0 | 100 / 102 | – | 512x360 | 26 | – |  |  |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | 171 | – |  | no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | 125 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 106 | privateBytes | 154 | 3 | 0.0 |
| 1 | 131 | privateBytes | 224 | 4 | 0.1 |
| 2 | 156 | privateBytes | 291 | 5 | 0.2 |
| 4 | 209 | privateBytes | 438 | 7 | 0.4 |
| 8 | 319 | privateBytes | 739 | 11 | 0.6 |

Per idle hidden tab: **27 MiB**, 0.07% CPU. Four tabs: one partition +98 MiB, four partitions +104 MiB.

Quiet tabs (no rAF loop) working in one shared 1×1 host: **27 MiB** and -0.01% CPU a tab (0: 135 MiB / 0.8%, 1: 163 MiB / 0.2%, 4: 242 MiB / 0.4%, 8: 353 MiB / 0.7%).

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 40.4 | 17.0 | 23.2 | 64 |
| animated, never-shown window, throttling off | 1.7 | 1.2 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.2 | 0.0 | 0.0 | 0 |
| animated, never-shown window, throttling off + frame pump | 1.4 | 1.2 | 0.0 | 0 |
| animated, invisible shown window | 49.5 | 22.9 | 26.5 | 64 |
| animated, 1x1 shown window | 1.4 | 1.3 | 0.0 | 0 |
| animated, osr 30 fps | 10.2 | 5.5 | 2.3 | 30 |

**One host, 4 tabs:** tab 1 rAF 0 Hz, capturePage 0/4 in – ms (-); tab 2 rAF 0 Hz, capturePage 0/4 in – ms (-); tab 3 rAF 0 Hz, capturePage 0/4 in – ms (-); tab 4 rAF 0 Hz, capturePage 0/4 in – ms (-)

**Assertions:** **FAIL** capturePage works in the 1x1 host; **FAIL** every tab in one shared host draws and is pictured

### Electron · windows (electron-windows.json)

Electron 45.2.2 (Chromium 156.0.8078.80), win32-x64 10.0.26100, ozone (default), displays 1024x768@1, status **done**, 884 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.92 | 27.4 | 25 / 64 | 0 / 41 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.96 | 28.6 | 23 / 33 | 14 / 16 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.0 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.97 | 28.6 | 23 / 29 | 13 / 17 | 1280x800@1 → 1000x700@1 → 1280x800 | 1 / 2 | 2.0 |  |
| invisibleWindow | true | true | true | true (1) | 0.96 | 28.8 | 20 / 26 | 5 / 16 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 64.1 |  |
| tinyWindow | true | true | true | true (1) | 0.97 | 28.8 | 21 / 24 | 1 / 14 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 64.0 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | IO / RO Hz | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 100.0 | 92.4 | 64.0 | 18 | 2.0 / 2.0 | – | – | – | 5.8 | 10.5 |  |
| detached, throttling on (default) | hidden | 1280x800 | 1.2 | 1.2 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.3 |  |
| detached, throttling off | visible | 1280x800 | 100.0 | 98.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 1.1 | 1.3 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.2 |  |
| never-shown window, throttling off | visible | 1280x800 | 100.0 | 97.8 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 1.2 | 1.3 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 100.0 | 90.6 | 1.0 | 1001 | 0.0 / 0.0 | – | – | – | 1.0 | 1.3 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 100.0 | 98.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 1.1 | 1.3 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 100.0 | 98.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 1.1 | 1.3 |  |
| invisible shown window, throttling off | visible | 1280x800 | 100.0 | 92.4 | 64.2 | 18 | 2.2 / 2.2 | – | – | – | 5.8 | 10.6 |  |
| 1x1 shown window, throttling off | visible | 1280x800 | 100.0 | 91.6 | 64.0 | 17 | 1.8 / 1.8 | – | – | – | 4.5 | 7.5 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 100.0 | 92.6 | 64.0 | 18 | 2.0 / 2.0 | – | – | – | 5.3 | 8.8 | cover 0,0 1024x720 over host 0,0 4x31 |
| 1x1 shown window kept above a cover window (always on top) | visible | 1280x800 | 100.2 | 92.8 | 64.2 | 18 | 2.0 / 2.2 | – | – | – | 5.1 | 8.5 | cover 0,0 1024x720 over host 0,0 4x31 |
| invisible shown window, covered by another window | visible | 1280x800 | 100.0 | 91.4 | 64.0 | 18 | 2.0 / 2.0 | – | – | – | 4.6 | 8.4 | cover 0,0 1024x720 over host 0,0 1024x720 |
| 1x1 shown window, throttling on (control) | visible | 1280x800 | 100.0 | 93.0 | 64.0 | 18 | 2.0 / 2.0 | – | – | – | 4.9 | 8.1 |  |
| 1x1 shown window, throttling on, covered by another window (control) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.2 | cover 0,0 1024x720 over host 0,0 4x31 |
| invisible shown window, throttling on, covered by another window (control) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.2 | cover 0,0 1024x720 over host 0,0 1024x720 |
| osr window 30 fps, throttling off | visible | 1024x720 | 100.0 | 90.8 | 30.2 | 35 | 2.0 / 2.2 | – | – | – | 3.1 | 8.8 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 100.0 | 90.6 | 30.0 | 35 | 0.0 / 2.0 | – | – | – | 1.9 | 2.4 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 100.0 | 91.8 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 24.8 | – | 2.1 | 2.9 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 100.0 | 91.4 | 0.0 | 0 | 0.0 / 0.0 | 0.84 | 24.8 | – | 2.3 | 3.1 |  |
| detached, throttling off, playing media | visible | 1280x800 | 100.0 | 91.4 | 0.0 | 0 | 0.0 / 0.0 | 0.84 | 24.8 | – | 2.5 | 3.4 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 100.0 | 97.8 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | CPU ms/picture | frames/s | visibility events | errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 8 / 17 | 13 / 16 | 1000x700 | 55 | – |  |  |
| shown | true | capturePage | 6/6 | 6 | 5 / 12 | 14 / 16 | 1000x700 | 52 | – |  |  |
| shown | true | cdpJpeg | 6/6 | 6 | 69 / 71 | -41 / -35 | 1000x700 | 86 | – |  |  |
| shown | true | frameSub | 6/6 | 6 | 19 / 24 | 2 / 15 | 1000x700 | 51 | – |  |  |
| shown | true | cdpPng | 6/6 | 6 | 192 / 209 | -44 / -35 | 1000x700 | 248 | – |  |  |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | 95 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | 77 | – |  | frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 3974 / 3982 | -2942 / -37 | 1280x800 | 132 | – |  |  |
| hiddenWindow | false | frameSub | 6/6 | 6 | 8 / 9 | 59 / 72 | 1280x800 | 39 | – |  |  |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.5 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 70 / 86 | -39 / -26 | 1280x800 | 108 | – |  |  |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 12 / 24 | 1 / 15 | 1280x800 | 63 | – |  |  |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 6/6 | 6 | 8 / 20 | 10 / 16 | 1280x800 | 64 | – |  |  |
| invisibleWindow | false | capturePage | 6/6 | 6 | 19 / 22 | 3 / 14 | 1280x800 | 73 | – |  |  |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 76 / 82 | -38 / -32 | 1280x800 | 107 | – |  |  |
| invisibleWindow | false | frameSub | 6/6 | 6 | 23 / 25 | 3 / 3 | 1280x800 | 70 | – |  |  |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 22 / 23 | 2 / 4 | 1280x800 | 48 | – |  |  |
| tinyWindow | false | capturePage | 6/6 | 6 | 21 / 22 | 2 / 14 | 1280x800 | 50 | – |  |  |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 71 / 77 | -38 / -36 | 1280x800 | 73 | – |  |  |
| tinyWindow | false | frameSub | 6/6 | 6 | 23 / 26 | 0 / 3 | 1280x800 | 44 | – |  |  |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 8 / 21 | 13 / 14 | 1280x800 | 40 | – |  |  |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 7 / 20 | 14 / 15 | 1280x800 | 44 | – |  |  |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 69 / 77 | -37 / -37 | 1280x800 | 74 | – |  |  |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 23 / 24 | 0 / 15 | 1280x800 | 43 | – |  |  |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePageHidden | 6/6 | 6 | 7 / 23 | 1 / 2 | 1280x800 | 41 | – |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePage | 6/6 | 6 | 7 / 21 | 0 / 2 | 1280x800 | 36 | – |  |  |
| tinyWindow, fit 1280x800 at 1x | false | cdpJpeg | 6/6 | 6 | 54 / 64 | -36 / -21 | 1280x800 | 61 | – |  |  |
| tinyWindow, fit 1280x800 at 1x | false | frameSub | 6/6 | 6 | 11 / 23 | -11 / 2 | 1280x800 | 37 | – |  |  |
| tinyWindow, fit 1280x800 at 1x | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 41 / 43 | 1024x720 | 21 | – |  |  |
| osr | false | capturePage | 6/6 | 6 | 31 / 33 | 6 / 9 | 1024x720 | 29 | – |  |  |
| osr | false | cdpJpeg | 6/6 | 6 | 132 / 141 | -87 / -86 | 1024x720 | 61 | – |  |  |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | 137 | – |  | no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | 102 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 145 | privateBytes | 159 | 4 | 0.0 |
| 1 | 171 | privateBytes | 233 | 5 | 0.1 |
| 2 | 196 | privateBytes | 304 | 6 | 0.2 |
| 4 | 248 | privateBytes | 455 | 8 | 0.4 |
| 8 | 352 | privateBytes | 760 | 12 | 0.5 |

Per idle hidden tab: **26 MiB**, 0.06% CPU. Four tabs: one partition +99 MiB, four partitions +104 MiB.

Quiet tabs (no rAF loop) working in one shared 1×1 host: **28 MiB** and 0.67% CPU a tab (0: 172 MiB / 0.8%, 1: 199 MiB / 0.9%, 4: 280 MiB / 3.2%, 8: 393 MiB / 6.2%).

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 34.2 | 18.2 | 15.8 | 64 |
| animated, never-shown window, throttling off | 1.9 | 1.3 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.1 | 0.0 | 0.0 | 0 |
| animated, never-shown window, throttling off + frame pump | 1.4 | 1.2 | 0.1 | 0 |
| animated, invisible shown window | 42.5 | 22.6 | 19.7 | 64 |
| animated, 1x1 shown window | 26.2 | 22.0 | 4.0 | 64 |
| animated, osr 30 fps | 20.2 | 9.8 | 6.2 | 30 |

**Waking a resting tab into the host** (never-shown window, throttling on, 4 cycles): first rAF 2 / 4 ms, fresh picture 30 / 41 ms; resting rates 1.0 Hz / rAF 0.0, 1.1 Hz / rAF 0.0, 1.2 Hz / rAF 0.0, 1.1 Hz / rAF 0.0; awake rAF 64, 64, 64, 64

**One host, 4 tabs:** tab 1 rAF 64 Hz, capturePage 4/4 in 20 / 21 ms (1280x800); tab 2 rAF 64 Hz, capturePage 4/4 in 20 / 20 ms (1280x800); tab 3 rAF 64 Hz, capturePage 4/4 in 20 / 21 ms (1280x800); tab 4 rAF 64 Hz, capturePage 4/4 in 20 / 22 ms (1280x800)

**The host's invariants:** host 0,0 4x31, focused at start false, after its page grabs focus false (focused window "S7 probe"); Windows styles {"style":"0x14c00000","exStyle":"0x82801a0","toolWindow":true,"noActivate":true,"transparent":true,"layered":true,"appWindow":false}; click-through {"at":"2,15","tool":"SendInput via user32 SetCursorPos and mouse_event","belowClicks":1,"hostClicks":0}

**Assertions:** PASS no reload when moving from detached; PASS no reload when moving from hiddenWindow; PASS no reload when moving from hiddenWindowFit; PASS no reload when moving from invisibleWindow; PASS no reload when moving from tinyWindow; PASS the 1x1 host draws (rAF above 10 Hz); PASS a never-shown window draws nothing (rAF below 1 Hz); PASS capturePage works in the 1x1 host; PASS the host never takes focus, even when its page asks; PASS Windows: the host is a no-activate, click-through tool window, not an app window; PASS a real click at the host's point reaches the window below; PASS a resting tab draws within 2 s of moving into the host, every cycle; PASS every tab in one shared host draws and is pictured

**Q6 streamed view** (10 s at the viewer; latency p50 / p95 ms)

| road | content | source | fps | decoded fps | latency | gap p95 | kbit/s | bytes/frame | sender CPU % | viewer CPU % | source rAF | notes |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| screencast | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | 0 |  |
| capturePoll | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | anim | hiddenWindow | 25.6 | 25.6 | 37 / 39 | 64 | 2509 | 12253 | 70 | 16 | 64 | libvpx; video/VP8 |
| webrtc-h264 | anim | hiddenWindow | 14.7 | 14.7 | 67 / 70 | 93 | 2496 | 21225 | 62 | 9 | 64 | OpenH264; video/H264 |
| webcodecs-vp8 | anim | hiddenWindow | 30.0 | 30.0 | 30 / 32 | 48 | 2186 | 9110 | 78 | 15 | 64 |  |
| webcodecs-h264 | anim | hiddenWindow | 30.1 | 30.1 | 29 / 30 | 48 | 2172 | 9048 | 78 | 14 | 64 |  |
| screencast | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | 0 |  |
| capturePoll | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | static | hiddenWindow | 2.0 | 2.0 | 63 / 68 | 520 | 558 | 34847 | 7 | 2 | 64 | libvpx; video/VP8 |
| webrtc-h264 | static | hiddenWindow | 1.0 | 1.0 | 29 / 33 | 1005 | 17 | 2168 | 7 | 1 | 64 | OpenH264; video/H264 |
| webcodecs-vp8 | static | hiddenWindow | 2.0 | 2.0 | 25 / 27 | 502 | 114 | 7116 | 6 | 1 | 64 |  |
| webcodecs-h264 | static | hiddenWindow | 2.0 | 2.0 | 25 / 27 | 502 | 100 | 6230 | 5 | 1 | 64 |  |
| screencast | anim | invisibleWindow | 64.0 | 64.0 | 34 / 36 | 17 | 60542 | 118247 | 135 | 33 | 64 |  |
| capturePoll | anim | invisibleWindow | 32.4 | 32.4 | 33 / 35 | 34 | 30755 | 118653 | 91 | 16 | 64 | toJPEG 6.0 ms |
| webcodecs-h264 | anim | invisibleWindow | 30.0 | 30.0 | 32 / 34 | 48 | 2160 | 9001 | 103 | 15 | 64 |  |
| screencast | anim | tinyWindow | 64.0 | 64.0 | 32 / 34 | 17 | 60550 | 118261 | 126 | 32 | 64 |  |
| webcodecs-h264 | anim | tinyWindow | 30.1 | 30.1 | 30 / 32 | 47 | 2161 | 9004 | 87 | 14 | 64 |  |
| screencast | anim | shown | 64.0 | 64.0 | 30 / 31 | 17 | 50815 | 99248 | 102 | 24 | 64 |  |
| webrtc-vp8 | anim | shown | 24.6 | 24.6 | 53 / 56 | 77 | 2509 | 12751 | 101 | 16 | 64 | libvpx; video/VP8 |
| webcodecs-h264 | anim | shown | 30.1 | 30.1 | 37 / 39 | 48 | 2210 | 9207 | 108 | 17 | 64 |  |

### The pair · linux-x64 (pair-linux.json)

7.0.0-1017-azure, 35 s, state **done**

- **login start**: {"daemonUpMs":110,"daemonUp":true,"appConnectedMs":3304,"appStartedBy":"daemon","appStart":{"at":1793851089676,"safeMode":false,"reason":"daemon start","ok":true,"how":"systemctl --user start clover-s7-app-73aae481.service","out":""},"daemonParent":1107}
- **second daemon on the same home**: {"exitCode":0,"ms":27,"said":"2026-11-05T03:58:10.819Z [core 2385] another daemon holds this home (flock: held by another process); exiting","firstStillServing":true}
- **app crash**: {"killed":2333,"kill":{"ok":true,"how":"kill -9 2333","code":0,"out":""},"restartedMs":1218,"newPid":2395,"startedBy":"daemon","safeMode":false,"how":"systemctl --user start clover-s7-app-73aae481.service","eventsSinceKill":["start","tray","connected"]}
- **app crash loop → safe mode**: {"rounds":[{"killed":2395,"restartedMs":2222,"safeMode":false,"crashesInDaemon":2},{"killed":2447,"restartedMs":4139,"safeMode":true,"crashesInDaemon":3}],"thirdRestartInSafeMode":true}
- **daemon crash, restarted by the OS alone**: {"killed":2321,"kill":{"ok":true,"how":"kill -9 2321","code":0,"out":""},"daemonBackMs":1206,"newDaemonPid":2546,"appSurvived":true,"appPidAfter":2499,"samePid":true,"appStartedTheDaemon":false,"appEvents":["3ms daemon-lost","1508ms connected","1508ms reconnected"]}
- **daemon crash, the app helps after 3 s**: {"killed":2546,"kill":{"ok":true,"how":"kill -9 2546","code":0,"out":""},"daemonBackMs":1205,"newDaemonPid":2556,"appSurvived":true,"appPidAfter":2499,"samePid":true,"appStartedTheDaemon":false,"appEvents":["1ms daemon-lost","1506ms connected","1506ms reconnected"]}
- **tray Quit stops both, and they stay down**: {"forwarded":{"forwarded":true},"bothDownMs":402,"restartedWithin12s":false,"appEvents":["quit","quit-acked"]}
- **a user starts the app → it starts the daemon**: {"start":{"ok":true,"how":"spawn detached (as from a launcher)","code":0,"out":"2572"},"bothUpMs":508,"startedBy":"user","appStartedTheDaemon":[{"ok":true,"how":"systemctl --user start clover-s7-core-73aae481.service","out":""}],"appEvents":["start","tray","start-daemon","connected"]}
- **the daemon side's Quit stops both**: {"bothDownMs":402,"restartedWithin8s":false}

**Assertions:** PASS the login item starts the daemon, and the daemon the app; PASS a second daemon is refused and exits 0; PASS a crashed app is back within 6 s; PASS the start after the third crash in two minutes is in safe mode; PASS a crashed daemon is back within 5 s without the app's help; PASS a crashed daemon is back within 10 s, and the app lives on; PASS the tray's Quit stops both, and nothing restarts them; PASS a user's start of the app brings up both within 10 s; PASS the daemon side's Quit stops both, and nothing restarts them

### The pair · darwin-arm64 (pair-macos.json)

25.6.0, 38 s, state **done**

- **login start**: {"daemonUpMs":136,"daemonUp":true,"appConnectedMs":4271,"appStartedBy":"daemon","appStart":{"at":1793851113038,"safeMode":false,"reason":"daemon start","ok":true,"how":"open -n -g -a /Users/runner/work/clover/clover/spikes/s7-browser/prototype/node_modules/electron/dist/Electron.app --args /Users/runner/work/clover/clover/spikes/s7-browser/prototype/out/pair/app --home=/var/folders/n6/hn37q6pj7sj_9dmqqc2113800000gn/T/clover-s7-pair-FMXPI7","out":""},"daemonParent":1}
- **second daemon on the same home**: {"exitCode":0,"ms":173,"said":"2026-11-05T03:58:34.898Z [core 6734] another daemon holds this home (flock: held by another process); exiting","firstStillServing":true}
- **app crash**: {"killed":6723,"kill":{"ok":true,"how":"kill -9 6723","code":0,"out":""},"restartedMs":1661,"newPid":6740,"startedBy":"daemon","safeMode":false,"how":"open -n -g -a /Users/runner/work/clover/clover/spikes/s7-browser/prototype/node_modules/electron/dist/Electron.app --args /Users/runner/work/clover/clover/spikes/s7-browser/prototype/out/pair/app --home=/var/folders/n6/hn37q6pj7sj_9dmqqc2113800000gn/T/clover-s7-pair-FMXPI7","eventsSinceKill":["start","tray","connected"]}
- **app crash loop → safe mode**: {"rounds":[{"killed":6740,"restartedMs":2655,"safeMode":false,"crashesInDaemon":2},{"killed":6752,"restartedMs":4661,"safeMode":true,"crashesInDaemon":3}],"thirdRestartInSafeMode":true}
- **daemon crash, restarted by the OS alone**: {"killed":6710,"kill":{"ok":true,"how":"kill -9 6710","code":0,"out":""},"daemonBackMs":1224,"newDaemonPid":7010,"appSurvived":true,"appPidAfter":7004,"samePid":true,"appStartedTheDaemon":false,"appEvents":["3ms daemon-lost","1030ms connected","1031ms reconnected"]}
- **daemon crash, the app helps after 3 s**: {"killed":7010,"kill":{"ok":true,"how":"kill -9 7010","code":0,"out":""},"daemonBackMs":1208,"newDaemonPid":7015,"appSurvived":true,"appPidAfter":7004,"samePid":true,"appStartedTheDaemon":false,"appEvents":["1ms daemon-lost","511ms connected","512ms reconnected"]}
- **tray Quit stops both, and they stay down**: {"forwarded":{"forwarded":true},"bothDownMs":429,"restartedWithin12s":false,"appEvents":["quit","quit-acked"]}
- **a user starts the app → it starts the daemon**: {"start":{"ok":true,"how":"open -n -g -a /Users/runner/work/clover/clover/spikes/s7-browser/prototype/node_modules/electron/dist/Electron.app --args /Users/runner/work/clover/clover/spikes/s7-browser/prototype/out/pair/app --home=/var/folders/n6/hn37q6pj7sj_9dmqqc2113800000gn/T/clover-s7-pair-FMXPI7","code":0,"out":""},"bothUpMs":1029,"startedBy":"user","appStartedTheDaemon":[{"ok":true,"how":"launchctl kickstart gui/501/com.waifucave.clover.s7.core.8307e188","out":""}],"appEvents":["start","tray","start-daemon","connected"]}
- **the daemon side's Quit stops both**: {"bothDownMs":316,"restartedWithin8s":false}

**Assertions:** PASS the login item starts the daemon, and the daemon the app; PASS a second daemon is refused and exits 0; PASS a crashed app is back within 6 s; PASS the start after the third crash in two minutes is in safe mode; PASS a crashed daemon is back within 5 s without the app's help; PASS a crashed daemon is back within 10 s, and the app lives on; PASS the tray's Quit stops both, and nothing restarts them; PASS a user's start of the app brings up both within 10 s; PASS the daemon side's Quit stops both, and nothing restarts them

### The pair · win32-x64 (pair-windows-spawn.json)

10.0.26100, 188 s, state **done**, Windows app start: spawn

- **login start**: {"daemonUpMs":457,"daemonUp":true,"appConnectedMs":3620,"appStartedBy":"daemon","appStart":{"at":1793851113553,"safeMode":false,"reason":"daemon start","ok":true,"how":"spawn detached","out":"7844"},"daemonParent":2620}
- **second daemon on the same home**: {"exitCode":0,"ms":83,"said":"2026-11-05T03:58:33.886Z [core 6348] another daemon holds this home (CreateFileW: error 32 (sharing violation: another daemon holds it)); exiting","firstStillServing":true}
- **app crash**: {"killed":7844,"kill":{"ok":true,"how":"taskkill /F /T /PID 7844","code":0,"out":"SUCCESS: The process with PID 4344 (child process of PID 7844) has been terminated.\r\nSUCCESS: The process with PID 5064 (child process of PID 7844) has been ter"},"restartedMs":1221,"newPid":2908,"startedBy":"daemon","safeMode":false,"how":"spawn detached","eventsSinceKill":["start","tray","connected"]}
- **app crash loop → safe mode**: {"rounds":[{"killed":2908,"restartedMs":2230,"safeMode":false,"crashesInDaemon":2},{"killed":8956,"restartedMs":4186,"safeMode":true,"crashesInDaemon":3}],"thirdRestartInSafeMode":true}
- **daemon crash, restarted by the OS alone**: {"killed":7156,"kill":{"ok":true,"how":"taskkill /F /PID 7156","code":0,"out":"SUCCESS: The process with PID 7156 has been terminated."},"appSurvived":true,"appPidAfter":7280,"samePid":true,"appStartedTheDaemon":{"atMs":150394,"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-6a2392e1"},"appEvents":["58ms daemon-lost","150394ms start-daemon","150899ms connected","150899ms reconnected"]}
- **daemon crash, the app helps after 3 s**: {"killed":6548,"kill":{"ok":true,"how":"taskkill /F /PID 6548","code":0,"out":"SUCCESS: The process with PID 6548 has been terminated."},"daemonBackMs":3299,"newDaemonPid":7840,"appSurvived":true,"appPidAfter":7280,"samePid":true,"appStartedTheDaemon":{"atMs":3136,"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-6a2392e1"},"appEvents":["90ms daemon-lost","3136ms start-daemon","3640ms connected","3640ms reconnected"]}
- **tray Quit stops both, and they stay down**: {"forwarded":{"forwarded":true},"bothDownMs":324,"restartedWithin12s":false,"appEvents":["quit-acked"]}
- **a user starts the app → it starts the daemon**: {"start":{"ok":true,"how":"spawn detached","code":0,"out":"7152"},"bothUpMs":555,"startedBy":"user","appStartedTheDaemon":[{"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-6a2392e1","out":"SUCCESS: Attempted to run the scheduled task \"\\Clover S7\\core-6a2392e1\"."}],"appEvents":["start","tray","start-daemon","connected"]}
- **the daemon side's Quit stops both**: {"bothDownMs":322,"restartedWithin8s":false}

**Assertions:** PASS the login item starts the daemon, and the daemon the app; PASS a second daemon is refused and exits 0; PASS a crashed app is back within 6 s; PASS the start after the third crash in two minutes is in safe mode; PASS Task Scheduler alone does not restart a killed task (the finding the supervisor answers); PASS a crashed daemon is back within 10 s, and the app lives on; PASS the tray's Quit stops both, and nothing restarts them; PASS a user's start of the app brings up both within 10 s; PASS the daemon side's Quit stops both, and nothing restarts them

### The pair · win32-x64 (pair-windows-supervise.json)

10.0.26100, 36 s, state **done**, Windows app start: task, daemon under the supervisor

- **login start**: {"daemonUpMs":460,"daemonUp":true,"appConnectedMs":3082,"appStartedBy":"daemon","appStart":{"at":1793851165168,"safeMode":false,"reason":"daemon start","ok":true,"how":"schtasks /Run /TN \\Clover S7\\app-2af8e4a0","out":"SUCCESS: Attempted to run the scheduled task \"\\Clover S7\\app-2af8e4a0\"."},"daemonParent":7164}
- **second daemon on the same home**: {"exitCode":0,"ms":81,"said":"2026-11-05T03:59:25.790Z [core 2100] another daemon holds this home (CreateFileW: error 32 (sharing violation: another daemon holds it)); exiting","firstStillServing":true}
- **app crash**: {"killed":692,"kill":{"ok":true,"how":"taskkill /F /T /PID 692","code":0,"out":"SUCCESS: The process with PID 2416 (child process of PID 692) has been terminated.\r\nSUCCESS: The process with PID 1056 (child process of PID 692) has been termi"},"restartedMs":1218,"newPid":5340,"startedBy":"daemon","safeMode":false,"how":"schtasks /Run /TN \\Clover S7\\app-2af8e4a0","eventsSinceKill":["start","tray","connected"]}
- **app crash loop → safe mode**: {"rounds":[{"killed":5340,"restartedMs":2176,"safeMode":false,"crashesInDaemon":2},{"killed":2448,"restartedMs":4187,"safeMode":true,"crashesInDaemon":3}],"thirdRestartInSafeMode":true}
- **daemon crash, restarted by the OS alone**: {"killed":6016,"kill":{"ok":true,"how":"taskkill /F /PID 6016","code":0,"out":"SUCCESS: The process with PID 6016 has been terminated."},"daemonBackMs":642,"newDaemonPid":8668,"appSurvived":true,"appPidAfter":7056,"samePid":true,"appStartedTheDaemon":false,"appEvents":["58ms daemon-lost","1063ms connected","1063ms reconnected"]}
- **daemon crash, the app helps after 3 s**: {"killed":8668,"kill":{"ok":true,"how":"taskkill /F /PID 8668","code":0,"out":"SUCCESS: The process with PID 8668 has been terminated."},"daemonBackMs":1226,"newDaemonPid":2672,"appSurvived":true,"appPidAfter":7056,"samePid":true,"appStartedTheDaemon":false,"appEvents":["50ms daemon-lost","1559ms connected","1560ms reconnected"]}
- **tray Quit stops both, and they stay down**: {"forwarded":{"forwarded":true},"bothDownMs":334,"restartedWithin12s":false,"appEvents":[]}
- **a user starts the app → it starts the daemon**: {"start":{"ok":true,"how":"spawn detached","code":0,"out":"4968"},"bothUpMs":869,"startedBy":"user","appStartedTheDaemon":[{"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-2af8e4a0","out":"SUCCESS: Attempted to run the scheduled task \"\\Clover S7\\core-2af8e4a0\"."}],"appEvents":["start","tray","start-daemon","connected"]}
- **the daemon side's Quit stops both**: {"bothDownMs":325,"restartedWithin8s":false}

**Assertions:** PASS the login item starts the daemon, and the daemon the app; PASS a second daemon is refused and exits 0; PASS a crashed app is back within 6 s; PASS the start after the third crash in two minutes is in safe mode; PASS a crashed daemon is back within 5 s without the app's help; PASS a crashed daemon is back within 10 s, and the app lives on; PASS the tray's Quit stops both, and nothing restarts them; PASS a user's start of the app brings up both within 10 s; PASS the daemon side's Quit stops both, and nothing restarts them

### The pair · win32-x64 (pair-windows-task.json)

10.0.26100, 187 s, state **done**, Windows app start: task

- **login start**: {"daemonUpMs":348,"daemonUp":true,"appConnectedMs":2772,"appStartedBy":"daemon","appStart":{"at":1793851121384,"safeMode":false,"reason":"daemon start","ok":true,"how":"schtasks /Run /TN \\Clover S7\\app-c04e1803","out":"SUCCESS: Attempted to run the scheduled task \"\\Clover S7\\app-c04e1803\"."},"daemonParent":2652}
- **second daemon on the same home**: {"exitCode":0,"ms":80,"said":"2026-11-05T03:58:41.701Z [core 7092] another daemon holds this home (CreateFileW: error 32 (sharing violation: another daemon holds it)); exiting","firstStillServing":true}
- **app crash**: {"killed":8408,"kill":{"ok":true,"how":"taskkill /F /T /PID 8408","code":0,"out":"SUCCESS: The process with PID 7108 (child process of PID 8408) has been terminated.\r\nSUCCESS: The process with PID 7780 (child process of PID 8408) has been ter"},"restartedMs":1213,"newPid":1072,"startedBy":"daemon","safeMode":false,"how":"schtasks /Run /TN \\Clover S7\\app-c04e1803","eventsSinceKill":["start","tray","connected"]}
- **app crash loop → safe mode**: {"rounds":[{"killed":1072,"restartedMs":2213,"safeMode":false,"crashesInDaemon":2},{"killed":4124,"restartedMs":4195,"safeMode":true,"crashesInDaemon":3}],"thirdRestartInSafeMode":true}
- **daemon crash, restarted by the OS alone**: {"killed":876,"kill":{"ok":true,"how":"taskkill /F /PID 876","code":0,"out":"SUCCESS: The process with PID 876 has been terminated."},"appSurvived":true,"appPidAfter":2972,"samePid":true,"appStartedTheDaemon":{"atMs":150211,"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-c04e1803"},"appEvents":["58ms daemon-lost","150211ms start-daemon","150715ms connected","150715ms reconnected"]}
- **daemon crash, the app helps after 3 s**: {"killed":7324,"kill":{"ok":true,"how":"taskkill /F /PID 7324","code":0,"out":"SUCCESS: The process with PID 7324 has been terminated."},"daemonBackMs":3290,"newDaemonPid":3412,"appSurvived":true,"appPidAfter":2972,"samePid":true,"appStartedTheDaemon":{"atMs":3125,"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-c04e1803"},"appEvents":["93ms daemon-lost","3125ms start-daemon","3640ms connected","3640ms reconnected"]}
- **tray Quit stops both, and they stay down**: {"forwarded":{"forwarded":true},"bothDownMs":340,"restartedWithin12s":false,"appEvents":["quit","quit-acked"]}
- **a user starts the app → it starts the daemon**: {"start":{"ok":true,"how":"spawn detached","code":0,"out":"1916"},"bothUpMs":525,"startedBy":"user","appStartedTheDaemon":[{"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-c04e1803","out":"SUCCESS: Attempted to run the scheduled task \"\\Clover S7\\core-c04e1803\"."}],"appEvents":["start","tray","start-daemon","connected"]}
- **the daemon side's Quit stops both**: {"bothDownMs":323,"restartedWithin8s":false}

**Assertions:** PASS the login item starts the daemon, and the daemon the app; PASS a second daemon is refused and exits 0; PASS a crashed app is back within 6 s; PASS the start after the third crash in two minutes is in safe mode; PASS Task Scheduler alone does not restart a killed task (the finding the supervisor answers); PASS a crashed daemon is back within 10 s, and the app lives on; PASS the tray's Quit stops both, and nothing restarts them; PASS a user's start of the app brings up both within 10 s; PASS the daemon side's Quit stops both, and nothing restarts them

