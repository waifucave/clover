## Spike S7 results

### Chrome for Testing · linux-arm64 (cft-linux-arm64-install.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 5 s

**chrome-headless-shell** — ; sandbox –

- install: 121 MiB archive, 277 MiB unpacked, 287 files, 0 symlinks; download 1045 ms, unpack 996 ms; sha256 `5bb6a00a4285c13303d3f72c5afdb70f144ea7a93eed462365a52b69631c9607` (matches the pin; server MD5 true)

**chrome** — ; sandbox –

- install: 191 MiB archive, 401 MiB unpacked, 301 files, 0 symlinks; download 916 ms, unpack 1335 ms; sha256 `1f496a826c9ba4d6a5f5bf2de686145fe718528c2cc3dbeb96b5893b89653724` (matches the pin; server MD5 true)

**Assertions:** PASS the headless shell installs from its pin

### Chrome for Testing · linux-arm64 (cft-linux-arm64-worker.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 203 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 121 MiB archive, 277 MiB unpacked, 287 files, 0 symlinks; download 1045 ms, unpack 996 ms; sha256 `5bb6a00a4285c13303d3f72c5afdb70f144ea7a93eed462365a52b69631c9607` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 55 ms, warm 51 ms; the port for comparison 58 ms
- start attempts: fdpipe ok 55 ms
- tabs: own window: first (background): visible, 1280x800, interval 99.9 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x800, interval 99.9 Hz, rAF 60.0 Hz; one window: first (background): visible, 1280x800, interval 99.9 Hz, rAF 60.2 Hz; one window: second (front): visible, 1280x800, interval 99.9 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.0 Hz, media ×0.94, decoded 28.8 fps, audio running, set up in 35 ms, browser answers in 0 ms
- resize to 1000×700 and back: 4 ms / 2 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 216 / 221 ms (640 KiB, CPU 330 ms), jpeg 71 / 80 ms (166 KiB, stale -42 / -34 ms, CPU 130 ms)
- screencast: 60.3 fps, 66845 kbit/s, 135 KiB/frame, latency 32 / 33 ms, browser CPU 144%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 175 MiB, per idle tab 30 MiB, 4 browser contexts +119 MiB, a second bot's browser 119 MiB (7 processes), animated tab 51.3% CPU
  - steps: 0 tabs 175 MiB pss / 0.0%, 1 tabs 217 MiB pss / 2.7%, 2 tabs 247 MiB pss / 6.2%, 4 tabs 303 MiB pss / 12.7%, 8 tabs 413 MiB pss / 24.4%

**chrome** — Chrome/156.0.8078.80; sandbox on

- install: 191 MiB archive, 401 MiB unpacked, 301 files, 0 symlinks; download 916 ms, unpack 1335 ms; sha256 `1f496a826c9ba4d6a5f5bf2de686145fe718528c2cc3dbeb96b5893b89653724` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 228 ms, warm 207 ms; the port for comparison 235 ms
- start attempts: fdpipe ok 228 ms
- tabs: own window: first (background): visible, 1280x657, interval 99.9 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x657, interval 99.9 Hz, rAF 60.1 Hz; one window: first (background): hidden, 1280x657, interval 2.0 Hz, rAF 0.0 Hz; one window: second (front): visible, 1280x657, interval 100.1 Hz, rAF 60.1 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.0 Hz, media ×0.95, decoded 28.8 fps, audio running, set up in 80 ms, browser answers in 1 ms
- resize to 1000×700 and back: 2 ms / 22 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 185 / 196 ms (524 KiB, CPU 300 ms), jpeg 73 / 79 ms (145 KiB, stale -41 / -38 ms, CPU 135 ms)
- screencast: 60.3 fps, 58111 kbit/s, 118 KiB/frame, latency 31 / 32 ms, browser CPU 134%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 424 MiB, per idle tab 60 MiB, 4 browser contexts +332 MiB, a second bot's browser 267 MiB (10 processes), animated tab 55.8% CPU
  - steps: 0 tabs 424 MiB pss / 1.0%, 1 tabs 503 MiB pss / 2.7%, 2 tabs 582 MiB pss / 6.5%, 4 tabs 657 MiB pss / 12.9%, 8 tabs 905 MiB pss / 25.0%

**Assertions:** PASS the headless shell installs from its pin; PASS it starts over the native DevTools pipe; PASS it runs sandboxed; PASS no step failed; PASS every tab is visible and draws (rAF above 10 Hz); PASS screenshots and a screencast arrive, fresh; PASS per-bot profiles are apart and survive a restart

### Chrome for Testing · linux-arm64 (cft-linux-arm64.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 204 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 121 MiB archive, 277 MiB unpacked, 287 files, 0 symlinks; download 1045 ms, unpack 996 ms; sha256 `5bb6a00a4285c13303d3f72c5afdb70f144ea7a93eed462365a52b69631c9607` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 182 ms, warm 45 ms; the port for comparison 66 ms
- start attempts: fdpipe ok 182 ms
- tabs: own window: first (background): visible, 1280x800, interval 99.9 Hz, rAF 60.2 Hz; own window: second (front): visible, 1280x800, interval 99.9 Hz, rAF 60.0 Hz; one window: first (background): visible, 1280x800, interval 100.1 Hz, rAF 60.2 Hz; one window: second (front): visible, 1280x800, interval 99.9 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.0 Hz, media ×0.91, decoded 29.0 fps, audio running, set up in 196 ms, browser answers in 0 ms
- resize to 1000×700 and back: 2 ms / 22 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 217 / 229 ms (648 KiB, CPU 330 ms), jpeg 76 / 83 ms (165 KiB, stale -44 / -34 ms, CPU 134 ms)
- screencast: 60.4 fps, 66903 kbit/s, 135 KiB/frame, latency 32 / 34 ms, browser CPU 144%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 175 MiB, per idle tab 30 MiB, 4 browser contexts +119 MiB, a second bot's browser 113 MiB (7 processes), animated tab 50.6% CPU
  - steps: 0 tabs 175 MiB pss / 0.5%, 1 tabs 217 MiB pss / 2.7%, 2 tabs 247 MiB pss / 6.2%, 4 tabs 303 MiB pss / 11.7%, 8 tabs 413 MiB pss / 22.4%

**chrome** — Chrome/156.0.8078.80; sandbox on

- install: 191 MiB archive, 401 MiB unpacked, 301 files, 0 symlinks; download 916 ms, unpack 1335 ms; sha256 `1f496a826c9ba4d6a5f5bf2de686145fe718528c2cc3dbeb96b5893b89653724` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 327 ms, warm 217 ms; the port for comparison 261 ms
- start attempts: fdpipe ok 327 ms
- tabs: own window: first (background): visible, 1280x657, interval 100.1 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x657, interval 100.1 Hz, rAF 60.0 Hz; one window: first (background): hidden, 1280x657, interval 1.0 Hz, rAF 0.0 Hz; one window: second (front): visible, 1280x657, interval 100.1 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.0 Hz, media ×0.94, decoded 28.8 fps, audio running, set up in 59 ms, browser answers in 1 ms
- resize to 1000×700 and back: 3 ms / 21 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 186 / 199 ms (522 KiB, CPU 301 ms), jpeg 72 / 74 ms (144 KiB, stale -40 / -37 ms, CPU 138 ms)
- screencast: 60.5 fps, 58333 kbit/s, 118 KiB/frame, latency 31 / 32 ms, browser CPU 134%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 449 MiB, per idle tab 55 MiB, 4 browser contexts +336 MiB, a second bot's browser 288 MiB (12 processes), animated tab 56.1% CPU
  - steps: 0 tabs 449 MiB pss / 1.5%, 1 tabs 525 MiB pss / 3.5%, 2 tabs 606 MiB pss / 6.0%, 4 tabs 680 MiB pss / 12.7%, 8 tabs 886 MiB pss / 22.8%

**Assertions:** PASS the headless shell installs from its pin; PASS it starts over the native DevTools pipe; PASS it runs sandboxed; PASS no step failed; PASS every tab is visible and draws (rAF above 10 Hz); PASS screenshots and a screencast arrive, fresh; PASS per-bot profiles are apart and survive a restart

### Chrome for Testing · linux-x64 (cft-linux-x64-install.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 4 s

**chrome-headless-shell** — ; sandbox –

- install: 121 MiB archive, 274 MiB unpacked, 287 files, 0 symlinks; download 673 ms, unpack 1072 ms; sha256 `547dcd374e02961bf998f6046a267644f8502225c36bb78ca307dab32a0b3eb4` (matches the pin; server MD5 true)

**chrome** — ; sandbox –

- install: 192 MiB archive, 403 MiB unpacked, 301 files, 0 symlinks; download 673 ms, unpack 1459 ms; sha256 `b711c720f774be355197f32edf37e0651418ba036d92446ee2da19ac017540a7` (matches the pin; server MD5 true)

**Assertions:** PASS the headless shell installs from its pin

### Chrome for Testing · linux-x64 (cft-linux-x64-worker.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 203 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 121 MiB archive, 274 MiB unpacked, 287 files, 0 symlinks; download 673 ms, unpack 1072 ms; sha256 `547dcd374e02961bf998f6046a267644f8502225c36bb78ca307dab32a0b3eb4` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 58 ms, warm 61 ms; the port for comparison 60 ms
- start attempts: fdpipe ok 58 ms
- tabs: own window: first (background): visible, 1280x800, interval 100.0 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x800, interval 100.0 Hz, rAF 60.0 Hz; one window: first (background): visible, 1280x800, interval 100.0 Hz, rAF 60.0 Hz; one window: second (front): visible, 1280x800, interval 100.0 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.0 Hz, media ×0.94, decoded 28.8 fps, audio running, set up in 42 ms, browser answers in 0 ms
- resize to 1000×700 and back: 1 ms / 22 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 247 / 261 ms (647 KiB, CPU 285 ms), jpeg 78 / 91 ms (163 KiB, stale -43 / -35 ms, CPU 94 ms)
- screencast: 60.1 fps, 66313 kbit/s, 135 KiB/frame, latency 32 / 36 ms, browser CPU 128%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 172 MiB, per idle tab 29 MiB, 4 browser contexts +117 MiB, a second bot's browser 113 MiB (7 processes), animated tab 20.9% CPU
  - steps: 0 tabs 172 MiB pss / 0.0%, 1 tabs 213 MiB pss / 3.5%, 2 tabs 242 MiB pss / 6.5%, 4 tabs 297 MiB pss / 10.7%, 8 tabs 407 MiB pss / 16.9%

**chrome** — Chrome/156.0.8078.80; sandbox on

- install: 192 MiB archive, 403 MiB unpacked, 301 files, 0 symlinks; download 673 ms, unpack 1459 ms; sha256 `b711c720f774be355197f32edf37e0651418ba036d92446ee2da19ac017540a7` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 214 ms, warm 224 ms; the port for comparison 216 ms
- start attempts: fdpipe ok 214 ms
- tabs: own window: first (background): visible, 1280x657, interval 100.2 Hz, rAF 60.2 Hz; own window: second (front): visible, 1280x657, interval 100.1 Hz, rAF 60.2 Hz; one window: first (background): hidden, 1280x657, interval 1.0 Hz, rAF 0.0 Hz; one window: second (front): visible, 1280x657, interval 100.0 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.2 Hz, media ×0.95, decoded 28.8 fps, audio running, set up in 105 ms, browser answers in 1 ms
- resize to 1000×700 and back: 1 ms / 21 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 215 / 231 ms (523 KiB, CPU 264 ms), jpeg 71 / 73 ms (145 KiB, stale -40 / -36 ms, CPU 84 ms)
- screencast: 60.5 fps, 58214 kbit/s, 117 KiB/frame, latency 30 / 31 ms, browser CPU 109%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 411 MiB, per idle tab 61 MiB, 4 browser contexts +330 MiB, a second bot's browser 260 MiB (10 processes), animated tab 29.9% CPU
  - steps: 0 tabs 411 MiB pss / 0.3%, 1 tabs 494 MiB pss / 2.5%, 2 tabs 550 MiB pss / 4.5%, 4 tabs 653 MiB pss / 8.9%, 8 tabs 898 MiB pss / 16.3%

**Assertions:** PASS the headless shell installs from its pin; PASS it starts over the native DevTools pipe; PASS it runs sandboxed; PASS no step failed; PASS every tab is visible and draws (rAF above 10 Hz); PASS screenshots and a screencast arrive, fresh; PASS per-bot profiles are apart and survive a restart

### Chrome for Testing · linux-x64 (cft-linux-x64.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 205 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 121 MiB archive, 274 MiB unpacked, 287 files, 0 symlinks; download 673 ms, unpack 1072 ms; sha256 `547dcd374e02961bf998f6046a267644f8502225c36bb78ca307dab32a0b3eb4` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 139 ms, warm 62 ms; the port for comparison 74 ms
- start attempts: fdpipe ok 139 ms
- tabs: own window: first (background): visible, 1280x800, interval 100.0 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x800, interval 100.0 Hz, rAF 60.0 Hz; one window: first (background): visible, 1280x800, interval 100.0 Hz, rAF 60.2 Hz; one window: second (front): visible, 1280x800, interval 99.9 Hz, rAF 60.2 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.2 Hz, rAF 60.2 Hz, media ×0.95, decoded 29.0 fps, audio running, set up in 76 ms, browser answers in 0 ms
- resize to 1000×700 and back: 2 ms / 21 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 245 / 257 ms (640 KiB, CPU 278 ms), jpeg 76 / 82 ms (165 KiB, stale -44 / -35 ms, CPU 83 ms)
- screencast: 60.5 fps, 66662 kbit/s, 135 KiB/frame, latency 31 / 33 ms, browser CPU 123%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 171 MiB, per idle tab 29 MiB, 4 browser contexts +116 MiB, a second bot's browser 115 MiB (7 processes), animated tab 24.4% CPU
  - steps: 0 tabs 171 MiB pss / 0.0%, 1 tabs 212 MiB pss / 2.5%, 2 tabs 241 MiB pss / 5.0%, 4 tabs 296 MiB pss / 9.2%, 8 tabs 406 MiB pss / 15.9%

**chrome** — Chrome/156.0.8078.80; sandbox on

- install: 192 MiB archive, 403 MiB unpacked, 301 files, 0 symlinks; download 673 ms, unpack 1459 ms; sha256 `b711c720f774be355197f32edf37e0651418ba036d92446ee2da19ac017540a7` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 271 ms, warm 212 ms; the port for comparison 242 ms
- start attempts: fdpipe ok 271 ms
- tabs: own window: first (background): visible, 1280x657, interval 100.2 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x657, interval 100.0 Hz, rAF 60.0 Hz; one window: first (background): hidden, 1280x657, interval 1.8 Hz, rAF 0.0 Hz; one window: second (front): visible, 1280x657, interval 100.2 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.1 Hz, rAF 60.0 Hz, media ×0.95, decoded 28.8 fps, audio running, set up in 88 ms, browser answers in 0 ms
- resize to 1000×700 and back: 1 ms / 22 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 219 / 234 ms (523 KiB, CPU 266 ms), jpeg 71 / 79 ms (143 KiB, stale -40 / -36 ms, CPU 95 ms)
- screencast: 60.6 fps, 58217 kbit/s, 117 KiB/frame, latency 30 / 32 ms, browser CPU 110%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 438 MiB, per idle tab 58 MiB, 4 browser contexts +329 MiB, a second bot's browser 285 MiB (12 processes), animated tab 32.8% CPU
  - steps: 0 tabs 438 MiB pss / 0.7%, 1 tabs 518 MiB pss / 2.5%, 2 tabs 575 MiB pss / 5.2%, 4 tabs 678 MiB pss / 8.9%, 8 tabs 902 MiB pss / 18.0%

**Assertions:** PASS the headless shell installs from its pin; PASS it starts over the native DevTools pipe; PASS it runs sandboxed; PASS no step failed; PASS every tab is visible and draws (rAF above 10 Hz); PASS screenshots and a screencast arrive, fresh; PASS per-bot profiles are apart and survive a restart

### Chrome for Testing · darwin-arm64 (cft-macos-install.json)

25.6.0, 5 CPUs, 14 GiB, Bun 1.3.14, status **done**, 5 s

**chrome-headless-shell** — ; sandbox –

- install: 99 MiB archive, 204 MiB unpacked, 16 files, 0 symlinks; download 1130 ms, unpack 693 ms; sha256 `ea615baa2e9caf0d02d1898a6562b5f8fa9c35239707dae0f592178df5b986ac` (matches the pin; server MD5 true)

**chrome** — ; sandbox –

- install: 186 MiB archive, 366 MiB unpacked, 344 files, 5 symlinks; download 2124 ms, unpack 1194 ms; sha256 `8bc590d1b1acac042a000234c768f31830f25a3983a83ed5e067114c87c4cad1` (matches the pin; server MD5 true)

**Assertions:** PASS the headless shell installs from its pin

### Chrome for Testing · darwin-arm64 (cft-macos.json)

