## Spike S7 results

### Electron · dialogs-linux-wayland (electron-viewport-linux-wayland-dialogs.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone wayland, displays 1920x1080@1, status **done**, 22 s

**Round twelve, JavaScript dialogs answered over CDP**

| tab | dialog | CDP event | browser handler | windows during | windows after | page | error |
| :- | :- | :- | :- | :- | :- | :- | :- |
| offscreen tab | alert | true | true | "no way to list windows here (Wayland or no display)" | "no way to list windows here (Wayland or no display)" | alert:"returned":102ms |  |
| offscreen tab | confirm | true | true | "no way to list windows here (Wayland or no display)" | "no way to list windows here (Wayland or no display)" | alert:"returned":102ms | confirm:true:26ms |  |
| offscreen tab | prompt | false | – | "no way to list windows here (Wayland or no display)" | "no way to list windows here (Wayland or no display)" | alert:"returned":102ms | confirm:true:26ms |  |
| host window tab | alert | true | true | "no way to list windows here (Wayland or no display)" | "no way to list windows here (Wayland or no display)" | alert:"returned":25ms |  |
| host window tab | confirm | true | true | "no way to list windows here (Wayland or no display)" | "no way to list windows here (Wayland or no display)" | alert:"returned":25ms | confirm:true:26ms |  |
| host window tab | prompt | false | – | "no way to list windows here (Wayland or no display)" | "no way to list windows here (Wayland or no display)" | alert:"returned":25ms | confirm:true:26ms |  |
| offscreen tab, disableDialogs | alert | true | true | "no way to list windows here (Wayland or no display)" | "no way to list windows here (Wayland or no display)" | alert:"returned":1ms | handle: No dialog is showing |
| offscreen tab, disableDialogs | confirm | true | true | "no way to list windows here (Wayland or no display)" | "no way to list windows here (Wayland or no display)" | alert:"returned":1ms | confirm:false:0ms | handle: No dialog is showing |
| offscreen tab, disableDialogs | prompt | false | – | "no way to list windows here (Wayland or no display)" | "no way to list windows here (Wayland or no display)" | alert:"returned":1ms | confirm:false:0ms |  |

**Assertions:** PASS CDP sees every alert and confirm, offscreen, in the host window and with disableDialogs

### Electron · viewport-linux-wayland (electron-viewport-linux-wayland.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone wayland, displays 1920x1080@1, status **done**, 160 s

**Round twelve, offscreen bot tabs** (never-shown OSR windows; GPU "disabled_software")

Size: default: window 1280x800, page 1280x800@1 → **default**.

Shared textures: 0 textures, 0 bitmaps, 0 empty paints in 3 s → **none here (CPU bitmaps)**; error not asked for: GPU compositing is "disabled_software" here (asking hung the main process on the Linux runners)

| config | visibility | rAF Hz | paints/s | textures/s | all CPU % | renderer % | GPU % | browser % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| offscreen, bitmap, 10 fps, animated | visible | 10.0 | 10.0 | 0.0 | 9.5 | 5.3 | 1.5 | 2.8 |  |
| offscreen, bitmap, 30 fps, animated | visible | 30.0 | 30.0 | 0.0 | 25.7 | 13.0 | 4.5 | 8.2 |  |
| offscreen, bitmap, 60 fps, animated | visible | 60.2 | 60.2 | 0.0 | 50.0 | 24.7 | 9.5 | 15.7 |  |
| offscreen, bitmap, 30 fps, painting stopped, animated | visible | 30.0 | 0.0 | 0.0 | 17.0 | 12.5 | 4.0 | 0.5 |  |
| offscreen, bitmap, 10 fps, quiet page | visible | 0.0 | 4.3 | 0.0 | 4.3 | 0.8 | 0.5 | 3.0 |  |
| offscreen, bitmap, painting stopped, quiet page | visible | 0.0 | 0.0 | 0.0 | 2.0 | 1.0 | 0.8 | 0.3 |  |
| host window, animated | visible | 40.0 | 0.0 | 0.0 | 20.0 | 16.2 | 2.0 | 1.8 |  |
| host window, quiet page | visible | 0.0 | 0.0 | 0.0 | 1.0 | 0.8 | 0.3 | 0.0 |  |

| pictures of | method | ok | ms | stale ms | size | errors |
| :- | :- | :- | :- | :- | :- | :- |
| offscreen, bitmap, painting on (10 fps) | capturePage | 5/5 | 97 / 97 | -81 / -40 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | cdpJpeg | 5/5 | 298 / 312 | -267 / -267 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | osrPaint | 5/5 | 0 / 1 | 38 / 43 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | newest paint → JPEG | 5/5 | 7 / 7 | – | 1280x800 |  |
| offscreen, bitmap, painting stopped | capturePage | 5/5 | 97 / 98 | -84 / -56 | 1280x800 |  |
| offscreen, bitmap, painting stopped | cdpJpeg | 5/5 | 299 / 312 | -270 / -268 | 1280x800 |  |
| host window | capturePage | 5/5 | 24 / 24 | 37 / 39 | 1280x800 |  |
| host window | cdpJpeg | 5/5 | 148 / 154 | -74 / -63 | 1280x800 |  |

| cost | MiB a tab | CPU % a tab | kind | error |
| :- | :- | :- | :- | :- |
| 4 quiet offscreen tabs (bitmap, 10 fps) | 42.8 | 2.62 | pss |  |
| 4 quiet offscreen tabs (bitmap), painting stopped | 9.8 | 1.50 | pss |  |
| 4 quiet tabs in one shared host window | 30.9 | 1.17 | pss |  |

Windows on screen: 4 offscreen tabs open (nothing else shown): no way to list windows here (Wayland or no display); 4 tabs in the shared host window: no way to list windows here (Wayland or no display)

**Round twelve, the viewport** (mode **bitmap**: no shared textures on this machine (GPU compositing "disabled_software"): CPU bitmaps)

Shows: #1 first frame 17 ms, at the viewport's size 27 ms (1000x700, frame 1000x700), hidden again 1 ms; #2 first frame 18 ms, at the viewport's size 32 ms (1000x700, frame 1000x700), hidden again 2 ms

