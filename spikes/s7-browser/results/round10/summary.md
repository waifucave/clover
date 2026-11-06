## Spike S7 results

### Chrome for Testing · linux-arm64 (cft-linux-arm64-install.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 5 s

**chrome-headless-shell** — ; sandbox –

- install: 121 MiB archive, 277 MiB unpacked, 287 files, 0 symlinks; download 873 ms, unpack 1021 ms; sha256 `5bb6a00a4285c13303d3f72c5afdb70f144ea7a93eed462365a52b69631c9607` (matches the pin; server MD5 true)

**chrome** — ; sandbox –

- install: 191 MiB archive, 401 MiB unpacked, 301 files, 0 symlinks; download 1185 ms, unpack 1358 ms; sha256 `1f496a826c9ba4d6a5f5bf2de686145fe718528c2cc3dbeb96b5893b89653724` (matches the pin; server MD5 true)

**Assertions:** PASS the headless shell installs from its pin

### Chrome for Testing · linux-arm64 (cft-linux-arm64-worker.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 203 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 121 MiB archive, 277 MiB unpacked, 287 files, 0 symlinks; download 873 ms, unpack 1021 ms; sha256 `5bb6a00a4285c13303d3f72c5afdb70f144ea7a93eed462365a52b69631c9607` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 55 ms, warm 54 ms; the port for comparison 57 ms
- start attempts: fdpipe ok 55 ms
- tabs: own window: first (background): visible, 1280x800, interval 100.1 Hz, rAF 60.2 Hz; own window: second (front): visible, 1280x800, interval 100.0 Hz, rAF 60.2 Hz; one window: first (background): visible, 1280x800, interval 100.1 Hz, rAF 60.2 Hz; one window: second (front): visible, 1280x800, interval 100.0 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.2 Hz, rAF 60.2 Hz, media ×0.94, decoded 28.8 fps, audio running, set up in 37 ms, browser answers in 0 ms
- resize to 1000×700 and back: 3 ms / 22 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 213 / 227 ms (642 KiB, CPU 334 ms), jpeg 80 / 85 ms (165 KiB, stale -49 / -34 ms, CPU 143 ms)
- screencast: 60.3 fps, 66753 kbit/s, 135 KiB/frame, latency 32 / 33 ms, browser CPU 148%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 175 MiB, per idle tab 30 MiB, 4 browser contexts +119 MiB, a second bot's browser 113 MiB (7 processes), animated tab 53.3% CPU
  - steps: 0 tabs 175 MiB pss / 0.5%, 1 tabs 217 MiB pss / 3.5%, 2 tabs 247 MiB pss / 6.2%, 4 tabs 302 MiB pss / 13.2%, 8 tabs 413 MiB pss / 25.6%

**chrome** — Chrome/156.0.8078.80; sandbox on

- install: 191 MiB archive, 401 MiB unpacked, 301 files, 0 symlinks; download 1185 ms, unpack 1358 ms; sha256 `1f496a826c9ba4d6a5f5bf2de686145fe718528c2cc3dbeb96b5893b89653724` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 232 ms, warm 215 ms; the port for comparison 255 ms
- start attempts: fdpipe ok 232 ms
- tabs: own window: first (background): visible, 1280x657, interval 99.9 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x657, interval 100.1 Hz, rAF 60.0 Hz; one window: first (background): hidden, 1280x657, interval 1.0 Hz, rAF 0.0 Hz; one window: second (front): visible, 1280x657, interval 99.9 Hz, rAF 60.2 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.0 Hz, media ×0.95, decoded 28.8 fps, audio running, set up in 69 ms, browser answers in 0 ms
- resize to 1000×700 and back: 2 ms / 25 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 184 / 197 ms (532 KiB, CPU 308 ms), jpeg 73 / 74 ms (144 KiB, stale -41 / -39 ms, CPU 140 ms)
- screencast: 60.3 fps, 58068 kbit/s, 118 KiB/frame, latency 32 / 33 ms, browser CPU 139%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 424 MiB, per idle tab 57 MiB, 4 browser contexts +336 MiB, a second bot's browser 258 MiB (10 processes), animated tab 59.0% CPU
  - steps: 0 tabs 424 MiB pss / 1.2%, 1 tabs 503 MiB pss / 3.2%, 2 tabs 581 MiB pss / 7.5%, 4 tabs 656 MiB pss / 14.4%, 8 tabs 878 MiB pss / 28.2%

**Assertions:** PASS the headless shell installs from its pin; PASS it starts over the native DevTools pipe; PASS it runs sandboxed; PASS no step failed; PASS every tab is visible and draws (rAF above 10 Hz); PASS screenshots and a screencast arrive, fresh; PASS per-bot profiles are apart and survive a restart

### Chrome for Testing · linux-arm64 (cft-linux-arm64.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 204 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 121 MiB archive, 277 MiB unpacked, 287 files, 0 symlinks; download 873 ms, unpack 1021 ms; sha256 `5bb6a00a4285c13303d3f72c5afdb70f144ea7a93eed462365a52b69631c9607` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 125 ms, warm 51 ms; the port for comparison 55 ms
- start attempts: fdpipe ok 125 ms
- tabs: own window: first (background): visible, 1280x800, interval 100.1 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x800, interval 100.0 Hz, rAF 60.0 Hz; one window: first (background): visible, 1280x800, interval 100.2 Hz, rAF 60.0 Hz; one window: second (front): visible, 1280x800, interval 100.2 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.0 Hz, media ×0.95, decoded 29.0 fps, audio running, set up in 96 ms, browser answers in 1 ms
- resize to 1000×700 and back: 2 ms / 23 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 212 / 229 ms (637 KiB, CPU 338 ms), jpeg 76 / 84 ms (165 KiB, stale -49 / -34 ms, CPU 140 ms)
- screencast: 60.3 fps, 66718 kbit/s, 135 KiB/frame, latency 33 / 34 ms, browser CPU 150%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 176 MiB, per idle tab 30 MiB, 4 browser contexts +119 MiB, a second bot's browser 113 MiB (7 processes), animated tab 53.1% CPU
  - steps: 0 tabs 176 MiB pss / 0.0%, 1 tabs 217 MiB pss / 3.0%, 2 tabs 247 MiB pss / 6.2%, 4 tabs 303 MiB pss / 13.9%, 8 tabs 413 MiB pss / 26.1%

**chrome** — Chrome/156.0.8078.80; sandbox on

- install: 191 MiB archive, 401 MiB unpacked, 301 files, 0 symlinks; download 1185 ms, unpack 1358 ms; sha256 `1f496a826c9ba4d6a5f5bf2de686145fe718528c2cc3dbeb96b5893b89653724` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 278 ms, warm 218 ms; the port for comparison 250 ms
- start attempts: fdpipe ok 278 ms
- tabs: own window: first (background): visible, 1280x657, interval 100.2 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x657, interval 100.0 Hz, rAF 60.0 Hz; one window: first (background): hidden, 1280x657, interval 1.0 Hz, rAF 0.0 Hz; one window: second (front): visible, 1280x657, interval 99.9 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.0 Hz, media ×0.95, decoded 28.8 fps, audio running, set up in 62 ms, browser answers in 0 ms
- resize to 1000×700 and back: 3 ms / 22 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 187 / 196 ms (522 KiB, CPU 304 ms), jpeg 72 / 74 ms (144 KiB, stale -41 / -39 ms, CPU 139 ms)
- screencast: 60.5 fps, 58271 kbit/s, 118 KiB/frame, latency 31 / 32 ms, browser CPU 136%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 448 MiB, per idle tab 55 MiB, 4 browser contexts +333 MiB, a second bot's browser 287 MiB (12 processes), animated tab 57.8% CPU
  - steps: 0 tabs 448 MiB pss / 1.2%, 1 tabs 526 MiB pss / 3.5%, 2 tabs 604 MiB pss / 7.2%, 4 tabs 681 MiB pss / 13.9%, 8 tabs 885 MiB pss / 27.2%

**Assertions:** PASS the headless shell installs from its pin; PASS it starts over the native DevTools pipe; PASS it runs sandboxed; PASS no step failed; PASS every tab is visible and draws (rAF above 10 Hz); PASS screenshots and a screencast arrive, fresh; PASS per-bot profiles are apart and survive a restart

### Chrome for Testing · linux-x64 (cft-linux-x64-install.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 6 s

**chrome-headless-shell** — ; sandbox –

- install: 121 MiB archive, 274 MiB unpacked, 287 files, 0 symlinks; download 1049 ms, unpack 1399 ms; sha256 `547dcd374e02961bf998f6046a267644f8502225c36bb78ca307dab32a0b3eb4` (matches the pin; server MD5 true)

**chrome** — ; sandbox –

- install: 192 MiB archive, 403 MiB unpacked, 301 files, 0 symlinks; download 834 ms, unpack 1968 ms; sha256 `b711c720f774be355197f32edf37e0651418ba036d92446ee2da19ac017540a7` (matches the pin; server MD5 true)

**Assertions:** PASS the headless shell installs from its pin

### Chrome for Testing · linux-x64 (cft-linux-x64-worker.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 205 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 121 MiB archive, 274 MiB unpacked, 287 files, 0 symlinks; download 1049 ms, unpack 1399 ms; sha256 `547dcd374e02961bf998f6046a267644f8502225c36bb78ca307dab32a0b3eb4` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 70 ms, warm 66 ms; the port for comparison 71 ms
- start attempts: fdpipe ok 70 ms
- tabs: own window: first (background): visible, 1280x800, interval 100.2 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x800, interval 100.0 Hz, rAF 60.0 Hz; one window: first (background): visible, 1280x800, interval 100.1 Hz, rAF 60.0 Hz; one window: second (front): visible, 1280x800, interval 100.2 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.0 Hz, media ×0.94, decoded 29.0 fps, audio running, set up in 46 ms, browser answers in 1 ms
- resize to 1000×700 and back: 2 ms / 21 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 293 / 313 ms (639 KiB, CPU 384 ms), jpeg 77 / 88 ms (157 KiB, stale -42 / -35 ms, CPU 110 ms)
- screencast: 59.8 fps, 65340 kbit/s, 133 KiB/frame, latency 36 / 38 ms, browser CPU 156%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 169 MiB, per idle tab 29 MiB, 4 browser contexts +117 MiB, a second bot's browser 115 MiB (7 processes), animated tab 37.1% CPU
  - steps: 0 tabs 169 MiB pss / 0.0%, 1 tabs 210 MiB pss / 3.7%, 2 tabs 240 MiB pss / 7.0%, 4 tabs 295 MiB pss / 12.2%, 8 tabs 404 MiB pss / 22.6%

**chrome** — Chrome/156.0.8078.80; sandbox on

- install: 192 MiB archive, 403 MiB unpacked, 301 files, 0 symlinks; download 834 ms, unpack 1968 ms; sha256 `b711c720f774be355197f32edf37e0651418ba036d92446ee2da19ac017540a7` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 229 ms, warm 235 ms; the port for comparison 268 ms
- start attempts: fdpipe ok 229 ms
- tabs: own window: first (background): visible, 1280x657, interval 99.9 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x657, interval 100.2 Hz, rAF 60.0 Hz; one window: first (background): hidden, 1280x657, interval 2.0 Hz, rAF 0.0 Hz; one window: second (front): visible, 1280x657, interval 100.1 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.1 Hz, rAF 60.2 Hz, media ×0.95, decoded 28.8 fps, audio running, set up in 77 ms, browser answers in 1 ms
- resize to 1000×700 and back: 2 ms / 22 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 253 / 268 ms (536 KiB, CPU 346 ms), jpeg 73 / 76 ms (144 KiB, stale -39 / -35 ms, CPU 111 ms)
- screencast: 60.4 fps, 57784 kbit/s, 117 KiB/frame, latency 33 / 37 ms, browser CPU 136%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 411 MiB, per idle tab 61 MiB, 4 browser contexts +325 MiB, a second bot's browser 256 MiB (10 processes), animated tab 39.4% CPU
  - steps: 0 tabs 411 MiB pss / 2.0%, 1 tabs 493 MiB pss / 4.2%, 2 tabs 550 MiB pss / 7.2%, 4 tabs 653 MiB pss / 13.2%, 8 tabs 901 MiB pss / 25.1%

**Assertions:** PASS the headless shell installs from its pin; PASS it starts over the native DevTools pipe; PASS it runs sandboxed; PASS no step failed; PASS every tab is visible and draws (rAF above 10 Hz); PASS screenshots and a screencast arrive, fresh; PASS per-bot profiles are apart and survive a restart

### Chrome for Testing · linux-x64 (cft-linux-x64.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 208 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 121 MiB archive, 274 MiB unpacked, 287 files, 0 symlinks; download 1049 ms, unpack 1399 ms; sha256 `547dcd374e02961bf998f6046a267644f8502225c36bb78ca307dab32a0b3eb4` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 174 ms, warm 60 ms; the port for comparison 64 ms
- start attempts: fdpipe ok 174 ms
- tabs: own window: first (background): visible, 1280x800, interval 100.0 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x800, interval 100.0 Hz, rAF 60.2 Hz; one window: first (background): visible, 1280x800, interval 99.9 Hz, rAF 60.0 Hz; one window: second (front): visible, 1280x800, interval 100.0 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.0 Hz, media ×0.91, decoded 29.0 fps, audio running, set up in 152 ms, browser answers in 0 ms
- resize to 1000×700 and back: 2 ms / 21 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 295 / 315 ms (635 KiB, CPU 384 ms), jpeg 80 / 89 ms (154 KiB, stale -42 / -39 ms, CPU 108 ms)
- screencast: 59.8 fps, 65396 kbit/s, 134 KiB/frame, latency 35 / 39 ms, browser CPU 150%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 171 MiB, per idle tab 29 MiB, 4 browser contexts +117 MiB, a second bot's browser 114 MiB (7 processes), animated tab 33.6% CPU
  - steps: 0 tabs 171 MiB pss / 0.0%, 1 tabs 212 MiB pss / 3.7%, 2 tabs 241 MiB pss / 6.5%, 4 tabs 296 MiB pss / 12.5%, 8 tabs 406 MiB pss / 21.9%

**chrome** — Chrome/156.0.8078.80; sandbox on

- install: 192 MiB archive, 403 MiB unpacked, 301 files, 0 symlinks; download 834 ms, unpack 1968 ms; sha256 `b711c720f774be355197f32edf37e0651418ba036d92446ee2da19ac017540a7` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 275 ms, warm 218 ms; the port for comparison 299 ms
- start attempts: fdpipe ok 275 ms
- tabs: own window: first (background): visible, 1280x657, interval 99.9 Hz, rAF 60.0 Hz; own window: second (front): visible, 1280x657, interval 100.0 Hz, rAF 60.0 Hz; one window: first (background): hidden, 1280x657, interval 1.0 Hz, rAF 0.0 Hz; one window: second (front): visible, 1280x657, interval 99.9 Hz, rAF 60.0 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.0 Hz, rAF 60.0 Hz, media ×0.94, decoded 29.0 fps, audio running, set up in 75 ms, browser answers in 0 ms
- resize to 1000×700 and back: 2 ms / 44 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 265 / 293 ms (527 KiB, CPU 354 ms), jpeg 91 / 102 ms (137 KiB, stale -42 / -34 ms, CPU 116 ms)
- screencast: 60.5 fps, 57648 kbit/s, 116 KiB/frame, latency 49 / 51 ms, browser CPU 134%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 436 MiB, per idle tab 58 MiB, 4 browser contexts +325 MiB, a second bot's browser 283 MiB (12 processes), animated tab 37.2% CPU
  - steps: 0 tabs 436 MiB pss / 1.0%, 1 tabs 515 MiB pss / 4.0%, 2 tabs 572 MiB pss / 6.7%, 4 tabs 673 MiB pss / 12.2%, 8 tabs 898 MiB pss / 23.8%

**Assertions:** PASS the headless shell installs from its pin; PASS it starts over the native DevTools pipe; PASS it runs sandboxed; PASS no step failed; PASS every tab is visible and draws (rAF above 10 Hz); PASS screenshots and a screencast arrive, fresh; PASS per-bot profiles are apart and survive a restart

### Chrome for Testing · darwin-arm64 (cft-macos-install.json)

25.6.0, 3 CPUs, 7 GiB, Bun 1.3.14, status **done**, 9 s

**chrome-headless-shell** — ; sandbox –

- install: 99 MiB archive, 204 MiB unpacked, 16 files, 0 symlinks; download 1664 ms, unpack 1947 ms; sha256 `ea615baa2e9caf0d02d1898a6562b5f8fa9c35239707dae0f592178df5b986ac` (matches the pin; server MD5 true)

**chrome** — ; sandbox –

- install: 186 MiB archive, 366 MiB unpacked, 344 files, 5 symlinks; download 2245 ms, unpack 3023 ms; sha256 `8bc590d1b1acac042a000234c768f31830f25a3983a83ed5e067114c87c4cad1` (matches the pin; server MD5 true)

**Assertions:** PASS the headless shell installs from its pin

### Chrome for Testing · darwin-arm64 (cft-macos.json)