25.6.0, 5 CPUs, 14 GiB, Bun 1.3.14, status **done**, 215 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 99 MiB archive, 204 MiB unpacked, 16 files, 0 symlinks; download 1130 ms, unpack 693 ms; sha256 `ea615baa2e9caf0d02d1898a6562b5f8fa9c35239707dae0f592178df5b986ac` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 134 ms, warm 81 ms; the port for comparison 82 ms
- start attempts: fdpipe ok 134 ms
- tabs: own window: first (background): visible, 1280x800, interval 63.9 Hz, rAF 45.5 Hz; own window: second (front): visible, 1280x800, interval 62.3 Hz, rAF 45.9 Hz; one window: first (background): visible, 1280x800, interval 65.3 Hz, rAF 45.9 Hz; one window: second (front): visible, 1280x800, interval 66.7 Hz, rAF 42.9 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 62.9 Hz, rAF 28.2 Hz, media ×1.01, decoded 29.6 fps, audio running, set up in 202 ms, browser answers in 1 ms
- resize to 1000×700 and back: 5 ms / 28 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 310 / 339 ms (638 KiB, CPU 245 ms), jpeg 122 / 179 ms (130 KiB, stale -73 / -34 ms, CPU 79 ms)
- screencast: 36.8 fps, 35121 kbit/s, 117 KiB/frame, latency 64 / 85 ms, browser CPU 60%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 45 MiB, per idle tab 46 MiB, 4 browser contexts +179 MiB, a second bot's browser 45 MiB (4 processes), animated tab 21.0% CPU
  - steps: 0 tabs 45 MiB footprint / 0.7%, 1 tabs 91 MiB footprint / 3.0%, 2 tabs 137 MiB footprint / 5.2%, 4 tabs 228 MiB footprint / 10.9%, 8 tabs 410 MiB footprint / 22.6%

**chrome** — Chrome/156.0.8078.80; sandbox on

- install: 186 MiB archive, 366 MiB unpacked, 344 files, 5 symlinks; download 2124 ms, unpack 1194 ms; sha256 `8bc590d1b1acac042a000234c768f31830f25a3983a83ed5e067114c87c4cad1` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 974 ms, warm 408 ms; the port for comparison 523 ms
- start attempts: fdpipe ok 974 ms
- tabs: own window: first (background): visible, 1280x657, interval 57.1 Hz, rAF 27.0 Hz; own window: second (front): hidden, 1280x657, interval 1.0 Hz, rAF 0.0 Hz; one window: first (background): hidden, 1280x657, interval 1.8 Hz, rAF 0.0 Hz; one window: second (front): visible, 1280x657, interval 59.9 Hz, rAF 26.4 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 60.7 Hz, rAF 30.8 Hz, media ×0.93, decoded 28.6 fps, audio running, set up in 196 ms, browser answers in 0 ms
- resize to 1000×700 and back: 6 ms / 51 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 227 / 350 ms (481 KiB, CPU 169 ms), jpeg 155 / 226 ms (120 KiB, stale -94 / -27 ms, CPU 44 ms)
- screencast: 28.5 fps, 23657 kbit/s, 101 KiB/frame, latency 73 / 94 ms, browser CPU 30%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 269 MiB, per idle tab 53 MiB, 4 browser contexts +448 MiB, a second bot's browser 274 MiB (10 processes), animated tab 16.5% CPU
  - steps: 0 tabs 269 MiB footprint / 3.0%, 1 tabs 374 MiB footprint / 7.9%, 2 tabs 427 MiB footprint / 7.9%, 4 tabs 503 MiB footprint / 9.1%, 8 tabs 691 MiB footprint / 9.6%

**Assertions:** PASS the headless shell installs from its pin; PASS it starts over the native DevTools pipe; PASS it runs sandboxed; PASS no step failed; PASS every tab is visible and draws (rAF above 10 Hz); PASS screenshots and a screencast arrive, fresh; PASS per-bot profiles are apart and survive a restart

### Chrome for Testing · win32-x64 (cft-windows-install.json)

10.0.26100, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 5 s

**chrome-headless-shell** — ; sandbox –

- install: 120 MiB archive, 282 MiB unpacked, 288 files, 0 symlinks; download 692 ms, unpack 1289 ms; sha256 `10a77466005e7f64e00f1a75fd1ea81f4a38a60093c65fea6895843b26e60a9a` (matches the pin; server MD5 true)

**chrome** — ; sandbox –

- install: 199 MiB archive, 439 MiB unpacked, 305 files, 0 symlinks; download 1015 ms, unpack 2218 ms; sha256 `16edb57d6107bf1c48a7c149b8d78b155fe614410093796dd72441fd6640540f` (matches the pin; server MD5 true)

**Assertions:** PASS the headless shell installs from its pin

### Chrome for Testing · win32-x64 (cft-windows.json)

10.0.26100, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 240 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 120 MiB archive, 282 MiB unpacked, 288 files, 0 symlinks; download 692 ms, unpack 1289 ms; sha256 `10a77466005e7f64e00f1a75fd1ea81f4a38a60093c65fea6895843b26e60a9a` (matches the pin; server MD5 true)
- start: over **winpipe**, cold 153 ms, warm 143 ms; the port for comparison 118 ms
- start attempts: winpipe ok 153 ms
- tabs: own window: first (background): visible, 1280x800, interval 100.0 Hz, rAF 60.1 Hz; own window: second (front): visible, 1280x800, interval 100.0 Hz, rAF 59.9 Hz; one window: first (background): visible, 1280x800, interval 100.2 Hz, rAF 60.1 Hz; one window: second (front): visible, 1280x800, interval 100.0 Hz, rAF 59.9 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.1 Hz, rAF 60.0 Hz, media ×0.99, decoded 29.2 fps, audio running, set up in 61 ms, browser answers in 5 ms
- resize to 1000×700 and back: 12 ms / 32 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 276 / 283 ms (570 KiB, CPU 475 ms), jpeg 75 / 90 ms (143 KiB, stale -38 / -34 ms, CPU 174 ms)
- screencast: 58.9 fps, 55473 kbit/s, 115 KiB/frame, latency 41 / 46 ms, browser CPU 169%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 69 MiB, per idle tab 31 MiB, 4 browser contexts +121 MiB, a second bot's browser 69 MiB (5 processes), animated tab 48.0% CPU
  - steps: 0 tabs 69 MiB privateBytes / 0.0%, 1 tabs 99 MiB privateBytes / 2.1%, 2 tabs 129 MiB privateBytes / 14.8%, 4 tabs 192 MiB privateBytes / 19.1%, 8 tabs 315 MiB privateBytes / 29.1%

**chrome** — Chrome/156.0.8078.80; sandbox on

- install: 199 MiB archive, 439 MiB unpacked, 305 files, 0 symlinks; download 1015 ms, unpack 2218 ms; sha256 `16edb57d6107bf1c48a7c149b8d78b155fe614410093796dd72441fd6640540f` (matches the pin; server MD5 true)
- start: over **winpipe**, cold 722 ms, warm 418 ms; the port for comparison 407 ms
- start attempts: winpipe ok 722 ms
- tabs: own window: first (background): visible, 1264x649, interval 100.0 Hz, rAF 60.1 Hz; own window: second (front): visible, 1264x649, interval 100.0 Hz, rAF 60.1 Hz; one window: first (background): hidden, 1264x649, interval 1.0 Hz, rAF 0.0 Hz; one window: second (front): visible, 1264x649, interval 100.0 Hz, rAF 59.9 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 59.9 Hz, media ×0.99, decoded 29.1 fps, audio running, set up in 56 ms, browser answers in 4 ms
- resize to 1000×700 and back: 9 ms / 10 ms, same document true (1264 → 1000 → 1264)
- screenshots: png 234 / 261 ms (469 KiB, CPU 469 ms), jpeg 79 / 86 ms (104 KiB, stale -44 / -34 ms, CPU 150 ms)
- screencast: 60.5 fps, 47588 kbit/s, 96 KiB/frame, latency 34 / 41 ms, browser CPU 121%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 266 MiB, per idle tab 51 MiB, 4 browser contexts +489 MiB, a second bot's browser 258 MiB (11 processes), animated tab 40.9% CPU
  - steps: 0 tabs 266 MiB privateBytes / 15.1%, 1 tabs 344 MiB privateBytes / 3.8%, 2 tabs 406 MiB privateBytes / 5.9%, 4 tabs 463 MiB privateBytes / 10.7%, 8 tabs 676 MiB privateBytes / 20.8%

**Assertions:** PASS the headless shell installs from its pin; PASS it starts over the native DevTools pipe; PASS it runs sandboxed; PASS no step failed; PASS every tab is visible and draws (rAF above 10 Hz); PASS screenshots and a screencast arrive, fresh; PASS per-bot profiles are apart and survive a restart

### Electron · linux-arm64-ozone-headless (electron-linux-arm64-ozone-headless.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-arm64 7.0.0-1017-azure, ozone headless, displays 1920x1080@1, status **done**, 574 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.91 | 27.7 | 43 / 94 | 1 / 6 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.95 | 28.4 | 27 / 37 | 4 / 4 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.4 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.96 | 28.4 | 27 / 41 | 2 / 14 | 1280x800@1 → 1000x700@1 → 1280x800 | 1 / 1 | 2.3 |  |
| invisibleWindow | true | true | true | true (1) | 0.96 | 28.6 | 40 / 41 | 0 / 0 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.0 |  |
| tinyWindow | true | true | true | true (1) | 0.96 | 28.6 | 26 / 41 | 2 / 14 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.0 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | IO / RO Hz | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 100.0 | 99.2 | 60.0 | 17 | 2.2 / 2.2 | – | – | – | 5.4 | 7.2 |  |
| detached, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.0 |  |
| detached, throttling off | visible | 1280x800 | 100.1 | 99.3 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 1.0 | 1.0 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.2 |  |
| never-shown window, throttling off | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 1.0 | 1.2 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 99.9 | 99.3 | 1.0 | 1017 | 0.0 / 0.0 | – | – | – | 1.4 | 1.4 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 100.1 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 0.8 | 0.8 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 100.1 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 1.0 | 1.0 |  |
| invisible shown window, throttling off | visible | 1280x800 | 99.9 | 99.1 | 60.0 | 17 | 1.8 / 1.8 | – | – | – | 5.4 | 7.8 |  |
| 1x1 shown window, throttling off | visible | 1280x800 | 99.9 | 99.1 | 60.2 | 17 | 1.8 / 2.0 | – | – | – | 5.2 | 6.8 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 100.0 | 99.4 | 60.2 | 17 | 2.0 / 2.0 | – | – | – | 5.6 | 7.2 | cover 0,0 1920x1080 over host 0,0 1x1 |
| 1x1 shown window kept above a cover window (always on top) | visible | 1280x800 | 100.0 | 99.2 | 60.2 | 17 | 2.0 / 2.2 | – | – | – | 5.6 | 7.2 | cover 0,0 1920x1080 over host 0,0 1x1 |
| invisible shown window, covered by another window | visible | 1280x800 | 99.9 | 99.3 | 60.2 | 17 | 2.0 / 2.2 | – | – | – | 5.4 | 7.6 | cover -1480,-1000 1920x1080 over host -1480,-1000 1280x800 |
| 1x1 shown window, throttling on (control) | visible | 1280x800 | 99.9 | 99.1 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 5.4 | 7.2 |  |
| 1x1 shown window, throttling on, covered by another window (control) | visible | 1280x800 | 99.9 | 99.1 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 5.2 | 6.8 | cover 0,0 1920x1080 over host 0,0 1x1 |
| invisible shown window, throttling on, covered by another window (control) | visible | 1280x800 | 100.0 | 99.4 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 5.4 | 7.8 | cover -1480,-1000 1920x1080 over host -1480,-1000 1280x800 |
| osr window 30 fps, throttling off | visible | 1280x800 | 100.2 | 99.2 | 30.0 | 34 | 2.0 / 2.0 | – | – | – | 4.0 | 13.2 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 100.0 | 99.2 | 30.0 | 35 | 0.0 / 2.0 | – | – | – | 2.4 | 2.8 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 100.1 | 99.3 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 26.0 | – | 2.6 | 3.0 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 26.0 | – | 2.6 | 3.6 |  |
| detached, throttling off, playing media | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | 0.84 | 25.8 | – | 2.4 | 3.4 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 99.9 | 99.3 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | to 1280×800 + JPEG ms | CPU ms/picture | frames/s | visibility events | geometry; errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 17 / 18 | -8 / -5 | 1000x700 | 15 / 15 | 85 | – |  | view 0,0 1000x700 in content 40,65 1000x700; page 1000x700 at 1x |
| shown | true | capturePage | 6/6 | 6 | 17 / 18 | -8 / -5 | 1000x700 | 14 / 15 | 83 | – |  | view 0,0 1000x700 in content 40,65 1000x700; page 1000x700 at 1x |
| shown | true | cdpJpeg | 6/6 | 6 | 65 / 68 | -46 / -39 | 1000x700 | – | 87 | – |  | view 0,0 1000x700 in content 40,65 1000x700; page 1000x700 at 1x |
| shown | true | frameSub | 6/6 | 6 | 15 / 20 | -3 / -3 | 1000x700 | – | 55 | – |  | view 0,0 1000x700 in content 40,65 1000x700; page 1000x700 at 1x |
| shown | true | cdpPng | 6/6 | 6 | 158 / 170 | -45 / -34 | 1000x700 | – | 222 | – |  | view 0,0 1000x700 in content 40,65 1000x700; page 1000x700 at 1x |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 3 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 65 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | – | 50 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | – | 3 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 4047 / 4049 | -2994 / -50 | 1280x800 | – | 140 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x |
| hiddenWindow | false | frameSub | 6/6 | 6 | 7 / 8 | 62 / 75 | 1280x800 | – | 43 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.5 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 97 / 99 | -61 / -32 | 1280x800 | – | 150 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 15 / 17 | 9 / 10 | 1280x800 | – | 87 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 6/6 | 6 | 13 / 17 | 10 / 12 | 1280x800 | – | 75 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | capturePage | 6/6 | 6 | 13 / 16 | 11 / 13 | 1280x800 | – | 75 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 81 / 88 | -45 / -39 | 1280x800 | – | 120 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | frameSub | 6/6 | 6 | 14 / 20 | 12 / 14 | 1280x800 | – | 72 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 13 / 15 | 10 / 15 | 1280x800 | – | 63 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | capturePage | 6/6 | 6 | 15 / 15 | 9 / 10 | 1280x800 | – | 60 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 81 / 86 | -44 / -38 | 1280x800 | – | 110 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | frameSub | 6/6 | 6 | 15 / 19 | 11 / 12 | 1280x800 | – | 60 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 15 / 24 | 9 / 11 | 1280x800 | – | 67 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 14 / 15 | 9 / 11 | 1280x800 | – | 58 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 81 / 82 | -44 / -39 | 1280x800 | – | 112 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 15 / 19 | 11 / 12 | 1280x800 | – | 58 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePageHidden | 6/6 | 6 | 15 / 24 | 10 / 11 | 1280x800 | – | 63 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | capturePage | 6/6 | 6 | 14 / 15 | 10 / 13 | 1280x800 | – | 62 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | cdpJpeg | 6/6 | 6 | 81 / 83 | -44 / -39 | 1280x800 | – | 108 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | frameSub | 6/6 | 6 | 15 / 19 | 12 / 13 | 1280x800 | – | 62 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 41 / 67 | 1280x800 | – | 35 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | capturePage | 6/6 | 6 | 31 / 32 | 10 / 11 | 1280x800 | – | 62 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | cdpJpeg | 6/6 | 6 | 131 / 143 | -79 / -77 | 1280x800 | – | 103 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | – | 183 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 160 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 239 | pss | 499 | 4 | 0.0 |
| 1 | 267 | pss | 615 | 5 | 0.0 |
| 2 | 284 | pss | 735 | 6 | 0.0 |
| 4 | 314 | pss | 973 | 8 | 0.5 |
| 8 | 371 | pss | 1448 | 12 | 0.8 |

Per idle tab resting in the never-shown window (a still page): **16 MiB**, 0.09% CPU. Four tabs: one partition +67 MiB, four partitions +75 MiB.

Quiet tabs working in one shared 1×1 host (no rAF loop; the page repaints twice a second): **29 MiB** and 0.87% CPU a tab (0: 265 MiB / 0.5%, 1: 307 MiB / 1.3%, 4: 389 MiB / 4.0%, 8: 495 MiB / 7.5%).

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 37.7 | 29.5 | 7.8 | 60 |
| animated, never-shown window, throttling off | 1.8 | 1.3 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.0 | 0.0 | 0.0 | 0 |
| animated, never-shown window, throttling off + frame pump | 1.5 | 1.3 | 0.0 | 0 |
| animated, invisible shown window | 49.8 | 39.0 | 10.5 | 60 |
| animated, 1x1 shown window | 40.5 | 38.7 | 1.8 | 60 |
| animated, osr 30 fps | 33.2 | 20.5 | 5.5 | 30 |

**Waking a resting tab into the host** (never-shown window, throttling on, 4 cycles): first rAF 1 / 2 ms, fresh picture 26 / 30 ms; resting rates 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0; awake rAF 60, 60, 60, 60

**One host, 4 tabs (each held at 1280×800, 1×):** tab 1 rAF 60 Hz, capturePage 4/4 in 15 / 18 ms (1280x800); tab 2 rAF 60 Hz, capturePage 4/4 in 13 / 17 ms (1280x800); tab 3 rAF 60 Hz, capturePage 4/4 in 14 / 17 ms (1280x800); tab 4 rAF 60 Hz, capturePage 4/4 in 15 / 15 ms (1280x800)

**The host's invariants:** host 100,100 1x1, focused at start false, after its page grabs focus false (focused window "S7 browser view"); Windows styles –; click-through not testable here (macOS needs Accessibility for synthetic clicks; Wayland and no display have no global input)

