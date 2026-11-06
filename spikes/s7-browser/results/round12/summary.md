# Round twelve

Winter's model in Electron: offscreen bot tabs, one shown through a viewport, and JavaScript dialogs. Run 42002018170 on `3580061ad` (this folder), after a first run, 41998630149 on `988eaa71e`, whose Linux jobs hung (`first-run/`).

## Run 42002018170

### Electron · dialogs-linux-wayland (electron-viewport-linux-wayland-dialogs.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone wayland, displays 1920x1080@1, status **done**, 22 s

**Round twelve, JavaScript dialogs answered over CDP**

| tab | dialog | CDP event | browser handler | windows during | windows after | page | error |
| :- | :- | :- | :- | :- | :- | :- | :- |
| offscreen tab | alert | true | true | "no way to list windows here (Wayland or no display)" | "no way to list windows here (Wayland or no display)" | alert:"returned":78ms |  |
| offscreen tab | confirm | true | true | "no way to list windows here (Wayland or no display)" | "no way to list windows here (Wayland or no display)" | alert:"returned":78ms | confirm:true:25ms |  |
| offscreen tab | prompt | false | – | "no way to list windows here (Wayland or no display)" | "no way to list windows here (Wayland or no display)" | alert:"returned":78ms | confirm:true:25ms |  |
| host window tab | alert | true | true | "no way to list windows here (Wayland or no display)" | "no way to list windows here (Wayland or no display)" | alert:"returned":25ms |  |
| host window tab | confirm | true | true | "no way to list windows here (Wayland or no display)" | "no way to list windows here (Wayland or no display)" | alert:"returned":25ms | confirm:true:25ms |  |
| host window tab | prompt | false | – | "no way to list windows here (Wayland or no display)" | "no way to list windows here (Wayland or no display)" | alert:"returned":25ms | confirm:true:25ms |  |
| offscreen tab, disableDialogs | alert | true | true | "no way to list windows here (Wayland or no display)" | "no way to list windows here (Wayland or no display)" | alert:"returned":0ms | handle: No dialog is showing |
| offscreen tab, disableDialogs | confirm | true | true | "no way to list windows here (Wayland or no display)" | "no way to list windows here (Wayland or no display)" | alert:"returned":0ms | confirm:false:0ms | handle: No dialog is showing |
| offscreen tab, disableDialogs | prompt | false | – | "no way to list windows here (Wayland or no display)" | "no way to list windows here (Wayland or no display)" | alert:"returned":0ms | confirm:false:0ms |  |

### Electron · viewport-linux-wayland (electron-viewport-linux-wayland.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone wayland, displays 1920x1080@1, status **done**, 150 s

**Round twelve, offscreen bot tabs** (never-shown OSR windows; GPU "disabled_software")

Size: default: window 1280x800, page 1280x800@1 → **default**.

Shared textures: 0 textures, 0 bitmaps, 0 empty paints in 3 s → **none here (CPU bitmaps)**; error not asked for: GPU compositing is "disabled_software" here (asking hung the main process on the Linux runners)

| config | visibility | rAF Hz | paints/s | textures/s | all CPU % | renderer % | GPU % | browser % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| offscreen, bitmap, 10 fps, animated | visible | 10.0 | 10.0 | 0.0 | 11.5 | 6.0 | 1.8 | 3.8 |  |
| offscreen, bitmap, 30 fps, animated | visible | 30.0 | 30.0 | 0.0 | 28.5 | 14.5 | 5.8 | 8.3 |  |
| offscreen, bitmap, 60 fps, animated | visible | 60.0 | 60.0 | 0.0 | 55.5 | 27.0 | 12.0 | 16.5 |  |
| offscreen, bitmap, 30 fps, painting stopped, animated | visible | 30.2 | 0.0 | 0.0 | 19.2 | 14.0 | 4.7 | 0.5 |  |
| offscreen, bitmap, 10 fps, quiet page | visible | 0.0 | 4.3 | 0.0 | 4.0 | 1.0 | 0.5 | 2.5 |  |
| offscreen, bitmap, painting stopped, quiet page | visible | 0.0 | 0.0 | 0.0 | 1.8 | 0.8 | 0.8 | 0.3 |  |
| host window, animated | visible | 39.7 | 0.0 | 0.0 | 21.2 | 17.7 | 2.3 | 1.3 |  |
| host window, quiet page | visible | 0.0 | 0.0 | 0.0 | 1.3 | 1.0 | 0.3 | 0.0 |  |

| pictures of | method | ok | ms | stale ms | size | errors |
| :- | :- | :- | :- | :- | :- | :- |
| offscreen, bitmap, painting on (10 fps) | capturePage | 5/5 | 97 / 98 | -82 / -40 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | cdpJpeg | 5/5 | 298 / 311 | -268 / -266 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | osrPaint | 5/5 | 0 / 0 | 38 / 44 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | newest paint → JPEG | 5/5 | 7 / 8 | – | 1280x800 |  |
| offscreen, bitmap, painting stopped | capturePage | 5/5 | 97 / 98 | -84 / -52 | 1280x800 |  |
| offscreen, bitmap, painting stopped | cdpJpeg | 5/5 | 298 / 313 | -269 / -268 | 1280x800 |  |
| host window | capturePage | 5/5 | 23 / 23 | 37 / 42 | 1280x800 |  |
| host window | cdpJpeg | 5/5 | 147 / 151 | -72 / -63 | 1280x800 |  |

| cost | MiB a tab | CPU % a tab | kind | error |
| :- | :- | :- | :- | :- |
| 4 quiet offscreen tabs (bitmap, 10 fps) | 44.5 | 2.81 | pss |  |
| 4 quiet offscreen tabs (bitmap), painting stopped | 32.8 | 1.60 | pss |  |
| 4 quiet tabs in one shared host window | 30.1 | 1.31 | pss |  |

Windows on screen: 4 offscreen tabs open (nothing else shown): no way to list windows here (Wayland or no display); 4 tabs in the shared host window: no way to list windows here (Wayland or no display)

**Round twelve, the viewport** (mode **bitmap**: no shared textures on this machine (GPU compositing "disabled_software"): CPU bitmaps)

Shows: #1 first frame 19 ms, at the viewport's size 30 ms (1000x700, frame 1000x700), hidden again 1 ms; #2 first frame 15 ms, at the viewport's size 25 ms (1000x700, frame 1000x700), hidden again 1 ms

| oracle | same document | timers | SSE socket | form | layout | detail |
| :- | :- | :- | :- | :- | :- | :- |
| shown (first time) | true | false | false | true | 1000x700@1 | token same, loads +0, navigations +0, ticks 15→15, sse opens 1 (server 1) msgs 15→15, field "typed by the bot", checked true |
| hidden again (the agent's 1280x800) | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 305→320, sse opens 1 (server 1) msgs 304→319, field "x日本s7-paste-ok", checked true |
| shown again | true | true | true | true | 1000x700@1 | token same, loads +0, navigations +0, ticks 320→329, sse opens 1 (server 1) msgs 319→328, field "x日本s7-paste-ok", checked true |
| hidden at the end | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 329→344, sse opens 1 (server 1) msgs 328→343, field "x日本s7-paste-ok", checked true |

| through the viewport | ok | ms | detail |
| :- | :- | :- | :- |
| mouse: a click lands where the person clicked | yes | 103 | {"at":"260,40","page":{"x":260,"y":40,"t":1793870781785},"forwarded":{"mouseMove":1,"mouseDown":1,"mouseUp":1}} |
| wheel: the page scrolls | yes | 323 | {"scrollY":450,"wheels":4,"forwardedWheels":4} |
| keys: typing, Backspace and select-all in the field | yes | 1214 | {"typed":"typed by the botabc","afterBackspace":"typed by the botab","afterSelectAllAndX":"x","focused":"field","pageHasFocus":true,"keys":["End","a","b","c","Backspace","x"]} |
| IME: a composition in the viewport is composed and committed in the page | yes | 858 | {"field":"x日本","midField":"xにほ","compositions":["start:","update:にほ","update:日本","update:日本","end:日本"],"forwarded":{"set":2,"commit":1,"text":0}} |
| paste: the person's paste reaches the page as a paste | yes | 932 | {"field":"x日本s7-paste-ok","pasteEvents":["s7-paste-ok"],"clipboard":{},"forwarded":1} |
| <select>: it opens, and the keys choose an option | yes | 1595 | {"value":"c","changes":["c"],"popupTextures":0,"popupRects":["bitmap 180x146+480+48","bitmap 180x146+480+48","bitmap 180x146+480+48"],"viewerPopups":0,"viewerPopupSizes":[]} |
| cursor: the page's cursor reaches the viewport | yes | 1204 | {"events":["hand","text","crosshair","move"],"viewerCursors":["pointer","text","crosshair","move"]} |
| drag: an HTML5 drag inside the page, sent as plain mouse events | **no** | 1313 | {"page":["dragstart"]} |
| drag: the same, with the browser's drag handed to the viewport (CDP Input.setInterceptDrags) | yes | 1317 | {"page":["dragstart","dragenter","dragover","drop:s7-dragged","dragend:copy"],"intercepted":1,"dispatched":["dragEnter","dragOver","drop"]} |
| file chooser: answered with a file, no dialog | yes | 102 | {"choosers":[{"at":1793870790656,"mode":"selectSingle"}],"files":["s7-upload.txt:23:hello from the viewport"]} |
| a window the page opens: offscreen too, its opener kept, shown in the viewport and clicked | **no** | 3770 | {"offscreen":true,"visible":false,"size":"480x360","painting":true,"frameRate":30,"openerFramesOfTheChildSize":0,"paintsAfterRepaint":0,"pageState":"{\"clicks\":0,\"hasOpener\":true,\"loadedAt\":1793870790771}","directClick":false,"paints":0,"openerMessages":["popup:hello"],"clickedInViewport":false} |
| resize: the page reflows to the viewport, no reload | yes | 201 | {"oneMs":21,"quickThreeMs":48,"backMs":47,"resizes":["1793870781694:1000x700","1793870794495:800x560","1793870794526:900x620","1793870794569:760x520","1793870794610:820x580","1793870794660:1000x700"],"applied":["1793870781693:1000x700","1793870794492:800x560","1793870794515:900x620","1793870794567:760x520","1793870794597:820x580","1793870794643:1000x700"],"token":"same"} |
| find-in-page: matches found and drawn | yes | 2 | {"requestId":0,"matches":1,"selectionArea":{"x":202,"y":163,"width":32,"height":16},"activeMatchOrdinal":1,"finalUpdate":true} |
| DevTools: open on the offscreen tab (detached window) | yes | 725 | {"opened":true} |
| accessibility: the page's tree is there to read over CDP (the OS sees none of it) | yes | 5 | {"nodes":52,"button":true,"accessibilitySupport":false} |
| a 2x display: the device-metrics override at a scale of 2 gives the viewport 2x frames | **no** | 1603 | {"pageDpr":2,"layout":"1000x700","frame":"1000x700","viewerCanvas":"1000x700"} |
| the tab's webContents.focus(): does the hidden window take the OS focus from the viewport? | yes | 700 | {"viewerFocusedBefore":false,"after":false,"focusedWindow":"(none)","pageHasFocus":true,"tabVisible":false} |

| input → frame | trials | ms p50 / p95 | parts (p50) |
| :- | :- | :- | :- |
| viewport, mouse | 20 | 17 / 21 | to the page's handler 1; to the paint event 3; paint → drawn in the viewer 0; drawn → on screen (2 rAFs) 13 |
| viewport, key | 10 | 17 / 24 | to the page's handler 1; to the paint event 3; paint → drawn in the viewer 1; drawn → on screen (2 rAFs) 13 |
| native view, mouse | 20 | 9 / 10 | to the page's handler 0 |
| native view, key | 10 | 8 / 10 | to the page's handler 0 |

| frames | numbers |
| :- | :- |
| viewport, animated page | drawnPerSec 60.0, paintsPerSec 60.0, sentPerSec 60.0, droppedPerSec 0.0, pageRafPerSec 60.0, mbPerSec 58.6, drawMsP50 0.9, drawMsP95 1.0, cpuTotal 54.5, cpuBrowser 25.5, cpuGpu 5.0, cpuOffscreenRenderer 6.3, cpuViewerRenderer 17.8 |
| viewport, smooth scroll | ms 906.0, viewerFramesPerSec 60.7, pageRafPerSec 60.7 |
| native view, animated page | pageRafPerSec 39.5, cpuTotal 8.8, cpuBrowser 1.3, cpuGpu 2.8, cpuRenderer 4.0 |
| native view, smooth scroll | ms 909.0, pageRafPerSec 39.6 |

Windows on screen: a hidden offscreen tab and the viewer: no way to list windows here (Wayland or no display); a <select> open: no way to list windows here (Wayland or no display); a file chooser open: no way to list windows here (Wayland or no display); the page's window open (offscreen): no way to list windows here (Wayland or no display)

Viewer: {"frames":504,"textures":0,"bitmaps":504,"popups":0,"draw":{"n":300,"min":0.7,"p50":0.9,"p95":2.5,"max":6.1,"mean":1.22},"errors":[]}; counters {"sent":504,"dropped":0,"fullFrames":2,"mbSent":520.21,"outstandingTextures":0,"forwarded":{"mouseMove":42,"mouseDown":29,"mouseUp":29,"mouseWheel":4,"keyDown":20,"keyUp":20,"char":14,"edit":1,"ime-start":1,"ime-set":2,"ime-commit":1,"paste":1,"mouseLeave":1},"errors":[],"tabTextures":0,"tabPopupTextures":0,"tabEmptyPaints":0,"tabPaints":511}

### Electron · dialogs-linux-x11 (electron-viewport-linux-x11-dialogs.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone x11, displays 1920x1080@1, status **done**, 23 s

**Round twelve, JavaScript dialogs answered over CDP**

| tab | dialog | CDP event | browser handler | windows during | windows after | page | error |
| :- | :- | :- | :- | :- | :- | :- | :- |
| offscreen tab | alert | true | true | ["4194306 120x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)"] | ["4194306 120x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)"] | alert:"returned":226ms |  |
| offscreen tab | confirm | true | true | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)"] | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)"] | alert:"returned":226ms | confirm:true:67ms |  |
| offscreen tab | prompt | false | – | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)"] | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)"] | alert:"returned":226ms | confirm:true:67ms |  |
| host window tab | alert | true | true | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","2097158 1x1+0+0 IsViewable \"S7 tiny t2\"","4194513 120x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)"] | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","2097158 1x1+0+0 IsViewable \"S7 tiny t2\"","4194513 120x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)"] | alert:"returned":86ms |  |
| host window tab | confirm | true | true | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","2097158 1x1+0+0 IsViewable \"S7 tiny t2\"","4194513 120x81+0+0 IsViewable (has no name)","4194600 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)","4194601 1x1+-1+-1 IsViewable (has no name)"] | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","2097158 1x1+0+0 IsViewable \"S7 tiny t2\"","4194513 120x81+0+0 IsViewable (has no name)","4194600 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)","4194601 1x1+-1+-1 IsViewable (has no name)"] | alert:"returned":86ms | confirm:true:96ms |  |
| host window tab | prompt | false | – | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","2097158 1x1+0+0 IsViewable \"S7 tiny t2\"","4194513 120x81+0+0 IsViewable (has no name)","4194600 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)","4194601 1x1+-1+-1 IsViewable (has no name)"] | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","2097158 1x1+0+0 IsViewable \"S7 tiny t2\"","4194513 120x81+0+0 IsViewable (has no name)","4194600 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)","4194601 1x1+-1+-1 IsViewable (has no name)"] | alert:"returned":86ms | confirm:true:96ms |  |
| offscreen tab, disableDialogs | alert | true | true | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","4194513 120x81+0+0 IsViewable (has no name)","4194600 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)","4194601 1x1+-1+-1 IsViewable (has no name)"] | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","4194513 120x81+0+0 IsViewable (has no name)","4194600 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)","4194601 1x1+-1+-1 IsViewable (has no name)"] | alert:"returned":0ms | handle: No dialog is showing |
| offscreen tab, disableDialogs | confirm | true | true | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","4194513 120x81+0+0 IsViewable (has no name)","4194600 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)","4194601 1x1+-1+-1 IsViewable (has no name)"] | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","4194513 120x81+0+0 IsViewable (has no name)","4194600 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)","4194601 1x1+-1+-1 IsViewable (has no name)"] | alert:"returned":0ms | confirm:false:0ms | handle: No dialog is showing |
| offscreen tab, disableDialogs | prompt | false | – | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","4194513 120x81+0+0 IsViewable (has no name)","4194600 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)","4194601 1x1+-1+-1 IsViewable (has no name)"] | ["4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","4194513 120x81+0+0 IsViewable (has no name)","4194600 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)","4194601 1x1+-1+-1 IsViewable (has no name)"] | alert:"returned":0ms | confirm:false:0ms |  |

