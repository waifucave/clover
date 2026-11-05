## Spike S7 results

### Chrome for Testing · linux-arm64 (cft-linux-arm64-install.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 5 s

**chrome-headless-shell** — ; sandbox –

- install: 121 MiB archive, 277 MiB unpacked, 287 files, 0 symlinks; download 767 ms, unpack 992 ms; sha256 `5bb6a00a4285c13303d3f72c5afdb70f144ea7a93eed462365a52b69631c9607` (matches the pin; server MD5 true)

**chrome** — ; sandbox –

- install: 191 MiB archive, 401 MiB unpacked, 301 files, 0 symlinks; download 1052 ms, unpack 1392 ms; sha256 `1f496a826c9ba4d6a5f5bf2de686145fe718528c2cc3dbeb96b5893b89653724` (matches the pin; server MD5 true)

**Assertions:** PASS the headless shell installs from its pin

### Chrome for Testing · linux-arm64 (cft-linux-arm64-worker.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 204 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 121 MiB archive, 277 MiB unpacked, 287 files, 0 symlinks; download 767 ms, unpack 992 ms; sha256 `5bb6a00a4285c13303d3f72c5afdb70f144ea7a93eed462365a52b69631c9607` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 61 ms, warm 52 ms; the port for comparison 60 ms
- start attempts: fdpipe ok 61 ms
- tabs: own window: first (background): visible, 1280x800, interval 100.1 Hz, rAF 60.1 Hz; own window: second (front): visible, 1280x800, interval 99.9 Hz, rAF 60.0 Hz; one window: first (background): visible, 1280x800, interval 100.0 Hz, rAF 60.0 Hz; one window: second (front): visible, 1280x800, interval 100.1 Hz, rAF 60.2 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.2 Hz, rAF 60.0 Hz, media ×0.94, decoded 28.8 fps, audio running, set up in 42 ms, browser answers in 1 ms
- resize to 1000×700 and back: 2 ms / 23 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 216 / 230 ms (643 KiB, CPU 343 ms), jpeg 80 / 82 ms (163 KiB, stale -48 / -41 ms, CPU 145 ms)
- screencast: 60.3 fps, 66701 kbit/s, 135 KiB/frame, latency 33 / 34 ms, browser CPU 151%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 230 MiB, per idle tab 29 MiB, 4 browser contexts +118 MiB, a second bot's browser 106 MiB (7 processes), animated tab 53.8% CPU
  - steps: 0 tabs 230 MiB pss / 0.0%, 1 tabs 269 MiB pss / 3.0%, 2 tabs 299 MiB pss / 6.5%, 4 tabs 354 MiB pss / 13.7%, 8 tabs 464 MiB pss / 26.3%

**chrome** — Chrome/156.0.8078.80; sandbox on

- install: 191 MiB archive, 401 MiB unpacked, 301 files, 0 symlinks; download 1052 ms, unpack 1392 ms; sha256 `1f496a826c9ba4d6a5f5bf2de686145fe718528c2cc3dbeb96b5893b89653724` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 230 ms, warm 226 ms; the port for comparison 261 ms
- start attempts: fdpipe ok 230 ms
- tabs: own window: first (background): visible, 1280x657, interval 99.9 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x657, interval 100.0 Hz, rAF 60.0 Hz; one window: first (background): hidden, 1280x657, interval 1.0 Hz, rAF 0.0 Hz; one window: second (front): visible, 1280x657, interval 99.9 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.0 Hz, media ×0.95, decoded 28.8 fps, audio running, set up in 88 ms, browser answers in 0 ms
- resize to 1000×700 and back: 3 ms / 5 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 207 / 216 ms (531 KiB, CPU 320 ms), jpeg 87 / 90 ms (144 KiB, stale -39 / -36 ms, CPU 153 ms)
- screencast: 60.4 fps, 58057 kbit/s, 117 KiB/frame, latency 48 / 49 ms, browser CPU 139%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 423 MiB, per idle tab 58 MiB, 4 browser contexts +333 MiB, a second bot's browser 266 MiB (10 processes), animated tab 59.5% CPU
  - steps: 0 tabs 423 MiB pss / 1.0%, 1 tabs 503 MiB pss / 3.5%, 2 tabs 581 MiB pss / 7.0%, 4 tabs 657 MiB pss / 14.9%, 8 tabs 884 MiB pss / 28.2%

**Assertions:** PASS the headless shell installs from its pin; PASS it starts over the native DevTools pipe; PASS it runs sandboxed; PASS no step failed; PASS every tab is visible and draws (rAF above 10 Hz); PASS screenshots and a screencast arrive, fresh; PASS per-bot profiles are apart and survive a restart

### Chrome for Testing · linux-arm64 (cft-linux-arm64.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 207 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 121 MiB archive, 277 MiB unpacked, 287 files, 0 symlinks; download 767 ms, unpack 992 ms; sha256 `5bb6a00a4285c13303d3f72c5afdb70f144ea7a93eed462365a52b69631c9607` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 1450 ms, warm 51 ms; the port for comparison 64 ms
- start attempts: fdpipe ok 1450 ms
- tabs: own window: first (background): visible, 1280x800, interval 100.2 Hz, rAF 60.2 Hz; own window: second (front): visible, 1280x800, interval 100.0 Hz, rAF 60.0 Hz; one window: first (background): visible, 1280x800, interval 99.9 Hz, rAF 60.0 Hz; one window: second (front): visible, 1280x800, interval 100.1 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.2 Hz, media ×0.90, decoded 29.0 fps, audio running, set up in 134 ms, browser answers in 0 ms
- resize to 1000×700 and back: 3 ms / 22 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 217 / 230 ms (648 KiB, CPU 341 ms), jpeg 70 / 83 ms (147 KiB, stale -39 / -34 ms, CPU 139 ms)
- screencast: 60.3 fps, 65903 kbit/s, 134 KiB/frame, latency 32 / 36 ms, browser CPU 151%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 175 MiB, per idle tab 30 MiB, 4 browser contexts +119 MiB, a second bot's browser 113 MiB (7 processes), animated tab 54.0% CPU
  - steps: 0 tabs 175 MiB pss / 0.0%, 1 tabs 217 MiB pss / 3.2%, 2 tabs 247 MiB pss / 7.0%, 4 tabs 302 MiB pss / 13.7%, 8 tabs 412 MiB pss / 26.3%

**chrome** — Chrome/156.0.8078.80; sandbox on

- install: 191 MiB archive, 401 MiB unpacked, 301 files, 0 symlinks; download 1052 ms, unpack 1392 ms; sha256 `1f496a826c9ba4d6a5f5bf2de686145fe718528c2cc3dbeb96b5893b89653724` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 448 ms, warm 212 ms; the port for comparison 262 ms
- start attempts: fdpipe ok 448 ms
- tabs: own window: first (background): visible, 1280x657, interval 99.9 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x657, interval 100.0 Hz, rAF 60.0 Hz; one window: first (background): hidden, 1280x657, interval 1.0 Hz, rAF 0.0 Hz; one window: second (front): visible, 1280x657, interval 100.1 Hz, rAF 60.2 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.2 Hz, rAF 60.0 Hz, media ×0.95, decoded 28.8 fps, audio running, set up in 90 ms, browser answers in 0 ms
- resize to 1000×700 and back: 3 ms / 23 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 188 / 202 ms (522 KiB, CPU 308 ms), jpeg 72 / 85 ms (145 KiB, stale -40 / -35 ms, CPU 143 ms)
- screencast: 60.3 fps, 58063 kbit/s, 118 KiB/frame, latency 32 / 33 ms, browser CPU 140%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 449 MiB, per idle tab 55 MiB, 4 browser contexts +333 MiB, a second bot's browser 289 MiB (12 processes), animated tab 60.1% CPU
  - steps: 0 tabs 449 MiB pss / 1.5%, 1 tabs 526 MiB pss / 4.2%, 2 tabs 605 MiB pss / 7.2%, 4 tabs 683 MiB pss / 14.6%, 8 tabs 885 MiB pss / 29.9%

**Assertions:** PASS the headless shell installs from its pin; PASS it starts over the native DevTools pipe; PASS it runs sandboxed; PASS no step failed; PASS every tab is visible and draws (rAF above 10 Hz); PASS screenshots and a screencast arrive, fresh; PASS per-bot profiles are apart and survive a restart

### Chrome for Testing · linux-x64 (cft-linux-x64-install.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 4 s

**chrome-headless-shell** — ; sandbox –

- install: 121 MiB archive, 274 MiB unpacked, 287 files, 0 symlinks; download 874 ms, unpack 946 ms; sha256 `547dcd374e02961bf998f6046a267644f8502225c36bb78ca307dab32a0b3eb4` (matches the pin; server MD5 true)

**chrome** — ; sandbox –

- install: 192 MiB archive, 403 MiB unpacked, 301 files, 0 symlinks; download 861 ms, unpack 1227 ms; sha256 `b711c720f774be355197f32edf37e0651418ba036d92446ee2da19ac017540a7` (matches the pin; server MD5 true)

**Assertions:** PASS the headless shell installs from its pin

### Chrome for Testing · linux-x64 (cft-linux-x64-worker.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 202 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 121 MiB archive, 274 MiB unpacked, 287 files, 0 symlinks; download 874 ms, unpack 946 ms; sha256 `547dcd374e02961bf998f6046a267644f8502225c36bb78ca307dab32a0b3eb4` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 56 ms, warm 57 ms; the port for comparison 59 ms
- start attempts: fdpipe ok 56 ms
- tabs: own window: first (background): visible, 1280x800, interval 100.2 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x800, interval 100.0 Hz, rAF 60.0 Hz; one window: first (background): visible, 1280x800, interval 100.0 Hz, rAF 60.0 Hz; one window: second (front): visible, 1280x800, interval 100.0 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.0 Hz, media ×0.94, decoded 28.8 fps, audio running, set up in 35 ms, browser answers in 0 ms
- resize to 1000×700 and back: 2 ms / 21 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 194 / 202 ms (634 KiB, CPU 211 ms), jpeg 55 / 65 ms (164 KiB, stale -39 / -36 ms, CPU 55 ms)
- screencast: 60.4 fps, 67015 kbit/s, 135 KiB/frame, latency 14 / 18 ms, browser CPU 99%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 172 MiB, per idle tab 29 MiB, 4 browser contexts +117 MiB, a second bot's browser 114 MiB (7 processes), animated tab 18.4% CPU
  - steps: 0 tabs 172 MiB pss / 0.0%, 1 tabs 213 MiB pss / 2.5%, 2 tabs 243 MiB pss / 4.7%, 4 tabs 298 MiB pss / 8.7%, 8 tabs 407 MiB pss / 16.6%

**chrome** — Chrome/156.0.8078.80; sandbox on

- install: 192 MiB archive, 403 MiB unpacked, 301 files, 0 symlinks; download 861 ms, unpack 1227 ms; sha256 `b711c720f774be355197f32edf37e0651418ba036d92446ee2da19ac017540a7` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 212 ms, warm 199 ms; the port for comparison 216 ms
- start attempts: fdpipe ok 212 ms
- tabs: own window: first (background): visible, 1280x657, interval 99.9 Hz, rAF 60.2 Hz; own window: second (front): visible, 1280x657, interval 99.9 Hz, rAF 60.2 Hz; one window: first (background): hidden, 1280x657, interval 1.8 Hz, rAF 0.0 Hz; one window: second (front): visible, 1280x657, interval 100.0 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.0 Hz, media ×0.94, decoded 29.0 fps, audio running, set up in 62 ms, browser answers in 1 ms
- resize to 1000×700 and back: 1 ms / 21 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 187 / 198 ms (523 KiB, CPU 220 ms), jpeg 77 / 79 ms (144 KiB, stale -48 / -45 ms, CPU 75 ms)
- screencast: 60.6 fps, 58387 kbit/s, 118 KiB/frame, latency 28 / 29 ms, browser CPU 94%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 413 MiB, per idle tab 59 MiB, 4 browser contexts +379 MiB, a second bot's browser 258 MiB (10 processes), animated tab 17.1% CPU
  - steps: 0 tabs 413 MiB pss / 1.0%, 1 tabs 493 MiB pss / 2.0%, 2 tabs 549 MiB pss / 4.2%, 4 tabs 648 MiB pss / 5.7%, 8 tabs 881 MiB pss / 11.1%

**Assertions:** PASS the headless shell installs from its pin; PASS it starts over the native DevTools pipe; PASS it runs sandboxed; PASS no step failed; PASS every tab is visible and draws (rAF above 10 Hz); PASS screenshots and a screencast arrive, fresh; PASS per-bot profiles are apart and survive a restart

### Chrome for Testing · linux-x64 (cft-linux-x64.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 203 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 121 MiB archive, 274 MiB unpacked, 287 files, 0 symlinks; download 874 ms, unpack 946 ms; sha256 `547dcd374e02961bf998f6046a267644f8502225c36bb78ca307dab32a0b3eb4` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 147 ms, warm 53 ms; the port for comparison 52 ms
- start attempts: fdpipe ok 147 ms
- tabs: own window: first (background): visible, 1280x800, interval 100.2 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x800, interval 100.0 Hz, rAF 60.0 Hz; one window: first (background): visible, 1280x800, interval 100.0 Hz, rAF 60.0 Hz; one window: second (front): visible, 1280x800, interval 100.0 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.2 Hz, rAF 60.0 Hz, media ×0.94, decoded 29.0 fps, audio running, set up in 35 ms, browser answers in 0 ms
- resize to 1000×700 and back: 2 ms / 24 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 211 / 235 ms (641 KiB, CPU 219 ms), jpeg 70 / 80 ms (165 KiB, stale -40 / -39 ms, CPU 60 ms)
- screencast: 60.4 fps, 66898 kbit/s, 135 KiB/frame, latency 28 / 30 ms, browser CPU 98%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 172 MiB, per idle tab 29 MiB, 4 browser contexts +117 MiB, a second bot's browser 114 MiB (7 processes), animated tab 14.9% CPU
  - steps: 0 tabs 172 MiB pss / 0.0%, 1 tabs 213 MiB pss / 1.3%, 2 tabs 242 MiB pss / 3.0%, 4 tabs 297 MiB pss / 8.2%, 8 tabs 407 MiB pss / 11.4%

**chrome** — Chrome/156.0.8078.80; sandbox on

- install: 192 MiB archive, 403 MiB unpacked, 301 files, 0 symlinks; download 861 ms, unpack 1227 ms; sha256 `b711c720f774be355197f32edf37e0651418ba036d92446ee2da19ac017540a7` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 327 ms, warm 282 ms; the port for comparison 205 ms
- start attempts: fdpipe ok 327 ms
- tabs: own window: first (background): visible, 1280x657, interval 100.0 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x657, interval 100.0 Hz, rAF 60.0 Hz; one window: first (background): hidden, 1280x657, interval 1.0 Hz, rAF 0.0 Hz; one window: second (front): visible, 1280x657, interval 100.0 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.2 Hz, rAF 60.0 Hz, media ×0.95, decoded 28.8 fps, audio running, set up in 68 ms, browser answers in 0 ms
- resize to 1000×700 and back: 2 ms / 22 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 176 / 187 ms (528 KiB, CPU 185 ms), jpeg 77 / 80 ms (143 KiB, stale -49 / -35 ms, CPU 59 ms)
- screencast: 60.8 fps, 58501 kbit/s, 118 KiB/frame, latency 28 / 29 ms, browser CPU 89%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 437 MiB, per idle tab 56 MiB, 4 browser contexts +376 MiB, a second bot's browser 288 MiB (12 processes), animated tab 22.5% CPU
  - steps: 0 tabs 437 MiB pss / 0.7%, 1 tabs 516 MiB pss / 1.7%, 2 tabs 573 MiB pss / 4.5%, 4 tabs 672 MiB pss / 5.9%, 8 tabs 885 MiB pss / 12.3%

**Assertions:** PASS the headless shell installs from its pin; PASS it starts over the native DevTools pipe; PASS it runs sandboxed; PASS no step failed; PASS every tab is visible and draws (rAF above 10 Hz); PASS screenshots and a screencast arrive, fresh; PASS per-bot profiles are apart and survive a restart

### Chrome for Testing · darwin-arm64 (cft-macos-install.json)

25.6.0, 3 CPUs, 7 GiB, Bun 1.3.14, status **done**, 8 s

**chrome-headless-shell** — ; sandbox –

- install: 99 MiB archive, 204 MiB unpacked, 16 files, 0 symlinks; download 1204 ms, unpack 1662 ms; sha256 `ea615baa2e9caf0d02d1898a6562b5f8fa9c35239707dae0f592178df5b986ac` (matches the pin; server MD5 true)

**chrome** — ; sandbox –

- install: 186 MiB archive, 366 MiB unpacked, 344 files, 5 symlinks; download 1728 ms, unpack 2681 ms; sha256 `8bc590d1b1acac042a000234c768f31830f25a3983a83ed5e067114c87c4cad1` (matches the pin; server MD5 true)

**Assertions:** PASS the headless shell installs from its pin

### Chrome for Testing · darwin-arm64 (cft-macos.json)

25.6.0, 3 CPUs, 7 GiB, Bun 1.3.14, status **done**, 254 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 99 MiB archive, 204 MiB unpacked, 16 files, 0 symlinks; download 1204 ms, unpack 1662 ms; sha256 `ea615baa2e9caf0d02d1898a6562b5f8fa9c35239707dae0f592178df5b986ac` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 393 ms, warm 130 ms; the port for comparison 140 ms
- start attempts: fdpipe ok 393 ms
- tabs: own window: first (background): visible, 1280x800, interval 70.7 Hz, rAF 48.8 Hz; own window: second (front): visible, 1280x800, interval 72.9 Hz, rAF 49.5 Hz; one window: first (background): visible, 1280x800, interval 70.1 Hz, rAF 47.3 Hz; one window: second (front): visible, 1280x800, interval 69.0 Hz, rAF 42.7 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 63.4 Hz, rAF 25.6 Hz, media ×0.93, decoded 29.4 fps, audio running, set up in 447 ms, browser answers in 0 ms
- resize to 1000×700 and back: 4 ms / 45 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 292 / 342 ms (627 KiB, CPU 274 ms), jpeg 171 / 205 ms (132 KiB, stale -97 / -63 ms, CPU 75 ms)
- screencast: 33.5 fps, 32136 kbit/s, 117 KiB/frame, latency 66 / 100 ms, browser CPU 65%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 44 MiB, per idle tab 46 MiB, 4 browser contexts +179 MiB, a second bot's browser 44 MiB (4 processes), animated tab 30.9% CPU
  - steps: 0 tabs 44 MiB footprint / 1.5%, 1 tabs 90 MiB footprint / 4.2%, 2 tabs 136 MiB footprint / 8.1%, 4 tabs 227 MiB footprint / 16.5%, 8 tabs 409 MiB footprint / 29.0%

**chrome** — Chrome/156.0.8078.80; sandbox on

- install: 186 MiB archive, 366 MiB unpacked, 344 files, 5 symlinks; download 1728 ms, unpack 2681 ms; sha256 `8bc590d1b1acac042a000234c768f31830f25a3983a83ed5e067114c87c4cad1` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 4001 ms, warm 1589 ms; the port for comparison 1819 ms
- start attempts: fdpipe ok 4001 ms
- tabs: own window: first (background): visible, 1280x657, interval 59.5 Hz, rAF 23.4 Hz; own window: second (front): hidden, 1280x657, interval 1.0 Hz, rAF 0.0 Hz; one window: first (background): hidden, 1280x657, interval 1.0 Hz, rAF 0.0 Hz; one window: second (front): visible, 1280x657, interval 62.1 Hz, rAF 31.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 35.7 Hz, rAF 13.2 Hz, media ×0.95, decoded 28.5 fps, audio running, set up in 497 ms, browser answers in 1 ms
- resize to 1000×700 and back: 10 ms / 73 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 307 / 460 ms (467 KiB, CPU 239 ms), jpeg 183 / 259 ms (115 KiB, stale -86 / -25 ms, CPU 75 ms)
- screencast: 27.8 fps, 23227 kbit/s, 102 KiB/frame, latency 74 / 135 ms, browser CPU 44%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 265 MiB, per idle tab 53 MiB, 4 browser contexts +421 MiB, a second bot's browser 256 MiB (9 processes), animated tab 15.4% CPU
  - steps: 0 tabs 265 MiB footprint / 6.9%, 1 tabs 366 MiB footprint / 7.7%, 2 tabs 421 MiB footprint / 4.7%, 4 tabs 478 MiB footprint / 9.6%, 8 tabs 687 MiB footprint / 4.4%

**Assertions:** PASS the headless shell installs from its pin; PASS it starts over the native DevTools pipe; PASS it runs sandboxed; PASS no step failed; PASS every tab is visible and draws (rAF above 10 Hz); PASS screenshots and a screencast arrive, fresh; PASS per-bot profiles are apart and survive a restart

### Chrome for Testing · win32-x64 (cft-windows-install.json)

10.0.26100, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 6 s

**chrome-headless-shell** — ; sandbox –

- install: 120 MiB archive, 282 MiB unpacked, 288 files, 0 symlinks; download 889 ms, unpack 1369 ms; sha256 `10a77466005e7f64e00f1a75fd1ea81f4a38a60093c65fea6895843b26e60a9a` (matches the pin; server MD5 true)

**chrome** — ; sandbox –

- install: 199 MiB archive, 439 MiB unpacked, 305 files, 0 symlinks; download 1310 ms, unpack 2143 ms; sha256 `16edb57d6107bf1c48a7c149b8d78b155fe614410093796dd72441fd6640540f` (matches the pin; server MD5 true)

**Assertions:** PASS the headless shell installs from its pin

### Chrome for Testing · win32-x64 (cft-windows.json)

10.0.26100, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 243 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 120 MiB archive, 282 MiB unpacked, 288 files, 0 symlinks; download 889 ms, unpack 1369 ms; sha256 `10a77466005e7f64e00f1a75fd1ea81f4a38a60093c65fea6895843b26e60a9a` (matches the pin; server MD5 true)
- start: over **winpipe**, cold 150 ms, warm 114 ms; the port for comparison 148 ms
- start attempts: winpipe ok 150 ms
- tabs: own window: first (background): visible, 1280x800, interval 100.0 Hz, rAF 59.9 Hz; own window: second (front): visible, 1280x800, interval 100.0 Hz, rAF 60.1 Hz; one window: first (background): visible, 1280x800, interval 100.0 Hz, rAF 60.1 Hz; one window: second (front): visible, 1280x800, interval 100.0 Hz, rAF 60.1 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 99.9 Hz, rAF 60.1 Hz, media ×0.99, decoded 29.2 fps, audio running, set up in 68 ms, browser answers in 4 ms
- resize to 1000×700 and back: 10 ms / 10 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 268 / 295 ms (544 KiB, CPU 488 ms), jpeg 86 / 94 ms (152 KiB, stale -46 / -35 ms, CPU 199 ms)
- screencast: 57.4 fps, 53765 kbit/s, 114 KiB/frame, latency 43 / 49 ms, browser CPU 180%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 68 MiB, per idle tab 30 MiB, 4 browser contexts +120 MiB, a second bot's browser 69 MiB (5 processes), animated tab 66.6% CPU
  - steps: 0 tabs 68 MiB privateBytes / 0.0%, 1 tabs 99 MiB privateBytes / 3.1%, 2 tabs 129 MiB privateBytes / 6.6%, 4 tabs 187 MiB privateBytes / 15.5%, 8 tabs 309 MiB privateBytes / 16.5%

**chrome** — Chrome/156.0.8078.80; sandbox on

- install: 199 MiB archive, 439 MiB unpacked, 305 files, 0 symlinks; download 1310 ms, unpack 2143 ms; sha256 `16edb57d6107bf1c48a7c149b8d78b155fe614410093796dd72441fd6640540f` (matches the pin; server MD5 true)
- start: over **winpipe**, cold 825 ms, warm 503 ms; the port for comparison 437 ms
- start attempts: winpipe ok 825 ms
- tabs: own window: first (background): visible, 1264x649, interval 99.8 Hz, rAF 59.9 Hz; own window: second (front): visible, 1264x649, interval 100.1 Hz, rAF 59.9 Hz; one window: first (background): hidden, 1264x649, interval 2.0 Hz, rAF 0.0 Hz; one window: second (front): visible, 1264x649, interval 99.9 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 99.9 Hz, rAF 59.9 Hz, media ×0.99, decoded 29.2 fps, audio running, set up in 65 ms, browser answers in 4 ms
- resize to 1000×700 and back: 20 ms / 15 ms, same document true (1264 → 1000 → 1264)
- screenshots: png 241 / 256 ms (451 KiB, CPU 451 ms), jpeg 79 / 89 ms (105 KiB, stale -46 / -34 ms, CPU 188 ms)
- screencast: 60.5 fps, 47442 kbit/s, 96 KiB/frame, latency 35 / 42 ms, browser CPU 130%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 263 MiB, per idle tab 51 MiB, 4 browser contexts +486 MiB, a second bot's browser 260 MiB (11 processes), animated tab 53.7% CPU
  - steps: 0 tabs 263 MiB privateBytes / 14.9%, 1 tabs 341 MiB privateBytes / 4.8%, 2 tabs 399 MiB privateBytes / 11.4%, 4 tabs 429 MiB privateBytes / 37.2%, 8 tabs 669 MiB privateBytes / 45.8%

**Assertions:** PASS the headless shell installs from its pin; PASS it starts over the native DevTools pipe; PASS it runs sandboxed; PASS no step failed; PASS every tab is visible and draws (rAF above 10 Hz); PASS screenshots and a screencast arrive, fresh; PASS per-bot profiles are apart and survive a restart