25.6.0, 3 CPUs, 7 GiB, Bun 1.3.14, status **done**, 246 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 99 MiB archive, 204 MiB unpacked, 16 files, 0 symlinks; download 1664 ms, unpack 1947 ms; sha256 `ea615baa2e9caf0d02d1898a6562b5f8fa9c35239707dae0f592178df5b986ac` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 870 ms, warm 149 ms; the port for comparison 206 ms
- start attempts: fdpipe ok 870 ms
- tabs: own window: first (background): visible, 1280x800, interval 70.3 Hz, rAF 48.9 Hz; own window: second (front): visible, 1280x800, interval 68.7 Hz, rAF 42.7 Hz; one window: first (background): visible, 1280x800, interval 74.3 Hz, rAF 48.7 Hz; one window: second (front): visible, 1280x800, interval 70.1 Hz, rAF 43.7 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 68.9 Hz, rAF 35.4 Hz, media ×0.99, decoded 29.4 fps, audio running, set up in 449 ms, browser answers in 0 ms
- resize to 1000×700 and back: 4 ms / 47 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 331 / 494 ms (635 KiB, CPU 426 ms), jpeg 115 / 178 ms (132 KiB, stale -55 / -15 ms, CPU 130 ms)
- screencast: 35.0 fps, 33723 kbit/s, 118 KiB/frame, latency 56 / 103 ms, browser CPU 69%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 45 MiB, per idle tab 45 MiB, 4 browser contexts +179 MiB, a second bot's browser 44 MiB (4 processes), animated tab 29.5% CPU
  - steps: 0 tabs 45 MiB footprint / 1.0%, 1 tabs 91 MiB footprint / 3.0%, 2 tabs 136 MiB footprint / 6.2%, 4 tabs 227 MiB footprint / 17.2%, 8 tabs 408 MiB footprint / 30.6%

**chrome** — Chrome/156.0.8078.80; sandbox on

- install: 186 MiB archive, 366 MiB unpacked, 344 files, 5 symlinks; download 2245 ms, unpack 3023 ms; sha256 `8bc590d1b1acac042a000234c768f31830f25a3983a83ed5e067114c87c4cad1` (matches the pin; server MD5 true)
- start: over **fdpipe**, cold 3684 ms, warm 1570 ms; the port for comparison 1182 ms
- start attempts: fdpipe ok 3684 ms
- tabs: own window: first (background): visible, 1280x657, interval 50.5 Hz, rAF 28.5 Hz; own window: second (front): hidden, 1280x657, interval 1.2 Hz, rAF 0.0 Hz; one window: first (background): hidden, 1280x657, interval 1.0 Hz, rAF 0.0 Hz; one window: second (front): visible, 1280x657, interval 42.1 Hz, rAF 18.9 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 46.7 Hz, rAF 15.6 Hz, media ×0.96, decoded 29.1 fps, audio running, set up in 1111 ms, browser answers in 1 ms
- resize to 1000×700 and back: 16 ms / 51 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 360 / 457 ms (476 KiB, CPU 203 ms), jpeg 244 / 348 ms (120 KiB, stale -161 / -62 ms, CPU 111 ms)
- screencast: 32.6 fps, 26813 kbit/s, 100 KiB/frame, latency 82 / 137 ms, browser CPU 40%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 264 MiB, per idle tab 60 MiB, 4 browser contexts +429 MiB, a second bot's browser 255 MiB (9 processes), animated tab 2.5% CPU
  - steps: 0 tabs 264 MiB footprint / 5.6%, 1 tabs 369 MiB footprint / 6.8%, 2 tabs 422 MiB footprint / 6.1%, 4 tabs 518 MiB footprint / 10.8%, 8 tabs 748 MiB footprint / 8.8%

**Assertions:** PASS the headless shell installs from its pin; PASS it starts over the native DevTools pipe; PASS it runs sandboxed; PASS no step failed; PASS every tab is visible and draws (rAF above 10 Hz); PASS screenshots and a screencast arrive, fresh; PASS per-bot profiles are apart and survive a restart

### Chrome for Testing · win32-x64 (cft-windows-install.json)

10.0.26100, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 7 s

**chrome-headless-shell** — ; sandbox –

- install: 120 MiB archive, 282 MiB unpacked, 288 files, 0 symlinks; download 1181 ms, unpack 1769 ms; sha256 `10a77466005e7f64e00f1a75fd1ea81f4a38a60093c65fea6895843b26e60a9a` (matches the pin; server MD5 true)

**chrome** — ; sandbox –

- install: 199 MiB archive, 439 MiB unpacked, 305 files, 0 symlinks; download 1399 ms, unpack 2570 ms; sha256 `16edb57d6107bf1c48a7c149b8d78b155fe614410093796dd72441fd6640540f` (matches the pin; server MD5 true)

**Assertions:** PASS the headless shell installs from its pin

### Chrome for Testing · win32-x64 (cft-windows.json)

10.0.26100, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 232 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 120 MiB archive, 282 MiB unpacked, 288 files, 0 symlinks; download 1181 ms, unpack 1769 ms; sha256 `10a77466005e7f64e00f1a75fd1ea81f4a38a60093c65fea6895843b26e60a9a` (matches the pin; server MD5 true)
- start: over **winpipe**, cold 130 ms, warm 116 ms; the port for comparison 83 ms
- start attempts: winpipe ok 130 ms
- tabs: own window: first (background): visible, 1280x800, interval 100.0 Hz, rAF 59.9 Hz; own window: second (front): visible, 1280x800, interval 100.0 Hz, rAF 60.1 Hz; one window: first (background): visible, 1280x800, interval 99.9 Hz, rAF 60.0 Hz; one window: second (front): visible, 1280x800, interval 99.9 Hz, rAF 59.8 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.1 Hz, rAF 60.0 Hz, media ×0.99, decoded 29.2 fps, audio running, set up in 64 ms, browser answers in 4 ms
- resize to 1000×700 and back: 12 ms / 8 ms, same document true (1280 → 1000 → 1280)
- screenshots: png 249 / 263 ms (580 KiB, CPU 381 ms), jpeg 78 / 85 ms (144 KiB, stale -45 / -36 ms, CPU 145 ms)
- screencast: 60.1 fps, 56678 kbit/s, 115 KiB/frame, latency 36 / 53 ms, browser CPU 120%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 70 MiB, per idle tab 31 MiB, 4 browser contexts +118 MiB, a second bot's browser 71 MiB (5 processes), animated tab 42.8% CPU
  - steps: 0 tabs 70 MiB privateBytes / 0.0%, 1 tabs 101 MiB privateBytes / 2.8%, 2 tabs 131 MiB privateBytes / 5.3%, 4 tabs 196 MiB privateBytes / 8.5%, 8 tabs 315 MiB privateBytes / 27.9%

**chrome** — Chrome/156.0.8078.80; sandbox on

- install: 199 MiB archive, 439 MiB unpacked, 305 files, 0 symlinks; download 1399 ms, unpack 2570 ms; sha256 `16edb57d6107bf1c48a7c149b8d78b155fe614410093796dd72441fd6640540f` (matches the pin; server MD5 true)
- start: over **winpipe**, cold 733 ms, warm 371 ms; the port for comparison 391 ms
- start attempts: winpipe ok 733 ms
- tabs: own window: first (background): visible, 1264x649, interval 100.2 Hz, rAF 60.1 Hz; own window: second (front): visible, 1264x649, interval 100.0 Hz, rAF 60.1 Hz; one window: first (background): hidden, 1264x649, interval 1.0 Hz, rAF 0.0 Hz; one window: second (front): visible, 1264x649, interval 100.0 Hz, rAF 59.9 Hz
- media (video with sound, an AudioContext): default flags: visible, interval 100.1 Hz, rAF 60.0 Hz, media ×0.98, decoded 29.2 fps, audio running, set up in 43 ms, browser answers in 5 ms
- resize to 1000×700 and back: 9 ms / 11 ms, same document true (1264 → 1000 → 1264)
- screenshots: png 208 / 233 ms (467 KiB, CPU 361 ms), jpeg 75 / 78 ms (104 KiB, stale -43 / -38 ms, CPU 104 ms)
- screencast: 60.5 fps, 47599 kbit/s, 96 KiB/frame, latency 32 / 51 ms, browser CPU 96%
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 257 MiB, per idle tab 52 MiB, 4 browser contexts +480 MiB, a second bot's browser 273 MiB (12 processes), animated tab 42.0% CPU
  - steps: 0 tabs 257 MiB privateBytes / 1.4%, 1 tabs 334 MiB privateBytes / 2.5%, 2 tabs 390 MiB privateBytes / 10.3%, 4 tabs 451 MiB privateBytes / 11.4%, 8 tabs 676 MiB privateBytes / 14.2%

**Assertions:** PASS the headless shell installs from its pin; PASS it starts over the native DevTools pipe; PASS it runs sandboxed; PASS no step failed; PASS every tab is visible and draws (rAF above 10 Hz); PASS screenshots and a screencast arrive, fresh; PASS per-bot profiles are apart and survive a restart

### Electron · linux-arm64-ozone-headless (electron-linux-arm64-ozone-headless.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-arm64 7.0.0-1017-azure, ozone headless, displays 1920x1080@1, status **done**, 573 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.91 | 27.8 | 42 / 90 | 1 / 8 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.95 | 28.4 | 28 / 35 | 5 / 5 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.4 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.96 | 28.4 | 31 / 41 | 5 / 18 | 1280x800@1 → 1000x700@1 → 1280x800 | 1 / 1 | 2.4 |  |
| invisibleWindow | true | true | true | true (1) | 0.96 | 28.7 | 27 / 41 | 2 / 6 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.0 |  |
| tinyWindow | true | true | true | true (1) | 0.96 | 28.6 | 28 / 38 | 4 / 15 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.1 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | IO / RO Hz | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 100.1 | 99.1 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 5.6 | 8.6 |  |
| detached, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.2 |  |
| detached, throttling off | visible | 1280x800 | 100.1 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 1.0 | 1.2 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.0 |  |
| never-shown window, throttling off | visible | 1280x800 | 100.1 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.8 | 1.0 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 100.1 | 99.3 | 1.0 | 1017 | 0.0 / 0.0 | – | – | – | 1.0 | 1.2 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 100.1 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 0.8 | 0.8 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 100.1 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 1.0 | 1.4 |  |
| invisible shown window, throttling off | visible | 1280x800 | 100.0 | 99.4 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 5.2 | 7.2 |  |
| 1x1 shown window, throttling off | visible | 1280x800 | 100.0 | 99.4 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 5.4 | 6.8 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 99.9 | 99.1 | 60.0 | 18 | 2.0 / 2.0 | – | – | – | 5.2 | 7.0 | cover 0,0 1920x1080 over host 0,0 1x1 |
| 1x1 shown window kept above a cover window (always on top) | visible | 1280x800 | 99.9 | 99.1 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 5.2 | 6.8 | cover 0,0 1920x1080 over host 0,0 1x1 |
| invisible shown window, covered by another window | visible | 1280x800 | 100.2 | 99.2 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 5.4 | 7.4 | cover -1480,-1000 1920x1080 over host -1480,-1000 1280x800 |
| 1x1 shown window, throttling on (control) | visible | 1280x800 | 99.9 | 99.3 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 5.4 | 7.2 |  |
| 1x1 shown window, throttling on, covered by another window (control) | visible | 1280x800 | 100.0 | 99.2 | 60.0 | 17 | 1.8 / 1.8 | – | – | – | 5.0 | 6.4 | cover 0,0 1920x1080 over host 0,0 1x1 |
| invisible shown window, throttling on, covered by another window (control) | visible | 1280x800 | 100.0 | 99.2 | 60.0 | 18 | 2.0 / 2.0 | – | – | – | 5.0 | 7.4 | cover -1480,-1000 1920x1080 over host -1480,-1000 1280x800 |
| osr window 30 fps, throttling off | visible | 1280x800 | 100.2 | 99.0 | 30.0 | 36 | 2.2 / 2.2 | – | – | – | 4.2 | 13.6 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 100.0 | 99.2 | 30.0 | 35 | 0.0 / 2.0 | – | – | – | 2.2 | 2.8 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 99.9 | 99.3 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 25.8 | – | 2.4 | 3.0 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 99.9 | 99.3 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 25.8 | – | 2.4 | 3.0 |  |
| detached, throttling off, playing media | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 25.8 | – | 2.4 | 3.0 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 1.8 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | to 1280×800 + JPEG ms | CPU ms/picture | frames/s | visibility events | geometry; errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 16 / 19 | 5 / 14 | 1000x700 | 15 / 15 | 82 | – |  | view 0,0 1000x700 in content 40,65 1000x700; page 1000x700 at 1x |
| shown | true | capturePage | 6/6 | 6 | 17 / 18 | 5 / 9 | 1000x700 | 14 / 15 | 83 | – |  | view 0,0 1000x700 in content 40,65 1000x700; page 1000x700 at 1x |
| shown | true | cdpJpeg | 6/6 | 6 | 82 / 85 | -50 / -43 | 1000x700 | – | 95 | – |  | view 0,0 1000x700 in content 40,65 1000x700; page 1000x700 at 1x |
| shown | true | frameSub | 6/6 | 6 | 15 / 19 | 9 / 9 | 1000x700 | – | 55 | – |  | view 0,0 1000x700 in content 40,65 1000x700; page 1000x700 at 1x |
| shown | true | cdpPng | 6/6 | 6 | 172 / 183 | -47 / -37 | 1000x700 | – | 225 | – |  | view 0,0 1000x700 in content 40,65 1000x700; page 1000x700 at 1x |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 65 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | – | 60 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 4048 / 4049 | -2995 / -45 | 1280x800 | – | 137 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x |
| hiddenWindow | false | frameSub | 6/6 | 6 | 7 / 8 | 61 / 74 | 1280x800 | – | 43 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.5 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 97 / 100 | -62 / -31 | 1280x800 | – | 148 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 14 / 17 | 9 / 10 | 1280x800 | – | 82 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 6/6 | 6 | 15 / 16 | 9 / 10 | 1280x800 | – | 70 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | capturePage | 6/6 | 6 | 13 / 18 | 9 / 12 | 1280x800 | – | 68 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 81 / 83 | -45 / -40 | 1280x800 | – | 127 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | frameSub | 6/6 | 6 | 15 / 17 | 12 / 13 | 1280x800 | – | 72 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 14 / 16 | 9 / 14 | 1280x800 | – | 62 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | capturePage | 6/6 | 6 | 14 / 16 | 9 / 11 | 1280x800 | – | 60 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 81 / 83 | -45 / -38 | 1280x800 | – | 107 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | frameSub | 6/6 | 6 | 15 / 19 | 11 / 12 | 1280x800 | – | 58 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 15 / 17 | 9 / 12 | 1280x800 | – | 63 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 15 / 16 | 9 / 13 | 1280x800 | – | 60 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 80 / 83 | -45 / -36 | 1280x800 | – | 107 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 15 / 19 | 11 / 12 | 1280x800 | – | 60 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePageHidden | 6/6 | 6 | 14 / 23 | 9 / 10 | 1280x800 | – | 65 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | capturePage | 6/6 | 6 | 14 / 17 | 9 / 12 | 1280x800 | – | 60 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | cdpJpeg | 6/6 | 6 | 80 / 85 | -44 / -37 | 1280x800 | – | 107 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | frameSub | 6/6 | 6 | 15 / 18 | 11 / 12 | 1280x800 | – | 60 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 56 / 62 | 1280x800 | – | 35 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | capturePage | 6/6 | 6 | 30 / 32 | 10 / 33 | 1280x800 | – | 60 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | cdpJpeg | 6/6 | 6 | 131 / 133 | -78 / -77 | 1280x800 | – | 103 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | – | 172 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | – | 3 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 145 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 242 | pss | 512 | 4 | 0.3 |
| 1 | 270 | pss | 614 | 5 | 0.0 |
| 2 | 285 | pss | 717 | 6 | 0.0 |
| 4 | 314 | pss | 925 | 8 | 0.8 |
| 8 | 370 | pss | 1340 | 12 | 0.8 |

Per idle tab resting in the never-shown window (a still page): **16 MiB**, 0.06% CPU. Four tabs: one partition +65 MiB, four partitions +70 MiB.

Quiet tabs working in one shared 1×1 host (no rAF loop; the page repaints twice a second): **28 MiB** and 0.87% CPU a tab (0: 267 MiB / 0.0%, 1: 307 MiB / 1.0%, 4: 387 MiB / 4.8%, 8: 492 MiB / 7.0%).

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 37.0 | 29.2 | 7.8 | 60 |
| animated, never-shown window, throttling off | 1.0 | 1.0 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.3 | 0.0 | 0.0 | 0 |
| animated, never-shown window, throttling off + frame pump | 1.0 | 0.8 | 0.3 | 0 |
| animated, invisible shown window | 48.0 | 37.7 | 10.0 | 60 |
| animated, 1x1 shown window | 39.7 | 37.7 | 1.5 | 60 |
| animated, osr 30 fps | 33.0 | 20.5 | 5.5 | 30 |

**Waking a resting tab into the host** (never-shown window, throttling on, 4 cycles): first rAF 1 / 2 ms, fresh picture 22 / 28 ms; resting rates 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0; awake rAF 60, 60, 60, 60

**One host, 4 tabs (each held at 1280×800, 1×):** tab 1 rAF 60 Hz, capturePage 4/4 in 14 / 21 ms (1280x800); tab 2 rAF 60 Hz, capturePage 4/4 in 15 / 17 ms (1280x800); tab 3 rAF 60 Hz, capturePage 4/4 in 14 / 17 ms (1280x800); tab 4 rAF 60 Hz, capturePage 4/4 in 14 / 17 ms (1280x800)

**The host's invariants:** host 100,100 1x1, focused at start false, after its page grabs focus false (focused window "S7 browser view"); Windows styles –; click-through not testable here (macOS needs Accessibility for synthetic clicks; Wayland and no display have no global input)

**Assertions:** PASS no reload when moving from detached; PASS no reload when moving from hiddenWindow; PASS no reload when moving from hiddenWindowFit; PASS no reload when moving from invisibleWindow; PASS no reload when moving from tinyWindow; PASS the 1x1 host draws (rAF above 10 Hz); PASS a never-shown window draws nothing (rAF below 1 Hz); PASS capturePage works in the 1x1 host; PASS capturePage works in the 1x1 host with the agent's 1280x800 at 1x held; PASS the host never takes focus, even when its page asks; PASS a resting tab draws within 2 s of moving into the host, every cycle; PASS every tab in one shared host draws and is pictured

