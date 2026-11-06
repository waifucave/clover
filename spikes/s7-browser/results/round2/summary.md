## Spike S7 results

### Chrome for Testing · linux-arm64 (cft-linux-arm64-apparmor.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 0 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 121 MiB archive, 277 MiB unpacked, 287 files, 0 symlinks; download 1229 ms, unpack 988 ms; sha256 `5bb6a00a4285c13303d3f72c5afdb70f144ea7a93eed462365a52b69631c9607` (trust on first use; server MD5 true)
- start: over **pipe**, cold 59 ms, warm 56 ms; the port for comparison 59 ms
- start attempts: pipe ok 59 ms

### Chrome for Testing · linux-arm64 (cft-linux-arm64.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 159 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox off (--no-sandbox: every sandboxed start failed)

- install: 121 MiB archive, 277 MiB unpacked, 287 files, 0 symlinks; download 1229 ms, unpack 988 ms; sha256 `5bb6a00a4285c13303d3f72c5afdb70f144ea7a93eed462365a52b69631c9607` (trust on first use; server MD5 true)
- start: over **pipe**, cold 201 ms, warm 35 ms; the port for comparison 52 ms
- start attempts: pipe failed (pipe start failed: browser exited (SIGTRAP) during Browser.getVersion (exit SIGTRAP); stderr: [1105/010454.303588:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:130] No usable sandbox! If you are running on ); port failed (port start failed: browser exited before listening (exit SIGTRAP); stderr: [1105/010454.487277:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:130] No usable sandbox! If you are running on Ubuntu 23.10+ or an); pipe --no-sandbox ok 201 ms
- tabs: first (created first): visible, 1280x800, interval 99.9 Hz, rAF 60.2 Hz, media ×0.00, decoded 0.0 fps, audio suspended; second (created last): visible, 1280x800, interval 99.9 Hz, rAF 60.2 Hz, media ×0.00, decoded 0.0 fps, audio suspended
- resize to 1000×700 and back: 2 ms / 22 ms, same document true (1280 → 1000 → 1280)
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 175 MiB, per idle tab 23 MiB, 4 browser contexts +95 MiB, a second bot's browser 112 MiB (6 processes), animated tab 53.6% CPU
  - steps: 0 tabs 175 MiB pss / 0.0%, 1 tabs 210 MiB pss / 2.2%, 2 tabs 234 MiB pss / 4.7%, 4 tabs 276 MiB pss / 9.5%, 8 tabs 361 MiB pss / 17.9%
- errors: screenshots: browser gone (Page.captureScreenshot) — the browser exited (0); stderr: ALSA lib confmisc.c:422:(snd_func_concat) error evaluating strings | ALSA lib conf.c:5208:(_snd_config_evaluate) function snd_func_concat returned error: No such file or directory | ALSA lib confmisc.c:1342:(snd_func_refer) error evaluating name | ALSA lib conf.c:5208:(_snd_config_evaluate) function snd_func_refer returned error: No such file or directory | ALSA lib conf.c:5731:(snd_config_expand) Evaluate error: No such file or directory | ALSA lib pcm.c:2721:(snd_pcm_open_noupdate) Unknown PCM default | [1105/010455.347562:ERROR:media/audio/alsa/alsa_util.cc:204] PcmOpen: plug:default,No such file or directory | [1105/010457.275037:INFO:CONSOLE:303] "The AudioContext was not allowed to start. It must be resumed (or created) after a user gesture on the page. https://developer.chrome.com/blog/autoplay/#web_audio", source: http://127.0.0.1:35577/pages/probe.js (303) | [1105/010457.275080:INFO:CONSOLE:305] "The AudioContext was not allowed to start. It must be resumed (or created) after a user gesture on the page. https://developer.chrome.com/blog/autoplay/#web_audio", source: http://127.0.0.1:35577/pages/probe.js (305) | [1105/010508.271310:ERROR:content/browser/devtools/devtools_pipe_handler.cc:188] Connection terminated while reading from pipe

**chrome** — Chrome/156.0.8078.80; sandbox off (--no-sandbox: every sandboxed start failed)