### Electron · linux-arm64-ozone-headless (electron-linux-arm64-ozone-headless.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-arm64 7.0.0-1017-azure, ozone headless, displays 1920x1080@1, status **done**, 573 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.93 | 28.3 | 43 / 86 | 1 / 6 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.95 | 28.4 | 28 / 41 | 4 / 6 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.4 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.96 | 28.4 | 27 / 39 | 3 / 16 | 1280x800@1 → 1000x700@1 → 1280x800 | 1 / 1 | 2.4 |  |
| invisibleWindow | true | true | true | true (1) | 0.96 | 28.6 | 29 / 41 | 1 / 4 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.0 |  |
| tinyWindow | true | true | true | true (1) | 0.96 | 28.6 | 28 / 41 | 3 / 16 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.0 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | IO / RO Hz | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 100.1 | 99.1 | 60.1 | 17 | 2.2 / 2.2 | – | – | – | 5.0 | 6.8 |  |
| detached, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.2 |  |
| detached, throttling off | visible | 1280x800 | 100.1 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 1.0 | 1.0 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.0 |  |
| never-shown window, throttling off | visible | 1280x800 | 100.1 | 99.3 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.8 | 1.0 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 100.1 | 99.3 | 1.0 | 1017 | 0.0 / 0.0 | – | – | – | 1.2 | 1.6 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 100.1 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 1.0 | 1.2 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 100.2 | 99.2 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 1.2 | 1.4 |  |
| invisible shown window, throttling off | visible | 1280x800 | 100.0 | 99.4 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 5.0 | 6.8 |  |
| 1x1 shown window, throttling off | visible | 1280x800 | 100.1 | 99.1 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 4.6 | 6.0 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 100.0 | 99.2 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 4.8 | 6.2 | cover 0,0 1920x1080 over host 0,0 1x1 |
| 1x1 shown window kept above a cover window (always on top) | visible | 1280x800 | 99.9 | 99.1 | 60.1 | 17 | 2.2 / 2.2 | – | – | – | 5.4 | 7.2 | cover 0,0 1920x1080 over host 0,0 1x1 |
| invisible shown window, covered by another window | visible | 1280x800 | 99.9 | 99.1 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 5.2 | 7.4 | cover -1480,-1000 1920x1080 over host -1480,-1000 1280x800 |
| 1x1 shown window, throttling on (control) | visible | 1280x800 | 99.9 | 99.1 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 5.6 | 7.4 |  |
| 1x1 shown window, throttling on, covered by another window (control) | visible | 1280x800 | 100.0 | 99.4 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 5.4 | 7.2 | cover 0,0 1920x1080 over host 0,0 1x1 |
| invisible shown window, throttling on, covered by another window (control) | visible | 1280x800 | 99.9 | 99.1 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 5.0 | 7.2 | cover -1480,-1000 1920x1080 over host -1480,-1000 1280x800 |
| osr window 30 fps, throttling off | visible | 1280x800 | 100.1 | 99.1 | 30.0 | 34 | 2.0 / 2.0 | – | – | – | 3.4 | 12.0 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 100.1 | 99.1 | 30.0 | 34 | 0.0 / 2.2 | – | – | – | 2.2 | 2.6 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 100.1 | 99.3 | 0.0 | 0 | 0.0 / 0.0 | 0.89 | 26.0 | – | 2.2 | 2.8 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 25.8 | – | 2.6 | 3.2 |  |
| detached, throttling off, playing media | visible | 1280x800 | 99.9 | 99.3 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 25.8 | – | 2.4 | 2.8 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 100.1 | 99.3 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | to 1280×800 + JPEG ms | CPU ms/picture | frames/s | visibility events | geometry; errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 17 / 18 | -8 / -2 | 1000x700 | 14 / 15 | 77 | – |  | view 0,0 1000x700 in content 40,65 1000x700; page 1000x700 at 1x |
| shown | true | capturePage | 6/6 | 6 | 18 / 18 | -9 / -6 | 1000x700 | 14 / 15 | 80 | – |  | view 0,0 1000x700 in content 40,65 1000x700; page 1000x700 at 1x |
| shown | true | cdpJpeg | 6/6 | 6 | 64 / 68 | -46 / -41 | 1000x700 | – | 87 | – |  | view 0,0 1000x700 in content 40,65 1000x700; page 1000x700 at 1x |
| shown | true | frameSub | 6/6 | 6 | 15 / 22 | -3 / -2 | 1000x700 | – | 52 | – |  | view 0,0 1000x700 in content 40,65 1000x700; page 1000x700 at 1x |
| shown | true | cdpPng | 6/6 | 6 | 157 / 161 | -42 / -34 | 1000x700 | – | 215 | – |  | view 0,0 1000x700 in content 40,65 1000x700; page 1000x700 at 1x |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 65 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | – | 45 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 4046 / 4048 | -2995 / -40 | 1280x800 | – | 130 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x |
| hiddenWindow | false | frameSub | 6/6 | 6 | 7 / 8 | 61 / 74 | 1280x800 | – | 45 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.5 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | – | 3 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 98 / 100 | -62 / -32 | 1280x800 | – | 142 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 15 / 16 | 9 / 9 | 1280x800 | – | 77 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 6/6 | 6 | 14 / 15 | 9 / 11 | 1280x800 | – | 73 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | capturePage | 6/6 | 6 | 14 / 17 | 9 / 12 | 1280x800 | – | 77 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 81 / 84 | -43 / -37 | 1280x800 | – | 140 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | frameSub | 6/6 | 6 | 14 / 17 | 13 / 16 | 1280x800 | – | 77 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 14 / 17 | 10 / 13 | 1280x800 | – | 65 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | capturePage | 6/6 | 6 | 15 / 17 | 10 / 15 | 1280x800 | – | 60 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 81 / 86 | -44 / -36 | 1280x800 | – | 105 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | frameSub | 6/6 | 6 | 15 / 19 | 11 / 12 | 1280x800 | – | 58 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 14 / 16 | 11 / 13 | 1280x800 | – | 62 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 14 / 15 | 10 / 13 | 1280x800 | – | 65 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 80 / 84 | -43 / -39 | 1280x800 | – | 110 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 15 / 17 | 11 / 12 | 1280x800 | – | 60 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePageHidden | 6/6 | 6 | 14 / 15 | 9 / 15 | 1280x800 | – | 60 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | capturePage | 6/6 | 6 | 14 / 16 | 9 / 11 | 1280x800 | – | 62 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | cdpJpeg | 6/6 | 6 | 81 / 84 | -43 / -38 | 1280x800 | – | 105 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | frameSub | 6/6 | 6 | 15 / 17 | 11 / 12 | 1280x800 | – | 62 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 1 | 13 / 18 | 1280x800 | – | 35 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | capturePage | 6/6 | 6 | 30 / 32 | -17 / -11 | 1280x800 | – | 60 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | cdpJpeg | 6/6 | 6 | 98 / 110 | -73 / -71 | 1280x800 | – | 92 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | – | 170 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | – | 3 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 130 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 240 | pss | 511 | 4 | 0.0 |
| 1 | 269 | pss | 628 | 5 | 0.3 |
| 2 | 285 | pss | 746 | 6 | 0.3 |
| 4 | 315 | pss | 983 | 8 | 0.8 |
| 8 | 372 | pss | 1420 | 12 | 0.5 |

Per idle tab resting in the never-shown window (a still page): **16 MiB**, 0.06% CPU. Four tabs: one partition +67 MiB, four partitions +73 MiB.

Quiet tabs working in one shared 1×1 host (no rAF loop; the page repaints twice a second): **29 MiB** and 0.91% CPU a tab (0: 265 MiB / 0.0%, 1: 306 MiB / 1.3%, 4: 389 MiB / 3.5%, 8: 494 MiB / 7.2%).

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 35.5 | 28.2 | 7.3 | 60 |
| animated, never-shown window, throttling off | 1.0 | 1.0 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.3 | 0.0 | 0.0 | 0 |
| animated, never-shown window, throttling off + frame pump | 1.3 | 1.0 | 0.0 | 0 |
| animated, invisible shown window | 48.0 | 37.7 | 10.3 | 60 |
| animated, 1x1 shown window | 38.2 | 37.0 | 1.3 | 60 |
| animated, osr 30 fps | 32.5 | 20.0 | 5.5 | 30 |

**Waking a resting tab into the host** (never-shown window, throttling on, 4 cycles): first rAF 1 / 2 ms, fresh picture 14 / 34 ms; resting rates 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0; awake rAF 60, 61, 60, 60

**One host, 4 tabs (each held at 1280×800, 1×):** tab 1 rAF 60 Hz, capturePage 4/4 in 15 / 16 ms (1280x800); tab 2 rAF 60 Hz, capturePage 4/4 in 14 / 15 ms (1280x800); tab 3 rAF 60 Hz, capturePage 4/4 in 14 / 18 ms (1280x800); tab 4 rAF 60 Hz, capturePage 4/4 in 14 / 16 ms (1280x800)

**The host's invariants:** host 100,100 1x1, focused at start false, after its page grabs focus false (focused window "S7 browser view"); Windows styles –; click-through not testable here (macOS needs Accessibility for synthetic clicks; Wayland and no display have no global input)

**Assertions:** PASS no reload when moving from detached; PASS no reload when moving from hiddenWindow; PASS no reload when moving from hiddenWindowFit; PASS no reload when moving from invisibleWindow; PASS no reload when moving from tinyWindow; PASS the host (1x1; 32x32 on Windows) draws (rAF above 10 Hz); PASS a never-shown window draws nothing (rAF below 1 Hz); PASS capturePage works in the host; PASS capturePage works in the host with the agent's 1280x800 at 1x held; PASS the host never takes focus, even when its page asks; PASS a resting tab draws within 2 s of moving into the host, every cycle; PASS every tab in one shared host draws and is pictured

### Electron · linux-wayland (electron-linux-wayland.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone wayland, displays 1920x1080@1, status **done**, 837 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.92 | 27.7 | 46 / 421 | 1 / 392 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.92 | 27.4 | 39 / 41 | 1 / 2 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.1 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.92 | 27.4 | 36 / 44 | 0 / 2 | 1280x800@1 → 1000x700@1 → 1280x800 | 0 / 1 | 0.0 |  |
| tinyWindow | true | true | true | true (1) | 0.96 | 28.6 | 34 / 39 | 3 / 15 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 40.7 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | IO / RO Hz | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 100.1 | 99.3 | 39.8 | 26 | 2.0 / 2.0 | – | – | – | 3.6 | 7.4 |  |
| detached, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.2 |  |
| detached, throttling off | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 1.2 | 1.4 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.4 |  |
| never-shown window, throttling off | visible | 1280x800 | 99.9 | 98.9 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 1.2 | 1.6 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 99.9 | 98.9 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 1.6 | 1.8 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 1.2 | 1.4 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 1.2 | 1.2 |  |
| invisible shown window, throttling off | – | – | – | – | – | – | – | – | – | – | – | – | not possible here |
| 1x1 shown window, throttling off | visible | 1280x800 | 100.2 | 99.2 | 40.0 | 26 | 2.2 / 2.2 | – | – | – | 3.8 | 6.6 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 100.2 | 99.4 | 40.0 | 26 | 2.2 / 2.2 | – | – | – | 3.6 | 6.4 | cover -10,-10 1940x1100 over host 0,0 1x1 |
| 1x1 shown window kept above a cover window (always on top) | visible | 1280x800 | 100.0 | 99.4 | 39.8 | 26 | 2.0 / 2.0 | – | – | – | 3.4 | 5.6 | cover -10,-10 1940x1100 over host 0,0 1x1 |
| invisible shown window, covered by another window | – | – | – | – | – | – | – | – | – | – | – | – | not possible here |
| 1x1 shown window, throttling on (control) | visible | 1280x800 | 100.0 | 99.4 | 39.8 | 26 | 2.0 / 2.0 | – | – | – | 3.2 | 5.8 |  |
| 1x1 shown window, throttling on, covered by another window (control) | visible | 1280x800 | 100.0 | 99.4 | 39.8 | 26 | 2.0 / 2.0 | – | – | – | 3.8 | 6.4 | cover -10,-10 1940x1100 over host 0,0 1x1 |
| invisible shown window, throttling on, covered by another window (control) | – | – | – | – | – | – | – | – | – | – | – | – | not possible here |
| osr window 30 fps, throttling off | visible | 1280x800 | 100.0 | 99.2 | 30.0 | 34 | 2.0 / 2.0 | – | – | – | 2.8 | 11.8 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 100.0 | 99.2 | 30.0 | 34 | 0.0 / 2.2 | – | – | – | 1.6 | 2.2 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 25.8 | – | 1.8 | 2.6 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 100.2 | 99.2 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 25.8 | – | 1.8 | 2.2 |  |
| detached, throttling off, playing media | visible | 1280x800 | 99.9 | 99.3 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 25.8 | – | 1.8 | 2.6 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | to 1280×800 + JPEG ms | CPU ms/picture | frames/s | visibility events | geometry; errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 14 / 20 | 43 / 46 | 1000x700 | 14 / 15 | 50 | – |  | view 0,0 1000x700 in content 40,104 1000x700; page 1000x700 at 1x |
| shown | true | capturePage | 6/6 | 6 | 13 / 14 | 43 / 47 | 1000x700 | 13 / 15 | 48 | – |  | view 0,0 1000x700 in content 40,104 1000x700; page 1000x700 at 1x |
| shown | true | cdpJpeg | 6/6 | 6 | 130 / 131 | -63 / -58 | 1000x700 | – | 60 | – |  | view 0,0 1000x700 in content 40,104 1000x700; page 1000x700 at 1x |
| shown | true | frameSub | 6/6 | 6 | 27 / 28 | 33 / 44 | 1000x700 | – | 27 | – |  | view 0,0 1000x700 in content 40,104 1000x700; page 1000x700 at 1x |
| shown | true | cdpPng | 6/6 | 6 | 241 / 256 | -64 / -63 | 1000x700 | – | 175 | – |  | view 0,0 1000x700 in content 40,104 1000x700; page 1000x700 at 1x |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 80 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | – | 45 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 320,185 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 320,185 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 70 | – |  | view 0,0 1280x800 in content 320,185 1280x800; page 1280x800 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| hiddenWindow | false | frameSub | 0/2 | 0 | – | – | - | – | 45 | – |  | view 0,0 1280x800 in content 320,185 1280x800; page 1280x800 at 1x; frame subscription: timed out after 5000 ms |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 320,185 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 320,185 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 80 | – |  | view 0,0 1280x800 in content 320,185 1280x800; page 1280x800 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| hiddenWindow + pump | false | frameSub | 0/2 | 0 | – | – | - | – | 50 | – |  | view 0,0 1280x800 in content 320,185 1280x800; page 1280x800 at 1x; frame subscription: timed out after 5000 ms |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| invisibleWindow | false | - | 0/0 | 0 | – | – | - | – | – | – |  | not possible here |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 22 / 24 | 10 / 25 | 1280x800 | – | 35 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | capturePage | 6/6 | 6 | 23 / 24 | 10 / 11 | 1280x800 | – | 33 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 99 / 110 | -54 / -52 | 1280x800 | – | 55 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | frameSub | 6/6 | 6 | 23 / 24 | 13 / 24 | 1280x800 | – | 33 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 23 / 28 | 35 / 36 | 1280x800 | – | 32 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 23 / 24 | 35 / 37 | 1280x800 | – | 33 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 124 / 146 | -54 / -53 | 1280x800 | – | 60 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 23 / 24 | 38 / 49 | 1280x800 | – | 37 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePageHidden | 6/6 | 6 | 22 / 24 | 35 / 39 | 1280x800 | – | 30 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | capturePage | 6/6 | 6 | 23 / 25 | 34 / 35 | 1280x800 | – | 32 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | cdpJpeg | 6/6 | 6 | 123 / 134 | -54 / -50 | 1280x800 | – | 58 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | frameSub | 6/6 | 6 | 23 / 25 | 38 / 48 | 1280x800 | – | 33 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 42 / 48 | 1280x800 | – | 22 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | capturePage | 6/6 | 6 | 30 / 33 | 11 / 19 | 1280x800 | – | 42 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | cdpJpeg | 6/6 | 6 | 131 / 142 | -77 / -75 | 1280x800 | – | 72 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | – | 140 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 115 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 331 | pss | 602 | 4 | 0.3 |
| 1 | 360 | pss | 708 | 5 | 0.3 |
| 2 | 377 | pss | 818 | 6 | 0.5 |
| 4 | 405 | pss | 1033 | 8 | 0.8 |
| 8 | 459 | pss | 1465 | 12 | 0.0 |

Per idle tab resting in the never-shown window (a still page): **16 MiB**, -0.03% CPU. Four tabs: one partition +66 MiB, four partitions +71 MiB.

Quiet tabs working in one shared 1×1 host (no rAF loop; the page repaints twice a second): **28 MiB** and 0.91% CPU a tab (0: 356 MiB / 0.0%, 1: 397 MiB / 1.0%, 4: 476 MiB / 3.5%, 8: 581 MiB / 7.3%).

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 15.5 | 9.5 | 4.8 | 39 |
| animated, never-shown window, throttling off | 1.8 | 1.3 | 0.5 | 0 |
| animated, never-shown window, throttling on | 0.3 | 0.0 | 0.3 | 0 |
| animated, never-shown window, throttling off + frame pump | 1.3 | 1.3 | 0.0 | 0 |
| animated, 1x1 shown window | 13.0 | 10.5 | 1.5 | 40 |
| animated, osr 30 fps | 19.5 | 8.3 | 3.8 | 30 |

**Waking a resting tab into the host** (never-shown window, throttling on, 4 cycles): first rAF 0 / 2 ms, fresh picture 16 / 37 ms; resting rates 2.0 Hz / rAF 0.0, 2.0 Hz / rAF 0.0, 2.0 Hz / rAF 0.0, 2.0 Hz / rAF 0.0; awake rAF 40, 40, 40, 41

**One host, 4 tabs (each held at 1280×800, 1×):** tab 1 rAF 40 Hz, capturePage 4/4 in 23 / 24 ms (1280x800); tab 2 rAF 40 Hz, capturePage 4/4 in 22 / 24 ms (1280x800); tab 3 rAF 40 Hz, capturePage 4/4 in 23 / 25 ms (1280x800); tab 4 rAF 40 Hz, capturePage 4/4 in 22 / 24 ms (1280x800)

**The host's invariants:** host 100,100 1x1, focused at start false, after its page grabs focus false (focused window "(none)"); Windows styles –; click-through not testable here (macOS needs Accessibility for synthetic clicks; Wayland and no display have no global input)

**Assertions:** PASS no reload when moving from detached; PASS no reload when moving from hiddenWindow; PASS no reload when moving from hiddenWindowFit; PASS no reload when moving from tinyWindow; PASS the host (1x1; 32x32 on Windows) draws (rAF above 10 Hz); PASS a never-shown window draws nothing (rAF below 1 Hz); PASS capturePage works in the host; PASS capturePage works in the host with the agent's 1280x800 at 1x held; PASS the host never takes focus, even when its page asks; PASS a resting tab draws within 2 s of moving into the host, every cycle; PASS every tab in one shared host draws and is pictured

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
| screencast | anim | tinyWindow | 39.9 | 39.9 | 69 / 70 | 26 | 43834 | 137668 | 82 | 21 | 40 |  |
| webcodecs-h264 | anim | tinyWindow | 30.0 | 30.0 | 65 / 67 | 52 | 2366 | 9858 | 67 | 15 | 40 |  |
| screencast | anim | shown | 38.6 | 38.6 | 67 / 68 | 27 | 35372 | 114547 | 66 | 17 | 39 |  |
| webrtc-vp8 | anim | shown | 20.6 | 20.6 | 83 / 88 | 79 | 2505 | 15200 | 73 | 14 | 38 | libvpx; video/VP8 |
| webcodecs-h264 | anim | shown | 30.0 | 30.0 | 72 / 73 | 53 | 2409 | 10037 | 80 | 16 | 39 |  |

### Electron · linux-x11-dsf2 (electron-linux-x11-dsf2.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone x11, displays 960x540@2, status **done**, 289 s

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | to 1280×800 + JPEG ms | CPU ms/picture | frames/s | visibility events | geometry; errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 43 / 48 | 36 / 46 | 2000x1400 | 32 / 37 | 255 | – |  | view 0,0 1000x700 in content 40,67 960x540; page 1000x700 at 2x |
| shown | true | capturePage | 6/6 | 6 | 44 / 49 | 24 / 26 | 2000x1400 | 29 / 35 | 247 | – |  | view 0,0 1000x700 in content 40,67 960x540; page 1000x700 at 2x |
| shown | true | cdpJpeg | 6/6 | 6 | 144 / 157 | -45 / -33 | 2000x1400 | – | 308 | – |  | view 0,0 1000x700 in content 40,67 960x540; page 1000x700 at 2x |
| shown | true | frameSub | 6/6 | 6 | 59 / 61 | 20 / 21 | 2000x1400 | – | 190 | – |  | view 0,0 1000x700 in content 40,67 960x540; page 1000x700 at 2x |
| shown | true | cdpPng | 6/6 | 6 | 463 / 492 | -42 / -36 | 2000x1400 | – | 960 | – |  | view 0,0 1000x700 in content 40,67 960x540; page 1000x700 at 2x |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 28.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 60 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | – | 85 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 0,27 960x540; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 0,27 960x540; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 4041 / 4046 | -2917 / -51 | 2560x1600 | – | 217 | – |  | view 0,0 1280x800 in content 0,27 960x540; page 1280x800 at 2x |
| hiddenWindow | false | frameSub | 6/6 | 6 | 49 / 50 | 57 / 152 | 2560x1600 | – | 128 | – |  | view 0,0 1280x800 in content 0,27 960x540; page 1280x800 at 2x |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content 0,27 960x540; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | – | 3 | – |  | view 0,0 1280x800 in content 0,27 960x540; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 229 / 257 | -93 / -43 | 2560x1600 | – | 590 | – |  | view 0,0 1280x800 in content 0,27 960x540; page 1280x800 at 2x |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 72 / 80 | 31 / 41 | 2560x1600 | – | 233 | – |  | view 0,0 1280x800 in content 0,27 960x540; page 1280x800 at 2x |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 28.5 |  |  |
| invisibleWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content -1480,-1000 960x540; page 1280x800 at 2x; Current display surface not available for capture |
| invisibleWindow | false | capturePage | 0/6 | 0 | – | – | - | – | 3 | – |  | view 0,0 1280x800 in content -1480,-1000 960x540; page 1280x800 at 2x; Current display surface not available for capture |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 174 / 190 | -41 / -25 | 2560x1600 | – | 400 | – |  | view 0,0 1280x800 in content -1480,-1000 960x540; page 1280x800 at 2x |
| invisibleWindow | false | frameSub | 6/6 | 6 | 75 / 78 | 22 / 26 | 2560x1600 | – | 218 | – |  | view 0,0 1280x800 in content -1480,-1000 960x540; page 1280x800 at 2x |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 23.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 55 / 59 | 27 / 31 | 2560x1600 | 33 / 51 | 172 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 2x |
| tinyWindow | false | capturePage | 6/6 | 6 | 55 / 58 | 27 / 33 | 2560x1600 | 32 / 41 | 172 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 2x |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 173 / 179 | -43 / -39 | 2560x1600 | – | 205 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 2x |
| tinyWindow | false | frameSub | 6/6 | 6 | 74 / 77 | 21 / 26 | 2560x1600 | – | 165 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 2x |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 23.5 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 56 / 63 | 11 / 17 | 2560x1600 | 35 / 40 | 168 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 2x |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 53 / 60 | 10 / 13 | 2560x1600 | 34 / 40 | 170 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 2x |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 157 / 162 | -43 / -40 | 2560x1600 | – | 197 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 2x |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 73 / 79 | 6 / 10 | 2560x1600 | – | 163 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 2x |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 24.0 |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePageHidden | 6/6 | 6 | 54 / 65 | 9 / 16 | 2560x1600 | 33 / 41 | 167 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | capturePage | 6/6 | 6 | 57 / 64 | 9 / 14 | 2560x1600 | 35 / 42 | 177 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | cdpJpeg | 6/6 | 6 | 65 / 77 | -38 / -35 | 1280x800 | – | 92 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | frameSub | 6/6 | 6 | 73 / 77 | -10 / -1 | 2560x1600 | – | 153 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 24.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 1 | 14 / 18 | 960x540 | – | 15 | – |  | view - in content 0,0 960x540; page 960x540 at 1x |
| osr | false | capturePage | 6/6 | 6 | 17 / 20 | -11 / -9 | 960x540 | 14 / 16 | 50 | – |  | view - in content 0,0 960x540; page 960x540 at 1x |
| osr | false | cdpJpeg | 6/6 | 6 | 99 / 100 | -83 / -75 | 960x540 | – | 48 | – |  | view - in content 0,0 960x540; page 960x540 at 1x |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | – | 155 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | – | 7 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 110 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 288 | pss | 479 | 3 | 0.0 |
| 1 | 318 | pss | 586 | 4 | 0.0 |
| 2 | 334 | pss | 696 | 5 | 0.5 |
| 4 | 364 | pss | 915 | 7 | 0.3 |
| 8 | 421 | pss | 1353 | 11 | 1.0 |

Per idle tab resting in the never-shown window (a still page): **17 MiB**, 0.12% CPU. Four tabs: one partition +71 MiB, four partitions +76 MiB.

Quiet tabs working in one shared 1×1 host (no rAF loop; the page repaints twice a second): **60 MiB** and 1.59% CPU a tab (0: 314 MiB / 0.0%, 1: 388 MiB / 1.5%, 4: 563 MiB / 6.5%, 8: 794 MiB / 12.7%).

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 90.3 | 23.8 | 66.5 | 60 |
| animated, never-shown window, throttling off | 1.3 | 1.3 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.3 | 0.0 | 0.0 | 0 |
| animated, never-shown window, throttling off + frame pump | 1.0 | 1.0 | 0.0 | 0 |
| animated, invisible shown window | 1.3 | 1.0 | 0.0 | 0 |
| animated, 1x1 shown window | 23.3 | 21.0 | 2.0 | 60 |
| animated, osr 30 fps | 15.8 | 8.0 | 2.5 | 30 |

**One host, 4 tabs (each held at 1280×800, 1×):** tab 1 rAF 60 Hz, capturePage 4/4 in 63 / 70 ms (2560x1600); tab 2 rAF 59 Hz, capturePage 4/4 in 63 / 69 ms (2560x1600); tab 3 rAF 58 Hz, capturePage 4/4 in 64 / 68 ms (2560x1600); tab 4 rAF 57 Hz, capturePage 4/4 in 70 / 72 ms (2560x1600)

**Assertions:** PASS capturePage works in the host with the agent's 1280x800 at 1x held; PASS every tab in one shared host draws and is pictured

### Electron · linux-x11 (electron-linux-x11.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone x11, displays 1920x1080@1, status **done**, 876 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.91 | 27.3 | 47 / 53 | 1 / 15 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.96 | 28.4 | 44 / 47 | 12 / 19 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.1 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.96 | 28.5 | 41 / 48 | 15 / 19 | 1280x800@1 → 1000x700@1 → 1280x800 | 0 / 1 | 2.1 |  |
| invisibleWindow | true | true | true | true (1) | 0.96 | 28.4 | 41 / 46 | 3 / 18 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.1 |  |
| tinyWindow | true | true | true | true (1) | 0.96 | 28.6 | 41 / 44 | 13 / 16 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.1 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | IO / RO Hz | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 99.9 | 99.3 | 60.0 | 18 | 2.0 / 2.0 | – | – | – | 4.8 | 7.0 |  |
| detached, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.2 |  |
| detached, throttling off | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 1.0 | 1.0 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.2 |  |
| never-shown window, throttling off | visible | 1280x800 | 99.9 | 99.3 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 1.0 | 1.0 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 100.1 | 99.1 | 1.0 | 1018 | 0.0 / 0.0 | – | – | – | 1.2 | 1.6 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 1.2 | 1.6 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 99.9 | 98.9 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 1.2 | 1.2 |  |
| invisible shown window, throttling off | visible | 1280x800 | 99.9 | 98.9 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 1.2 | 1.2 |  |
| 1x1 shown window, throttling off | visible | 1280x800 | 100.2 | 99.2 | 60.0 | 18 | 2.0 / 2.0 | – | – | – | 4.0 | 5.6 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 100.2 | 99.2 | 60.0 | 18 | 2.0 / 2.0 | – | – | – | 4.2 | 5.8 | cover 0,0 1919x1079 over host 0,0 1x1 |
| 1x1 shown window kept above a cover window (always on top) | visible | 1280x800 | 100.1 | 99.1 | 60.0 | 18 | 2.0 / 2.0 | – | – | – | 4.2 | 6.2 | cover 0,0 1919x1079 over host 0,0 1x1 |
| invisible shown window, covered by another window | visible | 1280x800 | 100.2 | 99.2 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 1.0 | 1.0 | cover -1480,-1000 1919x1079 over host -1480,-1000 1280x800 |
| 1x1 shown window, throttling on (control) | visible | 1280x800 | 100.0 | 99.2 | 60.0 | 18 | 2.0 / 2.0 | – | – | – | 4.4 | 6.2 |  |
| 1x1 shown window, throttling on, covered by another window (control) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.0 | cover 0,0 1919x1079 over host 0,0 1x1 |
| invisible shown window, throttling on, covered by another window (control) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.0 | cover -1480,-1000 1919x1079 over host -1480,-1000 1280x800 |
| osr window 30 fps, throttling off | visible | 1280x800 | 100.0 | 99.2 | 30.0 | 34 | 2.0 / 2.0 | – | – | – | 3.2 | 13.2 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 99.9 | 99.1 | 30.0 | 34 | 0.0 / 2.0 | – | – | – | 1.8 | 2.2 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 25.8 | – | 2.0 | 3.0 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 25.8 | – | 2.2 | 3.2 |  |
| detached, throttling off, playing media | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 25.8 | – | 2.4 | 3.2 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 99.9 | 98.9 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | to 1280×800 + JPEG ms | CPU ms/picture | frames/s | visibility events | geometry; errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 13 / 16 | 9 / 10 | 1000x700 | 17 / 17 | 72 | – |  | view 0,0 1000x700 in content 40,67 1000x700; page 1000x700 at 1x |
| shown | true | capturePage | 6/6 | 6 | 15 / 18 | 8 / 11 | 1000x700 | 15 / 17 | 70 | – |  | view 0,0 1000x700 in content 40,67 1000x700; page 1000x700 at 1x |
| shown | true | cdpJpeg | 6/6 | 6 | 81 / 87 | -46 / -41 | 1000x700 | – | 80 | – |  | view 0,0 1000x700 in content 40,67 1000x700; page 1000x700 at 1x |
| shown | true | frameSub | 6/6 | 6 | 15 / 17 | 11 / 12 | 1000x700 | – | 40 | – |  | view 0,0 1000x700 in content 40,67 1000x700; page 1000x700 at 1x |
| shown | true | cdpPng | 6/6 | 6 | 212 / 234 | -44 / -37 | 1000x700 | – | 255 | – |  | view 0,0 1000x700 in content 40,67 1000x700; page 1000x700 at 1x |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 75 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | – | 45 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 3 | – |  | view 0,0 1280x800 in content 320,167 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 320,167 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 4045 / 4049 | -2990 / -49 | 1280x800 | – | 132 | – |  | view 0,0 1280x800 in content 320,167 1280x800; page 1280x800 at 1x |
| hiddenWindow | false | frameSub | 6/6 | 6 | 9 / 11 | 61 / 78 | 1280x800 | – | 40 | – |  | view 0,0 1280x800 in content 320,167 1280x800; page 1280x800 at 1x |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.5 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content 320,167 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 320,167 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 98 / 98 | -57 / -30 | 1280x800 | – | 135 | – |  | view 0,0 1280x800 in content 320,167 1280x800; page 1280x800 at 1x |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 14 / 15 | 11 / 13 | 1280x800 | – | 73 | – |  | view 0,0 1280x800 in content 320,167 1280x800; page 1280x800 at 1x |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 3 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| invisibleWindow | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 78 / 86 | -39 / -29 | 1280x800 | – | 102 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | frameSub | 6/6 | 6 | 15 / 31 | 15 / 16 | 1280x800 | – | 62 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.5 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 14 / 14 | -2 / -2 | 1280x800 | – | 48 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | capturePage | 6/6 | 6 | 14 / 15 | -3 / 0 | 1280x800 | – | 38 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 63 / 78 | -38 / -21 | 1280x800 | – | 80 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | frameSub | 6/6 | 6 | 15 / 15 | 1 / 2 | 1280x800 | – | 43 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 14 / 23 | 12 / 14 | 1280x800 | – | 47 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 13 / 15 | 14 / 14 | 1280x800 | – | 48 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 78 / 85 | -39 / -35 | 1280x800 | – | 85 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 14 / 31 | 15 / 16 | 1280x800 | – | 48 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePageHidden | 6/6 | 6 | 14 / 18 | 12 / 14 | 1280x800 | – | 52 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | capturePage | 6/6 | 6 | 13 / 15 | 12 / 16 | 1280x800 | – | 47 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | cdpJpeg | 6/6 | 6 | 80 / 83 | -39 / -36 | 1280x800 | – | 82 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | frameSub | 6/6 | 6 | 14 / 18 | 15 / 17 | 1280x800 | – | 50 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 16 / 24 | 1280x800 | – | 32 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | capturePage | 6/6 | 6 | 30 / 33 | -17 / -5 | 1280x800 | – | 50 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | cdpJpeg | 6/6 | 6 | 97 / 112 | -70 / -67 | 1280x800 | – | 87 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | – | 153 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 120 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 327 | pss | 589 | 4 | 0.5 |
| 1 | 355 | pss | 695 | 5 | 0.0 |
| 2 | 370 | pss | 804 | 6 | 0.3 |
| 4 | 400 | pss | 1020 | 8 | 0.3 |
| 8 | 454 | pss | 1455 | 12 | 0.8 |