### Electron · linux-wayland (electron-linux-wayland.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone wayland, displays 1920x1080@1, status **done**, 835 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.92 | 28.1 | 50 / 171 | 1 / 136 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.91 | 27.4 | 44 / 47 | 1 / 2 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.1 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.93 | 27.8 | 41 / 46 | 1 / 2 | 1280x800@1 → 1000x700@1 → 1280x800 | 0 / 1 | 0.0 |  |
| tinyWindow | true | true | true | true (1) | 0.96 | 28.6 | 40 / 50 | 10 / 17 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 40.7 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | IO / RO Hz | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 100.1 | 98.9 | 39.8 | 27 | 2.0 / 2.2 | – | – | – | 5.0 | 9.8 |  |
| detached, throttling on (default) | hidden | 1280x800 | 2.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.2 |  |
| detached, throttling off | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 1.2 | 1.8 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.8 |  |
| never-shown window, throttling off | visible | 1280x800 | 100.0 | 99.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 1.2 | 1.4 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 100.1 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 1.4 | 1.4 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 1.2 | 1.8 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 100.1 | 98.9 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 1.4 | 1.6 |  |
| invisible shown window, throttling off | – | – | – | – | – | – | – | – | – | – | – | – | not possible here |
| 1x1 shown window, throttling off | visible | 1280x800 | 100.1 | 99.1 | 39.8 | 26 | 1.8 / 1.8 | – | – | – | 4.6 | 8.0 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 100.1 | 99.1 | 39.8 | 26 | 2.0 / 2.0 | – | – | – | 5.2 | 8.6 | cover -10,-10 1940x1100 over host 0,0 1x1 |
| 1x1 shown window kept above a cover window (always on top) | visible | 1280x800 | 100.0 | 99.0 | 40.0 | 26 | 2.2 / 2.2 | – | – | – | 4.8 | 8.8 | cover -10,-10 1940x1100 over host 0,0 1x1 |
| invisible shown window, covered by another window | – | – | – | – | – | – | – | – | – | – | – | – | not possible here |
| 1x1 shown window, throttling on (control) | visible | 1280x800 | 99.9 | 99.1 | 39.8 | 26 | 2.0 / 2.0 | – | – | – | 4.8 | 8.0 |  |
| 1x1 shown window, throttling on, covered by another window (control) | visible | 1280x800 | 99.9 | 98.9 | 40.0 | 26 | 2.2 / 2.2 | – | – | – | 4.8 | 8.0 | cover -10,-10 1940x1100 over host 0,0 1x1 |
| invisible shown window, throttling on, covered by another window (control) | – | – | – | – | – | – | – | – | – | – | – | – | not possible here |
| osr window 30 fps, throttling off | visible | 1280x800 | 100.0 | 99.2 | 30.0 | 34 | 2.0 / 2.0 | – | – | – | 3.6 | 14.8 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 100.0 | 99.2 | 30.0 | 34 | 0.0 / 2.0 | – | – | – | 2.2 | 2.8 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 25.8 | – | 2.6 | 3.6 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 26.0 | – | 2.6 | 3.6 |  |
| detached, throttling off, playing media | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 25.8 | – | 2.8 | 3.6 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 99.9 | 98.9 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 2.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | to 1280×800 + JPEG ms | CPU ms/picture | frames/s | visibility events | geometry; errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 10 / 32 | 48 / 49 | 1000x700 | 16 / 21 | 68 | – |  | view 0,0 1000x700 in content 40,104 1000x700; page 1000x700 at 1x |
| shown | true | capturePage | 6/6 | 6 | 11 / 12 | 47 / 49 | 1000x700 | 16 / 17 | 63 | – |  | view 0,0 1000x700 in content 40,104 1000x700; page 1000x700 at 1x |
| shown | true | cdpJpeg | 6/6 | 6 | 131 / 135 | -61 / -55 | 1000x700 | – | 82 | – |  | view 0,0 1000x700 in content 40,104 1000x700; page 1000x700 at 1x |
| shown | true | frameSub | 6/6 | 6 | 27 / 29 | 34 / 48 | 1000x700 | – | 43 | – |  | view 0,0 1000x700 in content 40,104 1000x700; page 1000x700 at 1x |
| shown | true | cdpPng | 6/6 | 6 | 262 / 277 | -65 / -64 | 1000x700 | – | 215 | – |  | view 0,0 1000x700 in content 40,104 1000x700; page 1000x700 at 1x |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 29.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 85 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | – | 75 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content 320,185 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 320,185 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 95 | – |  | view 0,0 1280x800 in content 320,185 1280x800; page 1280x800 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| hiddenWindow | false | frameSub | 0/2 | 0 | – | – | - | – | 75 | – |  | view 0,0 1280x800 in content 320,185 1280x800; page 1280x800 at 1x; frame subscription: timed out after 5000 ms |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 320,185 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 320,185 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 85 | – |  | view 0,0 1280x800 in content 320,185 1280x800; page 1280x800 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| hiddenWindow + pump | false | frameSub | 0/2 | 0 | – | – | - | – | 60 | – |  | view 0,0 1280x800 in content 320,185 1280x800; page 1280x800 at 1x; frame subscription: timed out after 5000 ms |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| invisibleWindow | false | - | 0/0 | 0 | – | – | - | – | – | – |  | not possible here |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 22 / 25 | 39 / 39 | 1280x800 | – | 53 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | capturePage | 6/6 | 6 | 22 / 24 | 37 / 39 | 1280x800 | – | 45 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 146 / 153 | -74 / -62 | 1280x800 | – | 82 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | frameSub | 6/6 | 6 | 23 / 34 | 41 / 41 | 1280x800 | – | 48 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.5 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 23 / 30 | 37 / 38 | 1280x800 | – | 48 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 22 / 24 | 37 / 39 | 1280x800 | – | 43 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 148 / 152 | -74 / -62 | 1280x800 | – | 88 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 23 / 34 | 40 / 42 | 1280x800 | – | 48 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.5 |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePageHidden | 6/6 | 6 | 22 / 23 | 37 / 41 | 1280x800 | – | 42 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | capturePage | 6/6 | 6 | 22 / 24 | 37 / 38 | 1280x800 | – | 48 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | cdpJpeg | 6/6 | 6 | 148 / 151 | -73 / -61 | 1280x800 | – | 80 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | frameSub | 6/6 | 6 | 23 / 34 | 40 / 41 | 1280x800 | – | 45 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.5 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 19 / 26 | 1280x800 | – | 28 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | capturePage | 6/6 | 6 | 30 / 32 | -17 / -4 | 1280x800 | – | 53 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | cdpJpeg | 6/6 | 6 | 98 / 129 | -71 / -69 | 1280x800 | – | 90 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | – | 180 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 130 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 330 | pss | 598 | 4 | 0.5 |
| 1 | 358 | pss | 705 | 5 | 0.3 |
| 2 | 374 | pss | 813 | 6 | 0.3 |
| 4 | 404 | pss | 1030 | 8 | 0.3 |
| 8 | 458 | pss | 1462 | 12 | 1.0 |

Per idle tab resting in the never-shown window (a still page): **16 MiB**, 0.06% CPU. Four tabs: one partition +65 MiB, four partitions +71 MiB.

Quiet tabs working in one shared 1×1 host (no rAF loop; the page repaints twice a second): **28 MiB** and 0.97% CPU a tab (0: 355 MiB / 0.5%, 1: 396 MiB / 1.8%, 4: 475 MiB / 5.3%, 8: 579 MiB / 8.3%).

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 22.0 | 14.8 | 5.8 | 39 |
| animated, never-shown window, throttling off | 1.0 | 1.0 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.3 | 0.0 | 0.3 | 0 |
| animated, never-shown window, throttling off + frame pump | 1.5 | 1.3 | 0.3 | 0 |
| animated, 1x1 shown window | 17.3 | 14.5 | 2.0 | 40 |
| animated, osr 30 fps | 25.7 | 12.3 | 4.5 | 30 |

**Waking a resting tab into the host** (never-shown window, throttling on, 4 cycles): first rAF 1 / 11 ms, fresh picture 30 / 65 ms; resting rates 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0; awake rAF 40, 40, 40, 40

**One host, 4 tabs (each held at 1280×800, 1×):** tab 1 rAF 40 Hz, capturePage 4/4 in 21 / 25 ms (1280x800); tab 2 rAF 40 Hz, capturePage 4/4 in 22 / 25 ms (1280x800); tab 3 rAF 40 Hz, capturePage 4/4 in 22 / 24 ms (1280x800); tab 4 rAF 40 Hz, capturePage 4/4 in 22 / 25 ms (1280x800)

**The host's invariants:** host 100,100 1x1, focused at start false, after its page grabs focus false (focused window "(none)"); Windows styles –; click-through not testable here (macOS needs Accessibility for synthetic clicks; Wayland and no display have no global input)

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
| screencast | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 |  |
| capturePoll | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | getUserMedia(tab): AbortError: Timeout starting video source; then getDisplayMedia: AbortError: Timeout starting video source |
| webrtc-h264 | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | getUserMedia(tab): AbortError: Timeout starting video source; then getDisplayMedia: AbortError: Timeout starting video source |
| webcodecs-vp8 | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | getUserMedia(tab): AbortError: Timeout starting video source; then getDisplayMedia: AbortError: Timeout starting video source |
| webcodecs-h264 | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | getUserMedia(tab): AbortError: Timeout starting video source; then getDisplayMedia: AbortError: Timeout starting video source |
| screencast | anim | invisibleWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | not possible here |
| capturePoll | anim | invisibleWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | not possible here |
| webcodecs-h264 | anim | invisibleWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | – | not possible here |
| screencast | anim | tinyWindow | 39.9 | 39.9 | 73 / 74 | 27 | 43833 | 137667 | 102 | 26 | 40 |  |
| webcodecs-h264 | anim | tinyWindow | 30.1 | 30.1 | 68 / 70 | 53 | 2378 | 9874 | 83 | 18 | 40 |  |
| screencast | anim | shown | 38.5 | 38.5 | 70 / 71 | 27 | 35295 | 114593 | 79 | 20 | 39 |  |
| webrtc-vp8 | anim | shown | 20.7 | 20.7 | 87 / 93 | 79 | 2522 | 15231 | 92 | 18 | 38 | libvpx; video/VP8 |
| webcodecs-h264 | anim | shown | 30.0 | 30.0 | 75 / 77 | 54 | 2407 | 10028 | 96 | 18 | 38 |  |

### Electron · linux-x11-dsf2 (electron-linux-x11-dsf2.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone x11, displays 960x540@2, status **done**, 278 s

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | to 1280×800 + JPEG ms | CPU ms/picture | frames/s | visibility events | geometry; errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 47 / 51 | 4 / 14 | 2000x1400 | 28 / 37 | 238 | – |  | view 0,0 1000x700 in content 40,67 960x540; page 1000x700 at 2x |
| shown | true | capturePage | 6/6 | 6 | 46 / 49 | 6 / 10 | 2000x1400 | 29 / 35 | 242 | – |  | view 0,0 1000x700 in content 40,67 960x540; page 1000x700 at 2x |
| shown | true | cdpJpeg | 6/6 | 6 | 139 / 155 | -45 / -33 | 2000x1400 | – | 320 | – |  | view 0,0 1000x700 in content 40,67 960x540; page 1000x700 at 2x |
| shown | true | frameSub | 6/6 | 6 | 58 / 80 | 9 / 11 | 2000x1400 | – | 212 | – |  | view 0,0 1000x700 in content 40,67 960x540; page 1000x700 at 2x |
| shown | true | cdpPng | 6/6 | 6 | 448 / 469 | -44 / -34 | 2000x1400 | – | 965 | – |  | view 0,0 1000x700 in content 40,67 960x540; page 1000x700 at 2x |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 26.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 60 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | – | 95 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content 0,27 960x540; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | – | 3 | – |  | view 0,0 1280x800 in content 0,27 960x540; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 1/3 | 1 | 180 / 180 | -41 / -41 | 2560x1600 | – | 180 | – |  | view 0,0 1280x800 in content 0,27 960x540; page 1280x800 at 2x; Page.captureScreenshot: timed out after 5000 ms |
| hiddenWindow | false | frameSub | 6/6 | 6 | 49 / 52 | 57 / 3038 | 2560x1600 | – | 138 | – |  | view 0,0 1280x800 in content 0,27 960x540; page 1280x800 at 2x |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 29.5 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content 0,27 960x540; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | – | 3 | – |  | view 0,0 1280x800 in content 0,27 960x540; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 265 / 305 | -94 / -22 | 2560x1600 | – | 638 | – |  | view 0,0 1280x800 in content 0,27 960x540; page 1280x800 at 2x |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 72 / 95 | 72 / 77 | 2560x1600 | – | 243 | – |  | view 0,0 1280x800 in content 0,27 960x540; page 1280x800 at 2x |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 28.0 |  |  |
| invisibleWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content -1480,-1000 960x540; page 1280x800 at 2x; Current display surface not available for capture |
| invisibleWindow | false | capturePage | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content -1480,-1000 960x540; page 1280x800 at 2x; Current display surface not available for capture |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 178 / 197 | -41 / -28 | 2560x1600 | – | 407 | – |  | view 0,0 1280x800 in content -1480,-1000 960x540; page 1280x800 at 2x |
| invisibleWindow | false | frameSub | 6/6 | 6 | 75 / 77 | 24 / 28 | 2560x1600 | – | 228 | – |  | view 0,0 1280x800 in content -1480,-1000 960x540; page 1280x800 at 2x |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 23.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 56 / 68 | 28 / 31 | 2560x1600 | 34 / 42 | 175 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 2x |
| tinyWindow | false | capturePage | 6/6 | 6 | 55 / 64 | 26 / 31 | 2560x1600 | 33 / 42 | 172 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 2x |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 173 / 178 | -39 / -35 | 2560x1600 | – | 210 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 2x |
| tinyWindow | false | frameSub | 6/6 | 6 | 72 / 77 | 25 / 30 | 2560x1600 | – | 162 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 2x |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 24.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 56 / 65 | 11 / 15 | 2560x1600 | 35 / 42 | 172 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 2x |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 55 / 66 | 11 / 12 | 2560x1600 | 35 / 42 | 170 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 2x |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 156 / 162 | -39 / -34 | 2560x1600 | – | 207 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 2x |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 73 / 74 | 8 / 16 | 2560x1600 | – | 170 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 2x |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 24.0 |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePageHidden | 6/6 | 6 | 54 / 65 | 12 / 21 | 2560x1600 | 33 / 44 | 168 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | capturePage | 6/6 | 6 | 58 / 63 | 8 / 11 | 2560x1600 | 33 / 40 | 173 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | cdpJpeg | 6/6 | 6 | 69 / 76 | -39 / -36 | 1280x800 | – | 90 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | frameSub | 6/6 | 6 | 73 / 79 | -7 / 13 | 2560x1600 | – | 160 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 24.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 1 | 26 / 30 | 960x540 | – | 12 | – |  | view - in content 0,0 960x540; page 960x540 at 1x |
| osr | false | capturePage | 6/6 | 6 | 17 / 18 | -9 / 0 | 960x540 | 14 / 15 | 45 | – |  | view - in content 0,0 960x540; page 960x540 at 1x |
| osr | false | cdpJpeg | 6/6 | 6 | 98 / 99 | -82 / -76 | 960x540 | – | 52 | – |  | view - in content 0,0 960x540; page 960x540 at 1x |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | – | 162 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | – | 3 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 130 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 288 | pss | 482 | 3 | 0.0 |
| 1 | 318 | pss | 586 | 4 | 0.0 |
| 2 | 333 | pss | 690 | 5 | 0.3 |
| 4 | 363 | pss | 899 | 7 | 0.3 |
| 8 | 419 | pss | 1319 | 11 | 0.8 |

Per idle tab resting in the never-shown window (a still page): **16 MiB**, 0.09% CPU. Four tabs: one partition +67 MiB, four partitions +73 MiB.

Quiet tabs working in one shared 1×1 host (no rAF loop; the page repaints twice a second): **60 MiB** and 1.81% CPU a tab (0: 314 MiB / 0.0%, 1: 387 MiB / 2.3%, 4: 561 MiB / 7.3%, 8: 792 MiB / 14.5%).

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 83.5 | 20.2 | 63.2 | 60 |
| animated, never-shown window, throttling off | 2.0 | 1.5 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.3 | 0.0 | 0.0 | 0 |
| animated, never-shown window, throttling off + frame pump | 1.5 | 1.3 | 0.3 | 0 |
| animated, invisible shown window | 1.8 | 1.3 | 0.3 | 0 |
| animated, 1x1 shown window | 24.7 | 21.7 | 2.5 | 60 |
| animated, osr 30 fps | 17.3 | 9.0 | 3.0 | 30 |

**One host, 4 tabs (each held at 1280×800, 1×):** tab 1 rAF 60 Hz, capturePage 4/4 in 62 / 67 ms (2560x1600); tab 2 rAF 59 Hz, capturePage 4/4 in 67 / 69 ms (2560x1600); tab 3 rAF 58 Hz, capturePage 4/4 in 64 / 69 ms (2560x1600); tab 4 rAF 57 Hz, capturePage 4/4 in 65 / 69 ms (2560x1600)

**Assertions:** PASS capturePage works in the 1x1 host with the agent's 1280x800 at 1x held; PASS every tab in one shared host draws and is pictured