### Electron · viewport-linux-x11 (electron-viewport-linux-x11.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone x11, displays 1920x1080@1, status **done**, 154 s

**Round twelve, offscreen bot tabs** (never-shown OSR windows; GPU "disabled_software")

Size: default: window 1280x800, page 1280x800@1 → **default**.

Shared textures: 0 textures, 0 bitmaps, 0 empty paints in 3 s → **none here (CPU bitmaps)**; error not asked for: GPU compositing is "disabled_software" here (asking hung the main process on the Linux runners)

| config | visibility | rAF Hz | paints/s | textures/s | all CPU % | renderer % | GPU % | browser % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| offscreen, bitmap, 10 fps, animated | visible | 10.0 | 10.0 | 0.0 | 10.2 | 5.5 | 1.8 | 3.0 |  |
| offscreen, bitmap, 30 fps, animated | visible | 30.0 | 30.0 | 0.0 | 26.0 | 13.0 | 4.8 | 8.3 |  |
| offscreen, bitmap, 60 fps, animated | visible | 60.0 | 60.0 | 0.0 | 53.0 | 25.5 | 11.0 | 16.5 |  |
| offscreen, bitmap, 30 fps, painting stopped, animated | visible | 30.0 | 0.0 | 0.0 | 19.7 | 14.5 | 4.7 | 0.5 |  |
| offscreen, bitmap, 10 fps, quiet page | visible | 0.0 | 4.3 | 0.0 | 4.0 | 1.0 | 0.8 | 2.3 |  |
| offscreen, bitmap, painting stopped, quiet page | visible | 0.0 | 0.0 | 0.0 | 2.0 | 1.0 | 1.0 | 0.0 |  |
| host window, animated | visible | 60.0 | 0.0 | 0.0 | 26.2 | 23.2 | 2.5 | 0.5 |  |
| host window, quiet page | visible | 0.0 | 0.0 | 0.0 | 1.3 | 1.0 | 0.3 | 0.0 |  |

| pictures of | method | ok | ms | stale ms | size | errors |
| :- | :- | :- | :- | :- | :- | :- |
| offscreen, bitmap, painting on (10 fps) | capturePage | 5/5 | 97 / 97 | -82 / -44 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | cdpJpeg | 5/5 | 297 / 313 | -268 / -267 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | osrPaint | 5/5 | 0 / 0 | 37 / 44 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | newest paint → JPEG | 5/5 | 7 / 7 | – | 1280x800 |  |
| offscreen, bitmap, painting stopped | capturePage | 5/5 | 97 / 99 | -84 / -43 | 1280x800 |  |
| offscreen, bitmap, painting stopped | cdpJpeg | 5/5 | 297 / 313 | -269 / -268 | 1280x800 |  |
| host window | capturePage | 5/5 | 14 / 16 | 14 / 17 | 1280x800 |  |
| host window | cdpJpeg | 5/5 | 78 / 84 | -38 / -34 | 1280x800 |  |

| cost | MiB a tab | CPU % a tab | kind | error |
| :- | :- | :- | :- | :- |
| 4 quiet offscreen tabs (bitmap, 10 fps) | 47.4 | 2.85 | pss |  |
| 4 quiet offscreen tabs (bitmap), painting stopped | 30.7 | 1.69 | pss |  |
| 4 quiet tabs in one shared host window | 30.9 | 1.23 | pss |  |

Windows on screen: 4 offscreen tabs open (nothing else shown): 0 []; 4 tabs in the shared host window: 1 ["2097280 1x1+0+0 IsViewable \"S7 shared host\""]

**Round twelve, the viewport** (mode **bitmap**: no shared textures on this machine (GPU compositing "disabled_software"): CPU bitmaps)

Shows: #1 first frame 21 ms, at the viewport's size 30 ms (1000x700, frame 1000x700), hidden again 1 ms; #2 first frame 18 ms, at the viewport's size 34 ms (1000x700, frame 1000x700), hidden again 1 ms