Per idle tab resting in the never-shown window (a still page): **16 MiB**, 0.03% CPU. Four tabs: one partition +66 MiB, four partitions +71 MiB.

Quiet tabs working in one shared 1×1 host (no rAF loop; the page repaints twice a second): **28 MiB** and 0.87% CPU a tab (0: 351 MiB / 0.5%, 1: 392 MiB / 1.3%, 4: 472 MiB / 3.5%, 8: 576 MiB / 7.5%).

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 25.2 | 18.3 | 6.8 | 60 |
| animated, never-shown window, throttling off | 1.3 | 1.0 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.3 | 0.0 | 0.0 | 0 |
| animated, never-shown window, throttling off + frame pump | 1.5 | 1.3 | 0.3 | 0 |
| animated, invisible shown window | 1.5 | 1.0 | 0.0 | 0 |
| animated, 1x1 shown window | 23.5 | 21.5 | 2.0 | 60 |
| animated, osr 30 fps | 24.0 | 11.5 | 3.8 | 30 |

**Waking a resting tab into the host** (never-shown window, throttling on, 4 cycles): first rAF 1 / 2 ms, fresh picture 17 / 34 ms; resting rates 1.9 Hz / rAF 0.0, 2.0 Hz / rAF 0.0, 2.0 Hz / rAF 0.0, 2.0 Hz / rAF 0.0; awake rAF 60, 60, 60, 60

**One host, 4 tabs (each held at 1280×800, 1×):** tab 1 rAF 60 Hz, capturePage 4/4 in 25 / 29 ms (1280x800); tab 2 rAF 60 Hz, capturePage 4/4 in 15 / 26 ms (1280x800); tab 3 rAF 60 Hz, capturePage 4/4 in 14 / 16 ms (1280x800); tab 4 rAF 60 Hz, capturePage 4/4 in 11 / 16 ms (1280x800)

**The host's invariants:** host 100,100 1x1, focused at start false, after its page grabs focus false (focused window "S7 probe"); Windows styles –; click-through {"at":"100,100","tool":"xdotool","belowClicks":0,"hostClicks":1}; X11 {"id":"0x200156","size":"1x1","mapState":"IsViewable","overrideRedirect":"yes","shape":"No window shape defined; No border shape defined"}

**X11, the host with an empty window shape:** {"id":"0x200164","size":"1x1","mapState":"IsViewable","overrideRedirect":"yes","shape":"Window shape extents:  0x0+0+0; No border shape defined"}; rAF 60 Hz (visible), capturePage 4/4 in 13 / 20 ms (1280x800); click-through {"at":"100,100","tool":"xdotool","belowClicks":1,"hostClicks":0}; with throttling on: 1.0 Hz / rAF 0 (hidden)

**Assertions:** PASS no reload when moving from detached; PASS no reload when moving from hiddenWindow; PASS no reload when moving from hiddenWindowFit; PASS no reload when moving from invisibleWindow; PASS no reload when moving from tinyWindow; PASS the host (1x1; 32x32 on Windows) draws (rAF above 10 Hz); PASS a never-shown window draws nothing (rAF below 1 Hz); PASS capturePage works in the host; PASS capturePage works in the host with the agent's 1280x800 at 1x held; PASS the host never takes focus, even when its page asks; PASS X11: the host with an empty window shape draws and is pictured; PASS X11: a real click at the shaped host's point reaches the window below; PASS a resting tab draws within 2 s of moving into the host, every cycle; PASS every tab in one shared host draws and is pictured

**Q6 streamed view** (10 s at the viewer; latency p50 / p95 ms)

| road | content | source | fps | decoded fps | latency | gap p95 | kbit/s | bytes/frame | sender CPU % | viewer CPU % | source rAF | notes |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| screencast | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | 0 |  |
| capturePoll | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | anim | hiddenWindow | 20.8 | 20.8 | 43 / 51 | 78 | 2515 | 15117 | 69 | 16 | 60 | libvpx; video/VP8 |
| webrtc-h264 | anim | hiddenWindow | 12.7 | 12.7 | 97 / 108 | 111 | 2490 | 24507 | 65 | 10 | 60 | OpenH264; video/H264 |
| webcodecs-vp8 | anim | hiddenWindow | 30.0 | 30.0 | 34 / 36 | 36 | 2421 | 10087 | 92 | 19 | 60 |  |
| webcodecs-h264 | anim | hiddenWindow | 30.0 | 30.0 | 32 / 34 | 36 | 2403 | 10012 | 81 | 18 | 60 |  |
| screencast | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | 0 |  |
| capturePoll | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | static | hiddenWindow | 2.7 | 2.7 | 70 / 155 | 505 | 872 | 40357 | 9 | 3 | 60 | libvpx; video/VP8 |
| webrtc-h264 | static | hiddenWindow | 1.0 | 1.0 | 19 / 64 | 1046 | 46 | 5701 | 6 | 1 | 60 | OpenH264; video/H264 |
| webcodecs-vp8 | static | hiddenWindow | 2.0 | 2.0 | 33 / 35 | 504 | 124 | 7771 | 7 | 1 | 60 |  |
| webcodecs-h264 | static | hiddenWindow | 2.0 | 2.0 | 19 / 21 | 503 | 84 | 5264 | 5 | 1 | 60 |  |
| screencast | anim | invisibleWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | 0 |  |
| capturePoll | anim | invisibleWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | 0 | toJPEG 0.0 ms |
| webcodecs-h264 | anim | invisibleWindow | 30.0 | 30.0 | 35 / 37 | 36 | 2397 | 9988 | 101 | 19 | 60 |  |
| screencast | anim | tinyWindow | 60.1 | 60.1 | 42 / 45 | 20 | 66112 | 137734 | 161 | 43 | 60 |  |
| webcodecs-h264 | anim | tinyWindow | 30.0 | 30.0 | 34 / 37 | 36 | 2405 | 10022 | 94 | 18 | 60 |  |
| screencast | anim | shown | 60.0 | 60.0 | 35 / 37 | 19 | 55109 | 114619 | 117 | 32 | 60 |  |
| webrtc-vp8 | anim | shown | 20.3 | 20.3 | 52 / 60 | 79 | 2508 | 15444 | 102 | 17 | 60 | libvpx; video/VP8 |
| webcodecs-h264 | anim | shown | 30.0 | 30.0 | 40 / 43 | 36 | 2452 | 10215 | 110 | 20 | 60 |  |

### Electron · linux-x64-ozone-headless (electron-linux-x64-ozone-headless.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone headless, displays 1920x1080@1, status **done**, 574 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.93 | 27.8 | 45 / 89 | 1 / 6 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.96 | 28.4 | 44 / 47 | 17 / 18 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.3 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.96 | 28.4 | 40 / 45 | 11 / 13 | 1280x800@1 → 1000x700@1 → 1280x800 | 0 / 2 | 2.1 |  |
| invisibleWindow | true | true | true | true (1) | 0.96 | 28.6 | 43 / 47 | 0 / 14 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.0 |  |
| tinyWindow | true | true | true | true (1) | 0.96 | 28.7 | 39 / 43 | 12 / 13 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.0 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | IO / RO Hz | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 100.0 | 99.2 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 4.8 | 6.6 |  |
| detached, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.4 |  |
| detached, throttling off | visible | 1280x800 | 100.0 | 99.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 1.4 | 1.4 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.2 |  |
| never-shown window, throttling off | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 1.0 | 1.0 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 100.1 | 99.1 | 1.0 | 1017 | 0.0 / 0.0 | – | – | – | 1.4 | 2.0 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 1.2 | 1.2 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 100.1 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 1.0 | 1.0 |  |
| invisible shown window, throttling off | visible | 1280x800 | 100.0 | 99.4 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 4.4 | 6.0 |  |
| 1x1 shown window, throttling off | visible | 1280x800 | 100.0 | 99.2 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 4.8 | 6.0 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 100.1 | 99.1 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 5.2 | 7.0 | cover 0,0 1920x1080 over host 0,0 1x1 |
| 1x1 shown window kept above a cover window (always on top) | visible | 1280x800 | 100.1 | 99.1 | 60.2 | 17 | 2.2 / 2.2 | – | – | – | 4.8 | 6.2 | cover 0,0 1920x1080 over host 0,0 1x1 |
| invisible shown window, covered by another window | visible | 1280x800 | 100.2 | 99.2 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 4.8 | 6.8 | cover -1480,-1000 1920x1080 over host -1480,-1000 1280x800 |
| 1x1 shown window, throttling on (control) | visible | 1280x800 | 100.1 | 99.3 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 5.2 | 6.8 |  |
| 1x1 shown window, throttling on, covered by another window (control) | visible | 1280x800 | 100.0 | 99.2 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 5.0 | 6.6 | cover 0,0 1920x1080 over host 0,0 1x1 |
| invisible shown window, throttling on, covered by another window (control) | visible | 1280x800 | 99.9 | 99.1 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 5.2 | 7.4 | cover -1480,-1000 1920x1080 over host -1480,-1000 1280x800 |
| osr window 30 fps, throttling off | visible | 1280x800 | 100.0 | 99.2 | 30.0 | 34 | 2.0 / 2.0 | – | – | – | 2.8 | 12.4 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 100.1 | 99.1 | 30.0 | 34 | 0.0 / 2.0 | – | – | – | 1.6 | 2.0 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 26.0 | – | 2.6 | 3.4 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 25.8 | – | 2.2 | 3.0 |  |
| detached, throttling off, playing media | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 26.0 | – | 2.4 | 3.2 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | to 1280×800 + JPEG ms | CPU ms/picture | frames/s | visibility events | geometry; errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 15 / 22 | 8 / 11 | 1000x700 | 16 / 17 | 73 | – |  | view 0,0 1000x700 in content 40,65 1000x700; page 1000x700 at 1x |
| shown | true | capturePage | 6/6 | 6 | 15 / 17 | 9 / 10 | 1000x700 | 15 / 17 | 65 | – |  | view 0,0 1000x700 in content 40,65 1000x700; page 1000x700 at 1x |
| shown | true | cdpJpeg | 6/6 | 6 | 80 / 86 | -46 / -40 | 1000x700 | – | 77 | – |  | view 0,0 1000x700 in content 40,65 1000x700; page 1000x700 at 1x |
| shown | true | frameSub | 6/6 | 6 | 15 / 17 | 12 / 12 | 1000x700 | – | 45 | – |  | view 0,0 1000x700 in content 40,65 1000x700; page 1000x700 at 1x |
| shown | true | cdpPng | 6/6 | 6 | 212 / 227 | -39 / -34 | 1000x700 | – | 248 | – |  | view 0,0 1000x700 in content 40,65 1000x700; page 1000x700 at 1x |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 80 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | – | 65 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 3 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 4044 / 4049 | -2991 / -50 | 1280x800 | – | 128 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x |
| hiddenWindow | false | frameSub | 6/6 | 6 | 9 / 11 | 62 / 79 | 1280x800 | – | 43 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.5 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | – | 3 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 98 / 100 | -57 / -30 | 1280x800 | – | 138 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 14 / 16 | 12 / 13 | 1280x800 | – | 78 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 6/6 | 6 | 15 / 15 | 13 / 14 | 1280x800 | – | 68 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | capturePage | 6/6 | 6 | 13 / 16 | 12 / 17 | 1280x800 | – | 63 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 80 / 91 | -39 / -36 | 1280x800 | – | 110 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | frameSub | 6/6 | 6 | 17 / 31 | 2 / 16 | 1280x800 | – | 67 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 14 / 24 | 13 / 15 | 1280x800 | – | 52 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | capturePage | 6/6 | 6 | 13 / 16 | 12 / 14 | 1280x800 | – | 45 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 79 / 84 | -39 / -36 | 1280x800 | – | 83 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | frameSub | 6/6 | 6 | 14 / 29 | 15 / 16 | 1280x800 | – | 45 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 15 / 23 | 13 / 14 | 1280x800 | – | 52 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 14 / 21 | 12 / 17 | 1280x800 | – | 48 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 82 / 90 | -41 / -40 | 1280x800 | – | 82 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 16 / 17 | 14 / 15 | 1280x800 | – | 43 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePageHidden | 6/6 | 6 | 14 / 19 | 14 / 15 | 1280x800 | – | 50 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | capturePage | 6/6 | 6 | 13 / 14 | 13 / 15 | 1280x800 | – | 45 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | cdpJpeg | 6/6 | 6 | 80 / 82 | -41 / -35 | 1280x800 | – | 83 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | frameSub | 6/6 | 6 | 14 / 19 | 16 / 16 | 1280x800 | – | 50 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 29 / 36 | 1280x800 | – | 33 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | capturePage | 6/6 | 6 | 30 / 35 | -17 / -17 | 1280x800 | – | 48 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | cdpJpeg | 6/6 | 6 | 98 / 127 | -70 / -68 | 1280x800 | – | 83 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | – | 180 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 140 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 243 | pss | 499 | 4 | 0.0 |
| 1 | 270 | pss | 603 | 5 | 0.8 |
| 2 | 286 | pss | 711 | 6 | 0.3 |
| 4 | 315 | pss | 926 | 8 | 0.8 |
| 8 | 370 | pss | 1356 | 12 | 0.0 |

Per idle tab resting in the never-shown window (a still page): **16 MiB**, 0.00% CPU. Four tabs: one partition +65 MiB, four partitions +71 MiB.

Quiet tabs working in one shared 1×1 host (no rAF loop; the page repaints twice a second): **28 MiB** and 0.87% CPU a tab (0: 267 MiB / 0.0%, 1: 307 MiB / 1.5%, 4: 387 MiB / 3.8%, 8: 491 MiB / 7.0%).

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 24.2 | 18.0 | 5.8 | 60 |
| animated, never-shown window, throttling off | 1.5 | 1.3 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.0 | 0.0 | 0.0 | 0 |
| animated, never-shown window, throttling off + frame pump | 1.5 | 1.3 | 0.3 | 0 |
| animated, invisible shown window | 34.2 | 24.5 | 9.8 | 60 |
| animated, 1x1 shown window | 25.0 | 23.0 | 1.8 | 60 |
| animated, osr 30 fps | 26.0 | 12.3 | 4.5 | 30 |

**Waking a resting tab into the host** (never-shown window, throttling on, 4 cycles): first rAF 1 / 2 ms, fresh picture 25 / 51 ms; resting rates 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0; awake rAF 60, 60, 60, 60

**One host, 4 tabs (each held at 1280×800, 1×):** tab 1 rAF 60 Hz, capturePage 4/4 in 18 / 30 ms (1280x800); tab 2 rAF 60 Hz, capturePage 4/4 in 16 / 27 ms (1280x800); tab 3 rAF 60 Hz, capturePage 4/4 in 14 / 24 ms (1280x800); tab 4 rAF 60 Hz, capturePage 4/4 in 13 / 17 ms (1280x800)

**The host's invariants:** host 100,100 1x1, focused at start false, after its page grabs focus false (focused window "S7 browser view"); Windows styles –; click-through not testable here (macOS needs Accessibility for synthetic clicks; Wayland and no display have no global input)

**Assertions:** PASS no reload when moving from detached; PASS no reload when moving from hiddenWindow; PASS no reload when moving from hiddenWindowFit; PASS no reload when moving from invisibleWindow; PASS no reload when moving from tinyWindow; PASS the host (1x1; 32x32 on Windows) draws (rAF above 10 Hz); PASS a never-shown window draws nothing (rAF below 1 Hz); PASS capturePage works in the host; PASS capturePage works in the host with the agent's 1280x800 at 1x held; PASS the host never takes focus, even when its page asks; PASS a resting tab draws within 2 s of moving into the host, every cycle; PASS every tab in one shared host draws and is pictured

### Electron · macos-dsf2 (electron-macos-dsf2.json)

Electron 45.2.2 (Chromium 156.0.8078.80), darwin-arm64 25.6.0, ozone (default), displays 1024x768@2, status **done**, 271 s

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | to 1280×800 + JPEG ms | CPU ms/picture | frames/s | visibility events | geometry; errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 52 / 100 | 5 / 17 | 2000x1400 | 40 / 46 | 157 | – |  | view 0,0 1000x700 in content 24,63 1000x645; page 1000x700 at 2x |
| shown | true | capturePage | 6/6 | 6 | 32 / 58 | 3 / 14 | 2000x1400 | 23 / 45 | 109 | – |  | view 0,0 1000x700 in content 24,63 1000x645; page 1000x700 at 2x |
| shown | true | cdpJpeg | 6/6 | 6 | 111 / 133 | -43 / -37 | 2000x1400 | – | 118 | – |  | view 0,0 1000x700 in content 24,63 1000x645; page 1000x700 at 2x |
| shown | true | frameSub | 6/6 | 6 | 26 / 59 | 10 / 19 | 2000x1400 | – | 76 | – |  | view 0,0 1000x700 in content 24,63 1000x645; page 1000x700 at 2x |
| shown | true | cdpPng | 6/6 | 6 | 329 / 361 | -48 / -37 | 2000x1400 | – | 367 | – |  | view 0,0 1000x700 in content 24,63 1000x645; page 1000x700 at 2x |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 13 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 2x; Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | – | 13 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 2x; Current display surface not available for capture |
| detached | false | cdpJpeg | 1/3 | 1 | 147 / 147 | -50 / -50 | 2560x1600 | – | 202 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 2x; Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | – | 205 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 2x; frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 11 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | – | 12 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 137 / 160 | -52 / -38 | 2560x1600 | – | 139 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 2x |
| hiddenWindow | false | frameSub | 6/6 | 6 | 43 / 69 | 15 / 29 | 2560x1600 | – | 91 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 2x |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 15 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | – | 15 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 136 / 211 | -50 / -17 | 2560x1600 | – | 288 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 2x |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 32 / 56 | 2 / 12 | 2560x1600 | – | 136 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 2x |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.5 |  |  |
| invisibleWindow | false | capturePageHidden | 6/6 | 6 | 25 / 44 | 8 / 15 | 2560x1600 | 19 / 28 | 98 | – |  | view 0,0 1280x800 in content 0,31 1280x800; page 1280x800 at 2x |
| invisibleWindow | false | capturePage | 6/6 | 6 | 29 / 46 | 7 / 18 | 2560x1600 | 15 / 22 | 75 | – |  | view 0,0 1280x800 in content 0,31 1280x800; page 1280x800 at 2x |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 116 / 142 | -47 / -34 | 2560x1600 | – | 127 | – |  | view 0,0 1280x800 in content 0,31 1280x800; page 1280x800 at 2x |
| invisibleWindow | false | frameSub | 6/6 | 6 | 32 / 34 | 7 / 18 | 2560x1600 | – | 60 | – |  | view 0,0 1280x800 in content 0,31 1280x800; page 1280x800 at 2x |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 28 / 41 | 6 / 13 | 2560x1600 | 17 / 21 | 85 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 2x |
| tinyWindow | false | capturePage | 6/6 | 6 | 23 / 36 | 12 / 17 | 2560x1600 | 17 / 22 | 83 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 2x |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 122 / 131 | -47 / -40 | 2560x1600 | – | 121 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 2x |
| tinyWindow | false | frameSub | 6/6 | 6 | 32 / 51 | 7 / 18 | 2560x1600 | – | 77 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 2x |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 18 / 31 | -4 / 0 | 2560x1600 | 13 / 18 | 72 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 2x |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 25 / 30 | -4 / -2 | 2560x1600 | 14 / 19 | 83 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 2x |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 94 / 102 | -43 / -37 | 2560x1600 | – | 109 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 2x |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 27 / 37 | -1 / 0 | 2560x1600 | – | 78 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 2x |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePageHidden | 6/6 | 6 | 19 / 43 | 13 / 19 | 2560x1600 | 16 / 24 | 88 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | capturePage | 6/6 | 6 | 25 / 33 | 4 / 12 | 2560x1600 | 18 / 23 | 88 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | cdpJpeg | 6/6 | 6 | 67 / 305 | -43 / -25 | 1280x800 | – | 90 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | frameSub | 6/6 | 6 | 32 / 60 | 6 / 13 | 2560x1600 | – | 77 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 131 / 208 | 1280x800 | – | 20 | – |  | view - in content 0,-33 1280x800; page 1280x800 at 1x |
| osr | false | capturePage | 6/6 | 6 | 122 / 168 | 42 / 118 | 1280x800 | – | 38 | – |  | view - in content 0,-33 1280x800; page 1280x800 at 1x |
| osr | false | cdpJpeg | 6/6 | 6 | 307 / 382 | -181 / -77 | 1280x800 | – | 100 | – |  | view - in content 0,-33 1280x800; page 1280x800 at 1x |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | – | 13.5 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | – | 453 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | – | 7 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 356 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 165 | footprint | 333 | 3 | 0.1 |
| 1 | 186 | footprint | 424 | 4 | 0.5 |
| 2 | 205 | footprint | 518 | 5 | 0.6 |
| 4 | 246 | footprint | 704 | 7 | 1.4 |
| 8 | 331 | footprint | 1077 | 11 | 2.5 |

Per idle tab resting in the never-shown window (a still page): **21 MiB**, 0.30% CPU. Four tabs: one partition +79 MiB, four partitions +81 MiB.

Quiet tabs working in one shared 1×1 host (no rAF loop; the page repaints twice a second): **67 MiB** and 2.02% CPU a tab (0: 189 MiB / 0.1%, 1: 281 MiB / 2.8%, 4: 475 MiB / 9.1%, 8: 722 MiB / 16.3%).

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 29.2 | 10.0 | 18.8 | 60 |
| animated, never-shown window, throttling off | 11.6 | 3.6 | 7.6 | 0 |
| animated, never-shown window, throttling on | 0.5 | 0.1 | 0.3 | 0 |
| animated, never-shown window, throttling off + frame pump | 11.6 | 3.8 | 7.6 | 0 |
| animated, invisible shown window | 40.3 | 12.7 | 27.3 | 60 |
| animated, 1x1 shown window | 34.1 | 11.3 | 22.5 | 60 |
| animated, osr 30 fps | 17.8 | 3.9 | 9.4 | 14 |

**One host, 4 tabs (each held at 1280×800, 1×):** tab 1 rAF 60 Hz, capturePage 4/4 in 20 / 36 ms (2560x1600); tab 2 rAF 60 Hz, capturePage 4/4 in 21 / 24 ms (2560x1600); tab 3 rAF 60 Hz, capturePage 4/4 in 29 / 33 ms (2560x1600); tab 4 rAF 60 Hz, capturePage 4/4 in 24 / 39 ms (2560x1600)

**Assertions:** PASS capturePage works in the host with the agent's 1280x800 at 1x held; PASS every tab in one shared host draws and is pictured

### Electron · macos (electron-macos.json)

Electron 45.2.2 (Chromium 156.0.8078.80), darwin-arm64 25.6.0, ozone (default), displays 1024x768@1, status **done**, 881 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.90 | 26.8 | 81 / 3529 | 19 / 2134 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.95 | 28.4 | 144 / 299 | 11 / 81 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.1 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.98 | 29.1 | 134 / 167 | 26 / 37 | 1280x800@1 → 1000x700@1 → 1280x800 | 3 / 5 | 2.0 |  |
| invisibleWindow | true | true | true | true (1) | 0.98 | 28.8 | 62 / 117 | 5 / 16 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 58.4 |  |
| tinyWindow | true | true | true | true (1) | 0.97 | 28.9 | 49 / 85 | 4 / 13 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 58.7 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | IO / RO Hz | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 75.5 | 60.9 | 59.3 | 72 | 2.0 / 2.0 | – | – | – | 9.3 | 26.7 |  |
| detached, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.2 | 1.0 |  |
| detached, throttling off | visible | 1280x800 | 99.1 | 81.5 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 4.2 | 10.5 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 1.4 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.2 | 0.8 |  |
| never-shown window, throttling off | visible | 1280x800 | 99.2 | 81.5 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 4.4 | 11.4 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 73.6 | 56.1 | 56.1 | 200 | 2.2 / 2.2 | – | – | – | 8.9 | 24.8 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 94.6 | 77.2 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 3.9 | 10.6 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 99.1 | 80.3 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 4.1 | 10.3 |  |
| invisible shown window, throttling off | visible | 1280x800 | 80.3 | 61.1 | 59.5 | 45 | 2.2 / 2.2 | – | – | – | 8.3 | 23.3 |  |
| 1x1 shown window, throttling off | visible | 1280x800 | 69.7 | 59.7 | 59.5 | 43 | 2.0 / 2.0 | – | – | – | 7.8 | 22.1 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 65.5 | 50.3 | 55.9 | 72 | 2.0 / 2.0 | – | – | – | 7.8 | 22.3 | cover 0,0 1024x768 over host 0,31 1x1 |
| 1x1 shown window kept above a cover window (always on top) | visible | 1280x800 | 73.2 | 52.6 | 58.0 | 61 | 2.0 / 2.0 | – | – | – | 7.8 | 22.1 | cover 0,0 1024x768 over host 0,31 1x1 |
| invisible shown window, covered by another window | visible | 1280x800 | 64.2 | 52.4 | 55.8 | 125 | 2.0 / 2.0 | – | – | – | 8.0 | 22.9 | cover 0,0 1280x831 over host 0,31 1280x800 |
| 1x1 shown window, throttling on (control) | visible | 1280x800 | 65.3 | 57.1 | 59.3 | 79 | 2.2 / 2.2 | – | – | – | 8.0 | 23.5 |  |
| 1x1 shown window, throttling on, covered by another window (control) | hidden | 1280x800 | 1.4 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.2 | 0.9 | cover 0,0 1024x768 over host 0,31 1x1 |
| invisible shown window, throttling on, covered by another window (control) | hidden | 1280x800 | 2.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.4 | 1.2 | cover 0,0 1280x831 over host 0,31 1280x800 |
| osr window 30 fps, throttling off | visible | 1280x800 | 42.4 | 35.2 | 16.4 | 172 | 1.8 / 1.8 | – | – | – | 3.7 | 26.6 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 44.3 | 35.1 | 14.4 | 179 | 0.0 / 2.0 | – | – | – | 3.3 | 7.9 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 42.0 | 33.0 | 0.0 | 0 | 0.0 / 0.0 | 0.83 | 25.6 | – | 4.5 | 9.9 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 38.0 | 30.3 | 0.0 | 0 | 0.0 / 0.0 | 0.88 | 27.1 | – | 5.0 | 10.9 |  |
| detached, throttling off, playing media | visible | 1280x800 | 40.1 | 32.4 | 0.0 | 0 | 0.0 / 0.0 | 0.91 | 26.6 | – | 5.2 | 11.4 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 100.0 | 71.9 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | to 1280×800 + JPEG ms | CPU ms/picture | frames/s | visibility events | geometry; errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 30 / 37 | 17 / 22 | 1000x700 | 12 / 29 | 73 | – |  | view 0,0 1000x700 in content 24,63 1000x645; page 1000x700 at 1x |
| shown | true | capturePage | 6/6 | 6 | 19 / 26 | 30 / 34 | 1000x700 | 11 / 24 | 64 | – |  | view 0,0 1000x700 in content 24,63 1000x645; page 1000x700 at 1x |
| shown | true | cdpJpeg | 6/6 | 6 | 97 / 110 | -44 / -39 | 1000x700 | – | 70 | – |  | view 0,0 1000x700 in content 24,63 1000x645; page 1000x700 at 1x |
| shown | true | frameSub | 6/6 | 6 | 26 / 30 | 22 / 30 | 1000x700 | – | 42 | – |  | view 0,0 1000x700 in content 24,63 1000x645; page 1000x700 at 1x |
| shown | true | cdpPng | 6/6 | 6 | 212 / 245 | -45 / -35 | 1000x700 | – | 201 | – |  | view 0,0 1000x700 in content 24,63 1000x645; page 1000x700 at 1x |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 12 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | – | 13 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | cdpJpeg | 1/3 | 1 | 150 / 150 | -70 / -70 | 1280x800 | – | 220 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | – | 187 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 13 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | – | 10 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 80 / 102 | -46 / -36 | 1280x800 | – | 71 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 1x |
| hiddenWindow | false | frameSub | 6/6 | 6 | 18 / 32 | 8 / 16 | 1280x800 | – | 34 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 1x |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.5 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 16 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | – | 14 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 97 / 119 | -52 / -20 | 1280x800 | – | 142 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 1x |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 17 / 28 | 8 / 12 | 1280x800 | – | 65 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 1x |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 6/6 | 6 | 25 / 26 | 8 / 13 | 1280x800 | – | 57 | – |  | view 0,0 1280x800 in content 0,31 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | capturePage | 6/6 | 6 | 14 / 32 | 6 / 22 | 1280x800 | – | 63 | – |  | view 0,0 1280x800 in content 0,31 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 91 / 121 | -47 / -40 | 1280x800 | – | 110 | – |  | view 0,0 1280x800 in content 0,31 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | frameSub | 6/6 | 6 | 23 / 40 | 11 / 24 | 1280x800 | – | 69 | – |  | view 0,0 1280x800 in content 0,31 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 19.5 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 20 / 27 | 25 / 29 | 1280x800 | – | 43 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow | false | capturePage | 6/6 | 6 | 28 / 43 | 23 / 39 | 1280x800 | – | 58 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 118 / 127 | -44 / -41 | 1280x800 | – | 116 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow | false | frameSub | 6/6 | 6 | 27 / 34 | 24 / 32 | 1280x800 | – | 73 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 22 / 31 | 11 / 21 | 1280x800 | – | 70 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 23 / 33 | 14 / 17 | 1280x800 | – | 74 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 97 / 142 | -44 / -38 | 1280x800 | – | 88 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 31 / 33 | 20 / 23 | 1280x800 | – | 54 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePageHidden | 6/6 | 6 | 21 / 34 | 11 / 15 | 1280x800 | – | 60 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | capturePage | 6/6 | 6 | 18 / 36 | 7 / 22 | 1280x800 | – | 66 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | cdpJpeg | 6/6 | 6 | 101 / 109 | -51 / -36 | 1280x800 | – | 106 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | frameSub | 6/6 | 6 | 23 / 31 | 5 / 14 | 1280x800 | – | 64 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 133 / 218 | 1280x800 | – | 18 | – |  | view - in content 0,-33 1280x800; page 1280x800 at 1x |
| osr | false | capturePage | 6/6 | 6 | 17 / 92 | 94 / 159 | 1280x800 | – | 35 | – |  | view - in content 0,-33 1280x800; page 1280x800 at 1x |
| osr | false | cdpJpeg | 6/6 | 6 | 310 / 481 | -178 / -157 | 1280x800 | – | 120 | – |  | view - in content 0,-33 1280x800; page 1280x800 at 1x |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | – | 14.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | – | 440 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | – | 8 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 442 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 148 | footprint | 385 | 4 | 0.3 |
| 1 | 170 | footprint | 476 | 5 | 0.6 |
| 2 | 188 | footprint | 570 | 6 | 0.7 |
| 4 | 230 | footprint | 755 | 8 | 1.7 |
| 8 | 315 | footprint | 1128 | 12 | 2.6 |

