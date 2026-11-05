## Spike S7 results

### Electron · dialogs-linux-wayland (electron-viewport-linux-wayland-dialogs.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone wayland, displays 1920x1080@1, status **done**, 22 s

**Round twelve, JavaScript dialogs answered over CDP**

| tab | dialog | CDP event | browser handler | windows during | windows after | page | error |
| :- | :- | :- | :- | :- | :- | :- | :- |
| offscreen tab | alert | true | true | "no way to list windows here (Wayland or no display)" | "no way to list windows here (Wayland or no display)" | alert:"returned":108ms |  |
| offscreen tab | confirm | true | true | "no way to list windows here (Wayland or no display)" | "no way to list windows here (Wayland or no display)" | alert:"returned":108ms | confirm:true:26ms |  |
| offscreen tab | prompt | false | – | "no way to list windows here (Wayland or no display)" | "no way to list windows here (Wayland or no display)" | alert:"returned":108ms | confirm:true:26ms |  |
| host window tab | alert | true | true | "no way to list windows here (Wayland or no display)" | "no way to list windows here (Wayland or no display)" | alert:"returned":25ms |  |
| host window tab | confirm | true | true | "no way to list windows here (Wayland or no display)" | "no way to list windows here (Wayland or no display)" | alert:"returned":25ms | confirm:true:26ms |  |
| host window tab | prompt | false | – | "no way to list windows here (Wayland or no display)" | "no way to list windows here (Wayland or no display)" | alert:"returned":25ms | confirm:true:26ms |  |
| offscreen tab, disableDialogs | alert | true | true | "no way to list windows here (Wayland or no display)" | "no way to list windows here (Wayland or no display)" | alert:"returned":0ms | handle: No dialog is showing |
| offscreen tab, disableDialogs | confirm | true | true | "no way to list windows here (Wayland or no display)" | "no way to list windows here (Wayland or no display)" | alert:"returned":0ms | confirm:false:1ms | handle: No dialog is showing |
| offscreen tab, disableDialogs | prompt | false | – | "no way to list windows here (Wayland or no display)" | "no way to list windows here (Wayland or no display)" | alert:"returned":0ms | confirm:false:1ms |  |

**Assertions:** PASS CDP sees every alert and confirm, offscreen, in the host window and with disableDialogs

### Electron · viewport-linux-wayland (electron-viewport-linux-wayland.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone wayland, displays 1920x1080@1, status **done**, 160 s

**Round twelve, offscreen bot tabs** (never-shown OSR windows; GPU "disabled_software")

Size: default: window 1280x800, page 1280x800@1 → **default**.

Shared textures: 0 textures, 0 bitmaps, 0 empty paints in 3 s → **none here (CPU bitmaps)**; error not asked for: GPU compositing is "disabled_software" here (asking hung the main process on the Linux runners)

| config | visibility | rAF Hz | paints/s | textures/s | all CPU % | renderer % | GPU % | browser % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| offscreen, bitmap, 10 fps, animated | visible | 10.0 | 10.0 | 0.0 | 6.3 | 2.8 | 1.3 | 2.3 |  |
| offscreen, bitmap, 30 fps, animated | visible | 30.2 | 30.0 | 0.0 | 16.2 | 6.0 | 3.3 | 7.0 |  |
| offscreen, bitmap, 60 fps, animated | visible | 60.0 | 60.2 | 0.0 | 25.5 | 9.5 | 5.0 | 11.0 |  |
| offscreen, bitmap, 30 fps, painting stopped, animated | visible | 30.0 | 0.0 | 0.0 | 9.5 | 6.0 | 3.0 | 0.5 |  |
| offscreen, bitmap, 10 fps, quiet page | visible | 0.0 | 4.3 | 0.0 | 3.3 | 0.8 | 0.3 | 2.3 |  |
| offscreen, bitmap, painting stopped, quiet page | visible | 0.0 | 0.0 | 0.0 | 1.3 | 0.8 | 0.5 | 0.0 |  |
| host window, animated | visible | 39.7 | 0.0 | 0.0 | 9.5 | 7.0 | 1.3 | 1.3 |  |
| host window, quiet page | visible | 0.0 | 0.0 | 0.0 | 0.8 | 0.8 | 0.0 | 0.0 |  |

| pictures of | method | ok | ms | stale ms | size | errors |
| :- | :- | :- | :- | :- | :- | :- |
| offscreen, bitmap, painting on (10 fps) | capturePage | 5/5 | 97 / 98 | -89 / -69 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | cdpJpeg | 5/5 | 299 / 308 | -279 / -276 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | osrPaint | 5/5 | 0 / 1 | 26 / 30 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | newest paint → JPEG | 5/5 | 5 / 5 | – | 1280x800 |  |
| offscreen, bitmap, painting stopped | capturePage | 5/5 | 96 / 99 | -88 / -58 | 1280x800 |  |
| offscreen, bitmap, painting stopped | cdpJpeg | 5/5 | 298 / 308 | -279 / -279 | 1280x800 |  |
| host window | capturePage | 5/5 | 24 / 24 | 9 / 16 | 1280x800 |  |
| host window | cdpJpeg | 5/5 | 120 / 125 | -57 / -53 | 1280x800 |  |

| cost | MiB a tab | CPU % a tab | kind | error |
| :- | :- | :- | :- | :- |
| 4 quiet offscreen tabs (bitmap, 10 fps) | 52.1 | 2.12 | pss |  |
| 4 quiet offscreen tabs (bitmap), painting stopped | 15.2 | 1.19 | pss |  |
| 4 quiet tabs in one shared host window | 30.5 | 1.04 | pss |  |

Windows on screen: 4 offscreen tabs open (nothing else shown): no way to list windows here (Wayland or no display); 4 tabs in the shared host window: no way to list windows here (Wayland or no display)

**Round twelve, the viewport** (mode **bitmap**: no shared textures on this machine (GPU compositing "disabled_software"): CPU bitmaps)

Shows: #1 first frame 13 ms, at the viewport's size 21 ms (1000x700, frame 1000x700), hidden again 1 ms; #2 first frame 13 ms, at the viewport's size 21 ms (1000x700, frame 1000x700), hidden again 1 ms