### Electron · linux-x11 (electron-linux-x11.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone x11, displays 1920x1080@1, status **done**, 876 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.93 | 27.3 | 46 / 52 | 1 / 16 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.96 | 28.4 | 42 / 46 | 17 / 19 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.4 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.96 | 28.4 | 45 / 49 | 12 / 18 | 1280x800@1 → 1000x700@1 → 1280x800 | 0 / 1 | 2.4 |  |
| invisibleWindow | true | true | true | true (1) | 0.96 | 28.4 | 44 / 48 | 3 / 16 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.1 |  |
| tinyWindow | true | true | true | true (1) | 0.96 | 28.6 | 41 / 44 | 13 / 15 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.0 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | IO / RO Hz | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 99.9 | 99.1 | 60.2 | 18 | 2.0 / 2.0 | – | – | – | 4.8 | 7.2 |  |
| detached, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.0 |  |
| detached, throttling off | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 1.2 | 1.2 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 2.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.2 | 0.6 |  |
| never-shown window, throttling off | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 1.2 | 1.2 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 100.2 | 99.2 | 1.0 | 1017 | 0.0 / 0.0 | – | – | – | 1.4 | 1.6 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 100.0 | 99.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 1.2 | 1.2 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 1.2 | 1.4 |  |
| invisible shown window, throttling off | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 1.2 | 1.2 |  |
| 1x1 shown window, throttling off | visible | 1280x800 | 100.1 | 99.1 | 60.0 | 18 | 2.0 / 2.0 | – | – | – | 4.8 | 6.8 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 99.9 | 99.1 | 60.0 | 18 | 2.0 / 2.0 | – | – | – | 4.6 | 6.6 | cover 0,0 1919x1079 over host 0,0 1x1 |
| 1x1 shown window kept above a cover window (always on top) | visible | 1280x800 | 100.2 | 99.2 | 60.0 | 18 | 2.0 / 2.0 | – | – | – | 4.4 | 6.0 | cover 0,0 1919x1079 over host 0,0 1x1 |
| invisible shown window, covered by another window | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 1.0 | 1.0 | cover -1480,-1000 1919x1079 over host -1480,-1000 1280x800 |
| 1x1 shown window, throttling on (control) | visible | 1280x800 | 100.0 | 99.2 | 60.2 | 18 | 2.0 / 2.2 | – | – | – | 4.8 | 6.4 |  |
| 1x1 shown window, throttling on, covered by another window (control) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.4 | cover 0,0 1919x1079 over host 0,0 1x1 |
| invisible shown window, throttling on, covered by another window (control) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.0 | cover -1480,-1000 1919x1079 over host -1480,-1000 1280x800 |
| osr window 30 fps, throttling off | visible | 1280x800 | 100.0 | 99.2 | 30.0 | 34 | 2.0 / 2.0 | – | – | – | 3.0 | 12.6 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 100.0 | 99.2 | 30.0 | 34 | 0.0 / 2.0 | – | – | – | 2.0 | 2.4 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 24.8 | – | 2.6 | 3.6 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 100.1 | 99.1 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 25.8 | – | 2.6 | 3.6 |  |
| detached, throttling off, playing media | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 26.0 | – | 2.4 | 3.4 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 99.9 | 98.9 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 2.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | to 1280×800 + JPEG ms | CPU ms/picture | frames/s | visibility events | geometry; errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 12 / 16 | -6 / -3 | 1000x700 | 16 / 19 | 72 | – |  | view 0,0 1000x700 in content 40,67 1000x700; page 1000x700 at 1x |
| shown | true | capturePage | 6/6 | 6 | 14 / 17 | -5 / -5 | 1000x700 | 16 / 17 | 65 | – |  | view 0,0 1000x700 in content 40,67 1000x700; page 1000x700 at 1x |
| shown | true | cdpJpeg | 6/6 | 6 | 64 / 70 | -44 / -39 | 1000x700 | – | 70 | – |  | view 0,0 1000x700 in content 40,67 1000x700; page 1000x700 at 1x |
| shown | true | frameSub | 6/6 | 6 | 15 / 16 | -4 / -3 | 1000x700 | – | 40 | – |  | view 0,0 1000x700 in content 40,67 1000x700; page 1000x700 at 1x |
| shown | true | cdpPng | 6/6 | 6 | 204 / 219 | -42 / -36 | 1000x700 | – | 243 | – |  | view 0,0 1000x700 in content 40,67 1000x700; page 1000x700 at 1x |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 80 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | – | 60 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 3 | – |  | view 0,0 1280x800 in content 320,167 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 320,167 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 4045 / 4049 | -2992 / -49 | 1280x800 | – | 122 | – |  | view 0,0 1280x800 in content 320,167 1280x800; page 1280x800 at 1x |
| hiddenWindow | false | frameSub | 6/6 | 6 | 9 / 10 | 61 / 80 | 1280x800 | – | 42 | – |  | view 0,0 1280x800 in content 320,167 1280x800; page 1280x800 at 1x |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.5 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content 320,167 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 320,167 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 97 / 98 | -57 / -28 | 1280x800 | – | 132 | – |  | view 0,0 1280x800 in content 320,167 1280x800; page 1280x800 at 1x |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 15 / 16 | 10 / 11 | 1280x800 | – | 72 | – |  | view 0,0 1280x800 in content 320,167 1280x800; page 1280x800 at 1x |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| invisibleWindow | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 80 / 84 | -38 / -28 | 1280x800 | – | 107 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | frameSub | 6/6 | 6 | 15 / 29 | 15 / 16 | 1280x800 | – | 57 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 14 / 23 | 12 / 14 | 1280x800 | – | 43 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | capturePage | 6/6 | 6 | 14 / 16 | 12 / 15 | 1280x800 | – | 50 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 78 / 88 | -38 / -34 | 1280x800 | – | 82 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | frameSub | 6/6 | 6 | 14 / 18 | 15 / 16 | 1280x800 | – | 47 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 14 / 15 | 12 / 14 | 1280x800 | – | 47 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 13 / 15 | 13 / 14 | 1280x800 | – | 52 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 79 / 86 | -40 / -35 | 1280x800 | – | 80 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 16 / 29 | 14 / 16 | 1280x800 | – | 48 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePageHidden | 6/6 | 6 | 14 / 25 | 13 / 14 | 1280x800 | – | 45 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | capturePage | 6/6 | 6 | 13 / 15 | 13 / 14 | 1280x800 | – | 52 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | cdpJpeg | 6/6 | 6 | 80 / 84 | -38 / -36 | 1280x800 | – | 83 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | frameSub | 6/6 | 6 | 14 / 15 | 16 / 17 | 1280x800 | – | 43 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 28 / 36 | 1280x800 | – | 28 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | capturePage | 6/6 | 6 | 31 / 34 | -18 / -16 | 1280x800 | – | 58 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | cdpJpeg | 6/6 | 6 | 97 / 111 | -69 / -67 | 1280x800 | – | 80 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | – | 163 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | – | 3 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 130 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 327 | pss | 589 | 4 | 0.3 |
| 1 | 354 | pss | 694 | 5 | 0.3 |
| 2 | 369 | pss | 802 | 6 | 0.0 |
| 4 | 398 | pss | 1016 | 8 | 0.3 |
| 8 | 453 | pss | 1447 | 12 | 0.8 |

Per idle tab resting in the never-shown window (a still page): **16 MiB**, 0.06% CPU. Four tabs: one partition +65 MiB, four partitions +70 MiB.

Quiet tabs working in one shared 1×1 host (no rAF loop; the page repaints twice a second): **28 MiB** and 0.91% CPU a tab (0: 351 MiB / 0.0%, 1: 391 MiB / 1.0%, 4: 470 MiB / 3.5%, 8: 575 MiB / 7.2%).

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 22.8 | 17.0 | 5.5 | 60 |
| animated, never-shown window, throttling off | 1.3 | 1.0 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.0 | 0.0 | 0.0 | 0 |
| animated, never-shown window, throttling off + frame pump | 1.0 | 1.0 | 0.0 | 0 |
| animated, invisible shown window | 1.3 | 1.3 | 0.0 | 0 |
| animated, 1x1 shown window | 22.5 | 20.7 | 1.8 | 60 |
| animated, osr 30 fps | 25.3 | 12.3 | 4.0 | 30 |

**Waking a resting tab into the host** (never-shown window, throttling on, 4 cycles): first rAF 1 / 2 ms, fresh picture 18 / 32 ms; resting rates 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0; awake rAF 60, 60, 60, 60

**One host, 4 tabs (each held at 1280×800, 1×):** tab 1 rAF 60 Hz, capturePage 4/4 in 17 / 25 ms (1280x800); tab 2 rAF 60 Hz, capturePage 4/4 in 15 / 27 ms (1280x800); tab 3 rAF 60 Hz, capturePage 4/4 in 14 / 15 ms (1280x800); tab 4 rAF 60 Hz, capturePage 4/4 in 15 / 30 ms (1280x800)

**The host's invariants:** host 100,100 1x1, focused at start false, after its page grabs focus false (focused window "S7 probe"); Windows styles –; click-through {"at":"100,100","tool":"xdotool","belowClicks":0,"hostClicks":1}; X11 {"id":"0x200156","size":"1x1","mapState":"IsViewable","overrideRedirect":"yes","shape":"No window shape defined; No border shape defined"}

**X11, the host with an empty window shape:** {"id":"0x200164","size":"1x1","mapState":"IsViewable","overrideRedirect":"yes","shape":"Window shape extents:  0x0+0+0; No border shape defined"}; rAF 60 Hz (visible), capturePage 4/4 in 13 / 14 ms (1280x800); click-through {"at":"100,100","tool":"xdotool","belowClicks":1,"hostClicks":0}; with throttling on: 1.0 Hz / rAF 0 (hidden)

**Assertions:** PASS no reload when moving from detached; PASS no reload when moving from hiddenWindow; PASS no reload when moving from hiddenWindowFit; PASS no reload when moving from invisibleWindow; PASS no reload when moving from tinyWindow; PASS the 1x1 host draws (rAF above 10 Hz); PASS a never-shown window draws nothing (rAF below 1 Hz); PASS capturePage works in the 1x1 host; PASS capturePage works in the 1x1 host with the agent's 1280x800 at 1x held; PASS the host never takes focus, even when its page asks; PASS X11: the host with an empty window shape draws and is pictured; PASS X11: a real click at the shaped host's point reaches the window below; PASS a resting tab draws within 2 s of moving into the host, every cycle; PASS every tab in one shared host draws and is pictured

**Q6 streamed view** (10 s at the viewer; latency p50 / p95 ms)

| road | content | source | fps | decoded fps | latency | gap p95 | kbit/s | bytes/frame | sender CPU % | viewer CPU % | source rAF | notes |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| screencast | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | 0 |  |
| capturePoll | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | anim | hiddenWindow | 20.8 | 20.8 | 43 / 50 | 78 | 2495 | 14994 | 66 | 16 | 60 | libvpx; video/VP8 |
| webrtc-h264 | anim | hiddenWindow | 12.6 | 12.6 | 71 / 93 | 111 | 2501 | 24813 | 67 | 10 | 60 | OpenH264; video/H264 |
| webcodecs-vp8 | anim | hiddenWindow | 30.0 | 30.0 | 33 / 36 | 36 | 2421 | 10087 | 91 | 19 | 60 |  |
| webcodecs-h264 | anim | hiddenWindow | 30.0 | 30.0 | 32 / 34 | 36 | 2406 | 10027 | 76 | 18 | 60 |  |
| screencast | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | 0 |  |
| capturePoll | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | static | hiddenWindow | 3.5 | 3.5 | 87 / 196 | 475 | 925 | 33053 | 9 | 4 | 60 | libvpx; video/VP8 |
| webrtc-h264 | static | hiddenWindow | 1.0 | 1.0 | 27 / 28 | 1001 | 17 | 2166 | 6 | 1 | 60 | OpenH264; video/H264 |
| webcodecs-vp8 | static | hiddenWindow | 3.1 | 3.1 | 18 / 103 | 501 | 204 | 8243 | 8 | 2 | 60 |  |
| webcodecs-h264 | static | hiddenWindow | 2.0 | 2.0 | 20 / 22 | 503 | 76 | 4759 | 5 | 1 | 60 |  |
| screencast | anim | invisibleWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | 0 |  |
| capturePoll | anim | invisibleWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 | toJPEG 0.0 ms |
| webcodecs-h264 | anim | invisibleWindow | 30.0 | 30.0 | 51 / 54 | 36 | 2408 | 10032 | 102 | 19 | 60 |  |
| screencast | anim | tinyWindow | 60.0 | 60.0 | 42 / 44 | 19 | 66210 | 137707 | 157 | 43 | 60 |  |
| webcodecs-h264 | anim | tinyWindow | 30.0 | 30.0 | 34 / 37 | 36 | 2404 | 10018 | 93 | 19 | 60 |  |
| screencast | anim | shown | 60.0 | 60.0 | 35 / 37 | 18 | 55014 | 114613 | 115 | 32 | 60 |  |
| webrtc-vp8 | anim | shown | 20.2 | 20.2 | 50 / 59 | 79 | 2499 | 15467 | 101 | 17 | 60 | libvpx; video/VP8 |
| webcodecs-h264 | anim | shown | 30.0 | 30.0 | 41 / 43 | 36 | 2450 | 10209 | 110 | 20 | 60 |  |

### Electron · linux-x64-ozone-headless (electron-linux-x64-ozone-headless.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone headless, displays 1920x1080@1, status **done**, 572 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.92 | 27.3 | 31 / 85 | 1 / 5 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.95 | 28.4 | 30 / 43 | 10 / 12 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.4 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.95 | 28.4 | 34 / 38 | 4 / 15 | 1280x800@1 → 1000x700@1 → 1280x800 | 0 / 1 | 2.3 |  |
| invisibleWindow | true | true | true | true (1) | 0.96 | 28.6 | 27 / 32 | 7 / 11 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.0 |  |
| tinyWindow | true | true | true | true (1) | 0.96 | 28.6 | 28 / 30 | 9 / 9 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.0 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | IO / RO Hz | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 100.0 | 99.4 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 2.4 | 3.4 |  |
| detached, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.0 |  |
| detached, throttling off | visible | 1280x800 | 100.0 | 99.4 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.6 | 0.8 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.2 |  |
| never-shown window, throttling off | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.6 | 0.6 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 99.9 | 99.3 | 1.0 | 1017 | 0.0 / 0.0 | – | – | – | 0.8 | 0.8 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 99.9 | 99.3 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 0.8 | 0.8 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 0.6 | 0.8 |  |
| invisible shown window, throttling off | visible | 1280x800 | 100.0 | 99.4 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 2.6 | 3.4 |  |
| 1x1 shown window, throttling off | visible | 1280x800 | 100.0 | 99.2 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 2.4 | 2.8 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 100.0 | 99.4 | 60.0 | 17 | 2.2 / 2.2 | – | – | – | 2.6 | 3.2 | cover 0,0 1920x1080 over host 0,0 1x1 |
| 1x1 shown window kept above a cover window (always on top) | visible | 1280x800 | 99.9 | 99.3 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 2.2 | 2.8 | cover 0,0 1920x1080 over host 0,0 1x1 |
| invisible shown window, covered by another window | visible | 1280x800 | 100.2 | 99.4 | 60.0 | 17 | 1.8 / 1.8 | – | – | – | 2.2 | 3.4 | cover -1480,-1000 1920x1080 over host -1480,-1000 1280x800 |
| 1x1 shown window, throttling on (control) | visible | 1280x800 | 100.1 | 99.1 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 2.4 | 3.2 |  |
| 1x1 shown window, throttling on, covered by another window (control) | visible | 1280x800 | 100.0 | 99.4 | 60.0 | 17 | 1.8 / 1.8 | – | – | – | 2.6 | 3.2 | cover 0,0 1920x1080 over host 0,0 1x1 |
| invisible shown window, throttling on, covered by another window (control) | visible | 1280x800 | 100.0 | 99.4 | 60.0 | 17 | 2.0 / 2.0 | – | – | – | 2.4 | 3.2 | cover -1480,-1000 1920x1080 over host -1480,-1000 1280x800 |
| osr window 30 fps, throttling off | visible | 1280x800 | 100.0 | 99.2 | 30.0 | 34 | 2.0 / 2.0 | – | – | – | 1.8 | 8.6 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 100.1 | 99.1 | 30.2 | 34 | 0.0 / 2.2 | – | – | – | 1.0 | 1.2 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 100.0 | 99.4 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 25.8 | – | 1.4 | 2.0 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 100.0 | 99.4 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 25.8 | – | 1.2 | 1.6 |  |
| detached, throttling off, playing media | visible | 1280x800 | 100.0 | 99.4 | 0.0 | 0 | 0.0 / 0.0 | 0.85 | 25.8 | – | 1.2 | 1.4 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 2.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | to 1280×800 + JPEG ms | CPU ms/picture | frames/s | visibility events | geometry; errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 20 / 21 | -14 / 1 | 1000x700 | 11 / 13 | 40 | – |  | view 0,0 1000x700 in content 40,65 1000x700; page 1000x700 at 1x |
| shown | true | capturePage | 6/6 | 6 | 20 / 22 | -15 / -13 | 1000x700 | 11 / 12 | 40 | – |  | view 0,0 1000x700 in content 40,65 1000x700; page 1000x700 at 1x |
| shown | true | cdpJpeg | 6/6 | 6 | 49 / 62 | -35 / -34 | 1000x700 | – | 35 | – |  | view 0,0 1000x700 in content 40,65 1000x700; page 1000x700 at 1x |
| shown | true | frameSub | 6/6 | 6 | 15 / 22 | -8 / -7 | 1000x700 | – | 25 | – |  | view 0,0 1000x700 in content 40,65 1000x700; page 1000x700 at 1x |
| shown | true | cdpPng | 6/6 | 6 | 156 / 160 | -40 / -34 | 1000x700 | – | 150 | – |  | view 0,0 1000x700 in content 40,65 1000x700; page 1000x700 at 1x |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 40 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | – | 25 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 4045 / 4049 | -2998 / -38 | 1280x800 | – | 78 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x |
| hiddenWindow | false | frameSub | 6/6 | 6 | 7 / 7 | 62 / 70 | 1280x800 | – | 23 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.5 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 80 / 83 | -49 / -33 | 1280x800 | – | 77 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 15 / 21 | 8 / 9 | 1280x800 | – | 48 | – |  | view 0,0 1280x800 in content 320,165 1280x800; page 1280x800 at 1x |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 6/6 | 6 | 15 / 16 | -7 / -6 | 1280x800 | – | 30 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | capturePage | 6/6 | 6 | 14 / 15 | -7 / -6 | 1280x800 | – | 30 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 63 / 68 | -46 / -38 | 1280x800 | – | 53 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | frameSub | 6/6 | 6 | 15 / 21 | -4 / -3 | 1280x800 | – | 32 | – |  | view 0,0 1280x800 in content -1480,-1000 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 14 / 15 | -6 / -2 | 1280x800 | – | 28 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | capturePage | 6/6 | 6 | 14 / 15 | -6 / -5 | 1280x800 | – | 25 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 64 / 65 | -46 / -40 | 1280x800 | – | 43 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | frameSub | 6/6 | 6 | 15 / 22 | -5 / -4 | 1280x800 | – | 27 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 15 / 22 | -7 / -5 | 1280x800 | – | 25 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 14 / 15 | -7 / -6 | 1280x800 | – | 25 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 64 / 69 | -46 / -39 | 1280x800 | – | 45 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 15 / 22 | -5 / -4 | 1280x800 | – | 23 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.5 |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePageHidden | 6/6 | 6 | 14 / 22 | 9 / 10 | 1280x800 | – | 27 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | capturePage | 6/6 | 6 | 15 / 15 | 9 / 12 | 1280x800 | – | 23 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | cdpJpeg | 6/6 | 6 | 81 / 87 | -47 / -40 | 1280x800 | – | 48 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | frameSub | 6/6 | 6 | 15 / 22 | 11 / 12 | 1280x800 | – | 23 | – |  | view 0,0 1280x800 in content 0,0 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 11 / 16 | 1280x800 | – | 18 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | capturePage | 6/6 | 6 | 31 / 38 | -22 / -13 | 1280x800 | – | 35 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | cdpJpeg | 6/6 | 6 | 98 / 101 | -79 / -77 | 1280x800 | – | 55 | – |  | view - in content 320,140 1280x800; page 1280x800 at 1x |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | – | 83 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | – | 0 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 70 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 243 | pss | 498 | 4 | 0.0 |
| 1 | 272 | pss | 603 | 5 | 0.3 |
| 2 | 287 | pss | 711 | 6 | 0.0 |
| 4 | 317 | pss | 927 | 8 | 0.0 |
| 8 | 371 | pss | 1356 | 12 | 0.3 |