| oracle | same document | timers | SSE socket | form | layout | detail |
| :- | :- | :- | :- | :- | :- | :- |
| shown (first time) | true | true | true | true | 1000x700@1 | token same, loads +0, navigations +0, ticks 15→21, sse opens 1 (server 1) msgs 14→21, field "typed by the bot", checked true |
| hidden again (the agent's 1280x800) | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 376→391, sse opens 1 (server 1) msgs 375→390, field "x日本s7-paste-ok", checked true |
| shown again | true | true | true | true | 1000x700@1 | token same, loads +0, navigations +0, ticks 391→400, sse opens 1 (server 1) msgs 390→398, field "x日本s7-paste-ok", checked true |
| hidden at the end | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 400→415, sse opens 1 (server 1) msgs 398→413, field "x日本s7-paste-ok", checked true |

| through the viewport | ok | ms | detail |
| :- | :- | :- | :- |
| mouse: a click lands where the person clicked | yes | 103 | {"at":"260,40","page":{"x":260,"y":40,"t":1793877674312},"forwarded":{"mouseMove":1,"mouseDown":1,"mouseUp":1}} |
| wheel: the page scrolls | yes | 322 | {"scrollY":450,"wheels":4,"forwardedWheels":4} |
| keys: typing, Backspace and select-all in the field | yes | 1217 | {"typed":"typed by the botabc","afterBackspace":"typed by the botab","afterSelectAllAndX":"x","focused":"field","pageHasFocus":true,"keys":["End","a","b","c","Backspace","x"]} |
| IME: a composition in the viewport is composed and committed in the page | yes | 860 | {"field":"x日本","midField":"xにほ","compositions":["start:","update:にほ","update:日本","update:日本","end:日本"],"forwarded":{"set":2,"commit":1,"text":0}} |
| paste: the person's paste reaches the page as a paste | yes | 934 | {"field":"x日本s7-paste-ok","pasteEvents":["s7-paste-ok"],"clipboard":"s7-paste-ok","forwarded":1} |
| select text: a mouse drag across the page's text selects it | yes | 758 | {"selection":"s7 select and copy this sentence please"} |
| copy: the copy key (⌘C, Ctrl+C) in the viewport copies the page's selection | yes | 32 | {"selection":"s7 select and copy this sentence please","clipboard":"s7 select and copy this sentence please","forwardedEdits":2} |
| copy: a right click on the selection, then the menu's Copy (webContents.copy) | yes | 85 | {"at":"660,240","selectionText":"s7 select and copy this sentence please","canCopy":true,"menuSourceType":"mouse","clipboard":"s7 select and copy this sentence please"} |
| <select>: it opens, and the keys choose an option | yes | 1596 | {"value":"c","changes":["c"],"popupTextures":0,"popupRects":["bitmap 180x146+480+48","bitmap 180x146+480+48","bitmap 180x146+480+48"],"viewerPopups":0,"viewerPopupSizes":[]} |
| cursor: the page's cursor reaches the viewport | yes | 1204 | {"events":["hand","text","crosshair","move"],"viewerCursors":["pointer","text","crosshair","move"]} |
| drag: an HTML5 drag inside the page, sent as plain mouse events | **no** | 1320 | {"page":["dragstart"]} |
| drag: the same, with the browser's drag handed to the viewport (CDP Input.setInterceptDrags) | yes | 1318 | {"page":["dragstart","dragenter","dragover","drop:s7-dragged","dragend:copy"],"intercepted":1,"dispatched":["dragEnter","dragOver","drop"]} |
| file chooser: answered with a file, no dialog | yes | 102 | {"choosers":[{"at":1793877684076,"mode":"selectSingle"}],"files":["s7-upload.txt:23:hello from the viewport"]} |
| a window the page opens: offscreen too, its opener kept, shown in the viewport and clicked | **no** | 3774 | {"offscreen":true,"visible":false,"size":"480x360","painting":true,"frameRate":30,"pageSize":"0x0","sameProcessAsOpener":true,"openerFramesOfTheChildSize":0,"paintsAfterRepaint":0,"pageState":"{\"clicks\":0,\"hasOpener\":true,\"loadedAt\":1793877684191}","directClick":false,"paints":0,"openerMessages":["popup:hello"],"clickedInViewport":false} |
| a cross-site window the page opens (Electron #55565): offscreen, its opener kept, shown in the viewport and clicked | yes | 5714 | {"offscreen":true,"visible":false,"size":"480x360","painting":true,"frameRate":30,"pageSize":"480x360","sameProcessAsOpener":false,"openerFramesOfTheChildSize":0,"paintsAfterRepaint":1,"pageState":"{\"clicks\":0,\"hasOpener\":true,\"loadedAt\":1793877687988}","directClick":true,"paints":5,"openerMessages":["popup:hello","popup:hello@other-site","popup:click@other-site","popup:click@other-site"],"clickedInViewport":true} |
| resize: the page reflows to the viewport, no reload | yes | 175 | {"oneMs":22,"quickThreeMs":23,"backMs":43,"resizes":["1793877693072:1000x700","1793877693632:800x560","1793877693674:900x620","1793877693722:760x520","1793877693755:820x580","1793877693774:1000x700"],"applied":["1793877693071:1000x700","1793877693631:800x560","1793877693673:900x620","1793877693714:760x520","1793877693738:820x580","1793877693773:1000x700"],"token":"same"} |
| find-in-page: matches found and drawn | yes | 6 | {"requestId":0,"matches":1,"selectionArea":{"x":202,"y":163,"width":32,"height":16},"activeMatchOrdinal":1,"finalUpdate":true} |
| DevTools: open on the offscreen tab (detached window) | yes | 731 | {"opened":true} |
| accessibility: the page's tree is there to read over CDP (the OS sees none of it) | yes | 5 | {"nodes":58,"button":true,"accessibilitySupport":false} |
| a 2x display: the device-metrics override at a scale of 2 gives the viewport 2x frames | **no** | 1604 | {"pageDpr":2,"layout":"1000x700","frame":"1000x700","viewerCanvas":"1000x700"} |
| the tab's webContents.focus(): does the hidden window take the OS focus from the viewport? | yes | 701 | {"viewerFocusedBefore":false,"after":false,"focusedWindow":"(none)","pageHasFocus":true,"tabVisible":false} |

| input → frame | trials | ms p50 / p95 | parts (p50) |
| :- | :- | :- | :- |
| viewport, mouse | 20 | 11 / 21 | to the page's handler 1; to the paint event 3; paint → drawn in the viewer 1; drawn → on screen (2 rAFs) 7 |
| viewport, key | 10 | 14 / 26 | to the page's handler 1; to the paint event 3; paint → drawn in the viewer 0; drawn → on screen (2 rAFs) 9 |
| native view, mouse | 20 | 9 / 14 | to the page's handler 0 |
| native view, key | 10 | 9 / 10 | to the page's handler 0 |

| frames | numbers |
| :- | :- |
| viewport, animated page | drawnPerSec 59.9, paintsPerSec 60.2, sentPerSec 60.2, droppedPerSec 0.0, pageRafPerSec 59.9, mbPerSec 58.8, drawMsP50 0.9, drawMsP95 1.2, cpuTotal 60.4, cpuBrowser 27.2, cpuGpu 6.0, cpuOffscreenRenderer 7.2, cpuViewerRenderer 19.5 |
| viewport, smooth scroll | ms 903.0, viewerFramesPerSec 62.0, pageRafPerSec 60.9 |
| native view, animated page | pageRafPerSec 39.5, cpuTotal 7.5, cpuBrowser 1.3, cpuGpu 2.3, cpuRenderer 3.8 |
| native view, smooth scroll | ms 901.0, pageRafPerSec 40.0 |

Windows on screen: a hidden offscreen tab and the viewer: no way to list windows here (Wayland or no display); a <select> open: no way to list windows here (Wayland or no display); a file chooser open: no way to list windows here (Wayland or no display); the page's window open (offscreen): no way to list windows here (Wayland or no display); the page's cross-site window open (offscreen): no way to list windows here (Wayland or no display)

Viewer: {"frames":523,"textures":0,"bitmaps":523,"popups":0,"draw":{"n":300,"min":0.8,"p50":0.9,"p95":2.5,"max":6.2,"mean":1.27},"errors":[]}; counters {"sent":523,"dropped":0,"fullFrames":4,"mbSent":533.83,"outstandingTextures":0,"forwarded":{"mouseMove":56,"mouseDown":33,"mouseUp":33,"mouseWheel":4,"keyDown":20,"keyUp":20,"char":14,"edit":2,"ime-start":1,"ime-set":2,"ime-commit":1,"paste":1},"errors":[],"tabTextures":0,"tabPopupTextures":0,"tabEmptyPaints":0,"tabPaints":529}

**Assertions:** PASS an offscreen tab draws with no window (CPU bitmaps asked at 30 fps: rAF above 10 Hz); PASS capturePage works on an offscreen tab; PASS no reload across show and hide through the viewport: same document, its timers, its socket, its form; PASS through the viewport: mouse: a click lands where the person clicked; PASS through the viewport: wheel: the page scrolls; PASS through the viewport: keys: typing, Backspace and select-all in the field; PASS through the viewport: IME: a composition in the viewport is composed and committed in the page; PASS through the viewport: paste: the person's paste reaches the page as a paste; PASS through the viewport: <select>: it opens, and the keys choose an option; PASS through the viewport: cursor: the page's cursor reaches the viewport; PASS through the viewport: drag: the same, with the browser's drag handed to the viewport (CDP Input.setInterceptDrags); PASS through the viewport: file chooser: answered with a file, no dialog; PASS through the viewport: resize: the page reflows to the viewport, no reload; PASS through the viewport: find-in-page: matches found and drawn; PASS through the viewport: DevTools: open on the offscreen tab (detached window); PASS through the viewport: accessibility: the page's tree is there to read over CDP (the OS sees none of it); PASS through the viewport: the tab's webContents.focus(): does the hidden window take the OS focus from the viewport?; PASS a known gap, pinned: an HTML5 drag sent as plain mouse events doesn't drop in an offscreen tab; PASS a known gap, pinned: a window the page opens, made offscreen, paints nothing; PASS the viewport draws an animated page at 45 fps or more

### Electron · dialogs-linux-x11 (electron-viewport-linux-x11-dialogs.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone x11, displays 1920x1080@1, status **done**, 23 s

**Round twelve, JavaScript dialogs answered over CDP**

| tab | dialog | CDP event | browser handler | windows during | windows after | page | error |
| :- | :- | :- | :- | :- | :- | :- | :- |
| offscreen tab | alert | true | true | ["4194306 120x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)"] | ["4194306 120x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)"] | alert:"returned":91ms |  |
| offscreen tab | confirm | true | true | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)"] | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)"] | alert:"returned":91ms | confirm:true:61ms |  |
| offscreen tab | prompt | false | – | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)"] | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)"] | alert:"returned":91ms | confirm:true:61ms |  |
| host window tab | alert | true | true | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","2097158 1x1+0+0 IsViewable \"S7 tiny t2\"","4194513 120x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)"] | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","2097158 1x1+0+0 IsViewable \"S7 tiny t2\"","4194513 120x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)"] | alert:"returned":76ms |  |
| host window tab | confirm | true | true | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","2097158 1x1+0+0 IsViewable \"S7 tiny t2\"","4194513 120x81+0+0 IsViewable (has no name)","4194600 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)","4194601 1x1+-1+-1 IsViewable (has no name)"] | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","2097158 1x1+0+0 IsViewable \"S7 tiny t2\"","4194513 120x81+0+0 IsViewable (has no name)","4194600 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)","4194601 1x1+-1+-1 IsViewable (has no name)"] | alert:"returned":76ms | confirm:true:86ms |  |
| host window tab | prompt | false | – | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","2097158 1x1+0+0 IsViewable \"S7 tiny t2\"","4194513 120x81+0+0 IsViewable (has no name)","4194600 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)","4194601 1x1+-1+-1 IsViewable (has no name)"] | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","2097158 1x1+0+0 IsViewable \"S7 tiny t2\"","4194513 120x81+0+0 IsViewable (has no name)","4194600 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)","4194601 1x1+-1+-1 IsViewable (has no name)"] | alert:"returned":76ms | confirm:true:86ms |  |
| offscreen tab, disableDialogs | alert | true | true | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","4194513 120x81+0+0 IsViewable (has no name)","4194600 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)","4194601 1x1+-1+-1 IsViewable (has no name)"] | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","4194513 120x81+0+0 IsViewable (has no name)","4194600 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)","4194601 1x1+-1+-1 IsViewable (has no name)"] | alert:"returned":0ms | handle: No dialog is showing |
| offscreen tab, disableDialogs | confirm | true | true | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","4194513 120x81+0+0 IsViewable (has no name)","4194600 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)","4194601 1x1+-1+-1 IsViewable (has no name)"] | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","4194513 120x81+0+0 IsViewable (has no name)","4194600 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)","4194601 1x1+-1+-1 IsViewable (has no name)"] | alert:"returned":0ms | confirm:false:0ms | handle: No dialog is showing |
| offscreen tab, disableDialogs | prompt | false | – | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","4194513 120x81+0+0 IsViewable (has no name)","4194600 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)","4194601 1x1+-1+-1 IsViewable (has no name)"] | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","4194513 120x81+0+0 IsViewable (has no name)","4194600 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)","4194601 1x1+-1+-1 IsViewable (has no name)"] | alert:"returned":0ms | confirm:false:0ms |  |

**Assertions:** PASS CDP sees every alert and confirm, offscreen, in the host window and with disableDialogs; PASS a known gap, pinned: an alert answered over CDP still leaves a native box up (offscreen tab); PASS a known gap, pinned: an alert answered over CDP still leaves a native box up (host window tab); PASS with disableDialogs an alert puts up no window

### Electron · viewport-linux-x11 (electron-viewport-linux-x11.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone x11, displays 1920x1080@1, status **done**, 157 s

**Round twelve, offscreen bot tabs** (never-shown OSR windows; GPU "disabled_software")

Size: default: window 1280x800, page 1280x800@1 → **default**.

Shared textures: 0 textures, 0 bitmaps, 0 empty paints in 3 s → **none here (CPU bitmaps)**; error not asked for: GPU compositing is "disabled_software" here (asking hung the main process on the Linux runners)

| config | visibility | rAF Hz | paints/s | textures/s | all CPU % | renderer % | GPU % | browser % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| offscreen, bitmap, 10 fps, animated | visible | 10.0 | 10.0 | 0.0 | 10.5 | 6.0 | 1.5 | 3.0 |  |
| offscreen, bitmap, 30 fps, animated | visible | 30.0 | 30.0 | 0.0 | 28.0 | 14.0 | 5.0 | 9.0 |  |
| offscreen, bitmap, 60 fps, animated | visible | 60.0 | 60.0 | 0.0 | 49.2 | 23.5 | 10.2 | 15.5 |  |
| offscreen, bitmap, 30 fps, painting stopped, animated | visible | 30.0 | 0.0 | 0.0 | 18.7 | 13.7 | 4.5 | 0.5 |  |
| offscreen, bitmap, 10 fps, quiet page | visible | 0.0 | 4.3 | 0.0 | 4.3 | 1.0 | 0.8 | 2.5 |  |
| offscreen, bitmap, painting stopped, quiet page | visible | 0.0 | 0.0 | 0.0 | 2.0 | 1.0 | 0.8 | 0.3 |  |
| host window, animated | visible | 60.1 | 0.0 | 0.0 | 23.2 | 21.5 | 1.8 | 0.0 |  |
| host window, quiet page | visible | 0.0 | 0.0 | 0.0 | 1.0 | 0.8 | 0.3 | 0.0 |  |

| pictures of | method | ok | ms | stale ms | size | errors |
| :- | :- | :- | :- | :- | :- | :- |
| offscreen, bitmap, painting on (10 fps) | capturePage | 5/5 | 97 / 98 | -82 / -46 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | cdpJpeg | 5/5 | 297 / 313 | -266 / -265 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | osrPaint | 5/5 | 0 / 1 | 39 / 44 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | newest paint → JPEG | 5/5 | 7 / 8 | – | 1280x800 |  |
| offscreen, bitmap, painting stopped | capturePage | 5/5 | 97 / 98 | -83 / -43 | 1280x800 |  |
| offscreen, bitmap, painting stopped | cdpJpeg | 5/5 | 299 / 312 | -269 / -269 | 1280x800 |  |
| host window | capturePage | 5/5 | 14 / 28 | 11 / 15 | 1280x800 |  |
| host window | cdpJpeg | 5/5 | 80 / 82 | -38 / -37 | 1280x800 |  |

| cost | MiB a tab | CPU % a tab | kind | error |
| :- | :- | :- | :- | :- |
| 4 quiet offscreen tabs (bitmap, 10 fps) | 55.4 | 2.83 | pss |  |
| 4 quiet offscreen tabs (bitmap), painting stopped | 29.9 | 1.56 | pss |  |
| 4 quiet tabs in one shared host window | 30.7 | 1.06 | pss |  |

Windows on screen: 4 offscreen tabs open (nothing else shown): 0 []; 4 tabs in the shared host window: 1 ["2097280 1x1+0+0 IsViewable \"S7 shared host\""]

**Round twelve, the viewport** (mode **bitmap**: no shared textures on this machine (GPU compositing "disabled_software"): CPU bitmaps)

Shows: #1 first frame 20 ms, at the viewport's size 31 ms (1000x700, frame 1000x700), hidden again 1 ms; #2 first frame 22 ms, at the viewport's size 35 ms (1000x700, frame 1000x700), hidden again 1 ms