**Assertions:** PASS no reload when moving from detached; PASS no reload when moving from hiddenWindow; PASS no reload when moving from hiddenWindowFit; PASS no reload when moving from invisibleWindow; PASS no reload when moving from tinyWindow; PASS the host (1x1; 32x32 on Windows) draws (rAF above 10 Hz); PASS a never-shown window draws nothing (rAF below 1 Hz); PASS capturePage works in the host; PASS capturePage works in the host with the agent's 1280x800 at 1x held; PASS the host never takes focus, even when its page asks; PASS a resting tab draws within 2 s of moving into the host, every cycle; PASS every tab in one shared host draws and is pictured

### Electron · linux-wayland (electron-linux-wayland.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone wayland, displays 1920x1080@1, status **done**, 847 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.92 | 28.1 | 48 / 324 | 1 / 291 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.93 | 27.4 | 39 / 53 | 1 / 2 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.1 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.93 | 27.9 | 41 / 43 | 1 / 2 | 1280x800@1 → 1000x700@1 → 1280x800 | 1 / 1 | 0.0 |  |
| tinyWindow | true | true | true | true (1) | 0.96 | 28.6 | 37 / 48 | 3 / 19 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 41.0 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | IO / RO Hz | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 100.0 | 99.2 | 39.8 | 26 | 2.2 / 2.2 | – | – | – | 4.0 | 7.8 |  |
| detached, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.2 |  |
| detached, throttling off | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 1.0 | 1.2 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 2.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.6 |  |
| never-shown window, throttling off | visible | 1280x800 | 100.1 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 1.2 | 1.8 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 100.2 | 99.2 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 1.0 | 1.2 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 100.2 | 99.2 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 1.2 | 1.6 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 100.0 | 99.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 1.2 | 1.6 |  |
| invisible shown window, throttling off | – | – | – | – | – | – | – | – | – | – | – | – | not possible here |
| 1x1 shown window, throttling off | visible | 1280x800 | 100.2 | 99.2 | 39.8 | 26 | 2.0 / 2.0 | – | – | – | 4.0 | 7.0 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 100.0 | 99.2 | 39.8 | 26 | 1.8 / 1.8 | – | – | – | 3.8 | 6.2 | cover -10,-10 1940x1100 over host 0,0 1x1 |
| 1x1 shown window kept above a cover window (always on top) | visible | 1280x800 | 100.1 | 99.1 | 39.8 | 26 | 2.0 / 2.0 | – | – | – | 3.8 | 6.2 | cover -10,-10 1940x1100 over host 0,0 1x1 |
| invisible shown window, covered by another window | – | – | – | – | – | – | – | – | – | – | – | – | not possible here |
| 1x1 shown window, throttling on (control) | visible | 1280x800 | 100.1 | 99.1 | 39.8 | 26 | 2.0 / 2.0 | – | – | – | 3.8 | 6.2 |  |
| 1x1 shown window, throttling on, covered by another window (control) | visible | 1280x800 | 100.0 | 99.2 | 39.8 | 26 | 2.0 / 2.0 | – | – | – | 3.4 | 5.8 | cover -10,-10 1940x1100 over host 0,0 1x1 |
| invisible shown window, throttling on, covered by another window (control) | – | – | – | – | – | – | – | – | – | – | – | – | not possible here |
| osr window 30 fps, throttling off | visible | 1280x800 | 100.0 | 99.2 | 30.0 | 34 | 2.0 / 2.0 | – | – | – | 3.2 | 13.6 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 100.1 | 99.1 | 30.0 | 34 | 0.0 / 2.0 | – | – | – | 2.2 | 2.6 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 26.0 | – | 2.4 | 3.4 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 25.8 | – | 2.4 | 3.6 |  |
| detached, throttling off, playing media | visible | 1280x800 | 100.1 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 25.8 | – | 2.2 | 2.8 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | to 1280×800 + JPEG ms | CPU ms/picture | frames/s | visibility events | geometry; errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 11 / 26 | 47 / 50 | 1000x700 | 16 / 18 | 65 | – |  | view 0,0 1000x700 in content 40,104 1000x700; page 1000x700 at 1x |
| shown | true | capturePage | 6/6 | 6 | 10 / 12 | 47 / 50 | 1000x700 | 15 / 17 | 58 | – |  | view 0,0 1000x700 in content 40,104 1000x700; page 1000x700 at 1x |
| shown | true | cdpJpeg | 6/6 | 6 | 129 / 133 | -60 / -54 | 1000x700 | – | 75 | – |  | view 0,0 1000x700 in content 40,104 1000x700; page 1000x700 at 1x |
| shown | true | frameSub | 6/6 | 6 | 27 / 28 | 34 / 46 | 1000x700 | – | 37 | – |  | view 0,0 1000x700 in content 40,104 1000x700; page 1000x700 at 1x |
| shown | true | cdpPng | 6/6 | 6 | 267 / 282 | -67 / -64 | 1000x700 | – | 217 | – |  | view 0,0 1000x700 in content 40,104 1000x700; page 1000x700 at 1x |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 29.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 100 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | – | 65 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 320,185 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | – | 3 | – |  | view 0,0 1280x800 in content 320,185 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 75 | – |  | view 0,0 1280x800 in content 320,185 1280x800; page 1280x800 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| hiddenWindow | false | frameSub | 0/2 | 0 | – | – | - | – | 70 | – |  | view 0,0 1280x800 in content 320,185 1280x800; page 1280x800 at 1x; frame subscription: timed out after 5000 ms |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content 320,185 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 320,185 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 90 | – |  | view 0,0 1280x800 in content 320,185 1280x800; page 1280x800 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| hiddenWindow + pump | false | frameSub | 0/2 | 0 | – | – | - | – | 65 | – |  | view 0,0 1280x800 in content 320,185 1280x800; page 1280x800 at 1x; frame subscription: timed out after 5000 ms |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| invisibleWindow | false | - | 0/0 | 0 | – | – | - | – | – | – |  | not possible here |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 22 / 24 | 36 / 40 | 1280x800 | – | 47 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | capturePage | 6/6 | 6 | 23 / 24 | 36 / 40 | 1280x800 | – | 43 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 148 / 151 | -74 / -61 | 1280x800 | – | 80 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | frameSub | 6/6 | 6 | 23 / 34 | 39 / 41 | 1280x800 | – | 43 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.5 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 22 / 25 | 37 / 45 | 1280x800 | – | 45 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 23 / 24 | 36 / 39 | 1280x800 | – | 40 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 145 / 152 | -74 / -50 | 1280x800 | – | 82 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 23 / 35 | 40 / 41 | 1280x800 | – | 43 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.5 |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePageHidden | 6/6 | 6 | 22 / 24 | 37 / 40 | 1280x800 | – | 40 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | capturePage | 6/6 | 6 | 23 / 25 | 36 / 40 | 1280x800 | – | 43 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | cdpJpeg | 6/6 | 6 | 147 / 153 | -75 / -61 | 1280x800 | – | 80 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | frameSub | 6/6 | 6 | 23 / 34 | 40 / 41 | 1280x800 | – | 45 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.5 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 27 / 34 | 1280x800 | – | 28 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | capturePage | 6/6 | 6 | 31 / 40 | -17 / -16 | 1280x800 | – | 57 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | cdpJpeg | 6/6 | 6 | 97 / 109 | -70 / -68 | 1280x800 | – | 83 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | – | 162 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 140 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 330 | pss | 593 | 4 | 0.3 |
| 1 | 357 | pss | 697 | 5 | 0.5 |
| 2 | 373 | pss | 805 | 6 | 0.3 |
| 4 | 402 | pss | 1020 | 8 | 0.8 |
| 8 | 456 | pss | 1450 | 12 | 0.3 |

Per idle tab resting in the never-shown window (a still page): **16 MiB**, 0.00% CPU. Four tabs: one partition +66 MiB, four partitions +71 MiB.

Quiet tabs working in one shared 1×1 host (no rAF loop; the page repaints twice a second): **28 MiB** and 1.09% CPU a tab (0: 354 MiB / 0.5%, 1: 395 MiB / 1.5%, 4: 474 MiB / 4.5%, 8: 578 MiB / 9.2%).

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 19.5 | 12.8 | 5.8 | 39 |
| animated, never-shown window, throttling off | 1.3 | 1.0 | 0.3 | 0 |
| animated, never-shown window, throttling on | 0.0 | 0.0 | 0.0 | 0 |
| animated, never-shown window, throttling off + frame pump | 1.8 | 1.3 | 0.3 | 0 |
| animated, 1x1 shown window | 17.7 | 15.0 | 1.8 | 40 |
| animated, osr 30 fps | 25.2 | 12.2 | 4.3 | 30 |

**Waking a resting tab into the host** (never-shown window, throttling on, 4 cycles): first rAF 1 / 1 ms, fresh picture 28 / 38 ms; resting rates 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0; awake rAF 40, 40, 40, 41

**One host, 4 tabs (each held at 1280×800, 1×):** tab 1 rAF 40 Hz, capturePage 4/4 in 21 / 24 ms (1280x800); tab 2 rAF 40 Hz, capturePage 4/4 in 21 / 25 ms (1280x800); tab 3 rAF 40 Hz, capturePage 4/4 in 22 / 24 ms (1280x800); tab 4 rAF 40 Hz, capturePage 4/4 in 20 / 25 ms (1280x800)

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
| screencast | anim | tinyWindow | 39.8 | 39.8 | 72 / 74 | 27 | 43989 | 137811 | 102 | 26 | 40 |  |
| webcodecs-h264 | anim | tinyWindow | 30.1 | 30.1 | 67 / 71 | 52 | 2365 | 9822 | 82 | 18 | 40 |  |
| screencast | anim | shown | 38.5 | 38.5 | 70 / 71 | 27 | 35314 | 114657 | 79 | 20 | 38 |  |
| webrtc-vp8 | anim | shown | 20.4 | 20.4 | 87 / 93 | 79 | 2498 | 15304 | 92 | 17 | 38 | libvpx; video/VP8 |
| webcodecs-h264 | anim | shown | 30.0 | 30.0 | 75 / 78 | 54 | 2409 | 10038 | 96 | 18 | 38 |  |

### Electron · linux-x11-dsf2 (electron-linux-x11-dsf2.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone x11, displays 960x540@2, status **done**, 279 s

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | to 1280×800 + JPEG ms | CPU ms/picture | frames/s | visibility events | geometry; errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 43 / 47 | 24 / 32 | 2000x1400 | 29 / 34 | 247 | – |  | view 0,0 1000x700 in content 40,67 960x540; page 1000x700 at 2x |
| shown | true | capturePage | 6/6 | 6 | 48 / 53 | 20 / 24 | 2000x1400 | 36 / 45 | 275 | – |  | view 0,0 1000x700 in content 40,67 960x540; page 1000x700 at 2x |
| shown | true | cdpJpeg | 6/6 | 6 | 155 / 169 | -46 / -38 | 2000x1400 | – | 348 | – |  | view 0,0 1000x700 in content 40,67 960x540; page 1000x700 at 2x |
| shown | true | frameSub | 6/6 | 6 | 60 / 65 | 22 / 31 | 2000x1400 | – | 215 | – |  | view 0,0 1000x700 in content 40,67 960x540; page 1000x700 at 2x |
| shown | true | cdpPng | 6/6 | 6 | 462 / 500 | -49 / -34 | 2000x1400 | – | 1038 | – |  | view 0,0 1000x700 in content 40,67 960x540; page 1000x700 at 2x |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 24.5 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 80 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | – | 85 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 5 | – |  | view 0,0 1280x800 in content 0,27 960x540; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 0,27 960x540; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 1/3 | 1 | 181 / 181 | -44 / -44 | 2560x1600 | – | 197 | – |  | view 0,0 1280x800 in content 0,27 960x540; page 1280x800 at 2x; Page.captureScreenshot: timed out after 5000 ms |
| hiddenWindow | false | frameSub | 6/6 | 6 | 49 / 58 | 60 / 3034 | 2560x1600 | – | 143 | – |  | view 0,0 1280x800 in content 0,27 960x540; page 1280x800 at 2x |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 28.5 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content 0,27 960x540; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | – | 5 | – |  | view 0,0 1280x800 in content 0,27 960x540; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 231 / 252 | -87 / -58 | 2560x1600 | – | 600 | – |  | view 0,0 1280x800 in content 0,27 960x540; page 1280x800 at 2x |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 64 / 77 | 31 / 45 | 2560x1600 | – | 245 | – |  | view 0,0 1280x800 in content 0,27 960x540; page 1280x800 at 2x |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 28.5 |  |  |
| invisibleWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -1480,-1000 960x540; page 1280x800 at 2x; Current display surface not available for capture |
| invisibleWindow | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -1480,-1000 960x540; page 1280x800 at 2x; Current display surface not available for capture |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 179 / 199 | -39 / -24 | 2560x1600 | – | 407 | – |  | view 0,0 1280x800 in content -1480,-1000 960x540; page 1280x800 at 2x |
| invisibleWindow | false | frameSub | 6/6 | 6 | 74 / 79 | 25 / 27 | 2560x1600 | – | 233 | – |  | view 0,0 1280x800 in content -1480,-1000 960x540; page 1280x800 at 2x |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 23.5 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 54 / 63 | 13 / 22 | 2560x1600 | 34 / 40 | 170 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 2x |
| tinyWindow | false | capturePage | 6/6 | 6 | 54 / 57 | 12 / 16 | 2560x1600 | 34 / 40 | 178 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 2x |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 171 / 177 | -40 / -35 | 2560x1600 | – | 207 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 2x |
| tinyWindow | false | frameSub | 6/6 | 6 | 73 / 77 | 24 / 25 | 2560x1600 | – | 172 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 2x |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 23.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 55 / 66 | 26 / 30 | 2560x1600 | 35 / 42 | 185 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 2x |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 55 / 70 | 12 / 14 | 2560x1600 | 35 / 41 | 185 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 2x |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 156 / 165 | -38 / -35 | 2560x1600 | – | 222 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 2x |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 73 / 80 | 8 / 12 | 2560x1600 | – | 173 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 2x |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 22.5 |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePageHidden | 6/6 | 6 | 57 / 64 | 8 / 21 | 2560x1600 | 35 / 42 | 178 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | capturePage | 6/6 | 6 | 58 / 66 | 10 / 16 | 2560x1600 | 33 / 41 | 178 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | cdpJpeg | 6/6 | 6 | 68 / 94 | -46 / -35 | 1280x800 | – | 100 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | frameSub | 6/6 | 6 | 74 / 76 | -6 / 14 | 2560x1600 | – | 162 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 23.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 31 / 36 | 960x540 | – | 27 | – |  | view - in content 0,0 960x540; page 960x540 at 1x |
| osr | false | capturePage | 6/6 | 6 | 17 / 34 | -9 / -7 | 960x540 | 15 / 16 | 45 | – |  | view - in content 0,0 960x540; page 960x540 at 1x |
| osr | false | cdpJpeg | 6/6 | 6 | 98 / 100 | -82 / -73 | 960x540 | – | 53 | – |  | view - in content 0,0 960x540; page 960x540 at 1x |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | – | 217 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | – | 5 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 160 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 288 | pss | 482 | 3 | 0.3 |
| 1 | 319 | pss | 589 | 4 | 0.0 |
| 2 | 336 | pss | 699 | 5 | 0.5 |
| 4 | 365 | pss | 917 | 7 | 0.3 |
| 8 | 421 | pss | 1353 | 11 | 0.0 |

Per idle tab resting in the never-shown window (a still page): **17 MiB**, -0.03% CPU. Four tabs: one partition +69 MiB, four partitions +75 MiB.

Quiet tabs working in one shared 1×1 host (no rAF loop; the page repaints twice a second): **60 MiB** and 1.87% CPU a tab (0: 314 MiB / 0.0%, 1: 388 MiB / 1.8%, 4: 564 MiB / 7.7%, 8: 795 MiB / 15.0%).

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 92.8 | 25.0 | 67.5 | 60 |
| animated, never-shown window, throttling off | 2.0 | 1.5 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.3 | 0.0 | 0.3 | 0 |
| animated, never-shown window, throttling off + frame pump | 1.8 | 1.5 | 0.3 | 0 |
| animated, invisible shown window | 1.5 | 1.3 | 0.0 | 0 |
| animated, 1x1 shown window | 26.7 | 23.7 | 3.0 | 60 |
| animated, osr 30 fps | 18.0 | 9.3 | 3.3 | 30 |

**One host, 4 tabs (each held at 1280×800, 1×):** tab 1 rAF 60 Hz, capturePage 4/4 in 64 / 72 ms (2560x1600); tab 2 rAF 58 Hz, capturePage 4/4 in 62 / 64 ms (2560x1600); tab 3 rAF 57 Hz, capturePage 4/4 in 67 / 73 ms (2560x1600); tab 4 rAF 57 Hz, capturePage 4/4 in 65 / 70 ms (2560x1600)

**Assertions:** PASS capturePage works in the host with the agent's 1280x800 at 1x held; PASS every tab in one shared host draws and is pictured

