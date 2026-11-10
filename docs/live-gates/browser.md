# The browser's live gate

Generated from `apps/desktop/scripts/browser-live-gate-lib.ts`; edit the list there and run `bun run apps/desktop/scripts/browser-live-gate.ts --write-doc`, or a test fails. This is the browser's part of plan §10 (items 2, 3, 4, 5 and 8). **The owner runs it, never an agent:** it opens a real window.

## How to run it

On each machine in turn (a Mac, a Windows 11 PC, a GNOME and a KDE Wayland session, a server):

```sh
cd apps/desktop
bun install                      # from the repo root, once
bun run scripts/browser-live-gate.ts [--section <name>] [--out <folder>] [--all]
```

It builds a small app that shows one window, serves a fixture page on loopback, and walks you through the steps for that OS. For some steps it measures by itself (the page's token across show and hide, composition events, wheel and pinch events, the frame rate, the display's scale, whether a new tab went to the screen-reader host) and then asks you. Answer `p` (pass), `f` (fail) or `s` (skip), and add a note. Your answers go to `browser-live-gate.json` in the run folder (printed when it starts; `--out` chooses it). Nothing else is written: no Clover home, no Keychain, no account.

It refuses to run in CI, under an agent, or without a terminal.

On Wayland, to try the XWayland fallback for the screen-reader host if a step fails: `--electron-arg --ozone-platform=x11`, and say so in the note.

Parts that need more than this machine and the script: the **phone or web companion** step needs lane I's companion on a phone or in a browser, the **proxy** steps need your real proxy and PAC, and the **server** step is done on the server by hand (the script lists it with `--all`).

## macOS

### A bot's tab shown through the viewport and back, with no reload

`mac-viewport-roundtrip`, on macOS; the script measures `no-reload`.

1. The bot's tab is open offscreen with a counter that has been running. Press Enter in the terminal to show it in the window.
1. Watch the counter and the field's text; press Enter again to send it back; again to show it.

**Pass:** The page's token is the same all three times and its timer never restarted (the script checks it); no window of the app's but the one you are looking at appears or flashes.

### IME composition (Japanese and Chinese)

`mac-ime`, on macOS; the script measures `ime-composition`.

1. With the tab shown, click the large text box on the page.
1. Switch to a Japanese input source and type 'nihongo', choose a candidate with Space, press Return.
1. Switch to a Chinese (Pinyin) source and type 'zhongwen', choose a candidate.

**Pass:** The candidate window sits at the caret, the underlined text shows while composing, and the committed text lands in the box. The script saw compositionstart, update and end for each.

### Trackpad scrolling and pinch

`mac-trackpad`, on macOS; the script measures `scroll-and-pinch`.

1. Two-finger scroll the tall page up and down with momentum.
1. Pinch to zoom in and out on the page.

**Pass:** Scrolling is smooth with momentum and stops at the ends; a pinch zooms the page's content (the script saw wheel events with the pinch flag).

### Retina and 120 Hz

`mac-display`, on macOS; the script measures `refresh-rate`.

1. On a Retina display, and on a 120 Hz one if you have it, read the sharpness of the shown tab's small text.
1. Leave the page's animation running for ten seconds.

**Pass:** The text is as sharp as Safari's, and the page's measured frame rate is the display's (60 or 120; the script reports it).

### VoiceOver on: new tabs go to the screen-reader host, which can be taken over

`mac-voiceover`, on macOS; the script measures `reader-host`.

1. Turn VoiceOver on (Cmd+F5). Press Enter in the terminal to open a new tab for the bot.
1. Move VoiceOver to the page in the app's window after showing it, and read the heading and the button.
1. Turn VoiceOver off.

**Pass:** The new tab is a real view in the hidden host (the script reports it), it reads in VoiceOver once shown, and no window of the host was ever visible or took focus.

### Selecting and copying, the right-click menu, the file chooser, a same-site popup while watched

`mac-select-copy`, on macOS.