| oracle | same document | timers | SSE socket | form | layout | detail |
| :- | :- | :- | :- | :- | :- | :- |
| shown (first time) | true | true | true | true | 1000x700@1 | token same, loads +0, navigations +0, ticks 15→21, sse opens 1 (server 1) msgs 14→21, field "typed by the bot", checked true |
| hidden again (the agent's 1280x800) | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 366→381, sse opens 1 (server 1) msgs 364→379, field "x日本s7-paste-ok", checked true |
| shown again | true | true | true | true | 1000x700@1 | token same, loads +0, navigations +0, ticks 381→389, sse opens 1 (server 1) msgs 379→388, field "x日本s7-paste-ok", checked true |
| hidden at the end | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 389→404, sse opens 1 (server 1) msgs 388→403, field "x日本s7-paste-ok", checked true |

| through the viewport | ok | ms | detail |
| :- | :- | :- | :- |
| mouse: a click lands where the person clicked | yes | 101 | {"at":"260,40","page":{"x":260,"y":40,"t":1793876087896},"forwarded":{"mouseMove":1,"mouseDown":1,"mouseUp":1}} |
| wheel: the page scrolls | yes | 325 | {"scrollY":600,"wheels":4,"forwardedWheels":4} |
| keys: typing, Backspace and select-all in the field | yes | 1217 | {"typed":"typed by the botabc","afterBackspace":"typed by the botab","afterSelectAllAndX":"x","focused":"field","pageHasFocus":true,"keys":["End","a","b","c","Backspace","x"]} |
| IME: a composition in the viewport is composed and committed in the page | yes | 856 | {"field":"x日本","midField":"xにほ","compositions":["start:","update:にほ","update:日本","update:日本","end:日本"],"forwarded":{"set":2,"commit":1,"text":0}} |
| paste: the person's paste reaches the page as a paste | yes | 933 | {"field":"x日本s7-paste-ok","pasteEvents":["s7-paste-ok"],"clipboard":{},"forwarded":1} |
| <select>: it opens, and the keys choose an option | yes | 1594 | {"value":"c","changes":["c"],"popupTextures":0,"popupRects":["bitmap 180x146+480+48","bitmap 180x146+480+48","bitmap 180x146+480+48"],"viewerPopups":0,"viewerPopupSizes":[]} |
| cursor: the page's cursor reaches the viewport | yes | 1205 | {"events":["hand","text","crosshair","move"],"viewerCursors":["pointer","text","crosshair","move"]} |
| drag: an HTML5 drag inside the page, sent as plain mouse events | **no** | 1317 | {"page":["dragstart"]} |
| drag: the same, with the browser's drag handed to the viewport (CDP Input.setInterceptDrags) | yes | 1327 | {"page":["dragstart","dragenter","dragover","drop:s7-dragged","dragend:copy"],"intercepted":1,"dispatched":["dragEnter","dragOver","drop"]} |
| file chooser: answered with a file, no dialog | yes | 101 | {"choosers":[{"at":1793876096783,"mode":"selectSingle"}],"files":["s7-upload.txt:23:hello from the viewport"]} |
| a window the page opens: offscreen too, its opener kept, shown in the viewport and clicked | **no** | 3758 | {"offscreen":true,"visible":false,"size":"480x360","painting":true,"frameRate":30,"pageSize":"0x0","sameProcessAsOpener":true,"openerFramesOfTheChildSize":0,"paintsAfterRepaint":0,"pageState":"{\"clicks\":0,\"hasOpener\":true,\"loadedAt\":1793876096896}","directClick":false,"paints":0,"openerMessages":["popup:hello"],"clickedInViewport":false} |
| a cross-site window the page opens (Electron #55565): offscreen, its opener kept, shown in the viewport and clicked | yes | 5724 | {"offscreen":true,"visible":false,"size":"480x360","painting":true,"frameRate":30,"pageSize":"480x360","sameProcessAsOpener":false,"openerFramesOfTheChildSize":0,"paintsAfterRepaint":1,"pageState":"{\"clicks\":0,\"hasOpener\":true,\"loadedAt\":1793876100675}","directClick":true,"paints":5,"openerMessages":["popup:hello","popup:hello@other-site","popup:click@other-site","popup:click@other-site"],"clickedInViewport":true} |
| resize: the page reflows to the viewport, no reload | yes | 172 | {"oneMs":20,"quickThreeMs":42,"backMs":25,"resizes":["1793876105765:1000x700","1793876106331:800x560","1793876106363:900x620","1793876106402:760x520","1793876106446:820x580","1793876106480:1000x700"],"applied":["1793876105762:1000x700","1793876106330:800x560","1793876106355:900x620","1793876106401:760x520","1793876106435:820x580","1793876106477:1000x700"],"token":"same"} |
| find-in-page: matches found and drawn | yes | 2 | {"requestId":0,"matches":1,"selectionArea":{"x":202,"y":163,"width":32,"height":16},"activeMatchOrdinal":1,"finalUpdate":true} |
| DevTools: open on the offscreen tab (detached window) | yes | 614 | {"opened":true} |
| accessibility: the page's tree is there to read over CDP (the OS sees none of it) | yes | 4 | {"nodes":55,"button":true,"accessibilitySupport":false} |
| a 2x display: the device-metrics override at a scale of 2 gives the viewport 2x frames | **no** | 1603 | {"pageDpr":2,"layout":"1000x700","frame":"1000x700","viewerCanvas":"1000x700"} |
| the tab's webContents.focus(): does the hidden window take the OS focus from the viewport? | yes | 702 | {"viewerFocusedBefore":false,"after":false,"focusedWindow":"(none)","pageHasFocus":true,"tabVisible":false} |

| input → frame | trials | ms p50 / p95 | parts (p50) |
| :- | :- | :- | :- |
| viewport, mouse | 20 | 14 / 20 | to the page's handler 1; to the paint event 3; paint → drawn in the viewer 0; drawn → on screen (2 rAFs) 11 |
| viewport, key | 10 | 12 / 20 | to the page's handler 1; to the paint event 3; paint → drawn in the viewer 0; drawn → on screen (2 rAFs) 9 |
| native view, mouse | 20 | 9 / 10 | to the page's handler 0 |
| native view, key | 10 | 10 / 10 | to the page's handler 0 |

| frames | numbers |
| :- | :- |
| viewport, animated page | drawnPerSec 60.0, paintsPerSec 60.0, sentPerSec 60.0, droppedPerSec 0.0, pageRafPerSec 60.0, mbPerSec 58.6, drawMsP50 0.6, drawMsP95 0.8, cpuTotal 48.0, cpuBrowser 22.5, cpuGpu 4.5, cpuOffscreenRenderer 6.0, cpuViewerRenderer 15.0 |
| viewport, smooth scroll | ms 908.0, viewerFramesPerSec 60.6, pageRafPerSec 60.6 |
| native view, animated page | pageRafPerSec 39.7, cpuTotal 5.0, cpuBrowser 0.8, cpuGpu 1.5, cpuRenderer 2.5 |
| native view, smooth scroll | ms 910.0, pageRafPerSec 39.6 |

Windows on screen: a hidden offscreen tab and the viewer: no way to list windows here (Wayland or no display); a <select> open: no way to list windows here (Wayland or no display); a file chooser open: no way to list windows here (Wayland or no display); the page's window open (offscreen): no way to list windows here (Wayland or no display); the page's cross-site window open (offscreen): no way to list windows here (Wayland or no display)

Viewer: {"frames":510,"textures":0,"bitmaps":510,"popups":0,"draw":{"n":300,"min":0.5,"p50":0.6,"p95":1.6,"max":5.4,"mean":0.84},"errors":[]}; counters {"sent":510,"dropped":0,"fullFrames":4,"mbSent":524.39,"outstandingTextures":0,"forwarded":{"mouseMove":44,"mouseDown":31,"mouseUp":31,"mouseWheel":4,"keyDown":20,"keyUp":20,"char":14,"edit":1,"ime-start":1,"ime-set":2,"ime-commit":1,"paste":1},"errors":[],"tabTextures":0,"tabPopupTextures":0,"tabEmptyPaints":0,"tabPaints":516}

**Assertions:** PASS an offscreen tab draws with no window (CPU bitmaps asked at 30 fps: rAF above 10 Hz); PASS capturePage works on an offscreen tab; PASS no reload across show and hide through the viewport: same document, its timers, its socket, its form; PASS through the viewport: mouse: a click lands where the person clicked; PASS through the viewport: wheel: the page scrolls; PASS through the viewport: keys: typing, Backspace and select-all in the field; PASS through the viewport: IME: a composition in the viewport is composed and committed in the page; PASS through the viewport: paste: the person's paste reaches the page as a paste; PASS through the viewport: <select>: it opens, and the keys choose an option; PASS through the viewport: cursor: the page's cursor reaches the viewport; PASS through the viewport: drag: the same, with the browser's drag handed to the viewport (CDP Input.setInterceptDrags); PASS through the viewport: file chooser: answered with a file, no dialog; PASS through the viewport: resize: the page reflows to the viewport, no reload; PASS through the viewport: find-in-page: matches found and drawn; PASS through the viewport: DevTools: open on the offscreen tab (detached window); PASS through the viewport: accessibility: the page's tree is there to read over CDP (the OS sees none of it); PASS through the viewport: the tab's webContents.focus(): does the hidden window take the OS focus from the viewport?; PASS a known gap, pinned: an HTML5 drag sent as plain mouse events doesn't drop in an offscreen tab; PASS a known gap, pinned: a window the page opens, made offscreen, paints nothing; PASS the viewport draws an animated page at 45 fps or more

### Electron · dialogs-linux-x11 (electron-viewport-linux-x11-dialogs.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone x11, displays 1920x1080@1, status **done**, 23 s

**Round twelve, JavaScript dialogs answered over CDP**

| tab | dialog | CDP event | browser handler | windows during | windows after | page | error |
| :- | :- | :- | :- | :- | :- | :- | :- |
| offscreen tab | alert | true | true | ["4194306 120x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)"] | ["4194306 120x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)"] | alert:"returned":139ms |  |
| offscreen tab | confirm | true | true | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)"] | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)"] | alert:"returned":139ms | confirm:true:60ms |  |
| offscreen tab | prompt | false | – | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)"] | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)"] | alert:"returned":139ms | confirm:true:60ms |  |
| host window tab | alert | true | true | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","2097158 1x1+0+0 IsViewable \"S7 tiny t2\"","4194513 120x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)"] | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","2097158 1x1+0+0 IsViewable \"S7 tiny t2\"","4194513 120x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)"] | alert:"returned":78ms |  |
| host window tab | confirm | true | true | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","2097158 1x1+0+0 IsViewable \"S7 tiny t2\"","4194513 120x81+0+0 IsViewable (has no name)","4194600 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)","4194601 1x1+-1+-1 IsViewable (has no name)"] | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","2097158 1x1+0+0 IsViewable \"S7 tiny t2\"","4194513 120x81+0+0 IsViewable (has no name)","4194600 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)","4194601 1x1+-1+-1 IsViewable (has no name)"] | alert:"returned":78ms | confirm:true:93ms |  |
| host window tab | prompt | false | – | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","2097158 1x1+0+0 IsViewable \"S7 tiny t2\"","4194513 120x81+0+0 IsViewable (has no name)","4194600 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)","4194601 1x1+-1+-1 IsViewable (has no name)"] | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","2097158 1x1+0+0 IsViewable \"S7 tiny t2\"","4194513 120x81+0+0 IsViewable (has no name)","4194600 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)","4194601 1x1+-1+-1 IsViewable (has no name)"] | alert:"returned":78ms | confirm:true:93ms |  |
| offscreen tab, disableDialogs | alert | true | true | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","4194513 120x81+0+0 IsViewable (has no name)","4194600 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)","4194601 1x1+-1+-1 IsViewable (has no name)"] | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","4194513 120x81+0+0 IsViewable (has no name)","4194600 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)","4194601 1x1+-1+-1 IsViewable (has no name)"] | alert:"returned":1ms | handle: No dialog is showing |
| offscreen tab, disableDialogs | confirm | true | true | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","4194513 120x81+0+0 IsViewable (has no name)","4194600 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)","4194601 1x1+-1+-1 IsViewable (has no name)"] | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","4194513 120x81+0+0 IsViewable (has no name)","4194600 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)","4194601 1x1+-1+-1 IsViewable (has no name)"] | alert:"returned":1ms | confirm:false:0ms | handle: No dialog is showing |
| offscreen tab, disableDialogs | prompt | false | – | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","4194513 120x81+0+0 IsViewable (has no name)","4194600 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)","4194601 1x1+-1+-1 IsViewable (has no name)"] | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","4194513 120x81+0+0 IsViewable (has no name)","4194600 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)","4194601 1x1+-1+-1 IsViewable (has no name)"] | alert:"returned":1ms | confirm:false:0ms |  |

**Assertions:** PASS CDP sees every alert and confirm, offscreen, in the host window and with disableDialogs; PASS a known gap, pinned: an alert answered over CDP still leaves a native box up (offscreen tab); PASS a known gap, pinned: an alert answered over CDP still leaves a native box up (host window tab); PASS with disableDialogs an alert puts up no window

### Electron · viewport-linux-x11 (electron-viewport-linux-x11.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone x11, displays 1920x1080@1, status **done**, 156 s

**Round twelve, offscreen bot tabs** (never-shown OSR windows; GPU "disabled_software")

Size: default: window 1280x800, page 1280x800@1 → **default**.

Shared textures: 0 textures, 0 bitmaps, 0 empty paints in 3 s → **none here (CPU bitmaps)**; error not asked for: GPU compositing is "disabled_software" here (asking hung the main process on the Linux runners)

| config | visibility | rAF Hz | paints/s | textures/s | all CPU % | renderer % | GPU % | browser % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| offscreen, bitmap, 10 fps, animated | visible | 10.0 | 10.0 | 0.0 | 9.3 | 5.0 | 1.5 | 2.8 |  |
| offscreen, bitmap, 30 fps, animated | visible | 30.0 | 30.0 | 0.0 | 24.2 | 11.7 | 4.3 | 8.3 |  |
| offscreen, bitmap, 60 fps, animated | visible | 60.0 | 60.0 | 0.0 | 50.5 | 24.7 | 10.0 | 15.8 |  |
| offscreen, bitmap, 30 fps, painting stopped, animated | visible | 30.0 | 0.0 | 0.0 | 17.2 | 12.2 | 4.5 | 0.5 |  |
| offscreen, bitmap, 10 fps, quiet page | visible | 0.0 | 4.3 | 0.0 | 4.0 | 1.0 | 0.8 | 2.3 |  |
| offscreen, bitmap, painting stopped, quiet page | visible | 0.0 | 0.0 | 0.0 | 1.8 | 0.5 | 1.0 | 0.3 |  |
| host window, animated | visible | 59.9 | 0.0 | 0.0 | 24.7 | 22.2 | 2.3 | 0.3 |  |
| host window, quiet page | visible | 0.0 | 0.0 | 0.0 | 1.0 | 0.8 | 0.3 | 0.0 |  |

| pictures of | method | ok | ms | stale ms | size | errors |
| :- | :- | :- | :- | :- | :- | :- |
| offscreen, bitmap, painting on (10 fps) | capturePage | 5/5 | 96 / 98 | -83 / -39 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | cdpJpeg | 5/5 | 297 / 312 | -268 / -268 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | osrPaint | 5/5 | 0 / 0 | 36 / 42 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | newest paint → JPEG | 5/5 | 7 / 8 | – | 1280x800 |  |
| offscreen, bitmap, painting stopped | capturePage | 5/5 | 97 / 98 | -85 / -42 | 1280x800 |  |
| offscreen, bitmap, painting stopped | cdpJpeg | 5/5 | 300 / 312 | -271 / -269 | 1280x800 |  |
| host window | capturePage | 5/5 | 14 / 19 | 13 / 13 | 1280x800 |  |
| host window | cdpJpeg | 5/5 | 80 / 83 | -38 / -37 | 1280x800 |  |

| cost | MiB a tab | CPU % a tab | kind | error |
| :- | :- | :- | :- | :- |
| 4 quiet offscreen tabs (bitmap, 10 fps) | 41.4 | 2.62 | pss |  |
| 4 quiet offscreen tabs (bitmap), painting stopped | 9.3 | 1.50 | pss |  |
| 4 quiet tabs in one shared host window | 30.4 | 0.94 | pss |  |

Windows on screen: 4 offscreen tabs open (nothing else shown): 0 []; 4 tabs in the shared host window: 1 ["2097280 1x1+0+0 IsViewable \"S7 shared host\""]

**Round twelve, the viewport** (mode **bitmap**: no shared textures on this machine (GPU compositing "disabled_software"): CPU bitmaps)

Shows: #1 first frame 19 ms, at the viewport's size 29 ms (1000x700, frame 1000x700), hidden again 1 ms; #2 first frame 18 ms, at the viewport's size 32 ms (1000x700, frame 1000x700), hidden again 2 ms