### Electron · linux-x11 (electron-linux-x11.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone x11, displays 1920x1080@1, status **done**, 876 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.91 | 27.8 | 43 / 54 | 1 / 17 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.96 | 28.4 | 45 / 52 | 14 / 18 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.1 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.96 | 28.5 | 39 / 47 | 10 / 17 | 1280x800@1 → 1000x700@1 → 1280x800 | 0 / 1 | 2.4 |  |
| invisibleWindow | true | true | true | true (1) | 0.96 | 28.4 | 41 / 45 | 12 / 14 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.0 |  |
| tinyWindow | true | true | true | true (1) | 0.96 | 28.7 | 38 / 43 | 11 / 14 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.0 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | IO / RO Hz | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 100.1 | 99.1 | 60.0 | 18 | 2.0 / 2.0 | – | – | – | 6.0 | 8.8 |  |
| detached, throttling on (default) | hidden | 1280x800 | 2.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.2 | 0.6 |  |
| detached, throttling off | visible | 1280x800 | 99.9 | 98.9 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 1.4 | 1.6 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.0 |  |
| never-shown window, throttling off | visible | 1280x800 | 100.1 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 1.6 | 2.0 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 100.1 | 98.9 | 1.0 | 1017 | 0.0 / 0.0 | – | – | – | 1.8 | 2.2 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 100.2 | 99.2 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 1.2 | 1.2 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 1.4 | 1.6 |  |
| invisible shown window, throttling off | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 1.2 | 1.2 |  |
| 1x1 shown window, throttling off | visible | 1280x800 | 100.0 | 99.2 | 60.0 | 21 | 2.0 / 2.0 | – | – | – | 5.6 | 7.8 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 100.0 | 99.2 | 60.0 | 18 | 2.0 / 2.0 | – | – | – | 6.2 | 8.8 | cover 0,0 1919x1079 over host 0,0 1x1 |
| 1x1 shown window kept above a cover window (always on top) | visible | 1280x800 | 100.1 | 99.1 | 60.2 | 18 | 2.0 / 2.2 | – | – | – | 6.0 | 8.6 | cover 0,0 1919x1079 over host 0,0 1x1 |
| invisible shown window, covered by another window | visible | 1280x800 | 100.1 | 98.9 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 1.6 | 1.8 | cover -1480,-1000 1919x1079 over host -1480,-1000 1280x800 |
| 1x1 shown window, throttling on (control) | visible | 1280x800 | 100.0 | 99.2 | 60.0 | 18 | 2.0 / 2.0 | – | – | – | 6.0 | 8.4 |  |
| 1x1 shown window, throttling on, covered by another window (control) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.4 | 0.4 | cover 0,0 1919x1079 over host 0,0 1x1 |
| invisible shown window, throttling on, covered by another window (control) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.0 | cover -1480,-1000 1919x1079 over host -1480,-1000 1280x800 |
| osr window 30 fps, throttling off | visible | 1280x800 | 100.0 | 99.0 | 30.0 | 35 | 2.0 / 2.0 | – | – | – | 4.4 | 15.8 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 100.0 | 99.0 | 30.0 | 34 | 0.0 / 2.0 | – | – | – | 3.0 | 3.4 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 100.0 | 99.0 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 26.0 | – | 3.2 | 4.6 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 26.0 | – | 3.0 | 3.8 |  |
| detached, throttling off, playing media | visible | 1280x800 | 99.9 | 98.9 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 25.8 | – | 3.0 | 4.2 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 100.2 | 99.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | to 1280×800 + JPEG ms | CPU ms/picture | frames/s | visibility events | geometry; errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 14 / 16 | -4 / 0 | 1000x700 | 16 / 18 | 77 | – |  | view 0,0 1000x700 in content 40,67 1000x700; page 1000x700 at 1x |
| shown | true | capturePage | 6/6 | 6 | 15 / 16 | -6 / -3 | 1000x700 | 16 / 19 | 72 | – |  | view 0,0 1000x700 in content 40,67 1000x700; page 1000x700 at 1x |
| shown | true | cdpJpeg | 6/6 | 6 | 64 / 68 | -43 / -37 | 1000x700 | – | 77 | – |  | view 0,0 1000x700 in content 40,67 1000x700; page 1000x700 at 1x |
| shown | true | frameSub | 6/6 | 6 | 15 / 17 | -3 / -1 | 1000x700 | – | 47 | – |  | view 0,0 1000x700 in content 40,67 1000x700; page 1000x700 at 1x |
| shown | true | cdpPng | 6/6 | 6 | 201 / 219 | -40 / -34 | 1000x700 | – | 255 | – |  | view 0,0 1000x700 in content 40,67 1000x700; page 1000x700 at 1x |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 100 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | – | 70 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 3 | – |  | view 0,0 1280x800 in content 320,167 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content 320,167 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 4047 / 4048 | -2990 / -41 | 1280x800 | – | 143 | – |  | view 0,0 1280x800 in content 320,167 1280x800; page 1280x800 at 1x |
| hiddenWindow | false | frameSub | 6/6 | 6 | 9 / 10 | 59 / 80 | 1280x800 | – | 48 | – |  | view 0,0 1280x800 in content 320,167 1280x800; page 1280x800 at 1x |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.5 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 3 | – |  | view 0,0 1280x800 in content 320,167 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 320,167 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 96 / 99 | -54 / -34 | 1280x800 | – | 142 | – |  | view 0,0 1280x800 in content 320,167 1280x800; page 1280x800 at 1x |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 14 / 15 | 13 / 15 | 1280x800 | – | 85 | – |  | view 0,0 1280x800 in content 320,167 1280x800; page 1280x800 at 1x |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.5 |  |  |
| invisibleWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| invisibleWindow | false | capturePage | 0/6 | 0 | – | – | - | – | 3 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 80 / 94 | -39 / -28 | 1280x800 | – | 118 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | frameSub | 6/6 | 6 | 15 / 31 | 1 / 17 | 1280x800 | – | 73 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 15 / 16 | 12 / 14 | 1280x800 | – | 48 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | capturePage | 6/6 | 6 | 13 / 16 | 13 / 16 | 1280x800 | – | 53 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 78 / 87 | -38 / -35 | 1280x800 | – | 92 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | frameSub | 6/6 | 6 | 15 / 30 | 13 / 16 | 1280x800 | – | 57 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.5 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 14 / 25 | 14 / 15 | 1280x800 | – | 57 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 13 / 16 | 13 / 17 | 1280x800 | – | 52 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 80 / 87 | -39 / -34 | 1280x800 | – | 90 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 15 / 32 | 12 / 16 | 1280x800 | – | 53 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePageHidden | 6/6 | 6 | 13 / 18 | 14 / 15 | 1280x800 | – | 52 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | capturePage | 6/6 | 6 | 14 / 15 | 13 / 15 | 1280x800 | – | 55 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | cdpJpeg | 6/6 | 6 | 78 / 84 | -38 / -35 | 1280x800 | – | 90 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | frameSub | 6/6 | 6 | 15 / 16 | 15 / 16 | 1280x800 | – | 47 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 27 / 37 | 1280x800 | – | 35 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | capturePage | 6/6 | 6 | 30 / 31 | -16 / -10 | 1280x800 | – | 58 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | cdpJpeg | 6/6 | 6 | 99 / 129 | -69 / -68 | 1280x800 | – | 97 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | – | 217 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | – | 3 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 180 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 327 | pss | 588 | 4 | 0.0 |
| 1 | 354 | pss | 693 | 5 | 0.3 |
| 2 | 370 | pss | 801 | 6 | 0.5 |
| 4 | 399 | pss | 1016 | 8 | 0.5 |
| 8 | 455 | pss | 1448 | 12 | 1.0 |

Per idle tab resting in the never-shown window (a still page): **16 MiB**, 0.12% CPU. Four tabs: one partition +66 MiB, four partitions +71 MiB.

Quiet tabs working in one shared 1×1 host (no rAF loop; the page repaints twice a second): **28 MiB** and 1.06% CPU a tab (0: 352 MiB / 0.0%, 1: 392 MiB / 1.5%, 4: 472 MiB / 4.3%, 8: 577 MiB / 8.5%).

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 28.5 | 20.7 | 7.8 | 60 |
| animated, never-shown window, throttling off | 1.3 | 1.0 | 0.3 | 0 |
| animated, never-shown window, throttling on | 0.3 | 0.0 | 0.0 | 0 |
| animated, never-shown window, throttling off + frame pump | 1.5 | 1.5 | 0.0 | 0 |
| animated, invisible shown window | 1.5 | 1.3 | 0.0 | 0 |
| animated, 1x1 shown window | 25.7 | 23.0 | 2.8 | 60 |
| animated, osr 30 fps | 27.0 | 12.8 | 5.0 | 30 |

**Waking a resting tab into the host** (never-shown window, throttling on, 4 cycles): first rAF 1 / 2 ms, fresh picture 26 / 40 ms; resting rates 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0; awake rAF 60, 60, 60, 60

**One host, 4 tabs (each held at 1280×800, 1×):** tab 1 rAF 60 Hz, capturePage 4/4 in 15 / 28 ms (1280x800); tab 2 rAF 60 Hz, capturePage 4/4 in 22 / 28 ms (1280x800); tab 3 rAF 60 Hz, capturePage 4/4 in 16 / 26 ms (1280x800); tab 4 rAF 60 Hz, capturePage 4/4 in 16 / 26 ms (1280x800)

**The host's invariants:** host 100,100 1x1, focused at start false, after its page grabs focus false (focused window "S7 probe"); Windows styles –; click-through {"at":"100,100","tool":"xdotool","belowClicks":0,"hostClicks":1}; X11 {"id":"0x200156","size":"1x1","mapState":"IsViewable","overrideRedirect":"yes","shape":"No window shape defined; No border shape defined"}

**X11, the host with an empty window shape:** {"id":"0x200164","size":"1x1","mapState":"IsViewable","overrideRedirect":"yes","shape":"Window shape extents:  0x0+0+0; No border shape defined"}; rAF 60 Hz (visible), capturePage 4/4 in 12 / 17 ms (1280x800); click-through {"at":"100,100","tool":"xdotool","belowClicks":1,"hostClicks":0}; with throttling on: 1.0 Hz / rAF 0 (hidden)

**Assertions:** PASS no reload when moving from detached; PASS no reload when moving from hiddenWindow; PASS no reload when moving from hiddenWindowFit; PASS no reload when moving from invisibleWindow; PASS no reload when moving from tinyWindow; PASS the host (1x1; 32x32 on Windows) draws (rAF above 10 Hz); PASS a never-shown window draws nothing (rAF below 1 Hz); PASS capturePage works in the host; PASS capturePage works in the host with the agent's 1280x800 at 1x held; PASS the host never takes focus, even when its page asks; PASS X11: the host with an empty window shape draws and is pictured; PASS X11: a real click at the shaped host's point reaches the window below; PASS a resting tab draws within 2 s of moving into the host, every cycle; PASS every tab in one shared host draws and is pictured

**Q6 streamed view** (10 s at the viewer; latency p50 / p95 ms)

| road | content | source | fps | decoded fps | latency | gap p95 | kbit/s | bytes/frame | sender CPU % | viewer CPU % | source rAF | notes |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| screencast | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | 0 |  |
| capturePoll | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | anim | hiddenWindow | 20.9 | 20.9 | 43 / 50 | 78 | 2510 | 15011 | 71 | 16 | 60 | libvpx; video/VP8 |
| webrtc-h264 | anim | hiddenWindow | 12.7 | 12.7 | 76 / 87 | 110 | 2510 | 24707 | 68 | 10 | 60 | OpenH264; video/H264 |
| webcodecs-vp8 | anim | hiddenWindow | 30.0 | 30.0 | 34 / 37 | 36 | 2422 | 10091 | 97 | 20 | 60 |  |
| webcodecs-h264 | anim | hiddenWindow | 30.0 | 30.0 | 33 / 35 | 35 | 2402 | 10007 | 79 | 19 | 60 |  |
| screencast | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | 0 |  |
| capturePoll | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | static | hiddenWindow | 2.0 | 2.0 | 76 / 87 | 513 | 824 | 51500 | 8 | 3 | 60 | libvpx; video/VP8 |
| webrtc-h264 | static | hiddenWindow | 1.0 | 1.0 | 28 / 32 | 1005 | 17 | 2170 | 7 | 1 | 60 | OpenH264; video/H264 |
| webcodecs-vp8 | static | hiddenWindow | 2.0 | 2.0 | 21 / 24 | 505 | 127 | 7916 | 7 | 1 | 60 |  |
| webcodecs-h264 | static | hiddenWindow | 2.0 | 2.0 | 30 / 32 | 503 | 71 | 4408 | 6 | 1 | 60 |  |
| screencast | anim | invisibleWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | 0 |  |
| capturePoll | anim | invisibleWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | 0 | toJPEG 0.0 ms |
| webcodecs-h264 | anim | invisibleWindow | 30.0 | 30.0 | 36 / 38 | 36 | 2398 | 9990 | 110 | 20 | 60 |  |
| screencast | anim | tinyWindow | 60.1 | 60.1 | 43 / 46 | 19 | 66170 | 137854 | 171 | 44 | 60 |  |
| webcodecs-h264 | anim | tinyWindow | 30.0 | 30.0 | 35 / 37 | 36 | 2407 | 10028 | 97 | 19 | 60 |  |
| screencast | anim | shown | 60.1 | 60.1 | 36 / 37 | 18 | 55056 | 114700 | 122 | 34 | 60 |  |
| webrtc-vp8 | anim | shown | 20.2 | 20.2 | 52 / 61 | 80 | 2484 | 15373 | 108 | 17 | 60 | libvpx; video/VP8 |
| webcodecs-h264 | anim | shown | 30.0 | 30.0 | 41 / 44 | 36 | 2451 | 10211 | 114 | 20 | 60 |  |

### Electron · linux-x64-ozone-headless (electron-linux-x64-ozone-headless.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone headless, displays 1920x1080@1, status **done**, 568 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.93 | 28.4 | 45 / 83 | 0 / 5 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.95 | 28.4 | 30 / 39 | 6 / 8 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.4 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.96 | 28.4 | 27 / 45 | 2 / 7 | 1280x800@1 → 1000x700@1 → 1280x800 | 0 / 1 | 2.4 |  |
| invisibleWindow | true | true | true | true (1) | 0.96 | 28.6 | 29 / 34 | 5 / 10 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.0 |  |
| tinyWindow | true | true | true | true (1) | 0.96 | 28.6 | 26 / 28 | 3 / 4 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.0 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | IO / RO Hz | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 99.9 | 99.3 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 3.6 | 6.0 |  |
| detached, throttling on (default) | hidden | 1280x800 | 2.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.0 |  |
| detached, throttling off | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 1.2 | 1.4 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 2.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.0 |  |
| never-shown window, throttling off | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 1.2 | 1.2 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 100.1 | 99.1 | 1.0 | 1017 | 0.0 / 0.0 | – | – | – | 1.2 | 1.6 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 1.0 | 1.2 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 1.2 | 1.2 |  |
| invisible shown window, throttling off | visible | 1280x800 | 99.9 | 99.3 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 4.0 | 5.6 |  |
| 1x1 shown window, throttling off | visible | 1280x800 | 100.0 | 99.2 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 4.0 | 5.4 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 99.9 | 99.3 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 4.2 | 5.4 | cover 0,0 1920x1080 over host 0,0 1x1 |
| 1x1 shown window kept above a cover window (always on top) | visible | 1280x800 | 100.0 | 99.2 | 60.2 | 17 | 2.2 / 2.2 | – | – | – | 4.2 | 5.4 | cover 0,0 1920x1080 over host 0,0 1x1 |
| invisible shown window, covered by another window | visible | 1280x800 | 100.2 | 99.2 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 3.8 | 5.4 | cover -1480,-1000 1920x1080 over host -1480,-1000 1280x800 |
| 1x1 shown window, throttling on (control) | visible | 1280x800 | 100.1 | 99.1 | 60.0 | 17 | 2.2 / 2.2 | – | – | – | 4.0 | 5.2 |  |
| 1x1 shown window, throttling on, covered by another window (control) | visible | 1280x800 | 100.0 | 99.2 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 3.8 | 5.2 | cover 0,0 1920x1080 over host 0,0 1x1 |
| invisible shown window, throttling on, covered by another window (control) | visible | 1280x800 | 100.0 | 99.4 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 4.0 | 5.6 | cover -1480,-1000 1920x1080 over host -1480,-1000 1280x800 |
| osr window 30 fps, throttling off | visible | 1280x800 | 100.0 | 99.2 | 30.0 | 34 | 2.2 / 2.2 | – | – | – | 2.8 | 12.0 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 100.2 | 99.0 | 30.0 | 34 | 0.0 / 2.2 | – | – | – | 1.8 | 2.4 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 100.0 | 99.4 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 25.8 | – | 1.8 | 2.4 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 100.1 | 99.3 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 25.8 | – | 2.0 | 2.6 |  |
| detached, throttling off, playing media | visible | 1280x800 | 100.2 | 99.2 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 25.8 | – | 1.8 | 2.8 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 100.2 | 99.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | to 1280×800 + JPEG ms | CPU ms/picture | frames/s | visibility events | geometry; errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 17 / 20 | -11 / -8 | 1000x700 | 14 / 16 | 57 | – |  | view 0,0 1000x700 in content 40,65 1000x700; page 1000x700 at 1x |
| shown | true | capturePage | 6/6 | 6 | 18 / 19 | -11 / -9 | 1000x700 | 13 / 16 | 53 | – |  | view 0,0 1000x700 in content 40,65 1000x700; page 1000x700 at 1x |
| shown | true | cdpJpeg | 6/6 | 6 | 64 / 67 | -49 / -43 | 1000x700 | – | 50 | – |  | view 0,0 1000x700 in content 40,65 1000x700; page 1000x700 at 1x |
| shown | true | frameSub | 6/6 | 6 | 15 / 22 | -6 / -5 | 1000x700 | – | 33 | – |  | view 0,0 1000x700 in content 40,65 1000x700; page 1000x700 at 1x |
| shown | true | cdpPng | 6/6 | 6 | 169 / 184 | -42 / -36 | 1000x700 | – | 190 | – |  | view 0,0 1000x700 in content 40,65 1000x700; page 1000x700 at 1x |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 65 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | – | 50 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 3016 / 3032 | -2995 / -32 | 1280x800 | – | 87 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x |
| hiddenWindow | false | frameSub | 6/6 | 6 | 7 / 8 | 52 / 59 | 1280x800 | – | 27 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.5 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 97 / 98 | -61 / -24 | 1280x800 | – | 102 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 15 / 17 | 10 / 10 | 1280x800 | – | 60 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 6/6 | 6 | 14 / 22 | 11 / 12 | 1280x800 | – | 47 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | capturePage | 6/6 | 6 | 14 / 15 | 11 / 13 | 1280x800 | – | 47 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 80 / 83 | -43 / -38 | 1280x800 | – | 68 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | frameSub | 6/6 | 6 | 14 / 21 | 14 / 14 | 1280x800 | – | 42 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 14 / 15 | -5 / -2 | 1280x800 | – | 33 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | capturePage | 6/6 | 6 | 14 / 15 | -5 / -3 | 1280x800 | – | 33 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 64 / 67 | -42 / -37 | 1280x800 | – | 58 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | frameSub | 6/6 | 6 | 15 / 20 | -2 / -1 | 1280x800 | – | 37 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 14 / 22 | 11 / 12 | 1280x800 | – | 33 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 14 / 16 | 10 / 13 | 1280x800 | – | 37 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 81 / 86 | -44 / -38 | 1280x800 | – | 57 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 14 / 21 | 13 / 14 | 1280x800 | – | 37 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePageHidden | 6/6 | 6 | 14 / 15 | -5 / -3 | 1280x800 | – | 32 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | capturePage | 6/6 | 6 | 14 / 15 | -5 / -3 | 1280x800 | – | 33 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | cdpJpeg | 6/6 | 6 | 63 / 69 | -42 / -38 | 1280x800 | – | 55 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | frameSub | 6/6 | 6 | 15 / 19 | -2 / -1 | 1280x800 | – | 35 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.5 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 9 / 34 | 1280x800 | – | 23 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | capturePage | 6/6 | 6 | 31 / 31 | -20 / -17 | 1280x800 | – | 40 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | cdpJpeg | 6/6 | 6 | 98 / 108 | -75 / -74 | 1280x800 | – | 65 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | – | 140 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 115 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 244 | pss | 494 | 4 | 0.0 |
| 1 | 272 | pss | 600 | 5 | 0.0 |
| 2 | 288 | pss | 709 | 6 | 0.0 |
| 4 | 316 | pss | 924 | 8 | 0.3 |
| 8 | 371 | pss | 1357 | 12 | 1.0 |