1. Drag-select the sentence and press Cmd+C; paste it into the text box.
1. Right-click the sentence and choose Copy.
1. Click 'Choose file' and pick any file.
1. Click 'Open same-site window' while you are watching.

**Pass:** Each works as in a normal browser; the popup opens as a real window while you watch.

## Windows 11

### 150 % and 200 % scaling

`win-scale`, on Windows; the script measures `scale`.

1. Set Display scaling to 150 %, sign out and in, run this script and show the tab. Note the result.
1. Do the same at 200 %. Answer once for each, in the note.

**Pass:** The shown tab fills its frame, text is crisp, a click lands where the pointer is, and the script's reported scale is the setting's.

### IME composition

`win-ime`, on Windows; the script measures `ime-composition`.

1. Click the large text box with the shown tab.
1. Type with the Microsoft Japanese IME, then Pinyin, committing a candidate each time.

**Pass:** The candidate window sits at the caret and the committed text lands in the box.

### Narrator or NVDA: new tabs go to the screen-reader host, which can be taken over

`win-reader`, on Windows; the script measures `reader-host`.

1. Start Narrator (Win+Ctrl+Enter) or NVDA. Press Enter in the terminal to open a new tab for the bot.
1. Show it and read the heading and the button.

**Pass:** The new tab is a real view in the hidden host (the script reports it), it reads once shown, and the host never appeared in the taskbar, Alt-Tab or on screen.

## GNOME and KDE on Wayland

### No window of the app's while bots work

`wl-no-window`, on Linux.

1. Log in to a GNOME or KDE Wayland session (answer once per desktop, in the note). Run this script; the bot's tab starts offscreen.
1. Open the overview or window list while the bot's tab runs a page with an animation.

**Pass:** Only the one window you are looking at is listed; nothing of the app's flashes in the list, the dock or the overview.

### The screen-reader host's one pixel

`wl-host-pixel`, on Linux; the script measures `reader-host`.

1. Turn the screen reader on (Orca: Super+Alt+S). Press Enter in the terminal to open a new tab for the bot.
1. Look for a dot or a row for the host in the window list, and click where it sits if you find it.

**Pass:** The host is not in the list, or if it is, a click at its pixel goes to the window below. If either fails, note it: the fallback is `--ozone-platform=x11` for the host (XWayland).

### Orca reads the shown tab

`wl-orca`, on Linux.

1. With Orca on and the new tab shown, read the heading and the button.

**Pass:** Orca reads them.

## The phone or web companion

### The phone or web companion decodes the streamed view (with lane I): hardware H.264 on a real Mac

`comp-stream`, on any OS.

1. On a real Mac, start the stream of the bot's tab to the phone or the web companion (Chrome, Firefox, Safari in turn).
1. Watch the animated page on the companion for a minute; throttle the phone's connection once.

**Pass:** The picture follows the page within about a second, the codec is H.264 from the hardware encoder on the Mac (the app's stream log says), and it recovers after the throttling without freezing for long.

## A corporate-style proxy and PAC

### An explicit corporate-style proxy

`proxy-explicit`, on any OS; the script measures `proxy-load`.

1. Enter the proxy's address when asked (http://, https:// or socks5://), and a public https URL to load through it.

**Pass:** The page loads, the proxy's own log shows the request for the address (not the name), and a page on your LAN is not sent to the proxy.

### The system's PAC

`proxy-pac`, on any OS; the script measures `proxy-load`.

1. Set the OS's automatic proxy configuration to your company's PAC file, then choose 'system' when asked, and load a public https URL.

**Pass:** The page loads by the route the PAC names, and nothing looked up wpad or fetched a dictionary.

## A server or cloud computer

### A server or cloud computer: the headless shell installs from the pin and a bot works

`server-install`, on Linux.

1. On a headless server or a cloud computer made for this, run the core with the browser on and have a bot open a page and take a screenshot.
1. Look at <home>/browser/ afterwards.

**Pass:** The pinned build downloaded and verified once, the bot's page loaded, the screenshot is 1280x800, and <home>/browser/ holds only the install, the profiles and a run folder that empties when the browser exits.