| oracle | same document | timers | SSE socket | form | layout | detail |
| :- | :- | :- | :- | :- | :- | :- |
| shown (first time) | true | true | true | true | 1000x700@1 | token same, loads +0, navigations +0, ticks 15→21, sse opens 1 (server 1) msgs 14→21, field "typed by the bot", checked true |
| hidden again (the agent's 1280x800) | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 378→393, sse opens 1 (server 1) msgs 376→391, field "x日本s7-paste-ok", checked true |
| shown again | true | true | true | true | 1000x700@1 | token same, loads +0, navigations +0, ticks 393→402, sse opens 1 (server 1) msgs 391→400, field "x日本s7-paste-ok", checked true |
| hidden at the end | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 402→417, sse opens 1 (server 1) msgs 400→415, field "x日本s7-paste-ok", checked true |

| through the viewport | ok | ms | detail |
| :- | :- | :- | :- |
| mouse: a click lands where the person clicked | yes | 103 | {"at":"260,40","page":{"x":260,"y":40,"t":1793877663162},"forwarded":{"mouseMove":1,"mouseDown":1,"mouseUp":1}} |
| wheel: the page scrolls | yes | 324 | {"scrollY":600,"wheels":4,"forwardedWheels":4} |
| keys: typing, Backspace and select-all in the field | yes | 1215 | {"typed":"typed by the botabc","afterBackspace":"typed by the botab","afterSelectAllAndX":"x","focused":"field","pageHasFocus":true,"keys":["End","a","b","c","Backspace","x"]} |
| IME: a composition in the viewport is composed and committed in the page | yes | 859 | {"field":"x日本","midField":"xにほ","compositions":["start:","update:にほ","update:日本","update:日本","end:日本"],"forwarded":{"set":2,"commit":1,"text":0}} |
| paste: the person's paste reaches the page as a paste | yes | 934 | {"field":"x日本s7-paste-ok","pasteEvents":["s7-paste-ok"],"clipboard":"s7-paste-ok","forwarded":1} |
| select text: a mouse drag across the page's text selects it | yes | 758 | {"selection":"s7 select and copy this sentence please"} |
| copy: the copy key (⌘C, Ctrl+C) in the viewport copies the page's selection | yes | 32 | {"selection":"s7 select and copy this sentence please","clipboard":"s7 select and copy this sentence please","forwardedEdits":2} |
| copy: a right click on the selection, then the menu's Copy (webContents.copy) | yes | 87 | {"at":"660,240","selectionText":"s7 select and copy this sentence please","canCopy":true,"menuSourceType":"mouse","clipboard":"s7 select and copy this sentence please"} |
| <select>: it opens, and the keys choose an option | yes | 1636 | {"value":"c","changes":["c"],"popupTextures":0,"popupRects":["bitmap 180x146+480+48","bitmap 180x146+480+48","bitmap 180x146+480+48"],"viewerPopups":0,"viewerPopupSizes":[]} |
| cursor: the page's cursor reaches the viewport | yes | 1203 | {"events":["hand","text","crosshair","move"],"viewerCursors":["pointer","text","crosshair","move"]} |
| drag: an HTML5 drag inside the page, sent as plain mouse events | **no** | 1318 | {"page":["dragstart"]} |
| drag: the same, with the browser's drag handed to the viewport (CDP Input.setInterceptDrags) | yes | 1320 | {"page":["dragstart","dragenter","dragover","drop:s7-dragged","dragend:copy"],"intercepted":1,"dispatched":["dragEnter","dragOver","drop"]} |
| file chooser: answered with a file, no dialog | yes | 128 | {"choosers":[{"at":1793877672968,"mode":"selectSingle"}],"files":["s7-upload.txt:23:hello from the viewport"]} |
| a window the page opens: offscreen too, its opener kept, shown in the viewport and clicked | **no** | 3797 | {"offscreen":true,"visible":false,"size":"480x360","painting":true,"frameRate":30,"pageSize":"0x0","sameProcessAsOpener":true,"openerFramesOfTheChildSize":0,"paintsAfterRepaint":0,"pageState":"{\"clicks\":0,\"hasOpener\":true,\"loadedAt\":1793877673109}","directClick":false,"paints":0,"openerMessages":["popup:hello"],"clickedInViewport":false} |
| a cross-site window the page opens (Electron #55565): offscreen, its opener kept, shown in the viewport and clicked | yes | 5742 | {"offscreen":true,"visible":false,"size":"480x360","painting":true,"frameRate":30,"pageSize":"480x360","sameProcessAsOpener":false,"openerFramesOfTheChildSize":0,"paintsAfterRepaint":1,"pageState":"{\"clicks\":0,\"hasOpener\":true,\"loadedAt\":1793877676926}","directClick":true,"paints":6,"openerMessages":["popup:hello","popup:hello@other-site","popup:click@other-site","popup:click@other-site"],"clickedInViewport":true} |
| resize: the page reflows to the viewport, no reload | yes | 172 | {"oneMs":23,"quickThreeMs":43,"backMs":21,"resizes":["1793877682037:1000x700","1793877682600:800x560","1793877682634:900x620","1793877682677:760x520","1793877682718:820x580","1793877682751:1000x700"],"applied":["1793877682033:1000x700","1793877682598:800x560","1793877682625:900x620","1793877682675:760x520","1793877682709:820x580","1793877682746:1000x700"],"token":"same"} |
| find-in-page: matches found and drawn | yes | 8 | {"requestId":0,"matches":1,"selectionArea":{"x":202,"y":163,"width":32,"height":16},"activeMatchOrdinal":1,"finalUpdate":true} |
| DevTools: open on the offscreen tab (detached window) | yes | 728 | {"opened":true} |
| accessibility: the page's tree is there to read over CDP (the OS sees none of it) | yes | 5 | {"nodes":58,"button":true,"accessibilitySupport":false} |
| a 2x display: the device-metrics override at a scale of 2 gives the viewport 2x frames | **no** | 1603 | {"pageDpr":2,"layout":"1000x700","frame":"1000x700","viewerCanvas":"1000x700"} |
| the tab's webContents.focus(): does the hidden window take the OS focus from the viewport? | yes | 701 | {"viewerFocusedBefore":true,"after":true,"focusedWindow":"S7 viewport","pageHasFocus":true,"tabVisible":false} |

| input → frame | trials | ms p50 / p95 | parts (p50) |
| :- | :- | :- | :- |
| viewport, mouse | 20 | 14 / 31 | to the page's handler 1; to the paint event 3; paint → drawn in the viewer 1; drawn → on screen (2 rAFs) 10 |
| viewport, key | 10 | 12 / 17 | to the page's handler 1; to the paint event 4; paint → drawn in the viewer 0; drawn → on screen (2 rAFs) 8 |
| native view, mouse | 20 | 5 / 11 | to the page's handler 0 |
| native view, key | 10 | 16 / 18 | to the page's handler 0 |

| frames | numbers |
| :- | :- |
| viewport, animated page | drawnPerSec 60.0, paintsPerSec 60.0, sentPerSec 60.0, droppedPerSec 0.0, pageRafPerSec 60.0, mbPerSec 58.6, drawMsP50 1.0, drawMsP95 1.2, cpuTotal 56.2, cpuBrowser 26.2, cpuGpu 4.5, cpuOffscreenRenderer 6.8, cpuViewerRenderer 18.8 |
| viewport, smooth scroll | ms 904.0, viewerFramesPerSec 62.0, pageRafPerSec 60.8 |
| native view, animated page | pageRafPerSec 60.0, cpuTotal 8.8, cpuBrowser 0.3, cpuGpu 2.3, cpuRenderer 6.3 |
| native view, smooth scroll | ms 908.0, pageRafPerSec 60.6 |

Windows on screen: a hidden offscreen tab and the viewer: 1 ["2097287 1000x727+60+60 IsViewable \"S7 viewport\""]; a <select> open: 1 ["2097287 1000x727+60+60 IsViewable \"S7 viewport\""]; a file chooser open: 1 ["2097287 1000x727+60+60 IsViewable \"S7 viewport\""]; the page's window open (offscreen): 1 ["2097287 1000x727+60+60 IsViewable \"S7 viewport\""]; the page's cross-site window open (offscreen): 1 ["2097287 1000x727+60+60 IsViewable \"S7 viewport\""]

Viewer: {"frames":523,"textures":0,"bitmaps":523,"popups":0,"draw":{"n":300,"min":0.8,"p50":1,"p95":2.6,"max":8.4,"mean":1.34},"errors":[]}; counters {"sent":523,"dropped":0,"fullFrames":4,"mbSent":525.29,"outstandingTextures":0,"forwarded":{"mouseMove":56,"mouseDown":33,"mouseUp":33,"mouseWheel":4,"keyDown":20,"keyUp":20,"char":14,"edit":2,"ime-start":1,"ime-set":2,"ime-commit":1,"paste":1,"mouseLeave":2},"errors":[],"tabTextures":0,"tabPopupTextures":0,"tabEmptyPaints":0,"tabPaints":528}

**Assertions:** PASS an offscreen tab draws with no window (CPU bitmaps asked at 30 fps: rAF above 10 Hz); PASS capturePage works on an offscreen tab; PASS four offscreen tabs put no window on screen; PASS no reload across show and hide through the viewport: same document, its timers, its socket, its form; PASS through the viewport: mouse: a click lands where the person clicked; PASS through the viewport: wheel: the page scrolls; PASS through the viewport: keys: typing, Backspace and select-all in the field; PASS through the viewport: IME: a composition in the viewport is composed and committed in the page; PASS through the viewport: paste: the person's paste reaches the page as a paste; PASS through the viewport: <select>: it opens, and the keys choose an option; PASS through the viewport: cursor: the page's cursor reaches the viewport; PASS through the viewport: drag: the same, with the browser's drag handed to the viewport (CDP Input.setInterceptDrags); PASS through the viewport: file chooser: answered with a file, no dialog; PASS through the viewport: resize: the page reflows to the viewport, no reload; PASS through the viewport: find-in-page: matches found and drawn; PASS through the viewport: DevTools: open on the offscreen tab (detached window); PASS through the viewport: accessibility: the page's tree is there to read over CDP (the OS sees none of it); PASS through the viewport: the tab's webContents.focus(): does the hidden window take the OS focus from the viewport?; PASS a known gap, pinned: an HTML5 drag sent as plain mouse events doesn't drop in an offscreen tab; PASS a known gap, pinned: a window the page opens, made offscreen, paints nothing; PASS the viewport draws an animated page at 45 fps or more

### Electron · viewport-macos-bitmap (electron-viewport-macos-bitmap.json)

Electron 45.2.2 (Chromium 156.0.8078.80), darwin-arm64 25.6.0, ozone (default), displays 1024x768@1, status **done**, 60 s

**Round twelve, the viewport** (mode **bitmap**: forced by S7_VIEWPORT_MODE=bitmap)

Shows: #1 first frame 60 ms, at the viewport's size 160 ms (1000x645, frame 1000x645), hidden again 3 ms; #2 first frame 6 ms, at the viewport's size 45 ms (1000x645, frame 1000x645), hidden again 6 ms

| oracle | same document | timers | SSE socket | form | layout | detail |
| :- | :- | :- | :- | :- | :- | :- |
| shown (first time) | true | true | true | true | 1000x645@1 | token same, loads +0, navigations +0, ticks 14→23, sse opens 1 (server 1) msgs 14→22, field "typed by the bot", checked true |
| hidden again (the agent's 1280x800) | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 401→416, sse opens 1 (server 1) msgs 388→402, field "x日本s7-paste-ok", checked true |
| shown again | true | true | true | true | 1000x645@1 | token same, loads +0, navigations +0, ticks 416→425, sse opens 1 (server 1) msgs 402→411, field "x日本s7-paste-ok", checked true |
| hidden at the end | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 425→439, sse opens 1 (server 1) msgs 411→425, field "x日本s7-paste-ok", checked true |

| through the viewport | ok | ms | detail |
| :- | :- | :- | :- |
| mouse: a click lands where the person clicked | yes | 122 | {"at":"260,40","page":{"x":260,"y":40,"t":1793877882381},"forwarded":{"mouseMove":1,"mouseDown":1,"mouseUp":1}} |
| wheel: the page scrolls | yes | 335 | {"scrollY":600,"wheels":4,"forwardedWheels":4} |
| keys: typing, Backspace and select-all in the field | yes | 1241 | {"typed":"typed by the botabc","afterBackspace":"typed by the botab","afterSelectAllAndX":"x","focused":"field","pageHasFocus":true,"keys":["End","a","b","c","Backspace","x"]} |
| IME: a composition in the viewport is composed and committed in the page | yes | 892 | {"field":"x日本","midField":"xにほ","compositions":["start:","update:にほ","update:日本","update:日本","end:日本"],"forwarded":{"set":2,"commit":1,"text":0}} |
| paste: the person's paste reaches the page as a paste | yes | 948 | {"field":"x日本s7-paste-ok","pasteEvents":["s7-paste-ok"],"clipboard":"s7-paste-ok","forwarded":1} |
| select text: a mouse drag across the page's text selects it | yes | 783 | {"selection":"s7 select and copy this sentence please"} |
| copy: the copy key (⌘C, Ctrl+C) in the viewport copies the page's selection | yes | 38 | {"selection":"s7 select and copy this sentence please","clipboard":"s7 select and copy this sentence please","forwardedEdits":2} |
| copy: a right click on the selection, then the menu's Copy (webContents.copy) | yes | 92 | {"at":"660,240","selectionText":"s7 select and copy this sentence please","canCopy":true,"menuSourceType":"mouse","clipboard":"s7 select and copy this sentence please"} |
| <select>: it opens, and the keys choose an option | yes | 1704 | {"value":"c","changes":["c"],"popupTextures":0,"popupRects":["bitmap 180x146+480+48","bitmap 180x146+480+48","bitmap 180x146+480+48"],"viewerPopups":0,"viewerPopupSizes":[]} |
| cursor: the page's cursor reaches the viewport | yes | 1213 | {"events":["hand","text","crosshair","move"],"viewerCursors":["pointer","text","crosshair","move"]} |
| drag: an HTML5 drag inside the page, sent as plain mouse events | **no** | 1357 | {"page":["dragstart"]} |
| drag: the same, with the browser's drag handed to the viewport (CDP Input.setInterceptDrags) | yes | 1361 | {"page":["dragstart","dragenter","dragover","drop:s7-dragged","dragend:copy"],"intercepted":1,"dispatched":["dragEnter","dragOver","drop"]} |
| file chooser: answered with a file, no dialog | yes | 183 | {"choosers":[{"at":1793877892483,"mode":"selectSingle"}],"files":["s7-upload.txt:23:hello from the viewport"]} |
| a window the page opens: offscreen too, its opener kept, shown in the viewport and clicked | **no** | 3925 | {"offscreen":true,"visible":false,"size":"480x360","painting":true,"frameRate":30,"pageSize":"0x0","sameProcessAsOpener":true,"openerFramesOfTheChildSize":0,"paintsAfterRepaint":0,"pageState":"{\"clicks\":0,\"hasOpener\":true,\"loadedAt\":1793877892741}","directClick":false,"paints":0,"openerMessages":["popup:hello"],"clickedInViewport":false} |
| a cross-site window the page opens (Electron #55565): offscreen, its opener kept, shown in the viewport and clicked | yes | 6035 | {"offscreen":true,"visible":false,"size":"480x360","painting":true,"frameRate":30,"pageSize":"480x360","sameProcessAsOpener":false,"openerFramesOfTheChildSize":0,"paintsAfterRepaint":1,"pageState":"{\"clicks\":0,\"hasOpener\":true,\"loadedAt\":1793877896868}","directClick":true,"paints":6,"openerMessages":["popup:hello","popup:hello@other-site","popup:click@other-site","popup:click@other-site"],"clickedInViewport":true} |
| resize: the page reflows to the viewport, no reload | yes | 594 | {"oneMs":88,"quickThreeMs":337,"backMs":71,"resizes":["1793877902016:1000x645","1793877902619:800x560","1793877902702:900x620","1793877902735:760x520","1793877903037:820x580","1793877903124:1000x645"],"applied":["1793877902014:1000x645","1793877902608:800x560","1793877902687:900x620","1793877902727:760x520","1793877903033:820x580","1793877903122:1000x645"],"token":"same"} |
| find-in-page: matches found and drawn | yes | 3 | {"requestId":0,"matches":1,"selectionArea":{"x":202,"y":163,"width":30,"height":17},"activeMatchOrdinal":1,"finalUpdate":true} |
| DevTools: open on the offscreen tab (detached window) | yes | 956 | {"opened":true} |
| accessibility: the page's tree is there to read over CDP (the OS sees none of it) | yes | 7 | {"nodes":58,"button":true,"accessibilitySupport":false} |
| a 2x display: the device-metrics override at a scale of 2 gives the viewport 2x frames | **no** | 1607 | {"pageDpr":2,"layout":"1000x645","frame":"1000x645","viewerCanvas":"1000x645"} |
| the tab's webContents.focus(): does the hidden window take the OS focus from the viewport? | yes | 719 | {"viewerFocusedBefore":true,"after":true,"focusedWindow":"S7 viewport","pageHasFocus":true,"tabVisible":false} |

| input → frame | trials | ms p50 / p95 | parts (p50) |
| :- | :- | :- | :- |
| viewport, mouse | 20 | 25 / 40 | to the page's handler 1; to the paint event 13; paint → drawn in the viewer 1; drawn → on screen (2 rAFs) 12 |
| viewport, key | 10 | 26 / 54 | to the page's handler 1; to the paint event 15; paint → drawn in the viewer 1; drawn → on screen (2 rAFs) 13 |
| native view, mouse | 20 | 8 / 20 | to the page's handler 1 |
| native view, key | 10 | 8 / 24 | to the page's handler 1 |

| frames | numbers |
| :- | :- |
| viewport, animated page | drawnPerSec 60.2, paintsPerSec 60.2, sentPerSec 60.2, droppedPerSec 0.0, pageRafPerSec 60.0, mbPerSec 58.8, drawMsP50 0.5, drawMsP95 1.2, cpuTotal 59.5, cpuBrowser 13.3, cpuGpu 26.6, cpuOffscreenRenderer 6.2, cpuViewerRenderer 13.2 |
| viewport, smooth scroll | ms 909.0, viewerFramesPerSec 61.6, pageRafPerSec 60.5 |
| native view, animated page | pageRafPerSec 60.2, cpuTotal 24.1, cpuBrowser 1.1, cpuGpu 13.6, cpuRenderer 8.9 |
| native view, smooth scroll | ms 928.0, pageRafPerSec 60.3 |

Windows on screen: a hidden offscreen tab and the viewer: 1 ["layer 0 alpha 1 1000x677+24+31 \"S7 viewport\""]; a <select> open: 1 ["layer 0 alpha 1 1000x677+24+31 \"S7 viewport\""]; a file chooser open: 1 ["layer 0 alpha 1 1000x677+24+31 \"S7 viewport\""]; the page's window open (offscreen): 1 ["layer 0 alpha 1 1000x677+24+31 \"S7 viewport\""]; the page's cross-site window open (offscreen): 1 ["layer 0 alpha 1 1000x677+24+31 \"S7 viewport\""]

Viewer: {"frames":482,"textures":0,"bitmaps":482,"popups":0,"draw":{"n":300,"min":0.3,"p50":0.6,"p95":1.5,"max":2.8,"mean":0.78},"errors":[]}; counters {"sent":482,"dropped":1,"fullFrames":5,"mbSent":490.78,"outstandingTextures":0,"forwarded":{"mouseMove":56,"mouseDown":33,"mouseUp":33,"mouseWheel":4,"keyDown":20,"keyUp":20,"char":14,"edit":2,"ime-start":1,"ime-set":2,"ime-commit":1,"paste":1},"errors":[],"tabTextures":0,"tabPopupTextures":0,"tabEmptyPaints":0,"tabPaints":486}

**Assertions:** PASS no reload across show and hide through the viewport: same document, its timers, its socket, its form; PASS through the viewport: mouse: a click lands where the person clicked; PASS through the viewport: wheel: the page scrolls; PASS through the viewport: keys: typing, Backspace and select-all in the field; PASS through the viewport: IME: a composition in the viewport is composed and committed in the page; PASS through the viewport: paste: the person's paste reaches the page as a paste; PASS through the viewport: <select>: it opens, and the keys choose an option; PASS through the viewport: cursor: the page's cursor reaches the viewport; PASS through the viewport: drag: the same, with the browser's drag handed to the viewport (CDP Input.setInterceptDrags); PASS through the viewport: file chooser: answered with a file, no dialog; PASS through the viewport: resize: the page reflows to the viewport, no reload; PASS through the viewport: find-in-page: matches found and drawn; PASS through the viewport: DevTools: open on the offscreen tab (detached window); PASS through the viewport: accessibility: the page's tree is there to read over CDP (the OS sees none of it); PASS through the viewport: the tab's webContents.focus(): does the hidden window take the OS focus from the viewport?; PASS a known gap, pinned: an HTML5 drag sent as plain mouse events doesn't drop in an offscreen tab; PASS a known gap, pinned: a window the page opens, made offscreen, paints nothing

### Electron · dialogs-macos (electron-viewport-macos-dialogs.json)

Electron 45.2.2 (Chromium 156.0.8078.80), darwin-arm64 25.6.0, ozone (default), displays 1024x768@1, status **done**, 26 s

**Round twelve, JavaScript dialogs answered over CDP**

| tab | dialog | CDP event | browser handler | windows during | windows after | page | error |
| :- | :- | :- | :- | :- | :- | :- | :- |
| offscreen tab | alert | true | true | ["layer 0 alpha 1 260x96+382+321","layer 0 alpha 1 1024x677+0+31 \"S7 viewport page\""] | ["layer 0 alpha 1 260x96+382+321","layer 0 alpha 1 1024x677+0+31 \"S7 viewport page\""] | alert:"returned":233ms |  |
| offscreen tab | confirm | true | true | ["layer 0 alpha 1 260x96+382+321","layer 0 alpha 1 1024x677+0+31 \"S7 viewport page\""] | ["layer 0 alpha 1 260x96+382+321","layer 0 alpha 1 1024x677+0+31 \"S7 viewport page\""] | alert:"returned":233ms | confirm:true:129ms |  |
| offscreen tab | prompt | false | – | ["layer 0 alpha 1 260x96+382+321","layer 0 alpha 1 1024x677+0+31 \"S7 viewport page\""] | ["layer 0 alpha 1 260x96+382+321","layer 0 alpha 1 1024x677+0+31 \"S7 viewport page\""] | alert:"returned":233ms | confirm:true:129ms |  |
| host window tab | alert | true | true | ["layer 0 alpha 1 260x96+0+31","layer 0 alpha 0 1x1+129+31 \"S7 tiny t2\""] | ["layer 0 alpha 1 260x96+0+31","layer 0 alpha 0 1x1+129+31 \"S7 tiny t2\""] | alert:"returned":183ms |  |
| host window tab | confirm | true | true | ["layer 0 alpha 1 260x96+0+31","layer 0 alpha 0 1x1+129+31 \"S7 tiny t2\""] | ["layer 0 alpha 1 260x96+0+31","layer 0 alpha 0 1x1+129+31 \"S7 tiny t2\""] | alert:"returned":183ms | confirm:true:114ms |  |
| host window tab | prompt | false | – | ["layer 0 alpha 1 260x96+0+31","layer 0 alpha 0 1x1+129+31 \"S7 tiny t2\""] | ["layer 0 alpha 1 260x96+0+31","layer 0 alpha 0 1x1+129+31 \"S7 tiny t2\""] | alert:"returned":183ms | confirm:true:114ms |  |
| offscreen tab, disableDialogs | alert | true | true | [] | [] | alert:"returned":0ms | handle: No dialog is showing |
| offscreen tab, disableDialogs | confirm | true | true | [] | [] | alert:"returned":0ms | confirm:false:1ms | handle: No dialog is showing |
| offscreen tab, disableDialogs | prompt | false | – | [] | [] | alert:"returned":0ms | confirm:false:1ms |  |

**Assertions:** PASS CDP sees every alert and confirm, offscreen, in the host window and with disableDialogs; PASS a known gap, pinned: an alert answered over CDP still leaves a native box up (offscreen tab); PASS a known gap, pinned: an alert answered over CDP still leaves a native box up (host window tab); PASS with disableDialogs an alert puts up no window

### Electron · viewport-macos (electron-viewport-macos.json)

Electron 45.2.2 (Chromium 156.0.8078.80), darwin-arm64 25.6.0, ozone (default), displays 1024x768@1, status **done**, 220 s

**Round twelve, offscreen bot tabs** (never-shown OSR windows; GPU "enabled")

Size: default: window 1280x800, page 1280x800@1 → **default**.

Shared textures: 38 textures, 0 bitmaps, 0 empty paints in 3 s → **they come here** — {"pixelFormat":"bgra","codedSize":"1280x800","handle":["ioSurface"]}

| config | visibility | rAF Hz | paints/s | textures/s | all CPU % | renderer % | GPU % | browser % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| offscreen, texture, 10 fps, animated | visible | 9.5 | 9.7 | 9.7 | 9.5 | 2.9 | 5.9 | 0.7 |  |
| offscreen, texture, 30 fps, animated | visible | 17.7 | 17.5 | 17.5 | 10.9 | 3.4 | 6.7 | 0.8 |  |
| offscreen, texture, 60 fps, animated | visible | 27.2 | 27.2 | 27.2 | 13.6 | 4.0 | 8.5 | 1.0 |  |
| offscreen, texture, 30 fps, painting stopped, animated | visible | 16.2 | 0.0 | 0.0 | 10.4 | 3.8 | 6.3 | 0.3 |  |
| offscreen, texture, 10 fps, quiet page | visible | 0.0 | 2.8 | 2.8 | 2.1 | 0.6 | 1.3 | 0.3 |  |
| offscreen, texture, painting stopped, quiet page | visible | 0.0 | 0.0 | 0.0 | 2.0 | 0.8 | 0.9 | 0.3 |  |
| offscreen, bitmap, 10 fps, animated | visible | 9.7 | 9.5 | 0.0 | 14.5 | 4.0 | 7.2 | 3.3 |  |
| offscreen, bitmap, 30 fps, animated | visible | 17.2 | 17.2 | 0.0 | 25.4 | 5.4 | 11.8 | 8.1 |  |
| offscreen, bitmap, 60 fps, animated | visible | 35.4 | 35.7 | 0.0 | 40.6 | 8.2 | 18.6 | 13.7 |  |
| offscreen, bitmap, 30 fps, painting stopped, animated | visible | 18.2 | 0.0 | 0.0 | 14.0 | 4.8 | 8.8 | 0.3 |  |
| offscreen, bitmap, 10 fps, quiet page | visible | 0.0 | 1.8 | 0.0 | 3.4 | 0.5 | 1.0 | 1.9 |  |
| offscreen, bitmap, painting stopped, quiet page | visible | 0.0 | 0.0 | 0.0 | 2.6 | 0.8 | 1.1 | 0.8 |  |
| host window, animated | visible | 58.1 | 0.0 | 0.0 | 28.4 | 10.4 | 17.7 | 0.3 |  |
| host window, quiet page | visible | 0.0 | 0.0 | 0.0 | 3.0 | 0.6 | 1.7 | 0.7 |  |

| pictures of | method | ok | ms | stale ms | size | errors |
| :- | :- | :- | :- | :- | :- | :- |
| offscreen, texture, painting on (10 fps) | capturePage | 5/5 | 97 / 157 | 120 / 170 | 1280x800 |  |
| offscreen, texture, painting on (10 fps) | cdpJpeg | 5/5 | 508 / 592 | -263 / -251 | 1280x800 |  |
| offscreen, texture, painting stopped | capturePage | 5/5 | 102 / 142 | -79 / 6 | 1280x800 |  |
| offscreen, texture, painting stopped | cdpJpeg | 5/5 | 353 / 442 | -229 / -159 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | capturePage | 5/5 | 88 / 104 | 11 / 19 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | cdpJpeg | 5/5 | 400 / 414 | -282 / -154 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | osrPaint | 5/5 | 0 / 1 | 217 / 222 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | newest paint → JPEG | 5/5 | 7 / 8 | – | 1280x800 |  |
| offscreen, bitmap, painting stopped | capturePage | 5/5 | 89 / 117 | -71 / -38 | 1280x800 |  |
| offscreen, bitmap, painting stopped | cdpJpeg | 5/5 | 404 / 420 | -254 / -191 | 1280x800 |  |
| host window | capturePage | 5/5 | 18 / 23 | 14 / 15 | 1280x800 |  |
| host window | cdpJpeg | 5/5 | 88 / 91 | -42 / -34 | 1280x800 |  |

| cost | MiB a tab | CPU % a tab | kind | error |
| :- | :- | :- | :- | :- |
| 4 quiet offscreen tabs (texture, 10 fps) | 30.7 | 1.44 | footprint |  |
| 4 quiet offscreen tabs (texture), painting stopped | 38.1 | 1.57 | footprint |  |
| 4 quiet tabs in one shared host window | 35.3 | 1.91 | footprint |  |

Windows on screen: 4 offscreen tabs open (nothing else shown): 0 []; 4 tabs in the shared host window: 1 ["layer 0 alpha 0 1x1+0+31 \"S7 shared host\""]

**Round twelve, the viewport** (mode **texture**: shared textures come on this machine)

Shows: #1 first frame 53 ms, at the viewport's size 78 ms (1000x645, frame 1000x645), hidden again 13 ms; #2 first frame 80 ms, at the viewport's size 80 ms (1000x645, frame 1000x645), hidden again 2 ms

| oracle | same document | timers | SSE socket | form | layout | detail |
| :- | :- | :- | :- | :- | :- | :- |
| shown (first time) | true | true | true | true | 1000x645@1 | token same, loads +0, navigations +0, ticks 16→24, sse opens 1 (server 1) msgs 13→21, field "typed by the bot", checked true |
| hidden again (the agent's 1280x800) | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 394→409, sse opens 1 (server 1) msgs 387→402, field "x日本s7-paste-ok", checked true |
| shown again | true | true | true | true | 1000x645@1 | token same, loads +0, navigations +0, ticks 409→418, sse opens 1 (server 1) msgs 402→411, field "x日本s7-paste-ok", checked true |
| hidden at the end | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 418→433, sse opens 1 (server 1) msgs 411→425, field "x日本s7-paste-ok", checked true |

| through the viewport | ok | ms | detail |
| :- | :- | :- | :- |
| mouse: a click lands where the person clicked | yes | 115 | {"at":"260,40","page":{"x":260,"y":40,"t":1793877792781},"forwarded":{"mouseMove":1,"mouseDown":1,"mouseUp":1}} |
| wheel: the page scrolls | yes | 332 | {"scrollY":600,"wheels":4,"forwardedWheels":4} |
| keys: typing, Backspace and select-all in the field | yes | 1256 | {"typed":"typed by the botabc","afterBackspace":"typed by the botab","afterSelectAllAndX":"x","focused":"field","pageHasFocus":true,"keys":["End","a","b","c","Backspace","x"]} |
| IME: a composition in the viewport is composed and committed in the page | yes | 1323 | {"field":"x日本","midField":"xにほ","compositions":["start:","update:にほ","update:日本","update:日本","end:日本"],"forwarded":{"set":2,"commit":1,"text":0}} |
| paste: the person's paste reaches the page as a paste | yes | 945 | {"field":"x日本s7-paste-ok","pasteEvents":["s7-paste-ok"],"clipboard":"s7-paste-ok","forwarded":1} |
| select text: a mouse drag across the page's text selects it | yes | 773 | {"selection":"s7 select and copy this sentence please"} |
| copy: the copy key (⌘C, Ctrl+C) in the viewport copies the page's selection | yes | 36 | {"selection":"s7 select and copy this sentence please","clipboard":"s7 select and copy this sentence please","forwardedEdits":2} |
| copy: a right click on the selection, then the menu's Copy (webContents.copy) | yes | 93 | {"at":"660,240","selectionText":"s7 select and copy this sentence please","canCopy":true,"menuSourceType":"mouse","clipboard":"s7 select and copy this sentence please"} |
| <select>: it opens, and the keys choose an option | yes | 1684 | {"value":"c","changes":["c"],"popupTextures":4,"popupRects":["popup 180x146+0+0","popup 180x146+0+0"],"viewerPopups":3,"viewerPopupSizes":["180x146","180x146","180x146"]} |
| cursor: the page's cursor reaches the viewport | yes | 1215 | {"events":["hand","text","crosshair","move"],"viewerCursors":["pointer","text","crosshair","move"]} |
| drag: an HTML5 drag inside the page, sent as plain mouse events | **no** | 1357 | {"page":["dragstart"]} |
| drag: the same, with the browser's drag handed to the viewport (CDP Input.setInterceptDrags) | yes | 1339 | {"page":["dragstart","dragenter","dragover","drop:s7-dragged","dragend:copy"],"intercepted":1,"dispatched":["dragEnter","dragOver","drop"]} |
| file chooser: answered with a file, no dialog | yes | 229 | {"choosers":[{"at":1793877803311,"mode":"selectSingle"}],"files":["s7-upload.txt:23:hello from the viewport"]} |
| a window the page opens: offscreen too, its opener kept, shown in the viewport and clicked | **no** | 4059 | {"offscreen":true,"visible":false,"size":"480x360","painting":true,"frameRate":30,"pageSize":"0x0","sameProcessAsOpener":true,"openerFramesOfTheChildSize":0,"paintsAfterRepaint":0,"pageState":"{\"clicks\":0,\"hasOpener\":true,\"loadedAt\":1793877803749}","directClick":false,"paints":0,"openerMessages":["popup:hello"],"clickedInViewport":false} |
| a cross-site window the page opens (Electron #55565): offscreen, its opener kept, shown in the viewport and clicked | yes | 5910 | {"offscreen":true,"visible":false,"size":"480x360","painting":true,"frameRate":30,"pageSize":"480x360","sameProcessAsOpener":false,"openerFramesOfTheChildSize":0,"paintsAfterRepaint":1,"pageState":"{\"clicks\":0,\"hasOpener\":true,\"loadedAt\":1793877807764}","directClick":true,"paints":5,"openerMessages":["popup:hello","popup:hello@other-site","popup:click@other-site","popup:click@other-site"],"clickedInViewport":true} |
| resize: the page reflows to the viewport, no reload | yes | 318 | {"oneMs":92,"quickThreeMs":64,"backMs":68,"resizes":["1793877812894:1000x645","1793877813452:800x560","1793877813567:900x620","1793877813617:760x520","1793877813640:820x580","1793877813703:1000x645"],"applied":["1793877812890:1000x645","1793877813451:800x560","1793877813546:900x620","1793877813587:760x520","1793877813632:820x580","1793877813702:1000x645"],"token":"same"} |
| find-in-page: matches found and drawn | yes | 2 | {"requestId":0,"matches":1,"selectionArea":{"x":202,"y":163,"width":30,"height":17},"activeMatchOrdinal":1,"finalUpdate":true} |
| DevTools: open on the offscreen tab (detached window) | yes | 1205 | {"opened":true} |
| accessibility: the page's tree is there to read over CDP (the OS sees none of it) | yes | 16 | {"nodes":58,"button":true,"accessibilitySupport":false} |
| a 2x display: the device-metrics override at a scale of 2 gives the viewport 2x frames | **no** | 1604 | {"pageDpr":2,"layout":"1000x645","frame":"1000x645","viewerCanvas":"1000x645"} |
| the tab's webContents.focus(): does the hidden window take the OS focus from the viewport? | yes | 710 | {"viewerFocusedBefore":true,"after":true,"focusedWindow":"S7 viewport","pageHasFocus":true,"tabVisible":false} |

| input → frame | trials | ms p50 / p95 | parts (p50) |
| :- | :- | :- | :- |
| viewport, mouse | 20 | 27 / 31 | to the page's handler 1; to the paint event 12; paint → drawn in the viewer 1; drawn → on screen (2 rAFs) 12 |
| viewport, key | 10 | 15 / 28 | to the page's handler 1; to the paint event 8; paint → drawn in the viewer 1; drawn → on screen (2 rAFs) 6 |
| native view, mouse | 20 | 11 / 18 | to the page's handler 1 |
| native view, key | 10 | 9 / 20 | to the page's handler 0 |

| frames | numbers |
| :- | :- |
| viewport, animated page | drawnPerSec 59.8, paintsPerSec 60.0, sentPerSec 59.8, droppedPerSec 0.3, pageRafPerSec 60.0, mbPerSec 0.0, drawMsP50 0.6, drawMsP95 1.4, cpuTotal 80.4, cpuBrowser 12.3, cpuGpu 46.1, cpuOffscreenRenderer 8.8, cpuViewerRenderer 13.1 |
| viewport, smooth scroll | ms 917.0, viewerFramesPerSec 62.2, pageRafPerSec 61.1 |
| native view, animated page | pageRafPerSec 59.9, cpuTotal 20.9, cpuBrowser 0.6, cpuGpu 12.5, cpuRenderer 7.4 |
| native view, smooth scroll | ms 930.0, pageRafPerSec 60.2 |

Windows on screen: a hidden offscreen tab and the viewer: 1 ["layer 0 alpha 1 1000x677+24+31 \"S7 viewport\""]; a <select> open: 1 ["layer 0 alpha 1 1000x677+24+31 \"S7 viewport\""]; a file chooser open: 1 ["layer 0 alpha 1 1000x677+24+31 \"S7 viewport\""]; the page's window open (offscreen): 1 ["layer 0 alpha 1 1000x677+24+31 \"S7 viewport\""]; the page's cross-site window open (offscreen): 1 ["layer 0 alpha 1 1000x677+24+31 \"S7 viewport\""]

Viewer: {"frames":445,"textures":445,"bitmaps":0,"popups":3,"draw":{"n":300,"min":0.1,"p50":0.4,"p95":1.4,"max":4.5,"mean":0.56},"errors":[]}; counters {"sent":448,"dropped":2,"fullFrames":0,"mbSent":0,"outstandingTextures":0,"forwarded":{"mouseMove":56,"mouseDown":33,"mouseUp":33,"mouseWheel":4,"keyDown":20,"keyUp":20,"char":14,"edit":2,"ime-start":1,"ime-set":2,"ime-commit":1,"paste":1},"errors":[],"tabTextures":452,"tabPopupTextures":4,"tabEmptyPaints":0,"tabPaints":456}

**Assertions:** PASS an offscreen tab draws with no window (CPU bitmaps asked at 30 fps: rAF above 10 Hz); PASS capturePage works on an offscreen tab; PASS four offscreen tabs put no window on screen; PASS macOS: shared textures come (GPU compositing on); PASS no reload across show and hide through the viewport: same document, its timers, its socket, its form; PASS through the viewport: mouse: a click lands where the person clicked; PASS through the viewport: wheel: the page scrolls; PASS through the viewport: keys: typing, Backspace and select-all in the field; PASS through the viewport: IME: a composition in the viewport is composed and committed in the page; PASS through the viewport: paste: the person's paste reaches the page as a paste; PASS through the viewport: <select>: it opens, and the keys choose an option; PASS through the viewport: cursor: the page's cursor reaches the viewport; PASS through the viewport: drag: the same, with the browser's drag handed to the viewport (CDP Input.setInterceptDrags); PASS through the viewport: file chooser: answered with a file, no dialog; PASS through the viewport: resize: the page reflows to the viewport, no reload; PASS through the viewport: find-in-page: matches found and drawn; PASS through the viewport: DevTools: open on the offscreen tab (detached window); PASS through the viewport: accessibility: the page's tree is there to read over CDP (the OS sees none of it); PASS through the viewport: the tab's webContents.focus(): does the hidden window take the OS focus from the viewport?; PASS a known gap, pinned: an HTML5 drag sent as plain mouse events doesn't drop in an offscreen tab; PASS a known gap, pinned: a window the page opens, made offscreen, paints nothing; PASS the viewport draws an animated page at 45 fps or more

### Electron · dialogs-windows (electron-viewport-windows-dialogs.json)

Electron 45.2.2 (Chromium 156.0.8078.80), win32-x64 10.0.26100, ozone (default), displays 1024x768@1, status **done**, 32 s

**Round twelve, JavaScript dialogs answered over CDP**

| tab | dialog | CDP event | browser handler | windows during | windows after | page | error |
| :- | :- | :- | :- | :- | :- | :- | :- |
| offscreen tab | alert | true | true | ["#32770 366x125+321+270 ex 0x10101 \"Electron\""] | ["#32770 366x125+321+270 ex 0x10101 \"Electron\""] | alert:"returned":436ms |  |
| offscreen tab | confirm | true | true | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | alert:"returned":436ms | confirm:true:404ms |  |
| offscreen tab | prompt | false | – | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | alert:"returned":436ms | confirm:true:404ms |  |
| host window tab | alert | true | true | ["#32770 366x125+0+0 ex 0x10101 \"Electron\"","Chrome_WidgetWin_1 48x40+-8+0 ex 0x82801a0 \"S7 tiny t2\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | ["#32770 366x125+0+0 ex 0x10101 \"Electron\"","Chrome_WidgetWin_1 48x40+-8+0 ex 0x82801a0 \"S7 tiny t2\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | alert:"returned":393ms |  |
| host window tab | confirm | true | true | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+0+0 ex 0x10101 \"Electron\"","Chrome_WidgetWin_1 48x40+-8+0 ex 0x82801a0 \"S7 tiny t2\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+0+0 ex 0x10101 \"Electron\"","Chrome_WidgetWin_1 48x40+-8+0 ex 0x82801a0 \"S7 tiny t2\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | alert:"returned":393ms | confirm:true:425ms |  |
| host window tab | prompt | false | – | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+0+0 ex 0x10101 \"Electron\"","Chrome_WidgetWin_1 48x40+-8+0 ex 0x82801a0 \"S7 tiny t2\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+0+0 ex 0x10101 \"Electron\"","Chrome_WidgetWin_1 48x40+-8+0 ex 0x82801a0 \"S7 tiny t2\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | alert:"returned":393ms | confirm:true:425ms |  |
| offscreen tab, disableDialogs | alert | true | true | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+0+0 ex 0x10101 \"Electron\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+0+0 ex 0x10101 \"Electron\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | alert:"returned":0ms | handle: No dialog is showing |
| offscreen tab, disableDialogs | confirm | true | true | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+0+0 ex 0x10101 \"Electron\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+0+0 ex 0x10101 \"Electron\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | alert:"returned":0ms | confirm:false:1ms | handle: No dialog is showing |
| offscreen tab, disableDialogs | prompt | false | – | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+0+0 ex 0x10101 \"Electron\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+0+0 ex 0x10101 \"Electron\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | alert:"returned":0ms | confirm:false:1ms |  |

**Assertions:** PASS CDP sees every alert and confirm, offscreen, in the host window and with disableDialogs; PASS a known gap, pinned: an alert answered over CDP still leaves a native box up (offscreen tab); PASS a known gap, pinned: an alert answered over CDP still leaves a native box up (host window tab); PASS with disableDialogs an alert puts up no window

### Electron · viewport-windows-warp (electron-viewport-windows-warp.json)

Electron 45.2.2 (Chromium 156.0.8078.80), win32-x64 10.0.26100, ozone (default), displays 1024x768@1, status **done**, 218 s

**Round twelve, offscreen bot tabs** (never-shown OSR windows; GPU "enabled")

Size: default: window 1024x720, page 1024x720@1; setContentSize after creation: window 1280x800, page 1280x800@1; not resizable, then setContentSize: window 1280x800, page 1280x800@1; enableLargerThanScreen, then setContentSize: window 1280x800, page 1280x800@1; not resizable, enableLargerThanScreen, then setBounds: window 1280x800, page 1280x800@1 → **setContentSize after creation**.

Shared textures: 90 textures, 0 bitmaps, 0 empty paints in 3 s → **they come here** — {"pixelFormat":"bgra","codedSize":"1280x800","handle":["ntHandle"]}

| config | visibility | rAF Hz | paints/s | textures/s | all CPU % | renderer % | GPU % | browser % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| offscreen, texture, 10 fps, animated | visible | 10.0 | 10.0 | 10.0 | 73.0 | 3.8 | 68.5 | 0.6 |  |
| offscreen, texture, 30 fps, animated | visible | 30.2 | 30.0 | 30.0 | 188.2 | 5.6 | 181.4 | 1.2 |  |
| offscreen, texture, 60 fps, animated | visible | 57.8 | 57.9 | 57.9 | 347.4 | 9.4 | 335.6 | 2.4 |  |
| offscreen, texture, 30 fps, painting stopped, animated | visible | 29.9 | 0.0 | 0.0 | 134.7 | 5.8 | 128.8 | 0.1 |  |
| offscreen, texture, 10 fps, quiet page | visible | 0.0 | 2.0 | 2.0 | 11.8 | 0.5 | 9.9 | 1.4 |  |
| offscreen, texture, painting stopped, quiet page | visible | 0.0 | 0.0 | 0.0 | 6.6 | 0.5 | 5.8 | 0.1 |  |
| offscreen, bitmap, 10 fps, animated | visible | 10.0 | 10.2 | 0.0 | 71.7 | 3.7 | 62.5 | 5.5 |  |
| offscreen, bitmap, 30 fps, animated | visible | 30.0 | 30.0 | 0.0 | 180.1 | 6.1 | 162.1 | 11.9 |  |
| offscreen, bitmap, 60 fps, animated | visible | 57.5 | 57.3 | 0.0 | 331.9 | 9.9 | 299.4 | 22.4 |  |
| offscreen, bitmap, 30 fps, painting stopped, animated | visible | 30.0 | 0.0 | 0.0 | 134.7 | 5.8 | 128.6 | 0.2 |  |
| offscreen, bitmap, 10 fps, quiet page | visible | 0.0 | 2.8 | 0.0 | 11.4 | 0.5 | 8.8 | 2.0 |  |
| offscreen, bitmap, painting stopped, quiet page | visible | 0.0 | 0.0 | 0.0 | 7.3 | 0.6 | 6.4 | 0.2 |  |
| host window, animated | visible | 61.0 | 0.0 | 0.0 | 178.7 | 10.6 | 166.9 | 1.2 |  |
| host window, quiet page | visible | 0.0 | 0.0 | 0.0 | 4.5 | 0.6 | 3.7 | 0.2 |  |

| pictures of | method | ok | ms | stale ms | size | errors |
| :- | :- | :- | :- | :- | :- | :- |
| offscreen, texture, painting on (10 fps) | capturePage | 5/5 | 95 / 103 | -76 / -71 | 1280x800 |  |
| offscreen, texture, painting on (10 fps) | cdpJpeg | 5/5 | 300 / 310 | -266 / -260 | 1280x800 |  |
| offscreen, texture, painting stopped | capturePage | 5/5 | 86 / 128 | -67 / -10 | 1280x800 |  |
| offscreen, texture, painting stopped | cdpJpeg | 5/5 | 293 / 333 | -263 / -234 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | capturePage | 5/5 | 96 / 104 | -77 / -72 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | cdpJpeg | 5/5 | 297 / 314 | -262 / -259 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | osrPaint | 5/5 | 0 / 1 | 42 / 52 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | newest paint → JPEG | 5/5 | 8 / 11 | – | 1280x800 |  |
| offscreen, bitmap, painting stopped | capturePage | 5/5 | 96 / 118 | -78 / -4 | 1280x800 |  |
| offscreen, bitmap, painting stopped | cdpJpeg | 5/5 | 297 / 310 | -266 / -255 | 1280x800 |  |
| host window | capturePage | 5/5 | 20 / 27 | 11 / 12 | 1280x800 |  |
| host window | cdpJpeg | 5/5 | 120 / 133 | -62 / -49 | 1280x800 |  |

| cost | MiB a tab | CPU % a tab | kind | error |
| :- | :- | :- | :- | :- |
| 4 quiet offscreen tabs (texture, 10 fps) | 28.3 | 10.91 | privateBytes |  |
| 4 quiet offscreen tabs (texture), painting stopped | 22.4 | 6.31 | privateBytes |  |
| 4 quiet tabs in one shared host window | 24.9 | 4.39 | privateBytes |  |

Windows on screen: 4 offscreen tabs open (nothing else shown): 0 []; 4 tabs in the shared host window: 1 ["Chrome_WidgetWin_1 48x40+-8+0 ex 0x82801a0 \"S7 shared host\""]

**Round twelve, the viewport** (mode **texture**: shared textures come on this machine)

Shows: #1 first frame 62 ms, at the viewport's size 62 ms (1000x681, frame 1000x681), hidden again 6 ms; #2 first frame 61 ms, at the viewport's size 61 ms (1000x681, frame 1000x681), hidden again 3 ms

| oracle | same document | timers | SSE socket | form | layout | detail |
| :- | :- | :- | :- | :- | :- | :- |
| shown (first time) | true | true | true | true | 1000x681@1 | token same, loads +0, navigations +0, ticks 15→25, sse opens 1 (server 1) msgs 14→24, field "typed by the bot", checked true |
| hidden again (the agent's 1280x800) | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 397→412, sse opens 1 (server 1) msgs 386→400, field "x日本s7-paste-ok", checked true |
| shown again | true | true | true | true | 1000x681@1 | token same, loads +0, navigations +0, ticks 412→421, sse opens 1 (server 1) msgs 400→409, field "x日本s7-paste-ok", checked true |
| hidden at the end | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 421→436, sse opens 1 (server 1) msgs 409→424, field "x日本s7-paste-ok", checked true |

| through the viewport | ok | ms | detail |
| :- | :- | :- | :- |
| mouse: a click lands where the person clicked | yes | 104 | {"at":"260,40","page":{"x":260,"y":40,"t":1793877943370},"forwarded":{"mouseMove":1,"mouseDown":1,"mouseUp":1}} |
| wheel: the page scrolls | yes | 325 | {"scrollY":450,"wheels":4,"forwardedWheels":4} |
| keys: typing, Backspace and select-all in the field | yes | 1236 | {"typed":"typed by the botabc","afterBackspace":"typed by the botab","afterSelectAllAndX":"x","focused":"field","pageHasFocus":true,"keys":["End","a","b","c","Backspace","x"]} |
| IME: a composition in the viewport is composed and committed in the page | yes | 886 | {"field":"x日本","midField":"xにほ","compositions":["start:","update:にほ","update:日本","update:日本","end:日本"],"forwarded":{"set":2,"commit":1,"text":0}} |
| paste: the person's paste reaches the page as a paste | yes | 935 | {"field":"x日本s7-paste-ok","pasteEvents":["s7-paste-ok"],"clipboard":"s7-paste-ok","forwarded":1} |
| select text: a mouse drag across the page's text selects it | yes | 765 | {"selection":"s7 select and copy this sentence please"} |
| copy: the copy key (⌘C, Ctrl+C) in the viewport copies the page's selection | yes | 46 | {"selection":"s7 select and copy this sentence please","clipboard":"s7 select and copy this sentence please","forwardedEdits":2} |
| copy: a right click on the selection, then the menu's Copy (webContents.copy) | yes | 129 | {"at":"660,240","selectionText":"s7 select and copy this sentence please","canCopy":true,"menuSourceType":"mouse","clipboard":"s7 select and copy this sentence please"} |
| <select>: it opens, and the keys choose an option | yes | 2265 | {"value":"c","changes":["c"],"popupTextures":3,"popupRects":["popup 180x146+0+0","popup 178x140+1+1"],"viewerPopups":3,"viewerPopupSizes":["180x146","180x146","180x146"]} |
| cursor: the page's cursor reaches the viewport | yes | 1208 | {"events":["hand","text","crosshair","move"],"viewerCursors":["pointer","text","crosshair","move"]} |
| drag: an HTML5 drag inside the page, sent as plain mouse events | **no** | 1365 | {"page":["dragstart"]} |
| drag: the same, with the browser's drag handed to the viewport (CDP Input.setInterceptDrags) | yes | 1355 | {"page":["dragstart","dragenter","dragover","drop:s7-dragged","dragend:copy"],"intercepted":1,"dispatched":["dragEnter","dragOver","drop"]} |
| file chooser: answered with a file, no dialog | yes | 491 | {"choosers":[{"at":1793877954003,"mode":"selectSingle"}],"files":["s7-upload.txt:23:hello from the viewport"]} |
| a window the page opens: offscreen too, its opener kept, shown in the viewport and clicked | **no** | 4148 | {"offscreen":true,"visible":false,"size":"480x360","painting":true,"frameRate":30,"pageSize":"0x0","sameProcessAsOpener":true,"openerFramesOfTheChildSize":0,"paintsAfterRepaint":0,"pageState":"{\"clicks\":0,\"hasOpener\":true,\"loadedAt\":1793877954519}","directClick":false,"paints":0,"openerMessages":["popup:hello"],"clickedInViewport":false} |
| a cross-site window the page opens (Electron #55565): offscreen, its opener kept, shown in the viewport and clicked | yes | 6127 | {"offscreen":true,"visible":false,"size":"480x360","painting":true,"frameRate":30,"pageSize":"480x360","sameProcessAsOpener":false,"openerFramesOfTheChildSize":0,"paintsAfterRepaint":1,"pageState":"{\"clicks\":0,\"hasOpener\":true,\"loadedAt\":1793877958718}","directClick":true,"paints":5,"openerMessages":["popup:hello","popup:hello@other-site","popup:click@other-site","popup:click@other-site"],"clickedInViewport":true} |
| resize: the page reflows to the viewport, no reload | yes | 244 | {"oneMs":43,"quickThreeMs":62,"backMs":43,"resizes":["1793877964162:1000x681","1793877964735:800x560","1793877964780:900x620","1793877964830:760x520","1793877964880:820x580","1793877964933:1000x681"],"applied":["1793877964161:1000x681","1793877964734:800x560","1793877964779:900x620","1793877964827:760x520","1793877964875:820x580","1793877964932:1000x681"],"token":"same"} |
| find-in-page: matches found and drawn | yes | 1 | {"requestId":0,"matches":1,"selectionArea":{"x":202,"y":162,"width":30,"height":19},"activeMatchOrdinal":1,"finalUpdate":true} |
| DevTools: open on the offscreen tab (detached window) | yes | 775 | {"opened":true} |
| accessibility: the page's tree is there to read over CDP (the OS sees none of it) | yes | 11 | {"nodes":58,"button":true,"accessibilitySupport":false} |
| a 2x display: the device-metrics override at a scale of 2 gives the viewport 2x frames | **no** | 1609 | {"pageDpr":2,"layout":"1000x681","frame":"1000x681","viewerCanvas":"1000x681"} |
| the tab's webContents.focus(): does the hidden window take the OS focus from the viewport? | yes | 705 | {"viewerFocusedBefore":true,"after":true,"focusedWindow":"S7 viewport","pageHasFocus":true,"tabVisible":false} |

| input → frame | trials | ms p50 / p95 | parts (p50) |
| :- | :- | :- | :- |
| viewport, mouse | 20 | 25 / 31 | to the page's handler 1; to the paint event 9; paint → drawn in the viewer 1; drawn → on screen (2 rAFs) 15 |
| viewport, key | 10 | 23 / 27 | to the page's handler 1; to the paint event 9; paint → drawn in the viewer 1; drawn → on screen (2 rAFs) 13 |
| native view, mouse | 20 | 17 / 17 | to the page's handler 0 |
| native view, key | 10 | 17 / 17 | to the page's handler 0 |

| frames | numbers |
| :- | :- |
| viewport, animated page | drawnPerSec 60.2, paintsPerSec 60.2, sentPerSec 60.2, droppedPerSec 0.0, pageRafPerSec 60.0, mbPerSec 0.0, drawMsP50 0.3, drawMsP95 0.5, cpuTotal 261.9, cpuBrowser 7.8, cpuGpu 237.5, cpuOffscreenRenderer 6.6, cpuViewerRenderer 9.8 |
| viewport, smooth scroll | ms 2.0, viewerFramesPerSec 500.0, pageRafPerSec 500.0 |
| native view, animated page | pageRafPerSec 58.9, cpuTotal 45.5, cpuBrowser 0.4, cpuGpu 38.6, cpuRenderer 6.1 |
| native view, smooth scroll | ms 13.0, pageRafPerSec 76.9 |

Windows on screen: a hidden offscreen tab and the viewer: 1 ["Chrome_WidgetWin_1 1016x746+60+60 ex 0x200100 \"S7 viewport\""]; a <select> open: 1 ["Chrome_WidgetWin_1 1016x746+60+60 ex 0x200100 \"S7 viewport\""]; a file chooser open: 1 ["Chrome_WidgetWin_1 1016x746+60+60 ex 0x200100 \"S7 viewport\""]; the page's window open (offscreen): 1 ["Chrome_WidgetWin_1 1016x746+60+60 ex 0x200100 \"S7 viewport\""]; the page's cross-site window open (offscreen): 1 ["Chrome_WidgetWin_1 1016x746+60+60 ex 0x200100 \"S7 viewport\""]

Viewer: {"frames":398,"textures":398,"bitmaps":0,"popups":3,"draw":{"n":300,"min":0.2,"p50":0.3,"p95":0.5,"max":1.6,"mean":0.33},"errors":[]}; counters {"sent":401,"dropped":0,"fullFrames":0,"mbSent":0,"outstandingTextures":0,"forwarded":{"mouseMove":56,"mouseDown":33,"mouseUp":33,"mouseWheel":4,"keyDown":20,"keyUp":20,"char":14,"edit":2,"ime-start":1,"ime-set":2,"ime-commit":1,"paste":1},"errors":[],"tabTextures":404,"tabPopupTextures":3,"tabEmptyPaints":0,"tabPaints":407}

**Assertions:** PASS an offscreen tab draws with no window (CPU bitmaps asked at 30 fps: rAF above 10 Hz); PASS capturePage works on an offscreen tab; PASS four offscreen tabs put no window on screen; PASS no reload across show and hide through the viewport: same document, its timers, its socket, its form; PASS through the viewport: mouse: a click lands where the person clicked; PASS through the viewport: wheel: the page scrolls; PASS through the viewport: keys: typing, Backspace and select-all in the field; PASS through the viewport: IME: a composition in the viewport is composed and committed in the page; PASS through the viewport: paste: the person's paste reaches the page as a paste; PASS through the viewport: <select>: it opens, and the keys choose an option; PASS through the viewport: cursor: the page's cursor reaches the viewport; PASS through the viewport: drag: the same, with the browser's drag handed to the viewport (CDP Input.setInterceptDrags); PASS through the viewport: file chooser: answered with a file, no dialog; PASS through the viewport: resize: the page reflows to the viewport, no reload; PASS through the viewport: find-in-page: matches found and drawn; PASS through the viewport: DevTools: open on the offscreen tab (detached window); PASS through the viewport: accessibility: the page's tree is there to read over CDP (the OS sees none of it); PASS through the viewport: the tab's webContents.focus(): does the hidden window take the OS focus from the viewport?; PASS a known gap, pinned: an HTML5 drag sent as plain mouse events doesn't drop in an offscreen tab; PASS a known gap, pinned: a window the page opens, made offscreen, paints nothing; PASS the viewport draws an animated page at 45 fps or more

### Electron · viewport-windows (electron-viewport-windows.json)

Electron 45.2.2 (Chromium 156.0.8078.80), win32-x64 10.0.26100, ozone (default), displays 1024x768@1, status **done**, 174 s

**Round twelve, offscreen bot tabs** (never-shown OSR windows; GPU "disabled_software")

Size: default: window 1024x720, page 1024x720@1; setContentSize after creation: window 1280x800, page 1280x800@1; not resizable, then setContentSize: window 1280x800, page 1280x800@1; enableLargerThanScreen, then setContentSize: window 1280x800, page 1280x800@1; not resizable, enableLargerThanScreen, then setBounds: window 1280x800, page 1280x800@1 → **setContentSize after creation**.

Shared textures: 0 textures, 0 bitmaps, 0 empty paints in 3 s → **none here (CPU bitmaps)**; error not asked for: GPU compositing is "disabled_software" here (asking hung the main process on the Linux runners)

| config | visibility | rAF Hz | paints/s | textures/s | all CPU % | renderer % | GPU % | browser % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| offscreen, bitmap, 10 fps, animated | visible | 10.0 | 10.0 | 0.0 | 12.4 | 6.8 | 3.2 | 2.4 |  |
| offscreen, bitmap, 30 fps, animated | visible | 30.0 | 30.0 | 0.0 | 30.8 | 14.3 | 9.7 | 6.8 |  |
| offscreen, bitmap, 60 fps, animated | visible | 60.0 | 60.0 | 0.0 | 56.0 | 25.7 | 17.6 | 12.8 |  |
| offscreen, bitmap, 30 fps, painting stopped, animated | visible | 30.0 | 0.0 | 0.0 | 29.2 | 16.0 | 12.5 | 0.7 |  |
| offscreen, bitmap, 10 fps, quiet page | visible | 0.0 | 2.5 | 0.0 | 3.8 | 0.8 | 0.7 | 2.4 |  |
| offscreen, bitmap, painting stopped, quiet page | visible | 0.0 | 0.0 | 0.0 | 1.7 | 0.8 | 0.6 | 0.2 |  |
| host window, animated | visible | 64.0 | 0.0 | 0.0 | 30.8 | 25.8 | 3.9 | 1.0 |  |
| host window, quiet page | visible | 0.0 | 0.0 | 0.0 | 1.4 | 0.9 | 0.3 | 0.1 |  |

| pictures of | method | ok | ms | stale ms | size | errors |
| :- | :- | :- | :- | :- | :- | :- |
| offscreen, bitmap, painting on (10 fps) | capturePage | 5/5 | 97 / 98 | -84 / -8 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | cdpJpeg | 5/5 | 297 / 316 | -271 / -266 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | osrPaint | 5/5 | 0 / 0 | 30 / 34 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | newest paint → JPEG | 5/5 | 6 / 6 | – | 1280x800 |  |
| offscreen, bitmap, painting stopped | capturePage | 5/5 | 96 / 98 | -84 / -11 | 1280x800 |  |
| offscreen, bitmap, painting stopped | cdpJpeg | 5/5 | 300 / 309 | -274 / -272 | 1280x800 |  |
| host window | capturePage | 5/5 | 21 / 22 | 2 / 12 | 1280x800 |  |
| host window | cdpJpeg | 5/5 | 79 / 86 | -42 / -32 | 1280x800 |  |

| cost | MiB a tab | CPU % a tab | kind | error |
| :- | :- | :- | :- | :- |
| 4 quiet offscreen tabs (bitmap, 10 fps) | 30.4 | 2.09 | privateBytes |  |
| 4 quiet offscreen tabs (bitmap), painting stopped | 14.4 | 1.56 | privateBytes |  |
| 4 quiet tabs in one shared host window | 26.7 | 1.21 | privateBytes |  |

Windows on screen: 4 offscreen tabs open (nothing else shown): 0 []; 4 tabs in the shared host window: 1 ["Chrome_WidgetWin_1 48x40+-8+0 ex 0x82801a0 \"S7 shared host\""]

**Round twelve, the viewport** (mode **bitmap**: no shared textures on this machine (GPU compositing "disabled_software"): CPU bitmaps)

Shows: #1 first frame 17 ms, at the viewport's size 27 ms (1000x681, frame 1000x681), hidden again 2 ms; #2 first frame 17 ms, at the viewport's size 24 ms (1000x681, frame 1000x681), hidden again 3 ms

| oracle | same document | timers | SSE socket | form | layout | detail |
| :- | :- | :- | :- | :- | :- | :- |
| shown (first time) | true | true | true | true | 1000x681@1 | token same, loads +0, navigations +0, ticks 15→25, sse opens 1 (server 1) msgs 14→24, field "typed by the bot", checked true |
| hidden again (the agent's 1280x800) | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 396→411, sse opens 1 (server 1) msgs 388→402, field "x日本s7-paste-ok", checked true |
| shown again | true | true | true | true | 1000x681@1 | token same, loads +0, navigations +0, ticks 411→419, sse opens 1 (server 1) msgs 402→411, field "x日本s7-paste-ok", checked true |
| hidden at the end | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 419→434, sse opens 1 (server 1) msgs 411→425, field "x日本s7-paste-ok", checked true |

| through the viewport | ok | ms | detail |
| :- | :- | :- | :- |
| mouse: a click lands where the person clicked | yes | 103 | {"at":"260,40","page":{"x":260,"y":40,"t":1793877692773},"forwarded":{"mouseMove":1,"mouseDown":1,"mouseUp":1}} |
| wheel: the page scrolls | yes | 325 | {"scrollY":450,"wheels":4,"forwardedWheels":4} |
| keys: typing, Backspace and select-all in the field | yes | 1233 | {"typed":"typed by the botabc","afterBackspace":"typed by the botab","afterSelectAllAndX":"x","focused":"field","pageHasFocus":true,"keys":["End","a","b","c","Backspace","x"]} |
| IME: a composition in the viewport is composed and committed in the page | yes | 1202 | {"field":"x日本","midField":"xにほ","compositions":["start:","update:にほ","update:日本","update:日本","end:日本"],"forwarded":{"set":2,"commit":1,"text":0}} |
| paste: the person's paste reaches the page as a paste | yes | 936 | {"field":"x日本s7-paste-ok","pasteEvents":["s7-paste-ok"],"clipboard":"s7-paste-ok","forwarded":1} |
| select text: a mouse drag across the page's text selects it | yes | 757 | {"selection":"s7 select and copy this sentence please"} |
| copy: the copy key (⌘C, Ctrl+C) in the viewport copies the page's selection | yes | 32 | {"selection":"s7 select and copy this sentence please","clipboard":"s7 select and copy this sentence please","forwardedEdits":2} |
| copy: a right click on the selection, then the menu's Copy (webContents.copy) | yes | 118 | {"at":"660,240","selectionText":"s7 select and copy this sentence please","canCopy":true,"menuSourceType":"mouse","clipboard":"s7 select and copy this sentence please"} |
| <select>: it opens, and the keys choose an option | yes | 2337 | {"value":"c","changes":["c"],"popupTextures":0,"popupRects":["bitmap 180x146+480+48","bitmap 180x146+480+48","bitmap 180x146+480+48"],"viewerPopups":0,"viewerPopupSizes":[]} |
| cursor: the page's cursor reaches the viewport | yes | 1213 | {"events":["hand","text","crosshair","move"],"viewerCursors":["pointer","text","crosshair","move"]} |
| drag: an HTML5 drag inside the page, sent as plain mouse events | **no** | 1418 | {"page":["dragstart"]} |
| drag: the same, with the browser's drag handed to the viewport (CDP Input.setInterceptDrags) | yes | 1391 | {"page":["dragstart","dragenter","dragover","drop:s7-dragged","dragend:copy"],"intercepted":1,"dispatched":["dragEnter","dragOver","drop"]} |
| file chooser: answered with a file, no dialog | yes | 487 | {"choosers":[{"at":1793877703853,"mode":"selectSingle"}],"files":["s7-upload.txt:23:hello from the viewport"]} |
| a window the page opens: offscreen too, its opener kept, shown in the viewport and clicked | **no** | 4176 | {"offscreen":true,"visible":false,"size":"480x360","painting":true,"frameRate":30,"pageSize":"0x0","sameProcessAsOpener":true,"openerFramesOfTheChildSize":0,"paintsAfterRepaint":0,"pageState":"{\"clicks\":0,\"hasOpener\":true,\"loadedAt\":1793877704360}","directClick":false,"paints":0,"openerMessages":["popup:hello"],"clickedInViewport":false} |
| a cross-site window the page opens (Electron #55565): offscreen, its opener kept, shown in the viewport and clicked | yes | 6111 | {"offscreen":true,"visible":false,"size":"480x360","painting":true,"frameRate":30,"pageSize":"480x360","sameProcessAsOpener":false,"openerFramesOfTheChildSize":0,"paintsAfterRepaint":1,"pageState":"{\"clicks\":0,\"hasOpener\":true,\"loadedAt\":1793877708579}","directClick":true,"paints":6,"openerMessages":["popup:hello","popup:hello@other-site","popup:click@other-site","popup:click@other-site"],"clickedInViewport":true} |
| resize: the page reflows to the viewport, no reload | yes | 183 | {"oneMs":23,"quickThreeMs":23,"backMs":44,"resizes":["1793877714020:1000x681","1793877714591:800x560","1793877714621:900x620","1793877714659:760x520","1793877714706:820x580","1793877714753:1000x681"],"applied":["1793877714019:1000x681","1793877714590:800x560","1793877714614:900x620","1793877714657:760x520","1793877714705:820x580","1793877714737:1000x681"],"token":"same"} |
| find-in-page: matches found and drawn | yes | 1 | {"requestId":0,"matches":1,"selectionArea":{"x":202,"y":162,"width":30,"height":19},"activeMatchOrdinal":1,"finalUpdate":true} |
| DevTools: open on the offscreen tab (detached window) | yes | 762 | {"opened":true} |
| accessibility: the page's tree is there to read over CDP (the OS sees none of it) | yes | 9 | {"nodes":58,"button":true,"accessibilitySupport":false} |
| a 2x display: the device-metrics override at a scale of 2 gives the viewport 2x frames | **no** | 1617 | {"pageDpr":2,"layout":"1000x681","frame":"1000x681","viewerCanvas":"1000x681"} |
| the tab's webContents.focus(): does the hidden window take the OS focus from the viewport? | yes | 703 | {"viewerFocusedBefore":true,"after":true,"focusedWindow":"S7 viewport","pageHasFocus":true,"tabVisible":false} |

| input → frame | trials | ms p50 / p95 | parts (p50) |
| :- | :- | :- | :- |
| viewport, mouse | 20 | 14 / 18 | to the page's handler 1; to the paint event 3; paint → drawn in the viewer 1; drawn → on screen (2 rAFs) 10 |
| viewport, key | 10 | 14 / 18 | to the page's handler 1; to the paint event 3; paint → drawn in the viewer 1; drawn → on screen (2 rAFs) 11 |
| native view, mouse | 20 | 12 / 15 | to the page's handler 0 |
| native view, key | 10 | 10 / 14 | to the page's handler 0 |

| frames | numbers |
| :- | :- |
| viewport, animated page | drawnPerSec 60.0, paintsPerSec 60.0, sentPerSec 60.0, droppedPerSec 0.0, pageRafPerSec 60.0, mbPerSec 58.6, drawMsP50 0.7, drawMsP95 1.0, cpuTotal 56.2, cpuBrowser 20.2, cpuGpu 9.4, cpuOffscreenRenderer 8.0, cpuViewerRenderer 18.5 |
| viewport, smooth scroll | ms 8.0, viewerFramesPerSec 125.0, pageRafPerSec 125.0 |
| native view, animated page | pageRafPerSec 64.0, cpuTotal 14.3, cpuBrowser 0.4, cpuGpu 6.3, cpuRenderer 7.3 |
| native view, smooth scroll | ms 10.0, pageRafPerSec 100.0 |

Windows on screen: a hidden offscreen tab and the viewer: 1 ["Chrome_WidgetWin_1 1016x746+60+60 ex 0x200100 \"S7 viewport\""]; a <select> open: 1 ["Chrome_WidgetWin_1 1016x746+60+60 ex 0x200100 \"S7 viewport\""]; a file chooser open: 1 ["Chrome_WidgetWin_1 1016x746+60+60 ex 0x200100 \"S7 viewport\""]; the page's window open (offscreen): 1 ["Chrome_WidgetWin_1 1016x746+60+60 ex 0x200100 \"S7 viewport\""]; the page's cross-site window open (offscreen): 1 ["Chrome_WidgetWin_1 1016x746+60+60 ex 0x200100 \"S7 viewport\""]

Viewer: {"frames":514,"textures":0,"bitmaps":514,"popups":0,"draw":{"n":300,"min":0.5,"p50":0.7,"p95":1.1,"max":5.4,"mean":0.79},"errors":[]}; counters {"sent":514,"dropped":0,"fullFrames":4,"mbSent":384.63,"outstandingTextures":0,"forwarded":{"mouseMove":56,"mouseDown":33,"mouseUp":33,"mouseWheel":4,"keyDown":20,"keyUp":20,"char":14,"edit":2,"ime-start":1,"ime-set":2,"ime-commit":1,"paste":1},"errors":[],"tabTextures":0,"tabPopupTextures":0,"tabEmptyPaints":0,"tabPaints":521}

**Assertions:** PASS an offscreen tab draws with no window (CPU bitmaps asked at 30 fps: rAF above 10 Hz); PASS capturePage works on an offscreen tab; PASS four offscreen tabs put no window on screen; PASS no reload across show and hide through the viewport: same document, its timers, its socket, its form; PASS through the viewport: mouse: a click lands where the person clicked; PASS through the viewport: wheel: the page scrolls; PASS through the viewport: keys: typing, Backspace and select-all in the field; PASS through the viewport: IME: a composition in the viewport is composed and committed in the page; PASS through the viewport: paste: the person's paste reaches the page as a paste; PASS through the viewport: <select>: it opens, and the keys choose an option; PASS through the viewport: cursor: the page's cursor reaches the viewport; PASS through the viewport: drag: the same, with the browser's drag handed to the viewport (CDP Input.setInterceptDrags); PASS through the viewport: file chooser: answered with a file, no dialog; PASS through the viewport: resize: the page reflows to the viewport, no reload; PASS through the viewport: find-in-page: matches found and drawn; PASS through the viewport: DevTools: open on the offscreen tab (detached window); PASS through the viewport: accessibility: the page's tree is there to read over CDP (the OS sees none of it); PASS through the viewport: the tab's webContents.focus(): does the hidden window take the OS focus from the viewport?; PASS a known gap, pinned: an HTML5 drag sent as plain mouse events doesn't drop in an offscreen tab; PASS a known gap, pinned: a window the page opens, made offscreen, paints nothing; PASS the viewport draws an animated page at 45 fps or more