Per idle tab resting in the never-shown window (a still page): **16 MiB**, 0.12% CPU. Four tabs: one partition +65 MiB, four partitions +70 MiB.

Quiet tabs working in one shared 1×1 host (no rAF loop; the page repaints twice a second): **28 MiB** and 0.78% CPU a tab (0: 269 MiB / 0.0%, 1: 310 MiB / 1.3%, 4: 389 MiB / 2.8%, 8: 493 MiB / 6.3%).

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 16.3 | 11.5 | 4.3 | 60 |
| animated, never-shown window, throttling off | 1.3 | 1.0 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.5 | 0.3 | 0.0 | 0 |
| animated, never-shown window, throttling off + frame pump | 1.0 | 1.0 | 0.0 | 0 |
| animated, invisible shown window | 20.5 | 14.0 | 6.5 | 60 |
| animated, 1x1 shown window | 15.0 | 13.5 | 1.3 | 60 |
| animated, osr 30 fps | 19.5 | 8.5 | 3.8 | 30 |

**Waking a resting tab into the host** (never-shown window, throttling on, 4 cycles): first rAF 0 / 2 ms, fresh picture 17 / 39 ms; resting rates 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0; awake rAF 60, 60, 60, 60

**One host, 4 tabs (each held at 1280×800, 1×):** tab 1 rAF 60 Hz, capturePage 4/4 in 13 / 20 ms (1280x800); tab 2 rAF 60 Hz, capturePage 4/4 in 14 / 16 ms (1280x800); tab 3 rAF 60 Hz, capturePage 4/4 in 13 / 16 ms (1280x800); tab 4 rAF 60 Hz, capturePage 4/4 in 14 / 18 ms (1280x800)

**The host's invariants:** host 100,100 1x1, focused at start false, after its page grabs focus false (focused window "S7 browser view"); Windows styles –; click-through not testable here (macOS needs Accessibility for synthetic clicks; Wayland and no display have no global input)

**Assertions:** PASS no reload when moving from detached; PASS no reload when moving from hiddenWindow; PASS no reload when moving from hiddenWindowFit; PASS no reload when moving from invisibleWindow; PASS no reload when moving from tinyWindow; PASS the host (1x1; 32x32 on Windows) draws (rAF above 10 Hz); PASS a never-shown window draws nothing (rAF below 1 Hz); PASS capturePage works in the host; PASS capturePage works in the host with the agent's 1280x800 at 1x held; PASS the host never takes focus, even when its page asks; PASS a resting tab draws within 2 s of moving into the host, every cycle; PASS every tab in one shared host draws and is pictured

### Electron · macos-dsf2 (electron-macos-dsf2.json)

Electron 45.2.2 (Chromium 156.0.8078.80), darwin-arm64 25.6.0, ozone (default), displays 1024x768@2, status **done**, 278 s

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | to 1280×800 + JPEG ms | CPU ms/picture | frames/s | visibility events | geometry; errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 75 / 147 | 3 / 22 | 2000x1400 | 40 / 53 | 206 | – |  | view 0,0 1000x700 in content 24,63 1000x642; page 1000x700 at 2x |
| shown | true | capturePage | 6/6 | 6 | 52 / 63 | 6 / 14 | 2000x1400 | 37 / 73 | 165 | – |  | view 0,0 1000x700 in content 24,63 1000x642; page 1000x700 at 2x |
| shown | true | cdpJpeg | 6/6 | 6 | 110 / 123 | -42 / -36 | 2000x1400 | – | 133 | – |  | view 0,0 1000x700 in content 24,63 1000x642; page 1000x700 at 2x |
| shown | true | frameSub | 6/6 | 6 | 36 / 63 | 6 / 18 | 2000x1400 | – | 112 | – |  | view 0,0 1000x700 in content 24,63 1000x642; page 1000x700 at 2x |
| shown | true | cdpPng | 6/6 | 6 | 408 / 495 | -43 / -40 | 2000x1400 | – | 550 | – |  | view 0,0 1000x700 in content 24,63 1000x642; page 1000x700 at 2x |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 29.5 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 14 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 2x; Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | – | 12 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 2x; Current display surface not available for capture |
| detached | false | cdpJpeg | 1/3 | 1 | 162 / 162 | -64 / -64 | 2560x1600 | – | 231 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 2x; Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | – | 284 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 2x; frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 15 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | – | 15 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 174 / 197 | -49 / -39 | 2560x1600 | – | 224 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 2x |
| hiddenWindow | false | frameSub | 6/6 | 6 | 59 / 99 | 18 / 24 | 2560x1600 | – | 150 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 2x |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 12 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | – | 10 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 134 / 178 | -49 / -35 | 2560x1600 | – | 292 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 2x |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 38 / 57 | 11 / 17 | 2560x1600 | – | 135 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 2x |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 6/6 | 6 | 49 / 62 | 10 / 13 | 2560x1600 | 31 / 52 | 162 | – |  | view 0,0 1280x800 in content 0,31 1280x800; page 1280x800 at 2x |
| invisibleWindow | false | capturePage | 6/6 | 6 | 32 / 36 | 11 / 18 | 2560x1600 | 23 / 34 | 112 | – |  | view 0,0 1280x800 in content 0,31 1280x800; page 1280x800 at 2x |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 135 / 164 | -50 / -41 | 2560x1600 | – | 152 | – |  | view 0,0 1280x800 in content 0,31 1280x800; page 1280x800 at 2x |
| invisibleWindow | false | frameSub | 6/6 | 6 | 42 / 61 | 2 / 17 | 2560x1600 | – | 90 | – |  | view 0,0 1280x800 in content 0,31 1280x800; page 1280x800 at 2x |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 34 / 71 | 5 / 24 | 2560x1600 | 24 / 38 | 124 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 2x |
| tinyWindow | false | capturePage | 6/6 | 6 | 25 / 32 | 6 / 16 | 2560x1600 | 18 / 27 | 89 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 2x |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 125 / 144 | -50 / -38 | 2560x1600 | – | 135 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 2x |
| tinyWindow | false | frameSub | 6/6 | 6 | 28 / 44 | 2 / 14 | 2560x1600 | – | 73 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 2x |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 24 / 47 | 10 / 19 | 2560x1600 | 21 / 22 | 87 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 2x |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 27 / 35 | 7 / 20 | 2560x1600 | 29 / 36 | 115 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 2x |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 130 / 140 | -43 / -37 | 2560x1600 | – | 156 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 2x |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 34 / 46 | 4 / 16 | 2560x1600 | – | 77 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 2x |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePageHidden | 6/6 | 6 | 36 / 58 | 6 / 16 | 2560x1600 | 33 / 34 | 124 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | capturePage | 6/6 | 6 | 39 / 57 | 5 / 18 | 2560x1600 | 33 / 68 | 146 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | cdpJpeg | 6/6 | 6 | 77 / 409 | -43 / -27 | 1280x800 | – | 125 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | frameSub | 6/6 | 6 | 31 / 49 | -7 / 0 | 2560x1600 | – | 87 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 101 / 188 | 1280x800 | – | 26 | – |  | view - in content 0,-33 1280x800; page 1280x800 at 1x |
| osr | false | capturePage | 6/6 | 6 | 33 / 213 | 20 / 114 | 1280x800 | – | 52 | – |  | view - in content 0,-33 1280x800; page 1280x800 at 1x |
| osr | false | cdpJpeg | 6/6 | 6 | 338 / 419 | -219 / -166 | 1280x800 | – | 110 | – |  | view - in content 0,-33 1280x800; page 1280x800 at 1x |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | – | 14.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | – | 510 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | – | 11 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 457 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 154 | footprint | 333 | 3 | 0.2 |
| 1 | 176 | footprint | 425 | 4 | 0.6 |
| 2 | 195 | footprint | 519 | 5 | 0.9 |
| 4 | 238 | footprint | 705 | 7 | 2.3 |
| 8 | 321 | footprint | 1079 | 11 | 2.9 |

Per idle tab resting in the never-shown window (a still page): **21 MiB**, 0.33% CPU. Four tabs: one partition +79 MiB, four partitions +82 MiB.

Quiet tabs working in one shared 1×1 host (no rAF loop; the page repaints twice a second): **67 MiB** and 2.58% CPU a tab (0: 179 MiB / 0.1%, 1: 270 MiB / 4.2%, 4: 466 MiB / 10.3%, 8: 712 MiB / 20.8%).

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 30.4 | 10.6 | 19.2 | 60 |
| animated, never-shown window, throttling off | 13.7 | 4.6 | 8.3 | 0 |
| animated, never-shown window, throttling on | 1.5 | 0.1 | 0.7 | 0 |
| animated, never-shown window, throttling off + frame pump | 10.1 | 3.8 | 6.0 | 0 |
| animated, invisible shown window | 35.9 | 11.9 | 23.8 | 60 |
| animated, 1x1 shown window | 35.4 | 11.6 | 23.0 | 60 |
| animated, osr 30 fps | 29.4 | 5.1 | 12.2 | 17 |

**One host, 4 tabs (each held at 1280×800, 1×):** tab 1 rAF 60 Hz, capturePage 4/4 in 38 / 65 ms (2560x1600); tab 2 rAF 60 Hz, capturePage 4/4 in 29 / 35 ms (2560x1600); tab 3 rAF 60 Hz, capturePage 4/4 in 28 / 38 ms (2560x1600); tab 4 rAF 60 Hz, capturePage 4/4 in 22 / 26 ms (2560x1600)

**Assertions:** PASS capturePage works in the host with the agent's 1280x800 at 1x held; PASS every tab in one shared host draws and is pictured

### Electron · macos (electron-macos.json)

Electron 45.2.2 (Chromium 156.0.8078.80), darwin-arm64 25.6.0, ozone (default), displays 1024x768@1, status **done**, 890 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.92 | 27.3 | 111 / 3682 | 29 / 1950 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.3 |  |
| hiddenWindow | true | true | true | true (1) | 0.97 | 29.1 | 110 / 175 | 20 / 45 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.1 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.95 | 28.6 | 134 / 190 | 20 / 34 | 1280x800@1 → 1000x700@1 → 1280x800 | 2 / 8 | 1.8 |  |
| invisibleWindow | true | true | true | true (1) | 0.97 | 28.9 | 53 / 400 | 7 / 47 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 57.5 |  |
| tinyWindow | true | true | true | true (1) | 0.98 | 28.9 | 71 / 134 | 9 / 11 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 59.3 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | IO / RO Hz | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 80.5 | 61.1 | 59.9 | 32 | 2.0 / 2.0 | – | – | – | 8.6 | 25.9 |  |
| detached, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.2 | 1.0 |  |
| detached, throttling off | visible | 1280x800 | 99.7 | 81.8 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 4.2 | 10.6 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 1.6 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.2 | 0.9 |  |
| never-shown window, throttling off | visible | 1280x800 | 94.2 | 74.6 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 4.3 | 11.2 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 54.7 | 40.3 | 47.3 | 356 | 2.0 / 2.0 | – | – | – | 6.4 | 18.1 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 75.8 | 57.3 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 3.8 | 9.7 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 97.8 | 78.3 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 3.9 | 10.3 |  |
| invisible shown window, throttling off | visible | 1280x800 | 77.3 | 57.9 | 58.7 | 79 | 2.0 / 2.0 | – | – | – | 9.1 | 25.1 |  |
| 1x1 shown window, throttling off | visible | 1280x800 | 73.4 | 60.0 | 60.0 | 24 | 2.2 / 2.2 | – | – | – | 9.0 | 25.4 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 78.5 | 60.1 | 59.9 | 24 | 2.0 / 2.0 | – | – | – | 8.7 | 24.4 | cover 0,0 1024x768 over host 0,31 1x1 |
| 1x1 shown window kept above a cover window (always on top) | visible | 1280x800 | 71.5 | 60.7 | 59.9 | 25 | 2.0 / 2.0 | – | – | – | 8.9 | 25.0 | cover 0,0 1024x768 over host 0,31 1x1 |
| invisible shown window, covered by another window | visible | 1280x800 | 65.5 | 59.3 | 59.9 | 44 | 2.0 / 2.0 | – | – | – | 7.3 | 20.6 | cover 0,0 1280x831 over host 0,31 1280x800 |
| 1x1 shown window, throttling on (control) | visible | 1280x800 | 69.9 | 56.7 | 57.1 | 113 | 2.0 / 2.0 | – | – | – | 8.0 | 22.5 |  |
| 1x1 shown window, throttling on, covered by another window (control) | hidden | 1280x800 | 1.4 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.3 | 1.2 | cover 0,0 1024x768 over host 0,31 1x1 |
| invisible shown window, throttling on, covered by another window (control) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.3 | 1.1 | cover 0,0 1280x831 over host 0,31 1280x800 |
| osr window 30 fps, throttling off | visible | 1280x800 | 45.9 | 39.9 | 15.3 | 184 | 2.0 / 1.8 | – | – | – | 3.7 | 19.0 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 45.0 | 36.6 | 13.8 | 176 | 0.0 / 2.0 | – | – | – | 3.0 | 9.0 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 36.0 | 29.4 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 26.0 | – | 4.8 | 10.0 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 38.1 | 31.0 | 0.0 | 0 | 0.0 / 0.0 | 0.88 | 26.0 | – | 4.9 | 10.4 |  |
| detached, throttling off, playing media | visible | 1280x800 | 37.8 | 29.8 | 0.0 | 0 | 0.0 / 0.0 | 0.87 | 28.2 | – | 4.8 | 9.8 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 99.9 | 71.9 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 1.6 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | to 1280×800 + JPEG ms | CPU ms/picture | frames/s | visibility events | geometry; errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 23 / 34 | 4 / 18 | 1000x700 | 20 / 29 | 85 | – |  | view 0,0 1000x700 in content 24,63 1000x645; page 1000x700 at 1x |
| shown | true | capturePage | 6/6 | 6 | 22 / 30 | 7 / 13 | 1000x700 | 24 / 30 | 91 | – |  | view 0,0 1000x700 in content 24,63 1000x645; page 1000x700 at 1x |
| shown | true | cdpJpeg | 6/6 | 6 | 95 / 118 | -45 / -37 | 1000x700 | – | 105 | – |  | view 0,0 1000x700 in content 24,63 1000x645; page 1000x700 at 1x |
| shown | true | frameSub | 6/6 | 6 | 26 / 72 | 3 / 12 | 1000x700 | – | 69 | – |  | view 0,0 1000x700 in content 24,63 1000x645; page 1000x700 at 1x |
| shown | true | cdpPng | 6/6 | 6 | 252 / 278 | -44 / -36 | 1000x700 | – | 281 | – |  | view 0,0 1000x700 in content 24,63 1000x645; page 1000x700 at 1x |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 15 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | – | 13 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | cdpJpeg | 1/3 | 1 | 162 / 162 | -81 / -81 | 1280x800 | – | 258 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | – | 218 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 12 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | – | 14 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 118 / 153 | -46 / -41 | 1280x800 | – | 129 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 1x |
| hiddenWindow | false | frameSub | 6/6 | 6 | 31 / 52 | 23 / 33 | 1280x800 | – | 61 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 1x |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 12 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | – | 14 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 111 / 182 | -60 / -38 | 1280x800 | – | 186 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 1x |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 23 / 30 | 12 / 27 | 1280x800 | – | 70 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 1x |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 6/6 | 6 | 17 / 23 | 11 / 16 | 1280x800 | – | 46 | – |  | view 0,0 1280x800 in content 0,31 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | capturePage | 6/6 | 6 | 30 / 43 | 4 / 6 | 1280x800 | – | 58 | – |  | view 0,0 1280x800 in content 0,31 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 98 / 112 | -50 / -35 | 1280x800 | – | 113 | – |  | view 0,0 1280x800 in content 0,31 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | frameSub | 6/6 | 6 | 28 / 41 | 7 / 11 | 1280x800 | – | 63 | – |  | view 0,0 1280x800 in content 0,31 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 26 / 30 | 8 / 12 | 1280x800 | – | 76 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow | false | capturePage | 6/6 | 6 | 22 / 28 | 10 / 19 | 1280x800 | – | 74 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 96 / 106 | -45 / -41 | 1280x800 | – | 112 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow | false | frameSub | 6/6 | 6 | 23 / 28 | 11 / 16 | 1280x800 | – | 64 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 25 / 49 | 7 / 11 | 1280x800 | – | 71 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 26 / 32 | 8 / 11 | 1280x800 | – | 65 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 89 / 102 | -42 / -36 | 1280x800 | – | 90 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 30 / 38 | 3 / 12 | 1280x800 | – | 65 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePageHidden | 6/6 | 6 | 19 / 23 | 9 / 14 | 1280x800 | – | 53 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | capturePage | 6/6 | 6 | 21 / 30 | 6 / 16 | 1280x800 | – | 48 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | cdpJpeg | 6/6 | 6 | 96 / 103 | -49 / -36 | 1280x800 | – | 86 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | frameSub | 6/6 | 6 | 27 / 36 | 2 / 22 | 1280x800 | – | 67 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 1 | 72 / 270 | 1280x800 | – | 34 | – |  | view - in content 0,-33 1280x800; page 1280x800 at 1x |
| osr | false | capturePage | 6/6 | 6 | 50 / 147 | 60 / 119 | 1280x800 | – | 36 | – |  | view - in content 0,-33 1280x800; page 1280x800 at 1x |
| osr | false | cdpJpeg | 6/6 | 6 | 250 / 322 | -147 / -55 | 1280x800 | – | 94 | – |  | view - in content 0,-33 1280x800; page 1280x800 at 1x |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | – | 15.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | – | 473 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | – | 10 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 443 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 160 | footprint | 384 | 4 | 0.3 |
| 1 | 181 | footprint | 475 | 5 | 0.6 |
| 2 | 200 | footprint | 569 | 6 | 1.4 |
| 4 | 242 | footprint | 755 | 8 | 2.4 |
| 8 | 324 | footprint | 1127 | 12 | 3.8 |