Per idle tab resting in the never-shown window (a still page): **16 MiB**, 0.03% CPU. Four tabs: one partition +66 MiB, four partitions +71 MiB.

Quiet tabs working in one shared 1×1 host (no rAF loop; the page repaints twice a second): **28 MiB** and 0.66% CPU a tab (0: 268 MiB / 0.0%, 1: 310 MiB / 1.5%, 4: 388 MiB / 2.8%, 8: 493 MiB / 5.3%).

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 12.0 | 8.5 | 3.5 | 60 |
| animated, never-shown window, throttling off | 1.3 | 0.8 | 0.3 | 0 |
| animated, never-shown window, throttling on | 0.3 | 0.0 | 0.3 | 0 |
| animated, never-shown window, throttling off + frame pump | 1.0 | 0.8 | 0.0 | 0 |
| animated, invisible shown window | 15.8 | 10.0 | 5.5 | 60 |
| animated, 1x1 shown window | 10.5 | 9.3 | 1.0 | 60 |
| animated, osr 30 fps | 17.5 | 6.5 | 3.8 | 30 |

**Waking a resting tab into the host** (never-shown window, throttling on, 4 cycles): first rAF 0 / 2 ms, fresh picture 13 / 33 ms; resting rates 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0, 1.0 Hz / rAF 0.0; awake rAF 60, 60, 60, 60

**One host, 4 tabs (each held at 1280×800, 1×):** tab 1 rAF 60 Hz, capturePage 4/4 in 14 / 15 ms (1280x800); tab 2 rAF 60 Hz, capturePage 4/4 in 14 / 15 ms (1280x800); tab 3 rAF 60 Hz, capturePage 4/4 in 14 / 15 ms (1280x800); tab 4 rAF 60 Hz, capturePage 4/4 in 15 / 18 ms (1280x800)

**The host's invariants:** host 100,100 1x1, focused at start false, after its page grabs focus false (focused window "S7 browser view"); Windows styles –; click-through not testable here (macOS needs Accessibility for synthetic clicks; Wayland and no display have no global input)

**Assertions:** PASS no reload when moving from detached; PASS no reload when moving from hiddenWindow; PASS no reload when moving from hiddenWindowFit; PASS no reload when moving from invisibleWindow; PASS no reload when moving from tinyWindow; PASS the 1x1 host draws (rAF above 10 Hz); PASS a never-shown window draws nothing (rAF below 1 Hz); PASS capturePage works in the 1x1 host; PASS capturePage works in the 1x1 host with the agent's 1280x800 at 1x held; PASS the host never takes focus, even when its page asks; PASS a resting tab draws within 2 s of moving into the host, every cycle; PASS every tab in one shared host draws and is pictured

### Electron · macos-dsf2 (electron-macos-dsf2.json)

Electron 45.2.2 (Chromium 156.0.8078.80), darwin-arm64 25.6.0, ozone (default), displays 1024x768@2, status **done**, 271 s

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | to 1280×800 + JPEG ms | CPU ms/picture | frames/s | visibility events | geometry; errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 30 / 62 | 8 / 14 | 2000x1400 | 22 / 26 | 88 | – |  | view 0,0 1000x700 in content 24,63 1000x645; page 1000x700 at 2x |
| shown | true | capturePage | 6/6 | 6 | 28 / 38 | 7 / 14 | 2000x1400 | 17 / 21 | 69 | – |  | view 0,0 1000x700 in content 24,63 1000x645; page 1000x700 at 2x |
| shown | true | cdpJpeg | 6/6 | 6 | 110 / 118 | -49 / -40 | 2000x1400 | – | 93 | – |  | view 0,0 1000x700 in content 24,63 1000x645; page 1000x700 at 2x |
| shown | true | frameSub | 6/6 | 6 | 23 / 34 | 7 / 18 | 2000x1400 | – | 45 | – |  | view 0,0 1000x700 in content 24,63 1000x645; page 1000x700 at 2x |
| shown | true | cdpPng | 6/6 | 6 | 317 / 367 | -42 / -37 | 2000x1400 | – | 349 | – |  | view 0,0 1000x700 in content 24,63 1000x645; page 1000x700 at 2x |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 16 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 2x; Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | – | 17 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 2x; Current display surface not available for capture |
| detached | false | cdpJpeg | 1/3 | 1 | 169 / 169 | -57 / -57 | 2560x1600 | – | 226 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 2x; Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | – | 277 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 2x; frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 13 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | – | 18 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 135 / 161 | -60 / -31 | 2560x1600 | – | 129 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 2x |
| hiddenWindow | false | frameSub | 6/6 | 6 | 23 / 35 | 5 / 18 | 2560x1600 | – | 38 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 2x |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 15 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | – | 14 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 131 / 224 | -44 / -23 | 2560x1600 | – | 290 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 2x |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 21 / 48 | 8 / 22 | 2560x1600 | – | 85 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 2x |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 6/6 | 6 | 25 / 52 | 7 / 13 | 2560x1600 | 19 / 26 | 84 | – |  | view 0,0 1280x800 in content 0,31 1280x800; page 1280x800 at 2x |
| invisibleWindow | false | capturePage | 6/6 | 6 | 25 / 51 | 10 / 14 | 2560x1600 | 17 / 25 | 87 | – |  | view 0,0 1280x800 in content 0,31 1280x800; page 1280x800 at 2x |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 114 / 138 | -49 / -40 | 2560x1600 | – | 119 | – |  | view 0,0 1280x800 in content 0,31 1280x800; page 1280x800 at 2x |
| invisibleWindow | false | frameSub | 6/6 | 6 | 31 / 53 | 7 / 20 | 2560x1600 | – | 82 | – |  | view 0,0 1280x800 in content 0,31 1280x800; page 1280x800 at 2x |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 30 / 43 | -8 / -1 | 2560x1600 | 14 / 24 | 91 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 2x |
| tinyWindow | false | capturePage | 6/6 | 6 | 25 / 32 | -2 / 0 | 2560x1600 | 18 / 26 | 93 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 2x |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 94 / 103 | -45 / -37 | 2560x1600 | – | 98 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 2x |
| tinyWindow | false | frameSub | 6/6 | 6 | 27 / 36 | -4 / 0 | 2560x1600 | – | 65 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 2x |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 29.5 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 25 / 48 | 12 / 15 | 2560x1600 | 18 / 21 | 88 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 2x |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 28 / 39 | 6 / 14 | 2560x1600 | 16 / 28 | 93 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 2x |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 124 / 143 | -51 / -36 | 2560x1600 | – | 124 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 2x |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 44 / 47 | 3 / 23 | 2560x1600 | – | 82 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 2x |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePageHidden | 6/6 | 6 | 22 / 62 | 9 / 19 | 2560x1600 | 20 / 24 | 83 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | capturePage | 6/6 | 6 | 29 / 35 | 6 / 15 | 2560x1600 | 16 / 22 | 71 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | cdpJpeg | 6/6 | 6 | 85 / 222 | -47 / -21 | 1280x800 | – | 100 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | frameSub | 6/6 | 6 | 31 / 56 | -5 / 0 | 2560x1600 | – | 73 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 1 | 78 / 174 | 1280x800 | – | 20 | – |  | view - in content 0,-33 1280x800; page 1280x800 at 1x |
| osr | false | capturePage | 6/6 | 6 | 14 / 96 | 76 / 114 | 1280x800 | – | 22 | – |  | view - in content 0,-33 1280x800; page 1280x800 at 1x |
| osr | false | cdpJpeg | 6/6 | 6 | 190 / 471 | -193 / -107 | 1280x800 | – | 107 | – |  | view - in content 0,-33 1280x800; page 1280x800 at 1x |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | – | 14.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | – | 579 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | – | 9 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 493 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 153 | footprint | 334 | 3 | 0.3 |
| 1 | 175 | footprint | 426 | 4 | 0.6 |
| 2 | 195 | footprint | 520 | 5 | 1.1 |
| 4 | 237 | footprint | 707 | 7 | 1.8 |
| 8 | 319 | footprint | 1081 | 11 | 3.0 |

Per idle tab resting in the never-shown window (a still page): **21 MiB**, 0.34% CPU. Four tabs: one partition +78 MiB, four partitions +83 MiB.

Quiet tabs working in one shared 1×1 host (no rAF loop; the page repaints twice a second): **67 MiB** and 2.19% CPU a tab (0: 179 MiB / 0.4%, 1: 270 MiB / 3.0%, 4: 465 MiB / 8.8%, 8: 712 MiB / 17.9%).

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 30.4 | 10.3 | 19.6 | 60 |
| animated, never-shown window, throttling off | 13.2 | 4.0 | 8.7 | 0 |
| animated, never-shown window, throttling on | 0.7 | 0.1 | 0.4 | 0 |
| animated, never-shown window, throttling off + frame pump | 11.0 | 3.4 | 7.3 | 0 |
| animated, invisible shown window | 42.8 | 14.0 | 28.4 | 60 |
| animated, 1x1 shown window | 35.2 | 11.8 | 23.1 | 60 |
| animated, osr 30 fps | 22.2 | 4.7 | 12.1 | 13 |

**One host, 4 tabs (each held at 1280×800, 1×):** tab 1 rAF 60 Hz, capturePage 4/4 in 27 / 31 ms (2560x1600); tab 2 rAF 60 Hz, capturePage 4/4 in 40 / 160 ms (2560x1600); tab 3 rAF 60 Hz, capturePage 4/4 in 17 / 29 ms (2560x1600); tab 4 rAF 60 Hz, capturePage 4/4 in 24 / 33 ms (2560x1600)

**Assertions:** PASS capturePage works in the 1x1 host with the agent's 1280x800 at 1x held; PASS every tab in one shared host draws and is pictured

### Electron · macos (electron-macos.json)

Electron 45.2.2 (Chromium 156.0.8078.80), darwin-arm64 25.6.0, ozone (default), displays 1024x768@1, status **done**, 866 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.95 | 28.5 | 85 / 926 | 26 / 277 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.97 | 29.0 | 74 / 153 | 24 / 32 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.0 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.96 | 28.7 | 52 / 87 | 10 / 19 | 1280x800@1 → 1000x700@1 → 1280x800 | 2 / 3 | 1.6 |  |
| invisibleWindow | true | true | true | true (1) | 0.97 | 29.0 | 41 / 90 | 4 / 6 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 59.9 |  |
| tinyWindow | true | true | true | true (1) | 0.97 | 29.0 | 54 / 59 | 6 / 7 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 59.9 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | IO / RO Hz | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 79.7 | 61.5 | 60.0 | 20 | 2.2 / 2.2 | – | – | – | 5.9 | 16.2 |  |
| detached, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.1 | 0.7 |  |
| detached, throttling off | visible | 1280x800 | 100.1 | 74.3 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 4.3 | 11.7 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 1.2 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.2 | 0.8 |  |
| never-shown window, throttling off | visible | 1280x800 | 85.6 | 67.1 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 2.3 | 5.5 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 67.9 | 60.3 | 59.9 | 24 | 2.0 / 2.0 | – | – | – | 10.5 | 29.3 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 97.1 | 69.1 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 3.7 | 12.0 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 99.4 | 73.3 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 3.5 | 10.9 |  |
| invisible shown window, throttling off | visible | 1280x800 | 69.5 | 60.1 | 59.9 | 27 | 2.0 / 2.0 | – | – | – | 14.2 | 38.6 |  |
| 1x1 shown window, throttling off | visible | 1280x800 | 73.5 | 59.9 | 59.9 | 30 | 2.0 / 2.0 | – | – | – | 10.9 | 30.9 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 70.5 | 60.1 | 59.9 | 23 | 2.0 / 2.0 | – | – | – | 6.5 | 17.7 | cover 0,0 1024x768 over host 0,31 1x1 |
| 1x1 shown window kept above a cover window (always on top) | visible | 1280x800 | 68.9 | 57.3 | 59.1 | 67 | 2.0 / 2.0 | – | – | – | 7.2 | 19.6 | cover 0,0 1024x768 over host 0,31 1x1 |
| invisible shown window, covered by another window | visible | 1280x800 | 68.9 | 60.3 | 60.1 | 24 | 2.0 / 2.0 | – | – | – | 12.3 | 35.5 | cover 0,0 1280x831 over host 0,31 1280x800 |
| 1x1 shown window, throttling on (control) | visible | 1280x800 | 71.7 | 60.5 | 59.9 | 24 | 2.0 / 2.0 | – | – | – | 9.3 | 26.4 |  |
| 1x1 shown window, throttling on, covered by another window (control) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.1 | 0.6 | cover 0,0 1024x768 over host 0,31 1x1 |
| invisible shown window, throttling on, covered by another window (control) | hidden | 1280x800 | 1.4 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.1 | 0.7 | cover 0,0 1280x831 over host 0,31 1280x800 |
| osr window 30 fps, throttling off | visible | 1280x800 | 40.1 | 33.4 | 14.4 | 180 | 2.0 / 2.0 | – | – | – | 3.5 | 17.1 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 37.1 | 32.3 | 13.6 | 182 | 0.0 / 2.0 | – | – | – | 3.2 | 8.8 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 40.4 | 34.2 | 0.0 | 0 | 0.0 / 0.0 | 0.90 | 27.4 | – | 3.5 | 7.4 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 39.1 | 30.8 | 0.0 | 0 | 0.0 / 0.0 | 0.90 | 24.8 | – | 5.3 | 10.9 |  |
| detached, throttling off, playing media | visible | 1280x800 | 33.4 | 26.2 | 0.0 | 0 | 0.0 / 0.0 | 0.89 | 27.8 | – | 4.8 | 9.9 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 99.8 | 71.1 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | to 1280×800 + JPEG ms | CPU ms/picture | frames/s | visibility events | geometry; errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 24 / 36 | 7 / 12 | 1000x700 | 12 / 19 | 56 | – |  | view 0,0 1000x700 in content 24,63 1000x645; page 1000x700 at 1x |
| shown | true | capturePage | 6/6 | 6 | 19 / 31 | 5 / 18 | 1000x700 | 9 / 15 | 46 | – |  | view 0,0 1000x700 in content 24,63 1000x645; page 1000x700 at 1x |
| shown | true | cdpJpeg | 6/6 | 6 | 80 / 93 | -41 / -34 | 1000x700 | – | 53 | – |  | view 0,0 1000x700 in content 24,63 1000x645; page 1000x700 at 1x |
| shown | true | frameSub | 6/6 | 6 | 21 / 37 | 11 / 16 | 1000x700 | – | 54 | – |  | view 0,0 1000x700 in content 24,63 1000x645; page 1000x700 at 1x |
| shown | true | cdpPng | 6/6 | 6 | 196 / 206 | -42 / -35 | 1000x700 | – | 181 | – |  | view 0,0 1000x700 in content 24,63 1000x645; page 1000x700 at 1x |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 10 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | – | 6 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | cdpJpeg | 1/3 | 1 | 80 / 80 | -53 / -53 | 1280x800 | – | 169 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | – | 183 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 13 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | – | 12 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 113 / 130 | -45 / -35 | 1280x800 | – | 132 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 1x |
| hiddenWindow | false | frameSub | 6/6 | 6 | 25 / 37 | 21 / 37 | 1280x800 | – | 59 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 1x |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 16 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | – | 16 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 89 / 119 | -62 / -39 | 1280x800 | – | 119 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 1x |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 19 / 38 | 4 / 13 | 1280x800 | – | 47 | – |  | view 0,0 1280x800 in content 0,63 1280x800; page 1280x800 at 1x |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 29.5 |  |  |
| invisibleWindow | false | capturePageHidden | 6/6 | 6 | 27 / 33 | -11 / -7 | 1280x800 | – | 69 | – |  | view 0,0 1280x800 in content 0,31 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | capturePage | 6/6 | 6 | 19 / 38 | -7 / 1 | 1280x800 | – | 42 | – |  | view 0,0 1280x800 in content 0,31 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 78 / 102 | -48 / -37 | 1280x800 | – | 48 | – |  | view 0,0 1280x800 in content 0,31 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | frameSub | 6/6 | 6 | 27 / 36 | 6 / 18 | 1280x800 | – | 41 | – |  | view 0,0 1280x800 in content 0,31 1280x800; page 1280x800 at 1x |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.5 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 21 / 38 | -6 / 0 | 1280x800 | – | 66 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow | false | capturePage | 6/6 | 6 | 26 / 40 | -10 / 0 | 1280x800 | – | 77 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 81 / 99 | -53 / -39 | 1280x800 | – | 106 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow | false | frameSub | 6/6 | 6 | 29 / 36 | -11 / 0 | 1280x800 | – | 77 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 25 / 31 | -10 / 0 | 1280x800 | – | 74 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 27 / 34 | -12 / -6 | 1280x800 | – | 77 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 60 / 95 | -49 / -37 | 1280x800 | – | 63 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 18 / 30 | -6 / 0 | 1280x800 | – | 37 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePageHidden | 6/6 | 6 | 26 / 50 | 8 / 17 | 1280x800 | – | 90 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | capturePage | 6/6 | 6 | 23 / 35 | 7 / 15 | 1280x800 | – | 75 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | cdpJpeg | 6/6 | 6 | 103 / 116 | -48 / -43 | 1280x800 | – | 127 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | frameSub | 6/6 | 6 | 27 / 41 | 9 / 13 | 1280x800 | – | 77 | – |  | view 0,0 1280x800 in content 0,31 1x1; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 41 / 162 | 1280x800 | – | 29 | – |  | view - in content 0,-33 1280x800; page 1280x800 at 1x |
| osr | false | capturePage | 6/6 | 6 | 13 / 164 | 12 / 116 | 1280x800 | – | 44 | – |  | view - in content 0,-33 1280x800; page 1280x800 at 1x |
| osr | false | cdpJpeg | 6/6 | 6 | 361 / 458 | -254 / -74 | 1280x800 | – | 97 | – |  | view - in content 0,-33 1280x800; page 1280x800 at 1x |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | – | 15.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | – | 557 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | – | 10 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 523 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 150 | footprint | 364 | 4 | 0.1 |
| 1 | 171 | footprint | 456 | 5 | 0.7 |
| 2 | 190 | footprint | 549 | 6 | 1.0 |
| 4 | 232 | footprint | 735 | 8 | 2.3 |
| 8 | 313 | footprint | 1108 | 12 | 3.8 |