Per idle tab resting in the never-shown window (a still page): **21 MiB**, 0.29% CPU. Four tabs: one partition +77 MiB, four partitions +81 MiB.

Quiet tabs working in one shared 1×1 host (no rAF loop; the page repaints twice a second): **35 MiB** and 1.67% CPU a tab (0: 173 MiB / 0.2%, 1: 221 MiB / 2.8%, 4: 320 MiB / 8.7%, 8: 450 MiB / 13.6%).

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 29.4 | 9.7 | 19.2 | 60 |
| animated, never-shown window, throttling off | 10.8 | 3.3 | 7.0 | 0 |
| animated, never-shown window, throttling on | 0.6 | 0.1 | 0.3 | 0 |
| animated, never-shown window, throttling off + frame pump | 10.0 | 3.3 | 6.5 | 0 |
| animated, invisible shown window | 33.0 | 10.7 | 22.0 | 60 |
| animated, 1x1 shown window | 40.4 | 13.1 | 27.0 | 60 |
| animated, osr 30 fps | 19.8 | 4.4 | 9.6 | 14 |

**Waking a resting tab into the host** (never-shown window, throttling on, 4 cycles): first rAF 23 / 56 ms, fresh picture 98 / 156 ms; resting rates 1.4 Hz / rAF 0.0, 1.5 Hz / rAF 0.0, 1.2 Hz / rAF 0.0, 1.2 Hz / rAF 0.0; awake rAF 60, 60, 60, 60

**One host, 4 tabs (each held at 1280×800, 1×):** tab 1 rAF 60 Hz, capturePage 4/4 in 14 / 65 ms (1280x800); tab 2 rAF 60 Hz, capturePage 4/4 in 18 / 33 ms (1280x800); tab 3 rAF 59 Hz, capturePage 4/4 in 9 / 28 ms (1280x800); tab 4 rAF 59 Hz, capturePage 4/4 in 15 / 29 ms (1280x800)

**The host's invariants:** host 100,131 1x1, focused at start false, after its page grabs focus false (focused window "S7 probe"); Windows styles –; click-through not testable here (macOS needs Accessibility for synthetic clicks; Wayland and no display have no global input)

**Assertions:** PASS no reload when moving from detached; PASS no reload when moving from hiddenWindow; PASS no reload when moving from hiddenWindowFit; PASS no reload when moving from invisibleWindow; PASS no reload when moving from tinyWindow; PASS the host (1x1; 32x32 on Windows) draws (rAF above 10 Hz); PASS a never-shown window draws nothing (rAF below 1 Hz); PASS capturePage works in the host; PASS capturePage works in the host with the agent's 1280x800 at 1x held; PASS the host never takes focus, even when its page asks; PASS a resting tab draws within 2 s of moving into the host, every cycle; PASS every tab in one shared host draws and is pictured

**Q6 streamed view** (10 s at the viewer; latency p50 / p95 ms)

| road | content | source | fps | decoded fps | latency | gap p95 | kbit/s | bytes/frame | sender CPU % | viewer CPU % | source rAF | notes |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| screencast | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 10 | 0 | 0 |  |
| capturePoll | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 10 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | anim | hiddenWindow | 4.7 | 4.7 | 156 / 210 | 309 | 742 | 19733 | 56 | 7 | 60 | libvpx; video/VP8 |
| webrtc-h264 | anim | hiddenWindow | 1.3 | 1.3 | 768 / 1009 | 1065 | 482 | 46391 | 55 | 2 | 60 | OpenH264; video/H264 |
| webcodecs-vp8 | anim | hiddenWindow | 29.8 | 29.8 | 38 / 53 | 53 | 2221 | 9318 | 61 | 13 | 60 |  |
| webcodecs-h264 | anim | hiddenWindow | 30.0 | 30.0 | 42 / 52 | 51 | 2232 | 9299 | 76 | 10 | 60 |  |
| screencast | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 |  |
| capturePoll | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | static | hiddenWindow | 2.0 | 2.0 | 102 / 236 | 604 | 88 | 5503 | 9 | 2 | 45 | libvpx; video/VP8 |
| webrtc-h264 | static | hiddenWindow | 1.1 | 1.1 | 73 / 1431 | 1191 | 20 | 2308 | 10 | 1 | 44 | OpenH264; video/H264 |
| webcodecs-vp8 | static | hiddenWindow | 2.0 | 2.0 | 47 / 63 | 538 | 99 | 6212 | 10 | 1 | 42 |  |
| webcodecs-h264 | static | hiddenWindow | 2.0 | 2.0 | 53 / 70 | 543 | 9 | 581 | 9 | 1 | 43 |  |
| screencast | anim | invisibleWindow | 59.9 | 59.9 | 45 / 67 | 33 | 58245 | 121546 | 100 | 30 | 60 |  |
| capturePoll | anim | invisibleWindow | 25.8 | 25.8 | 47 / 73 | 60 | 25248 | 122325 | 66 | 15 | 60 | toJPEG 6.3 ms |
| webcodecs-h264 | anim | invisibleWindow | 30.0 | 30.0 | 43 / 55 | 51 | 2189 | 9150 | 82 | 11 | 60 |  |
| screencast | anim | tinyWindow | 57.4 | 57.4 | 53 / 86 | 35 | 55934 | 121808 | 100 | 29 | 60 |  |
| webcodecs-h264 | anim | tinyWindow | 30.1 | 30.1 | 50 / 63 | 50 | 2235 | 9313 | 113 | 22 | 60 |  |
| screencast | anim | shown | 59.3 | 59.3 | 60 / 75 | 31 | 48284 | 101951 | 103 | 29 | 60 |  |
| webrtc-vp8 | anim | shown | 2.9 | 2.9 | 287 / 441 | 487 | 458 | 19744 | 44 | 3 | 60 | libvpx; video/VP8 |
| webcodecs-h264 | anim | shown | 30.0 | 30.0 | 45 / 56 | 44 | 2109 | 8785 | 96 | 17 | 60 |  |

### Electron · windows-dsf2 (electron-windows-dsf2.json)

Electron 45.2.2 (Chromium 156.0.8078.80), win32-x64 10.0.26100, ozone (default), displays 256x192@2, status **done**, 299 s

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | to 1280×800 + JPEG ms | CPU ms/picture | frames/s | visibility events | geometry; errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 28 / 37 | 12 / 16 | 2000x1400 | 20 / 22 | 300 | – |  | view 0,0 1000x700 in content 44,82 504x342; page 1000x700 at 2x |
| shown | true | capturePage | 6/6 | 6 | 27 / 40 | 12 / 15 | 2000x1400 | 20 / 25 | 160 | – |  | view 0,0 1000x700 in content 44,82 504x342; page 1000x700 at 2x |
| shown | true | cdpJpeg | 6/6 | 6 | 116 / 120 | -38 / -35 | 2000x1400 | – | 210 | – |  | view 0,0 1000x700 in content 44,82 504x342; page 1000x700 at 2x |
| shown | true | frameSub | 6/6 | 6 | 52 / 56 | 6 / 13 | 2000x1400 | – | 152 | – |  | view 0,0 1000x700 in content 44,82 504x342; page 1000x700 at 2x |
| shown | true | cdpPng | 6/6 | 6 | 364 / 399 | -42 / -37 | 2000x1400 | – | 603 | – |  | view 0,0 1000x700 in content 44,82 504x342; page 1000x700 at 2x |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 28.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 118 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | – | 124 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 4,42 504x342; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 4,42 504x342; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 3971 / 3983 | -2878 / -56 | 2560x1600 | – | 221 | – |  | view 0,0 1280x800 in content 4,42 504x342; page 1280x800 at 2x |
| hiddenWindow | false | frameSub | 6/6 | 6 | 40 / 40 | 53 / 136 | 2560x1600 | – | 110 | – |  | view 0,0 1280x800 in content 4,42 504x342; page 1280x800 at 2x |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 3 | – |  | view 0,0 1280x800 in content 4,42 504x342; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 4,42 504x342; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 206 / 246 | -82 / -18 | 2560x1600 | – | 525 | – |  | view 0,0 1280x800 in content 4,42 504x342; page 1280x800 at 2x |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 60 / 75 | 10 / 18 | 2560x1600 | – | 237 | – |  | view 0,0 1280x800 in content 4,42 504x342; page 1280x800 at 2x |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 29.0 |  |  |
| invisibleWindow | false | capturePageHidden | 6/6 | 6 | 48 / 52 | 5 / 14 | 2560x1600 | 24 / 30 | 211 | – |  | view 0,0 1280x800 in content 1,0 511x362; page 1280x800 at 2x |
| invisibleWindow | false | capturePage | 6/6 | 6 | 48 / 52 | 6 / 15 | 2560x1600 | 22 / 29 | 213 | – |  | view 0,0 1280x800 in content 1,0 511x362; page 1280x800 at 2x |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 146 / 147 | -40 / -37 | 2560x1600 | – | 276 | – |  | view 0,0 1280x800 in content 1,0 511x362; page 1280x800 at 2x |
| invisibleWindow | false | frameSub | 6/6 | 6 | 68 / 70 | 9 / 10 | 2560x1600 | – | 181 | – |  | view 0,0 1280x800 in content 1,0 511x362; page 1280x800 at 2x |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 21.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 42 / 53 | 37 / 45 | 2560x1600 | 22 / 29 | 164 | – |  | view 0,0 1280x800 in content 1,0 31x35; page 1280x800 at 2x |
| tinyWindow | false | capturePage | 6/6 | 6 | 41 / 53 | 13 / 36 | 2560x1600 | 23 / 27 | 164 | – |  | view 0,0 1280x800 in content 1,0 31x35; page 1280x800 at 2x |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 140 / 148 | -43 / -32 | 2560x1600 | – | 203 | – |  | view 0,0 1280x800 in content 1,0 31x35; page 1280x800 at 2x |
| tinyWindow | false | frameSub | 6/6 | 6 | 68 / 71 | 7 / 9 | 2560x1600 | – | 167 | – |  | view 0,0 1280x800 in content 1,0 31x35; page 1280x800 at 2x |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 22.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 45 / 53 | 13 / 26 | 2560x1600 | 22 / 31 | 175 | – |  | view 0,0 1280x800 in content 1,0 31x35; page 1280x800 at 2x |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 40 / 51 | 5 / 15 | 2560x1600 | 24 / 29 | 168 | – |  | view 0,0 1280x800 in content 1,0 31x35; page 1280x800 at 2x |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 147 / 153 | -45 / -40 | 2560x1600 | – | 216 | – |  | view 0,0 1280x800 in content 1,0 31x35; page 1280x800 at 2x |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 68 / 70 | 7 / 9 | 2560x1600 | – | 163 | – |  | view 0,0 1280x800 in content 1,0 31x35; page 1280x800 at 2x |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 22.0 |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePageHidden | 6/6 | 6 | 44 / 51 | 34 / 47 | 2560x1600 | 22 / 29 | 160 | – |  | view 0,0 1280x800 in content 1,0 31x35; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | capturePage | 6/6 | 6 | 41 / 52 | 12 / 14 | 2560x1600 | 23 / 27 | 162 | – |  | view 0,0 1280x800 in content 1,0 31x35; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | cdpJpeg | 6/6 | 6 | 70 / 73 | -44 / -34 | 1280x800 | – | 109 | – |  | view 0,0 1280x800 in content 1,0 31x35; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | frameSub | 6/6 | 6 | 67 / 75 | 8 / 10 | 2560x1600 | – | 164 | – |  | view 0,0 1280x800 in content 1,0 31x35; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 21.5 |  |  |
| osr | false | osrPaint | 6/6 | 0 | 0 / 1 | – | 512x360 | – | 18 | – |  | view - in content 1,0 511x360; page 512x360 at 1x |
| osr | false | capturePage | 6/6 | 0 | 21 / 25 | – | 512x360 | 10 / 11 | 31 | – |  | view - in content 1,0 511x360; page 512x360 at 1x |
| osr | false | cdpJpeg | 6/6 | 0 | 99 / 101 | – | 512x360 | – | 33 | – |  | view - in content 1,0 511x360; page 512x360 at 1x |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | – | 215 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | – | 3 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 145 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 106 | privateBytes | 206 | 3 | 0.0 |
| 1 | 131 | privateBytes | 288 | 4 | 0.1 |
| 2 | 160 | privateBytes | 371 | 5 | 0.2 |
| 4 | 215 | privateBytes | 536 | 7 | 0.5 |
| 8 | 321 | privateBytes | 864 | 11 | 0.8 |

Per idle tab resting in the never-shown window (a still page): **27 MiB**, 0.09% CPU. Four tabs: one partition +105 MiB, four partitions +103 MiB.

Quiet tabs working in one shared 1×1 host (no rAF loop; the page repaints twice a second): **29 MiB** and 1.58% CPU a tab (0: 135 MiB / 0.9%, 1: 159 MiB / 1.6%, 4: 244 MiB / 6.8%, 8: 366 MiB / 13.5%).

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 54.1 | 26.2 | 27.6 | 64 |
| animated, never-shown window, throttling off | 2.3 | 1.8 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.2 | 0.0 | 0.0 | 0 |
| animated, never-shown window, throttling off + frame pump | 1.9 | 1.7 | 0.1 | 0 |
| animated, invisible shown window | 60.0 | 31.1 | 28.7 | 64 |
| animated, 1x1 shown window | 33.2 | 29.2 | 4.0 | 64 |
| animated, osr 30 fps | 12.4 | 6.8 | 3.0 | 30 |

**One host, 4 tabs (each held at 1280×800, 1×):** tab 1 rAF 64 Hz, capturePage 4/4 in 50 / 50 ms (2560x1600); tab 2 rAF 62 Hz, capturePage 4/4 in 48 / 56 ms (2560x1600); tab 3 rAF 61 Hz, capturePage 4/4 in 47 / 53 ms (2560x1600); tab 4 rAF 60 Hz, capturePage 4/4 in 49 / 54 ms (2560x1600)

**Assertions:** PASS capturePage works in the host with the agent's 1280x800 at 1x held; PASS every tab in one shared host draws and is pictured

### Electron · windows (electron-windows.json)

Electron 45.2.2 (Chromium 156.0.8078.80), win32-x64 10.0.26100, ozone (default), displays 1024x768@1, status **done**, 883 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.91 | 26.9 | 41 / 102 | 1 / 61 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.96 | 28.6 | 37 / 51 | 12 / 16 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.0 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.96 | 28.6 | 31 / 47 | 8 / 15 | 1280x800@1 → 1000x700@1 → 1280x800 | 1 / 3 | 2.1 |  |
| invisibleWindow | true | true | true | true (1) | 0.97 | 28.8 | 34 / 42 | 11 / 11 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 64.0 |  |
| tinyWindow | true | true | true | true (1) | 0.96 | 28.8 | 36 / 41 | 13 / 13 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 64.0 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | IO / RO Hz | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 100.0 | 93.2 | 64.0 | 18 | 2.0 / 2.0 | – | – | – | 6.9 | 12.4 |  |
| detached, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.3 |  |
| detached, throttling off | visible | 1280x800 | 100.0 | 95.8 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 2.1 | 2.2 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 2.0 | 1.6 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.1 | 0.2 |  |
| never-shown window, throttling off | visible | 1280x800 | 100.0 | 96.8 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 1.8 | 1.9 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 100.0 | 90.6 | 1.0 | 1001 | 0.0 / 0.0 | – | – | – | 1.4 | 1.7 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 100.0 | 96.6 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 1.7 | 1.8 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 100.0 | 96.6 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 1.6 | 1.8 |  |
| invisible shown window, throttling off | visible | 1280x800 | 100.1 | 91.9 | 64.0 | 18 | 2.0 / 2.0 | – | – | – | 6.2 | 11.2 |  |
| 1x1 shown window, throttling off | visible | 1280x800 | 100.0 | 91.4 | 64.0 | 18 | 2.0 / 2.0 | – | – | – | 5.8 | 9.7 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 100.0 | 91.8 | 64.0 | 18 | 2.0 / 2.0 | – | – | – | 6.2 | 10.3 | cover 0,0 1024x720 over host 0,0 32x32 |
| 1x1 shown window kept above a cover window (always on top) | visible | 1280x800 | 100.0 | 92.8 | 64.0 | 18 | 2.0 / 2.0 | – | – | – | 6.8 | 11.4 | cover 0,0 1024x720 over host 0,0 32x32 |
| invisible shown window, covered by another window | visible | 1280x800 | 100.0 | 92.0 | 64.2 | 18 | 2.2 / 2.2 | – | – | – | 6.2 | 11.3 | cover 0,0 1024x720 over host 0,0 1024x720 |
| 1x1 shown window, throttling on (control) | visible | 1280x800 | 100.2 | 91.8 | 64.0 | 17 | 2.2 / 2.0 | – | – | – | 6.2 | 10.3 |  |
| 1x1 shown window, throttling on, covered by another window (control) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.2 | cover 0,0 1024x720 over host 0,0 32x32 |
| invisible shown window, throttling on, covered by another window (control) | hidden | 1280x800 | 1.2 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.3 | cover 0,0 1024x720 over host 0,0 1024x720 |
| osr window 30 fps, throttling off | visible | 1024x720 | 100.0 | 90.8 | 30.0 | 35 | 2.0 / 2.0 | – | – | – | 3.7 | 10.0 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 100.2 | 91.2 | 30.0 | 35 | 0.0 / 2.0 | – | – | – | 2.4 | 3.0 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 100.0 | 90.0 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 24.8 | – | 3.0 | 4.0 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 100.0 | 91.0 | 0.0 | 0 | 0.0 / 0.0 | 0.84 | 24.8 | – | 3.2 | 4.3 |  |
| detached, throttling off, playing media | visible | 1280x800 | 100.0 | 90.8 | 0.0 | 0 | 0.0 / 0.0 | 0.84 | 24.8 | – | 3.2 | 4.3 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 100.2 | 96.2 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | to 1280×800 + JPEG ms | CPU ms/picture | frames/s | visibility events | geometry; errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 9 / 21 | 13 / 15 | 1000x700 | 15 / 15 | 92 | – |  | view 0,0 1000x700 in content 48,97 1000x681; page 1000x700 at 1x |
| shown | true | capturePage | 6/6 | 6 | 9 / 16 | 11 / 14 | 1000x700 | 13 / 14 | 95 | – |  | view 0,0 1000x700 in content 48,97 1000x681; page 1000x700 at 1x |
| shown | true | cdpJpeg | 6/6 | 6 | 68 / 73 | -37 / -35 | 1000x700 | – | 106 | – |  | view 0,0 1000x700 in content 48,97 1000x681; page 1000x700 at 1x |
| shown | true | frameSub | 6/6 | 6 | 21 / 26 | 2 / 15 | 1000x700 | – | 73 | – |  | view 0,0 1000x700 in content 48,97 1000x681; page 1000x700 at 1x |
| shown | true | cdpPng | 6/6 | 6 | 209 / 224 | -39 / -38 | 1000x700 | – | 319 | – |  | view 0,0 1000x700 in content 48,97 1000x681; page 1000x700 at 1x |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.5 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 3 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | – | 3 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 131 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | – | 98 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 3 | – |  | view 0,0 1280x800 in content 8,57 1008x681; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | – | 3 | – |  | view 0,0 1280x800 in content 8,57 1008x681; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 3975 / 3979 | -2941 / -53 | 1280x800 | – | 138 | – |  | view 0,0 1280x800 in content 8,57 1008x681; page 1280x800 at 1x |
| hiddenWindow | false | frameSub | 6/6 | 6 | 9 / 9 | 63 / 75 | 1280x800 | – | 42 | – |  | view 0,0 1280x800 in content 8,57 1008x681; page 1280x800 at 1x |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.5 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 8,57 1008x681; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 8,57 1008x681; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 73 / 99 | -47 / -33 | 1280x800 | – | 141 | – |  | view 0,0 1280x800 in content 8,57 1008x681; page 1280x800 at 1x |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 23 / 24 | 1 / 2 | 1280x800 | – | 86 | – |  | view 0,0 1280x800 in content 8,57 1008x681; page 1280x800 at 1x |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 6/6 | 6 | 19 / 24 | 3 / 6 | 1280x800 | – | 89 | – |  | view 0,0 1280x800 in content 0,0 1024x720; page 1280x800 at 1x |
| invisibleWindow | false | capturePage | 6/6 | 6 | 21 / 23 | 2 / 6 | 1280x800 | – | 87 | – |  | view 0,0 1280x800 in content 0,0 1024x720; page 1280x800 at 1x |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 72 / 83 | -35 / -34 | 1280x800 | – | 133 | – |  | view 0,0 1280x800 in content 0,0 1024x720; page 1280x800 at 1x |
| invisibleWindow | false | frameSub | 6/6 | 6 | 24 / 25 | 5 / 8 | 1280x800 | – | 84 | – |  | view 0,0 1280x800 in content 0,0 1024x720; page 1280x800 at 1x |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 20 / 25 | 3 / 15 | 1280x800 | – | 63 | – |  | view 0,0 1280x800 in content 0,0 32x32; page 1280x800 at 1x |
| tinyWindow | false | capturePage | 6/6 | 6 | 22 / 25 | 0 / 5 | 1280x800 | – | 68 | – |  | view 0,0 1280x800 in content 0,0 32x32; page 1280x800 at 1x |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 74 / 85 | -43 / -34 | 1280x800 | – | 100 | – |  | view 0,0 1280x800 in content 0,0 32x32; page 1280x800 at 1x |
| tinyWindow | false | frameSub | 6/6 | 6 | 24 / 26 | 5 / 7 | 1280x800 | – | 58 | – |  | view 0,0 1280x800 in content 0,0 32x32; page 1280x800 at 1x |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 20 / 23 | 2 / 7 | 1280x800 | – | 66 | – |  | view 0,0 1280x800 in content 0,0 32x32; page 1280x800 at 1x |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 21 / 24 | 1 / 5 | 1280x800 | – | 61 | – |  | view 0,0 1280x800 in content 0,0 32x32; page 1280x800 at 1x |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 71 / 79 | -34 / -33 | 1280x800 | – | 95 | – |  | view 0,0 1280x800 in content 0,0 32x32; page 1280x800 at 1x |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 23 / 26 | 5 / 8 | 1280x800 | – | 61 | – |  | view 0,0 1280x800 in content 0,0 32x32; page 1280x800 at 1x |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePageHidden | 6/6 | 6 | 22 / 24 | 1 / 8 | 1280x800 | – | 60 | – |  | view 0,0 1280x800 in content 0,0 32x32; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | capturePage | 6/6 | 6 | 21 / 24 | 2 / 15 | 1280x800 | – | 60 | – |  | view 0,0 1280x800 in content 0,0 32x32; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | cdpJpeg | 6/6 | 6 | 72 / 84 | -36 / -33 | 1280x800 | – | 98 | – |  | view 0,0 1280x800 in content 0,0 32x32; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | frameSub | 6/6 | 6 | 24 / 28 | 4 / 9 | 1280x800 | – | 63 | – |  | view 0,0 1280x800 in content 0,0 32x32; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 1 | 28 / 32 | 1024x720 | – | 29 | – |  | view - in content 0,0 1024x720; page 1024x720 at 1x |
| osr | false | capturePage | 6/6 | 6 | 19 / 39 | -11 / -10 | 1024x720 | 12 / 12 | 59 | – |  | view - in content 0,0 1024x720; page 1024x720 at 1x |
| osr | false | cdpJpeg | 6/6 | 6 | 99 / 101 | -81 / -76 | 1024x720 | – | 74 | – |  | view - in content 0,0 1024x720; page 1024x720 at 1x |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | – | 212 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | – | 3 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 176 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 147 | privateBytes | 165 | 4 | 0.0 |
| 1 | 175 | privateBytes | 242 | 5 | 0.1 |
| 2 | 200 | privateBytes | 314 | 6 | 0.2 |
| 4 | 255 | privateBytes | 467 | 8 | 0.4 |
| 8 | 364 | privateBytes | 771 | 12 | 0.6 |

Per idle tab resting in the never-shown window (a still page): **27 MiB**, 0.07% CPU. Four tabs: one partition +97 MiB, four partitions +102 MiB.

Quiet tabs working in one shared 1×1 host (no rAF loop; the page repaints twice a second): **28 MiB** and 0.94% CPU a tab (0: 175 MiB / 0.9%, 1: 200 MiB / 1.2%, 4: 283 MiB / 5.0%, 8: 397 MiB / 8.4%).

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 50.0 | 28.3 | 21.4 | 64 |
| animated, never-shown window, throttling off | 2.6 | 1.9 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.2 | 0.0 | 0.0 | 0 |
| animated, never-shown window, throttling off + frame pump | 2.5 | 2.3 | 0.1 | 0 |
| animated, invisible shown window | 68.5 | 39.3 | 29.0 | 64 |
| animated, 1x1 shown window | 42.8 | 37.6 | 5.0 | 64 |
| animated, osr 30 fps | 32.5 | 16.9 | 11.0 | 30 |