| oracle | same document | timers | SSE socket | form | layout | detail |
| :- | :- | :- | :- | :- | :- | :- |
| shown (first time) | true | false | true | true | 1000x700@1 | token same, loads +0, navigations +0, ticks 15→15, sse opens 1 (server 1) msgs 14→15, field "typed by the bot", checked true |
| hidden again (the agent's 1280x800) | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 307→322, sse opens 1 (server 1) msgs 306→321, field "x日本s7-paste-ok", checked true |
| shown again | true | true | true | true | 1000x700@1 | token same, loads +0, navigations +0, ticks 322→330, sse opens 1 (server 1) msgs 321→329, field "x日本s7-paste-ok", checked true |
| hidden at the end | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 330→345, sse opens 1 (server 1) msgs 329→344, field "x日本s7-paste-ok", checked true |

| through the viewport | ok | ms | detail |
| :- | :- | :- | :- |
| mouse: a click lands where the person clicked | yes | 102 | {"at":"260,40","page":{"x":260,"y":40,"t":1793870775839},"forwarded":{"mouseMove":1,"mouseDown":1,"mouseUp":1}} |
| wheel: the page scrolls | yes | 322 | {"scrollY":450,"wheels":4,"forwardedWheels":4} |
| keys: typing, Backspace and select-all in the field | yes | 1216 | {"typed":"typed by the botabc","afterBackspace":"typed by the botab","afterSelectAllAndX":"x","focused":"field","pageHasFocus":true,"keys":["End","a","b","c","Backspace","x"]} |
| IME: a composition in the viewport is composed and committed in the page | yes | 859 | {"field":"x日本","midField":"xにほ","compositions":["start:","update:にほ","update:日本","update:日本","end:日本"],"forwarded":{"set":2,"commit":1,"text":0}} |
| paste: the person's paste reaches the page as a paste | yes | 933 | {"field":"x日本s7-paste-ok","pasteEvents":["s7-paste-ok"],"clipboard":{},"forwarded":1} |
| <select>: it opens, and the keys choose an option | yes | 1635 | {"value":"c","changes":["c"],"popupTextures":0,"popupRects":["bitmap 180x146+480+48","bitmap 180x146+480+48","bitmap 180x146+480+48"],"viewerPopups":0,"viewerPopupSizes":[]} |
| cursor: the page's cursor reaches the viewport | yes | 1204 | {"events":["hand","text","crosshair","move"],"viewerCursors":["pointer","text","crosshair","move"]} |
| drag: an HTML5 drag inside the page, sent as plain mouse events | **no** | 1320 | {"page":["dragstart"]} |
| drag: the same, with the browser's drag handed to the viewport (CDP Input.setInterceptDrags) | yes | 1318 | {"page":["dragstart","dragenter","dragover","drop:s7-dragged","dragend:copy"],"intercepted":1,"dispatched":["dragEnter","dragOver","drop"]} |
| file chooser: answered with a file, no dialog | yes | 128 | {"choosers":[{"at":1793870784764,"mode":"selectSingle"}],"files":["s7-upload.txt:23:hello from the viewport"]} |
| a window the page opens: offscreen too, its opener kept, shown in the viewport and clicked | **no** | 3797 | {"offscreen":true,"visible":false,"size":"480x360","painting":true,"frameRate":30,"openerFramesOfTheChildSize":0,"paintsAfterRepaint":0,"pageState":"{\"clicks\":0,\"hasOpener\":true,\"loadedAt\":1793870784910}","directClick":false,"paints":0,"openerMessages":["popup:hello"],"clickedInViewport":false} |
| resize: the page reflows to the viewport, no reload | yes | 232 | {"oneMs":43,"quickThreeMs":41,"backMs":62,"resizes":["1793870775765:1000x700","1793870788653:800x560","1793870788703:900x620","1793870788747:760x520","1793870788798:820x580","1793870788848:1000x700"],"applied":["1793870775764:1000x700","1793870788652:800x560","1793870788702:900x620","1793870788742:760x520","1793870788789:820x580","1793870788836:1000x700"],"token":"same"} |
| find-in-page: matches found and drawn | yes | 7 | {"requestId":0,"matches":1,"selectionArea":{"x":202,"y":163,"width":32,"height":16},"activeMatchOrdinal":1,"finalUpdate":true} |
| DevTools: open on the offscreen tab (detached window) | yes | 760 | {"opened":true} |
| accessibility: the page's tree is there to read over CDP (the OS sees none of it) | yes | 5 | {"nodes":52,"button":true,"accessibilitySupport":false} |
| a 2x display: the device-metrics override at a scale of 2 gives the viewport 2x frames | **no** | 1605 | {"pageDpr":2,"layout":"1000x700","frame":"1000x700","viewerCanvas":"1000x700"} |
| the tab's webContents.focus(): does the hidden window take the OS focus from the viewport? | yes | 701 | {"viewerFocusedBefore":true,"after":true,"focusedWindow":"S7 viewport","pageHasFocus":true,"tabVisible":false} |

| input → frame | trials | ms p50 / p95 | parts (p50) |
| :- | :- | :- | :- |
| viewport, mouse | 20 | 13 / 30 | to the page's handler 1; to the paint event 4; paint → drawn in the viewer 0; drawn → on screen (2 rAFs) 9 |
| viewport, key | 10 | 12 / 32 | to the page's handler 1; to the paint event 4; paint → drawn in the viewer 0; drawn → on screen (2 rAFs) 8 |
| native view, mouse | 20 | 14 / 18 | to the page's handler 0 |
| native view, key | 10 | 5 / 7 | to the page's handler 0 |

| frames | numbers |
| :- | :- |
| viewport, animated page | drawnPerSec 60.0, paintsPerSec 60.0, sentPerSec 60.0, droppedPerSec 0.0, pageRafPerSec 60.0, mbPerSec 58.6, drawMsP50 0.9, drawMsP95 1.1, cpuTotal 60.2, cpuBrowser 27.7, cpuGpu 5.5, cpuOffscreenRenderer 7.5, cpuViewerRenderer 19.5 |
| viewport, smooth scroll | ms 903.0, viewerFramesPerSec 62.0, pageRafPerSec 60.9 |
| native view, animated page | pageRafPerSec 60.3, cpuTotal 11.0, cpuBrowser 0.3, cpuGpu 3.0, cpuRenderer 7.5 |
| native view, smooth scroll | ms 914.0, pageRafPerSec 60.2 |

Windows on screen: a hidden offscreen tab and the viewer: 1 ["2097287 1000x727+60+60 IsViewable \"S7 viewport\""]; a <select> open: 1 ["2097287 1000x727+60+60 IsViewable \"S7 viewport\""]; a file chooser open: 1 ["2097287 1000x727+60+60 IsViewable \"S7 viewport\""]; the page's window open (offscreen): 1 ["2097287 1000x727+60+60 IsViewable \"S7 viewport\""]

Viewer: {"frames":481,"textures":0,"bitmaps":481,"popups":0,"draw":{"n":300,"min":0.8,"p50":0.9,"p95":2.5,"max":7.8,"mean":1.27},"errors":[]}; counters {"sent":481,"dropped":0,"fullFrames":2,"mbSent":522.12,"outstandingTextures":0,"forwarded":{"mouseMove":42,"mouseDown":29,"mouseUp":29,"mouseWheel":4,"keyDown":20,"keyUp":20,"char":14,"edit":1,"ime-start":1,"ime-set":2,"ime-commit":1,"paste":1,"mouseLeave":1},"errors":[],"tabTextures":0,"tabPopupTextures":0,"tabEmptyPaints":0,"tabPaints":487}

### Electron · viewport-macos-bitmap (electron-viewport-macos-bitmap.json)

Electron 45.2.2 (Chromium 156.0.8078.80), darwin-arm64 25.6.0, ozone (default), displays 1024x768@1, status **done**, 54 s

**Round twelve, the viewport** (mode **bitmap**: forced by S7_VIEWPORT_MODE=bitmap)

Shows: #1 first frame 51 ms, at the viewport's size 109 ms (1000x645, frame 1000x645), hidden again 19 ms; #2 first frame 16 ms, at the viewport's size 56 ms (1000x645, frame 1000x645), hidden again 3 ms

| oracle | same document | timers | SSE socket | form | layout | detail |
| :- | :- | :- | :- | :- | :- | :- |
| shown (first time) | true | true | true | true | 1000x645@1 | token same, loads +0, navigations +0, ticks 15→17, sse opens 1 (server 1) msgs 14→16, field "typed by the bot", checked true |
| hidden again (the agent's 1280x800) | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 335→350, sse opens 1 (server 1) msgs 327→341, field "x日本s7-paste-ok", checked true |
| shown again | true | true | true | true | 1000x645@1 | token same, loads +0, navigations +0, ticks 350→359, sse opens 1 (server 1) msgs 341→350, field "x日本s7-paste-ok", checked true |
| hidden at the end | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 359→374, sse opens 1 (server 1) msgs 350→365, field "x日本s7-paste-ok", checked true |

| through the viewport | ok | ms | detail |
| :- | :- | :- | :- |
| mouse: a click lands where the person clicked | yes | 110 | {"at":"260,40","page":{"x":260,"y":40,"t":1793871959565},"forwarded":{"mouseMove":1,"mouseDown":1,"mouseUp":1}} |
| wheel: the page scrolls | yes | 368 | {"scrollY":600,"wheels":4,"forwardedWheels":4} |
| keys: typing, Backspace and select-all in the field | yes | 1247 | {"typed":"typed by the botabc","afterBackspace":"typed by the botab","afterSelectAllAndX":"x","focused":"field","pageHasFocus":true,"keys":["End","a","b","c","Backspace","x"]} |
| IME: a composition in the viewport is composed and committed in the page | yes | 905 | {"field":"x日本","midField":"xにほ","compositions":["start:","update:にほ","update:日本","update:日本","end:日本"],"forwarded":{"set":2,"commit":1,"text":0}} |
| paste: the person's paste reaches the page as a paste | yes | 951 | {"field":"x日本s7-paste-ok","pasteEvents":["s7-paste-ok"],"clipboard":{},"forwarded":1} |
| <select>: it opens, and the keys choose an option | yes | 1729 | {"value":"c","changes":["c"],"popupTextures":0,"popupRects":["bitmap 180x146+480+48","bitmap 180x146+480+48","bitmap 180x146+480+48"],"viewerPopups":0,"viewerPopupSizes":[]} |
| cursor: the page's cursor reaches the viewport | yes | 1219 | {"events":["hand","text","crosshair","move"],"viewerCursors":["pointer","text","crosshair","move"]} |
| drag: an HTML5 drag inside the page, sent as plain mouse events | **no** | 1370 | {"page":["dragstart"]} |
| drag: the same, with the browser's drag handed to the viewport (CDP Input.setInterceptDrags) | yes | 1355 | {"page":["dragstart","dragenter","dragover","drop:s7-dragged","dragend:copy"],"intercepted":1,"dispatched":["dragEnter","dragOver","drop"]} |
| file chooser: answered with a file, no dialog | yes | 183 | {"choosers":[{"at":1793871968829,"mode":"selectSingle"}],"files":["s7-upload.txt:23:hello from the viewport"]} |
| a window the page opens: offscreen too, its opener kept, shown in the viewport and clicked | **no** | 3931 | {"offscreen":true,"visible":false,"size":"480x360","painting":true,"frameRate":30,"openerFramesOfTheChildSize":0,"paintsAfterRepaint":0,"pageState":"{\"clicks\":0,\"hasOpener\":true,\"loadedAt\":1793871969090}","directClick":false,"paints":0,"openerMessages":["popup:hello"],"clickedInViewport":false} |
| resize: the page reflows to the viewport, no reload | yes | 417 | {"oneMs":124,"quickThreeMs":89,"backMs":99,"resizes":["1793871959390:1000x645","1793871972924:800x560","1793871973052:900x620","1793871973115:760x520","1793871973145:820x580","1793871973236:1000x645"],"applied":["1793871959385:1000x645","1793871972915:800x560","1793871973046:900x620","1793871973100:760x520","1793871973141:820x580","1793871973231:1000x645"],"token":"same"} |
| find-in-page: matches found and drawn | yes | 8 | {"requestId":0,"matches":1,"selectionArea":{"x":202,"y":163,"width":30,"height":17},"activeMatchOrdinal":1,"finalUpdate":true} |
| DevTools: open on the offscreen tab (detached window) | yes | 2258 | {"opened":true} |
| accessibility: the page's tree is there to read over CDP (the OS sees none of it) | yes | 13 | {"nodes":52,"button":true,"accessibilitySupport":false} |
| a 2x display: the device-metrics override at a scale of 2 gives the viewport 2x frames | **no** | 1616 | {"pageDpr":2,"layout":"1000x645","frame":"1000x645","viewerCanvas":"1000x645"} |
| the tab's webContents.focus(): does the hidden window take the OS focus from the viewport? | yes | 715 | {"viewerFocusedBefore":true,"after":true,"focusedWindow":"S7 viewport","pageHasFocus":true,"tabVisible":false} |

| input → frame | trials | ms p50 / p95 | parts (p50) |
| :- | :- | :- | :- |
| viewport, mouse | 20 | 27 / 40 | to the page's handler 1; to the paint event 15; paint → drawn in the viewer 1; drawn → on screen (2 rAFs) 8 |
| viewport, key | 10 | 28 / 38 | to the page's handler 1; to the paint event 16; paint → drawn in the viewer 1; drawn → on screen (2 rAFs) 10 |
| native view, mouse | 20 | 10 / 19 | to the page's handler 1 |
| native view, key | 10 | 8 / 30 | to the page's handler 0 |

| frames | numbers |
| :- | :- |
| viewport, animated page | drawnPerSec 60.2, paintsPerSec 60.0, sentPerSec 60.0, droppedPerSec 0.0, pageRafPerSec 60.0, mbPerSec 58.6, drawMsP50 0.7, drawMsP95 2.0, cpuTotal 79.2, cpuBrowser 19.5, cpuGpu 34.8, cpuOffscreenRenderer 7.0, cpuViewerRenderer 17.7 |
| viewport, smooth scroll | ms 921.0, viewerFramesPerSec 63.0, pageRafPerSec 60.8 |
| native view, animated page | pageRafPerSec 60.0, cpuTotal 17.7, cpuBrowser 1.1, cpuGpu 9.8, cpuRenderer 6.4 |
| native view, smooth scroll | ms 927.0, pageRafPerSec 60.4 |

Windows on screen: a hidden offscreen tab and the viewer: 1 ["layer 0 alpha 1 1000x677+24+31 \"S7 viewport\""]; a <select> open: 1 ["layer 0 alpha 1 1000x677+24+31 \"S7 viewport\""]; a file chooser open: 1 ["layer 0 alpha 1 1000x677+24+31 \"S7 viewport\""]; the page's window open (offscreen): 1 ["layer 0 alpha 1 1000x677+24+31 \"S7 viewport\""]

Viewer: {"frames":443,"textures":0,"bitmaps":443,"popups":0,"draw":{"n":300,"min":0.3,"p50":0.8,"p95":2.6,"max":12.4,"mean":1.12},"errors":[]}; counters {"sent":443,"dropped":0,"fullFrames":2,"mbSent":479.6,"outstandingTextures":0,"forwarded":{"mouseMove":42,"mouseDown":29,"mouseUp":29,"mouseWheel":4,"keyDown":20,"keyUp":20,"char":14,"edit":1,"ime-start":1,"ime-set":2,"ime-commit":1,"paste":1,"mouseLeave":1},"errors":[],"tabTextures":0,"tabPopupTextures":0,"tabEmptyPaints":0,"tabPaints":448}

### Electron · dialogs-macos (electron-viewport-macos-dialogs.json)

Electron 45.2.2 (Chromium 156.0.8078.80), darwin-arm64 25.6.0, ozone (default), displays 1024x768@1, status **done**, 25 s

**Round twelve, JavaScript dialogs answered over CDP**

| tab | dialog | CDP event | browser handler | windows during | windows after | page | error |
| :- | :- | :- | :- | :- | :- | :- | :- |
| offscreen tab | alert | true | true | ["layer 0 alpha 1 260x96+382+321","layer 0 alpha 1 1024x677+0+31 \"S7 viewport page\""] | ["layer 0 alpha 1 260x96+382+321","layer 0 alpha 1 1024x677+0+31 \"S7 viewport page\""] | alert:"returned":217ms |  |
| offscreen tab | confirm | true | true | ["layer 0 alpha 1 260x96+382+321","layer 0 alpha 1 1024x677+0+31 \"S7 viewport page\""] | ["layer 0 alpha 1 260x96+382+321","layer 0 alpha 1 1024x677+0+31 \"S7 viewport page\""] | alert:"returned":217ms | confirm:true:89ms |  |
| offscreen tab | prompt | false | – | ["layer 0 alpha 1 260x96+382+321","layer 0 alpha 1 1024x677+0+31 \"S7 viewport page\""] | ["layer 0 alpha 1 260x96+382+321","layer 0 alpha 1 1024x677+0+31 \"S7 viewport page\""] | alert:"returned":217ms | confirm:true:89ms |  |
| host window tab | alert | true | true | ["layer 0 alpha 1 260x96+0+31","layer 0 alpha 0 1x1+129+31 \"S7 tiny t2\""] | ["layer 0 alpha 1 260x96+0+31","layer 0 alpha 0 1x1+129+31 \"S7 tiny t2\""] | alert:"returned":158ms |  |
| host window tab | confirm | true | true | ["layer 0 alpha 1 260x96+0+31","layer 0 alpha 0 1x1+129+31 \"S7 tiny t2\""] | ["layer 0 alpha 1 260x96+0+31","layer 0 alpha 0 1x1+129+31 \"S7 tiny t2\""] | alert:"returned":158ms | confirm:true:68ms |  |
| host window tab | prompt | false | – | ["layer 0 alpha 1 260x96+0+31","layer 0 alpha 0 1x1+129+31 \"S7 tiny t2\""] | ["layer 0 alpha 1 260x96+0+31","layer 0 alpha 0 1x1+129+31 \"S7 tiny t2\""] | alert:"returned":158ms | confirm:true:68ms |  |
| offscreen tab, disableDialogs | alert | true | true | [] | [] | alert:"returned":0ms | handle: No dialog is showing |
| offscreen tab, disableDialogs | confirm | true | true | [] | [] | alert:"returned":0ms | confirm:false:0ms | handle: No dialog is showing |
| offscreen tab, disableDialogs | prompt | false | – | [] | [] | alert:"returned":0ms | confirm:false:0ms |  |

### Electron · viewport-macos (electron-viewport-macos.json)

Electron 45.2.2 (Chromium 156.0.8078.80), darwin-arm64 25.6.0, ozone (default), displays 1024x768@1, status **done**, 211 s

**Round twelve, offscreen bot tabs** (never-shown OSR windows; GPU "enabled")

Size: default: window 1280x800, page 1280x800@1 → **default**.

Shared textures: 43 textures, 0 bitmaps, 0 empty paints in 3 s → **they come here** — {"pixelFormat":"bgra","codedSize":"1280x800","handle":["ioSurface"]}

| config | visibility | rAF Hz | paints/s | textures/s | all CPU % | renderer % | GPU % | browser % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| offscreen, texture, 10 fps, animated | visible | 8.7 | 8.2 | 8.2 | 9.2 | 2.9 | 5.6 | 0.7 |  |
| offscreen, texture, 30 fps, animated | visible | 12.7 | 12.7 | 12.7 | 15.2 | 4.7 | 9.5 | 0.9 |  |
| offscreen, texture, 60 fps, animated | visible | 28.7 | 28.7 | 28.7 | 26.2 | 8.0 | 16.2 | 2.1 |  |
| offscreen, texture, 30 fps, painting stopped, animated | visible | 19.7 | 0.0 | 0.0 | 17.9 | 6.0 | 11.0 | 0.9 |  |
| offscreen, texture, 10 fps, quiet page | visible | 0.0 | 2.0 | 2.0 | 2.8 | 0.9 | 1.5 | 0.4 |  |
| offscreen, texture, painting stopped, quiet page | visible | 0.0 | 0.0 | 0.0 | 1.8 | 0.6 | 0.9 | 0.3 |  |
| offscreen, bitmap, 10 fps, animated | visible | 10.0 | 10.0 | 0.0 | 11.0 | 3.1 | 5.5 | 2.4 |  |
| offscreen, bitmap, 30 fps, animated | visible | 18.2 | 17.7 | 0.0 | 15.7 | 4.0 | 7.8 | 3.9 |  |
| offscreen, bitmap, 60 fps, animated | visible | 29.5 | 29.0 | 0.0 | 22.5 | 5.3 | 11.7 | 5.5 |  |
| offscreen, bitmap, 30 fps, painting stopped, animated | visible | 16.7 | 0.0 | 0.0 | 10.3 | 3.9 | 6.2 | 0.2 |  |
| offscreen, bitmap, 10 fps, quiet page | visible | 0.0 | 2.3 | 0.0 | 2.6 | 0.4 | 0.9 | 1.2 |  |
| offscreen, bitmap, painting stopped, quiet page | visible | 0.0 | 0.0 | 0.0 | 1.6 | 0.5 | 0.8 | 0.2 |  |
| host window, animated | visible | 58.7 | 0.0 | 0.0 | 27.9 | 10.0 | 17.6 | 0.2 |  |
| host window, quiet page | visible | 0.0 | 0.0 | 0.0 | 3.4 | 0.8 | 2.1 | 0.5 |  |

| pictures of | method | ok | ms | stale ms | size | errors |
| :- | :- | :- | :- | :- | :- | :- |
| offscreen, texture, painting on (10 fps) | capturePage | 5/5 | 96 / 163 | 112 / 114 | 1280x800 |  |
| offscreen, texture, painting on (10 fps) | cdpJpeg | 5/5 | 498 / 560 | -263 / -217 | 1280x800 |  |
| offscreen, texture, painting stopped | capturePage | 5/5 | 101 / 146 | 16 / 25 | 1280x800 |  |
| offscreen, texture, painting stopped | cdpJpeg | 5/5 | 390 / 425 | -265 / -216 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | capturePage | 5/5 | 32 / 77 | 108 / 123 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | cdpJpeg | 5/5 | 500 / 581 | -287 / -151 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | osrPaint | 5/5 | 0 / 1 | 234 / 243 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | newest paint → JPEG | 5/5 | 6 / 9 | – | 1280x800 |  |
| offscreen, bitmap, painting stopped | capturePage | 5/5 | 14 / 102 | 117 / 234 | 1280x800 |  |
| offscreen, bitmap, painting stopped | cdpJpeg | 5/5 | 486 / 508 | -272 / -248 | 1280x800 |  |
| host window | capturePage | 5/5 | 19 / 27 | -5 / 0 | 1280x800 |  |
| host window | cdpJpeg | 5/5 | 77 / 88 | -48 / -35 | 1280x800 |  |

| cost | MiB a tab | CPU % a tab | kind | error |
| :- | :- | :- | :- | :- |
| 4 quiet offscreen tabs (texture, 10 fps) | 46.1 | 2.17 | footprint |  |
| 4 quiet offscreen tabs (texture), painting stopped | 37.5 | 1.58 | footprint |  |
| 4 quiet tabs in one shared host window | 35.3 | 1.93 | footprint |  |

Windows on screen: 4 offscreen tabs open (nothing else shown): 0 []; 4 tabs in the shared host window: 1 ["layer 0 alpha 0 1x1+0+31 \"S7 shared host\""]

**Round twelve, the viewport** (mode **texture**: shared textures come on this machine)

Shows: #1 first frame 63 ms, at the viewport's size 63 ms (1000x645, frame 1000x645), hidden again 29 ms; #2 first frame 63 ms, at the viewport's size 63 ms (1000x645, frame 1000x645), hidden again 6 ms

| oracle | same document | timers | SSE socket | form | layout | detail |
| :- | :- | :- | :- | :- | :- | :- |
| shown (first time) | true | true | true | true | 1000x645@1 | token same, loads +0, navigations +0, ticks 16→17, sse opens 1 (server 1) msgs 14→16, field "typed by the bot", checked true |
| hidden again (the agent's 1280x800) | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 329→345, sse opens 1 (server 1) msgs 322→337, field "x日本s7-paste-ok", checked true |
| shown again | true | true | true | true | 1000x645@1 | token same, loads +0, navigations +0, ticks 345→353, sse opens 1 (server 1) msgs 337→346, field "x日本s7-paste-ok", checked true |
| hidden at the end | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 353→368, sse opens 1 (server 1) msgs 346→361, field "x日本s7-paste-ok", checked true |

| through the viewport | ok | ms | detail |
| :- | :- | :- | :- |
| mouse: a click lands where the person clicked | yes | 117 | {"at":"260,40","page":{"x":260,"y":40,"t":1793871879251},"forwarded":{"mouseMove":1,"mouseDown":1,"mouseUp":1}} |
| wheel: the page scrolls | yes | 332 | {"scrollY":450,"wheels":2,"forwardedWheels":4} |
| keys: typing, Backspace and select-all in the field | yes | 1312 | {"typed":"typed by the botabc","afterBackspace":"typed by the botab","afterSelectAllAndX":"x","focused":"field","pageHasFocus":true,"keys":["End","a","b","c","Backspace","x"]} |
| IME: a composition in the viewport is composed and committed in the page | yes | 1006 | {"field":"x日本","midField":"xにほ","compositions":["start:","update:にほ","update:日本","update:日本","end:日本"],"forwarded":{"set":2,"commit":1,"text":0}} |
| paste: the person's paste reaches the page as a paste | yes | 947 | {"field":"x日本s7-paste-ok","pasteEvents":["s7-paste-ok"],"clipboard":{},"forwarded":1} |
| <select>: it opens, and the keys choose an option | yes | 1725 | {"value":"c","changes":["c"],"popupTextures":3,"popupRects":["popup 180x146+0+0"],"viewerPopups":3,"viewerPopupSizes":["180x146","180x146","180x146"]} |
| cursor: the page's cursor reaches the viewport | yes | 1215 | {"events":["hand","text","crosshair","move"],"viewerCursors":["pointer","text","crosshair","move"]} |
| drag: an HTML5 drag inside the page, sent as plain mouse events | **no** | 1348 | {"page":["dragstart"]} |
| drag: the same, with the browser's drag handed to the viewport (CDP Input.setInterceptDrags) | yes | 1359 | {"page":["dragstart","dragenter","dragover","drop:s7-dragged","dragend:copy"],"intercepted":1,"dispatched":["dragEnter","dragOver","drop"]} |
| file chooser: answered with a file, no dialog | yes | 186 | {"choosers":[{"at":1793871888638,"mode":"selectSingle"}],"files":["s7-upload.txt:23:hello from the viewport"]} |
| a window the page opens: offscreen too, its opener kept, shown in the viewport and clicked | **no** | 3968 | {"offscreen":true,"visible":false,"size":"480x360","painting":true,"frameRate":30,"openerFramesOfTheChildSize":0,"paintsAfterRepaint":0,"pageState":"{\"clicks\":0,\"hasOpener\":true,\"loadedAt\":1793871888932}","directClick":false,"paints":0,"openerMessages":["popup:hello"],"clickedInViewport":false} |
| resize: the page reflows to the viewport, no reload | yes | 374 | {"oneMs":93,"quickThreeMs":83,"backMs":101,"resizes":["1793871879127:1000x645","1793871892752:800x560","1793871892846:900x620","1793871892898:760x520","1793871892947:820x580","1793871893030:1000x645"],"applied":["1793871879123:1000x645","1793871892749:800x560","1793871892845:900x620","1793871892895:760x520","1793871892946:820x580","1793871893027:1000x645"],"token":"same"} |
| find-in-page: matches found and drawn | yes | 22 | {"requestId":0,"matches":1,"selectionArea":{"x":202,"y":163,"width":30,"height":17},"activeMatchOrdinal":1,"finalUpdate":true} |
| DevTools: open on the offscreen tab (detached window) | yes | 1555 | {"opened":true} |
| accessibility: the page's tree is there to read over CDP (the OS sees none of it) | yes | 73 | {"nodes":52,"button":true,"accessibilitySupport":false} |
| a 2x display: the device-metrics override at a scale of 2 gives the viewport 2x frames | **no** | 1616 | {"pageDpr":2,"layout":"1000x645","frame":"1000x645","viewerCanvas":"1000x645"} |
| the tab's webContents.focus(): does the hidden window take the OS focus from the viewport? | yes | 714 | {"viewerFocusedBefore":true,"after":true,"focusedWindow":"S7 viewport","pageHasFocus":true,"tabVisible":false} |

| input → frame | trials | ms p50 / p95 | parts (p50) |
| :- | :- | :- | :- |
| viewport, mouse | 20 | 26 / 32 | to the page's handler 2; to the paint event 12; paint → drawn in the viewer 1; drawn → on screen (2 rAFs) 12 |
| viewport, key | 10 | 21 / 44 | to the page's handler 1; to the paint event 8; paint → drawn in the viewer 1; drawn → on screen (2 rAFs) 3 |
| native view, mouse | 20 | 12 / 17 | to the page's handler 1 |
| native view, key | 10 | 5 / 26 | to the page's handler 1 |

| frames | numbers |
| :- | :- |
| viewport, animated page | drawnPerSec 59.2, paintsPerSec 59.2, sentPerSec 59.2, droppedPerSec 0.0, pageRafPerSec 59.2, mbPerSec 0.0, drawMsP50 0.3, drawMsP95 1.0, cpuTotal 67.0, cpuBrowser 10.5, cpuGpu 38.4, cpuOffscreenRenderer 7.2, cpuViewerRenderer 10.7 |
| viewport, smooth scroll | ms 934.0, viewerFramesPerSec 58.9, pageRafPerSec 60.0 |
| native view, animated page | pageRafPerSec 58.5, cpuTotal 17.9, cpuBrowser 0.9, cpuGpu 10.1, cpuRenderer 6.5 |
| native view, smooth scroll | ms 930.0, pageRafPerSec 60.2 |

Windows on screen: a hidden offscreen tab and the viewer: 1 ["layer 0 alpha 1 1000x677+24+31 \"S7 viewport\""]; a <select> open: 1 ["layer 0 alpha 1 1000x677+24+31 \"S7 viewport\""]; a file chooser open: 1 ["layer 0 alpha 1 1000x677+24+31 \"S7 viewport\""]; the page's window open (offscreen): 1 ["layer 0 alpha 1 1000x677+24+31 \"S7 viewport\""]

Viewer: {"frames":430,"textures":430,"bitmaps":0,"popups":3,"draw":{"n":300,"min":0,"p50":0.3,"p95":1,"max":7,"mean":0.44},"errors":[]}; counters {"sent":433,"dropped":0,"fullFrames":0,"mbSent":0,"outstandingTextures":0,"forwarded":{"mouseMove":42,"mouseDown":29,"mouseUp":29,"mouseWheel":4,"keyDown":20,"keyUp":20,"char":14,"edit":1,"ime-start":1,"ime-set":2,"ime-commit":1,"paste":1,"mouseLeave":2},"errors":[],"tabTextures":436,"tabPopupTextures":3,"tabEmptyPaints":0,"tabPaints":439}

### Electron · dialogs-windows (electron-viewport-windows-dialogs.json)

Electron 45.2.2 (Chromium 156.0.8078.80), win32-x64 10.0.26100, ozone (default), displays 1024x768@1, status **done**, 34 s

**Round twelve, JavaScript dialogs answered over CDP**

| tab | dialog | CDP event | browser handler | windows during | windows after | page | error |
| :- | :- | :- | :- | :- | :- | :- | :- |
| offscreen tab | alert | true | true | ["#32770 366x125+321+270 ex 0x10101 \"Electron\""] | ["#32770 366x125+321+270 ex 0x10101 \"Electron\""] | alert:"returned":547ms |  |
| offscreen tab | confirm | true | true | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | alert:"returned":547ms | confirm:true:479ms |  |
| offscreen tab | prompt | false | – | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | alert:"returned":547ms | confirm:true:479ms |  |
| host window tab | alert | true | true | ["#32770 366x125+0+0 ex 0x10101 \"Electron\"","Chrome_WidgetWin_1 48x40+-8+0 ex 0x82801a0 \"S7 tiny t2\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | ["#32770 366x125+0+0 ex 0x10101 \"Electron\"","Chrome_WidgetWin_1 48x40+-8+0 ex 0x82801a0 \"S7 tiny t2\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | alert:"returned":464ms |  |
| host window tab | confirm | true | true | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+0+0 ex 0x10101 \"Electron\"","Chrome_WidgetWin_1 48x40+-8+0 ex 0x82801a0 \"S7 tiny t2\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+0+0 ex 0x10101 \"Electron\"","Chrome_WidgetWin_1 48x40+-8+0 ex 0x82801a0 \"S7 tiny t2\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | alert:"returned":464ms | confirm:true:468ms |  |
| host window tab | prompt | false | – | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+0+0 ex 0x10101 \"Electron\"","Chrome_WidgetWin_1 48x40+-8+0 ex 0x82801a0 \"S7 tiny t2\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+0+0 ex 0x10101 \"Electron\"","Chrome_WidgetWin_1 48x40+-8+0 ex 0x82801a0 \"S7 tiny t2\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | alert:"returned":464ms | confirm:true:468ms |  |
| offscreen tab, disableDialogs | alert | true | true | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+0+0 ex 0x10101 \"Electron\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+0+0 ex 0x10101 \"Electron\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | alert:"returned":0ms | handle: No dialog is showing |
| offscreen tab, disableDialogs | confirm | true | true | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+0+0 ex 0x10101 \"Electron\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+0+0 ex 0x10101 \"Electron\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | alert:"returned":0ms | confirm:false:0ms | handle: No dialog is showing |
| offscreen tab, disableDialogs | prompt | false | – | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+0+0 ex 0x10101 \"Electron\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | ["#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+0+0 ex 0x10101 \"Electron\"","#32770 366x125+321+266 ex 0x10101 \"Electron\"","#32770 366x125+321+270 ex 0x10101 \"Electron\""] | alert:"returned":0ms | confirm:false:0ms |  |

### Electron · viewport-windows-warp (electron-viewport-windows-warp.json)

Electron 45.2.2 (Chromium 156.0.8078.80), win32-x64 10.0.26100, ozone (default), displays 1024x768@1, status **done**, 225 s

**Round twelve, offscreen bot tabs** (never-shown OSR windows; GPU "enabled")

Size: default: window 1024x720, page 1024x720@1; setContentSize after creation: window 1280x800, page 1280x800@1; not resizable, then setContentSize: window 1280x800, page 1280x800@1; enableLargerThanScreen, then setContentSize: window 1280x800, page 1280x800@1; not resizable, enableLargerThanScreen, then setBounds: window 1280x800, page 1280x800@1 → **setContentSize after creation**.

Shared textures: 90 textures, 0 bitmaps, 0 empty paints in 3 s → **they come here** — {"pixelFormat":"bgra","codedSize":"1280x800","handle":["ntHandle"]}

| config | visibility | rAF Hz | paints/s | textures/s | all CPU % | renderer % | GPU % | browser % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| offscreen, texture, 10 fps, animated | visible | 10.0 | 10.0 | 10.0 | 68.2 | 4.7 | 62.6 | 0.8 |  |
| offscreen, texture, 30 fps, animated | visible | 30.2 | 29.9 | 29.9 | 167.8 | 6.9 | 159.4 | 1.5 |  |
| offscreen, texture, 60 fps, animated | visible | 58.6 | 58.4 | 58.4 | 307.7 | 10.7 | 294.4 | 2.6 |  |
| offscreen, texture, 30 fps, painting stopped, animated | visible | 30.0 | 0.0 | 0.0 | 122.9 | 6.7 | 115.4 | 0.7 |  |
| offscreen, texture, 10 fps, quiet page | visible | 0.0 | 2.0 | 2.0 | 8.7 | 0.5 | 7.9 | 0.2 |  |
| offscreen, texture, painting stopped, quiet page | visible | 0.0 | 0.0 | 0.0 | 6.0 | 0.6 | 5.2 | 0.2 |  |
| offscreen, bitmap, 10 fps, animated | visible | 10.0 | 10.0 | 0.0 | 65.8 | 4.6 | 56.5 | 4.7 |  |
| offscreen, bitmap, 30 fps, animated | visible | 30.0 | 30.0 | 0.0 | 159.8 | 7.0 | 141.4 | 11.3 |  |
| offscreen, bitmap, 60 fps, animated | visible | 58.2 | 58.2 | 0.0 | 289.9 | 10.9 | 259.4 | 19.6 |  |
| offscreen, bitmap, 30 fps, painting stopped, animated | visible | 29.9 | 0.0 | 0.0 | 122.8 | 7.0 | 115.5 | 0.2 |  |
| offscreen, bitmap, 10 fps, quiet page | visible | 0.0 | 2.8 | 0.0 | 9.3 | 0.6 | 6.8 | 1.8 |  |
| offscreen, bitmap, painting stopped, quiet page | visible | 0.0 | 0.0 | 0.0 | 5.6 | 0.6 | 4.8 | 0.2 |  |
| host window, animated | visible | 61.1 | 0.0 | 0.0 | 166.8 | 12.1 | 153.5 | 1.2 |  |
| host window, quiet page | visible | 0.0 | 0.0 | 0.0 | 4.3 | 0.6 | 3.4 | 0.2 |  |

| pictures of | method | ok | ms | stale ms | size | errors |
| :- | :- | :- | :- | :- | :- | :- |
| offscreen, texture, painting on (10 fps) | capturePage | 5/5 | 88 / 117 | -71 / -19 | 1280x800 |  |
| offscreen, texture, painting on (10 fps) | cdpJpeg | 5/5 | 301 / 309 | -269 / -259 | 1280x800 |  |
| offscreen, texture, painting stopped | capturePage | 5/5 | 97 / 101 | -80 / -7 | 1280x800 |  |
| offscreen, texture, painting stopped | cdpJpeg | 5/5 | 298 / 298 | -269 / -260 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | capturePage | 5/5 | 97 / 134 | -78 / -6 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | cdpJpeg | 5/5 | 293 / 315 | -262 / -235 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | osrPaint | 5/5 | 0 / 1 | 42 / 138 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | newest paint → JPEG | 5/5 | 6 / 7 | – | 1280x800 |  |
| offscreen, bitmap, painting stopped | capturePage | 5/5 | 93 / 123 | -77 / -10 | 1280x800 |  |
| offscreen, bitmap, painting stopped | cdpJpeg | 5/5 | 297 / 327 | -262 / -252 | 1280x800 |  |
| host window | capturePage | 5/5 | 23 / 43 | 8 / 13 | 1280x800 |  |
| host window | cdpJpeg | 5/5 | 118 / 137 | -59 / -52 | 1280x800 |  |

| cost | MiB a tab | CPU % a tab | kind | error |
| :- | :- | :- | :- | :- |
| 4 quiet offscreen tabs (texture, 10 fps) | 32.5 | 9.22 | privateBytes |  |
| 4 quiet offscreen tabs (texture), painting stopped | 25.1 | 5.47 | privateBytes |  |
| 4 quiet tabs in one shared host window | 23.0 | 4.03 | privateBytes |  |

Windows on screen: 4 offscreen tabs open (nothing else shown): 0 []; 4 tabs in the shared host window: 1 ["Chrome_WidgetWin_1 48x40+-8+0 ex 0x82801a0 \"S7 shared host\""]

**Round twelve, the viewport** (mode **texture**: shared textures come on this machine)

Shows: #1 first frame 63 ms, at the viewport's size 63 ms (1000x681, frame 1000x681), hidden again 6 ms; #2 first frame 60 ms, at the viewport's size 60 ms (1000x681, frame 1000x681), hidden again 3 ms

| oracle | same document | timers | SSE socket | form | layout | detail |
| :- | :- | :- | :- | :- | :- | :- |
| shown (first time) | true | true | true | true | 1000x681@1 | token same, loads +0, navigations +0, ticks 15→21, sse opens 1 (server 1) msgs 14→20, field "typed by the bot", checked true |
| hidden again (the agent's 1280x800) | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 327→342, sse opens 1 (server 1) msgs 320→334, field "x日本s7-paste-ok", checked true |
| shown again | true | true | true | true | 1000x681@1 | token same, loads +0, navigations +0, ticks 342→351, sse opens 1 (server 1) msgs 334→343, field "x日本s7-paste-ok", checked true |
| hidden at the end | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 351→366, sse opens 1 (server 1) msgs 343→358, field "x日本s7-paste-ok", checked true |

| through the viewport | ok | ms | detail |
| :- | :- | :- | :- |
| mouse: a click lands where the person clicked | yes | 104 | {"at":"260,40","page":{"x":260,"y":40,"t":1793871062210},"forwarded":{"mouseMove":1,"mouseDown":1,"mouseUp":1}} |
| wheel: the page scrolls | yes | 335 | {"scrollY":450,"wheels":4,"forwardedWheels":4} |
| keys: typing, Backspace and select-all in the field | yes | 1241 | {"typed":"typed by the botabc","afterBackspace":"typed by the botab","afterSelectAllAndX":"x","focused":"field","pageHasFocus":true,"keys":["End","a","b","c","Backspace","x"]} |
| IME: a composition in the viewport is composed and committed in the page | yes | 881 | {"field":"x日本","midField":"xにほ","compositions":["start:","update:にほ","update:日本","update:日本","end:日本"],"forwarded":{"set":2,"commit":1,"text":0}} |
| paste: the person's paste reaches the page as a paste | yes | 953 | {"field":"x日本s7-paste-ok","pasteEvents":["s7-paste-ok"],"clipboard":{},"forwarded":1} |
| <select>: it opens, and the keys choose an option | yes | 2524 | {"value":"c","changes":["c"],"popupTextures":3,"popupRects":["popup 180x146+0+0","popup 178x140+1+1"],"viewerPopups":3,"viewerPopupSizes":["180x146","180x146","180x146"]} |
| cursor: the page's cursor reaches the viewport | yes | 1213 | {"events":["hand","text","crosshair","move"],"viewerCursors":["pointer","text","crosshair","move"]} |
| drag: an HTML5 drag inside the page, sent as plain mouse events | **no** | 1391 | {"page":["dragstart"]} |
| drag: the same, with the browser's drag handed to the viewport (CDP Input.setInterceptDrags) | yes | 1374 | {"page":["dragstart","dragenter","dragover","drop:s7-dragged","dragend:copy"],"intercepted":1,"dispatched":["dragEnter","dragOver","drop"]} |
| file chooser: answered with a file, no dialog | yes | 556 | {"choosers":[{"at":1793871072237,"mode":"selectSingle"}],"files":["s7-upload.txt:23:hello from the viewport"]} |
| a window the page opens: offscreen too, its opener kept, shown in the viewport and clicked | **no** | 4235 | {"offscreen":true,"visible":false,"size":"480x360","painting":true,"frameRate":30,"openerFramesOfTheChildSize":0,"paintsAfterRepaint":0,"pageState":"{\"clicks\":0,\"hasOpener\":true,\"loadedAt\":1793871072820}","directClick":false,"paints":0,"openerMessages":["popup:hello"],"clickedInViewport":false} |
| resize: the page reflows to the viewport, no reload | yes | 226 | {"oneMs":44,"quickThreeMs":44,"backMs":43,"resizes":["1793871062102:1000x681","1793871076993:800x560","1793871077047:900x620","1793871077119:760x520","1793871077135:820x580","1793871077178:1000x681"],"applied":["1793871062100:1000x681","1793871076991:800x560","1793871077046:900x620","1793871077094:760x520","1793871077129:820x580","1793871077176:1000x681"],"token":"same"} |
| find-in-page: matches found and drawn | yes | 3 | {"requestId":0,"matches":1,"selectionArea":{"x":202,"y":162,"width":30,"height":19},"activeMatchOrdinal":1,"finalUpdate":true} |
| DevTools: open on the offscreen tab (detached window) | yes | 824 | {"opened":true} |
| accessibility: the page's tree is there to read over CDP (the OS sees none of it) | yes | 9 | {"nodes":52,"button":true,"accessibilitySupport":false} |
| a 2x display: the device-metrics override at a scale of 2 gives the viewport 2x frames | **no** | 1606 | {"pageDpr":2,"layout":"1000x681","frame":"1000x681","viewerCanvas":"1000x681"} |
| the tab's webContents.focus(): does the hidden window take the OS focus from the viewport? | yes | 718 | {"viewerFocusedBefore":true,"after":true,"focusedWindow":"S7 viewport","pageHasFocus":true,"tabVisible":false} |

| input → frame | trials | ms p50 / p95 | parts (p50) |
| :- | :- | :- | :- |
| viewport, mouse | 20 | 20 / 32 | to the page's handler 1; to the paint event 6; paint → drawn in the viewer 2; drawn → on screen (2 rAFs) 11 |
| viewport, key | 10 | 19 / 32 | to the page's handler 1; to the paint event 6; paint → drawn in the viewer 1; drawn → on screen (2 rAFs) 12 |
| native view, mouse | 20 | 17 / 20 | to the page's handler 1 |
| native view, key | 10 | 17 / 32 | to the page's handler 0 |

| frames | numbers |
| :- | :- |
| viewport, animated page | drawnPerSec 60.2, paintsPerSec 60.0, sentPerSec 60.0, droppedPerSec 0.0, pageRafPerSec 60.0, mbPerSec 0.0, drawMsP50 0.4, drawMsP95 0.9, cpuTotal 244.9, cpuBrowser 9.2, cpuGpu 216.4, cpuOffscreenRenderer 7.3, cpuViewerRenderer 11.8 |
| viewport, smooth scroll | ms 10.0, viewerFramesPerSec 200.0, pageRafPerSec 100.0 |
| native view, animated page | pageRafPerSec 53.0, cpuTotal 42.1, cpuBrowser 0.6, cpuGpu 34.4, cpuRenderer 6.6 |
| native view, smooth scroll | ms 3.0, pageRafPerSec 333.3 |

Windows on screen: a hidden offscreen tab and the viewer: 1 ["Chrome_WidgetWin_1 1016x746+60+60 ex 0x200100 \"S7 viewport\""]; a <select> open: 1 ["Chrome_WidgetWin_1 1016x746+60+60 ex 0x200100 \"S7 viewport\""]; a file chooser open: 1 ["Chrome_WidgetWin_1 1016x746+60+60 ex 0x200100 \"S7 viewport\""]; the page's window open (offscreen): 1 ["Chrome_WidgetWin_1 1016x746+60+60 ex 0x200100 \"S7 viewport\""]

Viewer: {"frames":387,"textures":387,"bitmaps":0,"popups":3,"draw":{"n":300,"min":0.2,"p50":0.4,"p95":0.6,"max":3.1,"mean":0.43},"errors":[]}; counters {"sent":390,"dropped":0,"fullFrames":0,"mbSent":0,"outstandingTextures":0,"forwarded":{"mouseMove":42,"mouseDown":29,"mouseUp":29,"mouseWheel":4,"keyDown":20,"keyUp":20,"char":14,"edit":1,"ime-start":1,"ime-set":2,"ime-commit":1,"paste":1,"mouseLeave":1},"errors":[],"tabTextures":392,"tabPopupTextures":3,"tabEmptyPaints":0,"tabPaints":395}

### Electron · viewport-windows (electron-viewport-windows.json)

Electron 45.2.2 (Chromium 156.0.8078.80), win32-x64 10.0.26100, ozone (default), displays 1024x768@1, status **done**, 167 s

**Round twelve, offscreen bot tabs** (never-shown OSR windows; GPU "disabled_software")

Size: default: window 1024x720, page 1024x720@1; setContentSize after creation: window 1280x800, page 1280x800@1; not resizable, then setContentSize: window 1280x800, page 1280x800@1; enableLargerThanScreen, then setContentSize: window 1280x800, page 1280x800@1; not resizable, enableLargerThanScreen, then setBounds: window 1280x800, page 1280x800@1 → **setContentSize after creation**.

Shared textures: 0 textures, 0 bitmaps, 0 empty paints in 3 s → **none here (CPU bitmaps)**; error not asked for: GPU compositing is "disabled_software" here (asking hung the main process on the Linux runners)

| config | visibility | rAF Hz | paints/s | textures/s | all CPU % | renderer % | GPU % | browser % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| offscreen, bitmap, 10 fps, animated | visible | 10.0 | 10.0 | 0.0 | 13.0 | 6.8 | 3.7 | 2.3 |  |
| offscreen, bitmap, 30 fps, animated | visible | 30.0 | 30.0 | 0.0 | 33.9 | 17.0 | 11.6 | 5.3 |  |
| offscreen, bitmap, 60 fps, animated | visible | 60.0 | 60.0 | 0.0 | 62.6 | 31.4 | 22.5 | 8.6 |  |
| offscreen, bitmap, 30 fps, painting stopped, animated | visible | 30.0 | 0.0 | 0.0 | 25.9 | 14.9 | 10.3 | 0.7 |  |
| offscreen, bitmap, 10 fps, quiet page | visible | 0.0 | 2.3 | 0.0 | 3.1 | 0.8 | 0.6 | 1.7 |  |
| offscreen, bitmap, painting stopped, quiet page | visible | 0.0 | 0.0 | 0.0 | 1.6 | 0.7 | 0.7 | 0.2 |  |
| host window, animated | visible | 64.0 | 0.0 | 0.0 | 38.2 | 32.2 | 4.9 | 1.1 |  |
| host window, quiet page | visible | 0.0 | 0.0 | 0.0 | 1.2 | 0.7 | 0.3 | 0.2 |  |

| pictures of | method | ok | ms | stale ms | size | errors |
| :- | :- | :- | :- | :- | :- | :- |
| offscreen, bitmap, painting on (10 fps) | capturePage | 5/5 | 97 / 99 | -86 / -11 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | cdpJpeg | 5/5 | 299 / 310 | -274 / -273 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | osrPaint | 5/5 | 0 / 0 | 29 / 30 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | newest paint → JPEG | 5/5 | 6 / 6 | – | 1280x800 |  |
| offscreen, bitmap, painting stopped | capturePage | 5/5 | 96 / 98 | -84 / -5 | 1280x800 |  |
| offscreen, bitmap, painting stopped | cdpJpeg | 5/5 | 299 / 311 | -274 / -274 | 1280x800 |  |
| host window | capturePage | 5/5 | 21 / 22 | 3 / 6 | 1280x800 |  |
| host window | cdpJpeg | 5/5 | 72 / 84 | -34 / -32 | 1280x800 |  |

| cost | MiB a tab | CPU % a tab | kind | error |
| :- | :- | :- | :- | :- |
| 4 quiet offscreen tabs (bitmap, 10 fps) | 38.3 | 1.78 | privateBytes |  |
| 4 quiet offscreen tabs (bitmap), painting stopped | 20.4 | 1.47 | privateBytes |  |
| 4 quiet tabs in one shared host window | 26.4 | 1.26 | privateBytes |  |

Windows on screen: 4 offscreen tabs open (nothing else shown): 0 []; 4 tabs in the shared host window: 1 ["Chrome_WidgetWin_1 48x40+-8+0 ex 0x82801a0 \"S7 shared host\""]

**Round twelve, the viewport** (mode **bitmap**: no shared textures on this machine (GPU compositing "disabled_software"): CPU bitmaps)

Shows: #1 first frame 16 ms, at the viewport's size 26 ms (1000x681, frame 1000x681), hidden again 2 ms; #2 first frame 14 ms, at the viewport's size 22 ms (1000x681, frame 1000x681), hidden again 3 ms

| oracle | same document | timers | SSE socket | form | layout | detail |
| :- | :- | :- | :- | :- | :- | :- |
| shown (first time) | true | true | true | true | 1000x681@1 | token same, loads +0, navigations +0, ticks 15→20, sse opens 1 (server 1) msgs 14→19, field "typed by the bot", checked true |
| hidden again (the agent's 1280x800) | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 324→339, sse opens 1 (server 1) msgs 319→333, field "x日本s7-paste-ok", checked true |
| shown again | true | true | true | true | 1000x681@1 | token same, loads +0, navigations +0, ticks 339→347, sse opens 1 (server 1) msgs 333→342, field "x日本s7-paste-ok", checked true |
| hidden at the end | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 347→363, sse opens 1 (server 1) msgs 342→356, field "x日本s7-paste-ok", checked true |

| through the viewport | ok | ms | detail |
| :- | :- | :- | :- |
| mouse: a click lands where the person clicked | yes | 103 | {"at":"260,40","page":{"x":260,"y":40,"t":1793870801776},"forwarded":{"mouseMove":1,"mouseDown":1,"mouseUp":1}} |
| wheel: the page scrolls | yes | 336 | {"scrollY":600,"wheels":4,"forwardedWheels":4} |
| keys: typing, Backspace and select-all in the field | yes | 1231 | {"typed":"typed by the botabc","afterBackspace":"typed by the botab","afterSelectAllAndX":"x","focused":"field","pageHasFocus":true,"keys":["End","a","b","c","Backspace","x"]} |
| IME: a composition in the viewport is composed and committed in the page | yes | 1185 | {"field":"x日本","midField":"xにほ","compositions":["start:","update:にほ","update:日本","update:日本","end:日本"],"forwarded":{"set":2,"commit":1,"text":0}} |
| paste: the person's paste reaches the page as a paste | yes | 933 | {"field":"x日本s7-paste-ok","pasteEvents":["s7-paste-ok"],"clipboard":{},"forwarded":1} |
| <select>: it opens, and the keys choose an option | yes | 2596 | {"value":"c","changes":["c"],"popupTextures":0,"popupRects":["bitmap 180x146+480+48","bitmap 180x146+480+48","bitmap 180x146+480+48"],"viewerPopups":0,"viewerPopupSizes":[]} |
| cursor: the page's cursor reaches the viewport | yes | 1236 | {"events":["hand","text","crosshair","move"],"viewerCursors":["pointer","text","crosshair","move"]} |
| drag: an HTML5 drag inside the page, sent as plain mouse events | **no** | 1420 | {"page":["dragstart"]} |
| drag: the same, with the browser's drag handed to the viewport (CDP Input.setInterceptDrags) | yes | 1364 | {"page":["dragstart","dragenter","dragover","drop:s7-dragged","dragend:copy"],"intercepted":1,"dispatched":["dragEnter","dragOver","drop"]} |
| file chooser: answered with a file, no dialog | yes | 546 | {"choosers":[{"at":1793870812195,"mode":"selectSingle"}],"files":["s7-upload.txt:23:hello from the viewport"]} |
| a window the page opens: offscreen too, its opener kept, shown in the viewport and clicked | **no** | 4211 | {"offscreen":true,"visible":false,"size":"480x360","painting":true,"frameRate":30,"openerFramesOfTheChildSize":0,"paintsAfterRepaint":0,"pageState":"{\"clicks\":0,\"hasOpener\":true,\"loadedAt\":1793870812763}","directClick":false,"paints":0,"openerMessages":["popup:hello"],"clickedInViewport":false} |
| resize: the page reflows to the viewport, no reload | yes | 182 | {"oneMs":26,"quickThreeMs":21,"backMs":43,"resizes":["1793870801695:1000x681","1793870816916:800x560","1793870816960:900x620","1793870816993:760x520","1793870817029:820x580","1793870817077:1000x681"],"applied":["1793870801693:1000x681","1793870816915:800x560","1793870816951:900x620","1793870816984:760x520","1793870817027:820x580","1793870817059:1000x681"],"token":"same"} |
| find-in-page: matches found and drawn | yes | 3 | {"requestId":0,"matches":1,"selectionArea":{"x":202,"y":162,"width":30,"height":19},"activeMatchOrdinal":1,"finalUpdate":true} |
| DevTools: open on the offscreen tab (detached window) | yes | 788 | {"opened":true} |
| accessibility: the page's tree is there to read over CDP (the OS sees none of it) | yes | 6 | {"nodes":52,"button":true,"accessibilitySupport":false} |
| a 2x display: the device-metrics override at a scale of 2 gives the viewport 2x frames | **no** | 1606 | {"pageDpr":2,"layout":"1000x681","frame":"1000x681","viewerCanvas":"1000x681"} |
| the tab's webContents.focus(): does the hidden window take the OS focus from the viewport? | yes | 704 | {"viewerFocusedBefore":true,"after":true,"focusedWindow":"S7 viewport","pageHasFocus":true,"tabVisible":false} |

| input → frame | trials | ms p50 / p95 | parts (p50) |
| :- | :- | :- | :- |
| viewport, mouse | 20 | 15 / 19 | to the page's handler 1; to the paint event 3; paint → drawn in the viewer 1; drawn → on screen (2 rAFs) 12 |
| viewport, key | 10 | 15 / 17 | to the page's handler 1; to the paint event 3; paint → drawn in the viewer 1; drawn → on screen (2 rAFs) 11 |
| native view, mouse | 20 | 12 / 13 | to the page's handler 1 |
| native view, key | 10 | 11 / 13 | to the page's handler 1 |

| frames | numbers |
| :- | :- |
| viewport, animated page | drawnPerSec 60.0, paintsPerSec 60.0, sentPerSec 60.0, droppedPerSec 0.0, pageRafPerSec 60.0, mbPerSec 58.6, drawMsP50 0.6, drawMsP95 0.9, cpuTotal 52.9, cpuBrowser 18.1, cpuGpu 9.9, cpuOffscreenRenderer 7.7, cpuViewerRenderer 16.9 |
| viewport, smooth scroll | ms 7.0, viewerFramesPerSec 142.9, pageRafPerSec 142.9 |
| native view, animated page | pageRafPerSec 64.0, cpuTotal 16.5, cpuBrowser 0.6, cpuGpu 7.4, cpuRenderer 8.1 |
| native view, smooth scroll | ms 9.0, pageRafPerSec 111.1 |

Windows on screen: a hidden offscreen tab and the viewer: 1 ["Chrome_WidgetWin_1 1016x746+60+60 ex 0x200100 \"S7 viewport\""]; a <select> open: 1 ["Chrome_WidgetWin_1 1016x746+60+60 ex 0x200100 \"S7 viewport\""]; a file chooser open: 1 ["Chrome_WidgetWin_1 1016x746+60+60 ex 0x200100 \"S7 viewport\""]; the page's window open (offscreen): 1 ["Chrome_WidgetWin_1 1016x746+60+60 ex 0x200100 \"S7 viewport\""]

Viewer: {"frames":506,"textures":0,"bitmaps":506,"popups":0,"draw":{"n":300,"min":0.5,"p50":0.6,"p95":0.9,"max":4.1,"mean":0.7},"errors":[]}; counters {"sent":506,"dropped":0,"fullFrames":2,"mbSent":371.46,"outstandingTextures":0,"forwarded":{"mouseMove":42,"mouseDown":29,"mouseUp":29,"mouseWheel":4,"keyDown":20,"keyUp":20,"char":14,"edit":1,"ime-start":1,"ime-set":2,"ime-commit":1,"paste":1,"mouseLeave":1},"errors":[],"tabTextures":0,"tabPopupTextures":0,"tabEmptyPaints":0,"tabPaints":513}


## The first run, 41998630149 (`first-run/`)

macOS ran in full with GPU textures. On Linux the first offscreen tab that asked for textures, with no GPU compositing, hung Electron's main process until the step's 20-minute timeout (`linux-x11-hang.txt`, `linux-wayland-hang.txt`); only the dialogs step ran there. The Windows job was cancelled before it finished, and its log was not kept.


### Electron · dialogs-linux-wayland (electron-viewport-linux-wayland-dialogs.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1017-azure, ozone wayland, displays 1920x1080@1, status **done**, 14 s

**Round twelve, JavaScript dialogs answered over CDP**

| tab | dialog | CDP event | browser handler | windows during | windows after | page | error |
| :- | :- | :- | :- | :- | :- | :- | :- |
| offscreen tab | alert | true | true | "no way to list windows here (Wayland or no display)" | "no way to list windows here (Wayland or no display)" | alert:"returned":32ms |  |
| offscreen tab | confirm | true | true | "no way to list windows here (Wayland or no display)" | "no way to list windows here (Wayland or no display)" | alert:"returned":32ms | confirm:true:25ms |  |
| offscreen tab | prompt | false | – | "no way to list windows here (Wayland or no display)" | "no way to list windows here (Wayland or no display)" | alert:"returned":32ms | confirm:true:25ms |  |
| host window tab | alert | true | true | "no way to list windows here (Wayland or no display)" | "no way to list windows here (Wayland or no display)" | alert:"returned":26ms |  |
| host window tab | confirm | true | true | "no way to list windows here (Wayland or no display)" | "no way to list windows here (Wayland or no display)" | alert:"returned":26ms | confirm:true:25ms |  |
| host window tab | prompt | false | – | "no way to list windows here (Wayland or no display)" | "no way to list windows here (Wayland or no display)" | alert:"returned":26ms | confirm:true:25ms |  |

### Electron · dialogs-linux-x11 (electron-viewport-linux-x11-dialogs.json)

Electron 45.2.2 (Chromium 156.0.8078.80), linux-x64 7.0.0-1014-aws, ozone x11, displays 1920x1080@1, status **done**, 15 s

**Round twelve, JavaScript dialogs answered over CDP**

| tab | dialog | CDP event | browser handler | windows during | windows after | page | error |
| :- | :- | :- | :- | :- | :- | :- | :- |
| offscreen tab | alert | true | true | ["543 1920x1080+0+0 IsViewable (the root window) (has no name)","4194306 120x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)"] | ["543 1920x1080+0+0 IsViewable (the root window) (has no name)","4194306 120x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)"] | alert:"returned":40ms |  |
| offscreen tab | confirm | true | true | ["543 1920x1080+0+0 IsViewable (the root window) (has no name)","4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)"] | ["543 1920x1080+0+0 IsViewable (the root window) (has no name)","4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)"] | alert:"returned":40ms | confirm:true:45ms |  |
| offscreen tab | prompt | false | – | ["543 1920x1080+0+0 IsViewable (the root window) (has no name)","4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)"] | ["543 1920x1080+0+0 IsViewable (the root window) (has no name)","4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)"] | alert:"returned":40ms | confirm:true:45ms |  |
| host window tab | alert | true | true | ["543 1920x1080+0+0 IsViewable (the root window) (has no name)","4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","2097158 1x1+0+0 IsViewable \"S7 tiny t2\"","4194513 120x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)"] | ["543 1920x1080+0+0 IsViewable (the root window) (has no name)","4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","2097158 1x1+0+0 IsViewable \"S7 tiny t2\"","4194513 120x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)"] | alert:"returned":53ms |  |
| host window tab | confirm | true | true | ["543 1920x1080+0+0 IsViewable (the root window) (has no name)","4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","2097158 1x1+0+0 IsViewable \"S7 tiny t2\"","4194513 120x81+0+0 IsViewable (has no name)","4194600 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)","4194601 1x1+-1+-1 IsViewable (has no name)"] | ["543 1920x1080+0+0 IsViewable (the root window) (has no name)","4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","2097158 1x1+0+0 IsViewable \"S7 tiny t2\"","4194513 120x81+0+0 IsViewable (has no name)","4194600 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)","4194601 1x1+-1+-1 IsViewable (has no name)"] | alert:"returned":53ms | confirm:true:62ms |  |
| host window tab | prompt | false | – | ["543 1920x1080+0+0 IsViewable (the root window) (has no name)","4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","2097158 1x1+0+0 IsViewable \"S7 tiny t2\"","4194513 120x81+0+0 IsViewable (has no name)","4194600 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)","4194601 1x1+-1+-1 IsViewable (has no name)"] | ["543 1920x1080+0+0 IsViewable (the root window) (has no name)","4194306 120x81+0+0 IsViewable (has no name)","4194358 156x81+0+0 IsViewable (has no name)","2097158 1x1+0+0 IsViewable \"S7 tiny t2\"","4194513 120x81+0+0 IsViewable (has no name)","4194600 156x81+0+0 IsViewable (has no name)","4194307 1x1+-1+-1 IsViewable (has no name)","4194359 1x1+-1+-1 IsViewable (has no name)","4194514 1x1+-1+-1 IsViewable (has no name)","4194601 1x1+-1+-1 IsViewable (has no name)"] | alert:"returned":53ms | confirm:true:62ms |  |

### Electron · dialogs-macos (electron-viewport-macos-dialogs.json)

Electron 45.2.2 (Chromium 156.0.8078.80), darwin-arm64 25.6.0, ozone (default), displays 1024x768@1, status **done**, 18 s

**Round twelve, JavaScript dialogs answered over CDP**

| tab | dialog | CDP event | browser handler | windows during | windows after | page | error |
| :- | :- | :- | :- | :- | :- | :- | :- |
| offscreen tab | alert | true | true | ["layer 0 alpha 1 260x96+382+321","layer 0 alpha 1 1024x677+0+31 \"S7 viewport page\""] | ["layer 0 alpha 1 260x96+382+321","layer 0 alpha 1 1024x677+0+31 \"S7 viewport page\""] | alert:"returned":561ms |  |
| offscreen tab | confirm | true | true | ["layer 0 alpha 1 260x96+382+321","layer 0 alpha 1 1024x677+0+31 \"S7 viewport page\""] | ["layer 0 alpha 1 260x96+382+321","layer 0 alpha 1 1024x677+0+31 \"S7 viewport page\""] | alert:"returned":561ms | confirm:true:232ms |  |
| offscreen tab | prompt | false | – | ["layer 0 alpha 1 260x96+382+321","layer 0 alpha 1 1024x677+0+31 \"S7 viewport page\""] | ["layer 0 alpha 1 260x96+382+321","layer 0 alpha 1 1024x677+0+31 \"S7 viewport page\""] | alert:"returned":561ms | confirm:true:232ms |  |
| host window tab | alert | true | true | ["layer 0 alpha 1 260x96+0+31","layer 0 alpha 0 1x1+129+31 \"S7 tiny t2\""] | ["layer 0 alpha 1 260x96+0+31","layer 0 alpha 0 1x1+129+31 \"S7 tiny t2\""] | alert:"returned":139ms |  |
| host window tab | confirm | true | true | ["layer 0 alpha 1 260x96+0+31","layer 0 alpha 0 1x1+129+31 \"S7 tiny t2\""] | ["layer 0 alpha 1 260x96+0+31","layer 0 alpha 0 1x1+129+31 \"S7 tiny t2\""] | alert:"returned":139ms | confirm:true:110ms |  |
| host window tab | prompt | false | – | ["layer 0 alpha 1 260x96+0+31","layer 0 alpha 0 1x1+129+31 \"S7 tiny t2\""] | ["layer 0 alpha 1 260x96+0+31","layer 0 alpha 0 1x1+129+31 \"S7 tiny t2\""] | alert:"returned":139ms | confirm:true:110ms |  |

### Electron · viewport-macos (electron-viewport-macos.json)

Electron 45.2.2 (Chromium 156.0.8078.80), darwin-arm64 25.6.0, ozone (default), displays 1024x768@1, status **done**, 216 s

**Round twelve, offscreen bot tabs** (never-shown OSR windows; GPU "enabled")

Size: default: window 1280x800, page 1280x800@1 → **default**.

Shared textures: 42 textures, 0 bitmaps, 0 empty paints in 3 s → **they come here** — {"pixelFormat":"bgra","codedSize":"1280x800","handle":["ioSurface"]}

| config | visibility | rAF Hz | paints/s | textures/s | all CPU % | renderer % | GPU % | browser % | error |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| offscreen, texture, 10 fps, animated | visible | 7.7 | 7.2 | 7.2 | 6.6 | 2.1 | 4.0 | 0.5 |  |
| offscreen, texture, 30 fps, animated | visible | 14.0 | 13.7 | 13.7 | 13.0 | 4.1 | 8.0 | 0.9 |  |
| offscreen, texture, 60 fps, animated | visible | 35.4 | 35.4 | 35.4 | 31.2 | 8.7 | 20.3 | 2.2 |  |
| offscreen, texture, 30 fps, painting stopped, animated | visible | 22.1 | 0.0 | 0.0 | 18.5 | 6.8 | 11.3 | 0.4 |  |
| offscreen, texture, 10 fps, quiet page | visible | 0.0 | 2.0 | 2.0 | 2.9 | 0.8 | 1.5 | 0.6 |  |
| offscreen, texture, painting stopped, quiet page | visible | 0.0 | 0.0 | 0.0 | 2.5 | 0.8 | 1.0 | 0.7 |  |
| offscreen, bitmap, 10 fps, animated | visible | 10.0 | 9.7 | 0.0 | 15.2 | 3.8 | 7.4 | 3.9 |  |
| offscreen, bitmap, 30 fps, animated | visible | 19.2 | 19.2 | 0.0 | 19.9 | 4.5 | 10.0 | 5.3 |  |
| offscreen, bitmap, 60 fps, animated | visible | 31.5 | 31.5 | 0.0 | 30.4 | 6.1 | 14.3 | 9.9 |  |
| offscreen, bitmap, 30 fps, painting stopped, animated | visible | 14.2 | 0.0 | 0.0 | 8.1 | 2.9 | 5.0 | 0.2 |  |
| offscreen, bitmap, 10 fps, quiet page | visible | 0.0 | 2.0 | 0.0 | 3.2 | 0.7 | 1.0 | 1.4 |  |
| offscreen, bitmap, painting stopped, quiet page | visible | 0.0 | 0.0 | 0.0 | 1.6 | 0.6 | 0.8 | 0.2 |  |
| host window, animated | visible | 58.1 | 0.0 | 0.0 | 27.7 | 10.1 | 17.4 | 0.2 |  |
| host window, quiet page | visible | 0.0 | 0.0 | 0.0 | 4.4 | 0.8 | 2.3 | 1.3 |  |

| pictures of | method | ok | ms | stale ms | size | errors |
| :- | :- | :- | :- | :- | :- | :- |
| offscreen, texture, painting on (10 fps) | capturePage | 5/5 | 98 / 111 | 16 / 19 | 1280x800 |  |
| offscreen, texture, painting on (10 fps) | cdpJpeg | 5/5 | 403 / 424 | -248 / -236 | 1280x800 |  |
| offscreen, texture, painting stopped | capturePage | 5/5 | 96 / 143 | 118 / 138 | 1280x800 |  |
| offscreen, texture, painting stopped | cdpJpeg | 5/5 | 524 / 594 | -241 / -198 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | capturePage | 5/5 | 98 / 111 | 48 / 100 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | cdpJpeg | 5/5 | 348 / 371 | -236 / -205 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | osrPaint | 5/5 | 0 / 0 | 167 / 228 | 1280x800 |  |
| offscreen, bitmap, painting on (10 fps) | newest paint → JPEG | 5/5 | 5 / 6 | – | 1280x800 |  |
| offscreen, bitmap, painting stopped | capturePage | 5/5 | 76 / 128 | -67 / 0 | 1280x800 |  |
| offscreen, bitmap, painting stopped | cdpJpeg | 5/5 | 381 / 423 | -233 / -150 | 1280x800 |  |
| host window | capturePage | 5/5 | 19 / 38 | 25 / 32 | 1280x800 |  |
| host window | cdpJpeg | 5/5 | 101 / 119 | -50 / -41 | 1280x800 |  |

| cost | MiB a tab | CPU % a tab | kind | error |
| :- | :- | :- | :- | :- |
| 4 quiet offscreen tabs (texture, 10 fps) | 50.4 | 1.68 | footprint |  |
| 4 quiet offscreen tabs (texture), painting stopped | 37.4 | 1.39 | footprint |  |
| 4 quiet tabs in one shared host window | 35.5 | 2.13 | footprint |  |

Windows on screen: 4 offscreen tabs open (nothing else shown): 0 []; 4 tabs in the shared host window: 1 ["layer 0 alpha 0 1x1+0+31 \"S7 shared host\""]

**Round twelve, the viewport** (mode **texture**: shared textures come on this machine)

Shows: #1 first frame 289 ms, at the viewport's size 299 ms (1000x645, frame 1000x645), hidden again 11 ms; #2 first frame 55 ms, at the viewport's size 55 ms (1000x645, frame 1000x645), hidden again 7 ms

| oracle | same document | timers | SSE socket | form | layout | detail |
| :- | :- | :- | :- | :- | :- | :- |
| shown (first time) | true | true | true | true | 1000x645@1 | token same, loads +0, navigations +0, ticks 17→21, sse opens 1 (server 1) msgs 15→19, field "typed by the bot", checked true |
| hidden again (the agent's 1280x800) | true | true | true | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 407→422, sse opens 1 (server 1) msgs 405→419, field "x日本s7-paste-ok", checked true |
| shown again | true | true | true | true | 1000x645@1 | token same, loads +0, navigations +0, ticks 422→431, sse opens 1 (server 1) msgs 419→428, field "x日本s7-paste-ok", checked true |
| hidden at the end | true | false | false | true | 1280x800@1 | token same, loads +0, navigations +0, ticks 431→431, sse opens 1 (server 1) msgs 428→428, field "x日本s7-paste-ok", checked true |

| through the viewport | ok | ms | detail |
| :- | :- | :- | :- |
| mouse: a click lands where the person clicked | yes | 126 | {"at":"260,40","page":{"x":260,"y":40,"t":1793869636777},"forwarded":{"mouseMove":1,"mouseDown":1,"mouseUp":1}} |
| wheel: the page scrolls | yes | 470 | {"scrollY":150,"wheels":2,"forwardedWheels":4} |
| keys: typing, Backspace and select-all in the field | yes | 1313 | {"typed":"typed by the botabc","afterBackspace":"typed by the botab","afterSelectAllAndX":"x","focused":"field","pageHasFocus":true,"keys":["End","a","b","c","Backspace","x"]} |
| IME: a composition in the viewport is composed and committed in the page | yes | 1288 | {"field":"x日本","midField":"xにほ","compositions":["start:","update:にほ","update:日本","update:日本","end:日本"],"forwarded":{"set":2,"commit":1,"text":0}} |
| paste: the person's paste reaches the page as a paste | yes | 964 | {"field":"x日本s7-paste-ok","pasteEvents":["s7-paste-ok"],"clipboard":{},"forwarded":1} |
| <select>: it opens, and the keys choose an option | yes | 1829 | {"value":"c","changes":["c"],"popupTextures":22,"popupRects":["popup 180x146+0+0","popup 180x146+0+0","popup 180x146+0+0"],"viewerPopups":19,"viewerPopupSizes":["180x146","180x146","180x146","180x146","180x146","180x146","180x146","180x146","180x146","180x146"]} |
| cursor: the page's cursor reaches the viewport | yes | 1227 | {"events":["hand","text","crosshair","move"],"viewerCursors":["pointer","text","crosshair","move"]} |
| drag: an HTML5 drag inside the page, sent as plain mouse events | **no** | 1552 | {"page":["dragstart"]} |
| drag: the same, with the browser's drag handed to the viewport (CDP Input.setInterceptDrags) | yes | 1386 | {"page":["dragstart","dragenter","dragover","drop:s7-dragged","dragend:copy"],"intercepted":1,"dispatched":["dragEnter","dragOver","drop"]} |
| file chooser: answered with a file, no dialog | yes | 203 | {"choosers":[{"at":1793869646912,"mode":"selectSingle"}],"files":["s7-upload.txt:23:hello from the viewport"]} |
| a window the page opens: offscreen too, its opener kept, shown in the viewport and clicked | **no** | 8032 | {"offscreen":true,"visible":false,"size":"480x360","paints":0,"openerMessages":["popup:hello"],"clickedInViewport":false} |
| resize: the page reflows to the viewport, no reload | **no** | 4322 | {"oneMs":117,"quickThreeMs":91,"resizes":["1793869654533:1000x645","1793869655140:800x560","1793869655237:900x620","1793869655285:760x520","1793869655335:820x580","1793869655415:1000x645"],"applied":["1793869654528:1000x645","1793869655132:800x560","1793869655234:900x620","1793869655275:760x520","1793869655324:820x580","1793869655413:1000x645"],"token":"same"} |
| find-in-page: matches found and drawn | yes | 20 | {"requestId":0,"matches":1,"selectionArea":{"x":202,"y":163,"width":30,"height":17},"activeMatchOrdinal":1,"finalUpdate":true} |
| DevTools: open on the offscreen tab (detached window) | yes | 1317 | {"opened":true} |
| accessibility: the page's tree is there to read over CDP (the OS sees none of it) | yes | 23 | {"nodes":52,"button":true,"accessibilitySupport":false} |
| a 2x display: the device-metrics override at a scale of 2 gives the viewport 2x frames | **no** | 1609 | {"pageDpr":2,"layout":"1000x645","frame":"1000x645","viewerCanvas":"1000x645"} |
| the tab's webContents.focus(): does the hidden window take the OS focus from the viewport? | yes | 709 | {"viewerFocusedBefore":true,"after":true,"focusedWindow":"S7 viewport","pageHasFocus":true,"tabVisible":false} |

| input → frame | trials | ms p50 / p95 | parts (p50) |
| :- | :- | :- | :- |
| viewport, mouse | 20 | 28 / 31 | to the page's handler 1; to the paint event 12; paint → drawn in the viewer 1; drawn → on screen (2 rAFs) 13 |
| viewport, key | 10 | 25 / 29 | to the page's handler 1; to the paint event 9; paint → drawn in the viewer 1; drawn → on screen (2 rAFs) 14 |
| native view, mouse | 20 | 12 / 16 | to the page's handler 1 |
| native view, key | 10 | 8 / 28 | to the page's handler 0 |

| frames | numbers |
| :- | :- |
| viewport, animated page | drawnPerSec 56.7, paintsPerSec 58.0, sentPerSec 56.7, droppedPerSec 1.0, pageRafPerSec 57.7, mbPerSec 0.0, drawMsP50 0.4, drawMsP95 2.3, cpuTotal 81.8, cpuBrowser 12.3, cpuGpu 49.0, cpuOffscreenRenderer 7.8, cpuViewerRenderer 12.5 |
| viewport, smooth scroll | ms 923.0, viewerFramesPerSec 60.7, pageRafPerSec 60.7 |
| native view, animated page | pageRafPerSec 59.5, cpuTotal 17.4, cpuBrowser 0.5, cpuGpu 10.3, cpuRenderer 6.3 |
| native view, smooth scroll | ms 935.0, pageRafPerSec 59.9 |

Windows on screen: a hidden offscreen tab and the viewer: 1 ["layer 0 alpha 1 1000x677+24+31 \"S7 viewport\""]; a <select> open: 1 ["layer 0 alpha 1 1000x677+24+31 \"S7 viewport\""]; a file chooser open: 1 ["layer 0 alpha 1 1000x677+24+31 \"S7 viewport\""]; the page's window open (offscreen): 1 ["layer 0 alpha 1 1000x677+24+31 \"S7 viewport\""]

Viewer: {"frames":415,"textures":415,"bitmaps":0,"popups":19,"draw":{"n":300,"min":0.1,"p50":0.4,"p95":2.3,"max":18.5,"mean":0.79},"errors":[]}; counters {"sent":434,"dropped":9,"fullFrames":0,"mbSent":0,"outstandingTextures":0,"forwarded":{"mouseMove":43,"mouseDown":30,"mouseUp":30,"mouseWheel":4,"keyDown":20,"keyUp":20,"char":14,"edit":1,"ime-start":1,"ime-set":2,"ime-commit":1,"paste":1},"errors":[],"tabTextures":427,"tabPopupTextures":22,"tabEmptyPaints":0,"tabPaints":449}