Per idle tab resting in the never-shown window (a still page): **20 MiB**, 0.46% CPU. Four tabs: one partition +74 MiB, four partitions +83 MiB.

Quiet tabs working in one shared 1×1 host (no rAF loop; the page repaints twice a second): **35 MiB** and 2.42% CPU a tab (0: 175 MiB / 0.4%, 1: 224 MiB / 3.6%, 4: 323 MiB / 8.7%, 8: 453 MiB / 19.8%).

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 26.6 | 9.3 | 16.6 | 60 |
| animated, never-shown window, throttling off | 12.0 | 3.7 | 7.7 | 0 |
| animated, never-shown window, throttling on | 0.9 | 0.1 | 0.5 | 0 |
| animated, never-shown window, throttling off + frame pump | 13.7 | 3.9 | 9.6 | 0 |
| animated, invisible shown window | 44.3 | 14.2 | 29.8 | 60 |
| animated, 1x1 shown window | 21.8 | 7.7 | 13.9 | 60 |
| animated, osr 30 fps | 25.2 | 5.4 | 13.7 | 16 |

**Waking a resting tab into the host** (never-shown window, throttling on, 4 cycles): first rAF 10 / 31 ms, fresh picture 60 / 137 ms; resting rates 1.1 Hz / rAF 0.0, 1.1 Hz / rAF 0.0, 1.1 Hz / rAF 0.0, 1.2 Hz / rAF 0.0; awake rAF 60, 60, 60, 59

**One host, 4 tabs (each held at 1280×800, 1×):** tab 1 rAF 60 Hz, capturePage 4/4 in 17 / 36 ms (1280x800); tab 2 rAF 60 Hz, capturePage 4/4 in 11 / 25 ms (1280x800); tab 3 rAF 60 Hz, capturePage 4/4 in 21 / 38 ms (1280x800); tab 4 rAF 60 Hz, capturePage 4/4 in 13 / 27 ms (1280x800)

**The host's invariants:** host 100,131 1x1, focused at start false, after its page grabs focus false (focused window "S7 probe"); Windows styles –; click-through not testable here (macOS needs Accessibility for synthetic clicks; Wayland and no display have no global input)

**Assertions:** PASS no reload when moving from detached; PASS no reload when moving from hiddenWindow; PASS no reload when moving from hiddenWindowFit; PASS no reload when moving from invisibleWindow; PASS no reload when moving from tinyWindow; PASS the 1x1 host draws (rAF above 10 Hz); PASS a never-shown window draws nothing (rAF below 1 Hz); PASS capturePage works in the 1x1 host; PASS capturePage works in the 1x1 host with the agent's 1280x800 at 1x held; PASS the host never takes focus, even when its page asks; PASS a resting tab draws within 2 s of moving into the host, every cycle; PASS every tab in one shared host draws and is pictured

**Q6 streamed view** (10 s at the viewer; latency p50 / p95 ms)

| road | content | source | fps | decoded fps | latency | gap p95 | kbit/s | bytes/frame | sender CPU % | viewer CPU % | source rAF | notes |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| screencast | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 13 | 0 | 0 |  |
| capturePoll | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 12 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | anim | hiddenWindow | 2.7 | 2.7 | 307 / 449 | 526 | 463 | 21429 | 57 | 4 | 60 | libvpx; video/VP8 |
| webrtc-h264 | anim | hiddenWindow | 13.9 | 13.9 | 128 / 164 | 118 | 2482 | 22318 | 78 | 14 | 60 | OpenH264; video/H264 |
| webcodecs-vp8 | anim | hiddenWindow | 30.1 | 30.1 | 47 / 67 | 48 | 2258 | 9378 | 105 | 22 | 60 |  |
| webcodecs-h264 | anim | hiddenWindow | 30.1 | 30.1 | 52 / 70 | 53 | 2275 | 9447 | 119 | 22 | 60 |  |
| screencast | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 |  |
| capturePoll | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | static | hiddenWindow | 2.1 | 2.1 | 242 / 370 | 643 | 100 | 5929 | 11 | 3 | 42 | libvpx; video/VP8 |
| webrtc-h264 | static | hiddenWindow | 1.1 | 1.1 | 97 / 1365 | 1246 | 23 | 2570 | 13 | 2 | 43 | OpenH264; video/H264 |
| webcodecs-vp8 | static | hiddenWindow | 2.0 | 2.0 | 59 / 73 | 531 | 100 | 6236 | 11 | 2 | 40 |  |
| webcodecs-h264 | static | hiddenWindow | 2.2 | 2.2 | 50 / 109 | 538 | 10 | 541 | 10 | 1 | 41 |  |
| screencast | anim | invisibleWindow | 60.0 | 60.0 | 39 / 52 | 33 | 58269 | 121394 | 96 | 29 | 60 |  |
| capturePoll | anim | invisibleWindow | 24.0 | 24.0 | 49 / 57 | 53 | 23533 | 122057 | 69 | 15 | 60 | toJPEG 7.1 ms |
| webcodecs-h264 | anim | invisibleWindow | 30.0 | 30.0 | 61 / 79 | 51 | 2246 | 9327 | 114 | 18 | 60 |  |
| screencast | anim | tinyWindow | 60.0 | 60.0 | 37 / 49 | 34 | 58486 | 121642 | 82 | 25 | 60 |  |
| webcodecs-h264 | anim | tinyWindow | 30.0 | 30.0 | 43 / 57 | 50 | 2230 | 9293 | 90 | 16 | 60 |  |
| screencast | anim | shown | 59.9 | 59.9 | 40 / 44 | 27 | 48860 | 101791 | 63 | 19 | 60 |  |
| webrtc-vp8 | anim | shown | 3.2 | 3.2 | 253 / 433 | 442 | 500 | 19550 | 43 | 3 | 60 | libvpx; video/VP8 |
| webcodecs-h264 | anim | shown | 30.1 | 30.1 | 45 / 51 | 45 | 2125 | 8825 | 93 | 13 | 60 |  |

### Electron · windows-dsf2 (electron-windows-dsf2.json)

Electron 45.2.2 (Chromium 156.0.8078.80), win32-x64 10.0.26100, ozone (default), displays 256x192@2, status **done**, 302 s

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | to 1280×800 + JPEG ms | CPU ms/picture | frames/s | visibility events | geometry; errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 28 / 47 | 23 / 30 | 2000x1400 | 20 / 24 | 312 | – |  | view 0,0 1000x700 in content 44,82 504x342; page 1000x700 at 2x |
| shown | true | capturePage | 6/6 | 6 | 28 / 40 | 27 / 31 | 2000x1400 | 22 / 24 | 153 | – |  | view 0,0 1000x700 in content 44,82 504x342; page 1000x700 at 2x |
| shown | true | cdpJpeg | 6/6 | 6 | 132 / 137 | -40 / -35 | 2000x1400 | – | 204 | – |  | view 0,0 1000x700 in content 44,82 504x342; page 1000x700 at 2x |
| shown | true | frameSub | 6/6 | 6 | 54 / 55 | 19 / 28 | 2000x1400 | – | 141 | – |  | view 0,0 1000x700 in content 44,82 504x342; page 1000x700 at 2x |
| shown | true | cdpPng | 6/6 | 6 | 390 / 415 | -42 / -35 | 2000x1400 | – | 606 | – |  | view 0,0 1000x700 in content 44,82 504x342; page 1000x700 at 2x |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 29.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 89 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | – | 99 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 4,42 504x342; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 4,42 504x342; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 3971 / 4982 | -2879 / -45 | 2560x1600 | – | 208 | – |  | view 0,0 1280x800 in content 4,42 504x342; page 1280x800 at 2x |
| hiddenWindow | false | frameSub | 6/6 | 6 | 41 / 41 | 54 / 136 | 2560x1600 | – | 109 | – |  | view 0,0 1280x800 in content 4,42 504x342; page 1280x800 at 2x |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 4,42 504x342; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 4,42 504x342; page 1280x800 at 2x; Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 195 / 270 | -84 / -18 | 2560x1600 | – | 537 | – |  | view 0,0 1280x800 in content 4,42 504x342; page 1280x800 at 2x |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 65 / 88 | 8 / 19 | 2560x1600 | – | 234 | – |  | view 0,0 1280x800 in content 4,42 504x342; page 1280x800 at 2x |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 29.0 |  |  |
| invisibleWindow | false | capturePageHidden | 6/6 | 6 | 48 / 52 | 20 / 29 | 2560x1600 | 25 / 30 | 205 | – |  | view 0,0 1280x800 in content 1,0 511x362; page 1280x800 at 2x |
| invisibleWindow | false | capturePage | 6/6 | 6 | 38 / 47 | 29 / 31 | 2560x1600 | 24 / 33 | 200 | – |  | view 0,0 1280x800 in content 1,0 511x362; page 1280x800 at 2x |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 152 / 161 | -42 / -35 | 2560x1600 | – | 268 | – |  | view 0,0 1280x800 in content 1,0 511x362; page 1280x800 at 2x |
| invisibleWindow | false | frameSub | 6/6 | 6 | 71 / 72 | 7 / 10 | 2560x1600 | – | 183 | – |  | view 0,0 1280x800 in content 1,0 511x362; page 1280x800 at 2x |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 21.5 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 48 / 53 | 5 / 15 | 2560x1600 | 22 / 28 | 165 | – |  | view 0,0 1280x800 in content 1,0 31x35; page 1280x800 at 2x |
| tinyWindow | false | capturePage | 6/6 | 6 | 49 / 54 | 2 / 14 | 2560x1600 | 24 / 29 | 173 | – |  | view 0,0 1280x800 in content 1,0 31x35; page 1280x800 at 2x |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 144 / 151 | -45 / -34 | 2560x1600 | – | 201 | – |  | view 0,0 1280x800 in content 1,0 31x35; page 1280x800 at 2x |
| tinyWindow | false | frameSub | 6/6 | 6 | 68 / 72 | 6 / 9 | 2560x1600 | – | 156 | – |  | view 0,0 1280x800 in content 1,0 31x35; page 1280x800 at 2x |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 22.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 46 / 49 | 11 / 44 | 2560x1600 | 24 / 28 | 162 | – |  | view 0,0 1280x800 in content 1,0 31x35; page 1280x800 at 2x |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 41 / 52 | 11 / 14 | 2560x1600 | 22 / 30 | 164 | – |  | view 0,0 1280x800 in content 1,0 31x35; page 1280x800 at 2x |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 152 / 167 | -46 / -33 | 2560x1600 | – | 205 | – |  | view 0,0 1280x800 in content 1,0 31x35; page 1280x800 at 2x |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 68 / 70 | 6 / 7 | 2560x1600 | – | 156 | – |  | view 0,0 1280x800 in content 1,0 31x35; page 1280x800 at 2x |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 22.0 |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePageHidden | 6/6 | 6 | 45 / 52 | 14 / 29 | 2560x1600 | 23 / 28 | 163 | – |  | view 0,0 1280x800 in content 1,0 31x35; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | capturePage | 6/6 | 6 | 43 / 51 | 4 / 16 | 2560x1600 | 22 / 28 | 161 | – |  | view 0,0 1280x800 in content 1,0 31x35; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | cdpJpeg | 6/6 | 6 | 72 / 90 | -46 / -45 | 1280x800 | – | 114 | – |  | view 0,0 1280x800 in content 1,0 31x35; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | frameSub | 6/6 | 6 | 68 / 76 | 7 / 11 | 2560x1600 | – | 157 | – |  | view 0,0 1280x800 in content 1,0 31x35; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 22.0 |  |  |
| osr | false | osrPaint | 6/6 | 0 | 0 / 0 | – | 512x360 | – | 11 | – |  | view - in content 1,0 511x360; page 512x360 at 1x |
| osr | false | capturePage | 6/6 | 0 | 21 / 23 | – | 512x360 | 10 / 11 | 30 | – |  | view - in content 1,0 511x360; page 512x360 at 1x |
| osr | false | cdpJpeg | 6/6 | 0 | 133 / 134 | – | 512x360 | – | 39 | – |  | view - in content 1,0 511x360; page 512x360 at 1x |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | – | 148 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | – | 3 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 115 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 108 | privateBytes | 201 | 3 | 0.1 |
| 1 | 133 | privateBytes | 274 | 4 | 0.1 |
| 2 | 157 | privateBytes | 344 | 5 | 0.2 |
| 4 | 211 | privateBytes | 498 | 7 | 0.4 |
| 8 | 318 | privateBytes | 809 | 11 | 0.6 |

Per idle tab resting in the never-shown window (a still page): **26 MiB**, 0.06% CPU. Four tabs: one partition +99 MiB, four partitions +103 MiB.

Quiet tabs working in one shared 1×1 host (no rAF loop; the page repaints twice a second): **29 MiB** and 1.57% CPU a tab (0: 136 MiB / 0.9%, 1: 160 MiB / 1.7%, 4: 248 MiB / 7.0%, 8: 368 MiB / 13.5%).

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 50.9 | 24.5 | 26.1 | 64 |
| animated, never-shown window, throttling off | 2.1 | 1.5 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.1 | 0.0 | 0.0 | 0 |
| animated, never-shown window, throttling off + frame pump | 1.7 | 1.5 | 0.0 | 0 |
| animated, invisible shown window | 60.3 | 31.4 | 28.8 | 64 |
| animated, 1x1 shown window | 33.4 | 29.4 | 3.9 | 64 |
| animated, osr 30 fps | 11.7 | 6.4 | 2.7 | 30 |

**One host, 4 tabs (each held at 1280×800, 1×):** tab 1 rAF 64 Hz, capturePage 4/4 in 48 / 50 ms (2560x1600); tab 2 rAF 62 Hz, capturePage 4/4 in 42 / 53 ms (2560x1600); tab 3 rAF 61 Hz, capturePage 4/4 in 47 / 50 ms (2560x1600); tab 4 rAF 60 Hz, capturePage 4/4 in 49 / 54 ms (2560x1600)