**Waking a resting tab into the host** (never-shown window, throttling on, 4 cycles): first rAF 1 / 5 ms, fresh picture 38 / 43 ms; resting rates 1.2 Hz / rAF 0.0, 1.0 Hz / rAF 0.0, 1.1 Hz / rAF 0.0, 1.1 Hz / rAF 0.0; awake rAF 64, 64, 64, 64

**One host, 4 tabs (each held at 1280×800, 1×):** tab 1 rAF 64 Hz, capturePage 4/4 in 18 / 20 ms (1280x800); tab 2 rAF 64 Hz, capturePage 4/4 in 20 / 26 ms (1280x800); tab 3 rAF 64 Hz, capturePage 4/4 in 13 / 18 ms (1280x800); tab 4 rAF 64 Hz, capturePage 4/4 in 19 / 20 ms (1280x800)

**The host's invariants:** host 100,100 32x32, focused at start false, after its page grabs focus false (focused window "S7 probe"); Windows styles {"style":"0x14c00000","exStyle":"0x82801a0","toolWindow":true,"noActivate":true,"transparent":true,"layered":true,"appWindow":false}; click-through {"at":"116,116","tool":"SendInput via user32 SetCursorPos and mouse_event","belowClicks":1,"hostClicks":0}

**Assertions:** PASS no reload when moving from detached; PASS no reload when moving from hiddenWindow; PASS no reload when moving from hiddenWindowFit; PASS no reload when moving from invisibleWindow; PASS no reload when moving from tinyWindow; PASS the host (1x1; 32x32 on Windows) draws (rAF above 10 Hz); PASS a never-shown window draws nothing (rAF below 1 Hz); PASS capturePage works in the host; PASS capturePage works in the host with the agent's 1280x800 at 1x held; PASS the host never takes focus, even when its page asks; PASS Windows: the host is a no-activate, click-through tool window, not an app window; PASS Windows: a real click at the host's point reaches the window below; PASS a resting tab draws within 2 s of moving into the host, every cycle; PASS every tab in one shared host draws and is pictured

**Q6 streamed view** (10 s at the viewer; latency p50 / p95 ms)

| road | content | source | fps | decoded fps | latency | gap p95 | kbit/s | bytes/frame | sender CPU % | viewer CPU % | source rAF | notes |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| screencast | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 3 | 0 | 0 |  |
| capturePoll | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 3 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | anim | hiddenWindow | 25.2 | 25.2 | 39 / 42 | 65 | 2505 | 12427 | 93 | 20 | 64 | libvpx; video/VP8 |
| webrtc-h264 | anim | hiddenWindow | 14.8 | 14.8 | 55 / 57 | 81 | 2487 | 21003 | 92 | 13 | 64 | OpenH264; video/H264 |
| webcodecs-vp8 | anim | hiddenWindow | 30.1 | 30.1 | 34 / 36 | 48 | 2181 | 9086 | 108 | 19 | 64 |  |
| webcodecs-h264 | anim | hiddenWindow | 30.0 | 30.0 | 32 / 34 | 48 | 2160 | 8998 | 100 | 17 | 64 |  |
| screencast | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | 0 |  |
| capturePoll | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | static | hiddenWindow | 2.0 | 2.0 | 80 / 80 | 509 | 557 | 34829 | 9 | 3 | 64 | libvpx; video/VP8 |
| webrtc-h264 | static | hiddenWindow | 1.0 | 1.0 | 21 / 21 | 1001 | 17 | 2178 | 7 | 1 | 64 | OpenH264; video/H264 |
| webcodecs-vp8 | static | hiddenWindow | 2.9 | 2.9 | 19 / 114 | 502 | 194 | 8368 | 10 | 2 | 64 |  |
| webcodecs-h264 | static | hiddenWindow | 2.0 | 2.0 | 18 / 21 | 503 | 99 | 6209 | 6 | 1 | 64 |  |
| screencast | anim | invisibleWindow | 63.9 | 63.9 | 41 / 44 | 20 | 60542 | 118246 | 188 | 41 | 64 |  |
| capturePoll | anim | invisibleWindow | 30.8 | 30.8 | 39 / 47 | 41 | 29265 | 118770 | 125 | 18 | 64 | toJPEG 8.2 ms |
| webcodecs-h264 | anim | invisibleWindow | 30.0 | 30.0 | 36 / 41 | 48 | 2166 | 9023 | 140 | 20 | 64 |  |
| screencast | anim | tinyWindow | 64.1 | 64.1 | 39 / 42 | 19 | 60569 | 118298 | 181 | 39 | 64 |  |
| webcodecs-h264 | anim | tinyWindow | 30.0 | 30.0 | 34 / 37 | 48 | 2164 | 9017 | 115 | 18 | 64 |  |
| screencast | anim | shown | 63.9 | 63.9 | 35 / 42 | 19 | 50751 | 99278 | 144 | 34 | 64 |  |
| webrtc-vp8 | anim | shown | 24.4 | 24.4 | 56 / 58 | 74 | 2491 | 12760 | 141 | 20 | 64 | libvpx; video/VP8 |
| webcodecs-h264 | anim | shown | 30.0 | 30.0 | 43 / 46 | 48 | 2196 | 9148 | 141 | 19 | 64 |  |

### The pair · linux-x64 (pair-linux.json)

7.0.0-1017-azure, 40 s, state **done**

- **login start**: {"daemonUpMs":114,"daemonUp":true,"appConnectedMs":3776,"appStartedBy":"daemon","appStart":{"at":1793871238139,"safeMode":false,"reason":"daemon start","ok":true,"how":"systemctl --user start clover-s7-app-290dc9ac.service","out":""},"daemonParent":1062}
- **second daemon on the same home**: {"exitCode":0,"ms":38,"said":"2026-11-05T09:33:59.701Z [core 2324] another daemon holds this home (flock: held by another process) and answers on its socket; exiting","firstStillServing":true}
- **app crash**: {"killed":2274,"kill":{"ok":true,"how":"kill -9 2274","code":0,"out":""},"restartedMs":1625,"newPid":2335,"startedBy":"daemon","safeMode":false,"how":"systemctl --user start clover-s7-app-290dc9ac.service","eventsSinceKill":["start","tray","connected"]}
- **app crash loop → safe mode**: {"rounds":[{"killed":2335,"restartedMs":2225,"safeMode":false,"crashesInDaemon":2},{"killed":2385,"restartedMs":4246,"safeMode":true,"crashesInDaemon":3}],"thirdRestartInSafeMode":true}
- **daemon crash, restarted by the OS alone**: {"killed":2262,"kill":{"ok":true,"how":"kill -9 2262","code":0,"out":""},"daemonBackMs":1207,"newDaemonPid":2512,"appSurvived":true,"appPidAfter":2448,"samePid":true,"appStartedTheDaemon":false,"appEvents":["3ms daemon-lost","1507ms connected","1507ms reconnected"]}
- **daemon crash, the app helps after 3 s**: {"killed":2512,"kill":{"ok":true,"how":"kill -9 2512","code":0,"out":""},"daemonBackMs":1205,"newDaemonPid":2523,"appSurvived":true,"appPidAfter":2448,"samePid":true,"appStartedTheDaemon":false,"appEvents":["1ms daemon-lost","1506ms connected","1506ms reconnected"]}
- **tray Quit stops both, and they stay down**: {"forwarded":{"forwarded":true},"bothDownMs":402,"restartedWithin12s":false,"appEvents":["quit","quit-acked","daemon-quitting"]}
- **a user starts the app → it starts the daemon**: {"start":{"ok":true,"how":"spawn detached (as from a launcher)","code":0,"out":"2538"},"bothUpMs":511,"startedBy":"user","appStartedTheDaemon":[{"ok":true,"how":"systemctl --user start clover-s7-core-290dc9ac.service","out":""}],"appEvents":["start","tray","start-daemon","connected"]}
- **the daemon side's Quit stops both**: {"bothDownMs":401,"restartedWithin8s":false}
- **a held lock, no daemon answering**: {"exitCode":1,"signal":null,"exitMs":3050,"saidNoAnswer":true,"saidStayedHeld":true,"said":"2026-11-05T09:34:34.747Z [core 2614] the lock is held (flock: held by another process) but no daemon answers on the socket; trying again | 2026-11-05T09:34:35.247Z [core 2614] the lock stayed held and no daemon answered; exiting 1 so the daemon is started again","nextStartUpMs":106,"nextStartStopped":true}

**Assertions:** PASS the login item starts the daemon, and the daemon the app; PASS a second daemon is refused and exits 0; PASS a crashed app is back within 6 s; PASS the start after the third crash in two minutes is in safe mode; PASS a crashed daemon is back within 5 s without the app's help; PASS a crashed daemon is back within 10 s, and the app lives on; PASS the tray's Quit stops both, and nothing restarts them; PASS a user's start of the app brings up both within 10 s; PASS the daemon side's Quit stops both, and nothing restarts them; PASS with its lock held by another process and no daemon answering, the daemon exits 1 within 15 s, and comes up once the lock is free

### The pair · darwin-arm64 (pair-macos.json)

25.6.0, 39 s, state **done**

- **login start**: {"daemonUpMs":117,"daemonUp":true,"appConnectedMs":3174,"appStartedBy":"daemon","appStart":{"at":1793873727076,"safeMode":false,"reason":"daemon start","ok":true,"how":"open -n -g -a /Users/runner/work/clover/clover/spikes/s7-browser/prototype/node_modules/electron/dist/Electron.app --args /Users/runner/work/clover/clover/spikes/s7-browser/prototype/out/pair/app --home=/var/folders/n6/hn37q6pj7sj_9dmqqc2113800000gn/T/clover-s7-pair-YPepsp","out":""},"daemonParent":1}
- **second daemon on the same home**: {"exitCode":0,"ms":246,"said":"2026-11-05T10:15:28.035Z [core 1496] another daemon holds this home (flock: held by another process) and answers on its socket; exiting","firstStillServing":true}
- **app crash**: {"killed":1487,"kill":{"ok":true,"how":"kill -9 1487","code":0,"out":""},"restartedMs":1428,"newPid":1502,"startedBy":"daemon","safeMode":false,"how":"open -n -g -a /Users/runner/work/clover/clover/spikes/s7-browser/prototype/node_modules/electron/dist/Electron.app --args /Users/runner/work/clover/clover/spikes/s7-browser/prototype/out/pair/app --home=/var/folders/n6/hn37q6pj7sj_9dmqqc2113800000gn/T/clover-s7-pair-YPepsp","eventsSinceKill":["start","tray","connected"]}
- **app crash loop → safe mode**: {"rounds":[{"killed":1502,"restartedMs":2367,"safeMode":false,"crashesInDaemon":2},{"killed":1592,"restartedMs":4345,"safeMode":true,"crashesInDaemon":3}],"thirdRestartInSafeMode":true}
- **daemon crash, restarted by the OS alone**: {"killed":1478,"kill":{"ok":true,"how":"kill -9 1478","code":0,"out":""},"daemonBackMs":236,"newDaemonPid":1604,"appSurvived":true,"appPidAfter":1601,"samePid":true,"appStartedTheDaemon":false,"appEvents":["3ms daemon-lost","513ms connected","514ms reconnected"]}
- **daemon crash, the app helps after 3 s**: {"killed":1604,"kill":{"ok":true,"how":"kill -9 1604","code":0,"out":""},"daemonBackMs":1212,"newDaemonPid":1608,"appSurvived":true,"appPidAfter":1601,"samePid":true,"appStartedTheDaemon":false,"appEvents":["2ms daemon-lost","1509ms connected","1509ms reconnected"]}
- **tray Quit stops both, and they stay down**: {"forwarded":{"forwarded":true},"bothDownMs":411,"restartedWithin12s":false,"appEvents":["quit","quit-acked"]}
- **a user starts the app → it starts the daemon**: {"start":{"ok":true,"how":"open -n -g -a /Users/runner/work/clover/clover/spikes/s7-browser/prototype/node_modules/electron/dist/Electron.app --args /Users/runner/work/clover/clover/spikes/s7-browser/prototype/out/pair/app --home=/var/folders/n6/hn37q6pj7sj_9dmqqc2113800000gn/T/clover-s7-pair-YPepsp","code":0,"out":""},"bothUpMs":895,"startedBy":"user","appStartedTheDaemon":[{"ok":true,"how":"launchctl kickstart gui/501/com.waifucave.clover.s7.core.abc521cc","out":""}],"appEvents":["start","tray","start-daemon","connected"]}
- **the daemon side's Quit stops both**: {"bothDownMs":306,"restartedWithin8s":false}
- **a held lock, no daemon answering**: {"exitCode":1,"signal":null,"exitMs":3107,"saidNoAnswer":true,"saidStayedHeld":true,"said":"2026-11-05T10:16:02.903Z [core 1946] the lock is held (flock: held by another process) but no daemon answers on the socket; trying again | 2026-11-05T10:16:03.405Z [core 1946] the lock stayed held and no daemon answered; exiting 1 so the daemon is started again","nextStartUpMs":110,"nextStartStopped":true}

**Assertions:** PASS the login item starts the daemon, and the daemon the app; PASS a second daemon is refused and exits 0; PASS a crashed app is back within 6 s; PASS the start after the third crash in two minutes is in safe mode; PASS a crashed daemon is back within 5 s without the app's help; PASS a crashed daemon is back within 10 s, and the app lives on; PASS the tray's Quit stops both, and nothing restarts them; PASS a user's start of the app brings up both within 10 s; PASS the daemon side's Quit stops both, and nothing restarts them; PASS with its lock held by another process and no daemon answering, the daemon exits 1 within 15 s, and comes up once the lock is free

### The pair · win32-x64 (pair-windows-spawn.json)

10.0.26100, 191 s, state **done**, Windows app start: spawn

- **login start**: {"daemonUpMs":335,"daemonUp":true,"appConnectedMs":3489,"appStartedBy":"daemon","appStart":{"at":1793871252940,"safeMode":false,"reason":"daemon start","ok":true,"how":"spawn detached","out":"5584"},"daemonParent":2656}
- **second daemon on the same home**: {"exitCode":0,"ms":67,"said":"2026-11-05T09:34:13.245Z [core 8080] another daemon holds this home (CreateFileW: error 32 (sharing violation: another process holds it)) and answers on its socket; exiting","firstStillServing":true}
- **app crash**: {"killed":5584,"kill":{"ok":true,"how":"taskkill /F /T /PID 5584","code":0,"out":"SUCCESS: The process with PID 8164 (child process of PID 5584) has been terminated.\r\nSUCCESS: The process with PID 7620 (child process of PID 5584) has been ter"},"restartedMs":1132,"newPid":5160,"startedBy":"daemon","safeMode":false,"how":"spawn detached","eventsSinceKill":["start","tray","connected"]}
- **app crash loop → safe mode**: {"rounds":[{"killed":5160,"restartedMs":2124,"safeMode":false,"crashesInDaemon":2},{"killed":8668,"restartedMs":4144,"safeMode":true,"crashesInDaemon":3}],"thirdRestartInSafeMode":true}
- **daemon crash, restarted by the OS alone**: {"killed":3868,"kill":{"ok":true,"how":"taskkill /F /PID 3868","code":0,"out":"SUCCESS: The process with PID 3868 has been terminated."},"appSurvived":true,"appPidAfter":5528,"samePid":true,"appStartedTheDaemon":{"atMs":150261,"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-6ac23661"},"appEvents":["47ms daemon-lost","150261ms start-daemon","150778ms connected","150778ms reconnected"]}
- **daemon crash, the app helps after 3 s**: {"killed":6564,"kill":{"ok":true,"how":"taskkill /F /PID 6564","code":0,"out":"SUCCESS: The process with PID 6564 has been terminated."},"daemonBackMs":3263,"newDaemonPid":2900,"appSurvived":true,"appPidAfter":5528,"samePid":true,"appStartedTheDaemon":{"atMs":3152,"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-6ac23661"},"appEvents":["82ms daemon-lost","3152ms start-daemon","3656ms connected","3656ms reconnected"]}
- **tray Quit stops both, and they stay down**: {"forwarded":{"forwarded":true},"bothDownMs":316,"restartedWithin12s":false,"appEvents":["quit","quit-acked"]}
- **a user starts the app → it starts the daemon**: {"start":{"ok":true,"how":"spawn detached","code":0,"out":"6884"},"bothUpMs":547,"startedBy":"user","appStartedTheDaemon":[{"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-6ac23661","out":"SUCCESS: Attempted to run the scheduled task \"\\Clover S7\\core-6ac23661\"."}],"appEvents":["start","tray","start-daemon","connected"]}
- **the daemon side's Quit stops both**: {"bothDownMs":330,"restartedWithin8s":false}
- **a held lock, no daemon answering**: {"exitCode":1,"signal":null,"exitMs":3176,"saidNoAnswer":true,"saidStayedHeld":true,"said":"2026-11-05T09:37:19.516Z [core 4312] the lock is held (CreateFileW: error 32 (sharing violation: another process holds it)) but no daemon answers on the socket; trying again | 2026-11-05T09:37:20.031Z [core 4312] the lock stayed held and no daemon answered; exiting 1 so the daemon is started again","nextStartUpMs":108,"nextStartStopped":true}

**Assertions:** PASS the login item starts the daemon, and the daemon the app; PASS a second daemon is refused and exits 0; PASS a crashed app is back within 6 s; PASS the start after the third crash in two minutes is in safe mode; PASS Task Scheduler alone does not restart a killed task (the finding the supervisor answers); PASS a crashed daemon is back within 10 s, and the app lives on; PASS the tray's Quit stops both, and nothing restarts them; PASS a user's start of the app brings up both within 10 s; PASS the daemon side's Quit stops both, and nothing restarts them; PASS with its lock held by another process and no daemon answering, the daemon exits 1 within 15 s, and comes up once the lock is free

### The pair · win32-x64 (pair-windows-supervise.json)

10.0.26100, 40 s, state **done**, Windows app start: task, daemon under the supervisor

- **login start**: {"daemonUpMs":551,"daemonUp":true,"appConnectedMs":3781,"appStartedBy":"daemon","appStart":{"at":1793871258961,"safeMode":false,"reason":"daemon start","ok":true,"how":"schtasks /Run /TN \\Clover S7\\app-2b528b65","out":"SUCCESS: Attempted to run the scheduled task \"\\Clover S7\\app-2b528b65\"."},"daemonParent":1488}
- **second daemon on the same home**: {"exitCode":0,"ms":90,"said":"2026-11-05T09:34:20.226Z [core 6188] another daemon holds this home (CreateFileW: error 32 (sharing violation: another process holds it)) and answers on its socket; exiting","firstStillServing":true}
- **app crash**: {"killed":8272,"kill":{"ok":true,"how":"taskkill /F /T /PID 8272","code":0,"out":"SUCCESS: The process with PID 8220 (child process of PID 8272) has been terminated.\r\nSUCCESS: The process with PID 7300 (child process of PID 8272) has been ter"},"restartedMs":1189,"newPid":2832,"startedBy":"daemon","safeMode":false,"how":"schtasks /Run /TN \\Clover S7\\app-2b528b65","eventsSinceKill":["start","tray","connected"]}
- **app crash loop → safe mode**: {"rounds":[{"killed":2832,"restartedMs":2202,"safeMode":false,"crashesInDaemon":2},{"killed":3020,"restartedMs":4169,"safeMode":true,"crashesInDaemon":3}],"thirdRestartInSafeMode":true}
- **daemon crash, restarted by the OS alone**: {"killed":1984,"kill":{"ok":true,"how":"taskkill /F /PID 1984","code":0,"out":"SUCCESS: The process with PID 1984 has been terminated."},"daemonBackMs":634,"newDaemonPid":1740,"appSurvived":true,"appPidAfter":9160,"samePid":true,"appStartedTheDaemon":false,"appEvents":["74ms daemon-lost","1080ms connected","1080ms reconnected"]}
- **daemon crash, the app helps after 3 s**: {"killed":1740,"kill":{"ok":true,"how":"taskkill /F /PID 1740","code":0,"out":"SUCCESS: The process with PID 1740 has been terminated."},"daemonBackMs":1252,"newDaemonPid":2876,"appSurvived":true,"appPidAfter":9160,"samePid":true,"appStartedTheDaemon":false,"appEvents":["52ms daemon-lost","1557ms connected","1558ms reconnected"]}
- **tray Quit stops both, and they stay down**: {"forwarded":{"forwarded":true},"bothDownMs":333,"restartedWithin12s":false,"appEvents":["quit-acked"]}
- **a user starts the app → it starts the daemon**: {"start":{"ok":true,"how":"spawn detached","code":0,"out":"4212"},"bothUpMs":549,"startedBy":"user","appStartedTheDaemon":[{"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-2b528b65","out":"SUCCESS: Attempted to run the scheduled task \"\\Clover S7\\core-2b528b65\"."}],"appEvents":["start","tray","start-daemon","connected"]}
- **the daemon side's Quit stops both**: {"bothDownMs":333,"restartedWithin8s":false}
- **a held lock, no daemon answering**: {"exitCode":1,"signal":null,"exitMs":3145,"saidNoAnswer":true,"saidStayedHeld":true,"said":"2026-11-05T09:34:54.990Z [core 6768] the lock is held (CreateFileW: error 32 (sharing violation: another process holds it)) but no daemon answers on the socket; trying again | 2026-11-05T09:34:55.491Z [core 6768] the lock stayed held and no daemon answered; exiting 1 so the daemon is started again","nextStartUpMs":110,"nextStartStopped":true}

**Assertions:** PASS the login item starts the daemon, and the daemon the app; PASS a second daemon is refused and exits 0; PASS a crashed app is back within 6 s; PASS the start after the third crash in two minutes is in safe mode; PASS a crashed daemon is back within 5 s without the app's help; PASS a crashed daemon is back within 10 s, and the app lives on; PASS the tray's Quit stops both, and nothing restarts them; PASS a user's start of the app brings up both within 10 s; PASS the daemon side's Quit stops both, and nothing restarts them; PASS with its lock held by another process and no daemon answering, the daemon exits 1 within 15 s, and comes up once the lock is free

### The pair · win32-x64 (pair-windows-task.json)

10.0.26100, 191 s, state **done**, Windows app start: task

- **login start**: {"daemonUpMs":371,"daemonUp":true,"appConnectedMs":2741,"appStartedBy":"daemon","appStart":{"at":1793871262348,"safeMode":false,"reason":"daemon start","ok":true,"how":"schtasks /Run /TN \\Clover S7\\app-3e5f0458","out":"SUCCESS: Attempted to run the scheduled task \"\\Clover S7\\app-3e5f0458\"."},"daemonParent":2632}
- **second daemon on the same home**: {"exitCode":0,"ms":85,"said":"2026-11-05T09:34:22.676Z [core 2044] another daemon holds this home (CreateFileW: error 32 (sharing violation: another process holds it)) and answers on its socket; exiting","firstStillServing":true}
- **app crash**: {"killed":1060,"kill":{"ok":true,"how":"taskkill /F /T /PID 1060","code":0,"out":"SUCCESS: The process with PID 7300 (child process of PID 1060) has been terminated.\r\nSUCCESS: The process with PID 6104 (child process of PID 1060) has been ter"},"restartedMs":1163,"newPid":836,"startedBy":"daemon","safeMode":false,"how":"schtasks /Run /TN \\Clover S7\\app-3e5f0458","eventsSinceKill":["start","tray","connected"]}
- **app crash loop → safe mode**: {"rounds":[{"killed":836,"restartedMs":2199,"safeMode":false,"crashesInDaemon":2},{"killed":3500,"restartedMs":4194,"safeMode":true,"crashesInDaemon":3}],"thirdRestartInSafeMode":true}
- **daemon crash, restarted by the OS alone**: {"killed":1752,"kill":{"ok":true,"how":"taskkill /F /PID 1752","code":0,"out":"SUCCESS: The process with PID 1752 has been terminated."},"appSurvived":true,"appPidAfter":3056,"samePid":true,"appStartedTheDaemon":{"atMs":150533,"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-3e5f0458"},"appEvents":["67ms daemon-lost","150533ms start-daemon","151049ms connected","151050ms reconnected"]}
- **daemon crash, the app helps after 3 s**: {"killed":3924,"kill":{"ok":true,"how":"taskkill /F /PID 3924","code":0,"out":"SUCCESS: The process with PID 3924 has been terminated."},"daemonBackMs":3300,"newDaemonPid":7236,"appSurvived":true,"appPidAfter":3056,"samePid":true,"appStartedTheDaemon":{"atMs":3108,"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-3e5f0458"},"appEvents":["61ms daemon-lost","3108ms start-daemon","3621ms connected","3621ms reconnected"]}
- **tray Quit stops both, and they stay down**: {"forwarded":{"forwarded":true},"bothDownMs":328,"restartedWithin12s":false,"appEvents":["quit","quit-acked"]}
- **a user starts the app → it starts the daemon**: {"start":{"ok":true,"how":"spawn detached","code":0,"out":"4852"},"bothUpMs":569,"startedBy":"user","appStartedTheDaemon":[{"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-3e5f0458","out":"SUCCESS: Attempted to run the scheduled task \"\\Clover S7\\core-3e5f0458\"."}],"appEvents":["start","tray","start-daemon","connected"]}
- **the daemon side's Quit stops both**: {"bothDownMs":321,"restartedWithin8s":false}
- **a held lock, no daemon answering**: {"exitCode":1,"signal":null,"exitMs":3134,"saidNoAnswer":true,"saidStayedHeld":true,"said":"2026-11-05T09:37:29.469Z [core 8072] the lock is held (CreateFileW: error 32 (sharing violation: another process holds it)) but no daemon answers on the socket; trying again | 2026-11-05T09:37:29.973Z [core 8072] the lock stayed held and no daemon answered; exiting 1 so the daemon is started again","nextStartUpMs":106,"nextStartStopped":true}

**Assertions:** PASS the login item starts the daemon, and the daemon the app; PASS a second daemon is refused and exits 0; PASS a crashed app is back within 6 s; PASS the start after the third crash in two minutes is in safe mode; PASS Task Scheduler alone does not restart a killed task (the finding the supervisor answers); PASS a crashed daemon is back within 10 s, and the app lives on; PASS the tray's Quit stops both, and nothing restarts them; PASS a user's start of the app brings up both within 10 s; PASS the daemon side's Quit stops both, and nothing restarts them; PASS with its lock held by another process and no daemon answering, the daemon exits 1 within 15 s, and comes up once the lock is free

### Electron · dialogs-linux-wayland (electron-viewport-linux-wayland-dialogs.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone wayland, displays 1920x1080@1, status **done**, 22 s

**Round twelve, JavaScript dialogs answered over CDP**

| tab | dialog | CDP event | browser handler | windows during | windows after | page | error |
| :- | :- | :- | :- | :- | :- | :- | :- |
| offscreen tab | alert | true | true | "no way to list windows here (Wayland or no display)" | "no way to list windows here (Wayland or no display)" | alert:"returned":53ms |  |
| offscreen tab | confirm | true | true | "no way to list windows here (Wayland or no display)" | "no way to list windows here (Wayland or no display)" | alert:"returned":53ms | confirm:true:25ms |  |
| offscreen tab | prompt | false | – | "no way to list windows here (Wayland or no display)" | "no way to list windows here (Wayland or no display)" | alert:"returned":53ms | confirm:true:25ms |  |
| host window tab | alert | true | true | "no way to list windows here (Wayland or no display)" | "no way to list windows here (Wayland or no display)" | alert:"returned":26ms |  |
| host window tab | confirm | true | true | "no way to list windows here (Wayland or no display)" | "no way to list windows here (Wayland or no display)" | alert:"returned":26ms | confirm:true:26ms |  |
| host window tab | prompt | false | – | "no way to list windows here (Wayland or no display)" | "no way to list windows here (Wayland or no display)" | alert:"returned":26ms | confirm:true:26ms |  |
| offscreen tab, disableDialogs | alert | true | true | "no way to list windows here (Wayland or no display)" | "no way to list windows here (Wayland or no display)" | alert:"returned":2ms | handle: No dialog is showing |
| offscreen tab, disableDialogs | confirm | true | true | "no way to list windows here (Wayland or no display)" | "no way to list windows here (Wayland or no display)" | alert:"returned":2ms | confirm:false:0ms | handle: No dialog is showing |
| offscreen tab, disableDialogs | prompt | false | – | "no way to list windows here (Wayland or no display)" | "no way to list windows here (Wayland or no display)" | alert:"returned":2ms | confirm:false:0ms |  |

**Assertions:** PASS CDP sees every alert and confirm, offscreen, in the host window and with disableDialogs

### Electron · viewport-linux-wayland (electron-viewport-linux-wayland.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone wayland, displays 1920x1080@1, status **done**, 150 s

**Round twelve, offscreen bot tabs** (never-shown OSR windows; GPU "disabled_software")

Size: default: window 1280x800, page 1280x800@1 → **default**.