Per idle tab resting in the never-shown window (a still page): **20 MiB**, 0.43% CPU. Four tabs: one partition +78 MiB, four partitions +82 MiB.

Quiet tabs working in one shared 1×1 host (no rAF loop; the page repaints twice a second): **35 MiB** and 2.17% CPU a tab (0: 184 MiB / 0.5%, 1: 234 MiB / 3.7%, 4: 334 MiB / 11.2%, 8: 463 MiB / 17.9%).

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 30.8 | 10.2 | 19.8 | 60 |
| animated, never-shown window, throttling off | 13.5 | 4.6 | 8.0 | 0 |
| animated, never-shown window, throttling on | 1.2 | 0.1 | 0.6 | 0 |
| animated, never-shown window, throttling off + frame pump | 14.5 | 4.9 | 9.0 | 0 |
| animated, invisible shown window | 42.8 | 13.7 | 28.6 | 60 |
| animated, 1x1 shown window | 40.7 | 13.5 | 26.8 | 60 |
| animated, osr 30 fps | 26.9 | 5.2 | 12.6 | 14 |

**Waking a resting tab into the host** (never-shown window, throttling on, 4 cycles): first rAF 9 / 36 ms, fresh picture 72 / 104 ms; resting rates 1.1 Hz / rAF 0.0, 1.1 Hz / rAF 0.0, 1.0 Hz / rAF 0.0, 1.1 Hz / rAF 0.0; awake rAF 60, 60, 60, 60

**One host, 4 tabs (each held at 1280×800, 1×):** tab 1 rAF 60 Hz, capturePage 4/4 in 13 / 36 ms (1280x800); tab 2 rAF 60 Hz, capturePage 4/4 in 21 / 25 ms (1280x800); tab 3 rAF 60 Hz, capturePage 4/4 in 10 / 27 ms (1280x800); tab 4 rAF 60 Hz, capturePage 4/4 in 11 / 35 ms (1280x800)

**The host's invariants:** host 100,131 1x1, focused at start false, after its page grabs focus false (focused window "S7 probe"); Windows styles –; click-through not testable here (macOS needs Accessibility for synthetic clicks; Wayland and no display have no global input)

**Assertions:** PASS no reload when moving from detached; PASS no reload when moving from hiddenWindow; PASS no reload when moving from hiddenWindowFit; PASS no reload when moving from invisibleWindow; PASS no reload when moving from tinyWindow; PASS the host (1x1; 32x32 on Windows) draws (rAF above 10 Hz); PASS a never-shown window draws nothing (rAF below 1 Hz); PASS capturePage works in the host; PASS capturePage works in the host with the agent's 1280x800 at 1x held; PASS the host never takes focus, even when its page asks; PASS a resting tab draws within 2 s of moving into the host, every cycle; PASS every tab in one shared host draws and is pictured

**Q6 streamed view** (10 s at the viewer; latency p50 / p95 ms)

| road | content | source | fps | decoded fps | latency | gap p95 | kbit/s | bytes/frame | sender CPU % | viewer CPU % | source rAF | notes |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| screencast | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 14 | 0 | 0 |  |
| capturePoll | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 13 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | anim | hiddenWindow | 23.0 | 23.0 | 161 / 229 | 86 | 2470 | 13424 | 88 | 22 | 60 | libvpx; video/VP8 |
| webrtc-h264 | anim | hiddenWindow | 1.3 | 1.3 | 736 / 989 | 1018 | 490 | 47115 | 60 | 2 | 60 | OpenH264; video/H264 |
| webcodecs-vp8 | anim | hiddenWindow | 29.5 | 29.5 | 54 / 359 | 55 | 2217 | 9426 | 125 | 20 | 59 |  |
| webcodecs-h264 | anim | hiddenWindow | 30.0 | 30.0 | 49 / 81 | 50 | 2239 | 9331 | 118 | 18 | 60 |  |
| screencast | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 |  |
| capturePoll | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | static | hiddenWindow | 2.1 | 2.1 | 196 / 351 | 612 | 99 | 5891 | 12 | 2 | 44 | libvpx; video/VP8 |
| webrtc-h264 | static | hiddenWindow | 1.0 | 1.0 | 70 / 87 | 1049 | 3 | 354 | 13 | 1 | 44 | OpenH264; video/H264 |
| webcodecs-vp8 | static | hiddenWindow | 2.0 | 2.0 | 54 / 73 | 531 | 101 | 6327 | 11 | 1 | 42 |  |
| webcodecs-h264 | static | hiddenWindow | 2.0 | 2.0 | 51 / 71 | 539 | 9 | 584 | 9 | 1 | 43 |  |
| screencast | anim | invisibleWindow | 59.2 | 59.2 | 60 / 80 | 33 | 57638 | 121497 | 120 | 36 | 60 |  |
| capturePoll | anim | invisibleWindow | 24.3 | 24.3 | 64 / 73 | 53 | 23826 | 122057 | 74 | 15 | 60 | toJPEG 7.4 ms |
| webcodecs-h264 | anim | invisibleWindow | 30.0 | 30.0 | 63 / 75 | 48 | 2278 | 9460 | 114 | 16 | 60 |  |
| screencast | anim | tinyWindow | 59.9 | 59.9 | 42 / 56 | 33 | 58243 | 121745 | 115 | 34 | 60 |  |
| webcodecs-h264 | anim | tinyWindow | 30.0 | 30.0 | 47 / 57 | 47 | 2271 | 9431 | 110 | 17 | 60 |  |
| screencast | anim | shown | 59.8 | 59.8 | 43 / 53 | 29 | 48659 | 101883 | 101 | 28 | 60 |  |
| webrtc-vp8 | anim | shown | 26.2 | 26.2 | 75 / 107 | 88 | 2516 | 12002 | 87 | 19 | 60 | libvpx; video/VP8 |
| webcodecs-h264 | anim | shown | 29.9 | 29.9 | 49 / 79 | 47 | 2116 | 8818 | 118 | 18 | 60 |  |

### Electron · windows-dsf2 (electron-windows-dsf2.json)

Electron 45.2.2 (Chromium 156.0.8078.80), win32-x64 10.0.26100, ozone (default), displays 256x192@2, status **done**, 306 s

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | to 1280×800 + JPEG ms | CPU ms/picture | frames/s | visibility events | geometry; errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 36 / 45 | 27 / 29 | 2000x1400 | 25 / 26 | 310 | – |  | view 0,0 1000x700 in content 44,82 504x342; page 1000x700 at 2x |
| shown | true | capturePage | 6/6 | 6 | 37 / 47 | 27 / 30 | 2000x1400 | 25 / 33 | 185 | – |  | view 0,0 1000x700 in content 44,82 504x342; page 1000x700 at 2x |
| shown | true | cdpJpeg | 6/6 | 6 | 146 / 155 | -41 / -33 | 2000x1400 | – | 228 | – |  | view 0,0 1000x700 in content 44,82 504x342; page 1000x700 at 2x |
| shown | true | frameSub | 6/6 | 6 | 49 / 53 | 23 / 29 | 2000x1400 | – | 146 | – |  | view 0,0 1000x700 in content 44,82 504x342; page 1000x700 at 2x |
| shown | true | cdpPng | 6/6 | 6 | 404 / 452 | -42 / -33 | 2000x1400 | – | 653 | – |  | view 0,0 1000x700 in content 44,82 504x342; page 1000x700 at 2x |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.5 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 122 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | – | 144 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 3 | – |  | view 0,0 1280x800 in content 4,42 504x342; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | – | 3 | – |  | view 0,0 1280x800 in content 4,42 504x342; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 3976 / 4994 | -2868 / -40 | 2560x1600 | – | 264 | – |  | view 0,0 1280x800 in content 4,42 504x342; page 1280x800 at 2x |
| hiddenWindow | false | frameSub | 6/6 | 6 | 53 / 56 | 58 / 153 | 2560x1600 | – | 135 | – |  | view 0,0 1280x800 in content 4,42 504x342; page 1280x800 at 2x |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 3 | – |  | view 0,0 1280x800 in content 4,42 504x342; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | – | 3 | – |  | view 0,0 1280x800 in content 4,42 504x342; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 228 / 248 | -80 / -36 | 2560x1600 | – | 625 | – |  | view 0,0 1280x800 in content 4,42 504x342; page 1280x800 at 2x |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 75 / 89 | 12 / 15 | 2560x1600 | – | 277 | – |  | view 0,0 1280x800 in content 4,42 504x342; page 1280x800 at 2x |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 29.0 |  |  |
| invisibleWindow | false | capturePageHidden | 6/6 | 6 | 53 / 62 | 25 / 33 | 2560x1600 | 30 / 42 | 233 | – |  | view 0,0 1280x800 in content 1,0 511x362; page 1280x800 at 2x |
| invisibleWindow | false | capturePage | 6/6 | 6 | 56 / 62 | 9 / 24 | 2560x1600 | 30 / 38 | 235 | – |  | view 0,0 1280x800 in content 1,0 511x362; page 1280x800 at 2x |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 161 / 164 | -41 / -38 | 2560x1600 | – | 277 | – |  | view 0,0 1280x800 in content 1,0 511x362; page 1280x800 at 2x |
| invisibleWindow | false | frameSub | 6/6 | 6 | 66 / 68 | 12 / 14 | 2560x1600 | – | 182 | – |  | view 0,0 1280x800 in content 1,0 511x362; page 1280x800 at 2x |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 23.5 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 54 / 60 | 22 / 44 | 2560x1600 | 29 / 37 | 176 | – |  | view 0,0 1280x800 in content 1,0 31x35; page 1280x800 at 2x |
| tinyWindow | false | capturePage | 6/6 | 6 | 51 / 62 | 20 / 30 | 2560x1600 | 29 / 39 | 175 | – |  | view 0,0 1280x800 in content 1,0 31x35; page 1280x800 at 2x |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 166 / 174 | -41 / -32 | 2560x1600 | – | 204 | – |  | view 0,0 1280x800 in content 1,0 31x35; page 1280x800 at 2x |
| tinyWindow | false | frameSub | 6/6 | 6 | 67 / 77 | 25 / 28 | 2560x1600 | – | 160 | – |  | view 0,0 1280x800 in content 1,0 31x35; page 1280x800 at 2x |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 25.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 50 / 64 | 26 / 37 | 2560x1600 | 30 / 38 | 179 | – |  | view 0,0 1280x800 in content 1,0 31x35; page 1280x800 at 2x |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 57 / 59 | 20 / 32 | 2560x1600 | 29 / 29 | 175 | – |  | view 0,0 1280x800 in content 1,0 31x35; page 1280x800 at 2x |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 172 / 173 | -42 / -32 | 2560x1600 | – | 206 | – |  | view 0,0 1280x800 in content 1,0 31x35; page 1280x800 at 2x |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 65 / 76 | 28 / 30 | 2560x1600 | – | 165 | – |  | view 0,0 1280x800 in content 1,0 31x35; page 1280x800 at 2x |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 24.5 |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePageHidden | 6/6 | 6 | 58 / 62 | 35 / 46 | 2560x1600 | 30 / 39 | 184 | – |  | view 0,0 1280x800 in content 1,0 31x35; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | capturePage | 6/6 | 6 | 53 / 59 | 38 / 46 | 2560x1600 | 29 / 37 | 175 | – |  | view 0,0 1280x800 in content 1,0 31x35; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | cdpJpeg | 6/6 | 6 | 72 / 100 | -41 / -34 | 1280x800 | – | 108 | – |  | view 0,0 1280x800 in content 1,0 31x35; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | frameSub | 6/6 | 6 | 66 / 73 | 1 / 4 | 2560x1600 | – | 155 | – |  | view 0,0 1280x800 in content 1,0 31x35; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 24.0 |  |  |
| osr | false | osrPaint | 6/6 | 0 | 0 / 0 | – | 512x360 | – | 15 | – |  | view - in content 1,0 511x360; page 512x360 at 1x |
| osr | false | capturePage | 6/6 | 0 | 18 / 21 | – | 512x360 | 12 / 15 | 44 | – |  | view - in content 1,0 511x360; page 512x360 at 1x |
| osr | false | cdpJpeg | 6/6 | 0 | 131 / 134 | – | 512x360 | – | 42 | – |  | view - in content 1,0 511x360; page 512x360 at 1x |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | – | 249 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | – | 4 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 193 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 109 | privateBytes | 202 | 3 | 0.1 |
| 1 | 132 | privateBytes | 275 | 4 | 0.2 |
| 2 | 158 | privateBytes | 349 | 5 | 0.3 |
| 4 | 211 | privateBytes | 508 | 7 | 0.6 |
| 8 | 321 | privateBytes | 831 | 11 | 0.8 |

Per idle tab resting in the never-shown window (a still page): **27 MiB**, 0.09% CPU. Four tabs: one partition +96 MiB, four partitions +102 MiB.

Quiet tabs working in one shared 1×1 host (no rAF loop; the page repaints twice a second): **29 MiB** and 2.47% CPU a tab (0: 136 MiB / 0.9%, 1: 162 MiB / 2.4%, 4: 245 MiB / 10.6%, 8: 368 MiB / 20.6%).

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 53.9 | 22.4 | 31.3 | 64 |
| animated, never-shown window, throttling off | 2.9 | 2.2 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.3 | 0.1 | 0.0 | 0 |
| animated, never-shown window, throttling off + frame pump | 2.1 | 1.9 | 0.1 | 0 |
| animated, invisible shown window | 61.5 | 27.4 | 34.0 | 64 |
| animated, 1x1 shown window | 31.7 | 25.6 | 5.9 | 64 |
| animated, osr 30 fps | 15.8 | 8.4 | 3.5 | 30 |