**Assertions:** PASS capturePage works in the 1x1 host with the agent's 1280x800 at 1x held; PASS every tab in one shared host draws and is pictured

### Electron · windows (electron-windows.json)

Electron 45.2.2 (Chromium 156.0.8078.80), win32-x64 10.0.26100, ozone (default), displays 1024x768@1, status **done**, 886 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.91 | 27.3 | 40 / 94 | 1 / 52 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.96 | 28.6 | 39 / 45 | 14 / 17 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.1 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.96 | 28.6 | 31 / 42 | 8 / 12 | 1280x800@1 → 1000x700@1 → 1280x800 | 1 / 3 | 2.0 |  |
| invisibleWindow | true | true | true | true (1) | 0.98 | 28.8 | 35 / 41 | 11 / 14 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 64.0 |  |
| tinyWindow | true | true | true | true (1) | 0.97 | 28.9 | 32 / 38 | 11 / 14 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 64.0 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | IO / RO Hz | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 100.0 | 93.4 | 64.0 | 17 | 2.0 / 2.0 | – | – | – | 5.3 | 9.7 |  |
| detached, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.3 |  |
| detached, throttling off | visible | 1280x800 | 100.0 | 97.2 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 1.4 | 1.5 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.2 |  |
| never-shown window, throttling off | visible | 1280x800 | 100.0 | 97.6 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 1.4 | 1.5 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 100.0 | 91.0 | 1.0 | 1001 | 0.0 / 0.0 | – | – | – | 1.1 | 1.4 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 100.0 | 97.4 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 1.4 | 1.5 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 100.0 | 97.4 | 0.0 | 0 | 0.0 / 0.0 | – | – | 0.0 | 1.4 | 1.6 |  |
| invisible shown window, throttling off | visible | 1280x800 | 100.2 | 92.8 | 64.2 | 18 | 2.0 / 2.2 | – | – | – | 5.4 | 10.1 |  |
| 1x1 shown window, throttling off | visible | 1280x800 | 100.0 | 93.0 | 64.0 | 18 | 1.8 / 1.8 | – | – | – | 4.9 | 8.3 |  |
| 1x1 shown window, covered by another window | visible | 1280x800 | 100.0 | 92.4 | 64.0 | 18 | 2.0 / 2.0 | – | – | – | 4.8 | 8.1 | cover 0,0 1024x720 over host 0,0 32x32 |
| 1x1 shown window kept above a cover window (always on top) | visible | 1280x800 | 100.0 | 92.4 | 64.0 | 18 | 2.0 / 2.0 | – | – | – | 5.0 | 8.4 | cover 0,0 1024x720 over host 0,0 32x32 |
| invisible shown window, covered by another window | visible | 1280x800 | 100.0 | 93.0 | 64.0 | 18 | 2.0 / 2.0 | – | – | – | 5.5 | 10.3 | cover 0,0 1024x720 over host 0,0 1024x720 |
| 1x1 shown window, throttling on (control) | visible | 1280x800 | 100.0 | 91.2 | 64.0 | 17 | 2.0 / 2.0 | – | – | – | 4.5 | 7.4 |  |
| 1x1 shown window, throttling on, covered by another window (control) | hidden | 1280x800 | 1.8 | 1.4 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.1 | 0.2 | cover 0,0 1024x720 over host 0,0 32x32 |
| invisible shown window, throttling on, covered by another window (control) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | 0.0 | 0.3 | cover 0,0 1024x720 over host 0,0 1024x720 |
| osr window 30 fps, throttling off | visible | 1024x720 | 100.0 | 91.2 | 30.0 | 35 | 2.0 / 2.0 | – | – | – | 3.1 | 9.0 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 100.2 | 91.6 | 30.0 | 35 | 0.0 / 2.0 | – | – | – | 2.0 | 2.6 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 100.0 | 90.4 | 0.0 | 0 | 0.0 / 0.0 | 0.84 | 24.8 | – | 2.2 | 3.0 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 100.0 | 91.4 | 0.0 | 0 | 0.0 / 0.0 | 0.84 | 24.8 | – | 2.1 | 3.0 |  |
| detached, throttling off, playing media | visible | 1280x800 | 100.0 | 91.2 | 0.0 | 0 | 0.0 / 0.0 | 0.84 | 24.8 | – | 2.1 | 2.8 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 100.0 | 97.6 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 1.6 | 1.0 | 0.0 | 0 | 0.0 / 0.0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | to 1280×800 + JPEG ms | CPU ms/picture | frames/s | visibility events | geometry; errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 9 / 19 | 11 / 15 | 1000x700 | 13 / 16 | 90 | – |  | view 0,0 1000x700 in content 48,97 1000x681; page 1000x700 at 1x |
| shown | true | capturePage | 6/6 | 6 | 10 / 11 | 11 / 12 | 1000x700 | 13 / 14 | 89 | – |  | view 0,0 1000x700 in content 48,97 1000x681; page 1000x700 at 1x |
| shown | true | cdpJpeg | 6/6 | 6 | 70 / 81 | -40 / -37 | 1000x700 | – | 101 | – |  | view 0,0 1000x700 in content 48,97 1000x681; page 1000x700 at 1x |
| shown | true | frameSub | 6/6 | 6 | 22 / 25 | 1 / 8 | 1000x700 | – | 72 | – |  | view 0,0 1000x700 in content 48,97 1000x681; page 1000x700 at 1x |
| shown | true | cdpPng | 6/6 | 6 | 220 / 226 | -43 / -36 | 1000x700 | – | 305 | – |  | view 0,0 1000x700 in content 48,97 1000x681; page 1000x700 at 1x |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 98 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | – | 69 | – |  | view 0,0 1280x800 in content -; page 1280x800 at 1x; frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 8,57 1008x681; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 8,57 1008x681; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 3975 / 3979 | -2942 / -46 | 1280x800 | – | 119 | – |  | view 0,0 1280x800 in content 8,57 1008x681; page 1280x800 at 1x |
| hiddenWindow | false | frameSub | 6/6 | 6 | 8 / 9 | 62 / 76 | 1280x800 | – | 36 | – |  | view 0,0 1280x800 in content 8,57 1008x681; page 1280x800 at 1x |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.5 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 8,57 1008x681; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | – | 2 | – |  | view 0,0 1280x800 in content 8,57 1008x681; page 1280x800 at 1x; Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 76 / 99 | -41 / -34 | 1280x800 | – | 133 | – |  | view 0,0 1280x800 in content 8,57 1008x681; page 1280x800 at 1x |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 23 / 24 | 1 / 3 | 1280x800 | – | 79 | – |  | view 0,0 1280x800 in content 8,57 1008x681; page 1280x800 at 1x |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 6/6 | 6 | 18 / 21 | 4 / 15 | 1280x800 | – | 85 | – |  | view 0,0 1280x800 in content 0,0 1024x720; page 1280x800 at 1x |
| invisibleWindow | false | capturePage | 6/6 | 6 | 19 / 24 | 3 / 5 | 1280x800 | – | 81 | – |  | view 0,0 1280x800 in content 0,0 1024x720; page 1280x800 at 1x |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 71 / 80 | -34 / -33 | 1280x800 | – | 132 | – |  | view 0,0 1280x800 in content 0,0 1024x720; page 1280x800 at 1x |
| invisibleWindow | false | frameSub | 6/6 | 6 | 23 / 25 | 7 / 16 | 1280x800 | – | 87 | – |  | view 0,0 1280x800 in content 0,0 1024x720; page 1280x800 at 1x |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 21 / 23 | 2 / 15 | 1280x800 | – | 64 | – |  | view 0,0 1280x800 in content 0,0 32x32; page 1280x800 at 1x |
| tinyWindow | false | capturePage | 6/6 | 6 | 20 / 22 | 2 / 15 | 1280x800 | – | 62 | – |  | view 0,0 1280x800 in content 0,0 32x32; page 1280x800 at 1x |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 72 / 85 | -35 / -32 | 1280x800 | – | 98 | – |  | view 0,0 1280x800 in content 0,0 32x32; page 1280x800 at 1x |
| tinyWindow | false | frameSub | 6/6 | 6 | 23 / 26 | 6 / 8 | 1280x800 | – | 60 | – |  | view 0,0 1280x800 in content 0,0 32x32; page 1280x800 at 1x |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, covered | false | capturePageHidden | 6/6 | 6 | 20 / 24 | 2 / 10 | 1280x800 | – | 62 | – |  | view 0,0 1280x800 in content 0,0 32x32; page 1280x800 at 1x |
| tinyWindow, covered | false | capturePage | 6/6 | 6 | 21 / 23 | 2 / 16 | 1280x800 | – | 57 | – |  | view 0,0 1280x800 in content 0,0 32x32; page 1280x800 at 1x |
| tinyWindow, covered | false | cdpJpeg | 6/6 | 6 | 70 / 80 | -35 / -32 | 1280x800 | – | 89 | – |  | view 0,0 1280x800 in content 0,0 32x32; page 1280x800 at 1x |
| tinyWindow, covered | false | frameSub | 6/6 | 6 | 23 / 24 | 5 / 13 | 1280x800 | – | 54 | – |  | view 0,0 1280x800 in content 0,0 32x32; page 1280x800 at 1x |
| tinyWindow, covered | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| tinyWindow, fit 1280x800 at 1x | false | capturePageHidden | 6/6 | 6 | 20 / 23 | 2 / 15 | 1280x800 | – | 56 | – |  | view 0,0 1280x800 in content 0,0 32x32; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | capturePage | 6/6 | 6 | 21 / 24 | 2 / 4 | 1280x800 | – | 60 | – |  | view 0,0 1280x800 in content 0,0 32x32; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | cdpJpeg | 6/6 | 6 | 70 / 80 | -35 / -33 | 1280x800 | – | 88 | – |  | view 0,0 1280x800 in content 0,0 32x32; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | frameSub | 6/6 | 6 | 24 / 25 | 5 / 6 | 1280x800 | – | 56 | – |  | view 0,0 1280x800 in content 0,0 32x32; page 1280x800 at 1x |
| tinyWindow, fit 1280x800 at 1x | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 23 / 26 | 1024x720 | – | 26 | – |  | view - in content 0,0 1024x720; page 1024x720 at 1x |
| osr | false | capturePage | 6/6 | 6 | 15 / 22 | -10 / -4 | 1024x720 | 12 / 17 | 58 | – |  | view - in content 0,0 1024x720; page 1024x720 at 1x |
| osr | false | cdpJpeg | 6/6 | 6 | 66 / 101 | -76 / -44 | 1024x720 | – | 67 | – |  | view - in content 0,0 1024x720; page 1024x720 at 1x |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | – | 166 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | – | 3 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | – | 123 | – |  | view 0,0 1280x800 in content -; page 0x0 at 1x; Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 145 | privateBytes | 158 | 4 | 0.0 |
| 1 | 169 | privateBytes | 231 | 5 | 0.3 |
| 2 | 195 | privateBytes | 304 | 6 | 0.2 |
| 4 | 246 | privateBytes | 454 | 8 | 0.4 |
| 8 | 352 | privateBytes | 758 | 12 | 0.6 |

Per idle tab resting in the never-shown window (a still page): **26 MiB**, 0.06% CPU. Four tabs: one partition +94 MiB, four partitions +107 MiB.

Quiet tabs working in one shared 1×1 host (no rAF loop; the page repaints twice a second): **28 MiB** and 0.78% CPU a tab (0: 173 MiB / 0.8%, 1: 198 MiB / 1.1%, 4: 281 MiB / 3.8%, 8: 394 MiB / 7.0%).

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 44.0 | 24.8 | 18.9 | 64 |
| animated, never-shown window, throttling off | 1.9 | 1.4 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.1 | 0.0 | 0.0 | 0 |
| animated, never-shown window, throttling off + frame pump | 1.6 | 1.4 | 0.1 | 0 |
| animated, invisible shown window | 57.3 | 32.6 | 24.5 | 64 |
| animated, 1x1 shown window | 32.0 | 28.4 | 3.5 | 64 |
| animated, osr 30 fps | 26.2 | 13.0 | 8.3 | 30 |

**Waking a resting tab into the host** (never-shown window, throttling on, 4 cycles): first rAF 1 / 4 ms, fresh picture 27 / 40 ms; resting rates 1.6 Hz / rAF 0.0, 1.3 Hz / rAF 0.0, 1.3 Hz / rAF 0.0, 1.6 Hz / rAF 0.0; awake rAF 64, 64, 64, 64

**One host, 4 tabs (each held at 1280×800, 1×):** tab 1 rAF 64 Hz, capturePage 4/4 in 19 / 22 ms (1280x800); tab 2 rAF 64 Hz, capturePage 4/4 in 18 / 21 ms (1280x800); tab 3 rAF 64 Hz, capturePage 4/4 in 18 / 20 ms (1280x800); tab 4 rAF 64 Hz, capturePage 4/4 in 19 / 20 ms (1280x800)

**The host's invariants:** host 100,100 32x32, focused at start false, after its page grabs focus false (focused window "S7 probe"); Windows styles {"style":"0x14c00000","exStyle":"0x82801a0","toolWindow":true,"noActivate":true,"transparent":true,"layered":true,"appWindow":false}; click-through {"at":"116,116","tool":"SendInput via user32 SetCursorPos and mouse_event","belowClicks":1,"hostClicks":0}

**Assertions:** PASS no reload when moving from detached; PASS no reload when moving from hiddenWindow; PASS no reload when moving from hiddenWindowFit; PASS no reload when moving from invisibleWindow; PASS no reload when moving from tinyWindow; PASS the 1x1 host draws (rAF above 10 Hz); PASS a never-shown window draws nothing (rAF below 1 Hz); PASS capturePage works in the 1x1 host; PASS capturePage works in the 1x1 host with the agent's 1280x800 at 1x held; PASS the host never takes focus, even when its page asks; PASS Windows: the host is a no-activate, click-through tool window, not an app window; PASS Windows: a real click at the host's point reaches the window below; PASS a resting tab draws within 2 s of moving into the host, every cycle; PASS every tab in one shared host draws and is pictured

**Q6 streamed view** (10 s at the viewer; latency p50 / p95 ms)

| road | content | source | fps | decoded fps | latency | gap p95 | kbit/s | bytes/frame | sender CPU % | viewer CPU % | source rAF | notes |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| screencast | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | 0 |  |
| capturePoll | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | anim | hiddenWindow | 25.8 | 25.8 | 39 / 41 | 71 | 2516 | 12189 | 88 | 19 | 64 | libvpx; video/VP8 |
| webrtc-h264 | anim | hiddenWindow | 14.7 | 14.7 | 57 / 72 | 93 | 2488 | 21157 | 87 | 12 | 64 | OpenH264; video/H264 |
| webcodecs-vp8 | anim | hiddenWindow | 30.0 | 30.0 | 34 / 36 | 48 | 2181 | 9088 | 105 | 19 | 64 |  |
| webcodecs-h264 | anim | hiddenWindow | 30.0 | 30.0 | 32 / 35 | 49 | 2148 | 8952 | 100 | 17 | 64 |  |
| screencast | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | 0 |  |
| capturePoll | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | static | hiddenWindow | 2.0 | 2.0 | 75 / 76 | 509 | 559 | 34914 | 8 | 2 | 64 | libvpx; video/VP8 |
| webrtc-h264 | static | hiddenWindow | 1.0 | 1.0 | 21 / 23 | 1005 | 18 | 2224 | 6 | 1 | 64 | OpenH264; video/H264 |
| webcodecs-vp8 | static | hiddenWindow | 2.3 | 2.3 | 19 / 112 | 502 | 147 | 7967 | 7 | 1 | 64 |  |
| webcodecs-h264 | static | hiddenWindow | 2.0 | 2.0 | 19 / 21 | 503 | 104 | 6514 | 5 | 1 | 64 |  |
| screencast | anim | invisibleWindow | 64.1 | 64.1 | 39 / 43 | 20 | 60555 | 118271 | 179 | 39 | 64 |  |
| capturePoll | anim | invisibleWindow | 29.4 | 29.4 | 39 / 54 | 46 | 28003 | 119062 | 126 | 18 | 64 | toJPEG 8.6 ms |
| webcodecs-h264 | anim | invisibleWindow | 30.0 | 30.0 | 36 / 40 | 49 | 2149 | 8956 | 134 | 19 | 64 |  |
| screencast | anim | tinyWindow | 63.8 | 63.8 | 39 / 43 | 19 | 60468 | 118286 | 180 | 38 | 64 |  |
| webcodecs-h264 | anim | tinyWindow | 30.0 | 30.0 | 34 / 37 | 48 | 2164 | 9016 | 113 | 18 | 64 |  |
| screencast | anim | shown | 64.0 | 64.0 | 33 / 35 | 18 | 50843 | 99303 | 131 | 32 | 64 |  |
| webrtc-vp8 | anim | shown | 24.3 | 24.3 | 56 / 58 | 78 | 2498 | 12850 | 137 | 20 | 64 | libvpx; video/VP8 |
| webcodecs-h264 | anim | shown | 30.0 | 30.0 | 43 / 46 | 48 | 2192 | 9132 | 139 | 19 | 64 |  |

### The pair · linux-x64 (pair-linux.json)

7.0.0-1017-azure, 37 s, state **done**