Shared textures: 0 textures, 0 bitmaps, 0 empty paints in 3 s → **none here (CPU bitmaps)**; error not asked for: GPU compositing is "disabled_software" here (asking hung the main process on the Linux runners)

| config | visibility | rAF Hz | paints/s | textures/s | all CPU % | renderer % | GPU % | browser % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| offscreen, bitmap, 10 fps, animated | visible | 10.0 | 10.0 | 0.0 | 7.0 | 3.8 | 1.0 | 2.3 |  |
| offscreen, bitmap, 30 fps, animated | visible | 30.0 | 30.0 | 0.0 | 19.2 | 8.3 | 3.8 | 7.3 |  |
| offscreen, bitmap, 60 fps, animated | visible | 60.0 | 60.0 | 0.0 | 32.0 | 13.8 | 6.0 | 12.3 |  |
| offscreen, bitmap, 30 fps, painting stopped, animated | visible | 30.0 | 0.0 | 0.0 | 11.5 | 7.7 | 3.3 | 0.5 |  |
| offscreen, bitmap, 10 fps, quiet page | visible | 0.0 | 4.3 | 0.0 | 3.3 | 0.8 | 0.8 | 1.8 |  |
| offscreen, bitmap, painting stopped, quiet page | visible | 0.0 | 0.0 | 0.0 | 1.5 | 0.5 | 0.8 | 0.3 |  |
| host window, animated | visible | 40.0 | 0.0 | 0.0 | 12.8 | 10.3 | 1.5 | 1.0 |  |
| host window, quiet page | visible | 0.0 | 0.0 | 0.0 | 1.3 | 0.5 | 0.3 | 0.5 |  |

| pictures of | method | ok | ms | stale ms | size | errors |
| :- | :- | :- | :- | :- | :- | :- |
| offscreen, bitmap, painting on (10 fps) | capturePage | 5/5 | 97 / 98 | -86 / -54 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | cdpJpeg | 5/5 | 297 / 311 | -273 / -272 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | osrPaint | 5/5 | 0 / 1 | 29 / 34 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | newest paint → JPEG | 5/5 | 5 / 6 | – | 1280x800 |  |
| offscreen, bitmap, painting stopped | capturePage | 5/5 | 97 / 99 | -88 / -68 | 1280x800 |  |
| offscreen, bitmap, painting stopped | cdpJpeg | 5/5 | 300 / 310 | -276 / -276 | 1280x800 |  |
| host window | capturePage | 5/5 | 23 / 24 | 36 / 39 | 1280x800 |  |
| host window | cdpJpeg | 5/5 | 123 / 136 | -53 / -51 | 1280x800 |  |

| cost | MiB a tab | CPU % a tab | kind | error |
| :- | :- | :- | :- | :- |
| 4 quiet offscreen tabs (bitmap, 10 fps) | 56.5 | 2.31 | pss |  |
| 4 quiet offscreen tabs (bitmap), painting stopped | 23.0 | 1.29 | pss |  |
| 4 quiet tabs in one shared host window | 30.6 | 0.81 | pss |  |

Windows on screen: 4 offscreen tabs open (nothing else shown): no way to list windows here (Wayland or no display); 4 tabs in the shared host window: no way to list windows here (Wayland or no display)

**Round twelve, the viewport** (mode **bitmap**: no shared textures on this machine (GPU compositing "disabled_software"): CPU bitmaps)

Shows: #1 first frame 15 ms, at the viewport's size 24 ms (1000x700, frame 1000x700), hidden again 1 ms; #2 first frame 12 ms, at the viewport's size 21 ms (1000x700, frame 1000x700), hidden again 1 ms

| oracle | same document | timers | SSE socket | form | layout | detail |
| :- | :- | :- | :- | :- | :- | :- |
| shown (first time) | true | true | true | true | 1000x700@1 | token same, loads +0, navigations +0, ticks 15→21, sse opens 1 (server 1) msgs 14→21, field "typed by the bot", checked true |
| hidden again (the agent's 1280x800) | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 309→324, sse opens 1 (server 1) msgs 308→323, field "x日本s7-paste-ok", checked true |
| shown again | true | true | true | true | 1000x700@1 | token same, loads +0, navigations +0, ticks 324→333, sse opens 1 (server 1) msgs 323→332, field "x日本s7-paste-ok", checked true |
| hidden at the end | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 333→348, sse opens 1 (server 1) msgs 332→347, field "x日本s7-paste-ok", checked true |

| through the viewport | ok | ms | detail |
| :- | :- | :- | :- |
| mouse: a click lands where the person clicked | yes | 102 | {"at":"260,40","page":{"x":260,"y":40,"t":1793871364157},"forwarded":{"mouseMove":1,"mouseDown":1,"mouseUp":1}} |
| wheel: the page scrolls | yes | 323 | {"scrollY":450,"wheels":4,"forwardedWheels":4} |
| keys: typing, Backspace and select-all in the field | yes | 1217 | {"typed":"typed by the botabc","afterBackspace":"typed by the botab","afterSelectAllAndX":"x","focused":"field","pageHasFocus":true,"keys":["End","a","b","c","Backspace","x"]} |
| IME: a composition in the viewport is composed and committed in the page | yes | 857 | {"field":"x日本","midField":"xにほ","compositions":["start:","update:にほ","update:日本","update:日本","end:日本"],"forwarded":{"set":2,"commit":1,"text":0}} |
| paste: the person's paste reaches the page as a paste | yes | 933 | {"field":"x日本s7-paste-ok","pasteEvents":["s7-paste-ok"],"clipboard":{},"forwarded":1} |
| <select>: it opens, and the keys choose an option | yes | 1594 | {"value":"c","changes":["c"],"popupTextures":0,"popupRects":["bitmap 180x146+480+48","bitmap 180x146+480+48","bitmap 180x146+480+48"],"viewerPopups":0,"viewerPopupSizes":[]} |
| cursor: the page's cursor reaches the viewport | yes | 1206 | {"events":["hand","text","crosshair","move"],"viewerCursors":["pointer","text","crosshair","move"]} |
| drag: an HTML5 drag inside the page, sent as plain mouse events | **no** | 1316 | {"page":["dragstart"]} |
| drag: the same, with the browser's drag handed to the viewport (CDP Input.setInterceptDrags) | yes | 1318 | {"page":["dragstart","dragenter","dragover","drop:s7-dragged","dragend:copy"],"intercepted":1,"dispatched":["dragEnter","dragOver","drop"]} |
| file chooser: answered with a file, no dialog | yes | 102 | {"choosers":[{"at":1793871373032,"mode":"selectSingle"}],"files":["s7-upload.txt:23:hello from the viewport"]} |
| a window the page opens: offscreen too, its opener kept, shown in the viewport and clicked | **no** | 3775 | {"offscreen":true,"visible":false,"size":"480x360","painting":true,"frameRate":30,"openerFramesOfTheChildSize":0,"paintsAfterRepaint":0,"pageState":"{\"clicks\":0,\"hasOpener\":true,\"loadedAt\":1793871373144}","directClick":false,"paints":0,"openerMessages":["popup:hello"],"clickedInViewport":false} |
| resize: the page reflows to the viewport, no reload | yes | 171 | {"oneMs":25,"quickThreeMs":41,"backMs":22,"resizes":["1793871363478:1000x700","1793871376874:800x560","1793871376910:900x620","1793871376960:760x520","1793871376984:820x580","1793871377026:1000x700"],"applied":["1793871363477:1000x700","1793871376873:800x560","1793871376900:900x620","1793871376944:760x520","1793871376983:820x580","1793871377022:1000x700"],"token":"same"} |
| find-in-page: matches found and drawn | yes | 2 | {"requestId":0,"matches":1,"selectionArea":{"x":202,"y":163,"width":32,"height":16},"activeMatchOrdinal":1,"finalUpdate":true} |
| DevTools: open on the offscreen tab (detached window) | yes | 642 | {"opened":true} |
| accessibility: the page's tree is there to read over CDP (the OS sees none of it) | yes | 4 | {"nodes":52,"button":true,"accessibilitySupport":false} |
| a 2x display: the device-metrics override at a scale of 2 gives the viewport 2x frames | **no** | 1603 | {"pageDpr":2,"layout":"1000x700","frame":"1000x700","viewerCanvas":"1000x700"} |
| the tab's webContents.focus(): does the hidden window take the OS focus from the viewport? | yes | 700 | {"viewerFocusedBefore":false,"after":false,"focusedWindow":"(none)","pageHasFocus":true,"tabVisible":false} |

| input → frame | trials | ms p50 / p95 | parts (p50) |
| :- | :- | :- | :- |
| viewport, mouse | 20 | 12 / 24 | to the page's handler 1; to the paint event 3; paint → drawn in the viewer 1; drawn → on screen (2 rAFs) 9 |
| viewport, key | 10 | 19 / 24 | to the page's handler 1; to the paint event 3; paint → drawn in the viewer 1; drawn → on screen (2 rAFs) 15 |
| native view, mouse | 20 | 9 / 17 | to the page's handler 0 |
| native view, key | 10 | 9 / 10 | to the page's handler 0 |

| frames | numbers |
| :- | :- |
| viewport, animated page | drawnPerSec 60.0, paintsPerSec 60.0, sentPerSec 60.0, droppedPerSec 0.0, pageRafPerSec 60.0, mbPerSec 58.6, drawMsP50 0.7, drawMsP95 0.9, cpuTotal 48.5, cpuBrowser 23.0, cpuGpu 4.3, cpuOffscreenRenderer 5.5, cpuViewerRenderer 15.8 |
| viewport, smooth scroll | ms 906.0, viewerFramesPerSec 60.7, pageRafPerSec 60.7 |
| native view, animated page | pageRafPerSec 39.5, cpuTotal 7.0, cpuBrowser 1.3, cpuGpu 2.0, cpuRenderer 3.5 |
| native view, smooth scroll | ms 915.0, pageRafPerSec 39.3 |

Windows on screen: a hidden offscreen tab and the viewer: no way to list windows here (Wayland or no display); a <select> open: no way to list windows here (Wayland or no display); a file chooser open: no way to list windows here (Wayland or no display); the page's window open (offscreen): no way to list windows here (Wayland or no display)

Viewer: {"frames":504,"textures":0,"bitmaps":504,"popups":0,"draw":{"n":300,"min":0.6,"p50":0.7,"p95":2,"max":5.2,"mean":1},"errors":[]}; counters {"sent":504,"dropped":0,"fullFrames":2,"mbSent":513.04,"outstandingTextures":0,"forwarded":{"mouseMove":42,"mouseDown":29,"mouseUp":29,"mouseWheel":4,"keyDown":20,"keyUp":20,"char":14,"edit":1,"ime-start":1,"ime-set":2,"ime-commit":1,"paste":1,"mouseLeave":1},"errors":[],"tabTextures":0,"tabPopupTextures":0,"tabEmptyPaints":0,"tabPaints":511}

**Assertions:** PASS an offscreen tab draws with no window (CPU bitmaps asked at 30 fps: rAF above 10 Hz); PASS capturePage works on an offscreen tab; PASS no reload across show and hide through the viewport: same document, its timers, its socket, its form; PASS through the viewport: mouse: a click lands where the person clicked; PASS through the viewport: wheel: the page scrolls; PASS through the viewport: keys: typing, Backspace and select-all in the field; PASS through the viewport: IME: a composition in the viewport is composed and committed in the page; PASS through the viewport: paste: the person's paste reaches the page as a paste; PASS through the viewport: <select>: it opens, and the keys choose an option; PASS through the viewport: cursor: the page's cursor reaches the viewport; PASS through the viewport: drag: the same, with the browser's drag handed to the viewport (CDP Input.setInterceptDrags); PASS through the viewport: file chooser: answered with a file, no dialog; PASS through the viewport: resize: the page reflows to the viewport, no reload; PASS through the viewport: find-in-page: matches found and drawn; PASS through the viewport: DevTools: open on the offscreen tab (detached window); PASS through the viewport: accessibility: the page's tree is there to read over CDP (the OS sees none of it); PASS through the viewport: the tab's webContents.focus(): does the hidden window take the OS focus from the viewport?; PASS a known gap, pinned: an HTML5 drag sent as plain mouse events doesn't drop in an offscreen tab; PASS a known gap, pinned: a window the page opens, made offscreen, paints nothing; PASS the viewport draws an animated page at 45 fps or more

### Electron · dialogs-linux-x11 (electron-viewport-linux-x11-dialogs.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone x11, displays 1920x1080@1, status **done**, 23 s

**Round twelve, JavaScript dialogs answered over CDP**

| tab | dialog | CDP event | browser handler | windows during | windows after | page | error |
| :- | :- | :- | :- | :- | :- | :- | :- |
| offscreen tab | alert | true | true | ["4194306 120x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)"] | ["4194306 120x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)"] | alert:"returned":230ms |  |
| offscreen tab | confirm | true | true | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)"] | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)"] | alert:"returned":230ms | confirm:true:62ms |  |
| offscreen tab | prompt | false | – | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)"] | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)"] | alert:"returned":230ms | confirm:true:62ms |  |
| host window tab | alert | true | true | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","2097158 1x1+0+0 IsViewable \"S7 tiny t2\"","4194513 120x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)"] | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","2097158 1x1+0+0 IsViewable \"S7 tiny t2\"","4194513 120x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)"] | alert:"returned":81ms |  |
| host window tab | confirm | true | true | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","2097158 1x1+0+0 IsViewable \"S7 tiny t2\"","4194513 120x81+0+0 IsViewable (has no name)","4194600 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)","4194601 1x1+-1+-1 IsViewable (has no name)"] | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","2097158 1x1+0+0 IsViewable \"S7 tiny t2\"","4194513 120x81+0+0 IsViewable (has no name)","4194600 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)","4194601 1x1+-1+-1 IsViewable (has no name)"] | alert:"returned":81ms | confirm:true:87ms |  |
| host window tab | prompt | false | – | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","2097158 1x1+0+0 IsViewable \"S7 tiny t2\"","4194513 120x81+0+0 IsViewable (has no name)","4194600 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)","4194601 1x1+-1+-1 IsViewable (has no name)"] | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","2097158 1x1+0+0 IsViewable \"S7 tiny t2\"","4194513 120x81+0+0 IsViewable (has no name)","4194600 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)","4194601 1x1+-1+-1 IsViewable (has no name)"] | alert:"returned":81ms | confirm:true:87ms |  |
| offscreen tab, disableDialogs | alert | true | true | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","4194513 120x81+0+0 IsViewable (has no name)","4194600 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)","4194601 1x1+-1+-1 IsViewable (has no name)"] | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","4194513 120x81+0+0 IsViewable (has no name)","4194600 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)","4194601 1x1+-1+-1 IsViewable (has no name)"] | alert:"returned":0ms | handle: No dialog is showing |
| offscreen tab, disableDialogs | confirm | true | true | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","4194513 120x81+0+0 IsViewable (has no name)","4194600 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)","4194601 1x1+-1+-1 IsViewable (has no name)"] | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","4194513 120x81+0+0 IsViewable (has no name)","4194600 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)","4194601 1x1+-1+-1 IsViewable (has no name)"] | alert:"returned":0ms | confirm:false:1ms | handle: No dialog is showing |
| offscreen tab, disableDialogs | prompt | false | – | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","4194513 120x81+0+0 IsViewable (has no name)","4194600 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)","4194601 1x1+-1+-1 IsViewable (has no name)"] | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","4194513 120x81+0+0 IsViewable (has no name)","4194600 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)","4194601 1x1+-1+-1 IsViewable (has no name)"] | alert:"returned":0ms | confirm:false:1ms |  |

**Assertions:** PASS CDP sees every alert and confirm, offscreen, in the host window and with disableDialogs; PASS a known gap, pinned: an alert answered over CDP still leaves a native box up (offscreen tab); PASS a known gap, pinned: an alert answered over CDP still leaves a native box up (host window tab); PASS with disableDialogs an alert puts up no window

### Electron · viewport-linux-x11 (electron-viewport-linux-x11.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone x11, displays 1920x1080@1, status **done**, 154 s

**Round twelve, offscreen bot tabs** (never-shown OSR windows; GPU "disabled_software")

Size: default: window 1280x800, page 1280x800@1 → **default**.

Shared textures: 0 textures, 0 bitmaps, 0 empty paints in 3 s → **none here (CPU bitmaps)**; error not asked for: GPU compositing is "disabled_software" here (asking hung the main process on the Linux runners)

| config | visibility | rAF Hz | paints/s | textures/s | all CPU % | renderer % | GPU % | browser % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| offscreen, bitmap, 10 fps, animated | visible | 10.0 | 10.0 | 0.0 | 11.0 | 6.0 | 2.0 | 2.8 |  |
| offscreen, bitmap, 30 fps, animated | visible | 30.0 | 30.0 | 0.0 | 27.0 | 13.3 | 5.3 | 8.5 |  |
| offscreen, bitmap, 60 fps, animated | visible | 60.0 | 60.0 | 0.0 | 54.5 | 26.7 | 11.5 | 16.3 |  |
| offscreen, bitmap, 30 fps, painting stopped, animated | visible | 30.0 | 0.0 | 0.0 | 19.0 | 13.2 | 5.0 | 0.8 |  |
| offscreen, bitmap, 10 fps, quiet page | visible | 0.0 | 4.3 | 0.0 | 4.5 | 1.0 | 0.5 | 3.0 |  |
| offscreen, bitmap, painting stopped, quiet page | visible | 0.0 | 0.0 | 0.0 | 2.0 | 1.0 | 0.8 | 0.3 |  |
| host window, animated | visible | 59.9 | 0.0 | 0.0 | 27.2 | 24.0 | 2.5 | 0.8 |  |
| host window, quiet page | visible | 0.0 | 0.0 | 0.0 | 1.0 | 0.5 | 0.3 | 0.3 |  |

| pictures of | method | ok | ms | stale ms | size | errors |
| :- | :- | :- | :- | :- | :- | :- |
| offscreen, bitmap, painting on (10 fps) | capturePage | 5/5 | 97 / 98 | -82 / -44 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | cdpJpeg | 5/5 | 297 / 299 | -268 / -181 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | osrPaint | 5/5 | 0 / 0 | 36 / 43 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | newest paint → JPEG | 5/5 | 7 / 8 | – | 1280x800 |  |
| offscreen, bitmap, painting stopped | capturePage | 5/5 | 97 / 99 | -85 / -56 | 1280x800 |  |
| offscreen, bitmap, painting stopped | cdpJpeg | 5/5 | 299 / 313 | -270 / -269 | 1280x800 |  |
| host window | capturePage | 5/5 | 14 / 16 | 13 / 15 | 1280x800 |  |
| host window | cdpJpeg | 5/5 | 82 / 83 | -35 / -34 | 1280x800 |  |

| cost | MiB a tab | CPU % a tab | kind | error |
| :- | :- | :- | :- | :- |
| 4 quiet offscreen tabs (bitmap, 10 fps) | 42.9 | 2.87 | pss |  |
| 4 quiet offscreen tabs (bitmap), painting stopped | 37.5 | 1.81 | pss |  |
| 4 quiet tabs in one shared host window | 30.7 | 1.06 | pss |  |

Windows on screen: 4 offscreen tabs open (nothing else shown): 0 []; 4 tabs in the shared host window: 1 ["2097280 1x1+0+0 IsViewable \"S7 shared host\""]

**Round twelve, the viewport** (mode **bitmap**: no shared textures on this machine (GPU compositing "disabled_software"): CPU bitmaps)

Shows: #1 first frame 19 ms, at the viewport's size 29 ms (1000x700, frame 1000x700), hidden again 3 ms; #2 first frame 17 ms, at the viewport's size 28 ms (1000x700, frame 1000x700), hidden again 1 ms