**One host, 4 tabs (each held at 1280×800, 1×):** tab 1 rAF 64 Hz, capturePage 4/4 in 55 / 65 ms (2560x1600); tab 2 rAF 63 Hz, capturePage 4/4 in 56 / 58 ms (2560x1600); tab 3 rAF 62 Hz, capturePage 4/4 in 61 / 65 ms (2560x1600); tab 4 rAF 61 Hz, capturePage 4/4 in 57 / 62 ms (2560x1600)

**Assertions:** PASS capturePage works in the host with the agent's 1280x800 at 1x held; PASS every tab in one shared host draws and is pictured

### Electron · windows (electron-windows.json)

Electron 45.2.2 (Chromium 156.0.8078.80), win32-x64 10.0.26100, ozone (default), displays 1024x768@1, status **done**, 902 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.91 | 26.9 | 48 / 105 | 2 / 59 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.96 | 28.6 | 39 / 48 | 9 / 21 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.3 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.95 | 28.6 | 48 / 53 | 18 / 21 | 1280x800@1 → 1000x700@1 → 1280x800 | 1 / 1 | 2.4 |  |
| invisibleWindow | true | true | true | true (1) | 0.97 | 28.8 | 46 / 47 | 3 / 15 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 64.1 |  |
| tinyWindow | true | true | true | true (1) | 0.97 | 28.8 | 38 / 46 | 6 / 10 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 64.0 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | IO / RO Hz | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 100.0 | 92.2 | 64.0 | 19 | 2.0 / 2.0 | – | – | – | 8.2 | 14.2 |  |
| detached, throttling on (default) | hidden | 1280x800 | 1.2 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.1 | 0.4 |  |
| detached, throttling off | visible | 1280x800 | 99.8 | 94.4 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 2.4 | 2.6 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.1 | 0.2 |  |
| never-shown window, throttling off | visible | 1280x800 | 100.0 | 94.2 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 2.5 | 2.7 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 100.0 | 90.6 | 1.0 | 1001 | 0.0 / 0.0 | – | – | – | 1.8 | 2.2 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 99.9 | 94.7 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 2.3 | 2.5 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 100.0 | 96.2 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 1.9 | 2.1 |  |
| invisible shown window, throttling off | visible | 1280x800 | 100.0 | 93.0 | 64.2 | 19 | 2.0 / 2.0 | – | – | – | 8.0 | 13.9 |  |
| 1x1 shown window, throttling off | visible | 1280x800 | 100.0 | 91.6 | 64.0 | 21 | 2.0 / 2.0 | – | – | – | 7.5 | 12.2 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 100.0 | 92.4 | 64.0 | 19 | 2.0 / 2.0 | – | – | – | 8.3 | 13.2 | cover 0,0 1024x720 over host 0,0 32x32 |
| 1x1 shown window kept above a cover window (always on top) | visible | 1280x800 | 100.0 | 92.6 | 64.0 | 19 | 2.0 / 2.0 | – | – | – | 7.7 | 12.6 | cover 0,0 1024x720 over host 0,0 32x32 |
| invisible shown window, covered by another window | visible | 1280x800 | 100.2 | 92.6 | 64.0 | 20 | 2.0 / 2.0 | – | – | – | 7.9 | 13.9 | cover 0,0 1024x720 over host 0,0 1024x720 |
| 1x1 shown window, throttling on (control) | visible | 1280x800 | 100.0 | 91.8 | 64.0 | 18 | 2.0 / 2.0 | – | – | – | 6.9 | 11.1 |  |
| 1x1 shown window, throttling on, covered by another window (control) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.1 | 0.3 | cover 0,0 1024x720 over host 0,0 32x32 |
| invisible shown window, throttling on, covered by another window (control) | hidden | 1280x800 | 1.8 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.1 | 0.3 | cover 0,0 1024x720 over host 0,0 1024x720 |
| osr window 30 fps, throttling off | visible | 1024x720 | 100.0 | 91.4 | 30.0 | 35 | 2.0 / 2.0 | – | – | – | 4.8 | 13.4 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 100.2 | 90.6 | 30.0 | 35 | 0.0 / 1.8 | – | – | – | 2.8 | 3.4 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 100.0 | 92.4 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 24.8 | – | 3.2 | 4.5 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 100.0 | 91.0 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 24.8 | – | 3.1 | 4.3 |  |
| detached, throttling off, playing media | visible | 1280x800 | 100.0 | 91.0 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 24.8 | – | 3.1 | 4.2 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 100.2 | 96.8 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 1.2 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | to 1280×800 + JPEG ms | CPU ms/picture | frames/s | visibility events | geometry; errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 17 / 19 | 5 / 15 | 1000x700 | 16 / 18 | 91 | – |  | view 0,0 1000x700 in content 48,97 1000x681; page 1000x700 at 1x |
| shown | true | capturePage | 6/6 | 6 | 19 / 20 | 2 / 15 | 1000x700 | 16 / 17 | 91 | – |  | view 0,0 1000x700 in content 48,97 1000x681; page 1000x700 at 1x |
| shown | true | cdpJpeg | 6/6 | 6 | 70 / 84 | -35 / -34 | 1000x700 | – | 93 | – |  | view 0,0 1000x700 in content 48,97 1000x681; page 1000x700 at 1x |
| shown | true | frameSub | 6/6 | 6 | 23 / 24 | 3 / 14 | 1000x700 | – | 66 | – |  | view 0,0 1000x700 in content 48,97 1000x681; page 1000x700 at 1x |
| shown | true | cdpPng | 6/6 | 6 | 222 / 244 | -41 / -35 | 1000x700 | – | 300 | – |  | view 0,0 1000x700 in content 48,97 1000x681; page 1000x700 at 1x |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 118 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | – | 88 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 8,57 1008x681; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 8,57 1008x681; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 3972 / 3977 | -2936 / -38 | 1280x800 | – | 152 | – |  | view 0,0 1280x800 in content 8,57 1008x681; page 1280x800 at 1x |
| hiddenWindow | false | frameSub | 6/6 | 6 | 11 / 13 | 69 / 81 | 1280x800 | – | 44 | – |  | view 0,0 1280x800 in content 8,57 1008x681; page 1280x800 at 1x |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.5 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 3 | – |  | view 0,0 1280x800 in content 8,57 1008x681; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | – | 3 | – |  | view 0,0 1280x800 in content 8,57 1008x681; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 85 / 104 | -60 / -36 | 1280x800 | – | 154 | – |  | view 0,0 1280x800 in content 8,57 1008x681; page 1280x800 at 1x |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 21 / 26 | 3 / 8 | 1280x800 | – | 87 | – |  | view 0,0 1280x800 in content 8,57 1008x681; page 1280x800 at 1x |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 6/6 | 6 | 20 / 21 | 5 / 15 | 1280x800 | – | 76 | – |  | view 0,0 1280x800 in content 0,0 1024x720; page 1280x800 at 1x |
| invisibleWindow | false | capturePage | 6/6 | 6 | 20 / 22 | 4 / 6 | 1280x800 | – | 72 | – |  | view 0,0 1280x800 in content 0,0 1024x720; page 1280x800 at 1x |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 84 / 94 | -44 / -41 | 1280x800 | – | 124 | – |  | view 0,0 1280x800 in content 0,0 1024x720; page 1280x800 at 1x |
| invisibleWindow | false | frameSub | 6/6 | 6 | 21 / 25 | 8 / 9 | 1280x800 | – | 76 | – |  | view 0,0 1280x800 in content 0,0 1024x720; page 1280x800 at 1x |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 21 / 22 | 5 / 7 | 1280x800 | – | 60 | – |  | view 0,0 1280x800 in content 0,0 32x32; page 1280x800 at 1x |
| tinyWindow | false | capturePage | 6/6 | 6 | 20 / 23 | 4 / 7 | 1280x800 | – | 57 | – |  | view 0,0 1280x800 in content 0,0 32x32; page 1280x800 at 1x |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 81 / 92 | -43 / -34 | 1280x800 | – | 94 | – |  | view 0,0 1280x800 in content 0,0 32x32; page 1280x800 at 1x |
| tinyWindow | false | frameSub | 6/6 | 6 | 22 / 24 | 6 / 8 | 1280x800 | – | 53 | – |  | view 0,0 1280x800 in content 0,0 32x32; page 1280x800 at 1x |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 19 / 23 | 6 / 9 | 1280x800 | – | 57 | – |  | view 0,0 1280x800 in content 0,0 32x32; page 1280x800 at 1x |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 21 / 22 | 4 / 5 | 1280x800 | – | 53 | – |  | view 0,0 1280x800 in content 0,0 32x32; page 1280x800 at 1x |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 85 / 87 | -45 / -43 | 1280x800 | – | 94 | – |  | view 0,0 1280x800 in content 0,0 32x32; page 1280x800 at 1x |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 24 / 25 | 6 / 7 | 1280x800 | – | 55 | – |  | view 0,0 1280x800 in content 0,0 32x32; page 1280x800 at 1x |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePageHidden | 6/6 | 6 | 20 / 22 | 6 / 11 | 1280x800 | – | 54 | – |  | view 0,0 1280x800 in content 0,0 32x32; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | capturePage | 6/6 | 6 | 20 / 22 | 4 / 7 | 1280x800 | – | 60 | – |  | view 0,0 1280x800 in content 0,0 32x32; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | cdpJpeg | 6/6 | 6 | 84 / 95 | -44 / -38 | 1280x800 | – | 94 | – |  | view 0,0 1280x800 in content 0,0 32x32; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | frameSub | 6/6 | 6 | 21 / 25 | 7 / 14 | 1280x800 | – | 53 | – |  | view 0,0 1280x800 in content 0,0 32x32; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 10 / 39 | 1024x720 | – | 30 | – |  | view - in content 0,0 1024x720; page 1024x720 at 1x |
| osr | false | capturePage | 6/6 | 6 | 17 / 32 | -6 / -5 | 1024x720 | 14 / 15 | 61 | – |  | view - in content 0,0 1024x720; page 1024x720 at 1x |
| osr | false | cdpJpeg | 6/6 | 6 | 97 / 101 | -77 / -42 | 1024x720 | – | 70 | – |  | view - in content 0,0 1024x720; page 1024x720 at 1x |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | – | 245 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | – | 4 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 173 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 147 | privateBytes | 160 | 4 | 0.1 |
| 1 | 171 | privateBytes | 234 | 5 | 0.3 |
| 2 | 200 | privateBytes | 310 | 6 | 0.3 |
| 4 | 251 | privateBytes | 456 | 8 | 0.4 |
| 8 | 362 | privateBytes | 761 | 12 | 0.7 |

Per idle tab resting in the never-shown window (a still page): **27 MiB**, 0.08% CPU. Four tabs: one partition +101 MiB, four partitions +100 MiB.

Quiet tabs working in one shared 1×1 host (no rAF loop; the page repaints twice a second): **28 MiB** and 1.15% CPU a tab (0: 175 MiB / 0.9%, 1: 200 MiB / 1.5%, 4: 284 MiB / 5.1%, 8: 399 MiB / 10.1%).

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 38.8 | 20.2 | 18.2 | 64 |
| animated, never-shown window, throttling off | 2.4 | 1.8 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.2 | 0.0 | 0.0 | 0 |
| animated, never-shown window, throttling off + frame pump | 2.4 | 2.1 | 0.1 | 0 |
| animated, invisible shown window | 44.5 | 23.8 | 20.5 | 64 |
| animated, 1x1 shown window | 29.0 | 23.9 | 5.0 | 64 |
| animated, osr 30 fps | 25.0 | 10.8 | 7.4 | 30 |

**Waking a resting tab into the host** (never-shown window, throttling on, 4 cycles): first rAF 2 / 4 ms, fresh picture 54 / 55 ms; resting rates 1.2 Hz / rAF 0.0, 1.1 Hz / rAF 0.0, 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0; awake rAF 64, 64, 64, 64

**One host, 4 tabs (each held at 1280×800, 1×):** tab 1 rAF 64 Hz, capturePage 4/4 in 16 / 21 ms (1280x800); tab 2 rAF 64 Hz, capturePage 4/4 in 14 / 21 ms (1280x800); tab 3 rAF 64 Hz, capturePage 4/4 in 16 / 23 ms (1280x800); tab 4 rAF 64 Hz, capturePage 4/4 in 20 / 23 ms (1280x800)

**The host's invariants:** host 100,100 32x32, focused at start false, after its page grabs focus false (focused window "S7 probe"); Windows styles {"style":"0x14c00000","exStyle":"0x82801a0","toolWindow":true,"noActivate":true,"transparent":true,"layered":true,"appWindow":false}; click-through {"at":"116,116","tool":"SendInput via user32 SetCursorPos and mouse_event","belowClicks":1,"hostClicks":0}

**Assertions:** PASS no reload when moving from detached; PASS no reload when moving from hiddenWindow; PASS no reload when moving from hiddenWindowFit; PASS no reload when moving from invisibleWindow; PASS no reload when moving from tinyWindow; PASS the host (1x1; 32x32 on Windows) draws (rAF above 10 Hz); PASS a never-shown window draws nothing (rAF below 1 Hz); PASS capturePage works in the host; PASS capturePage works in the host with the agent's 1280x800 at 1x held; PASS the host never takes focus, even when its page asks; PASS Windows: the host is a no-activate, click-through tool window, not an app window; PASS Windows: a real click at the host's point reaches the window below; PASS a resting tab draws within 2 s of moving into the host, every cycle; PASS every tab in one shared host draws and is pictured

**Q6 streamed view** (10 s at the viewer; latency p50 / p95 ms)

| road | content | source | fps | decoded fps | latency | gap p95 | kbit/s | bytes/frame | sender CPU % | viewer CPU % | source rAF | notes |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| screencast | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 3 | 0 | 0 |  |
| capturePoll | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | anim | hiddenWindow | 25.7 | 25.7 | 42 / 43 | 64 | 2505 | 12182 | 84 | 22 | 64 | libvpx; video/VP8 |
| webrtc-h264 | anim | hiddenWindow | 14.7 | 14.7 | 58 / 60 | 83 | 2486 | 21136 | 80 | 14 | 64 | OpenH264; video/H264 |
| webcodecs-vp8 | anim | hiddenWindow | 30.0 | 30.0 | 37 / 43 | 47 | 2187 | 9113 | 109 | 21 | 64 |  |
| webcodecs-h264 | anim | hiddenWindow | 30.0 | 30.0 | 36 / 39 | 48 | 2163 | 9013 | 102 | 20 | 64 |  |
| screencast | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | 0 |  |
| capturePoll | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | static | hiddenWindow | 2.3 | 2.3 | 89 / 158 | 502 | 569 | 30944 | 10 | 3 | 64 | libvpx; video/VP8 |
| webrtc-h264 | static | hiddenWindow | 1.0 | 1.0 | 35 / 38 | 1002 | 17 | 2161 | 9 | 2 | 64 | OpenH264; video/H264 |
| webcodecs-vp8 | static | hiddenWindow | 2.0 | 2.0 | 36 / 38 | 504 | 113 | 7044 | 8 | 1 | 64 |  |
| webcodecs-h264 | static | hiddenWindow | 2.0 | 2.0 | 33 / 36 | 505 | 102 | 6351 | 7 | 1 | 64 |  |
| screencast | anim | invisibleWindow | 64.1 | 64.1 | 43 / 46 | 18 | 60597 | 118354 | 190 | 48 | 64 |  |
| capturePoll | anim | invisibleWindow | 30.1 | 30.1 | 42 / 49 | 46 | 28577 | 118676 | 117 | 21 | 64 | toJPEG 9.0 ms |
| webcodecs-h264 | anim | invisibleWindow | 30.0 | 30.0 | 40 / 43 | 48 | 2169 | 9036 | 134 | 22 | 64 |  |
| screencast | anim | tinyWindow | 63.8 | 63.8 | 43 / 45 | 19 | 60500 | 118349 | 178 | 47 | 64 |  |
| webcodecs-h264 | anim | tinyWindow | 30.0 | 30.0 | 39 / 43 | 48 | 2158 | 8991 | 117 | 21 | 64 |  |
| screencast | anim | shown | 64.0 | 64.0 | 36 / 40 | 19 | 50861 | 99338 | 143 | 38 | 64 |  |
| webrtc-vp8 | anim | shown | 24.1 | 24.1 | 59 / 61 | 77 | 2494 | 12933 | 138 | 23 | 64 | libvpx; video/VP8 |
| webcodecs-h264 | anim | shown | 30.0 | 30.0 | 49 / 53 | 48 | 2198 | 9158 | 144 | 20 | 64 |  |

### The pair · linux-x64 (pair-linux.json)

7.0.0-1017-azure, 35 s, state **done**