| oracle | same document | timers | SSE socket | form | layout | detail |
| :- | :- | :- | :- | :- | :- | :- |
| shown (first time) | true | true | true | true | 1000x700@1 | token same, loads +0, navigations +0, ticks 15→21, sse opens 1 (server 1) msgs 14→21, field "typed by the bot", checked true |
| hidden again (the agent's 1280x800) | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 369→384, sse opens 1 (server 1) msgs 367→382, field "x日本s7-paste-ok", checked true |
| shown again | true | true | true | true | 1000x700@1 | token same, loads +0, navigations +0, ticks 384→392, sse opens 1 (server 1) msgs 382→390, field "x日本s7-paste-ok", checked true |
| hidden at the end | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 392→407, sse opens 1 (server 1) msgs 390→405, field "x日本s7-paste-ok", checked true |

| through the viewport | ok | ms | detail |
| :- | :- | :- | :- |
| mouse: a click lands where the person clicked | yes | 103 | {"at":"260,40","page":{"x":260,"y":40,"t":1793876070145},"forwarded":{"mouseMove":1,"mouseDown":1,"mouseUp":1}} |
| wheel: the page scrolls | yes | 326 | {"scrollY":600,"wheels":4,"forwardedWheels":4} |
| keys: typing, Backspace and select-all in the field | yes | 1216 | {"typed":"typed by the botabc","afterBackspace":"typed by the botab","afterSelectAllAndX":"x","focused":"field","pageHasFocus":true,"keys":["End","a","b","c","Backspace","x"]} |
| IME: a composition in the viewport is composed and committed in the page | yes | 859 | {"field":"x日本","midField":"xにほ","compositions":["start:","update:にほ","update:日本","update:日本","end:日本"],"forwarded":{"set":2,"commit":1,"text":0}} |
| paste: the person's paste reaches the page as a paste | yes | 933 | {"field":"x日本s7-paste-ok","pasteEvents":["s7-paste-ok"],"clipboard":{},"forwarded":1} |
| <select>: it opens, and the keys choose an option | yes | 1627 | {"value":"c","changes":["c"],"popupTextures":0,"popupRects":["bitmap 180x146+480+48","bitmap 180x146+480+48","bitmap 180x146+480+48"],"viewerPopups":0,"viewerPopupSizes":[]} |
| cursor: the page's cursor reaches the viewport | yes | 1205 | {"events":["hand","text","crosshair","move"],"viewerCursors":["pointer","text","crosshair","move"]} |
| drag: an HTML5 drag inside the page, sent as plain mouse events | **no** | 1317 | {"page":["dragstart"]} |
| drag: the same, with the browser's drag handed to the viewport (CDP Input.setInterceptDrags) | yes | 1318 | {"page":["dragstart","dragenter","dragover","drop:s7-dragged","dragend:copy"],"intercepted":1,"dispatched":["dragEnter","dragOver","drop"]} |
| file chooser: answered with a file, no dialog | yes | 125 | {"choosers":[{"at":1793876079061,"mode":"selectSingle"}],"files":["s7-upload.txt:23:hello from the viewport"]} |
| a window the page opens: offscreen too, its opener kept, shown in the viewport and clicked | **no** | 3780 | {"offscreen":true,"visible":false,"size":"480x360","painting":true,"frameRate":30,"pageSize":"0x0","sameProcessAsOpener":true,"openerFramesOfTheChildSize":0,"paintsAfterRepaint":0,"pageState":"{\"clicks\":0,\"hasOpener\":true,\"loadedAt\":1793876079201}","directClick":false,"paints":0,"openerMessages":["popup:hello"],"clickedInViewport":false} |
| a cross-site window the page opens (Electron #55565): offscreen, its opener kept, shown in the viewport and clicked | yes | 5734 | {"offscreen":true,"visible":false,"size":"480x360","painting":true,"frameRate":30,"pageSize":"480x360","sameProcessAsOpener":false,"openerFramesOfTheChildSize":0,"paintsAfterRepaint":1,"pageState":"{\"clicks\":0,\"hasOpener\":true,\"loadedAt\":1793876083004}","directClick":true,"paints":5,"openerMessages":["popup:hello","popup:hello@other-site","popup:click@other-site","popup:click@other-site"],"clickedInViewport":true} |
| resize: the page reflows to the viewport, no reload | yes | 191 | {"oneMs":22,"quickThreeMs":45,"backMs":41,"resizes":["1793876088101:1000x700","1793876088669:800x560","1793876088701:900x620","1793876088743:760x520","1793876088784:820x580","1793876088818:1000x700"],"applied":["1793876088101:1000x700","1793876088664:800x560","1793876088692:900x620","1793876088742:760x520","1793876088775:820x580","1793876088813:1000x700"],"token":"same"} |
| find-in-page: matches found and drawn | yes | 2 | {"requestId":0,"matches":1,"selectionArea":{"x":202,"y":163,"width":32,"height":16},"activeMatchOrdinal":1,"finalUpdate":true} |
| DevTools: open on the offscreen tab (detached window) | yes | 735 | {"opened":true} |
| accessibility: the page's tree is there to read over CDP (the OS sees none of it) | yes | 5 | {"nodes":55,"button":true,"accessibilitySupport":false} |
| a 2x display: the device-metrics override at a scale of 2 gives the viewport 2x frames | **no** | 1604 | {"pageDpr":2,"layout":"1000x700","frame":"1000x700","viewerCanvas":"1000x700"} |
| the tab's webContents.focus(): does the hidden window take the OS focus from the viewport? | yes | 701 | {"viewerFocusedBefore":true,"after":true,"focusedWindow":"S7 viewport","pageHasFocus":true,"tabVisible":false} |

| input → frame | trials | ms p50 / p95 | parts (p50) |
| :- | :- | :- | :- |
| viewport, mouse | 20 | 11 / 16 | to the page's handler 1; to the paint event 3; paint → drawn in the viewer 1; drawn → on screen (2 rAFs) 7 |
| viewport, key | 10 | 13 / 16 | to the page's handler 1; to the paint event 3; paint → drawn in the viewer 1; drawn → on screen (2 rAFs) 9 |
| native view, mouse | 20 | 7 / 12 | to the page's handler 1 |
| native view, key | 10 | 15 / 17 | to the page's handler 0 |

| frames | numbers |
| :- | :- |
| viewport, animated page | drawnPerSec 60.0, paintsPerSec 60.0, sentPerSec 60.0, droppedPerSec 0.0, pageRafPerSec 60.0, mbPerSec 58.6, drawMsP50 0.9, drawMsP95 1.1, cpuTotal 56.7, cpuBrowser 26.2, cpuGpu 4.8, cpuOffscreenRenderer 7.0, cpuViewerRenderer 18.5 |
| viewport, smooth scroll | ms 913.0, viewerFramesPerSec 61.3, pageRafPerSec 60.2 |
| native view, animated page | pageRafPerSec 60.0, cpuTotal 10.0, cpuBrowser 0.5, cpuGpu 2.5, cpuRenderer 6.3 |
| native view, smooth scroll | ms 910.0, pageRafPerSec 60.4 |

Windows on screen: a hidden offscreen tab and the viewer: 1 ["2097287 1000x727+60+60 IsViewable \"S7 viewport\""]; a <select> open: 1 ["2097287 1000x727+60+60 IsViewable \"S7 viewport\""]; a file chooser open: 1 ["2097287 1000x727+60+60 IsViewable \"S7 viewport\""]; the page's window open (offscreen): 1 ["2097287 1000x727+60+60 IsViewable \"S7 viewport\""]; the page's cross-site window open (offscreen): 1 ["2097287 1000x727+60+60 IsViewable \"S7 viewport\""]

Viewer: {"frames":514,"textures":0,"bitmaps":514,"popups":0,"draw":{"n":300,"min":0.8,"p50":0.9,"p95":2.4,"max":7.8,"mean":1.23},"errors":[]}; counters {"sent":514,"dropped":0,"fullFrames":4,"mbSent":525.29,"outstandingTextures":0,"forwarded":{"mouseMove":44,"mouseDown":31,"mouseUp":31,"mouseWheel":4,"keyDown":20,"keyUp":20,"char":14,"edit":1,"ime-start":1,"ime-set":2,"ime-commit":1,"paste":1,"mouseLeave":1},"errors":[],"tabTextures":0,"tabPopupTextures":0,"tabEmptyPaints":0,"tabPaints":520}

**Assertions:** PASS an offscreen tab draws with no window (CPU bitmaps asked at 30 fps: rAF above 10 Hz); PASS capturePage works on an offscreen tab; PASS four offscreen tabs put no window on screen; PASS no reload across show and hide through the viewport: same document, its timers, its socket, its form; PASS through the viewport: mouse: a click lands where the person clicked; PASS through the viewport: wheel: the page scrolls; PASS through the viewport: keys: typing, Backspace and select-all in the field; PASS through the viewport: IME: a composition in the viewport is composed and committed in the page; PASS through the viewport: paste: the person's paste reaches the page as a paste; PASS through the viewport: <select>: it opens, and the keys choose an option; PASS through the viewport: cursor: the page's cursor reaches the viewport; PASS through the viewport: drag: the same, with the browser's drag handed to the viewport (CDP Input.setInterceptDrags); PASS through the viewport: file chooser: answered with a file, no dialog; PASS through the viewport: resize: the page reflows to the viewport, no reload; PASS through the viewport: find-in-page: matches found and drawn; PASS through the viewport: DevTools: open on the offscreen tab (detached window); PASS through the viewport: accessibility: the page's tree is there to read over CDP (the OS sees none of it); PASS through the viewport: the tab's webContents.focus(): does the hidden window take the OS focus from the viewport?; PASS a known gap, pinned: an HTML5 drag sent as plain mouse events doesn't drop in an offscreen tab; PASS a known gap, pinned: a window the page opens, made offscreen, paints nothing; PASS the viewport draws an animated page at 45 fps or more

### Electron · viewport-macos-bitmap (electron-viewport-macos-bitmap.json)

Electron 45.2.2 (Chromium 156.0.8078.80), darwin-arm64 25.6.0, ozone (default), displays 1024x768@1, status **done**, 58 s

**Round twelve, the viewport** (mode **bitmap**: forced by S7_VIEWPORT_MODE=bitmap)

Shows: #1 first frame 17 ms, at the viewport's size 66 ms (1000x645, frame 1000x645), hidden again 3 ms; #2 first frame 6 ms, at the viewport's size 46 ms (1000x645, frame 1000x645), hidden again 6 ms

| oracle | same document | timers | SSE socket | form | layout | detail |
| :- | :- | :- | :- | :- | :- | :- |
| shown (first time) | true | true | true | true | 1000x645@1 | token same, loads +0, navigations +0, ticks 14→21, sse opens 1 (server 1) msgs 14→21, field "typed by the bot", checked true |
| hidden again (the agent's 1280x800) | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 384→399, sse opens 1 (server 1) msgs 371→386, field "x日本s7-paste-ok", checked true |
| shown again | true | true | true | true | 1000x645@1 | token same, loads +0, navigations +0, ticks 399→408, sse opens 1 (server 1) msgs 386→394, field "x日本s7-paste-ok", checked true |
| hidden at the end | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 408→423, sse opens 1 (server 1) msgs 394→409, field "x日本s7-paste-ok", checked true |

| through the viewport | ok | ms | detail |
| :- | :- | :- | :- |
| mouse: a click lands where the person clicked | yes | 110 | {"at":"260,40","page":{"x":260,"y":40,"t":1793876480922},"forwarded":{"mouseMove":1,"mouseDown":1,"mouseUp":1}} |
| wheel: the page scrolls | yes | 341 | {"scrollY":450,"wheels":4,"forwardedWheels":4} |
| keys: typing, Backspace and select-all in the field | yes | 1255 | {"typed":"typed by the botabc","afterBackspace":"typed by the botab","afterSelectAllAndX":"x","focused":"field","pageHasFocus":true,"keys":["End","a","b","c","Backspace","x"]} |
| IME: a composition in the viewport is composed and committed in the page | yes | 895 | {"field":"x日本","midField":"xにほ","compositions":["start:","update:にほ","update:日本","update:日本","end:日本"],"forwarded":{"set":2,"commit":1,"text":0}} |
| paste: the person's paste reaches the page as a paste | yes | 954 | {"field":"x日本s7-paste-ok","pasteEvents":["s7-paste-ok"],"clipboard":{},"forwarded":1} |
| <select>: it opens, and the keys choose an option | yes | 1665 | {"value":"c","changes":["c"],"popupTextures":0,"popupRects":["bitmap 180x146+480+48","bitmap 180x146+480+48"],"viewerPopups":0,"viewerPopupSizes":[]} |
| cursor: the page's cursor reaches the viewport | yes | 1227 | {"events":["hand","text","crosshair","move"],"viewerCursors":["pointer","text","crosshair","move"]} |
| drag: an HTML5 drag inside the page, sent as plain mouse events | **no** | 1369 | {"page":["dragstart"]} |
| drag: the same, with the browser's drag handed to the viewport (CDP Input.setInterceptDrags) | yes | 1350 | {"page":["dragstart","dragenter","dragover","drop:s7-dragged","dragend:copy"],"intercepted":1,"dispatched":["dragEnter","dragOver","drop"]} |
| file chooser: answered with a file, no dialog | yes | 151 | {"choosers":[{"at":1793876490113,"mode":"selectSingle"}],"files":["s7-upload.txt:23:hello from the viewport"]} |
| a window the page opens: offscreen too, its opener kept, shown in the viewport and clicked | **no** | 3853 | {"offscreen":true,"visible":false,"size":"480x360","painting":true,"frameRate":30,"pageSize":"0x0","sameProcessAsOpener":true,"openerFramesOfTheChildSize":0,"paintsAfterRepaint":0,"pageState":"{\"clicks\":0,\"hasOpener\":true,\"loadedAt\":1793876490299}","directClick":false,"paints":0,"openerMessages":["popup:hello"],"clickedInViewport":false} |
| a cross-site window the page opens (Electron #55565): offscreen, its opener kept, shown in the viewport and clicked | yes | 5876 | {"offscreen":true,"visible":false,"size":"480x360","painting":true,"frameRate":30,"pageSize":"480x360","sameProcessAsOpener":false,"openerFramesOfTheChildSize":0,"paintsAfterRepaint":1,"pageState":"{\"clicks\":0,\"hasOpener\":true,\"loadedAt\":1793876494217}","directClick":true,"paints":7,"openerMessages":["popup:hello","popup:hello@other-site","popup:click@other-site","popup:click@other-site"],"clickedInViewport":true} |
| resize: the page reflows to the viewport, no reload | yes | 298 | {"oneMs":81,"quickThreeMs":73,"backMs":51,"resizes":["1793876499387:1000x645","1793876499962:800x560","1793876500041:900x620","1793876500089:760x520","1793876500140:820x580","1793876500203:1000x645"],"applied":["1793876499385:1000x645","1793876499958:800x560","1793876500039:900x620","1793876500084:760x520","1793876500129:820x580","1793876500201:1000x645"],"token":"same"} |
| find-in-page: matches found and drawn | yes | 2 | {"requestId":0,"matches":1,"selectionArea":{"x":202,"y":163,"width":30,"height":17},"activeMatchOrdinal":1,"finalUpdate":true} |
| DevTools: open on the offscreen tab (detached window) | yes | 871 | {"opened":true} |
| accessibility: the page's tree is there to read over CDP (the OS sees none of it) | yes | 11 | {"nodes":55,"button":true,"accessibilitySupport":false} |
| a 2x display: the device-metrics override at a scale of 2 gives the viewport 2x frames | **no** | 1610 | {"pageDpr":2,"layout":"1000x645","frame":"1000x645","viewerCanvas":"1000x645"} |
| the tab's webContents.focus(): does the hidden window take the OS focus from the viewport? | yes | 730 | {"viewerFocusedBefore":true,"after":true,"focusedWindow":"S7 viewport","pageHasFocus":true,"tabVisible":false} |

| input → frame | trials | ms p50 / p95 | parts (p50) |
| :- | :- | :- | :- |
| viewport, mouse | 20 | 26 / 45 | to the page's handler 2; to the paint event 16; paint → drawn in the viewer 1; drawn → on screen (2 rAFs) 12 |
| viewport, key | 10 | 28 / 54 | to the page's handler 1; to the paint event 15; paint → drawn in the viewer 1; drawn → on screen (2 rAFs) 12 |
| native view, mouse | 20 | 9 / 18 | to the page's handler 0 |
| native view, key | 10 | 9 / 18 | to the page's handler 1 |

| frames | numbers |
| :- | :- |
| viewport, animated page | drawnPerSec 59.9, paintsPerSec 59.9, sentPerSec 59.9, droppedPerSec 0.0, pageRafPerSec 59.9, mbPerSec 58.5, drawMsP50 0.5, drawMsP95 1.4, cpuTotal 60.2, cpuBrowser 12.9, cpuGpu 27.3, cpuOffscreenRenderer 6.4, cpuViewerRenderer 13.5 |
| viewport, smooth scroll | ms 900.0, viewerFramesPerSec 61.1, pageRafPerSec 61.1 |
| native view, animated page | pageRafPerSec 59.9, cpuTotal 21.3, cpuBrowser 0.6, cpuGpu 12.1, cpuRenderer 8.2 |
| native view, smooth scroll | ms 909.0, pageRafPerSec 60.5 |

Windows on screen: a hidden offscreen tab and the viewer: 1 ["layer 0 alpha 1 1000x677+24+31 \"S7 viewport\""]; a <select> open: 1 ["layer 0 alpha 1 1000x677+24+31 \"S7 viewport\""]; a file chooser open: 1 ["layer 0 alpha 1 1000x677+24+31 \"S7 viewport\""]; the page's window open (offscreen): 1 ["layer 0 alpha 1 1000x677+24+31 \"S7 viewport\""]; the page's cross-site window open (offscreen): 1 ["layer 0 alpha 1 1000x677+24+31 \"S7 viewport\""]

Viewer: {"frames":450,"textures":0,"bitmaps":450,"popups":0,"draw":{"n":300,"min":0.3,"p50":0.6,"p95":1.7,"max":4.7,"mean":0.85},"errors":[]}; counters {"sent":450,"dropped":0,"fullFrames":4,"mbSent":489.19,"outstandingTextures":0,"forwarded":{"mouseMove":44,"mouseDown":31,"mouseUp":31,"mouseWheel":4,"keyDown":20,"keyUp":20,"char":14,"edit":1,"ime-start":1,"ime-set":2,"ime-commit":1,"paste":1,"mouseLeave":1},"errors":[],"tabTextures":0,"tabPopupTextures":0,"tabEmptyPaints":0,"tabPaints":450}

**Assertions:** PASS no reload across show and hide through the viewport: same document, its timers, its socket, its form; PASS through the viewport: mouse: a click lands where the person clicked; PASS through the viewport: wheel: the page scrolls; PASS through the viewport: keys: typing, Backspace and select-all in the field; PASS through the viewport: IME: a composition in the viewport is composed and committed in the page; PASS through the viewport: paste: the person's paste reaches the page as a paste; PASS through the viewport: <select>: it opens, and the keys choose an option; PASS through the viewport: cursor: the page's cursor reaches the viewport; PASS through the viewport: drag: the same, with the browser's drag handed to the viewport (CDP Input.setInterceptDrags); PASS through the viewport: file chooser: answered with a file, no dialog; PASS through the viewport: resize: the page reflows to the viewport, no reload; PASS through the viewport: find-in-page: matches found and drawn; PASS through the viewport: DevTools: open on the offscreen tab (detached window); PASS through the viewport: accessibility: the page's tree is there to read over CDP (the OS sees none of it); PASS through the viewport: the tab's webContents.focus(): does the hidden window take the OS focus from the viewport?; PASS a known gap, pinned: an HTML5 drag sent as plain mouse events doesn't drop in an offscreen tab; PASS a known gap, pinned: a window the page opens, made offscreen, paints nothing

### Electron · dialogs-macos (electron-viewport-macos-dialogs.json)

Electron 45.2.2 (Chromium 156.0.8078.80), darwin-arm64 25.6.0, ozone (default), displays 1024x768@1, status **done**, 24 s

**Round twelve, JavaScript dialogs answered over CDP**

| tab | dialog | CDP event | browser handler | windows during | windows after | page | error |
| :- | :- | :- | :- | :- | :- | :- | :- |
| offscreen tab | alert | true | true | ["layer 0 alpha 1 260x96+382+321","layer 0 alpha 1 1024x677+0+31 \"S7 viewport page\""] | ["layer 0 alpha 1 260x96+382+321","layer 0 alpha 1 1024x677+0+31 \"S7 viewport page\""] | alert:"returned":337ms |  |
| offscreen tab | confirm | true | true | ["layer 0 alpha 1 260x96+382+321","layer 0 alpha 1 1024x677+0+31 \"S7 viewport page\""] | ["layer 0 alpha 1 260x96+382+321","layer 0 alpha 1 1024x677+0+31 \"S7 viewport page\""] | alert:"returned":337ms | confirm:true:65ms |  |
| offscreen tab | prompt | false | – | ["layer 0 alpha 1 260x96+382+321","layer 0 alpha 1 1024x677+0+31 \"S7 viewport page\""] | ["layer 0 alpha 1 260x96+382+321","layer 0 alpha 1 1024x677+0+31 \"S7 viewport page\""] | alert:"returned":337ms | confirm:true:65ms |  |
| host window tab | alert | true | true | ["layer 0 alpha 1 260x96+0+31","layer 0 alpha 0 1x1+129+31 \"S7 tiny t2\""] | ["layer 0 alpha 1 260x96+0+31","layer 0 alpha 0 1x1+129+31 \"S7 tiny t2\""] | alert:"returned":87ms |  |
| host window tab | confirm | true | true | ["layer 0 alpha 1 260x96+0+31","layer 0 alpha 0 1x1+129+31 \"S7 tiny t2\""] | ["layer 0 alpha 1 260x96+0+31","layer 0 alpha 0 1x1+129+31 \"S7 tiny t2\""] | alert:"returned":87ms | confirm:true:81ms |  |
| host window tab | prompt | false | – | ["layer 0 alpha 1 260x96+0+31","layer 0 alpha 0 1x1+129+31 \"S7 tiny t2\""] | ["layer 0 alpha 1 260x96+0+31","layer 0 alpha 0 1x1+129+31 \"S7 tiny t2\""] | alert:"returned":87ms | confirm:true:81ms |  |
| offscreen tab, disableDialogs | alert | true | true | [] | [] | alert:"returned":1ms | handle: No dialog is showing |
| offscreen tab, disableDialogs | confirm | true | true | [] | [] | alert:"returned":1ms | confirm:false:0ms | handle: No dialog is showing |
| offscreen tab, disableDialogs | prompt | false | – | [] | [] | alert:"returned":1ms | confirm:false:0ms |  |

**Assertions:** PASS CDP sees every alert and confirm, offscreen, in the host window and with disableDialogs; PASS a known gap, pinned: an alert answered over CDP still leaves a native box up (offscreen tab); PASS a known gap, pinned: an alert answered over CDP still leaves a native box up (host window tab); PASS with disableDialogs an alert puts up no window

### Electron · viewport-macos (electron-viewport-macos.json)

Electron 45.2.2 (Chromium 156.0.8078.80), darwin-arm64 25.6.0, ozone (default), displays 1024x768@1, status **done**, 210 s

**Round twelve, offscreen bot tabs** (never-shown OSR windows; GPU "enabled")

Size: default: window 1280x800, page 1280x800@1 → **default**.

Shared textures: 40 textures, 0 bitmaps, 0 empty paints in 3 s → **they come here** — {"pixelFormat":"bgra","codedSize":"1280x800","handle":["ioSurface"]}

| config | visibility | rAF Hz | paints/s | textures/s | all CPU % | renderer % | GPU % | browser % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| offscreen, texture, 10 fps, animated | visible | 8.7 | 8.7 | 8.7 | 7.6 | 2.3 | 4.6 | 0.6 |  |
| offscreen, texture, 30 fps, animated | visible | 17.2 | 17.0 | 17.0 | 8.6 | 2.6 | 5.3 | 0.7 |  |
| offscreen, texture, 60 fps, animated | visible | 30.9 | 30.9 | 30.9 | 12.9 | 3.8 | 8.0 | 1.0 |  |
| offscreen, texture, 30 fps, painting stopped, animated | visible | 16.5 | 0.0 | 0.0 | 7.2 | 2.8 | 4.3 | 0.1 |  |
| offscreen, texture, 10 fps, quiet page | visible | 0.0 | 2.0 | 2.0 | 1.4 | 0.4 | 0.8 | 0.2 |  |
| offscreen, texture, painting stopped, quiet page | visible | 0.0 | 0.0 | 0.0 | 1.4 | 0.4 | 0.5 | 0.6 |  |
| offscreen, bitmap, 10 fps, animated | visible | 9.5 | 9.2 | 0.0 | 9.3 | 2.4 | 4.4 | 2.5 |  |
| offscreen, bitmap, 30 fps, animated | visible | 13.7 | 14.0 | 0.0 | 9.6 | 2.4 | 5.0 | 2.1 |  |
| offscreen, bitmap, 60 fps, animated | visible | 33.5 | 34.0 | 0.0 | 21.3 | 4.6 | 10.9 | 5.8 |  |
| offscreen, bitmap, 30 fps, painting stopped, animated | visible | 15.7 | 0.0 | 0.0 | 6.3 | 2.3 | 3.7 | 0.2 |  |
| offscreen, bitmap, 10 fps, quiet page | visible | 0.0 | 2.0 | 0.0 | 2.1 | 0.4 | 0.8 | 1.0 |  |
| offscreen, bitmap, painting stopped, quiet page | visible | 0.0 | 0.0 | 0.0 | 1.0 | 0.3 | 0.5 | 0.1 |  |
| host window, animated | visible | 59.9 | 0.0 | 0.0 | 24.9 | 8.7 | 15.9 | 0.2 |  |
| host window, quiet page | visible | 0.0 | 0.0 | 0.0 | 1.7 | 0.4 | 1.2 | 0.1 |  |

| pictures of | method | ok | ms | stale ms | size | errors |
| :- | :- | :- | :- | :- | :- | :- |
| offscreen, texture, painting on (10 fps) | capturePage | 5/5 | 95 / 116 | 37 / 56 | 1280x800 |  |
| offscreen, texture, painting on (10 fps) | cdpJpeg | 5/5 | 360 / 450 | -249 / -216 | 1280x800 |  |
| offscreen, texture, painting stopped | capturePage | 5/5 | 67 / 102 | -54 / -1 | 1280x800 |  |
| offscreen, texture, painting stopped | cdpJpeg | 5/5 | 380 / 396 | -277 / -208 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | capturePage | 5/5 | 46 / 117 | -40 / 0 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | cdpJpeg | 5/5 | 322 / 430 | -235 / -156 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | osrPaint | 5/5 | 0 / 0 | 199 / 226 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | newest paint → JPEG | 5/5 | 5 / 7 | – | 1280x800 |  |
| offscreen, bitmap, painting stopped | capturePage | 5/5 | 77 / 158 | 11 / 117 | 1280x800 |  |
| offscreen, bitmap, painting stopped | cdpJpeg | 5/5 | 358 / 374 | -229 / -176 | 1280x800 |  |
| host window | capturePage | 5/5 | 13 / 16 | -2 / 0 | 1280x800 |  |
| host window | cdpJpeg | 5/5 | 68 / 98 | -43 / -38 | 1280x800 |  |

| cost | MiB a tab | CPU % a tab | kind | error |
| :- | :- | :- | :- | :- |
| 4 quiet offscreen tabs (texture, 10 fps) | 52.8 | 1.67 | footprint |  |
| 4 quiet offscreen tabs (texture), painting stopped | 37.6 | 1.59 | footprint |  |
| 4 quiet tabs in one shared host window | 35.4 | 1.87 | footprint |  |

Windows on screen: 4 offscreen tabs open (nothing else shown): 0 []; 4 tabs in the shared host window: 1 ["layer 0 alpha 0 1x1+0+31 \"S7 shared host\""]

**Round twelve, the viewport** (mode **texture**: shared textures come on this machine)

Shows: #1 first frame 54 ms, at the viewport's size 54 ms (1000x645, frame 1000x645), hidden again 16 ms; #2 first frame 50 ms, at the viewport's size 50 ms (1000x645, frame 1000x645), hidden again 3 ms

| oracle | same document | timers | SSE socket | form | layout | detail |
| :- | :- | :- | :- | :- | :- | :- |
| shown (first time) | true | true | true | true | 1000x645@1 | token same, loads +0, navigations +0, ticks 14→22, sse opens 1 (server 1) msgs 14→21, field "typed by the bot", checked true |
| hidden again (the agent's 1280x800) | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 382→397, sse opens 1 (server 1) msgs 375→390, field "x日本s7-paste-ok", checked true |
| shown again | true | true | true | true | 1000x645@1 | token same, loads +0, navigations +0, ticks 397→406, sse opens 1 (server 1) msgs 390→398, field "x日本s7-paste-ok", checked true |
| hidden at the end | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 406→421, sse opens 1 (server 1) msgs 398→413, field "x日本s7-paste-ok", checked true |

| through the viewport | ok | ms | detail |
| :- | :- | :- | :- |
| mouse: a click lands where the person clicked | yes | 116 | {"at":"260,40","page":{"x":260,"y":40,"t":1793876397868},"forwarded":{"mouseMove":1,"mouseDown":1,"mouseUp":1}} |
| wheel: the page scrolls | yes | 332 | {"scrollY":450,"wheels":3,"forwardedWheels":4} |
| keys: typing, Backspace and select-all in the field | yes | 1240 | {"typed":"typed by the botabc","afterBackspace":"typed by the botab","afterSelectAllAndX":"x","focused":"field","pageHasFocus":true,"keys":["End","a","b","c","Backspace","x"]} |
| IME: a composition in the viewport is composed and committed in the page | yes | 994 | {"field":"x日本","midField":"xにほ","compositions":["start:","update:にほ","update:日本","update:日本","end:日本"],"forwarded":{"set":2,"commit":1,"text":0}} |
| paste: the person's paste reaches the page as a paste | yes | 951 | {"field":"x日本s7-paste-ok","pasteEvents":["s7-paste-ok"],"clipboard":{},"forwarded":1} |
| <select>: it opens, and the keys choose an option | yes | 1653 | {"value":"c","changes":["c"],"popupTextures":4,"popupRects":["popup 180x146+0+0","popup 178x140+1+1","popup 180x146+0+0"],"viewerPopups":4,"viewerPopupSizes":["180x146","180x146","180x146","180x146"]} |
| cursor: the page's cursor reaches the viewport | yes | 1211 | {"events":["hand","text","crosshair","move"],"viewerCursors":["pointer","text","crosshair","move"]} |
| drag: an HTML5 drag inside the page, sent as plain mouse events | **no** | 1354 | {"page":["dragstart"]} |
| drag: the same, with the browser's drag handed to the viewport (CDP Input.setInterceptDrags) | yes | 1362 | {"page":["dragstart","dragenter","dragover","drop:s7-dragged","dragend:copy"],"intercepted":1,"dispatched":["dragEnter","dragOver","drop"]} |
| file chooser: answered with a file, no dialog | yes | 146 | {"choosers":[{"at":1793876407085,"mode":"selectSingle"}],"files":["s7-upload.txt:23:hello from the viewport"]} |
| a window the page opens: offscreen too, its opener kept, shown in the viewport and clicked | **no** | 3859 | {"offscreen":true,"visible":false,"size":"480x360","painting":true,"frameRate":30,"pageSize":"0x0","sameProcessAsOpener":true,"openerFramesOfTheChildSize":0,"paintsAfterRepaint":0,"pageState":"{\"clicks\":0,\"hasOpener\":true,\"loadedAt\":1793876407267}","directClick":false,"paints":0,"openerMessages":["popup:hello"],"clickedInViewport":false} |
| a cross-site window the page opens (Electron #55565): offscreen, its opener kept, shown in the viewport and clicked | yes | 5994 | {"offscreen":true,"visible":false,"size":"480x360","painting":true,"frameRate":30,"pageSize":"480x360","sameProcessAsOpener":false,"openerFramesOfTheChildSize":0,"paintsAfterRepaint":1,"pageState":"{\"clicks\":0,\"hasOpener\":true,\"loadedAt\":1793876411360}","directClick":true,"paints":5,"openerMessages":["popup:hello","popup:hello@other-site","popup:click@other-site","popup:click@other-site"],"clickedInViewport":true} |
| resize: the page reflows to the viewport, no reload | yes | 306 | {"oneMs":83,"quickThreeMs":67,"backMs":65,"resizes":["1793876416484:1000x645","1793876417046:800x560","1793876417130:900x620","1793876417173:760x520","1793876417218:820x580","1793876417300:1000x645"],"applied":["1793876416482:1000x645","1793876417044:800x560","1793876417129:900x620","1793876417171:760x520","1793876417214:820x580","1793876417297:1000x645"],"token":"same"} |
| find-in-page: matches found and drawn | yes | 9 | {"requestId":0,"matches":1,"selectionArea":{"x":202,"y":163,"width":30,"height":17},"activeMatchOrdinal":1,"finalUpdate":true} |
| DevTools: open on the offscreen tab (detached window) | yes | 769 | {"opened":true} |
| accessibility: the page's tree is there to read over CDP (the OS sees none of it) | yes | 19 | {"nodes":55,"button":true,"accessibilitySupport":false} |
| a 2x display: the device-metrics override at a scale of 2 gives the viewport 2x frames | **no** | 1605 | {"pageDpr":2,"layout":"1000x645","frame":"1000x645","viewerCanvas":"1000x645"} |
| the tab's webContents.focus(): does the hidden window take the OS focus from the viewport? | yes | 710 | {"viewerFocusedBefore":true,"after":true,"focusedWindow":"S7 viewport","pageHasFocus":true,"tabVisible":false} |

| input → frame | trials | ms p50 / p95 | parts (p50) |
| :- | :- | :- | :- |
| viewport, mouse | 20 | 25 / 33 | to the page's handler 1; to the paint event 10; paint → drawn in the viewer 1; drawn → on screen (2 rAFs) 12 |
| viewport, key | 10 | 23 / 48 | to the page's handler 1; to the paint event 8; paint → drawn in the viewer 1; drawn → on screen (2 rAFs) 6 |
| native view, mouse | 20 | 9 / 17 | to the page's handler 0 |
| native view, key | 10 | 10 / 17 | to the page's handler 1 |

| frames | numbers |
| :- | :- |
| viewport, animated page | drawnPerSec 60.0, paintsPerSec 60.0, sentPerSec 60.0, droppedPerSec 0.0, pageRafPerSec 60.0, mbPerSec 0.0, drawMsP50 0.3, drawMsP95 0.6, cpuTotal 49.9, cpuBrowser 7.5, cpuGpu 28.5, cpuOffscreenRenderer 5.2, cpuViewerRenderer 8.6 |
| viewport, smooth scroll | ms 901.0, viewerFramesPerSec 62.1, pageRafPerSec 61.0 |
| native view, animated page | pageRafPerSec 59.9, cpuTotal 11.3, cpuBrowser 0.3, cpuGpu 6.3, cpuRenderer 4.3 |
| native view, smooth scroll | ms 910.0, pageRafPerSec 60.4 |

Windows on screen: a hidden offscreen tab and the viewer: 1 ["layer 0 alpha 1 1000x677+24+31 \"S7 viewport\""]; a <select> open: 1 ["layer 0 alpha 1 1000x677+24+31 \"S7 viewport\""]; a file chooser open: 1 ["layer 0 alpha 1 1000x677+24+31 \"S7 viewport\""]; the page's window open (offscreen): 1 ["layer 0 alpha 1 1000x677+24+31 \"S7 viewport\""]; the page's cross-site window open (offscreen): 1 ["layer 0 alpha 1 1000x677+24+31 \"S7 viewport\""]

Viewer: {"frames":437,"textures":437,"bitmaps":0,"popups":4,"draw":{"n":300,"min":0.1,"p50":0.2,"p95":0.6,"max":1.5,"mean":0.28},"errors":[]}; counters {"sent":441,"dropped":0,"fullFrames":0,"mbSent":0,"outstandingTextures":0,"forwarded":{"mouseMove":44,"mouseDown":31,"mouseUp":31,"mouseWheel":4,"keyDown":20,"keyUp":20,"char":14,"edit":1,"ime-start":1,"ime-set":2,"ime-commit":1,"paste":1},"errors":[],"tabTextures":443,"tabPopupTextures":4,"tabEmptyPaints":0,"tabPaints":447}

**Assertions:** PASS an offscreen tab draws with no window (CPU bitmaps asked at 30 fps: rAF above 10 Hz); PASS capturePage works on an offscreen tab; PASS four offscreen tabs put no window on screen; PASS macOS: shared textures come (GPU compositing on); PASS no reload across show and hide through the viewport: same document, its timers, its socket, its form; PASS through the viewport: mouse: a click lands where the person clicked; PASS through the viewport: wheel: the page scrolls; PASS through the viewport: keys: typing, Backspace and select-all in the field; PASS through the viewport: IME: a composition in the viewport is composed and committed in the page; PASS through the viewport: paste: the person's paste reaches the page as a paste; PASS through the viewport: <select>: it opens, and the keys choose an option; PASS through the viewport: cursor: the page's cursor reaches the viewport; PASS through the viewport: drag: the same, with the browser's drag handed to the viewport (CDP Input.setInterceptDrags); PASS through the viewport: file chooser: answered with a file, no dialog; PASS through the viewport: resize: the page reflows to the viewport, no reload; PASS through the viewport: find-in-page: matches found and drawn; PASS through the viewport: DevTools: open on the offscreen tab (detached window); PASS through the viewport: accessibility: the page's tree is there to read over CDP (the OS sees none of it); PASS through the viewport: the tab's webContents.focus(): does the hidden window take the OS focus from the viewport?; PASS a known gap, pinned: an HTML5 drag sent as plain mouse events doesn't drop in an offscreen tab; PASS a known gap, pinned: a window the page opens, made offscreen, paints nothing; PASS the viewport draws an animated page at 45 fps or more

### Electron · dialogs-windows (electron-viewport-windows-dialogs.json)

Electron 45.2.2 (Chromium 156.0.8078.80), win32-x64 10.0.26100, ozone (default), displays 1024x768@1, status **done**, 33 s

**Round twelve, JavaScript dialogs answered over CDP**

| tab | dialog | CDP event | browser handler | windows during | windows after | page | error |
| :- | :- | :- | :- | :- | :- | :- | :- |
| offscreen tab | alert | true | true | ["#32770 366x125+321+270 ex 0x10101 \"Electron\""] | ["#32770 366x125+321+270 ex 0x10101 \"Electron\""] | alert:"returned":472ms |  |
| offscreen tab | confirm | true | true | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | alert:"returned":472ms | confirm:true:441ms |  |
| offscreen tab | prompt | false | – | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | alert:"returned":472ms | confirm:true:441ms |  |
| host window tab | alert | true | true | ["#32770 366x125+0+0 ex 0x10101 \"Electron\"","Chrome_WidgetWin_1 48x40+-8+0 ex 0x82801a0 \"S7 tiny t2\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | ["#32770 366x125+0+0 ex 0x10101 \"Electron\"","Chrome_WidgetWin_1 48x40+-8+0 ex 0x82801a0 \"S7 tiny t2\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | alert:"returned":453ms |  |
| host window tab | confirm | true | true | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+0+0 ex 0x10101 \"Electron\"","Chrome_WidgetWin_1 48x40+-8+0 ex 0x82801a0 \"S7 tiny t2\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+0+0 ex 0x10101 \"Electron\"","Chrome_WidgetWin_1 48x40+-8+0 ex 0x82801a0 \"S7 tiny t2\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | alert:"returned":453ms | confirm:true:440ms |  |
| host window tab | prompt | false | – | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+0+0 ex 0x10101 \"Electron\"","Chrome_WidgetWin_1 48x40+-8+0 ex 0x82801a0 \"S7 tiny t2\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+0+0 ex 0x10101 \"Electron\"","Chrome_WidgetWin_1 48x40+-8+0 ex 0x82801a0 \"S7 tiny t2\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | alert:"returned":453ms | confirm:true:440ms |  |
| offscreen tab, disableDialogs | alert | true | true | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+0+0 ex 0x10101 \"Electron\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+0+0 ex 0x10101 \"Electron\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | alert:"returned":1ms | handle: No dialog is showing |
| offscreen tab, disableDialogs | confirm | true | true | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+0+0 ex 0x10101 \"Electron\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+0+0 ex 0x10101 \"Electron\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | alert:"returned":1ms | confirm:false:2ms | handle: No dialog is showing |
| offscreen tab, disableDialogs | prompt | false | – | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+0+0 ex 0x10101 \"Electron\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+0+0 ex 0x10101 \"Electron\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | alert:"returned":1ms | confirm:false:2ms |  |

**Assertions:** PASS CDP sees every alert and confirm, offscreen, in the host window and with disableDialogs; PASS a known gap, pinned: an alert answered over CDP still leaves a native box up (offscreen tab); PASS a known gap, pinned: an alert answered over CDP still leaves a native box up (host window tab); PASS with disableDialogs an alert puts up no window

### Electron · viewport-windows-warp (electron-viewport-windows-warp.json)

Electron 45.2.2 (Chromium 156.0.8078.80), win32-x64 10.0.26100, ozone (default), displays 1024x768@1, status **done**, 224 s

**Round twelve, offscreen bot tabs** (never-shown OSR windows; GPU "enabled")

Size: default: window 1024x720, page 1024x720@1; setContentSize after creation: window 1280x800, page 1280x800@1; not resizable, then setContentSize: window 1280x800, page 1280x800@1; enableLargerThanScreen, then setContentSize: window 1280x800, page 1280x800@1; not resizable, enableLargerThanScreen, then setBounds: window 1280x800, page 1280x800@1 → **setContentSize after creation**.

Shared textures: 90 textures, 0 bitmaps, 0 empty paints in 3 s → **they come here** — {"pixelFormat":"bgra","codedSize":"1280x800","handle":["ntHandle"]}

| config | visibility | rAF Hz | paints/s | textures/s | all CPU % | renderer % | GPU % | browser % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| offscreen, texture, 10 fps, animated | visible | 10.0 | 10.2 | 10.2 | 77.9 | 5.2 | 71.8 | 0.8 |  |
| offscreen, texture, 30 fps, animated | visible | 30.0 | 30.0 | 30.0 | 195.1 | 7.4 | 186.1 | 1.5 |  |
| offscreen, texture, 60 fps, animated | visible | 56.2 | 55.5 | 55.5 | 344.5 | 11.4 | 330.3 | 2.8 |  |
| offscreen, texture, 30 fps, painting stopped, animated | visible | 30.0 | 0.0 | 0.0 | 140.2 | 7.0 | 132.9 | 0.2 |  |
| offscreen, texture, 10 fps, quiet page | visible | 0.0 | 2.3 | 2.3 | 11.0 | 0.5 | 9.1 | 1.4 |  |
| offscreen, texture, painting stopped, quiet page | visible | 0.0 | 0.0 | 0.0 | 6.2 | 0.6 | 5.4 | 0.2 |  |
| offscreen, bitmap, 10 fps, animated | visible | 10.2 | 10.0 | 0.0 | 77.1 | 5.5 | 65.8 | 5.9 |  |
| offscreen, bitmap, 30 fps, animated | visible | 30.0 | 30.0 | 0.0 | 187.1 | 7.4 | 167.1 | 12.6 |  |
| offscreen, bitmap, 60 fps, animated | visible | 57.0 | 57.0 | 0.0 | 341.1 | 11.9 | 305.9 | 23.2 |  |
| offscreen, bitmap, 30 fps, painting stopped, animated | visible | 30.2 | 0.0 | 0.0 | 139.7 | 7.3 | 132.2 | 0.3 |  |
| offscreen, bitmap, 10 fps, quiet page | visible | 0.0 | 2.5 | 0.0 | 11.1 | 0.6 | 8.8 | 1.7 |  |
| offscreen, bitmap, painting stopped, quiet page | visible | 0.0 | 0.0 | 0.0 | 6.4 | 0.6 | 5.6 | 0.2 |  |
| host window, animated | visible | 61.2 | 0.0 | 0.0 | 184.2 | 12.6 | 170.3 | 1.2 |  |
| host window, quiet page | visible | 0.0 | 0.0 | 0.0 | 4.5 | 0.6 | 3.7 | 0.2 |  |

| pictures of | method | ok | ms | stale ms | size | errors |
| :- | :- | :- | :- | :- | :- | :- |
| offscreen, texture, painting on (10 fps) | capturePage | 5/5 | 97 / 112 | -76 / -74 | 1280x800 |  |
| offscreen, texture, painting on (10 fps) | cdpJpeg | 5/5 | 299 / 325 | -263 / -239 | 1280x800 |  |
| offscreen, texture, painting stopped | capturePage | 5/5 | 97 / 97 | -78 / -2 | 1280x800 |  |
| offscreen, texture, painting stopped | cdpJpeg | 5/5 | 297 / 346 | -265 / -230 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | capturePage | 5/5 | 90 / 99 | 30 / 33 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | cdpJpeg | 5/5 | 397 / 404 | -264 / -263 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | osrPaint | 5/5 | 0 / 0 | 142 / 146 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | newest paint → JPEG | 5/5 | 6 / 7 | – | 1280x800 |  |
| offscreen, bitmap, painting stopped | capturePage | 5/5 | 81 / 124 | -62 / 0 | 1280x800 |  |
| offscreen, bitmap, painting stopped | cdpJpeg | 5/5 | 298 / 309 | -266 / -265 | 1280x800 |  |
| host window | capturePage | 5/5 | 19 / 24 | 13 / 15 | 1280x800 |  |
| host window | cdpJpeg | 5/5 | 118 / 133 | -56 / -49 | 1280x800 |  |

| cost | MiB a tab | CPU % a tab | kind | error |
| :- | :- | :- | :- | :- |
| 4 quiet offscreen tabs (texture, 10 fps) | 25.3 | 10.05 | privateBytes |  |
| 4 quiet offscreen tabs (texture), painting stopped | 23.3 | 6.03 | privateBytes |  |
| 4 quiet tabs in one shared host window | 23.4 | 4.38 | privateBytes |  |

Windows on screen: 4 offscreen tabs open (nothing else shown): 0 []; 4 tabs in the shared host window: 1 ["Chrome_WidgetWin_1 48x40+-8+0 ex 0x82801a0 \"S7 shared host\""]

**Round twelve, the viewport** (mode **texture**: shared textures come on this machine)

Shows: #1 first frame 64 ms, at the viewport's size 64 ms (1000x681, frame 1000x681), hidden again 2 ms; #2 first frame 62 ms, at the viewport's size 62 ms (1000x681, frame 1000x681), hidden again 3 ms

| oracle | same document | timers | SSE socket | form | layout | detail |
| :- | :- | :- | :- | :- | :- | :- |
| shown (first time) | true | true | true | true | 1000x681@1 | token same, loads +0, navigations +0, ticks 15→26, sse opens 1 (server 1) msgs 14→25, field "typed by the bot", checked true |
| hidden again (the agent's 1280x800) | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 407→422, sse opens 1 (server 1) msgs 391→406, field "x日本s7-paste-ok", checked true |
| shown again | true | true | true | true | 1000x681@1 | token same, loads +0, navigations +0, ticks 422→431, sse opens 1 (server 1) msgs 406→414, field "x日本s7-paste-ok", checked true |
| hidden at the end | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 431→446, sse opens 1 (server 1) msgs 414→429, field "x日本s7-paste-ok", checked true |

| through the viewport | ok | ms | detail |
| :- | :- | :- | :- |
| mouse: a click lands where the person clicked | yes | 105 | {"at":"260,40","page":{"x":260,"y":40,"t":1793876341603},"forwarded":{"mouseMove":1,"mouseDown":1,"mouseUp":1}} |
| wheel: the page scrolls | yes | 325 | {"scrollY":600,"wheels":4,"forwardedWheels":4} |
| keys: typing, Backspace and select-all in the field | yes | 1236 | {"typed":"typed by the botabc","afterBackspace":"typed by the botab","afterSelectAllAndX":"x","focused":"field","pageHasFocus":true,"keys":["End","a","b","c","Backspace","x"]} |
| IME: a composition in the viewport is composed and committed in the page | yes | 881 | {"field":"x日本","midField":"xにほ","compositions":["start:","update:にほ","update:日本","update:日本","end:日本"],"forwarded":{"set":2,"commit":1,"text":0}} |
| paste: the person's paste reaches the page as a paste | yes | 942 | {"field":"x日本s7-paste-ok","pasteEvents":["s7-paste-ok"],"clipboard":{},"forwarded":1} |
| <select>: it opens, and the keys choose an option | yes | 2865 | {"value":"c","changes":["c"],"popupTextures":4,"popupRects":["popup 180x146+0+0","popup 178x140+1+1"],"viewerPopups":4,"viewerPopupSizes":["180x146","180x146","180x146","180x146"]} |
| cursor: the page's cursor reaches the viewport | yes | 1211 | {"events":["hand","text","crosshair","move"],"viewerCursors":["pointer","text","crosshair","move"]} |
| drag: an HTML5 drag inside the page, sent as plain mouse events | **no** | 1401 | {"page":["dragstart"]} |
| drag: the same, with the browser's drag handed to the viewport (CDP Input.setInterceptDrags) | yes | 1394 | {"page":["dragstart","dragenter","dragover","drop:s7-dragged","dragend:copy"],"intercepted":1,"dispatched":["dragEnter","dragOver","drop"]} |
| file chooser: answered with a file, no dialog | yes | 695 | {"choosers":[{"at":1793876351976,"mode":"selectSingle"}],"files":["s7-upload.txt:23:hello from the viewport"]} |
| a window the page opens: offscreen too, its opener kept, shown in the viewport and clicked | **no** | 4695 | {"offscreen":true,"visible":false,"size":"480x360","painting":true,"frameRate":30,"pageSize":"0x0","sameProcessAsOpener":true,"openerFramesOfTheChildSize":0,"paintsAfterRepaint":0,"pageState":"{\"clicks\":0,\"hasOpener\":true,\"loadedAt\":1793876352695}","directClick":false,"paints":0,"openerMessages":["popup:hello"],"clickedInViewport":false} |
| a cross-site window the page opens (Electron #55565): offscreen, its opener kept, shown in the viewport and clicked | yes | 6380 | {"offscreen":true,"visible":false,"size":"480x360","painting":true,"frameRate":30,"pageSize":"480x360","sameProcessAsOpener":false,"openerFramesOfTheChildSize":0,"paintsAfterRepaint":1,"pageState":"{\"clicks\":0,\"hasOpener\":true,\"loadedAt\":1793876357457}","directClick":true,"paints":5,"openerMessages":["popup:hello","popup:hello@other-site","popup:click@other-site","popup:click@other-site"],"clickedInViewport":true} |
| resize: the page reflows to the viewport, no reload | yes | 246 | {"oneMs":63,"quickThreeMs":28,"backMs":64,"resizes":["1793876363150:1000x681","1793876363717:800x560","1793876363780:900x620","1793876363833:760x520","1793876363866:820x580","1793876363900:1000x681"],"applied":["1793876363148:1000x681","1793876363714:800x560","1793876363776:900x620","1793876363827:760x520","1793876363858:820x580","1793876363891:1000x681"],"token":"same"} |
| find-in-page: matches found and drawn | yes | 5 | {"requestId":0,"matches":1,"selectionArea":{"x":202,"y":162,"width":30,"height":19},"activeMatchOrdinal":1,"finalUpdate":true} |
| DevTools: open on the offscreen tab (detached window) | yes | 847 | {"opened":true} |
| accessibility: the page's tree is there to read over CDP (the OS sees none of it) | yes | 11 | {"nodes":55,"button":true,"accessibilitySupport":false} |
| a 2x display: the device-metrics override at a scale of 2 gives the viewport 2x frames | **no** | 1608 | {"pageDpr":2,"layout":"1000x681","frame":"1000x681","viewerCanvas":"1000x681"} |
| the tab's webContents.focus(): does the hidden window take the OS focus from the viewport? | yes | 716 | {"viewerFocusedBefore":true,"after":true,"focusedWindow":"S7 viewport","pageHasFocus":true,"tabVisible":false} |

| input → frame | trials | ms p50 / p95 | parts (p50) |
| :- | :- | :- | :- |
| viewport, mouse | 20 | 27 / 33 | to the page's handler 2; to the paint event 9; paint → drawn in the viewer 2; drawn → on screen (2 rAFs) 16 |
| viewport, key | 10 | 21 / 27 | to the page's handler 2; to the paint event 9; paint → drawn in the viewer 2; drawn → on screen (2 rAFs) 10 |
| native view, mouse | 20 | 18 / 18 | to the page's handler 1 |
| native view, key | 10 | 18 / 19 | to the page's handler 1 |

| frames | numbers |
| :- | :- |
| viewport, animated page | drawnPerSec 60.2, paintsPerSec 60.2, sentPerSec 60.2, droppedPerSec 0.0, pageRafPerSec 60.2, mbPerSec 0.0, drawMsP50 0.3, drawMsP95 0.5, cpuTotal 275.9, cpuBrowser 9.4, cpuGpu 246.5, cpuOffscreenRenderer 8.2, cpuViewerRenderer 11.6 |
| viewport, smooth scroll | ms 8.0, viewerFramesPerSec 250.0, pageRafPerSec 125.0 |
| native view, animated page | pageRafPerSec 53.0, cpuTotal 45.4, cpuBrowser 0.5, cpuGpu 37.7, cpuRenderer 6.8 |
| native view, smooth scroll | ms 13.0, pageRafPerSec 76.9 |

Windows on screen: a hidden offscreen tab and the viewer: 1 ["Chrome_WidgetWin_1 1016x746+60+60 ex 0x200100 \"S7 viewport\""]; a <select> open: 1 ["Chrome_WidgetWin_1 1016x746+60+60 ex 0x200100 \"S7 viewport\""]; a file chooser open: 1 ["Chrome_WidgetWin_1 1016x746+60+60 ex 0x200100 \"S7 viewport\""]; the page's window open (offscreen): 1 ["Chrome_WidgetWin_1 1016x746+60+60 ex 0x200100 \"S7 viewport\""]; the page's cross-site window open (offscreen): 1 ["Chrome_WidgetWin_1 1016x746+60+60 ex 0x200100 \"S7 viewport\""]

Viewer: {"frames":390,"textures":390,"bitmaps":0,"popups":4,"draw":{"n":300,"min":0.2,"p50":0.3,"p95":0.5,"max":3.3,"mean":0.37},"errors":[]}; counters {"sent":394,"dropped":0,"fullFrames":0,"mbSent":0,"outstandingTextures":0,"forwarded":{"mouseMove":44,"mouseDown":31,"mouseUp":31,"mouseWheel":4,"keyDown":20,"keyUp":20,"char":14,"edit":1,"ime-start":1,"ime-set":2,"ime-commit":1,"paste":1},"errors":[],"tabTextures":395,"tabPopupTextures":4,"tabEmptyPaints":0,"tabPaints":399}

**Assertions:** PASS an offscreen tab draws with no window (CPU bitmaps asked at 30 fps: rAF above 10 Hz); PASS capturePage works on an offscreen tab; PASS four offscreen tabs put no window on screen; PASS no reload across show and hide through the viewport: same document, its timers, its socket, its form; PASS through the viewport: mouse: a click lands where the person clicked; PASS through the viewport: wheel: the page scrolls; PASS through the viewport: keys: typing, Backspace and select-all in the field; PASS through the viewport: IME: a composition in the viewport is composed and committed in the page; PASS through the viewport: paste: the person's paste reaches the page as a paste; PASS through the viewport: <select>: it opens, and the keys choose an option; PASS through the viewport: cursor: the page's cursor reaches the viewport; PASS through the viewport: drag: the same, with the browser's drag handed to the viewport (CDP Input.setInterceptDrags); PASS through the viewport: file chooser: answered with a file, no dialog; PASS through the viewport: resize: the page reflows to the viewport, no reload; PASS through the viewport: find-in-page: matches found and drawn; PASS through the viewport: DevTools: open on the offscreen tab (detached window); PASS through the viewport: accessibility: the page's tree is there to read over CDP (the OS sees none of it); PASS through the viewport: the tab's webContents.focus(): does the hidden window take the OS focus from the viewport?; PASS a known gap, pinned: an HTML5 drag sent as plain mouse events doesn't drop in an offscreen tab; PASS a known gap, pinned: a window the page opens, made offscreen, paints nothing; PASS the viewport draws an animated page at 45 fps or more

### Electron · viewport-windows (electron-viewport-windows.json)

Electron 45.2.2 (Chromium 156.0.8078.80), win32-x64 10.0.26100, ozone (default), displays 1024x768@1, status **done**, 172 s

**Round twelve, offscreen bot tabs** (never-shown OSR windows; GPU "disabled_software")

Size: default: window 1024x720, page 1024x720@1; setContentSize after creation: window 1280x800, page 1280x800@1; not resizable, then setContentSize: window 1280x800, page 1280x800@1; enableLargerThanScreen, then setContentSize: window 1280x800, page 1280x800@1; not resizable, enableLargerThanScreen, then setBounds: window 1280x800, page 1280x800@1 → **setContentSize after creation**.

Shared textures: 0 textures, 0 bitmaps, 0 empty paints in 3 s → **none here (CPU bitmaps)**; error not asked for: GPU compositing is "disabled_software" here (asking hung the main process on the Linux runners)

| config | visibility | rAF Hz | paints/s | textures/s | all CPU % | renderer % | GPU % | browser % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| offscreen, bitmap, 10 fps, animated | visible | 10.0 | 10.0 | 0.0 | 13.4 | 7.0 | 3.8 | 2.5 |  |
| offscreen, bitmap, 30 fps, animated | visible | 30.0 | 30.0 | 0.0 | 37.0 | 17.5 | 11.9 | 7.5 |  |
| offscreen, bitmap, 60 fps, animated | visible | 60.0 | 60.0 | 0.0 | 64.3 | 29.5 | 22.4 | 12.3 |  |
| offscreen, bitmap, 30 fps, painting stopped, animated | visible | 30.0 | 0.0 | 0.0 | 31.3 | 17.1 | 13.3 | 0.7 |  |
| offscreen, bitmap, 10 fps, quiet page | visible | 0.0 | 2.3 | 0.0 | 4.2 | 0.8 | 0.7 | 2.6 |  |
| offscreen, bitmap, painting stopped, quiet page | visible | 0.0 | 0.0 | 0.0 | 1.8 | 0.8 | 0.7 | 0.2 |  |
| host window, animated | visible | 64.0 | 0.0 | 0.0 | 36.1 | 30.1 | 4.8 | 1.1 |  |
| host window, quiet page | visible | 0.0 | 0.0 | 0.0 | 1.4 | 0.9 | 0.4 | 0.1 |  |

| pictures of | method | ok | ms | stale ms | size | errors |
| :- | :- | :- | :- | :- | :- | :- |
| offscreen, bitmap, painting on (10 fps) | capturePage | 5/5 | 95 / 100 | -81 / -16 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | cdpJpeg | 5/5 | 298 / 317 | -272 / -263 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | osrPaint | 5/5 | 0 / 1 | 31 / 37 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | newest paint → JPEG | 5/5 | 9 / 9 | – | 1280x800 |  |
| offscreen, bitmap, painting stopped | capturePage | 5/5 | 96 / 97 | -83 / -7 | 1280x800 |  |
| offscreen, bitmap, painting stopped | cdpJpeg | 5/5 | 299 / 310 | -273 / -271 | 1280x800 |  |
| host window | capturePage | 5/5 | 23 / 23 | 3 / 5 | 1280x800 |  |
| host window | cdpJpeg | 5/5 | 84 / 90 | -45 / -32 | 1280x800 |  |

| cost | MiB a tab | CPU % a tab | kind | error |
| :- | :- | :- | :- | :- |
| 4 quiet offscreen tabs (bitmap, 10 fps) | 33.5 | 2.18 | privateBytes |  |
| 4 quiet offscreen tabs (bitmap), painting stopped | 12.1 | 1.60 | privateBytes |  |
| 4 quiet tabs in one shared host window | 28.1 | 1.41 | privateBytes |  |

Windows on screen: 4 offscreen tabs open (nothing else shown): 0 []; 4 tabs in the shared host window: 1 ["Chrome_WidgetWin_1 48x40+-8+0 ex 0x82801a0 \"S7 shared host\""]

**Round twelve, the viewport** (mode **bitmap**: no shared textures on this machine (GPU compositing "disabled_software"): CPU bitmaps)

Shows: #1 first frame 18 ms, at the viewport's size 27 ms (1000x681, frame 1000x681), hidden again 2 ms; #2 first frame 17 ms, at the viewport's size 25 ms (1000x681, frame 1000x681), hidden again 3 ms

| oracle | same document | timers | SSE socket | form | layout | detail |
| :- | :- | :- | :- | :- | :- | :- |
| shown (first time) | true | true | true | true | 1000x681@1 | token same, loads +0, navigations +0, ticks 15→25, sse opens 1 (server 1) msgs 14→24, field "typed by the bot", checked true |
| hidden again (the agent's 1280x800) | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 387→402, sse opens 1 (server 1) msgs 378→393, field "x日本s7-paste-ok", checked true |
| shown again | true | true | true | true | 1000x681@1 | token same, loads +0, navigations +0, ticks 402→411, sse opens 1 (server 1) msgs 393→401, field "x日本s7-paste-ok", checked true |
| hidden at the end | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 411→426, sse opens 1 (server 1) msgs 401→416, field "x日本s7-paste-ok", checked true |

| through the viewport | ok | ms | detail |
| :- | :- | :- | :- |
| mouse: a click lands where the person clicked | yes | 103 | {"at":"260,40","page":{"x":260,"y":40,"t":1793876085052},"forwarded":{"mouseMove":1,"mouseDown":1,"mouseUp":1}} |
| wheel: the page scrolls | yes | 326 | {"scrollY":450,"wheels":4,"forwardedWheels":4} |
| keys: typing, Backspace and select-all in the field | yes | 1219 | {"typed":"typed by the botabc","afterBackspace":"typed by the botab","afterSelectAllAndX":"x","focused":"field","pageHasFocus":true,"keys":["End","a","b","c","Backspace","x"]} |
| IME: a composition in the viewport is composed and committed in the page | yes | 1081 | {"field":"x日本","midField":"xにほ","compositions":["start:","update:にほ","update:日本","update:日本","end:日本"],"forwarded":{"set":2,"commit":1,"text":0}} |
| paste: the person's paste reaches the page as a paste | yes | 952 | {"field":"x日本s7-paste-ok","pasteEvents":["s7-paste-ok"],"clipboard":{},"forwarded":1} |
| <select>: it opens, and the keys choose an option | yes | 2357 | {"value":"c","changes":["c"],"popupTextures":0,"popupRects":["bitmap 180x146+480+48","bitmap 180x146+480+48","bitmap 180x146+480+48"],"viewerPopups":0,"viewerPopupSizes":[]} |
| cursor: the page's cursor reaches the viewport | yes | 1225 | {"events":["hand","text","crosshair","move"],"viewerCursors":["pointer","text","crosshair","move"]} |
| drag: an HTML5 drag inside the page, sent as plain mouse events | **no** | 1372 | {"page":["dragstart"]} |
| drag: the same, with the browser's drag handed to the viewport (CDP Input.setInterceptDrags) | yes | 1377 | {"page":["dragstart","dragenter","dragover","drop:s7-dragged","dragend:copy"],"intercepted":1,"dispatched":["dragEnter","dragOver","drop"]} |
| file chooser: answered with a file, no dialog | yes | 499 | {"choosers":[{"at":1793876095076,"mode":"selectSingle"}],"files":["s7-upload.txt:23:hello from the viewport"]} |
| a window the page opens: offscreen too, its opener kept, shown in the viewport and clicked | **no** | 4194 | {"offscreen":true,"visible":false,"size":"480x360","painting":true,"frameRate":30,"pageSize":"0x0","sameProcessAsOpener":true,"openerFramesOfTheChildSize":0,"paintsAfterRepaint":0,"pageState":"{\"clicks\":0,\"hasOpener\":true,\"loadedAt\":1793876095595}","directClick":false,"paints":0,"openerMessages":["popup:hello"],"clickedInViewport":false} |
| a cross-site window the page opens (Electron #55565): offscreen, its opener kept, shown in the viewport and clicked | yes | 6168 | {"offscreen":true,"visible":false,"size":"480x360","painting":true,"frameRate":30,"pageSize":"480x360","sameProcessAsOpener":false,"openerFramesOfTheChildSize":0,"paintsAfterRepaint":1,"pageState":"{\"clicks\":0,\"hasOpener\":true,\"loadedAt\":1793876099839}","directClick":true,"paints":6,"openerMessages":["popup:hello","popup:hello@other-site","popup:click@other-site","popup:click@other-site"],"clickedInViewport":true} |
| resize: the page reflows to the viewport, no reload | yes | 209 | {"oneMs":24,"quickThreeMs":47,"backMs":46,"resizes":["1793876105326:1000x681","1793876105901:800x560","1793876105942:900x620","1793876105976:760x520","1793876106020:820x580","1793876106067:1000x681"],"applied":["1793876105325:1000x681","1793876105900:800x560","1793876105927:900x620","1793876105972:760x520","1793876106018:820x580","1793876106065:1000x681"],"token":"same"} |
| find-in-page: matches found and drawn | yes | 4 | {"requestId":0,"matches":1,"selectionArea":{"x":202,"y":162,"width":30,"height":19},"activeMatchOrdinal":1,"finalUpdate":true} |
| DevTools: open on the offscreen tab (detached window) | yes | 829 | {"opened":true} |
| accessibility: the page's tree is there to read over CDP (the OS sees none of it) | yes | 6 | {"nodes":55,"button":true,"accessibilitySupport":false} |
| a 2x display: the device-metrics override at a scale of 2 gives the viewport 2x frames | **no** | 1609 | {"pageDpr":2,"layout":"1000x681","frame":"1000x681","viewerCanvas":"1000x681"} |
| the tab's webContents.focus(): does the hidden window take the OS focus from the viewport? | yes | 701 | {"viewerFocusedBefore":true,"after":true,"focusedWindow":"S7 viewport","pageHasFocus":true,"tabVisible":false} |

| input → frame | trials | ms p50 / p95 | parts (p50) |
| :- | :- | :- | :- |
| viewport, mouse | 20 | 15 / 17 | to the page's handler 1; to the paint event 3; paint → drawn in the viewer 1; drawn → on screen (2 rAFs) 11 |
| viewport, key | 10 | 14 / 18 | to the page's handler 1; to the paint event 3; paint → drawn in the viewer 1; drawn → on screen (2 rAFs) 10 |
| native view, mouse | 20 | 8 / 13 | to the page's handler 0 |
| native view, key | 10 | 6 / 16 | to the page's handler 0 |

| frames | numbers |
| :- | :- |
| viewport, animated page | drawnPerSec 60.0, paintsPerSec 60.0, sentPerSec 60.0, droppedPerSec 0.0, pageRafPerSec 60.0, mbPerSec 58.6, drawMsP50 0.8, drawMsP95 1.1, cpuTotal 64.1, cpuBrowser 22.0, cpuGpu 11.5, cpuOffscreenRenderer 9.4, cpuViewerRenderer 20.9 |
| viewport, smooth scroll | ms 1.0, viewerFramesPerSec 0.0, pageRafPerSec 1000.0 |
| native view, animated page | pageRafPerSec 64.0, cpuTotal 17.8, cpuBrowser 0.4, cpuGpu 8.0, cpuRenderer 9.0 |
| native view, smooth scroll | ms 8.0, pageRafPerSec 125.0 |

Windows on screen: a hidden offscreen tab and the viewer: 1 ["Chrome_WidgetWin_1 1016x746+60+60 ex 0x200100 \"S7 viewport\""]; a <select> open: 1 ["Chrome_WidgetWin_1 1016x746+60+60 ex 0x200100 \"S7 viewport\""]; a file chooser open: 1 ["Chrome_WidgetWin_1 1016x746+60+60 ex 0x200100 \"S7 viewport\""]; the page's window open (offscreen): 1 ["Chrome_WidgetWin_1 1016x746+60+60 ex 0x200100 \"S7 viewport\""]; the page's cross-site window open (offscreen): 1 ["Chrome_WidgetWin_1 1016x746+60+60 ex 0x200100 \"S7 viewport\""]

Viewer: {"frames":506,"textures":0,"bitmaps":506,"popups":0,"draw":{"n":300,"min":0.6,"p50":0.8,"p95":1.1,"max":5.4,"mean":0.85},"errors":[]}; counters {"sent":506,"dropped":0,"fullFrames":4,"mbSent":386.28,"outstandingTextures":0,"forwarded":{"mouseMove":44,"mouseDown":31,"mouseUp":31,"mouseWheel":4,"keyDown":20,"keyUp":20,"char":14,"edit":1,"ime-start":1,"ime-set":2,"ime-commit":1,"paste":1},"errors":[],"tabTextures":0,"tabPopupTextures":0,"tabEmptyPaints":0,"tabPaints":512}

**Assertions:** PASS an offscreen tab draws with no window (CPU bitmaps asked at 30 fps: rAF above 10 Hz); PASS capturePage works on an offscreen tab; PASS four offscreen tabs put no window on screen; PASS no reload across show and hide through the viewport: same document, its timers, its socket, its form; PASS through the viewport: mouse: a click lands where the person clicked; PASS through the viewport: wheel: the page scrolls; PASS through the viewport: keys: typing, Backspace and select-all in the field; PASS through the viewport: IME: a composition in the viewport is composed and committed in the page; PASS through the viewport: paste: the person's paste reaches the page as a paste; PASS through the viewport: <select>: it opens, and the keys choose an option; PASS through the viewport: cursor: the page's cursor reaches the viewport; PASS through the viewport: drag: the same, with the browser's drag handed to the viewport (CDP Input.setInterceptDrags); PASS through the viewport: file chooser: answered with a file, no dialog; PASS through the viewport: resize: the page reflows to the viewport, no reload; PASS through the viewport: find-in-page: matches found and drawn; PASS through the viewport: DevTools: open on the offscreen tab (detached window); PASS through the viewport: accessibility: the page's tree is there to read over CDP (the OS sees none of it); PASS through the viewport: the tab's webContents.focus(): does the hidden window take the OS focus from the viewport?; PASS a known gap, pinned: an HTML5 drag sent as plain mouse events doesn't drop in an offscreen tab; PASS a known gap, pinned: a window the page opens, made offscreen, paints nothing; PASS the viewport draws an animated page at 45 fps or more