| oracle | same document | timers | SSE socket | form | layout | detail |
| :- | :- | :- | :- | :- | :- | :- |
| shown (first time) | true | true | true | true | 1000x700@1 | token same, loads +0, navigations +0, ticks 15→21, sse opens 1 (server 1) msgs 14→21, field "typed by the bot", checked true |
| hidden again (the agent's 1280x800) | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 312→327, sse opens 1 (server 1) msgs 310→325, field "x日本s7-paste-ok", checked true |
| shown again | true | true | true | true | 1000x700@1 | token same, loads +0, navigations +0, ticks 327→335, sse opens 1 (server 1) msgs 325→334, field "x日本s7-paste-ok", checked true |
| hidden at the end | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 335→351, sse opens 1 (server 1) msgs 334→349, field "x日本s7-paste-ok", checked true |

| through the viewport | ok | ms | detail |
| :- | :- | :- | :- |
| mouse: a click lands where the person clicked | yes | 103 | {"at":"260,40","page":{"x":260,"y":40,"t":1793871378689},"forwarded":{"mouseMove":1,"mouseDown":1,"mouseUp":1}} |
| wheel: the page scrolls | yes | 324 | {"scrollY":450,"wheels":4,"forwardedWheels":4} |
| keys: typing, Backspace and select-all in the field | yes | 1218 | {"typed":"typed by the botabc","afterBackspace":"typed by the botab","afterSelectAllAndX":"x","focused":"field","pageHasFocus":true,"keys":["End","a","b","c","Backspace","x"]} |
| IME: a composition in the viewport is composed and committed in the page | yes | 858 | {"field":"x日本","midField":"xにほ","compositions":["start:","update:にほ","update:日本","update:日本","end:日本"],"forwarded":{"set":2,"commit":1,"text":0}} |
| paste: the person's paste reaches the page as a paste | yes | 933 | {"field":"x日本s7-paste-ok","pasteEvents":["s7-paste-ok"],"clipboard":{},"forwarded":1} |
| <select>: it opens, and the keys choose an option | yes | 1633 | {"value":"c","changes":["c"],"popupTextures":0,"popupRects":["bitmap 180x146+480+48","bitmap 180x146+480+48","bitmap 180x146+480+48"],"viewerPopups":0,"viewerPopupSizes":[]} |
| cursor: the page's cursor reaches the viewport | yes | 1204 | {"events":["hand","text","crosshair","move"],"viewerCursors":["pointer","text","crosshair","move"]} |
| drag: an HTML5 drag inside the page, sent as plain mouse events | **no** | 1321 | {"page":["dragstart"]} |
| drag: the same, with the browser's drag handed to the viewport (CDP Input.setInterceptDrags) | yes | 1321 | {"page":["dragstart","dragenter","dragover","drop:s7-dragged","dragend:copy"],"intercepted":1,"dispatched":["dragEnter","dragOver","drop"]} |
| file chooser: answered with a file, no dialog | yes | 127 | {"choosers":[{"at":1793871387618,"mode":"selectSingle"}],"files":["s7-upload.txt:23:hello from the viewport"]} |
| a window the page opens: offscreen too, its opener kept, shown in the viewport and clicked | **no** | 3784 | {"offscreen":true,"visible":false,"size":"480x360","painting":true,"frameRate":30,"openerFramesOfTheChildSize":0,"paintsAfterRepaint":0,"pageState":"{\"clicks\":0,\"hasOpener\":true,\"loadedAt\":1793871387760}","directClick":false,"paints":0,"openerMessages":["popup:hello"],"clickedInViewport":false} |
| resize: the page reflows to the viewport, no reload | yes | 175 | {"oneMs":23,"quickThreeMs":42,"backMs":26,"resizes":["1793871378006:1000x700","1793871391493:800x560","1793871391522:900x620","1793871391566:760x520","1793871391606:820x580","1793871391642:1000x700"],"applied":["1793871378005:1000x700","1793871391491:800x560","1793871391519:900x620","1793871391565:760x520","1793871391600:820x580","1793871391637:1000x700"],"token":"same"} |
| find-in-page: matches found and drawn | yes | 3 | {"requestId":0,"matches":1,"selectionArea":{"x":202,"y":163,"width":32,"height":16},"activeMatchOrdinal":1,"finalUpdate":true} |
| DevTools: open on the offscreen tab (detached window) | yes | 751 | {"opened":true} |
| accessibility: the page's tree is there to read over CDP (the OS sees none of it) | yes | 4 | {"nodes":52,"button":true,"accessibilitySupport":false} |
| a 2x display: the device-metrics override at a scale of 2 gives the viewport 2x frames | **no** | 1604 | {"pageDpr":2,"layout":"1000x700","frame":"1000x700","viewerCanvas":"1000x700"} |
| the tab's webContents.focus(): does the hidden window take the OS focus from the viewport? | yes | 702 | {"viewerFocusedBefore":true,"after":true,"focusedWindow":"S7 viewport","pageHasFocus":true,"tabVisible":false} |

| input → frame | trials | ms p50 / p95 | parts (p50) |
| :- | :- | :- | :- |
| viewport, mouse | 20 | 13 / 17 | to the page's handler 1; to the paint event 4; paint → drawn in the viewer 0; drawn → on screen (2 rAFs) 9 |
| viewport, key | 10 | 13 / 30 | to the page's handler 1; to the paint event 3; paint → drawn in the viewer 0; drawn → on screen (2 rAFs) 9 |
| native view, mouse | 20 | 8 / 17 | to the page's handler 0 |
| native view, key | 10 | 11 / 12 | to the page's handler 0 |

| frames | numbers |
| :- | :- |
| viewport, animated page | drawnPerSec 60.2, paintsPerSec 60.2, sentPerSec 60.2, droppedPerSec 0.0, pageRafPerSec 59.9, mbPerSec 58.8, drawMsP50 0.9, drawMsP95 1.0, cpuTotal 59.4, cpuBrowser 27.5, cpuGpu 5.2, cpuOffscreenRenderer 7.2, cpuViewerRenderer 19.5 |
| viewport, smooth scroll | ms 908.0, viewerFramesPerSec 61.7, pageRafPerSec 60.6 |
| native view, animated page | pageRafPerSec 60.0, cpuTotal 11.0, cpuBrowser 0.5, cpuGpu 3.3, cpuRenderer 7.0 |
| native view, smooth scroll | ms 902.0, pageRafPerSec 61.0 |

Windows on screen: a hidden offscreen tab and the viewer: 1 ["2097287 1000x727+60+60 IsViewable \"S7 viewport\""]; a <select> open: 1 ["2097287 1000x727+60+60 IsViewable \"S7 viewport\""]; a file chooser open: 1 ["2097287 1000x727+60+60 IsViewable \"S7 viewport\""]; the page's window open (offscreen): 1 ["2097287 1000x727+60+60 IsViewable \"S7 viewport\""]

Viewer: {"frames":506,"textures":0,"bitmaps":506,"popups":0,"draw":{"n":300,"min":0.7,"p50":0.9,"p95":2.5,"max":7.8,"mean":1.26},"errors":[]}; counters {"sent":506,"dropped":0,"fullFrames":2,"mbSent":516.59,"outstandingTextures":0,"forwarded":{"mouseMove":42,"mouseDown":29,"mouseUp":29,"mouseWheel":4,"keyDown":20,"keyUp":20,"char":14,"edit":1,"ime-start":1,"ime-set":2,"ime-commit":1,"paste":1,"mouseLeave":1},"errors":[],"tabTextures":0,"tabPopupTextures":0,"tabEmptyPaints":0,"tabPaints":514}

**Assertions:** PASS an offscreen tab draws with no window (CPU bitmaps asked at 30 fps: rAF above 10 Hz); PASS capturePage works on an offscreen tab; PASS four offscreen tabs put no window on screen; PASS no reload across show and hide through the viewport: same document, its timers, its socket, its form; PASS through the viewport: mouse: a click lands where the person clicked; PASS through the viewport: wheel: the page scrolls; PASS through the viewport: keys: typing, Backspace and select-all in the field; PASS through the viewport: IME: a composition in the viewport is composed and committed in the page; PASS through the viewport: paste: the person's paste reaches the page as a paste; PASS through the viewport: <select>: it opens, and the keys choose an option; PASS through the viewport: cursor: the page's cursor reaches the viewport; PASS through the viewport: drag: the same, with the browser's drag handed to the viewport (CDP Input.setInterceptDrags); PASS through the viewport: file chooser: answered with a file, no dialog; PASS through the viewport: resize: the page reflows to the viewport, no reload; PASS through the viewport: find-in-page: matches found and drawn; PASS through the viewport: DevTools: open on the offscreen tab (detached window); PASS through the viewport: accessibility: the page's tree is there to read over CDP (the OS sees none of it); PASS through the viewport: the tab's webContents.focus(): does the hidden window take the OS focus from the viewport?; PASS a known gap, pinned: an HTML5 drag sent as plain mouse events doesn't drop in an offscreen tab; PASS a known gap, pinned: a window the page opens, made offscreen, paints nothing; PASS the viewport draws an animated page at 45 fps or more

### Electron · viewport-macos-bitmap (electron-viewport-macos-bitmap.json)

Electron 45.2.2 (Chromium 156.0.8078.80), darwin-arm64 25.6.0, ozone (default), displays 1024x768@1, status **done**, 53 s

**Round twelve, the viewport** (mode **bitmap**: forced by S7_VIEWPORT_MODE=bitmap)

Shows: #1 first frame 26 ms, at the viewport's size 92 ms (1000x645, frame 1000x645), hidden again 8 ms; #2 first frame 17 ms, at the viewport's size 72 ms (1000x645, frame 1000x645), hidden again 8 ms

| oracle | same document | timers | SSE socket | form | layout | detail |
| :- | :- | :- | :- | :- | :- | :- |
| shown (first time) | true | true | true | true | 1000x645@1 | token same, loads +0, navigations +0, ticks 14→23, sse opens 1 (server 1) msgs 14→22, field "typed by the bot", checked true |
| hidden again (the agent's 1280x800) | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 328→343, sse opens 1 (server 1) msgs 317→331, field "x日本s7-paste-ok", checked true |
| shown again | true | true | true | true | 1000x645@1 | token same, loads +0, navigations +0, ticks 343→351, sse opens 1 (server 1) msgs 331→340, field "x日本s7-paste-ok", checked true |
| hidden at the end | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 351→366, sse opens 1 (server 1) msgs 340→354, field "x日本s7-paste-ok", checked true |

| through the viewport | ok | ms | detail |
| :- | :- | :- | :- |
| mouse: a click lands where the person clicked | yes | 112 | {"at":"260,40","page":{"x":260,"y":40,"t":1793873644831},"forwarded":{"mouseMove":1,"mouseDown":1,"mouseUp":1}} |
| wheel: the page scrolls | yes | 343 | {"scrollY":450,"wheels":3,"forwardedWheels":4} |
| keys: typing, Backspace and select-all in the field | yes | 1259 | {"typed":"typed by the botabc","afterBackspace":"typed by the botab","afterSelectAllAndX":"x","focused":"field","pageHasFocus":true,"keys":["End","a","b","c","Backspace","x"]} |
| IME: a composition in the viewport is composed and committed in the page | yes | 908 | {"field":"x日本","midField":"xにほ","compositions":["start:","update:にほ","update:日本","update:日本","end:日本"],"forwarded":{"set":2,"commit":1,"text":0}} |
| paste: the person's paste reaches the page as a paste | yes | 943 | {"field":"x日本s7-paste-ok","pasteEvents":["s7-paste-ok"],"clipboard":{},"forwarded":1} |
| <select>: it opens, and the keys choose an option | yes | 1708 | {"value":"c","changes":["c"],"popupTextures":0,"popupRects":["bitmap 180x146+480+48","bitmap 180x146+480+48","bitmap 180x146+480+48"],"viewerPopups":0,"viewerPopupSizes":[]} |
| cursor: the page's cursor reaches the viewport | yes | 1231 | {"events":["hand","text","crosshair","move"],"viewerCursors":["pointer","text","crosshair","move"]} |
| drag: an HTML5 drag inside the page, sent as plain mouse events | **no** | 1378 | {"page":["dragstart"]} |
| drag: the same, with the browser's drag handed to the viewport (CDP Input.setInterceptDrags) | yes | 1394 | {"page":["dragstart","dragenter","dragover","drop:s7-dragged","dragend:copy"],"intercepted":1,"dispatched":["dragEnter","dragOver","drop"]} |
| file chooser: answered with a file, no dialog | yes | 176 | {"choosers":[{"at":1793873654120,"mode":"selectSingle"}],"files":["s7-upload.txt:23:hello from the viewport"]} |
| a window the page opens: offscreen too, its opener kept, shown in the viewport and clicked | **no** | 3874 | {"offscreen":true,"visible":false,"size":"480x360","painting":true,"frameRate":30,"openerFramesOfTheChildSize":0,"paintsAfterRepaint":0,"pageState":"{\"clicks\":0,\"hasOpener\":true,\"loadedAt\":1793873654370}","directClick":false,"paints":0,"openerMessages":["popup:hello"],"clickedInViewport":false} |
| resize: the page reflows to the viewport, no reload | yes | 274 | {"oneMs":75,"quickThreeMs":28,"backMs":73,"resizes":["1793873644067:1000x645","1793873658130:800x560","1793873658212:900x620","1793873658274:760x520","1793873658307:820x580","1793873658343:1000x645"],"applied":["1793873644063:1000x645","1793873658128:800x560","1793873658210:900x620","1793873658253:760x520","1793873658297:820x580","1793873658326:1000x645"],"token":"same"} |
| find-in-page: matches found and drawn | yes | 6 | {"requestId":0,"matches":1,"selectionArea":{"x":202,"y":163,"width":30,"height":17},"activeMatchOrdinal":1,"finalUpdate":true} |
| DevTools: open on the offscreen tab (detached window) | yes | 860 | {"opened":true} |
| accessibility: the page's tree is there to read over CDP (the OS sees none of it) | yes | 18 | {"nodes":52,"button":true,"accessibilitySupport":false} |
| a 2x display: the device-metrics override at a scale of 2 gives the viewport 2x frames | **no** | 1618 | {"pageDpr":2,"layout":"1000x645","frame":"1000x645","viewerCanvas":"1000x645"} |
| the tab's webContents.focus(): does the hidden window take the OS focus from the viewport? | yes | 712 | {"viewerFocusedBefore":true,"after":true,"focusedWindow":"S7 viewport","pageHasFocus":true,"tabVisible":false} |

| input → frame | trials | ms p50 / p95 | parts (p50) |
| :- | :- | :- | :- |
| viewport, mouse | 20 | 27 / 39 | to the page's handler 2; to the paint event 19; paint → drawn in the viewer 1; drawn → on screen (2 rAFs) 9 |
| viewport, key | 10 | 30 / 57 | to the page's handler 2; to the paint event 18; paint → drawn in the viewer 1; drawn → on screen (2 rAFs) 10 |
| native view, mouse | 20 | 8 / 16 | to the page's handler 1 |
| native view, key | 10 | 9 / 18 | to the page's handler 1 |

| frames | numbers |
| :- | :- |
| viewport, animated page | drawnPerSec 60.0, paintsPerSec 60.2, sentPerSec 60.2, droppedPerSec 0.0, pageRafPerSec 60.2, mbPerSec 58.8, drawMsP50 0.5, drawMsP95 1.4, cpuTotal 60.0, cpuBrowser 13.2, cpuGpu 26.7, cpuOffscreenRenderer 6.3, cpuViewerRenderer 13.7 |
| viewport, smooth scroll | ms 910.0, viewerFramesPerSec 60.4, pageRafPerSec 60.4 |
| native view, animated page | pageRafPerSec 59.9, cpuTotal 25.1, cpuBrowser 0.8, cpuGpu 14.0, cpuRenderer 9.8 |
| native view, smooth scroll | ms 906.0, pageRafPerSec 60.7 |

Windows on screen: a hidden offscreen tab and the viewer: 1 ["layer 0 alpha 1 1000x677+24+31 \"S7 viewport\""]; a <select> open: 1 ["layer 0 alpha 1 1000x677+24+31 \"S7 viewport\""]; a file chooser open: 1 ["layer 0 alpha 1 1000x677+24+31 \"S7 viewport\""]; the page's window open (offscreen): 1 ["layer 0 alpha 1 1000x677+24+31 \"S7 viewport\""]

Viewer: {"frames":468,"textures":0,"bitmaps":468,"popups":0,"draw":{"n":300,"min":0.3,"p50":0.6,"p95":1.7,"max":6.1,"mean":0.86},"errors":[]}; counters {"sent":468,"dropped":0,"fullFrames":2,"mbSent":481.15,"outstandingTextures":0,"forwarded":{"mouseMove":42,"mouseDown":29,"mouseUp":29,"mouseWheel":4,"keyDown":20,"keyUp":20,"char":14,"edit":1,"ime-start":1,"ime-set":2,"ime-commit":1,"paste":1,"mouseLeave":1},"errors":[],"tabTextures":0,"tabPopupTextures":0,"tabEmptyPaints":0,"tabPaints":474}

**Assertions:** PASS no reload across show and hide through the viewport: same document, its timers, its socket, its form; PASS through the viewport: mouse: a click lands where the person clicked; PASS through the viewport: wheel: the page scrolls; PASS through the viewport: keys: typing, Backspace and select-all in the field; PASS through the viewport: IME: a composition in the viewport is composed and committed in the page; PASS through the viewport: paste: the person's paste reaches the page as a paste; PASS through the viewport: <select>: it opens, and the keys choose an option; PASS through the viewport: cursor: the page's cursor reaches the viewport; PASS through the viewport: drag: the same, with the browser's drag handed to the viewport (CDP Input.setInterceptDrags); PASS through the viewport: file chooser: answered with a file, no dialog; PASS through the viewport: resize: the page reflows to the viewport, no reload; PASS through the viewport: find-in-page: matches found and drawn; PASS through the viewport: DevTools: open on the offscreen tab (detached window); PASS through the viewport: accessibility: the page's tree is there to read over CDP (the OS sees none of it); PASS through the viewport: the tab's webContents.focus(): does the hidden window take the OS focus from the viewport?; PASS a known gap, pinned: an HTML5 drag sent as plain mouse events doesn't drop in an offscreen tab; PASS a known gap, pinned: a window the page opens, made offscreen, paints nothing

### Electron · dialogs-macos (electron-viewport-macos-dialogs.json)

Electron 45.2.2 (Chromium 156.0.8078.80), darwin-arm64 25.6.0, ozone (default), displays 1024x768@1, status **done**, 24 s

**Round twelve, JavaScript dialogs answered over CDP**

| tab | dialog | CDP event | browser handler | windows during | windows after | page | error |
| :- | :- | :- | :- | :- | :- | :- | :- |
| offscreen tab | alert | true | true | ["layer 0 alpha 1 260x96+382+321","layer 0 alpha 1 1024x677+0+31 \"S7 viewport page\""] | ["layer 0 alpha 1 260x96+382+321","layer 0 alpha 1 1024x677+0+31 \"S7 viewport page\""] | alert:"returned":230ms |  |
| offscreen tab | confirm | true | true | ["layer 0 alpha 1 260x96+382+321","layer 0 alpha 1 1024x677+0+31 \"S7 viewport page\""] | ["layer 0 alpha 1 260x96+382+321","layer 0 alpha 1 1024x677+0+31 \"S7 viewport page\""] | alert:"returned":230ms | confirm:true:72ms |  |
| offscreen tab | prompt | false | – | ["layer 0 alpha 1 260x96+382+321","layer 0 alpha 1 1024x677+0+31 \"S7 viewport page\""] | ["layer 0 alpha 1 260x96+382+321","layer 0 alpha 1 1024x677+0+31 \"S7 viewport page\""] | alert:"returned":230ms | confirm:true:72ms |  |
| host window tab | alert | true | true | ["layer 0 alpha 1 260x96+0+31","layer 0 alpha 0 1x1+129+31 \"S7 tiny t2\""] | ["layer 0 alpha 1 260x96+0+31","layer 0 alpha 0 1x1+129+31 \"S7 tiny t2\""] | alert:"returned":75ms |  |
| host window tab | confirm | true | true | ["layer 0 alpha 1 260x96+0+31","layer 0 alpha 0 1x1+129+31 \"S7 tiny t2\""] | ["layer 0 alpha 1 260x96+0+31","layer 0 alpha 0 1x1+129+31 \"S7 tiny t2\""] | alert:"returned":75ms | confirm:true:86ms |  |
| host window tab | prompt | false | – | ["layer 0 alpha 1 260x96+0+31","layer 0 alpha 0 1x1+129+31 \"S7 tiny t2\""] | ["layer 0 alpha 1 260x96+0+31","layer 0 alpha 0 1x1+129+31 \"S7 tiny t2\""] | alert:"returned":75ms | confirm:true:86ms |  |
| offscreen tab, disableDialogs | alert | true | true | [] | [] | alert:"returned":1ms | handle: No dialog is showing |
| offscreen tab, disableDialogs | confirm | true | true | [] | [] | alert:"returned":1ms | confirm:false:0ms | handle: No dialog is showing |
| offscreen tab, disableDialogs | prompt | false | – | [] | [] | alert:"returned":1ms | confirm:false:0ms |  |

**Assertions:** PASS CDP sees every alert and confirm, offscreen, in the host window and with disableDialogs; PASS a known gap, pinned: an alert answered over CDP still leaves a native box up (offscreen tab); PASS a known gap, pinned: an alert answered over CDP still leaves a native box up (host window tab); PASS with disableDialogs an alert puts up no window

### Electron · viewport-macos (electron-viewport-macos.json)

Electron 45.2.2 (Chromium 156.0.8078.80), darwin-arm64 25.6.0, ozone (default), displays 1024x768@1, status **done**, 210 s

**Round twelve, offscreen bot tabs** (never-shown OSR windows; GPU "enabled")

Size: default: window 1280x800, page 1280x800@1 → **default**.

Shared textures: 45 textures, 0 bitmaps, 0 empty paints in 3 s → **they come here** — {"pixelFormat":"bgra","codedSize":"1280x800","handle":["ioSurface"]}

| config | visibility | rAF Hz | paints/s | textures/s | all CPU % | renderer % | GPU % | browser % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| offscreen, texture, 10 fps, animated | visible | 7.2 | 7.2 | 7.2 | 6.7 | 2.3 | 3.9 | 0.5 |  |
| offscreen, texture, 30 fps, animated | visible | 13.0 | 13.0 | 13.0 | 6.5 | 2.1 | 3.9 | 0.5 |  |
| offscreen, texture, 60 fps, animated | visible | 28.2 | 28.5 | 28.5 | 26.4 | 7.3 | 17.1 | 1.9 |  |
| offscreen, texture, 30 fps, painting stopped, animated | visible | 13.5 | 0.0 | 0.0 | 14.9 | 5.3 | 9.1 | 0.5 |  |
| offscreen, texture, 10 fps, quiet page | visible | 0.0 | 2.0 | 2.0 | 1.9 | 0.6 | 1.1 | 0.2 |  |
| offscreen, texture, painting stopped, quiet page | visible | 0.0 | 0.0 | 0.0 | 2.2 | 0.8 | 1.3 | 0.1 |  |
| offscreen, bitmap, 10 fps, animated | visible | 8.0 | 7.5 | 0.0 | 13.7 | 3.3 | 7.1 | 3.2 |  |
| offscreen, bitmap, 30 fps, animated | visible | 16.5 | 16.2 | 0.0 | 24.5 | 5.7 | 13.2 | 5.6 |  |
| offscreen, bitmap, 60 fps, animated | visible | 38.9 | 38.9 | 0.0 | 41.7 | 8.9 | 22.4 | 10.5 |  |
| offscreen, bitmap, 30 fps, painting stopped, animated | visible | 13.2 | 0.0 | 0.0 | 16.5 | 5.6 | 10.5 | 0.3 |  |
| offscreen, bitmap, 10 fps, quiet page | visible | 0.0 | 2.0 | 0.0 | 4.8 | 1.0 | 1.8 | 2.0 |  |
| offscreen, bitmap, painting stopped, quiet page | visible | 0.0 | 0.0 | 0.0 | 3.1 | 1.0 | 1.8 | 0.3 |  |
| host window, animated | visible | 59.9 | 0.0 | 0.0 | 45.3 | 15.2 | 29.9 | 0.2 |  |
| host window, quiet page | visible | 0.0 | 0.0 | 0.0 | 3.2 | 0.9 | 2.0 | 0.3 |  |

| pictures of | method | ok | ms | stale ms | size | errors |
| :- | :- | :- | :- | :- | :- | :- |
| offscreen, texture, painting on (10 fps) | capturePage | 5/5 | 20 / 205 | 116 / 128 | 1280x800 |  |
| offscreen, texture, painting on (10 fps) | cdpJpeg | 5/5 | 539 / 573 | -286 / -147 | 1280x800 |  |
| offscreen, texture, painting stopped | capturePage | 5/5 | 127 / 206 | 17 / 100 | 1280x800 |  |
| offscreen, texture, painting stopped | cdpJpeg | 5/5 | 437 / 578 | -299 / -248 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | capturePage | 5/5 | 105 / 209 | -81 / -1 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | cdpJpeg | 5/5 | 668 / 679 | -351 / -164 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | osrPaint | 5/5 | 0 / 0 | 360 / 486 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | newest paint → JPEG | 5/5 | 4 / 5 | – | 1280x800 |  |
| offscreen, bitmap, painting stopped | capturePage | 5/5 | 58 / 194 | -40 / -1 | 1280x800 |  |
| offscreen, bitmap, painting stopped | cdpJpeg | 5/5 | 556 / 730 | -378 / -153 | 1280x800 |  |
| host window | capturePage | 5/5 | 26 / 34 | 7 / 13 | 1280x800 |  |
| host window | cdpJpeg | 5/5 | 93 / 104 | -48 / -39 | 1280x800 |  |

| cost | MiB a tab | CPU % a tab | kind | error |
| :- | :- | :- | :- | :- |
| 4 quiet offscreen tabs (texture, 10 fps) | 30.2 | 3.10 | footprint |  |
| 4 quiet offscreen tabs (texture), painting stopped | 37.4 | 2.41 | footprint |  |
| 4 quiet tabs in one shared host window | 35.4 | 2.12 | footprint |  |

Windows on screen: 4 offscreen tabs open (nothing else shown): 0 []; 4 tabs in the shared host window: 1 ["layer 0 alpha 0 1x1+0+31 \"S7 shared host\""]

**Round twelve, the viewport** (mode **texture**: shared textures come on this machine)

Shows: #1 first frame 48 ms, at the viewport's size 107 ms (1000x645, frame 1000x645), hidden again 9 ms; #2 first frame 46 ms, at the viewport's size 46 ms (1000x645, frame 1000x645), hidden again 8 ms

| oracle | same document | timers | SSE socket | form | layout | detail |
| :- | :- | :- | :- | :- | :- | :- |
| shown (first time) | true | true | true | true | 1000x645@1 | token same, loads +0, navigations +0, ticks 15→23, sse opens 1 (server 1) msgs 14→22, field "typed by the bot", checked true |
| hidden again (the agent's 1280x800) | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 333→348, sse opens 1 (server 1) msgs 324→338, field "x日本s7-paste-ok", checked true |
| shown again | true | true | true | true | 1000x645@1 | token same, loads +0, navigations +0, ticks 348→356, sse opens 1 (server 1) msgs 338→346, field "x日本s7-paste-ok", checked true |
| hidden at the end | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 356→372, sse opens 1 (server 1) msgs 346→361, field "x日本s7-paste-ok", checked true |

| through the viewport | ok | ms | detail |
| :- | :- | :- | :- |
| mouse: a click lands where the person clicked | yes | 113 | {"at":"260,40","page":{"x":260,"y":40,"t":1793873565468},"forwarded":{"mouseMove":1,"mouseDown":1,"mouseUp":1}} |
| wheel: the page scrolls | yes | 337 | {"scrollY":600,"wheels":4,"forwardedWheels":4} |
| keys: typing, Backspace and select-all in the field | yes | 1245 | {"typed":"typed by the botabc","afterBackspace":"typed by the botab","afterSelectAllAndX":"x","focused":"field","pageHasFocus":true,"keys":["End","a","b","c","Backspace","x"]} |
| IME: a composition in the viewport is composed and committed in the page | yes | 1092 | {"field":"x日本","midField":"xにほ","compositions":["start:","update:にほ","update:日本","update:日本","end:日本"],"forwarded":{"set":2,"commit":1,"text":0}} |
| paste: the person's paste reaches the page as a paste | yes | 946 | {"field":"x日本s7-paste-ok","pasteEvents":["s7-paste-ok"],"clipboard":{},"forwarded":1} |
| <select>: it opens, and the keys choose an option | yes | 1669 | {"value":"c","changes":["c"],"popupTextures":19,"popupRects":["popup 180x146+0+0","popup 180x146+0+0","popup 180x146+0+0"],"viewerPopups":16,"viewerPopupSizes":["180x146","180x146","180x146","180x146","180x146","180x146","180x146","180x146","180x146","180x146"]} |
| cursor: the page's cursor reaches the viewport | yes | 1222 | {"events":["hand","text","crosshair","move"],"viewerCursors":["pointer","text","crosshair","move"]} |
| drag: an HTML5 drag inside the page, sent as plain mouse events | **no** | 1399 | {"page":["dragstart"]} |
| drag: the same, with the browser's drag handed to the viewport (CDP Input.setInterceptDrags) | yes | 1384 | {"page":["dragstart","dragenter","dragover","drop:s7-dragged","dragend:copy"],"intercepted":1,"dispatched":["dragEnter","dragOver","drop"]} |
| file chooser: answered with a file, no dialog | yes | 170 | {"choosers":[{"at":1793873574896,"mode":"selectSingle"}],"files":["s7-upload.txt:23:hello from the viewport"]} |
| a window the page opens: offscreen too, its opener kept, shown in the viewport and clicked | **no** | 3886 | {"offscreen":true,"visible":false,"size":"480x360","painting":true,"frameRate":30,"openerFramesOfTheChildSize":0,"paintsAfterRepaint":0,"pageState":"{\"clicks\":0,\"hasOpener\":true,\"loadedAt\":1793873575122}","directClick":false,"paints":0,"openerMessages":["popup:hello"],"clickedInViewport":false} |
| resize: the page reflows to the viewport, no reload | yes | 294 | {"oneMs":77,"quickThreeMs":49,"backMs":75,"resizes":["1793873564690:1000x645","1793873578920:800x560","1793873579010:900x620","1793873579043:760x520","1793873579091:820x580","1793873579130:1000x645"],"applied":["1793873564686:1000x645","1793873578915:800x560","1793873578990:900x620","1793873579032:760x520","1793873579077:820x580","1793873579128:1000x645"],"token":"same"} |
| find-in-page: matches found and drawn | yes | 10 | {"requestId":0,"matches":1,"selectionArea":{"x":202,"y":163,"width":30,"height":17},"activeMatchOrdinal":1,"finalUpdate":true} |
| DevTools: open on the offscreen tab (detached window) | yes | 1277 | {"opened":true} |
| accessibility: the page's tree is there to read over CDP (the OS sees none of it) | yes | 26 | {"nodes":52,"button":true,"accessibilitySupport":false} |
| a 2x display: the device-metrics override at a scale of 2 gives the viewport 2x frames | **no** | 1609 | {"pageDpr":2,"layout":"1000x645","frame":"1000x645","viewerCanvas":"1000x645"} |
| the tab's webContents.focus(): does the hidden window take the OS focus from the viewport? | yes | 714 | {"viewerFocusedBefore":true,"after":true,"focusedWindow":"S7 viewport","pageHasFocus":true,"tabVisible":false} |

| input → frame | trials | ms p50 / p95 | parts (p50) |
| :- | :- | :- | :- |
| viewport, mouse | 20 | 31 / 46 | to the page's handler 2; to the paint event 17; paint → drawn in the viewer 2; drawn → on screen (2 rAFs) 11 |
| viewport, key | 10 | 28 / 55 | to the page's handler 2; to the paint event 17; paint → drawn in the viewer 2; drawn → on screen (2 rAFs) 12 |
| native view, mouse | 20 | 12 / 17 | to the page's handler 1 |
| native view, key | 10 | 12 / 27 | to the page's handler 1 |

| frames | numbers |
| :- | :- |
| viewport, animated page | drawnPerSec 60.0, paintsPerSec 60.0, sentPerSec 60.0, droppedPerSec 0.0, pageRafPerSec 60.0, mbPerSec 0.0, drawMsP50 0.3, drawMsP95 0.7, cpuTotal 63.4, cpuBrowser 9.7, cpuGpu 35.5, cpuOffscreenRenderer 7.3, cpuViewerRenderer 10.8 |
| viewport, smooth scroll | ms 907.0, viewerFramesPerSec 62.8, pageRafPerSec 60.6 |
| native view, animated page | pageRafPerSec 60.0, cpuTotal 24.5, cpuBrowser 0.8, cpuGpu 14.3, cpuRenderer 8.9 |
| native view, smooth scroll | ms 927.0, pageRafPerSec 60.4 |

Windows on screen: a hidden offscreen tab and the viewer: 1 ["layer 0 alpha 1 1000x677+24+31 \"S7 viewport\""]; a <select> open: 1 ["layer 0 alpha 1 1000x677+24+31 \"S7 viewport\""]; a file chooser open: 1 ["layer 0 alpha 1 1000x677+24+31 \"S7 viewport\""]; the page's window open (offscreen): 1 ["layer 0 alpha 1 1000x677+24+31 \"S7 viewport\""]

Viewer: {"frames":438,"textures":438,"bitmaps":0,"popups":16,"draw":{"n":300,"min":0.1,"p50":0.4,"p95":0.9,"max":1.5,"mean":0.42},"errors":[]}; counters {"sent":454,"dropped":3,"fullFrames":0,"mbSent":0,"outstandingTextures":0,"forwarded":{"mouseMove":42,"mouseDown":29,"mouseUp":29,"mouseWheel":4,"keyDown":20,"keyUp":20,"char":14,"edit":1,"ime-start":1,"ime-set":2,"ime-commit":1,"paste":1,"mouseLeave":2},"errors":[],"tabTextures":443,"tabPopupTextures":19,"tabEmptyPaints":0,"tabPaints":462}

**Assertions:** PASS an offscreen tab draws with no window (CPU bitmaps asked at 30 fps: rAF above 10 Hz); PASS capturePage works on an offscreen tab; PASS four offscreen tabs put no window on screen; PASS macOS: shared textures come (GPU compositing on); PASS no reload across show and hide through the viewport: same document, its timers, its socket, its form; PASS through the viewport: mouse: a click lands where the person clicked; PASS through the viewport: wheel: the page scrolls; PASS through the viewport: keys: typing, Backspace and select-all in the field; PASS through the viewport: IME: a composition in the viewport is composed and committed in the page; PASS through the viewport: paste: the person's paste reaches the page as a paste; PASS through the viewport: <select>: it opens, and the keys choose an option; PASS through the viewport: cursor: the page's cursor reaches the viewport; PASS through the viewport: drag: the same, with the browser's drag handed to the viewport (CDP Input.setInterceptDrags); PASS through the viewport: file chooser: answered with a file, no dialog; PASS through the viewport: resize: the page reflows to the viewport, no reload; PASS through the viewport: find-in-page: matches found and drawn; PASS through the viewport: DevTools: open on the offscreen tab (detached window); PASS through the viewport: accessibility: the page's tree is there to read over CDP (the OS sees none of it); PASS through the viewport: the tab's webContents.focus(): does the hidden window take the OS focus from the viewport?; PASS a known gap, pinned: an HTML5 drag sent as plain mouse events doesn't drop in an offscreen tab; PASS a known gap, pinned: a window the page opens, made offscreen, paints nothing; PASS the viewport draws an animated page at 45 fps or more

### Electron · dialogs-windows (electron-viewport-windows-dialogs.json)

Electron 45.2.2 (Chromium 156.0.8078.80), win32-x64 10.0.26100, ozone (default), displays 1024x768@1, status **done**, 32 s

**Round twelve, JavaScript dialogs answered over CDP**

| tab | dialog | CDP event | browser handler | windows during | windows after | page | error |
| :- | :- | :- | :- | :- | :- | :- | :- |
| offscreen tab | alert | true | true | ["#32770 366x125+321+270 ex 0x10101 \"Electron\""] | ["#32770 366x125+321+270 ex 0x10101 \"Electron\""] | alert:"returned":441ms |  |
| offscreen tab | confirm | true | true | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | alert:"returned":441ms | confirm:true:421ms |  |
| offscreen tab | prompt | false | – | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | alert:"returned":441ms | confirm:true:421ms |  |
| host window tab | alert | true | true | ["#32770 366x125+0+0 ex 0x10101 \"Electron\"","Chrome_WidgetWin_1 48x40+-8+0 ex 0x82801a0 \"S7 tiny t2\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | ["#32770 366x125+0+0 ex 0x10101 \"Electron\"","Chrome_WidgetWin_1 48x40+-8+0 ex 0x82801a0 \"S7 tiny t2\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | alert:"returned":413ms |  |
| host window tab | confirm | true | true | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+0+0 ex 0x10101 \"Electron\"","Chrome_WidgetWin_1 48x40+-8+0 ex 0x82801a0 \"S7 tiny t2\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+0+0 ex 0x10101 \"Electron\"","Chrome_WidgetWin_1 48x40+-8+0 ex 0x82801a0 \"S7 tiny t2\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | alert:"returned":413ms | confirm:true:414ms |  |
| host window tab | prompt | false | – | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+0+0 ex 0x10101 \"Electron\"","Chrome_WidgetWin_1 48x40+-8+0 ex 0x82801a0 \"S7 tiny t2\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+0+0 ex 0x10101 \"Electron\"","Chrome_WidgetWin_1 48x40+-8+0 ex 0x82801a0 \"S7 tiny t2\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | alert:"returned":413ms | confirm:true:414ms |  |
| offscreen tab, disableDialogs | alert | true | true | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+0+0 ex 0x10101 \"Electron\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+0+0 ex 0x10101 \"Electron\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | alert:"returned":1ms | handle: No dialog is showing |
| offscreen tab, disableDialogs | confirm | true | true | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+0+0 ex 0x10101 \"Electron\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+0+0 ex 0x10101 \"Electron\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | alert:"returned":1ms | confirm:false:0ms | handle: No dialog is showing |
| offscreen tab, disableDialogs | prompt | false | – | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+0+0 ex 0x10101 \"Electron\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+0+0 ex 0x10101 \"Electron\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | alert:"returned":1ms | confirm:false:0ms |  |

**Assertions:** PASS CDP sees every alert and confirm, offscreen, in the host window and with disableDialogs; PASS a known gap, pinned: an alert answered over CDP still leaves a native box up (offscreen tab); PASS a known gap, pinned: an alert answered over CDP still leaves a native box up (host window tab); PASS with disableDialogs an alert puts up no window

### Electron · viewport-windows-warp (electron-viewport-windows-warp.json)

Electron 45.2.2 (Chromium 156.0.8078.80), win32-x64 10.0.26100, ozone (default), displays 1024x768@1, status **done**, 211 s

**Round twelve, offscreen bot tabs** (never-shown OSR windows; GPU "enabled")

Size: default: window 1024x720, page 1024x720@1; setContentSize after creation: window 1280x800, page 1280x800@1; not resizable, then setContentSize: window 1280x800, page 1280x800@1; enableLargerThanScreen, then setContentSize: window 1280x800, page 1280x800@1; not resizable, enableLargerThanScreen, then setBounds: window 1280x800, page 1280x800@1 → **setContentSize after creation**.

Shared textures: 90 textures, 0 bitmaps, 0 empty paints in 3 s → **they come here** — {"pixelFormat":"bgra","codedSize":"1280x800","handle":["ntHandle"]}

| config | visibility | rAF Hz | paints/s | textures/s | all CPU % | renderer % | GPU % | browser % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| offscreen, texture, 10 fps, animated | visible | 10.0 | 10.0 | 10.0 | 72.6 | 4.1 | 67.8 | 0.7 |  |
| offscreen, texture, 30 fps, animated | visible | 30.0 | 30.0 | 30.0 | 184.3 | 5.7 | 177.4 | 1.2 |  |
| offscreen, texture, 60 fps, animated | visible | 60.1 | 59.9 | 59.9 | 352.8 | 9.0 | 341.7 | 2.0 |  |
| offscreen, texture, 30 fps, painting stopped, animated | visible | 30.0 | 0.0 | 0.0 | 130.6 | 5.5 | 125.0 | 0.2 |  |
| offscreen, texture, 10 fps, quiet page | visible | 0.0 | 2.3 | 2.3 | 11.2 | 0.5 | 9.3 | 1.3 |  |
| offscreen, texture, painting stopped, quiet page | visible | 0.0 | 0.0 | 0.0 | 6.5 | 0.6 | 5.7 | 0.1 |  |
| offscreen, bitmap, 10 fps, animated | visible | 10.0 | 10.0 | 0.0 | 71.1 | 3.9 | 60.9 | 6.3 |  |
| offscreen, bitmap, 30 fps, animated | visible | 30.0 | 30.0 | 0.0 | 177.6 | 5.7 | 157.9 | 14.0 |  |
| offscreen, bitmap, 60 fps, animated | visible | 59.9 | 59.2 | 0.0 | 339.6 | 8.7 | 302.8 | 27.9 |  |
| offscreen, bitmap, 30 fps, painting stopped, animated | visible | 30.0 | 0.0 | 0.0 | 130.1 | 5.4 | 124.4 | 0.2 |  |
| offscreen, bitmap, 10 fps, quiet page | visible | 0.0 | 2.5 | 0.0 | 11.8 | 0.5 | 8.2 | 2.9 |  |
| offscreen, bitmap, painting stopped, quiet page | visible | 0.0 | 0.0 | 0.0 | 6.0 | 0.6 | 5.3 | 0.2 |  |
| host window, animated | visible | 62.0 | 0.0 | 0.0 | 170.3 | 9.3 | 160.7 | 0.2 |  |
| host window, quiet page | visible | 0.0 | 0.0 | 0.0 | 4.2 | 0.6 | 3.4 | 0.2 |  |

| pictures of | method | ok | ms | stale ms | size | errors |
| :- | :- | :- | :- | :- | :- | :- |
| offscreen, texture, painting on (10 fps) | capturePage | 5/5 | 96 / 97 | -76 / -5 | 1280x800 |  |
| offscreen, texture, painting on (10 fps) | cdpJpeg | 5/5 | 299 / 311 | -265 / -260 | 1280x800 |  |
| offscreen, texture, painting stopped | capturePage | 5/5 | 82 / 98 | -65 / -5 | 1280x800 |  |
| offscreen, texture, painting stopped | cdpJpeg | 5/5 | 298 / 315 | -266 / -248 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | capturePage | 5/5 | 96 / 97 | -77 / -2 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | cdpJpeg | 5/5 | 298 / 311 | -264 / -263 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | osrPaint | 5/5 | 0 / 1 | 39 / 42 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | newest paint → JPEG | 5/5 | 7 / 7 | – | 1280x800 |  |
| offscreen, bitmap, painting stopped | capturePage | 5/5 | 93 / 98 | -76 / -5 | 1280x800 |  |
| offscreen, bitmap, painting stopped | cdpJpeg | 5/5 | 299 / 313 | -266 / -262 | 1280x800 |  |
| host window | capturePage | 5/5 | 21 / 25 | 11 / 15 | 1280x800 |  |
| host window | cdpJpeg | 5/5 | 110 / 116 | -51 / -49 | 1280x800 |  |

| cost | MiB a tab | CPU % a tab | kind | error |
| :- | :- | :- | :- | :- |
| 4 quiet offscreen tabs (texture, 10 fps) | 28.2 | 10.28 | privateBytes |  |
| 4 quiet offscreen tabs (texture), painting stopped | 24.1 | 5.72 | privateBytes |  |
| 4 quiet tabs in one shared host window | 26.7 | 4.03 | privateBytes |  |

Windows on screen: 4 offscreen tabs open (nothing else shown): 0 []; 4 tabs in the shared host window: 1 ["Chrome_WidgetWin_1 48x40+-8+0 ex 0x82801a0 \"S7 shared host\""]

**Round twelve, the viewport** (mode **texture**: shared textures come on this machine)

Shows: #1 first frame 62 ms, at the viewport's size 62 ms (1000x681, frame 1000x681), hidden again 6 ms; #2 first frame 59 ms, at the viewport's size 59 ms (1000x681, frame 1000x681), hidden again 3 ms

| oracle | same document | timers | SSE socket | form | layout | detail |
| :- | :- | :- | :- | :- | :- | :- |
| shown (first time) | true | true | true | true | 1000x681@1 | token same, loads +0, navigations +0, ticks 15→25, sse opens 1 (server 1) msgs 14→24, field "typed by the bot", checked true |
| hidden again (the agent's 1280x800) | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 326→341, sse opens 1 (server 1) msgs 318→333, field "x日本s7-paste-ok", checked true |
| shown again | true | true | true | true | 1000x681@1 | token same, loads +0, navigations +0, ticks 341→349, sse opens 1 (server 1) msgs 333→342, field "x日本s7-paste-ok", checked true |
| hidden at the end | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 349→365, sse opens 1 (server 1) msgs 342→357, field "x日本s7-paste-ok", checked true |

| through the viewport | ok | ms | detail |
| :- | :- | :- | :- |
| mouse: a click lands where the person clicked | yes | 104 | {"at":"260,40","page":{"x":260,"y":40,"t":1793871614503},"forwarded":{"mouseMove":1,"mouseDown":1,"mouseUp":1}} |
| wheel: the page scrolls | yes | 337 | {"scrollY":600,"wheels":4,"forwardedWheels":4} |
| keys: typing, Backspace and select-all in the field | yes | 1217 | {"typed":"typed by the botabc","afterBackspace":"typed by the botab","afterSelectAllAndX":"x","focused":"field","pageHasFocus":true,"keys":["End","a","b","c","Backspace","x"]} |
| IME: a composition in the viewport is composed and committed in the page | yes | 879 | {"field":"x日本","midField":"xにほ","compositions":["start:","update:にほ","update:日本","update:日本","end:日本"],"forwarded":{"set":2,"commit":1,"text":0}} |
| paste: the person's paste reaches the page as a paste | yes | 944 | {"field":"x日本s7-paste-ok","pasteEvents":["s7-paste-ok"],"clipboard":{},"forwarded":1} |
| <select>: it opens, and the keys choose an option | yes | 2277 | {"value":"c","changes":["c"],"popupTextures":4,"popupRects":["popup 180x146+0+0","popup 178x140+1+1"],"viewerPopups":4,"viewerPopupSizes":["180x146","180x146","180x146","180x146"]} |
| cursor: the page's cursor reaches the viewport | yes | 1222 | {"events":["hand","text","crosshair","move"],"viewerCursors":["pointer","text","crosshair","move"]} |
| drag: an HTML5 drag inside the page, sent as plain mouse events | **no** | 1378 | {"page":["dragstart"]} |
| drag: the same, with the browser's drag handed to the viewport (CDP Input.setInterceptDrags) | yes | 1357 | {"page":["dragstart","dragenter","dragover","drop:s7-dragged","dragend:copy"],"intercepted":1,"dispatched":["dragEnter","dragOver","drop"]} |
| file chooser: answered with a file, no dialog | yes | 498 | {"choosers":[{"at":1793871624228,"mode":"selectSingle"}],"files":["s7-upload.txt:23:hello from the viewport"]} |
| a window the page opens: offscreen too, its opener kept, shown in the viewport and clicked | **no** | 4176 | {"offscreen":true,"visible":false,"size":"480x360","painting":true,"frameRate":30,"openerFramesOfTheChildSize":0,"paintsAfterRepaint":0,"pageState":"{\"clicks\":0,\"hasOpener\":true,\"loadedAt\":1793871624750}","directClick":false,"paints":0,"openerMessages":["popup:hello"],"clickedInViewport":false} |
| resize: the page reflows to the viewport, no reload | yes | 248 | {"oneMs":43,"quickThreeMs":66,"backMs":48,"resizes":["1793871613794:1000x681","1793871628865:800x560","1793871628910:900x620","1793871628961:760x520","1793871629012:820x580","1793871629071:1000x681"],"applied":["1793871613792:1000x681","1793871628863:800x560","1793871628908:900x620","1793871628951:760x520","1793871629005:820x580","1793871629069:1000x681"],"token":"same"} |
| find-in-page: matches found and drawn | yes | 3 | {"requestId":0,"matches":1,"selectionArea":{"x":202,"y":162,"width":30,"height":19},"activeMatchOrdinal":1,"finalUpdate":true} |
| DevTools: open on the offscreen tab (detached window) | yes | 783 | {"opened":true} |
| accessibility: the page's tree is there to read over CDP (the OS sees none of it) | yes | 6 | {"nodes":52,"button":true,"accessibilitySupport":false} |
| a 2x display: the device-metrics override at a scale of 2 gives the viewport 2x frames | **no** | 1610 | {"pageDpr":2,"layout":"1000x681","frame":"1000x681","viewerCanvas":"1000x681"} |
| the tab's webContents.focus(): does the hidden window take the OS focus from the viewport? | yes | 711 | {"viewerFocusedBefore":true,"after":true,"focusedWindow":"S7 viewport","pageHasFocus":true,"tabVisible":false} |

| input → frame | trials | ms p50 / p95 | parts (p50) |
| :- | :- | :- | :- |
| viewport, mouse | 20 | 19 / 35 | to the page's handler 2; to the paint event 8; paint → drawn in the viewer 2; drawn → on screen (2 rAFs) 9 |
| viewport, key | 10 | 18 / 23 | to the page's handler 2; to the paint event 7; paint → drawn in the viewer 2; drawn → on screen (2 rAFs) 9 |
| native view, mouse | 20 | 17 / 18 | to the page's handler 1 |
| native view, key | 10 | 18 / 19 | to the page's handler 1 |

| frames | numbers |
| :- | :- |
| viewport, animated page | drawnPerSec 60.3, paintsPerSec 60.3, sentPerSec 60.3, droppedPerSec 0.0, pageRafPerSec 60.0, mbPerSec 0.0, drawMsP50 0.2, drawMsP95 0.4, cpuTotal 254.7, cpuBrowser 6.7, cpuGpu 234.1, cpuOffscreenRenderer 5.2, cpuViewerRenderer 8.4 |
| viewport, smooth scroll | ms 1.0, viewerFramesPerSec 0.0, pageRafPerSec 1000.0 |
| native view, animated page | pageRafPerSec 57.0, cpuTotal 42.9, cpuBrowser 0.6, cpuGpu 36.7, cpuRenderer 5.2 |
| native view, smooth scroll | ms 5.0, pageRafPerSec 200.0 |

Windows on screen: a hidden offscreen tab and the viewer: 1 ["Chrome_WidgetWin_1 1016x746+60+60 ex 0x200100 \"S7 viewport\""]; a <select> open: 1 ["Chrome_WidgetWin_1 1016x746+60+60 ex 0x200100 \"S7 viewport\""]; a file chooser open: 1 ["Chrome_WidgetWin_1 1016x746+60+60 ex 0x200100 \"S7 viewport\""]; the page's window open (offscreen): 1 ["Chrome_WidgetWin_1 1016x746+60+60 ex 0x200100 \"S7 viewport\""]

Viewer: {"frames":386,"textures":386,"bitmaps":0,"popups":4,"draw":{"n":300,"min":0.1,"p50":0.3,"p95":0.4,"max":4.5,"mean":0.27},"errors":[]}; counters {"sent":390,"dropped":0,"fullFrames":0,"mbSent":0,"outstandingTextures":0,"forwarded":{"mouseMove":42,"mouseDown":29,"mouseUp":29,"mouseWheel":4,"keyDown":20,"keyUp":20,"char":14,"edit":1,"ime-start":1,"ime-set":2,"ime-commit":1,"paste":1,"mouseLeave":1},"errors":[],"tabTextures":390,"tabPopupTextures":4,"tabEmptyPaints":0,"tabPaints":394}

**Assertions:** PASS an offscreen tab draws with no window (CPU bitmaps asked at 30 fps: rAF above 10 Hz); PASS capturePage works on an offscreen tab; PASS four offscreen tabs put no window on screen; PASS no reload across show and hide through the viewport: same document, its timers, its socket, its form; PASS through the viewport: mouse: a click lands where the person clicked; PASS through the viewport: wheel: the page scrolls; PASS through the viewport: keys: typing, Backspace and select-all in the field; PASS through the viewport: IME: a composition in the viewport is composed and committed in the page; PASS through the viewport: paste: the person's paste reaches the page as a paste; PASS through the viewport: <select>: it opens, and the keys choose an option; PASS through the viewport: cursor: the page's cursor reaches the viewport; PASS through the viewport: drag: the same, with the browser's drag handed to the viewport (CDP Input.setInterceptDrags); PASS through the viewport: file chooser: answered with a file, no dialog; PASS through the viewport: resize: the page reflows to the viewport, no reload; PASS through the viewport: find-in-page: matches found and drawn; PASS through the viewport: DevTools: open on the offscreen tab (detached window); PASS through the viewport: accessibility: the page's tree is there to read over CDP (the OS sees none of it); PASS through the viewport: the tab's webContents.focus(): does the hidden window take the OS focus from the viewport?; PASS a known gap, pinned: an HTML5 drag sent as plain mouse events doesn't drop in an offscreen tab; PASS a known gap, pinned: a window the page opens, made offscreen, paints nothing; PASS the viewport draws an animated page at 45 fps or more

### Electron · viewport-windows (electron-viewport-windows.json)

Electron 45.2.2 (Chromium 156.0.8078.80), win32-x64 10.0.26100, ozone (default), displays 1024x768@1, status **done**, 167 s

**Round twelve, offscreen bot tabs** (never-shown OSR windows; GPU "disabled_software")

Size: default: window 1024x720, page 1024x720@1; setContentSize after creation: window 1280x800, page 1280x800@1; not resizable, then setContentSize: window 1280x800, page 1280x800@1; enableLargerThanScreen, then setContentSize: window 1280x800, page 1280x800@1; not resizable, enableLargerThanScreen, then setBounds: window 1280x800, page 1280x800@1 → **setContentSize after creation**.

Shared textures: 0 textures, 0 bitmaps, 0 empty paints in 3 s → **none here (CPU bitmaps)**; error not asked for: GPU compositing is "disabled_software" here (asking hung the main process on the Linux runners)

| config | visibility | rAF Hz | paints/s | textures/s | all CPU % | renderer % | GPU % | browser % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| offscreen, bitmap, 10 fps, animated | visible | 10.0 | 10.0 | 0.0 | 12.1 | 5.4 | 3.0 | 3.6 |  |
| offscreen, bitmap, 30 fps, animated | visible | 30.0 | 30.0 | 0.0 | 25.1 | 10.6 | 8.1 | 6.3 |  |
| offscreen, bitmap, 60 fps, animated | visible | 60.0 | 60.0 | 0.0 | 45.4 | 18.5 | 14.5 | 12.3 |  |
| offscreen, bitmap, 30 fps, painting stopped, animated | visible | 30.2 | 0.0 | 0.0 | 20.3 | 11.0 | 8.6 | 0.7 |  |
| offscreen, bitmap, 10 fps, quiet page | visible | 0.0 | 2.3 | 0.0 | 4.5 | 0.8 | 0.6 | 3.0 |  |
| offscreen, bitmap, painting stopped, quiet page | visible | 0.0 | 0.0 | 0.0 | 1.7 | 0.8 | 0.6 | 0.2 |  |
| host window, animated | visible | 64.0 | 0.0 | 0.0 | 25.2 | 20.4 | 3.7 | 1.1 |  |
| host window, quiet page | visible | 0.0 | 0.0 | 0.0 | 1.4 | 0.9 | 0.3 | 0.2 |  |

| pictures of | method | ok | ms | stale ms | size | errors |
| :- | :- | :- | :- | :- | :- | :- |
| offscreen, bitmap, painting on (10 fps) | capturePage | 5/5 | 95 / 97 | -82 / -8 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | cdpJpeg | 5/5 | 297 / 311 | -271 / -267 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | osrPaint | 5/5 | 0 / 0 | 32 / 37 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | newest paint → JPEG | 5/5 | 6 / 7 | – | 1280x800 |  |
| offscreen, bitmap, painting stopped | capturePage | 5/5 | 96 / 98 | -84 / -7 | 1280x800 |  |
| offscreen, bitmap, painting stopped | cdpJpeg | 5/5 | 298 / 313 | -273 / -173 | 1280x800 |  |
| host window | capturePage | 5/5 | 20 / 21 | 6 / 11 | 1280x800 |  |
| host window | cdpJpeg | 5/5 | 83 / 90 | -44 / -32 | 1280x800 |  |

| cost | MiB a tab | CPU % a tab | kind | error |
| :- | :- | :- | :- | :- |
| 4 quiet offscreen tabs (bitmap, 10 fps) | 36.4 | 2.21 | privateBytes |  |
| 4 quiet offscreen tabs (bitmap), painting stopped | 15.1 | 1.46 | privateBytes |  |
| 4 quiet tabs in one shared host window | 26.4 | 1.23 | privateBytes |  |

Windows on screen: 4 offscreen tabs open (nothing else shown): 0 []; 4 tabs in the shared host window: 1 ["Chrome_WidgetWin_1 48x40+-8+0 ex 0x82801a0 \"S7 shared host\""]

**Round twelve, the viewport** (mode **bitmap**: no shared textures on this machine (GPU compositing "disabled_software"): CPU bitmaps)

Shows: #1 first frame 19 ms, at the viewport's size 30 ms (1000x681, frame 1000x681), hidden again 2 ms; #2 first frame 19 ms, at the viewport's size 27 ms (1000x681, frame 1000x681), hidden again 3 ms

| oracle | same document | timers | SSE socket | form | layout | detail |
| :- | :- | :- | :- | :- | :- | :- |
| shown (first time) | true | true | true | true | 1000x681@1 | token same, loads +0, navigations +0, ticks 15→25, sse opens 1 (server 1) msgs 14→24, field "typed by the bot", checked true |
| hidden again (the agent's 1280x800) | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 327→342, sse opens 1 (server 1) msgs 319→334, field "x日本s7-paste-ok", checked true |
| shown again | true | true | true | true | 1000x681@1 | token same, loads +0, navigations +0, ticks 342→350, sse opens 1 (server 1) msgs 334→342, field "x日本s7-paste-ok", checked true |
| hidden at the end | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 350→366, sse opens 1 (server 1) msgs 342→357, field "x日本s7-paste-ok", checked true |

| through the viewport | ok | ms | detail |
| :- | :- | :- | :- |
| mouse: a click lands where the person clicked | yes | 109 | {"at":"260,40","page":{"x":260,"y":40,"t":1793871370285},"forwarded":{"mouseMove":1,"mouseDown":1,"mouseUp":1}} |
| wheel: the page scrolls | yes | 328 | {"scrollY":600,"wheels":4,"forwardedWheels":4} |
| keys: typing, Backspace and select-all in the field | yes | 1233 | {"typed":"typed by the botabc","afterBackspace":"typed by the botab","afterSelectAllAndX":"x","focused":"field","pageHasFocus":true,"keys":["End","a","b","c","Backspace","x"]} |
| IME: a composition in the viewport is composed and committed in the page | yes | 1177 | {"field":"x日本","midField":"xにほ","compositions":["start:","update:にほ","update:日本","update:日本","end:日本"],"forwarded":{"set":2,"commit":1,"text":0}} |
| paste: the person's paste reaches the page as a paste | yes | 947 | {"field":"x日本s7-paste-ok","pasteEvents":["s7-paste-ok"],"clipboard":{},"forwarded":1} |
| <select>: it opens, and the keys choose an option | yes | 2330 | {"value":"c","changes":["c"],"popupTextures":0,"popupRects":["bitmap 180x146+480+48","bitmap 180x146+480+48","bitmap 180x146+480+48"],"viewerPopups":0,"viewerPopupSizes":[]} |
| cursor: the page's cursor reaches the viewport | yes | 1221 | {"events":["hand","text","crosshair","move"],"viewerCursors":["pointer","text","crosshair","move"]} |
| drag: an HTML5 drag inside the page, sent as plain mouse events | **no** | 1371 | {"page":["dragstart"]} |
| drag: the same, with the browser's drag handed to the viewport (CDP Input.setInterceptDrags) | yes | 1395 | {"page":["dragstart","dragenter","dragover","drop:s7-dragged","dragend:copy"],"intercepted":1,"dispatched":["dragEnter","dragOver","drop"]} |
| file chooser: answered with a file, no dialog | yes | 487 | {"choosers":[{"at":1793871380410,"mode":"selectSingle"}],"files":["s7-upload.txt:23:hello from the viewport"]} |
| a window the page opens: offscreen too, its opener kept, shown in the viewport and clicked | **no** | 4188 | {"offscreen":true,"visible":false,"size":"480x360","painting":true,"frameRate":30,"openerFramesOfTheChildSize":0,"paintsAfterRepaint":0,"pageState":"{\"clicks\":0,\"hasOpener\":true,\"loadedAt\":1793871380918}","directClick":false,"paints":0,"openerMessages":["popup:hello"],"clickedInViewport":false} |
| resize: the page reflows to the viewport, no reload | yes | 190 | {"oneMs":23,"quickThreeMs":29,"backMs":44,"resizes":["1793871369612:1000x681","1793871385049:800x560","1793871385079:900x620","1793871385131:760x520","1793871385161:820x580","1793871385196:1000x681"],"applied":["1793871369611:1000x681","1793871385047:800x560","1793871385072:900x620","1793871385117:760x520","1793871385156:820x580","1793871385195:1000x681"],"token":"same"} |
| find-in-page: matches found and drawn | yes | 4 | {"requestId":0,"matches":1,"selectionArea":{"x":202,"y":162,"width":30,"height":19},"activeMatchOrdinal":1,"finalUpdate":true} |
| DevTools: open on the offscreen tab (detached window) | yes | 785 | {"opened":true} |
| accessibility: the page's tree is there to read over CDP (the OS sees none of it) | yes | 6 | {"nodes":52,"button":true,"accessibilitySupport":false} |
| a 2x display: the device-metrics override at a scale of 2 gives the viewport 2x frames | **no** | 1605 | {"pageDpr":2,"layout":"1000x681","frame":"1000x681","viewerCanvas":"1000x681"} |
| the tab's webContents.focus(): does the hidden window take the OS focus from the viewport? | yes | 716 | {"viewerFocusedBefore":true,"after":true,"focusedWindow":"S7 viewport","pageHasFocus":true,"tabVisible":false} |

| input → frame | trials | ms p50 / p95 | parts (p50) |
| :- | :- | :- | :- |
| viewport, mouse | 20 | 15 / 28 | to the page's handler 1; to the paint event 3; paint → drawn in the viewer 1; drawn → on screen (2 rAFs) 11 |
| viewport, key | 10 | 14 / 18 | to the page's handler 1; to the paint event 3; paint → drawn in the viewer 1; drawn → on screen (2 rAFs) 11 |
| native view, mouse | 20 | 9 / 14 | to the page's handler 0 |
| native view, key | 10 | 12 / 17 | to the page's handler 0 |

| frames | numbers |
| :- | :- |
| viewport, animated page | drawnPerSec 60.0, paintsPerSec 60.0, sentPerSec 60.0, droppedPerSec 0.0, pageRafPerSec 60.0, mbPerSec 58.6, drawMsP50 0.7, drawMsP95 0.9, cpuTotal 57.2, cpuBrowser 22.7, cpuGpu 8.9, cpuOffscreenRenderer 6.7, cpuViewerRenderer 18.7 |
| viewport, smooth scroll | ms 4.0, viewerFramesPerSec 250.0, pageRafPerSec 250.0 |
| native view, animated page | pageRafPerSec 64.0, cpuTotal 13.4, cpuBrowser 0.6, cpuGpu 6.0, cpuRenderer 6.5 |
| native view, smooth scroll | ms 10.0, pageRafPerSec 100.0 |

Windows on screen: a hidden offscreen tab and the viewer: 1 ["Chrome_WidgetWin_1 1016x746+60+60 ex 0x200100 \"S7 viewport\""]; a <select> open: 1 ["Chrome_WidgetWin_1 1016x746+60+60 ex 0x200100 \"S7 viewport\""]; a file chooser open: 1 ["Chrome_WidgetWin_1 1016x746+60+60 ex 0x200100 \"S7 viewport\""]; the page's window open (offscreen): 1 ["Chrome_WidgetWin_1 1016x746+60+60 ex 0x200100 \"S7 viewport\""]

Viewer: {"frames":493,"textures":0,"bitmaps":493,"popups":0,"draw":{"n":300,"min":0.6,"p50":0.7,"p95":1,"max":6,"mean":0.77},"errors":[]}; counters {"sent":493,"dropped":0,"fullFrames":2,"mbSent":370.68,"outstandingTextures":0,"forwarded":{"mouseMove":42,"mouseDown":29,"mouseUp":29,"mouseWheel":4,"keyDown":20,"keyUp":20,"char":14,"edit":1,"ime-start":1,"ime-set":2,"ime-commit":1,"paste":1,"mouseLeave":1},"errors":[],"tabTextures":0,"tabPopupTextures":0,"tabEmptyPaints":0,"tabPaints":501}

**Assertions:** PASS an offscreen tab draws with no window (CPU bitmaps asked at 30 fps: rAF above 10 Hz); PASS capturePage works on an offscreen tab; PASS four offscreen tabs put no window on screen; PASS no reload across show and hide through the viewport: same document, its timers, its socket, its form; PASS through the viewport: mouse: a click lands where the person clicked; PASS through the viewport: wheel: the page scrolls; PASS through the viewport: keys: typing, Backspace and select-all in the field; PASS through the viewport: IME: a composition in the viewport is composed and committed in the page; PASS through the viewport: paste: the person's paste reaches the page as a paste; PASS through the viewport: <select>: it opens, and the keys choose an option; PASS through the viewport: cursor: the page's cursor reaches the viewport; PASS through the viewport: drag: the same, with the browser's drag handed to the viewport (CDP Input.setInterceptDrags); PASS through the viewport: file chooser: answered with a file, no dialog; PASS through the viewport: resize: the page reflows to the viewport, no reload; PASS through the viewport: find-in-page: matches found and drawn; PASS through the viewport: DevTools: open on the offscreen tab (detached window); PASS through the viewport: accessibility: the page's tree is there to read over CDP (the OS sees none of it); PASS through the viewport: the tab's webContents.focus(): does the hidden window take the OS focus from the viewport?; PASS a known gap, pinned: an HTML5 drag sent as plain mouse events doesn't drop in an offscreen tab; PASS a known gap, pinned: a window the page opens, made offscreen, paints nothing; PASS the viewport draws an animated page at 45 fps or more