- **login start**: {"daemonUpMs":118,"daemonUp":true,"appConnectedMs":4751,"appStartedBy":"daemon","appStart":{"at":1793855003836,"safeMode":false,"reason":"daemon start","ok":true,"how":"systemctl --user start clover-s7-app-d24491e4.service","out":""},"daemonParent":1387}
- **second daemon on the same home**: {"exitCode":0,"ms":34,"said":"2026-11-05T05:03:26.310Z [core 2606] another daemon holds this home (flock: held by another process); exiting","firstStillServing":true}
- **app crash**: {"killed":2553,"kill":{"ok":true,"how":"kill -9 2553","code":0,"out":""},"restartedMs":1223,"newPid":2616,"startedBy":"daemon","safeMode":false,"how":"systemctl --user start clover-s7-app-d24491e4.service","eventsSinceKill":["start","tray","connected"]}
- **app crash loop → safe mode**: {"rounds":[{"killed":2616,"restartedMs":2222,"safeMode":false,"crashesInDaemon":2},{"killed":2667,"restartedMs":4242,"safeMode":true,"crashesInDaemon":3}],"thirdRestartInSafeMode":true}
- **daemon crash, restarted by the OS alone**: {"killed":2542,"kill":{"ok":true,"how":"kill -9 2542","code":0,"out":""},"daemonBackMs":1409,"newDaemonPid":2767,"appSurvived":true,"appPidAfter":2719,"samePid":true,"appStartedTheDaemon":false,"appEvents":["3ms daemon-lost","1508ms connected","1508ms reconnected"]}
- **daemon crash, the app helps after 3 s**: {"killed":2767,"kill":{"ok":true,"how":"kill -9 2767","code":0,"out":""},"daemonBackMs":1407,"newDaemonPid":2786,"appSurvived":true,"appPidAfter":2719,"samePid":true,"appStartedTheDaemon":false,"appEvents":["1ms daemon-lost","1506ms connected","1506ms reconnected"]}
- **tray Quit stops both, and they stay down**: {"forwarded":{"forwarded":true},"bothDownMs":402,"restartedWithin12s":false,"appEvents":["quit","quit-acked"]}
- **a user starts the app → it starts the daemon**: {"start":{"ok":true,"how":"spawn detached (as from a launcher)","code":0,"out":"2800"},"bothUpMs":519,"startedBy":"user","appStartedTheDaemon":[{"ok":true,"how":"systemctl --user start clover-s7-core-d24491e4.service","out":""}],"appEvents":["start","tray","start-daemon","connected"]}
- **the daemon side's Quit stops both**: {"bothDownMs":401,"restartedWithin8s":false}

**Assertions:** PASS the login item starts the daemon, and the daemon the app; PASS a second daemon is refused and exits 0; PASS a crashed app is back within 6 s; PASS the start after the third crash in two minutes is in safe mode; PASS a crashed daemon is back within 5 s without the app's help; PASS a crashed daemon is back within 10 s, and the app lives on; PASS the tray's Quit stops both, and nothing restarts them; PASS a user's start of the app brings up both within 10 s; PASS the daemon side's Quit stops both, and nothing restarts them

### The pair · darwin-arm64 (pair-macos.json)

25.6.0, 39 s, state **done**

- **login start**: {"daemonUpMs":127,"daemonUp":true,"appConnectedMs":4157,"appStartedBy":"daemon","appStart":{"at":1793855187533,"safeMode":false,"reason":"daemon start","ok":true,"how":"open -n -g -a /Users/runner/work/clover/clover/spikes/s7-browser/prototype/node_modules/electron/dist/Electron.app --args /Users/runner/work/clover/clover/spikes/s7-browser/prototype/out/pair/app --home=/var/folders/n6/hn37q6pj7sj_9dmqqc2113800000gn/T/clover-s7-pair-5R7bsA","out":""},"daemonParent":1}
- **second daemon on the same home**: {"exitCode":0,"ms":440,"said":"2026-11-05T05:06:29.442Z [core 2211] another daemon holds this home (flock: held by another process); exiting","firstStillServing":true}
- **app crash**: {"killed":2198,"kill":{"ok":true,"how":"kill -9 2198","code":0,"out":""},"restartedMs":1752,"newPid":2221,"startedBy":"daemon","safeMode":false,"how":"open -n -g -a /Users/runner/work/clover/clover/spikes/s7-browser/prototype/node_modules/electron/dist/Electron.app --args /Users/runner/work/clover/clover/spikes/s7-browser/prototype/out/pair/app --home=/var/folders/n6/hn37q6pj7sj_9dmqqc2113800000gn/T/clover-s7-pair-5R7bsA","eventsSinceKill":["start","tray","connected"]}
- **app crash loop → safe mode**: {"rounds":[{"killed":2221,"restartedMs":2736,"safeMode":false,"crashesInDaemon":2},{"killed":2236,"restartedMs":4888,"safeMode":true,"crashesInDaemon":3}],"thirdRestartInSafeMode":true}
- **daemon crash, restarted by the OS alone**: {"killed":2187,"kill":{"ok":true,"how":"kill -9 2187","code":0,"out":""},"daemonBackMs":259,"newDaemonPid":2407,"appSurvived":true,"appPidAfter":2403,"samePid":true,"appStartedTheDaemon":false,"appEvents":["8ms daemon-lost","529ms connected","529ms reconnected"]}
- **daemon crash, the app helps after 3 s**: {"killed":2407,"kill":{"ok":true,"how":"kill -9 2407","code":0,"out":""},"daemonBackMs":1227,"newDaemonPid":2413,"appSurvived":true,"appPidAfter":2403,"samePid":true,"appStartedTheDaemon":false,"appEvents":["2ms daemon-lost","1517ms connected","1517ms reconnected"]}
- **tray Quit stops both, and they stay down**: {"forwarded":{"forwarded":true},"bothDownMs":417,"restartedWithin12s":false,"appEvents":["quit","quit-acked"]}
- **a user starts the app → it starts the daemon**: {"start":{"ok":true,"how":"open -n -g -a /Users/runner/work/clover/clover/spikes/s7-browser/prototype/node_modules/electron/dist/Electron.app --args /Users/runner/work/clover/clover/spikes/s7-browser/prototype/out/pair/app --home=/var/folders/n6/hn37q6pj7sj_9dmqqc2113800000gn/T/clover-s7-pair-5R7bsA","code":0,"out":""},"bothUpMs":895,"startedBy":"user","appStartedTheDaemon":[{"ok":true,"how":"launchctl kickstart gui/501/com.waifucave.clover.s7.core.4d6d955d","out":""}],"appEvents":["start","tray","start-daemon","connected"]}
- **the daemon side's Quit stops both**: {"bothDownMs":410,"restartedWithin8s":false}

**Assertions:** PASS the login item starts the daemon, and the daemon the app; PASS a second daemon is refused and exits 0; PASS a crashed app is back within 6 s; PASS the start after the third crash in two minutes is in safe mode; PASS a crashed daemon is back within 5 s without the app's help; PASS a crashed daemon is back within 10 s, and the app lives on; PASS the tray's Quit stops both, and nothing restarts them; PASS a user's start of the app brings up both within 10 s; PASS the daemon side's Quit stops both, and nothing restarts them

### The pair · win32-x64 (pair-windows-spawn.json)

10.0.26100, 188 s, state **done**, Windows app start: spawn

- **login start**: {"daemonUpMs":352,"daemonUp":true,"appConnectedMs":3533,"appStartedBy":"daemon","appStart":{"at":1793855167961,"safeMode":false,"reason":"daemon start","ok":true,"how":"spawn detached","out":"7928"},"daemonParent":2692}
- **second daemon on the same home**: {"exitCode":0,"ms":72,"said":"2026-11-05T05:06:08.251Z [core 4960] another daemon holds this home (CreateFileW: error 32 (sharing violation: another daemon holds it)); exiting","firstStillServing":true}
- **app crash**: {"killed":7928,"kill":{"ok":true,"how":"taskkill /F /T /PID 7928","code":0,"out":"SUCCESS: The process with PID 7092 (child process of PID 7928) has been terminated.\r\nSUCCESS: The process with PID 1244 (child process of PID 7928) has been ter"},"restartedMs":1131,"newPid":7016,"startedBy":"daemon","safeMode":false,"how":"spawn detached","eventsSinceKill":["start","tray","connected"]}
- **app crash loop → safe mode**: {"rounds":[{"killed":7016,"restartedMs":2170,"safeMode":false,"crashesInDaemon":2},{"killed":6036,"restartedMs":4153,"safeMode":true,"crashesInDaemon":3}],"thirdRestartInSafeMode":true}
- **daemon crash, restarted by the OS alone**: {"killed":8800,"kill":{"ok":true,"how":"taskkill /F /PID 8800","code":0,"out":"SUCCESS: The process with PID 8800 has been terminated."},"appSurvived":true,"appPidAfter":1660,"samePid":true,"appStartedTheDaemon":{"atMs":150629,"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-e113b2fd"},"appEvents":["50ms daemon-lost","150629ms start-daemon","151146ms connected","151146ms reconnected"]}
- **daemon crash, the app helps after 3 s**: {"killed":4792,"kill":{"ok":true,"how":"taskkill /F /PID 4792","code":0,"out":"SUCCESS: The process with PID 4792 has been terminated."},"daemonBackMs":3304,"newDaemonPid":7420,"appSurvived":true,"appPidAfter":1660,"samePid":true,"appStartedTheDaemon":{"atMs":3092,"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-e113b2fd"},"appEvents":["52ms daemon-lost","3092ms start-daemon","3598ms connected","3598ms reconnected"]}
- **tray Quit stops both, and they stay down**: {"forwarded":{"forwarded":true},"bothDownMs":320,"restartedWithin12s":false,"appEvents":["quit","quit-acked"]}
- **a user starts the app → it starts the daemon**: {"start":{"ok":true,"how":"spawn detached","code":0,"out":"2760"},"bothUpMs":446,"startedBy":"user","appStartedTheDaemon":[{"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-e113b2fd","out":"SUCCESS: Attempted to run the scheduled task \"\\Clover S7\\core-e113b2fd\"."}],"appEvents":["start","tray","start-daemon","connected"]}
- **the daemon side's Quit stops both**: {"bothDownMs":422,"restartedWithin8s":false}

**Assertions:** PASS the login item starts the daemon, and the daemon the app; PASS a second daemon is refused and exits 0; PASS a crashed app is back within 6 s; PASS the start after the third crash in two minutes is in safe mode; PASS Task Scheduler alone does not restart a killed task (the finding the supervisor answers); PASS a crashed daemon is back within 10 s, and the app lives on; PASS the tray's Quit stops both, and nothing restarts them; PASS a user's start of the app brings up both within 10 s; PASS the daemon side's Quit stops both, and nothing restarts them

### The pair · win32-x64 (pair-windows-supervise.json)

10.0.26100, 36 s, state **done**, Windows app start: task, daemon under the supervisor

- **login start**: {"daemonUpMs":338,"daemonUp":true,"appConnectedMs":3562,"appStartedBy":"daemon","appStart":{"at":1793855319776,"safeMode":false,"reason":"daemon start","ok":true,"how":"schtasks /Run /TN \\Clover S7\\app-116bd5fd","out":"SUCCESS: Attempted to run the scheduled task \"\\Clover S7\\app-116bd5fd\"."},"daemonParent":500}
- **second daemon on the same home**: {"exitCode":0,"ms":60,"said":"2026-11-05T05:08:40.928Z [core 8176] another daemon holds this home (CreateFileW: error 32 (sharing violation: another daemon holds it)); exiting","firstStillServing":true}
- **app crash**: {"killed":9740,"kill":{"ok":true,"how":"taskkill /F /T /PID 9740","code":0,"out":"SUCCESS: The process with PID 5412 (child process of PID 9740) has been terminated.\r\nSUCCESS: The process with PID 1124 (child process of PID 9740) has been ter"},"restartedMs":1208,"newPid":600,"startedBy":"daemon","safeMode":false,"how":"schtasks /Run /TN \\Clover S7\\app-116bd5fd","eventsSinceKill":["start","tray","connected"]}
- **app crash loop → safe mode**: {"rounds":[{"killed":600,"restartedMs":2185,"safeMode":false,"crashesInDaemon":2},{"killed":2012,"restartedMs":4197,"safeMode":true,"crashesInDaemon":3}],"thirdRestartInSafeMode":true}
- **daemon crash, restarted by the OS alone**: {"killed":5108,"kill":{"ok":true,"how":"taskkill /F /PID 5108","code":0,"out":"SUCCESS: The process with PID 5108 has been terminated."},"daemonBackMs":625,"newDaemonPid":2672,"appSurvived":true,"appPidAfter":3012,"samePid":true,"appStartedTheDaemon":false,"appEvents":["43ms daemon-lost","1060ms connected","1061ms reconnected"]}
- **daemon crash, the app helps after 3 s**: {"killed":2672,"kill":{"ok":true,"how":"taskkill /F /PID 2672","code":0,"out":"SUCCESS: The process with PID 2672 has been terminated."},"daemonBackMs":1228,"newDaemonPid":2876,"appSurvived":true,"appPidAfter":3012,"samePid":true,"appStartedTheDaemon":false,"appEvents":["40ms daemon-lost","1551ms connected","1552ms reconnected"]}
- **tray Quit stops both, and they stay down**: {"forwarded":{"forwarded":true},"bothDownMs":407,"restartedWithin12s":false,"appEvents":["quit-acked"]}
- **a user starts the app → it starts the daemon**: {"start":{"ok":true,"how":"spawn detached","code":0,"out":"7792"},"bothUpMs":437,"startedBy":"user","appStartedTheDaemon":[{"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-116bd5fd","out":"SUCCESS: Attempted to run the scheduled task \"\\Clover S7\\core-116bd5fd\"."}],"appEvents":["start","tray","start-daemon","connected"]}
- **the daemon side's Quit stops both**: {"bothDownMs":328,"restartedWithin8s":false}

**Assertions:** PASS the login item starts the daemon, and the daemon the app; PASS a second daemon is refused and exits 0; PASS a crashed app is back within 6 s; PASS the start after the third crash in two minutes is in safe mode; PASS a crashed daemon is back within 5 s without the app's help; PASS a crashed daemon is back within 10 s, and the app lives on; PASS the tray's Quit stops both, and nothing restarts them; PASS a user's start of the app brings up both within 10 s; PASS the daemon side's Quit stops both, and nothing restarts them

### The pair · win32-x64 (pair-windows-task.json)

10.0.26100, 188 s, state **done**, Windows app start: task

- **login start**: {"daemonUpMs":437,"daemonUp":true,"appConnectedMs":3616,"appStartedBy":"daemon","appStart":{"at":1793855018336,"safeMode":false,"reason":"daemon start","ok":true,"how":"schtasks /Run /TN \\Clover S7\\app-d2e567f7","out":"SUCCESS: Attempted to run the scheduled task \"\\Clover S7\\app-d2e567f7\"."},"daemonParent":2580}
- **second daemon on the same home**: {"exitCode":0,"ms":68,"said":"2026-11-05T05:03:39.395Z [core 7456] another daemon holds this home (CreateFileW: error 32 (sharing violation: another daemon holds it)); exiting","firstStillServing":true}
- **app crash**: {"killed":1324,"kill":{"ok":true,"how":"taskkill /F /T /PID 1324","code":0,"out":"SUCCESS: The process with PID 8448 (child process of PID 1324) has been terminated.\r\nSUCCESS: The process with PID 4188 (child process of PID 1324) has been ter"},"restartedMs":1190,"newPid":2984,"startedBy":"daemon","safeMode":false,"how":"schtasks /Run /TN \\Clover S7\\app-d2e567f7","eventsSinceKill":["start","tray","connected"]}
- **app crash loop → safe mode**: {"rounds":[{"killed":2984,"restartedMs":2191,"safeMode":false,"crashesInDaemon":2},{"killed":3344,"restartedMs":4149,"safeMode":true,"crashesInDaemon":3}],"thirdRestartInSafeMode":true}
- **daemon crash, restarted by the OS alone**: {"killed":8168,"kill":{"ok":true,"how":"taskkill /F /PID 8168","code":0,"out":"SUCCESS: The process with PID 8168 has been terminated."},"appSurvived":true,"appPidAfter":2420,"samePid":true,"appStartedTheDaemon":{"atMs":150686,"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-d2e567f7"},"appEvents":["51ms daemon-lost","150686ms start-daemon","151189ms connected","151190ms reconnected"]}
- **daemon crash, the app helps after 3 s**: {"killed":8092,"kill":{"ok":true,"how":"taskkill /F /PID 8092","code":0,"out":"SUCCESS: The process with PID 8092 has been terminated."},"daemonBackMs":3295,"newDaemonPid":2392,"appSurvived":true,"appPidAfter":2420,"samePid":true,"appStartedTheDaemon":{"atMs":3126,"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-d2e567f7"},"appEvents":["82ms daemon-lost","3126ms start-daemon","3636ms connected","3636ms reconnected"]}
- **tray Quit stops both, and they stay down**: {"forwarded":{"forwarded":true},"bothDownMs":327,"restartedWithin12s":false,"appEvents":["quit","quit-acked"]}
- **a user starts the app → it starts the daemon**: {"start":{"ok":true,"how":"spawn detached","code":0,"out":"8324"},"bothUpMs":447,"startedBy":"user","appStartedTheDaemon":[{"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-d2e567f7","out":"SUCCESS: Attempted to run the scheduled task \"\\Clover S7\\core-d2e567f7\"."}],"appEvents":["start","tray","start-daemon","connected"]}
- **the daemon side's Quit stops both**: {"bothDownMs":327,"restartedWithin8s":false}

**Assertions:** PASS the login item starts the daemon, and the daemon the app; PASS a second daemon is refused and exits 0; PASS a crashed app is back within 6 s; PASS the start after the third crash in two minutes is in safe mode; PASS Task Scheduler alone does not restart a killed task (the finding the supervisor answers); PASS a crashed daemon is back within 10 s, and the app lives on; PASS the tray's Quit stops both, and nothing restarts them; PASS a user's start of the app brings up both within 10 s; PASS the daemon side's Quit stops both, and nothing restarts them