- install: 191 MiB archive, 401 MiB unpacked, 301 files, 0 symlinks; download 2459 ms, unpack 1389 ms; sha256 `1f496a826c9ba4d6a5f5bf2de686145fe718528c2cc3dbeb96b5893b89653724` (trust on first use; server MD5 true)
- start: over **pipe**, cold 273 ms, warm 204 ms; the port for comparison 251 ms
- start attempts: pipe failed (pipe start failed: browser exited (SIGABRT) during Browser.getVersion (exit SIGABRT); stderr: #10 0xab94fd5f9138 (/home/runner/work/_temp/clover-s7-home/browsers/cft/156.0.8078.80/chrome-linux-arm64/chrome-linux-arm64/ch); port failed (port start failed: browser exited before listening (exit SIGABRT); stderr: #10 0xab299a979138 (/home/runner/work/_temp/clover-s7-home/browsers/cft/156.0.8078.80/chrome-linux-arm64/chrome-linux-arm64/chrome+0xa869137) | #); pipe --no-sandbox ok 273 ms
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 476 MiB, per idle tab 14 MiB, 4 browser contexts +388 MiB, a second bot's browser 279 MiB (11 processes), animated tab 60.5% CPU
  - steps: 0 tabs 476 MiB pss / 1.7%, 1 tabs 502 MiB pss / 2.5%, 2 tabs 522 MiB pss / 2.2%, 4 tabs 558 MiB pss / 2.7%, 8 tabs 591 MiB pss / 3.2%
- errors: tabs: browser gone (Runtime.evaluate) — the browser exited (0); stderr: ALSA lib confmisc.c:855:(parse_card) cannot find card '0' | ALSA lib conf.c:5208:(_snd_config_evaluate) function snd_func_card_inum returned error: No such file or directory | ALSA lib confmisc.c:422:(snd_func_concat) error evaluating strings | ALSA lib conf.c:5208:(_snd_config_evaluate) function snd_func_concat returned error: No such file or directory | ALSA lib confmisc.c:1342:(snd_func_refer) error evaluating name | ALSA lib conf.c:5208:(_snd_config_evaluate) function snd_func_refer returned error: No such file or directory | ALSA lib conf.c:5731:(snd_config_expand) Evaluate error: No such file or directory | ALSA lib pcm.c:2721:(snd_pcm_open_noupdate) Unknown PCM default | [3807:3807:1105/010617.935938:ERROR:media/audio/alsa/alsa_util.cc:204] PcmOpen: plug:default,No such file or directory | [3639:3711:1105/010624.112916:ERROR:content/browser/devtools/devtools_pipe_handler.cc:188] Connection terminated while reading from pipe; screenshots: browser gone (Target.createTarget) — the browser exited (0); stderr: ALSA lib confmisc.c:855:(parse_card) cannot find card '0' | ALSA lib conf.c:5208:(_snd_config_evaluate) function snd_func_card_inum returned error: No such file or directory | ALSA lib confmisc.c:422:(snd_func_concat) error evaluating strings | ALSA lib conf.c:5208:(_snd_config_evaluate) function snd_func_concat returned error: No such file or directory | ALSA lib confmisc.c:1342:(snd_func_refer) error evaluating name | ALSA lib conf.c:5208:(_snd_config_evaluate) function snd_func_refer returned error: No such file or directory | ALSA lib conf.c:5731:(snd_config_expand) Evaluate error: No such file or directory | ALSA lib pcm.c:2721:(snd_pcm_open_noupdate) Unknown PCM default | [3807:3807:1105/010617.935938:ERROR:media/audio/alsa/alsa_util.cc:204] PcmOpen: plug:default,No such file or directory | [3639:3711:1105/010624.112916:ERROR:content/browser/devtools/devtools_pipe_handler.cc:188] Connection terminated while reading from pipe

### Chrome for Testing · linux-x64 (cft-linux-x64-apparmor.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 0 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 121 MiB archive, 274 MiB unpacked, 287 files, 0 symlinks; download 842 ms, unpack 927 ms; sha256 `547dcd374e02961bf998f6046a267644f8502225c36bb78ca307dab32a0b3eb4` (trust on first use; server MD5 true)
- start: over **pipe**, cold 52 ms, warm 63 ms; the port for comparison 56 ms
- start attempts: pipe ok 52 ms

### Chrome for Testing · linux-x64 (cft-linux-x64.json)

7.0.0-1017-azure, 4 CPUs, 16 GiB, Bun 1.3.14, status **done**, 162 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox off (--no-sandbox: every sandboxed start failed)

- install: 121 MiB archive, 274 MiB unpacked, 287 files, 0 symlinks; download 842 ms, unpack 927 ms; sha256 `547dcd374e02961bf998f6046a267644f8502225c36bb78ca307dab32a0b3eb4` (trust on first use; server MD5 true)
- start: over **pipe**, cold 146 ms, warm 45 ms; the port for comparison 49 ms
- start attempts: pipe failed (pipe start failed: browser exited (SIGTRAP) during Browser.getVersion (exit SIGTRAP); stderr: [1105/010230.174803:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:130] No usable sandbox! If you are running on ); port failed (port start failed: browser exited before listening (exit SIGTRAP); stderr: [1105/010230.351582:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:130] No usable sandbox! If you are running on Ubuntu 23.10+ or an); pipe --no-sandbox ok 146 ms
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 171 MiB, per idle tab 23 MiB, 4 browser contexts +93 MiB, a second bot's browser 112 MiB (6 processes), animated tab 20.9% CPU
  - steps: 0 tabs 171 MiB pss / 0.0%, 1 tabs 206 MiB pss / 2.2%, 2 tabs 229 MiB pss / 3.5%, 4 tabs 271 MiB pss / 7.2%, 8 tabs 356 MiB pss / 13.1%
- errors: tabs: browser gone (Runtime.evaluate) — the browser exited (0); stderr: ALSA lib confmisc.c:422:(snd_func_concat) error evaluating strings | ALSA lib conf.c:5208:(_snd_config_evaluate) function snd_func_concat returned error: No such file or directory | ALSA lib confmisc.c:1342:(snd_func_refer) error evaluating name | ALSA lib conf.c:5208:(_snd_config_evaluate) function snd_func_refer returned error: No such file or directory | ALSA lib conf.c:5731:(snd_config_expand) Evaluate error: No such file or directory | ALSA lib pcm.c:2721:(snd_pcm_open_noupdate) Unknown PCM default | [1105/010231.256398:ERROR:media/audio/alsa/alsa_util.cc:204] PcmOpen: plug:default,No such file or directory | [1105/010233.210255:INFO:CONSOLE:303] "The AudioContext was not allowed to start. It must be resumed (or created) after a user gesture on the page. https://developer.chrome.com/blog/autoplay/#web_audio", source: http://127.0.0.1:43411/pages/probe.js (303) | [1105/010233.210284:INFO:CONSOLE:305] "The AudioContext was not allowed to start. It must be resumed (or created) after a user gesture on the page. https://developer.chrome.com/blog/autoplay/#web_audio", source: http://127.0.0.1:43411/pages/probe.js (305) | [1105/010238.516635:ERROR:content/browser/devtools/devtools_pipe_handler.cc:188] Connection terminated while reading from pipe; screenshots: browser gone (Target.createTarget) — the browser exited (0); stderr: ALSA lib confmisc.c:422:(snd_func_concat) error evaluating strings | ALSA lib conf.c:5208:(_snd_config_evaluate) function snd_func_concat returned error: No such file or directory | ALSA lib confmisc.c:1342:(snd_func_refer) error evaluating name | ALSA lib conf.c:5208:(_snd_config_evaluate) function snd_func_refer returned error: No such file or directory | ALSA lib conf.c:5731:(snd_config_expand) Evaluate error: No such file or directory | ALSA lib pcm.c:2721:(snd_pcm_open_noupdate) Unknown PCM default | [1105/010231.256398:ERROR:media/audio/alsa/alsa_util.cc:204] PcmOpen: plug:default,No such file or directory | [1105/010233.210255:INFO:CONSOLE:303] "The AudioContext was not allowed to start. It must be resumed (or created) after a user gesture on the page. https://developer.chrome.com/blog/autoplay/#web_audio", source: http://127.0.0.1:43411/pages/probe.js (303) | [1105/010233.210284:INFO:CONSOLE:305] "The AudioContext was not allowed to start. It must be resumed (or created) after a user gesture on the page. https://developer.chrome.com/blog/autoplay/#web_audio", source: http://127.0.0.1:43411/pages/probe.js (305) | [1105/010238.516635:ERROR:content/browser/devtools/devtools_pipe_handler.cc:188] Connection terminated while reading from pipe

**chrome** — Chrome/156.0.8078.80; sandbox off (--no-sandbox: every sandboxed start failed)

- install: 192 MiB archive, 403 MiB unpacked, 301 files, 0 symlinks; download 690 ms, unpack 1459 ms; sha256 `b711c720f774be355197f32edf37e0651418ba036d92446ee2da19ac017540a7` (trust on first use; server MD5 true)
- start: over **pipe**, cold 237 ms, warm 170 ms; the port for comparison 230 ms
- start attempts: pipe failed (pipe start failed: browser exited (SIGABRT) during Browser.getVersion (exit SIGABRT); stderr: #16 0x5601574a303a (/home/runner/work/_temp/clover-s7-home/browsers/cft/156.0.8078.80/chrome-linux64/chrome-linux64/chrome+0x7); port failed (port start failed: browser exited before listening (exit SIGABRT); stderr: #16 0x55ff6e12c03a (/home/runner/work/_temp/clover-s7-home/browsers/cft/156.0.8078.80/chrome-linux64/chrome-linux64/chrome+0x7646039) |   r8: 000); pipe --no-sandbox ok 237 ms
- tabs: first (created first): hidden, 1280x657, interval 2.0 Hz, rAF 0.0 Hz, media ×0.00, decoded 0.0 fps, audio suspended; second (created last): visible, 1280x657, interval 100.0 Hz, rAF 60.0 Hz, media ×0.00, decoded 0.0 fps, audio suspended
- resize to 1000×700 and back: 2 ms / 5012 ms, same document false (1280 → 1000 → )
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 437 MiB, per idle tab 15 MiB, 4 browser contexts +388 MiB, a second bot's browser 288 MiB (11 processes), animated tab 23.0% CPU
  - steps: 0 tabs 437 MiB pss / 1.0%, 1 tabs 468 MiB pss / 2.0%, 2 tabs 488 MiB pss / 1.7%, 4 tabs 525 MiB pss / 1.5%, 8 tabs 557 MiB pss / 2.2%
- errors: screenshots: browser exited (0) during Page.captureScreenshot — the browser exited (0); stderr: ALSA lib confmisc.c:855:(parse_card) cannot find card '0' | ALSA lib conf.c:5208:(_snd_config_evaluate) function snd_func_card_inum returned error: No such file or directory | ALSA lib confmisc.c:422:(snd_func_concat) error evaluating strings | ALSA lib conf.c:5208:(_snd_config_evaluate) function snd_func_concat returned error: No such file or directory | ALSA lib confmisc.c:1342:(snd_func_refer) error evaluating name | ALSA lib conf.c:5208:(_snd_config_evaluate) function snd_func_refer returned error: No such file or directory | ALSA lib conf.c:5731:(snd_config_expand) Evaluate error: No such file or directory | ALSA lib pcm.c:2721:(snd_pcm_open_noupdate) Unknown PCM default | [3638:3638:1105/010349.829105:ERROR:media/audio/alsa/alsa_util.cc:204] PcmOpen: plug:default,No such file or directory | [3470:3528:1105/010406.187367:ERROR:content/browser/devtools/devtools_pipe_handler.cc:188] Connection terminated while reading from pipe

### Chrome for Testing · darwin-arm64 (cft-macos.json)

25.6.0, 3 CPUs, 7 GiB, Bun 1.3.14, status **done**, 172 s

**chrome-headless-shell** — HeadlessChrome/156.0.8078.80; sandbox on

- install: 99 MiB archive, 204 MiB unpacked, 16 files, 0 symlinks; download 1663 ms, unpack 1686 ms; sha256 `ea615baa2e9caf0d02d1898a6562b5f8fa9c35239707dae0f592178df5b986ac` (trust on first use; server MD5 true)
- start: over **pipe**, cold 349 ms, warm 147 ms; the port for comparison 173 ms
- start attempts: pipe ok 349 ms
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 44 MiB, per idle tab 33 MiB, 4 browser contexts +132 MiB, a second bot's browser 44 MiB (4 processes), animated tab 38.1% CPU
  - steps: 0 tabs 44 MiB footprint / 1.0%, 1 tabs 78 MiB footprint / 2.2%, 2 tabs 111 MiB footprint / 5.0%, 4 tabs 178 MiB footprint / 12.8%, 8 tabs 310 MiB footprint / 24.2%
- errors: tabs: browser gone (Runtime.evaluate) — the browser exited (0); stderr: [1105/010255.660267:ERROR:ui/display/mac/cv_display_link_mac.mm:188] CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670 | [1105/010255.796917:ERROR:ui/display/mac/cv_display_link_mac.mm:188] CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670 | [1105/010255.873329:ERROR:ui/display/mac/cv_display_link_mac.mm:188] CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670 | [1105/010255.947592:ERROR:ui/display/mac/cv_display_link_mac.mm:188] CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670 | [1105/010256.129188:INFO:CONSOLE:303] "The AudioContext was not allowed to start. It must be resumed (or created) after a user gesture on the page. https://developer.chrome.com/blog/autoplay/#web_audio", source: http://127.0.0.1:49263/pages/probe.js (303) | [1105/010256.129336:INFO:CONSOLE:305] "The AudioContext was not allowed to start. It must be resumed (or created) after a user gesture on the page. https://developer.chrome.com/blog/autoplay/#web_audio", source: http://127.0.0.1:49263/pages/probe.js (305) | [1105/010258.158983:INFO:CONSOLE:303] "The AudioContext was not allowed to start. It must be resumed (or created) after a user gesture on the page. https://developer.chrome.com/blog/autoplay/#web_audio", source: http://127.0.0.1:49263/pages/probe.js (303) | [1105/010258.159050:INFO:CONSOLE:305] "The AudioContext was not allowed to start. It must be resumed (or created) after a user gesture on the page. https://developer.chrome.com/blog/autoplay/#web_audio", source: http://127.0.0.1:49263/pages/probe.js (305) | [1105/010301.934080:ERROR:content/browser/devtools/devtools_pipe_handler.cc:188] Connection terminated while reading from pipe | [1105/010301.964618:WARNING:services/audio/sync_reader.cc:154] ASR: No room in socket buffer.: Broken pipe (32); screenshots: browser gone (Target.createTarget) — the browser exited (0); stderr: [1105/010255.660267:ERROR:ui/display/mac/cv_display_link_mac.mm:188] CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670 | [1105/010255.796917:ERROR:ui/display/mac/cv_display_link_mac.mm:188] CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670 | [1105/010255.873329:ERROR:ui/display/mac/cv_display_link_mac.mm:188] CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670 | [1105/010255.947592:ERROR:ui/display/mac/cv_display_link_mac.mm:188] CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670 | [1105/010256.129188:INFO:CONSOLE:303] "The AudioContext was not allowed to start. It must be resumed (or created) after a user gesture on the page. https://developer.chrome.com/blog/autoplay/#web_audio", source: http://127.0.0.1:49263/pages/probe.js (303) | [1105/010256.129336:INFO:CONSOLE:305] "The AudioContext was not allowed to start. It must be resumed (or created) after a user gesture on the page. https://developer.chrome.com/blog/autoplay/#web_audio", source: http://127.0.0.1:49263/pages/probe.js (305) | [1105/010258.158983:INFO:CONSOLE:303] "The AudioContext was not allowed to start. It must be resumed (or created) after a user gesture on the page. https://developer.chrome.com/blog/autoplay/#web_audio", source: http://127.0.0.1:49263/pages/probe.js (303) | [1105/010258.159050:INFO:CONSOLE:305] "The AudioContext was not allowed to start. It must be resumed (or created) after a user gesture on the page. https://developer.chrome.com/blog/autoplay/#web_audio", source: http://127.0.0.1:49263/pages/probe.js (305) | [1105/010301.934080:ERROR:content/browser/devtools/devtools_pipe_handler.cc:188] Connection terminated while reading from pipe | [1105/010301.964618:WARNING:services/audio/sync_reader.cc:154] ASR: No room in socket buffer.: Broken pipe (32)

**chrome** — Chrome/156.0.8078.80; sandbox on

- install: 186 MiB archive, 366 MiB unpacked, 344 files, 5 symlinks; download 1949 ms, unpack 2475 ms; sha256 `8bc590d1b1acac042a000234c768f31830f25a3983a83ed5e067114c87c4cad1` (trust on first use; server MD5 true)
- start: over **pipe**, cold 2521 ms, warm 861 ms; the port for comparison 880 ms
- start attempts: pipe ok 2521 ms
- per-bot profiles: isolated true, persisted across a restart true
- cost: browser base 265 MiB, per idle tab 24 MiB, 4 browser contexts +514 MiB, a second bot's browser 258 MiB (9 processes), animated tab 10.9% CPU
  - steps: 0 tabs 265 MiB footprint / 3.7%, 1 tabs 312 MiB footprint / 5.2%, 2 tabs 339 MiB footprint / 5.7%, 4 tabs 395 MiB footprint / 5.9%, 8 tabs 457 MiB footprint / 3.9%
- errors: tabs: browser gone (Runtime.evaluate) — the browser exited (0); stderr: [3966:17720:1105/010419.789896:ERROR:ui/display/mac/cv_display_link_mac.mm:188] CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670 | [3966:17722:1105/010419.799189:ERROR:ui/display/mac/cv_display_link_mac.mm:188] CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670 | [3966:17720:1105/010419.800593:ERROR:ui/display/mac/cv_display_link_mac.mm:188] CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670 | [3966:17722:1105/010419.805640:ERROR:ui/display/mac/cv_display_link_mac.mm:188] CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670 | [3966:17720:1105/010419.810662:ERROR:ui/display/mac/cv_display_link_mac.mm:188] CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670 | [3966:17722:1105/010419.813592:ERROR:ui/display/mac/cv_display_link_mac.mm:188] CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670 | [3966:17720:1105/010419.814396:ERROR:ui/display/mac/cv_display_link_mac.mm:188] CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670 | [3966:17722:1105/010419.815454:ERROR:ui/display/mac/cv_display_link_mac.mm:188] CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670 | [3966:17720:1105/010419.816651:ERROR:ui/display/mac/cv_display_link_mac.mm:188] CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670 | [3959:17723:1105/010425.454605:ERROR:content/browser/devtools/devtools_pipe_handler.cc:188] Connection terminated while reading from pipe; screenshots: browser gone (Target.createTarget) — the browser exited (0); stderr: [3966:17720:1105/010419.789896:ERROR:ui/display/mac/cv_display_link_mac.mm:188] CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670 | [3966:17722:1105/010419.799189:ERROR:ui/display/mac/cv_display_link_mac.mm:188] CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670 | [3966:17720:1105/010419.800593:ERROR:ui/display/mac/cv_display_link_mac.mm:188] CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670 | [3966:17722:1105/010419.805640:ERROR:ui/display/mac/cv_display_link_mac.mm:188] CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670 | [3966:17720:1105/010419.810662:ERROR:ui/display/mac/cv_display_link_mac.mm:188] CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670 | [3966:17722:1105/010419.813592:ERROR:ui/display/mac/cv_display_link_mac.mm:188] CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670 | [3966:17720:1105/010419.814396:ERROR:ui/display/mac/cv_display_link_mac.mm:188] CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670 | [3966:17722:1105/010419.815454:ERROR:ui/display/mac/cv_display_link_mac.mm:188] CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670 | [3966:17720:1105/010419.816651:ERROR:ui/display/mac/cv_display_link_mac.mm:188] CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670 | [3959:17723:1105/010425.454605:ERROR:content/browser/devtools/devtools_pipe_handler.cc:188] Connection terminated while reading from pipe

### Electron · linux-arm64-ozone-headless (electron-linux-arm64-ozone-headless.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-arm64 7.0.0-1017-azure, ozone headless, displays 1920x1080@1, status **done**, 431 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.93 | 27.8 | 30 / 52 | 1 / 7 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.95 | 28.4 | 27 / 34 | 3 / 18 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.4 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.95 | 28.4 | 28 / 30 | 17 / 19 | 1280x800@1 → 1000x700@1 → 1280x800 | 1 / 1 | 2.4 |  |
| invisibleWindow | true | true | true | true (1) | 0.97 | 28.6 | 11 / 26 | 1 / 15 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.0 |  |
| tinyWindow | true | true | true | true (1) | 0.96 | 28.6 | 16 / 27 | 2 / 13 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.0 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 100.0 | 99.4 | 60.2 | 17 | – | – | – | 4.6 | 6.4 |  |
| detached, throttling on (default) | hidden | 1280x800 | 2.0 | 1.0 | 0.0 | 0 | – | – | – | 0.0 | 0.0 |  |
| detached, throttling off | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | – | – | – | 1.2 | 1.4 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | – | – | – | 0.0 | 0.0 |  |
| never-shown window, throttling off | visible | 1280x800 | 100.1 | 99.3 | 0.0 | 0 | – | – | – | 0.8 | 1.2 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 100.1 | 99.3 | 1.0 | 1017 | – | – | – | 1.2 | 1.6 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 100.1 | 99.1 | 0.0 | 0 | – | – | 0.0 | 1.0 | 1.0 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 100.1 | 99.3 | 0.0 | 0 | – | – | 0.0 | 0.8 | 1.2 |  |
| invisible shown window, throttling off | visible | 1280x800 | 100.2 | 99.2 | 60.0 | 17 | – | – | – | 5.0 | 6.8 |  |
| 1x1 shown window, throttling off | visible | 1280x800 | 100.0 | 99.2 | 60.0 | 17 | – | – | – | 4.6 | 6.0 |  |
| osr window 30 fps, throttling off | visible | 1280x800 | 100.1 | 99.1 | 30.0 | 34 | – | – | – | 3.6 | 12.0 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 100.2 | 99.2 | 30.0 | 34 | – | – | – | 2.0 | 2.2 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 100.0 | 99.4 | 0.0 | 0 | 0.84 | 25.8 | – | 2.2 | 2.8 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.85 | 25.8 | – | 2.4 | 3.2 |  |
| detached, throttling off, playing media | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | 0.85 | 25.8 | – | 2.4 | 3.2 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 100.1 | 99.1 | 0.0 | 0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | CPU ms/picture | frames/s | visibility events | errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 15 / 16 | -6 / 0 | 1000x700 | 57 | – |  |  |
| shown | true | capturePage | 6/6 | 6 | 15 / 16 | -6 / -4 | 1000x700 | 55 | – |  |  |
| shown | true | cdpJpeg | 6/6 | 6 | 65 / 66 | -46 / -30 | 1000x700 | 82 | – |  |  |
| shown | true | frameSub | 6/6 | 6 | 15 / 22 | -4 / -3 | 1000x700 | 52 | – |  |  |
| shown | true | cdpPng | 6/6 | 6 | 164 / 167 | -43 / -35 | 1000x700 | 222 | – |  |  |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | 65 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | 40 | – |  | frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | 3 | – |  | Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 4046 / 4048 | -2995 / -47 | 1280x800 | 135 | – |  |  |
| hiddenWindow | false | frameSub | 6/6 | 6 | 7 / 8 | 60 / 74 | 1280x800 | 47 | – |  |  |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.5 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 98 / 100 | -59 / -29 | 1280x800 | 167 | – |  |  |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 14 / 16 | 9 / 11 | 1280x800 | 95 | – |  |  |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 6/6 | 6 | 14 / 16 | 10 / 15 | 1280x800 | 68 | – |  |  |
| invisibleWindow | false | capturePage | 6/6 | 6 | 14 / 16 | 9 / 10 | 1280x800 | 67 | – |  |  |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 80 / 84 | -44 / -40 | 1280x800 | 127 | – |  |  |
| invisibleWindow | false | frameSub | 6/6 | 6 | 15 / 20 | 12 / 13 | 1280x800 | 70 | – |  |  |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 15 / 24 | 9 / 11 | 1280x800 | 62 | – |  |  |
| tinyWindow | false | capturePage | 6/6 | 6 | 13 / 17 | 9 / 11 | 1280x800 | 63 | – |  |  |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 79 / 86 | -44 / -39 | 1280x800 | 107 | – |  |  |
| tinyWindow | false | frameSub | 6/6 | 6 | 15 / 19 | 11 / 12 | 1280x800 | 62 | – |  |  |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 1 | 28 / 34 | 1280x800 | 35 | – |  |  |
| osr | false | capturePage | 6/6 | 6 | 31 / 39 | -19 / -19 | 1280x800 | 60 | – |  |  |
| osr | false | cdpJpeg | 6/6 | 6 | 98 / 110 | -73 / -71 | 1280x800 | 90 | – |  |  |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | 165 | – |  | no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | 5 | – |  | empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | 135 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 226 | pss | 488 | 4 | 0.0 |
| 1 | 254 | pss | 603 | 5 | 0.3 |
| 2 | 270 | pss | 722 | 6 | 0.0 |
| 4 | 300 | pss | 945 | 8 | 0.5 |
| 8 | 352 | pss | 1377 | 12 | 0.8 |

Per idle hidden tab: **16 MiB**, 0.09% CPU. Four tabs: one partition +66 MiB, four partitions +69 MiB.

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 35.7 | 28.5 | 7.3 | 60 |
| animated, never-shown window, throttling off | 1.3 | 1.3 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.0 | 0.0 | 0.0 | 0 |
| animated, never-shown window, throttling off + frame pump | 1.3 | 1.0 | 0.0 | 0 |
| animated, invisible shown window | 48.0 | 37.7 | 10.0 | 60 |
| animated, 1x1 shown window | 39.0 | 37.5 | 1.5 | 60 |
| animated, osr 30 fps | 33.0 | 20.2 | 5.5 | 30 |

### Electron · linux-wayland (electron-linux-wayland.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone wayland, displays 1920x1080@1, status **done**, 705 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.92 | 27.7 | 33 / 128 | 1 / 110 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.93 | 27.5 | 31 / 37 | 1 / 4 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.92 | 27.5 | 24 / 29 | 1 / 5 | 1280x800@1 → 1000x700@1 → 1280x800 | 1 / 2 | 0.0 |  |
| tinyWindow | true | true | true | true (1) | 0.96 | 28.6 | 25 / 32 | 11 / 18 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 40.7 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 100.2 | 99.2 | 40.0 | 26 | – | – | – | 4.4 | 8.0 |  |
| detached, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | – | – | – | 0.0 | 0.2 |  |
| detached, throttling off | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | – | – | – | 1.2 | 1.4 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | – | – | – | 0.2 | 0.4 |  |
| never-shown window, throttling off | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | – | – | – | 1.0 | 1.2 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 100.1 | 99.3 | 0.0 | 0 | – | – | – | 1.2 | 1.2 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | – | – | 0.0 | 1.0 | 1.0 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | – | – | 0.0 | 1.0 | 1.0 |  |
| invisible shown window, throttling off | – | – | – | – | – | – | – | – | – | – | – | not possible here |
| 1x1 shown window, throttling off | visible | 1280x800 | 99.9 | 99.1 | 40.0 | 26 | – | – | – | 4.8 | 8.4 |  |
| osr window 30 fps, throttling off | visible | 1280x800 | 99.9 | 99.1 | 30.0 | 34 | – | – | – | 3.8 | 15.2 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 100.0 | 99.2 | 30.0 | 34 | – | – | – | 2.4 | 3.0 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.84 | 24.8 | – | 2.8 | 3.8 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.85 | 25.6 | – | 2.6 | 3.8 |  |
| detached, throttling off, playing media | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | 0.85 | 26.0 | – | 3.0 | 4.2 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 100.2 | 99.2 | 0.0 | 0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | CPU ms/picture | frames/s | visibility events | errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 28 / 30 | 30 / 32 | 1000x700 | 47 | – |  |  |
| shown | true | capturePage | 6/6 | 6 | 28 / 30 | 30 / 31 | 1000x700 | 47 | – |  |  |
| shown | true | cdpJpeg | 6/6 | 6 | 133 / 143 | -63 / -62 | 1000x700 | 87 | – |  |  |
| shown | true | frameSub | 6/6 | 6 | 29 / 29 | 33 / 41 | 1000x700 | 40 | – |  |  |
| shown | true | cdpPng | 6/6 | 6 | 264 / 284 | -67 / -66 | 1000x700 | 220 | – |  |  |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 29.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | 100 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | 65 | – |  | frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | 3 | – |  | Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 0/2 | 0 | – | – | - | 80 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| hiddenWindow | false | frameSub | 0/2 | 0 | – | – | - | 55 | – |  | frame subscription: timed out after 5000 ms |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 0/2 | 0 | – | – | - | 95 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| hiddenWindow + pump | false | frameSub | 0/2 | 0 | – | – | - | 65 | – |  | frame subscription: timed out after 5000 ms |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| invisibleWindow | false | - | 0/0 | 0 | – | – | - | – | – |  | not possible here |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 22 / 25 | 12 / 19 | 1280x800 | 45 | – |  |  |
| tinyWindow | false | capturePage | 6/6 | 6 | 22 / 24 | 11 / 14 | 1280x800 | 47 | – |  |  |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 146 / 150 | -75 / -50 | 1280x800 | 87 | – |  |  |
| tinyWindow | false | frameSub | 6/6 | 6 | 24 / 33 | 40 / 41 | 1280x800 | 45 | – |  |  |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.5 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 29 / 37 | 1280x800 | 33 | – |  |  |
| osr | false | capturePage | 6/6 | 6 | 32 / 33 | -19 / -16 | 1280x800 | 52 | – |  |  |
| osr | false | cdpJpeg | 6/6 | 6 | 98 / 110 | -72 / -70 | 1280x800 | 83 | – |  |  |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | 205 | – |  | no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | 160 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 321 | pss | 590 | 4 | 0.3 |
| 1 | 348 | pss | 695 | 5 | 0.3 |
| 2 | 364 | pss | 804 | 6 | 0.3 |
| 4 | 392 | pss | 1020 | 8 | 0.3 |
| 8 | 444 | pss | 1450 | 12 | 0.5 |

Per idle hidden tab: **15 MiB**, 0.03% CPU. Four tabs: one partition +65 MiB, four partitions +69 MiB.

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 22.2 | 13.3 | 8.0 | 38 |
| animated, never-shown window, throttling off | 1.3 | 1.0 | 0.3 | 0 |
| animated, never-shown window, throttling on | 0.3 | 0.0 | 0.3 | 0 |
| animated, never-shown window, throttling off + frame pump | 1.0 | 1.0 | 0.0 | 0 |
| animated, 1x1 shown window | 18.8 | 15.5 | 2.3 | 40 |
| animated, osr 30 fps | 26.3 | 11.3 | 6.5 | 30 |

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
| screencast | anim | tinyWindow | 39.9 | 39.9 | 73 / 75 | 27 | 43832 | 137662 | 104 | 25 | 40 |  |
| webcodecs-h264 | anim | tinyWindow | 30.0 | 30.0 | 68 / 70 | 53 | 2383 | 9928 | 87 | 16 | 40 |  |
| screencast | anim | shown | 38.1 | 38.1 | 71 / 72 | 28 | 34921 | 114571 | 81 | 20 | 38 |  |
| webrtc-vp8 | anim | shown | 20.5 | 20.5 | 90 / 97 | 80 | 2501 | 15249 | 102 | 17 | 38 | libvpx; video/VP8 |
| webcodecs-h264 | anim | shown | 30.0 | 30.0 | 77 / 81 | 56 | 2413 | 10055 | 106 | 16 | 38 |  |

### Electron · linux-x11 (electron-linux-x11.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone x11, displays 1920x1080@1, status **done**, 725 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.92 | 28.1 | 31 / 37 | 1 / 16 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.95 | 28.4 | 29 / 30 | 11 / 18 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.4 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.95 | 28.4 | 27 / 33 | 13 / 17 | 1280x800@1 → 1000x700@1 → 1280x800 | 1 / 1 | 2.1 |  |
| invisibleWindow | true | true | true | true (1) | 0.95 | 28.4 | 26 / 30 | 3 / 15 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.0 |  |
| tinyWindow | true | true | true | true (1) | 0.96 | 28.6 | 26 / 27 | 13 / 16 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.1 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 99.9 | 99.1 | 60.1 | 18 | – | – | – | 4.6 | 6.4 |  |
| detached, throttling on (default) | hidden | 1280x800 | 2.0 | 1.0 | 0.0 | 0 | – | – | – | 0.0 | 0.2 |  |
| detached, throttling off | visible | 1280x800 | 100.2 | 99.0 | 0.0 | 0 | – | – | – | 1.4 | 1.4 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | – | – | – | 0.0 | 0.2 |  |
| never-shown window, throttling off | visible | 1280x800 | 100.0 | 99.0 | 0.0 | 0 | – | – | – | 1.2 | 1.2 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 100.1 | 99.1 | 1.0 | 1017 | – | – | – | 1.2 | 1.6 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | – | – | 0.0 | 1.2 | 1.4 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | – | – | 0.0 | 1.0 | 1.0 |  |
| invisible shown window, throttling off | visible | 1280x800 | 100.1 | 99.1 | 0.0 | 0 | – | – | – | 1.0 | 1.0 |  |
| 1x1 shown window, throttling off | visible | 1280x800 | 100.1 | 99.1 | 60.0 | 18 | – | – | – | 4.2 | 6.2 |  |
| osr window 30 fps, throttling off | visible | 1280x800 | 100.0 | 99.2 | 30.0 | 35 | – | – | – | 3.0 | 13.6 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 99.9 | 99.1 | 30.0 | 34 | – | – | – | 2.0 | 2.6 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.85 | 25.8 | – | 2.4 | 3.2 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.85 | 25.8 | – | 2.4 | 3.0 |  |
| detached, throttling off, playing media | visible | 1280x800 | 100.1 | 99.1 | 0.0 | 0 | 0.85 | 25.8 | – | 2.2 | 3.0 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 100.1 | 99.1 | 0.0 | 0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 2.0 | 1.0 | 0.0 | 0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | CPU ms/picture | frames/s | visibility events | errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 14 / 20 | 9 / 10 | 1000x700 | 53 | – |  |  |
| shown | true | capturePage | 6/6 | 6 | 15 / 16 | 9 / 12 | 1000x700 | 48 | – |  |  |
| shown | true | cdpJpeg | 6/6 | 6 | 81 / 83 | -46 / -39 | 1000x700 | 80 | – |  |  |
| shown | true | frameSub | 6/6 | 6 | 15 / 20 | 12 / 12 | 1000x700 | 42 | – |  |  |
| shown | true | cdpPng | 6/6 | 6 | 214 / 227 | -36 / -35 | 1000x700 | 257 | – |  |  |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | 85 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | 60 | – |  | frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 4044 / 4049 | -2991 / -38 | 1280x800 | 125 | – |  |  |
| hiddenWindow | false | frameSub | 6/6 | 6 | 9 / 10 | 61 / 77 | 1280x800 | 38 | – |  |  |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.5 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 96 / 102 | -53 / -33 | 1280x800 | 167 | – |  |  |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 14 / 15 | 12 / 16 | 1280x800 | 88 | – |  |  |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| invisibleWindow | false | capturePage | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 80 / 84 | -38 / -29 | 1280x800 | 100 | – |  |  |
| invisibleWindow | false | frameSub | 6/6 | 6 | 14 / 31 | 15 / 16 | 1280x800 | 57 | – |  |  |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 14 / 22 | 12 / 13 | 1280x800 | 43 | – |  |  |
| tinyWindow | false | capturePage | 6/6 | 6 | 13 / 17 | 13 / 14 | 1280x800 | 52 | – |  |  |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 80 / 86 | -39 / -34 | 1280x800 | 80 | – |  |  |
| tinyWindow | false | frameSub | 6/6 | 6 | 15 / 32 | 12 / 16 | 1280x800 | 52 | – |  |  |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 18 / 25 | 1280x800 | 28 | – |  |  |
| osr | false | capturePage | 6/6 | 6 | 31 / 32 | -18 / -4 | 1280x800 | 52 | – |  |  |
| osr | false | cdpJpeg | 6/6 | 6 | 99 / 129 | -70 / -68 | 1280x800 | 85 | – |  |  |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | 160 | – |  | no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | 5 | – |  | empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | 135 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 313 | pss | 570 | 4 | 0.0 |
| 1 | 341 | pss | 675 | 5 | 0.0 |
| 2 | 356 | pss | 783 | 6 | 0.0 |
| 4 | 384 | pss | 998 | 8 | 0.5 |
| 8 | 435 | pss | 1426 | 12 | 1.0 |

Per idle hidden tab: **15 MiB**, 0.12% CPU. Four tabs: one partition +65 MiB, four partitions +68 MiB.

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 24.8 | 18.3 | 6.5 | 60 |
| animated, never-shown window, throttling off | 1.3 | 1.3 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.0 | 0.0 | 0.0 | 0 |
| animated, never-shown window, throttling off + frame pump | 1.3 | 1.3 | 0.0 | 0 |
| animated, invisible shown window | 1.3 | 1.0 | 0.0 | 0 |
| animated, 1x1 shown window | 23.2 | 21.0 | 2.0 | 60 |
| animated, osr 30 fps | 25.2 | 12.0 | 4.8 | 30 |

**Q6 streamed view** (10 s at the viewer; latency p50 / p95 ms)

| road | content | source | fps | decoded fps | latency | gap p95 | kbit/s | bytes/frame | sender CPU % | viewer CPU % | source rAF | notes |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| screencast | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | 0 |  |
| capturePoll | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | anim | hiddenWindow | 20.9 | 20.9 | 42 / 50 | 78 | 2523 | 15093 | 68 | 16 | 60 | libvpx; video/VP8 |
| webrtc-h264 | anim | hiddenWindow | 12.6 | 12.6 | 68 / 94 | 110 | 2488 | 24680 | 64 | 10 | 60 | OpenH264; video/H264 |
| webcodecs-vp8 | anim | hiddenWindow | 30.0 | 30.0 | 34 / 38 | 36 | 2422 | 10092 | 94 | 20 | 60 |  |
| webcodecs-h264 | anim | hiddenWindow | 30.0 | 30.0 | 32 / 34 | 36 | 2400 | 9999 | 77 | 18 | 60 |  |
| screencast | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | 0 |  |
| capturePoll | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | static | hiddenWindow | 2.0 | 2.0 | 23 / 27 | 505 | 63 | 3940 | 6 | 2 | 60 | libvpx; video/VP8 |
| webrtc-h264 | static | hiddenWindow | 1.0 | 1.0 | 24 / 25 | 1000 | 18 | 2190 | 5 | 1 | 60 | OpenH264; video/H264 |
| webcodecs-vp8 | static | hiddenWindow | 2.0 | 2.0 | 29 / 33 | 504 | 113 | 7087 | 6 | 1 | 60 |  |
| webcodecs-h264 | static | hiddenWindow | 2.0 | 2.0 | 28 / 29 | 503 | 34 | 2137 | 5 | 1 | 60 |  |
| screencast | anim | invisibleWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 |  |
| capturePoll | anim | invisibleWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | 0 | toJPEG 0.0 ms |
| webcodecs-h264 | anim | invisibleWindow | 30.0 | 30.0 | 51 / 54 | 36 | 2403 | 10014 | 103 | 19 | 60 |  |
| screencast | anim | tinyWindow | 60.1 | 60.1 | 42 / 45 | 20 | 66130 | 137770 | 159 | 43 | 60 |  |
| webcodecs-h264 | anim | tinyWindow | 30.0 | 30.0 | 34 / 37 | 36 | 2402 | 10007 | 94 | 19 | 60 |  |
| screencast | anim | shown | 60.0 | 60.0 | 36 / 38 | 19 | 55032 | 114650 | 124 | 34 | 60 |  |
| webrtc-vp8 | anim | shown | 20.4 | 20.4 | 52 / 60 | 79 | 2500 | 15319 | 104 | 17 | 60 | libvpx; video/VP8 |
| webcodecs-h264 | anim | shown | 30.0 | 30.0 | 41 / 43 | 36 | 2453 | 10219 | 111 | 20 | 60 |  |

### Electron · linux-x64-ozone-headless (electron-linux-x64-ozone-headless.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone headless, displays 1920x1080@1, status **done**, 431 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.93 | 27.5 | 29 / 34 | 0 / 6 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.95 | 28.4 | 27 / 35 | 4 / 18 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.4 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.95 | 28.4 | 27 / 32 | 12 / 16 | 1280x800@1 → 1000x700@1 → 1280x800 | 1 / 1 | 2.1 |  |
| invisibleWindow | true | true | true | true (1) | 0.96 | 28.6 | 22 / 28 | 2 / 16 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.1 |  |
| tinyWindow | true | true | true | true (1) | 0.96 | 28.6 | 22 / 29 | 1 / 12 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 60.0 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 100.0 | 99.2 | 60.0 | 19 | – | – | – | 4.8 | 6.8 |  |
| detached, throttling on (default) | hidden | 1280x800 | 2.0 | 1.0 | 0.0 | 0 | – | – | – | 0.2 | 0.2 |  |
| detached, throttling off | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | – | – | – | 1.2 | 1.4 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 1.8 | 1.0 | 0.0 | 0 | – | – | – | 0.0 | 0.2 |  |
| never-shown window, throttling off | visible | 1280x800 | 99.9 | 98.9 | 0.0 | 0 | – | – | – | 1.4 | 1.4 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 100.1 | 99.1 | 1.0 | 1017 | – | – | – | 1.8 | 2.0 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 99.9 | 99.1 | 0.0 | 0 | – | – | 0.0 | 1.2 | 1.4 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | – | – | 0.0 | 1.2 | 1.4 |  |
| invisible shown window, throttling off | visible | 1280x800 | 99.9 | 99.1 | 60.0 | 18 | – | – | – | 5.4 | 7.4 |  |
| 1x1 shown window, throttling off | visible | 1280x800 | 100.2 | 99.2 | 60.0 | 17 | – | – | – | 5.0 | 6.6 |  |
| osr window 30 fps, throttling off | visible | 1280x800 | 99.9 | 99.1 | 30.0 | 34 | – | – | – | 3.4 | 14.0 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 99.9 | 99.1 | 30.0 | 34 | – | – | – | 2.6 | 3.4 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 100.1 | 98.9 | 0.0 | 0 | 0.85 | 25.8 | – | 3.0 | 4.0 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 100.0 | 99.2 | 0.0 | 0 | 0.85 | 25.6 | – | 3.2 | 4.4 |  |
| detached, throttling off, playing media | visible | 1280x800 | 99.9 | 98.9 | 0.0 | 0 | 0.85 | 26.0 | – | 3.2 | 4.4 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 100.1 | 99.1 | 0.0 | 0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 2.0 | 1.0 | 0.0 | 0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | CPU ms/picture | frames/s | visibility events | errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 15 / 16 | -6 / -1 | 1000x700 | 47 | – |  |  |
| shown | true | capturePage | 6/6 | 6 | 14 / 18 | -7 / -3 | 1000x700 | 42 | – |  |  |
| shown | true | cdpJpeg | 6/6 | 6 | 65 / 66 | -46 / -39 | 1000x700 | 70 | – |  |  |
| shown | true | frameSub | 6/6 | 6 | 15 / 23 | -4 / -4 | 1000x700 | 40 | – |  |  |
| shown | true | cdpPng | 6/6 | 6 | 196 / 216 | -39 / -35 | 1000x700 | 242 | – |  |  |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | 90 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | 70 | – |  | frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | 3 | – |  | Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 4047 / 4049 | -2992 / -39 | 1280x800 | 132 | – |  |  |
| hiddenWindow | false | frameSub | 6/6 | 6 | 10 / 11 | 59 / 79 | 1280x800 | 45 | – |  |  |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.5 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | 0 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | 3 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 96 / 102 | -55 / -28 | 1280x800 | 155 | – |  |  |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 14 / 16 | 10 / 14 | 1280x800 | 78 | – |  |  |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 6/6 | 6 | 14 / 15 | 11 / 14 | 1280x800 | 68 | – |  |  |
| invisibleWindow | false | capturePage | 6/6 | 6 | 13 / 16 | 12 / 14 | 1280x800 | 57 | – |  |  |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 81 / 86 | -42 / -35 | 1280x800 | 103 | – |  |  |
| invisibleWindow | false | frameSub | 6/6 | 6 | 14 / 18 | 15 / 16 | 1280x800 | 62 | – |  |  |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 14 / 22 | 12 / 13 | 1280x800 | 45 | – |  |  |
| tinyWindow | false | capturePage | 6/6 | 6 | 13 / 16 | 12 / 14 | 1280x800 | 52 | – |  |  |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 80 / 85 | -39 / -34 | 1280x800 | 83 | – |  |  |
| tinyWindow | false | frameSub | 6/6 | 6 | 15 / 30 | 15 / 17 | 1280x800 | 47 | – |  |  |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.5 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 29 / 37 | 1280x800 | 35 | – |  |  |
| osr | false | capturePage | 6/6 | 6 | 28 / 35 | -17 / -15 | 1280x800 | 52 | – |  |  |
| osr | false | cdpJpeg | 6/6 | 6 | 99 / 110 | -72 / -67 | 1280x800 | 87 | – |  |  |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | 200 | – |  | no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | 5 | – |  | empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | 140 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 229 | pss | 484 | 4 | 0.0 |
| 1 | 257 | pss | 588 | 5 | 0.0 |
| 2 | 272 | pss | 695 | 6 | 0.3 |
| 4 | 300 | pss | 908 | 8 | 0.8 |
| 8 | 352 | pss | 1336 | 12 | 1.3 |

Per idle hidden tab: **15 MiB**, 0.16% CPU. Four tabs: one partition +66 MiB, four partitions +69 MiB.

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 24.7 | 17.0 | 7.5 | 60 |
| animated, never-shown window, throttling off | 1.5 | 1.5 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.0 | 0.0 | 0.0 | 0 |
| animated, never-shown window, throttling off + frame pump | 1.5 | 1.3 | 0.0 | 0 |
| animated, invisible shown window | 33.0 | 21.2 | 11.8 | 60 |
| animated, 1x1 shown window | 22.2 | 20.2 | 2.0 | 60 |
| animated, osr 30 fps | 28.0 | 12.3 | 7.3 | 30 |

### Electron · macos (electron-macos.json)

Electron 45.2.2 (Chromium 156.0.8078.80), darwin-arm64 25.6.0, ozone (default), displays 1024x768@1, status **done**, 730 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.93 | 27.5 | 43 / 909 | 16 / 160 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 1.9 |  |
| hiddenWindow | true | true | true | true (1) | 0.96 | 28.9 | 30 / 57 | 11 / 19 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.0 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.96 | 28.7 | 74 / 97 | 24 / 30 | 1280x800@1 → 1000x700@1 → 1280x800 | 1 / 3 | 2.0 |  |
| invisibleWindow | true | true | true | true (1) | 0.97 | 28.9 | 59 / 94 | 3 / 20 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 59.9 |  |
| tinyWindow | true | true | true | true (1) | 0.98 | 28.9 | 42 / 67 | 5 / 11 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 58.2 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 73.5 | 60.9 | 59.9 | 45 | – | – | – | 4.7 | 12.8 |  |
| detached, throttling on (default) | hidden | 1280x800 | 1.2 | 1.0 | 0.0 | 0 | – | – | – | 0.1 | 0.3 |  |
| detached, throttling off | visible | 1280x800 | 97.2 | 79.6 | 0.0 | 0 | – | – | – | 3.8 | 9.5 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 1.4 | 1.0 | 0.0 | 0 | – | – | – | 0.3 | 2.2 |  |
| never-shown window, throttling off | visible | 1280x800 | 86.8 | 71.0 | 0.0 | 0 | – | – | – | 4.0 | 10.3 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 78.1 | 60.7 | 59.9 | 23 | – | – | – | 9.5 | 27.1 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 99.9 | 82.5 | 0.0 | 0 | – | – | 0.0 | 3.7 | 9.8 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 98.7 | 83.9 | 0.0 | 0 | – | – | 0.0 | 3.0 | 7.8 |  |
| invisible shown window, throttling off | visible | 1280x800 | 72.3 | 60.7 | 59.7 | 41 | – | – | – | 6.7 | 18.7 |  |
| 1x1 shown window, throttling off | visible | 1280x800 | 81.5 | 60.9 | 59.9 | 29 | – | – | – | 7.0 | 18.6 |  |
| osr window 30 fps, throttling off | visible | 1280x800 | 62.3 | 49.9 | 23.2 | 107 | – | – | – | 4.0 | 19.7 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 64.1 | 49.9 | 21.4 | 102 | – | – | – | 2.4 | 6.1 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 55.7 | 42.7 | 0.0 | 0 | 0.88 | 26.2 | – | 4.8 | 10.3 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 55.7 | 43.8 | 0.0 | 0 | 0.86 | 26.4 | – | 4.0 | 8.9 |  |
| detached, throttling off, playing media | visible | 1280x800 | 56.3 | 43.2 | 0.0 | 0 | 0.95 | 27.6 | – | 3.5 | 7.2 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 98.4 | 78.7 | 0.0 | 0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | CPU ms/picture | frames/s | visibility events | errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 15 / 21 | 12 / 18 | 1000x700 | 45 | – |  |  |
| shown | true | capturePage | 6/6 | 6 | 21 / 25 | 12 / 16 | 1000x700 | 49 | – |  |  |
| shown | true | cdpJpeg | 6/6 | 6 | 95 / 100 | -41 / -37 | 1000x700 | 97 | – |  |  |
| shown | true | frameSub | 6/6 | 6 | 30 / 40 | 6 / 15 | 1000x700 | 80 | – |  |  |
| shown | true | cdpPng | 6/6 | 6 | 204 / 236 | -43 / -36 | 1000x700 | 247 | – |  |  |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | 11 | – |  | Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | 6 | – |  | Current display surface not available for capture |
| detached | false | cdpJpeg | 1/3 | 1 | 70 / 70 | -48 / -48 | 1280x800 | 176 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | 207 | – |  | frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | 12 | – |  | Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | 12 | – |  | Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 196 / 787 | -73 / -61 | 1280x800 | 222 | – |  |  |
| hiddenWindow | false | frameSub | 6/6 | 6 | 67 / 247 | 5 / 32 | 1280x800 | 108 | – |  |  |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 26.5 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | 5 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | 10 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 166 / 527 | -117 / -44 | 1280x800 | 301 | – |  |  |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 34 / 86 | 4 / 15 | 1280x800 | 102 | – |  |  |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 29.5 |  |  |
| invisibleWindow | false | capturePageHidden | 6/6 | 6 | 31 / 46 | 7 / 15 | 1280x800 | 53 | – |  |  |
| invisibleWindow | false | capturePage | 6/6 | 6 | 24 / 59 | 11 / 16 | 1280x800 | 63 | – |  |  |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 97 / 136 | -49 / -27 | 1280x800 | 91 | – |  |  |
| invisibleWindow | false | frameSub | 6/6 | 6 | 24 / 31 | 5 / 14 | 1280x800 | 47 | – |  |  |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 35 / 40 | 20 / 28 | 1280x800 | 65 | – |  |  |
| tinyWindow | false | capturePage | 6/6 | 6 | 29 / 39 | 24 / 31 | 1280x800 | 58 | – |  |  |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 106 / 114 | -44 / -34 | 1280x800 | 69 | – |  |  |
| tinyWindow | false | frameSub | 6/6 | 6 | 33 / 38 | 27 / 30 | 1280x800 | 59 | – |  |  |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 27.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 1 | 80 / 176 | 1280x800 | 21 | – |  |  |
| osr | false | capturePage | 6/6 | 6 | 15 / 170 | 111 / 210 | 1280x800 | 28 | – |  |  |
| osr | false | cdpJpeg | 6/6 | 6 | 327 / 510 | -189 / -91 | 1280x800 | 118 | – |  |  |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | 14.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | 567 | – |  | no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | 8 | – |  | empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | 430 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 142 | footprint | 354 | 4 | 0.1 |
| 1 | 163 | footprint | 445 | 5 | 0.7 |
| 2 | 183 | footprint | 537 | 6 | 0.9 |
| 4 | 221 | footprint | 722 | 8 | 1.9 |
| 8 | 303 | footprint | 1093 | 12 | 3.2 |

Per idle hidden tab: **20 MiB**, 0.38% CPU. Four tabs: one partition +77 MiB, four partitions +79 MiB.

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 28.7 | 10.3 | 18.2 | 59 |
| animated, never-shown window, throttling off | 15.6 | 4.8 | 10.3 | 0 |
| animated, never-shown window, throttling on | 1.2 | 0.1 | 0.6 | 0 |
| animated, never-shown window, throttling off + frame pump | 16.9 | 5.2 | 10.7 | 0 |
| animated, invisible shown window | 50.8 | 17.0 | 33.0 | 60 |
| animated, 1x1 shown window | 29.7 | 10.3 | 18.5 | 60 |
| animated, osr 30 fps | 32.1 | 6.3 | 14.6 | 16 |

**Q6 streamed view** (10 s at the viewer; latency p50 / p95 ms)

| road | content | source | fps | decoded fps | latency | gap p95 | kbit/s | bytes/frame | sender CPU % | viewer CPU % | source rAF | notes |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| screencast | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 14 | 0 | 0 |  |
| capturePoll | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 15 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | anim | hiddenWindow | 4.3 | 4.3 | 180 / 216 | 378 | 675 | 19636 | 58 | 5 | 60 | libvpx; video/VP8 |
| webrtc-h264 | anim | hiddenWindow | 13.2 | 13.2 | 201 / 253 | 125 | 2378 | 22520 | 110 | 15 | 60 | OpenH264; video/H264 |
| webcodecs-vp8 | anim | hiddenWindow | 30.0 | 30.0 | 62 / 101 | 52 | 2293 | 9522 | 104 | 23 | 60 |  |
| webcodecs-h264 | anim | hiddenWindow | 30.0 | 30.0 | 43 / 54 | 47 | 2244 | 9320 | 88 | 12 | 60 |  |
| screencast | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 1 | 0 | 0 |  |
| capturePoll | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | static | hiddenWindow | 2.0 | 2.0 | 42 / 59 | 546 | 39 | 2413 | 10 | 2 | 43 | libvpx; video/VP8 |
| webrtc-h264 | static | hiddenWindow | 1.0 | 1.0 | 57 / 87 | 1023 | 8 | 1032 | 10 | 1 | 42 | OpenH264; video/H264 |
| webcodecs-vp8 | static | hiddenWindow | 2.0 | 2.0 | 47 / 75 | 541 | 106 | 6604 | 9 | 2 | 44 |  |
| webcodecs-h264 | static | hiddenWindow | 2.0 | 2.0 | 42 / 55 | 529 | 9 | 540 | 7 | 1 | 45 |  |
| screencast | anim | invisibleWindow | 60.0 | 60.0 | 41 / 48 | 29 | 58512 | 121697 | 92 | 30 | 60 |  |
| capturePoll | anim | invisibleWindow | 30.3 | 30.3 | 59 / 68 | 47 | 29592 | 122077 | 60 | 15 | 60 | toJPEG 5.8 ms |
| webcodecs-h264 | anim | invisibleWindow | 30.0 | 30.0 | 53 / 67 | 48 | 2230 | 9292 | 103 | 16 | 60 |  |
| screencast | anim | tinyWindow | 58.7 | 58.7 | 48 / 79 | 32 | 57044 | 121682 | 112 | 34 | 60 |  |
| webcodecs-h264 | anim | tinyWindow | 30.0 | 30.0 | 51 / 85 | 49 | 2236 | 9317 | 113 | 19 | 60 |  |
| screencast | anim | shown | 60.0 | 60.0 | 40 / 46 | 28 | 48888 | 101851 | 70 | 21 | 60 |  |
| webrtc-vp8 | anim | shown | 24.6 | 24.6 | 137 / 179 | 75 | 2387 | 12129 | 62 | 17 | 60 | libvpx; video/VP8 |
| webcodecs-h264 | anim | shown | 30.0 | 30.0 | 26 / 28 | 41 | 2119 | 8827 | 68 | 10 | 60 |  |

### Electron · windows (electron-windows.json)

Electron 45.2.2 (Chromium 156.0.8078.80), win32-x64 10.0.26100, ozone (default), displays 1024x768@1, status **done**, 720 s

**Q1 hidden ⇄ shown** (times are p50 / p95 ms from the move)

| hidden place | same document | field | scroll | SSE | media × | decoded fps | fresh picture shown | first rAF shown | layout hidden → shown → hidden | fit to 1280×800 | rAF while hidden | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| detached | true | true | true | true (1) | 0.92 | 27.5 | 27 / 60 | 1 / 39 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 0.0 |  |
| hiddenWindow | true | true | true | true (1) | 0.96 | 28.6 | 25 / 25 | 15 / 19 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 2.3 |  |
| hiddenWindowFit | true | true | true | true (1) | 0.96 | 28.6 | 23 / 26 | 15 / 19 | 1280x800@1 → 1000x700@1 → 1280x800 | 1 / 1 | 2.4 |  |
| invisibleWindow | true | true | true | true (1) | 0.97 | 28.8 | 21 / 24 | 0 / 14 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 64.1 |  |
| tinyWindow | true | true | true | true (1) | 0.96 | 28.8 | 22 / 25 | 5 / 16 | 1280x800@1 → 1000x700@1 → 1280x800 | – | 64.2 |  |

**Q2 throttling** (5 s windows)

| config | visibility | layout | interval Hz | chain Hz | rAF Hz | max rAF gap ms | media × | decoded fps | pump fps | renderer CPU % | all CPU % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown (reference) | visible | 1000x700 | 100.0 | 92.0 | 64.0 | 17 | – | – | – | 3.5 | 6.3 |  |
| detached, throttling on (default) | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | – | – | – | 0.0 | 0.2 |  |
| detached, throttling off | visible | 1280x800 | 100.0 | 98.2 | 0.0 | 0 | – | – | – | 1.1 | 1.2 |  |
| never-shown window, throttling on (default) | hidden | 1280x800 | 1.4 | 1.2 | 0.0 | 0 | – | – | – | 0.0 | 0.2 |  |
| never-shown window, throttling off | visible | 1280x800 | 100.0 | 94.8 | 0.0 | 0 | – | – | – | 1.2 | 1.4 |  |
| never-shown window, on, then setBackgroundThrottling(false) | visible | 1280x800 | 100.0 | 90.6 | 1.0 | 1001 | – | – | – | 0.9 | 1.1 |  |
| never-shown window, throttling off + frame pump | visible | 1280x800 | 100.0 | 98.2 | 0.0 | 0 | – | – | 0.0 | 1.1 | 1.2 |  |
| detached, throttling off + frame pump | visible | 1280x800 | 100.2 | 98.2 | 0.0 | 0 | – | – | 0.0 | 1.1 | 1.2 |  |
| invisible shown window, throttling off | visible | 1280x800 | 100.0 | 92.6 | 64.0 | 18 | – | – | – | 3.7 | 6.7 |  |
| 1x1 shown window, throttling off | visible | 1280x800 | 99.9 | 92.9 | 64.2 | 18 | – | – | – | 3.7 | 6.5 |  |
| osr window 30 fps, throttling off | visible | 1024x720 | 100.0 | 90.6 | 30.0 | 35 | – | – | – | 2.2 | 6.8 |  |
| osr view (no window) 30 fps, throttling off | visible | 0x0 | 100.0 | 90.8 | 30.0 | 35 | – | – | – | 1.4 | 1.8 |  |
| never-shown window, throttling on, playing media | hidden | 1280x800 | 100.0 | 93.6 | 0.0 | 0 | 0.85 | 24.8 | – | 1.9 | 2.6 |  |
| never-shown window, throttling off, playing media | visible | 1280x800 | 100.0 | 93.6 | 0.0 | 0 | 0.84 | 24.8 | – | 1.9 | 2.7 |  |
| detached, throttling off, playing media | visible | 1280x800 | 100.0 | 94.4 | 0.0 | 0 | 0.85 | 25.4 | – | 1.9 | 2.6 |  |
| one never-shown window: tab A, throttling off | visible | 1280x800 | 100.0 | 98.2 | 0.0 | 0 | – | – | – | – | – |  |
| one never-shown window: tab B, throttling on | hidden | 1280x800 | 1.0 | 1.0 | 0.0 | 0 | – | – | – | – | – |  |

**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)

| place | throttling | method | ok | decoded | ms | stale ms | size | CPU ms/picture | frames/s | visibility events | errors |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| shown | true | capturePageHidden | 6/6 | 6 | 7 / 9 | -1 / 0 | 1000x700 | 45 | – |  |  |
| shown | true | capturePage | 6/6 | 6 | 7 / 9 | -1 / 0 | 1000x700 | 42 | – |  |  |
| shown | true | cdpJpeg | 6/6 | 6 | 55 / 64 | -42 / -26 | 1000x700 | 64 | – |  |  |
| shown | true | frameSub | 6/6 | 6 | 8 / 17 | -1 / 1 | 1000x700 | 38 | – |  |  |
| shown | true | cdpPng | 6/6 | 6 | 176 / 190 | -42 / -35 | 1000x700 | 225 | – |  |  |
| shown | true | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| detached | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| detached | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| detached | false | cdpJpeg | 0/2 | 0 | – | – | - | 81 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| detached | false | frameSub | 0/2 | 0 | – | – | - | 58 | – |  | frame subscription: timed out after 5000 ms |
| detached | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 0.0 |  |  |
| hiddenWindow | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow | false | cdpJpeg | 6/6 | 6 | 3976 / 3979 | -2945 / -42 | 1280x800 | 97 | – |  |  |
| hiddenWindow | false | frameSub | 6/6 | 6 | 7 / 9 | 56 / 74 | 1280x800 | 33 | – |  |  |
| hiddenWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.5 |  |  |
| hiddenWindow + pump | false | capturePageHidden | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | Current display surface not available for capture |
| hiddenWindow + pump | false | cdpJpeg | 6/6 | 6 | 70 / 73 | -40 / -34 | 1280x800 | 106 | – |  |  |
| hiddenWindow + pump | false | frameSub | 6/6 | 6 | 9 / 22 | 12 / 14 | 1280x800 | 62 | – |  |  |
| hiddenWindow + pump | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| invisibleWindow | false | capturePageHidden | 6/6 | 6 | 10 / 22 | 8 / 14 | 1280x800 | 54 | – |  |  |
| invisibleWindow | false | capturePage | 6/6 | 6 | 8 / 21 | 14 / 16 | 1280x800 | 54 | – |  |  |
| invisibleWindow | false | cdpJpeg | 6/6 | 6 | 71 / 81 | -40 / -37 | 1280x800 | 90 | – |  |  |
| invisibleWindow | false | frameSub | 6/6 | 6 | 22 / 25 | 2 / 11 | 1280x800 | 56 | – |  |  |
| invisibleWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| tinyWindow | false | capturePageHidden | 6/6 | 6 | 7 / 24 | 13 / 15 | 1280x800 | 36 | – |  |  |
| tinyWindow | false | capturePage | 6/6 | 6 | 7 / 8 | 14 / 15 | 1280x800 | 39 | – |  |  |
| tinyWindow | false | cdpJpeg | 6/6 | 6 | 70 / 81 | -39 / -36 | 1280x800 | 64 | – |  |  |
| tinyWindow | false | frameSub | 6/6 | 6 | 16 / 24 | 0 / 14 | 1280x800 | 39 | – |  |  |
| tinyWindow | false | beginFrameSubscription | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osr | false | osrPaint | 6/6 | 6 | 0 / 0 | 38 / 41 | 1024x720 | 18 | – |  |  |
| osr | false | capturePage | 6/6 | 6 | 31 / 33 | 6 / 8 | 1024x720 | 32 | – |  |  |
| osr | false | cdpJpeg | 6/6 | 6 | 132 / 141 | -88 / -86 | 1024x720 | 56 | – |  |  |
| osr | false | paint events | 0/0 | 0 | – | – | - | – | 30.0 |  |  |
| osrView | false | osrPaint | 0/6 | 0 | – | – | - | 123 | – |  | no paint event |
| osrView | false | capturePage | 0/6 | 0 | – | – | - | 2 | – |  | empty image |
| osrView | false | cdpJpeg | 0/2 | 0 | – | – | - | 94 | – |  | Page.captureScreenshot: timed out after 5000 ms |
| osrView | false | paint events | 0/0 | 0 | – | – | - | – | 0.0 |  |  |

**Q2 cost**

| idle hidden tabs | memory MiB | kind | RSS MiB | processes | CPU % |
| :- | :- | :- | :- | :- | :- |
| 0 | 131 | privateBytes | 157 | 4 | 0.0 |
| 1 | 156 | privateBytes | 230 | 5 | 0.1 |
| 2 | 184 | privateBytes | 307 | 6 | 0.1 |
| 4 | 236 | privateBytes | 457 | 8 | 0.3 |
| 8 | 342 | privateBytes | 760 | 12 | 0.5 |

Per idle hidden tab: **26 MiB**, 0.05% CPU. Four tabs: one partition +96 MiB, four partitions +106 MiB.

| animated tab | all CPU % | renderer % | GPU % | rAF Hz |
| :- | :- | :- | :- | :- |
| animated, shown | 29.0 | 15.6 | 12.9 | 64 |
| animated, never-shown window, throttling off | 1.3 | 1.1 | 0.0 | 0 |
| animated, never-shown window, throttling on | 0.1 | 0.0 | 0.0 | 0 |
| animated, never-shown window, throttling off + frame pump | 1.3 | 1.2 | 0.1 | 0 |
| animated, invisible shown window | 40.1 | 21.1 | 18.9 | 64 |
| animated, 1x1 shown window | 23.7 | 20.0 | 3.5 | 64 |
| animated, osr 30 fps | 20.8 | 9.5 | 7.4 | 30 |

**Q6 streamed view** (10 s at the viewer; latency p50 / p95 ms)

| road | content | source | fps | decoded fps | latency | gap p95 | kbit/s | bytes/frame | sender CPU % | viewer CPU % | source rAF | notes |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| screencast | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | 0 |  |
| capturePoll | anim | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 2 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | anim | hiddenWindow | 26.0 | 26.0 | 38 / 40 | 64 | 2492 | 11979 | 72 | 16 | 64 | libvpx; video/VP8 |
| webrtc-h264 | anim | hiddenWindow | 14.7 | 14.7 | 56 / 70 | 81 | 2497 | 21237 | 64 | 10 | 64 | OpenH264; video/H264 |
| webcodecs-vp8 | anim | hiddenWindow | 30.0 | 30.0 | 30 / 32 | 48 | 2184 | 9101 | 78 | 15 | 64 |  |
| webcodecs-h264 | anim | hiddenWindow | 30.0 | 30.0 | 29 / 31 | 48 | 2172 | 9020 | 75 | 14 | 64 |  |
| screencast | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | 0 |  |
| capturePoll | static | hiddenWindow | 0.0 | 0.0 | – | – | 0 | 0 | 0 | 0 | 0 | toJPEG 0.0 ms |
| webrtc-vp8 | static | hiddenWindow | 2.0 | 2.0 | 15 / 17 | 501 | 51 | 3179 | 5 | 1 | 64 | libvpx; video/VP8 |
| webrtc-h264 | static | hiddenWindow | 1.0 | 1.0 | 29 / 32 | 1016 | 18 | 2188 | 5 | 1 | 64 | OpenH264; video/H264 |
| webcodecs-vp8 | static | hiddenWindow | 2.0 | 2.0 | 19 / 21 | 502 | 107 | 6692 | 5 | 1 | 64 |  |
| webcodecs-h264 | static | hiddenWindow | 2.0 | 2.0 | 22 / 23 | 501 | 8 | 507 | 4 | 1 | 64 |  |
| screencast | anim | invisibleWindow | 64.0 | 64.0 | 34 / 36 | 18 | 60570 | 118300 | 130 | 32 | 64 |  |
| capturePoll | anim | invisibleWindow | 31.9 | 31.9 | 33 / 36 | 35 | 30403 | 118761 | 90 | 16 | 64 | toJPEG 6.0 ms |
| webcodecs-h264 | anim | invisibleWindow | 30.1 | 30.1 | 32 / 34 | 48 | 2162 | 9007 | 101 | 14 | 64 |  |
| screencast | anim | tinyWindow | 64.0 | 64.0 | 33 / 34 | 17 | 60562 | 118285 | 124 | 32 | 64 |  |
| webcodecs-h264 | anim | tinyWindow | 30.1 | 30.1 | 31 / 32 | 47 | 2161 | 9006 | 86 | 14 | 64 |  |
| screencast | anim | shown | 64.0 | 64.0 | 29 / 31 | 17 | 50911 | 99281 | 100 | 24 | 64 |  |
| webrtc-vp8 | anim | shown | 24.8 | 24.8 | 54 / 56 | 77 | 2501 | 12605 | 99 | 16 | 64 | libvpx; video/VP8 |
| webcodecs-h264 | anim | shown | 30.0 | 30.0 | 37 / 39 | 48 | 2187 | 9112 | 105 | 16 | 64 |  |

### The pair · linux-x64 (pair-linux.json)

7.0.0-1017-azure, 35 s, state **done**

- **login start**: {"daemonUpMs":115,"daemonUp":true,"appConnectedMs":2820,"appStartedBy":"daemon","appStart":{"at":1793840558443,"safeMode":false,"reason":"daemon start","ok":true,"how":"systemctl --user start clover-s7-app-85fc91a9.service","out":""},"daemonParent":1174}
- **second daemon on the same home**: {"exitCode":0,"ms":43,"said":"2026-11-05T01:02:38.998Z [core 2626] another daemon holds this home (flock: held by another process); exiting","firstStillServing":true}
- **app crash**: {"killed":2576,"kill":{"ok":true,"how":"kill -9 2576","code":0,"out":""},"restartedMs":1221,"newPid":2636,"startedBy":"daemon","safeMode":false,"how":"systemctl --user start clover-s7-app-85fc91a9.service","eventsSinceKill":["start","tray","connected"]}
- **app crash loop → safe mode**: {"rounds":[{"killed":2636,"restartedMs":2228,"safeMode":false,"crashesInDaemon":2},{"killed":2686,"restartedMs":4252,"safeMode":true,"crashesInDaemon":3}],"thirdRestartInSafeMode":true}
- **daemon crash, restarted by the OS alone**: {"killed":2563,"kill":{"ok":true,"how":"kill -9 2563","code":0,"out":""},"daemonBackMs":1208,"newDaemonPid":2802,"appSurvived":true,"appPidAfter":2739,"samePid":true,"appStartedTheDaemon":false,"appEvents":["4ms daemon-lost","1510ms connected","1510ms reconnected"]}
- **daemon crash, the app helps after 3 s**: {"killed":2802,"kill":{"ok":true,"how":"kill -9 2802","code":0,"out":""},"daemonBackMs":1207,"newDaemonPid":2813,"appSurvived":true,"appPidAfter":2739,"samePid":true,"appStartedTheDaemon":false,"appEvents":["2ms daemon-lost","1507ms connected","1507ms reconnected"]}
- **tray Quit stops both, and they stay down**: {"forwarded":{"forwarded":true},"bothDownMs":403,"restartedWithin12s":false,"appEvents":["quit","quit-acked","daemon-quitting"]}
- **a user starts the app → it starts the daemon**: {"start":{"ok":true,"how":"spawn detached (as from a launcher)","code":0,"out":"2829"},"bothUpMs":515,"startedBy":"user","appStartedTheDaemon":[{"ok":true,"how":"systemctl --user start clover-s7-core-85fc91a9.service","out":""}],"appEvents":["start","tray","start-daemon","connected"]}
- **the daemon side's Quit stops both**: {"bothDownMs":401,"restartedWithin8s":false}

### The pair · darwin-arm64 (pair-macos.json)

25.6.0, 34 s, state **done**

- **login start**: {"daemonUpMs":110,"daemonUp":true,"appConnectedMs":2440,"appStartedBy":"daemon","appStart":{"at":1793840692772,"safeMode":false,"reason":"daemon start","ok":true,"how":"open -n -g -a /Users/runner/work/clover/clover/spikes/s7-browser/prototype/node_modules/electron/dist/Electron.app --args /Users/runner/work/clover/clover/spikes/s7-browser/prototype/out/pair/app --home=/var/folders/h5/t85nd63d71x27_8gl5gw3l_w0000gn/T/clover-s7-pair-cMP0W0","out":""},"daemonParent":1}
- **second daemon on the same home**: {"exitCode":0,"ms":41,"said":"2026-11-05T01:04:53.079Z [core 1243] another daemon holds this home (flock: held by another process); exiting","firstStillServing":true}
- **app crash**: {"killed":1233,"kill":{"ok":true,"how":"kill -9 1233","code":0,"out":""},"restartedMs":1365,"newPid":1248,"startedBy":"daemon","safeMode":false,"how":"open -n -g -a /Users/runner/work/clover/clover/spikes/s7-browser/prototype/node_modules/electron/dist/Electron.app --args /Users/runner/work/clover/clover/spikes/s7-browser/prototype/out/pair/app --home=/var/folders/h5/t85nd63d71x27_8gl5gw3l_w0000gn/T/clover-s7-pair-cMP0W0","eventsSinceKill":["start","tray","connected"]}
- **app crash loop → safe mode**: {"rounds":[{"killed":1248,"restartedMs":2265,"safeMode":false,"crashesInDaemon":2},{"killed":1309,"restartedMs":4298,"safeMode":true,"crashesInDaemon":3}],"thirdRestartInSafeMode":true}
- **daemon crash, restarted by the OS alone**: {"killed":1226,"kill":{"ok":true,"how":"kill -9 1226","code":0,"out":""},"daemonBackMs":1204,"newDaemonPid":1338,"appSurvived":true,"appPidAfter":1335,"samePid":true,"appStartedTheDaemon":false,"appEvents":["2ms daemon-lost","506ms connected","506ms reconnected"]}
- **daemon crash, the app helps after 3 s**: {"killed":1338,"kill":{"ok":true,"how":"kill -9 1338","code":0,"out":""},"daemonBackMs":1207,"newDaemonPid":1342,"appSurvived":true,"appPidAfter":1335,"samePid":true,"appStartedTheDaemon":false,"appEvents":["1ms daemon-lost","508ms connected","508ms reconnected"]}
- **tray Quit stops both, and they stay down**: {"forwarded":{"forwarded":true},"bothDownMs":309,"restartedWithin12s":false,"appEvents":["quit","quit-acked"]}
- **a user starts the app → it starts the daemon**: {"start":{"ok":true,"how":"open -n -g -a /Users/runner/work/clover/clover/spikes/s7-browser/prototype/node_modules/electron/dist/Electron.app --args /Users/runner/work/clover/clover/spikes/s7-browser/prototype/out/pair/app --home=/var/folders/h5/t85nd63d71x27_8gl5gw3l_w0000gn/T/clover-s7-pair-cMP0W0","code":0,"out":""},"bothUpMs":646,"startedBy":"user","appStartedTheDaemon":[{"ok":true,"how":"launchctl kickstart gui/501/com.waifucave.clover.s7.core.b13eabfd","out":""}],"appEvents":["start","tray","start-daemon","connected"]}
- **the daemon side's Quit stops both**: {"bothDownMs":306,"restartedWithin8s":false}

### The pair · win32-x64 (pair-windows-spawn.json)

10.0.26100, 187 s, state **done**, Windows app start: spawn

- **login start**: {"daemonUpMs":340,"daemonUp":true,"appConnectedMs":2988,"appStartedBy":"daemon","appStart":{"at":1793840580796,"safeMode":false,"reason":"daemon start","ok":true,"how":"spawn detached","out":"4196"},"daemonParent":2600}
- **second daemon on the same home**: {"exitCode":0,"ms":80,"said":"2026-11-05T01:03:01.130Z [core 6476] another daemon holds this home (CreateFileW: error 32 (sharing violation: another daemon holds it)); exiting","firstStillServing":true}
- **app crash**: {"killed":4196,"kill":{"ok":true,"how":"taskkill /F /T /PID 4196","code":0,"out":"SUCCESS: The process with PID 8408 (child process of PID 4196) has been terminated.\r\nSUCCESS: The process with PID 4516 (child process of PID 4196) has been ter"},"restartedMs":1233,"newPid":6824,"startedBy":"daemon","safeMode":false,"how":"spawn detached","eventsSinceKill":["start","tray","connected"]}
- **app crash loop → safe mode**: {"rounds":[{"killed":6824,"restartedMs":2225,"safeMode":false,"crashesInDaemon":2},{"killed":1372,"restartedMs":4181,"safeMode":true,"crashesInDaemon":3}],"thirdRestartInSafeMode":true}
- **daemon crash, restarted by the OS alone**: {"killed":3100,"kill":{"ok":true,"how":"taskkill /F /PID 3100","code":0,"out":"SUCCESS: The process with PID 3100 has been terminated."},"appSurvived":true,"appPidAfter":2132,"samePid":true,"appStartedTheDaemon":{"atMs":150276,"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-69817e23"},"appEvents":["58ms daemon-lost","150276ms start-daemon","150780ms connected","150781ms reconnected"]}
- **daemon crash, the app helps after 3 s**: {"killed":8428,"kill":{"ok":true,"how":"taskkill /F /PID 8428","code":0,"out":"SUCCESS: The process with PID 8428 has been terminated."},"daemonBackMs":3303,"newDaemonPid":8716,"appSurvived":true,"appPidAfter":2132,"samePid":true,"appStartedTheDaemon":{"atMs":3141,"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-69817e23"},"appEvents":["94ms daemon-lost","3141ms start-daemon","3658ms connected","3659ms reconnected"]}
- **tray Quit stops both, and they stay down**: {"forwarded":{"forwarded":true},"bothDownMs":324,"restartedWithin12s":false,"appEvents":[]}
- **a user starts the app → it starts the daemon**: {"start":{"ok":true,"how":"spawn detached","code":0,"out":"4576"},"bothUpMs":565,"startedBy":"user","appStartedTheDaemon":[{"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-69817e23","out":"SUCCESS: Attempted to run the scheduled task \"\\Clover S7\\core-69817e23\"."}],"appEvents":["start","tray","start-daemon","connected"]}
- **the daemon side's Quit stops both**: {"bothDownMs":332,"restartedWithin8s":false}

### The pair · win32-x64 (pair-windows-supervise.json)

10.0.26100, 36 s, state **done**, Windows app start: task, daemon under the supervisor

- **login start**: {"daemonUpMs":433,"daemonUp":true,"appConnectedMs":3156,"appStartedBy":"daemon","appStart":{"at":1793840636697,"safeMode":false,"reason":"daemon start","ok":true,"how":"schtasks /Run /TN \\Clover S7\\app-793eb50f","out":"SUCCESS: Attempted to run the scheduled task \"\\Clover S7\\app-793eb50f\"."},"daemonParent":8448}
- **second daemon on the same home**: {"exitCode":0,"ms":90,"said":"2026-11-05T01:03:57.052Z [core 8560] another daemon holds this home (CreateFileW: error 32 (sharing violation: another daemon holds it)); exiting","firstStillServing":true}
- **app crash**: {"killed":7636,"kill":{"ok":true,"how":"taskkill /F /T /PID 7636","code":0,"out":"SUCCESS: The process with PID 6560 (child process of PID 7636) has been terminated.\r\nSUCCESS: The process with PID 3672 (child process of PID 7636) has been ter"},"restartedMs":1209,"newPid":7996,"startedBy":"daemon","safeMode":false,"how":"schtasks /Run /TN \\Clover S7\\app-793eb50f","eventsSinceKill":["start","tray","connected"]}
- **app crash loop → safe mode**: {"rounds":[{"killed":7996,"restartedMs":2168,"safeMode":false,"crashesInDaemon":2},{"killed":3780,"restartedMs":4267,"safeMode":true,"crashesInDaemon":3}],"thirdRestartInSafeMode":true}
- **daemon crash, restarted by the OS alone**: {"killed":7764,"kill":{"ok":true,"how":"taskkill /F /PID 7764","code":0,"out":"SUCCESS: The process with PID 7764 has been terminated."},"daemonBackMs":631,"newDaemonPid":5600,"appSurvived":true,"appPidAfter":892,"samePid":true,"appStartedTheDaemon":false,"appEvents":["57ms daemon-lost","1069ms connected","1069ms reconnected"]}
- **daemon crash, the app helps after 3 s**: {"killed":5600,"kill":{"ok":true,"how":"taskkill /F /PID 5600","code":0,"out":"SUCCESS: The process with PID 5600 has been terminated."},"daemonBackMs":1246,"newDaemonPid":5316,"appSurvived":true,"appPidAfter":892,"samePid":true,"appStartedTheDaemon":false,"appEvents":["60ms daemon-lost","1567ms connected","1567ms reconnected"]}
- **tray Quit stops both, and they stay down**: {"forwarded":{"forwarded":true},"bothDownMs":310,"restartedWithin12s":false,"appEvents":["quit","quit-acked"]}
- **a user starts the app → it starts the daemon**: {"start":{"ok":true,"how":"spawn detached","code":0,"out":"8412"},"bothUpMs":874,"startedBy":"user","appStartedTheDaemon":[{"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-793eb50f","out":"SUCCESS: Attempted to run the scheduled task \"\\Clover S7\\core-793eb50f\"."}],"appEvents":["start","tray","start-daemon","connected"]}
- **the daemon side's Quit stops both**: {"bothDownMs":337,"restartedWithin8s":false}

### The pair · win32-x64 (pair-windows-task.json)

10.0.26100, 187 s, state **done**, Windows app start: task

- **login start**: {"daemonUpMs":345,"daemonUp":true,"appConnectedMs":2723,"appStartedBy":"daemon","appStart":{"at":1793840582024,"safeMode":false,"reason":"daemon start","ok":true,"how":"schtasks /Run /TN \\Clover S7\\app-2e87d567","out":"SUCCESS: Attempted to run the scheduled task \"\\Clover S7\\app-2e87d567\"."},"daemonParent":2552}
- **second daemon on the same home**: {"exitCode":0,"ms":76,"said":"2026-11-05T01:03:02.379Z [core 6512] another daemon holds this home (CreateFileW: error 32 (sharing violation: another daemon holds it)); exiting","firstStillServing":true}
- **app crash**: {"killed":7988,"kill":{"ok":true,"how":"taskkill /F /T /PID 7988","code":0,"out":"SUCCESS: The process with PID 5988 (child process of PID 7988) has been terminated.\r\nSUCCESS: The process with PID 8796 (child process of PID 7988) has been ter"},"restartedMs":1205,"newPid":4208,"startedBy":"daemon","safeMode":false,"how":"schtasks /Run /TN \\Clover S7\\app-2e87d567","eventsSinceKill":["start","tray","connected"]}
- **app crash loop → safe mode**: {"rounds":[{"killed":4208,"restartedMs":2196,"safeMode":false,"crashesInDaemon":2},{"killed":1608,"restartedMs":4205,"safeMode":true,"crashesInDaemon":3}],"thirdRestartInSafeMode":true}
- **daemon crash, restarted by the OS alone**: {"killed":6740,"kill":{"ok":true,"how":"taskkill /F /PID 6740","code":0,"out":"SUCCESS: The process with PID 6740 has been terminated."},"appSurvived":true,"appPidAfter":1696,"samePid":true,"appStartedTheDaemon":{"atMs":150764,"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-2e87d567"},"appEvents":["57ms daemon-lost","150764ms start-daemon","151267ms connected","151267ms reconnected"]}
- **daemon crash, the app helps after 3 s**: {"killed":2032,"kill":{"ok":true,"how":"taskkill /F /PID 2032","code":0,"out":"SUCCESS: The process with PID 2032 has been terminated."},"daemonBackMs":3289,"newDaemonPid":7956,"appSurvived":true,"appPidAfter":1696,"samePid":true,"appStartedTheDaemon":{"atMs":3118,"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-2e87d567"},"appEvents":["88ms daemon-lost","3118ms start-daemon","3622ms connected","3622ms reconnected"]}
- **tray Quit stops both, and they stay down**: {"forwarded":{"forwarded":true},"bothDownMs":324,"restartedWithin12s":false,"appEvents":[]}
- **a user starts the app → it starts the daemon**: {"start":{"ok":true,"how":"spawn detached","code":0,"out":"8260"},"bothUpMs":551,"startedBy":"user","appStartedTheDaemon":[{"ok":true,"how":"schtasks /Run /TN \\Clover S7\\core-2e87d567","out":"SUCCESS: Attempted to run the scheduled task \"\\Clover S7\\core-2e87d567\"."}],"appEvents":["start","tray","start-daemon","connected"]}
- **the daemon side's Quit stops both**: {"bothDownMs":420,"restartedWithin8s":false}