- **login start**: {"daemonUpMs":111,"daemonUp":true,"appConnectedMs":2814,"appStartedBy":"daemon","appStart":{"at":1793858685432,"safeMode":false,"reason":"daemon start","ok":true,"how":"systemctl --user start clover-s7-app-deced5af.service","out":""},"daemonParent":1049}
- **second daemon on the same home**: {"exitCode":0,"ms":30,"said":"2026-11-05T06:04:46.073Z [core 2328] another daemon holds this home (flock: held by another process) and answers on its socket; exiting","firstStillServing":true}
- **app crash**: {"killed":2276,"kill":{"ok":true,"how":"kill -9 2276","code":0,"out":""},"restartedMs":1220,"newPid":2338,"startedBy":"daemon","safeMode":false,"how":"systemctl --user start clover-s7-app-deced5af.service","eventsSinceKill":["start","tray","connected"]}
- **app crash loop → safe mode**: {"rounds":[{"killed":2338,"restartedMs":2225,"safeMode":false,"crashesInDaemon":2},{"killed":2391,"restartedMs":4148,"safeMode":true,"crashesInDaemon":3}],"thirdRestartInSafeMode":true}
- **daemon crash, restarted by the OS alone**: {"killed":2264,"kill":{"ok":true,"how":"kill -9 2264","code":0,"out":""},"daemonBackMs":1408,"newDaemonPid":2492,"appSurvived":true,"appPidAfter":2445,"samePid":true,"appStartedTheDaemon":false,"appEvents":["5ms daemon-lost","1509ms connected","1509ms reconnected"]}
- **daemon crash, the app helps after 3 s**: {"killed":2492,"kill":{"ok":true,"how":"kill -9 2492","code":0,"out":""},"daemonBackMs":1406,"newDaemonPid":2502,"appSurvived":true,"appPidAfter":2445,"samePid":true,"appStartedTheDaemon":false,"appEvents":["2ms daemon-lost","1506ms connected","1506ms reconnected"]}
- **tray Quit stops both, and they stay down**: {"forwarded":{"forwarded":true},"bothDownMs":402,"restartedWithin12s":false,"appEvents":["quit","quit-acked","daemon-quitting"]}
- **a user starts the app → it starts the daemon**: {"start":{"ok":true,"how":"spawn detached (as from a launcher)","code":0,"out":"2524"},"bothUpMs":513,"startedBy":"user","appStartedTheDaemon":[{"ok":true,"how":"systemctl --user start clover-s7-core-deced5af.service","out":""}],"appEvents":["start","tray","start-daemon","connected"]}
- **the daemon side's Quit stops both**: {"bothDownMs":401,"restartedWithin8s":false}

**Assertions:** PASS the login item starts the daemon, and the daemon the app; PASS a second daemon is refused and exits 0; PASS a crashed app is back within 6 s; PASS the start after the third crash in two minutes is in safe mode; PASS a crashed daemon is back within 5 s without the app's help; PASS a crashed daemon is back within 10 s, and the app lives on; PASS the tray's Quit stops both, and nothing restarts them; PASS a user's start of the app brings up both within 10 s; PASS the daemon side's Quit stops both, and nothing restarts them

### The pair · darwin-arm64 (pair-macos.json)

25.6.0, 38 s, state **done**

- **login start**: {"daemonUpMs":124,"daemonUp":true,"appConnectedMs":4313,"appStartedBy":"daemon","appStart":{"at":1793859166882,"safeMode":false,"reason":"daemon start","ok":true,"how":"open -n -g -a /Users/runner/work/clover/clover/spikes/s7-browser/prototype/node_modules/electron/dist/Electron.app --args /Users/runner/work/clover/clover/spikes/s7-browser/prototype/out/pair/app --home=/var/folders/n6/hn37q6pj7sj_9dmqqc2113800000gn/T/clover-s7-pair-q5MuP1","out":""},"daemonParent":1}
- **second daemon on the same home**: {"exitCode":0,"ms":106,"said":"2026-11-05T06:12:48.728Z [core 1426] another daemon holds this home (flock: held by another process) and answers on its socket; exiting","firstStillServing":true}
- **app crash**: {"killed":1415,"kill":{"ok":true,"how":"kill -9 1415","code":0,"out":""},"restartedMs":1741,"newPid":1431,"startedBy":"daemon","safeMode":false,"how":"open -n -g -a /Users/runner/work/clover/clover/spikes/s7-browser/prototype/node_modules/electron/dist/Electron.app --args /Users/runner/work/clover/clover/spikes/s7-browser/prototype/out/pair/app --home=/var/folders/n6/hn37q6pj7sj_9dmqqc2113800000gn/T/clover-s7-pair-q5MuP1","eventsSinceKill":["start","tray","connected"]}
- **app crash loop → safe mode**: {"rounds":[{"killed":1431,"restartedMs":2614,"safeMode":false,"crashesInDaemon":2},{"killed":1440,"restartedMs":4680,"safeMode":true,"crashesInDaemon":3}],"thirdRestartInSafeMode":true}
- **daemon crash, restarted by the OS alone**: {"killed":1361,"kill":{"ok":true,"how":"kill -9 1361","code":0,"out":""},"daemonBackMs":422,"newDaemonPid":1513,"appSurvived":true,"appPidAfter":1509,"samePid":true,"appStartedTheDaemon":false,"appEvents":["5ms daemon-lost","515ms connected","516ms reconnected"]}
- **daemon crash, the app helps after 3 s**: {"killed":1513,"kill":{"ok":true,"how":"kill -9 1513","code":0,"out":""},"daemonBackMs":1210,"newDaemonPid":1516,"appSurvived":true,"appPidAfter":1509,"samePid":true,"appStartedTheDaemon":false,"appEvents":["2ms daemon-lost","1512ms connected","1513ms reconnected"]}
- **tray Quit stops both, and they stay down**: {"forwarded":{"forwarded":true},"bothDownMs":367,"restartedWithin12s":false,"appEvents":["quit","quit-acked"]}
- **a user starts the app → it starts the daemon**: {"start":{"ok":true,"how":"open -n -g -a /Users/runner/work/clover/clover/spikes/s7-browser/prototype/node_modules/electron/dist/Electron.app --args /Users/runner/work/clover/clover/spikes/s7-browser/prototype/out/pair/app --home=/var/folders/n6/hn37q6pj7sj_9dmqqc2113800000gn/T/clover-s7-pair-q5MuP1","code":0,"out":""},"bothUpMs":902,"startedBy":"user","appStartedTheDaemon":[{"ok":true,"how":"launchctl kickstart gui/501/com.waifucave.clover.s7.core.54005726","out":""}],"appEvents":["start","tray","start-daemon","connected"]}
- **the daemon side's Quit stops both**: {"bothDownMs":307,"restartedWithin8s":false}

**Assertions:** PASS the login item starts the daemon, and the daemon the app; PASS a second daemon is refused and exits 0; PASS a crashed app is back within 6 s; PASS the start after the third crash in two minutes is in safe mode; PASS a crashed daemon is back within 5 s without the app's help; PASS a crashed daemon is back within 10 s, and the app lives on; PASS the tray's Quit stops both, and nothing restarts them; PASS a user's start of the app brings up both within 10 s; PASS the daemon side's Quit stops both, and nothing restarts them

### The pair · win32-x64 (pair-windows-spawn.json)

10.0.26100, 187 s, state **done**, Windows app start: spawn

- **login start**: {"daemonUpMs":347,"daemonUp":true,"appConnectedMs":2940,"appStartedBy":"daemon","appStart":{"at":1793858712820,"safeMode":false,"reason":"daemon start","ok":true,"how":"spawn detached","out":"4048"},"daemonParent":2612}
- **second daemon on the same home**: {"exitCode":0,"ms":105,"said":"2026-11-05T06:05:13.153Z [core 7644] another daemon holds this home (CreateFileW: error 32 (sharing violation: another process holds it)) and answers on its socket; exiting","firstStillServing":true}
- **app crash**: {"killed":4048,"kill":{"ok":true,"how":"taskkill /F /T /PID 4048","code":0,"out":"SUCCESS: The process with PID 3408 (child process of PID 4048) has been terminated.\r\nSUCCESS: The process with PID 7776 (child process of PID 4048) has been ter"},"restartedMs":1218,"newPid":808,"startedBy":"daemon","safeMode":false,"how":"spawn detached","eventsSinceKill":["start","tray","connected"]}
- **app crash loop → safe mode**: {"rounds":[{"killed":808,"restartedMs":2161,"safeMode":false,"crashesInDaemon":2},{"killed":8200,"restartedMs":4181,"safeMode":true,"crashesInDaemon":3}],"thirdRestartInSafeMode":true}
- **daemon crash, restarted by the OS alone**: {"killed":8040,"kill":{"ok":true,"how":"taskkill /F /PID 8040","code":0,"out":"SUCCESS: The process with PID 8040 has been terminated."},"appSurvived":true,"appPidAfter":1248,"samePid":true,"appStartedTheDaemon":{"atMs":150314,"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-1e4288d3"},"appEvents":["57ms daemon-lost","150314ms start-daemon","150818ms connected","150819ms reconnected"]}
- **daemon crash, the app helps after 3 s**: {"killed":7288,"kill":{"ok":true,"how":"taskkill /F /PID 7288","code":0,"out":"SUCCESS: The process with PID 7288 has been terminated."},"daemonBackMs":3297,"newDaemonPid":2004,"appSurvived":true,"appPidAfter":1248,"samePid":true,"appStartedTheDaemon":{"atMs":3095,"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-1e4288d3"},"appEvents":["64ms daemon-lost","3095ms start-daemon","3597ms connected","3598ms reconnected"]}
- **tray Quit stops both, and they stay down**: {"forwarded":{"forwarded":true},"bothDownMs":336,"restartedWithin12s":false,"appEvents":["quit","quit-acked"]}
- **a user starts the app → it starts the daemon**: {"start":{"ok":true,"how":"spawn detached","code":0,"out":"8824"},"bothUpMs":525,"startedBy":"user","appStartedTheDaemon":[{"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-1e4288d3","out":"SUCCESS: Attempted to run the scheduled task \"\\Clover S7\\core-1e4288d3\"."}],"appEvents":["start","tray","start-daemon","connected"]}
- **the daemon side's Quit stops both**: {"bothDownMs":330,"restartedWithin8s":false}

**Assertions:** PASS the login item starts the daemon, and the daemon the app; PASS a second daemon is refused and exits 0; PASS a crashed app is back within 6 s; PASS the start after the third crash in two minutes is in safe mode; PASS Task Scheduler alone does not restart a killed task (the finding the supervisor answers); PASS a crashed daemon is back within 10 s, and the app lives on; PASS the tray's Quit stops both, and nothing restarts them; PASS a user's start of the app brings up both within 10 s; PASS the daemon side's Quit stops both, and nothing restarts them

### The pair · win32-x64 (pair-windows-supervise.json)

10.0.26100, 36 s, state **done**, Windows app start: task, daemon under the supervisor

- **login start**: {"daemonUpMs":445,"daemonUp":true,"appConnectedMs":3667,"appStartedBy":"daemon","appStart":{"at":1793858707593,"safeMode":false,"reason":"daemon start","ok":true,"how":"schtasks /Run /TN \\Clover S7\\app-f41f31f8","out":"SUCCESS: Attempted to run the scheduled task \"\\Clover S7\\app-f41f31f8\"."},"daemonParent":8320}
- **second daemon on the same home**: {"exitCode":0,"ms":71,"said":"2026-11-05T06:05:08.790Z [core 6480] another daemon holds this home (CreateFileW: error 32 (sharing violation: another process holds it)) and answers on its socket; exiting","firstStillServing":true}
- **app crash**: {"killed":2756,"kill":{"ok":true,"how":"taskkill /F /T /PID 2756","code":0,"out":"SUCCESS: The process with PID 3540 (child process of PID 2756) has been terminated.\r\nSUCCESS: The process with PID 3660 (child process of PID 2756) has been ter"},"restartedMs":1225,"newPid":8768,"startedBy":"daemon","safeMode":false,"how":"schtasks /Run /TN \\Clover S7\\app-f41f31f8","eventsSinceKill":["start","tray","connected"]}
- **app crash loop → safe mode**: {"rounds":[{"killed":8768,"restartedMs":2181,"safeMode":false,"crashesInDaemon":2},{"killed":1864,"restartedMs":4224,"safeMode":true,"crashesInDaemon":3}],"thirdRestartInSafeMode":true}
- **daemon crash, restarted by the OS alone**: {"killed":8632,"kill":{"ok":true,"how":"taskkill /F /PID 8632","code":0,"out":"SUCCESS: The process with PID 8632 has been terminated."},"daemonBackMs":629,"newDaemonPid":6796,"appSurvived":true,"appPidAfter":3752,"samePid":true,"appStartedTheDaemon":false,"appEvents":["45ms daemon-lost","1059ms connected","1059ms reconnected"]}
- **daemon crash, the app helps after 3 s**: {"killed":6796,"kill":{"ok":true,"how":"taskkill /F /PID 6796","code":0,"out":"SUCCESS: The process with PID 6796 has been terminated."},"daemonBackMs":1238,"newDaemonPid":2820,"appSurvived":true,"appPidAfter":3752,"samePid":true,"appStartedTheDaemon":false,"appEvents":["42ms daemon-lost","1547ms connected","1547ms reconnected"]}
- **tray Quit stops both, and they stay down**: {"forwarded":{"forwarded":true},"bothDownMs":328,"restartedWithin12s":false,"appEvents":["quit-acked"]}
- **a user starts the app → it starts the daemon**: {"start":{"ok":true,"how":"spawn detached","code":0,"out":"8100"},"bothUpMs":448,"startedBy":"user","appStartedTheDaemon":[{"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-f41f31f8","out":"SUCCESS: Attempted to run the scheduled task \"\\Clover S7\\core-f41f31f8\"."}],"appEvents":["start","tray","start-daemon","connected"]}
- **the daemon side's Quit stops both**: {"bothDownMs":322,"restartedWithin8s":false}

**Assertions:** PASS the login item starts the daemon, and the daemon the app; PASS a second daemon is refused and exits 0; PASS a crashed app is back within 6 s; PASS the start after the third crash in two minutes is in safe mode; PASS a crashed daemon is back within 5 s without the app's help; PASS a crashed daemon is back within 10 s, and the app lives on; PASS the tray's Quit stops both, and nothing restarts them; PASS a user's start of the app brings up both within 10 s; PASS the daemon side's Quit stops both, and nothing restarts them

### The pair · win32-x64 (pair-windows-task.json)

10.0.26100, 187 s, state **done**, Windows app start: task

- **login start**: {"daemonUpMs":458,"daemonUp":true,"appConnectedMs":3039,"appStartedBy":"daemon","appStart":{"at":1793858705984,"safeMode":false,"reason":"daemon start","ok":true,"how":"schtasks /Run /TN \\Clover S7\\app-dac576ad","out":"SUCCESS: Attempted to run the scheduled task \"\\Clover S7\\app-dac576ad\"."},"daemonParent":2588}
- **second daemon on the same home**: {"exitCode":0,"ms":91,"said":"2026-11-05T06:05:06.326Z [core 9200] another daemon holds this home (CreateFileW: error 32 (sharing violation: another process holds it)) and answers on its socket; exiting","firstStillServing":true}
- **app crash**: {"killed":4068,"kill":{"ok":true,"how":"taskkill /F /T /PID 4068","code":0,"out":"SUCCESS: The process with PID 8116 (child process of PID 4068) has been terminated.\r\nSUCCESS: The process with PID 7204 (child process of PID 4068) has been ter"},"restartedMs":1260,"newPid":4112,"startedBy":"daemon","safeMode":false,"how":"schtasks /Run /TN \\Clover S7\\app-dac576ad","eventsSinceKill":["start","tray","connected"]}
- **app crash loop → safe mode**: {"rounds":[{"killed":4112,"restartedMs":2224,"safeMode":false,"crashesInDaemon":2},{"killed":7504,"restartedMs":4262,"safeMode":true,"crashesInDaemon":3}],"thirdRestartInSafeMode":true}
- **daemon crash, restarted by the OS alone**: {"killed":1420,"kill":{"ok":true,"how":"taskkill /F /PID 1420","code":0,"out":"SUCCESS: The process with PID 1420 has been terminated."},"appSurvived":true,"appPidAfter":1468,"samePid":true,"appStartedTheDaemon":{"atMs":150371,"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-dac576ad"},"appEvents":["54ms daemon-lost","150371ms start-daemon","150884ms connected","150885ms reconnected"]}
- **daemon crash, the app helps after 3 s**: {"killed":8204,"kill":{"ok":true,"how":"taskkill /F /PID 8204","code":0,"out":"SUCCESS: The process with PID 8204 has been terminated."},"daemonBackMs":3289,"newDaemonPid":8300,"appSurvived":true,"appPidAfter":1468,"samePid":true,"appStartedTheDaemon":{"atMs":3156,"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-dac576ad"},"appEvents":["101ms daemon-lost","3156ms start-daemon","3665ms connected","3666ms reconnected"]}
- **tray Quit stops both, and they stay down**: {"forwarded":{"forwarded":true},"bothDownMs":333,"restartedWithin12s":false,"appEvents":["quit","quit-acked"]}
- **a user starts the app → it starts the daemon**: {"start":{"ok":true,"how":"spawn detached","code":0,"out":"1244"},"bothUpMs":554,"startedBy":"user","appStartedTheDaemon":[{"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-dac576ad","out":"SUCCESS: Attempted to run the scheduled task \"\\Clover S7\\core-dac576ad\"."}],"appEvents":["start","tray","start-daemon","connected"]}
- **the daemon side's Quit stops both**: {"bothDownMs":329,"restartedWithin8s":false}

**Assertions:** PASS the login item starts the daemon, and the daemon the app; PASS a second daemon is refused and exits 0; PASS a crashed app is back within 6 s; PASS the start after the third crash in two minutes is in safe mode; PASS Task Scheduler alone does not restart a killed task (the finding the supervisor answers); PASS a crashed daemon is back within 10 s, and the app lives on; PASS the tray's Quit stops both, and nothing restarts them; PASS a user's start of the app brings up both within 10 s; PASS the daemon side's Quit stops both, and nothing restarts them

