# native/input

The desktop app's native helpers (plan §4, lane E owns this folder).

## `macos/screen.mm`: the screen add-on

What Electron's `screen` doesn't say about a Mac's displays: the safe area's top inset and the two auxiliary areas
either side of the camera housing (NSScreen, macOS 12 and later). The app's main process turns them into the housing's
place in each display's own coordinates (`apps/desktop/src/main/housing.ts`), which a surface's environment carries
(`SurfaceEnvironment.display.notch`, for the island beside it). It reads the displays and nothing else: no input, no
events, no state, no window.

- **Built:** by `apps/desktop/scripts/build.ts` on macOS, with `xcrun clang++` alone (arm64, Objective-C++): the few
  Node-API calls it makes are declared in the source from Node-API's stable ABI, so it needs no headers and loads in
  any runtime that speaks Node-API. It lands at `apps/desktop/out/main/native/screen.node`. Where it can't be built
  (no Xcode tools) the build says so and the app runs without it: no housing is known.
- **Tested:** `apps/desktop/test/housing.test.ts` checks the housing's arithmetic everywhere and loads the built add-on
  in Bun on a Mac; the app's UI test checks it loads in Electron's own Node.
- **Windows and Linux:** nothing to build; a display there has no housing (`notch: null`).

## `macos/touches.mm`: the trackpad-touch add-on

The touches of the trackpad's fingers, for the four-finger tap that hides and shows the Dispatch pill (ported from the old
app's `Gesture/MultitouchTrigger.swift`). It reads touches and nothing else: no keyboard, no pointer, no events posted,
no window, no file. `start(onFrame)` registers a contact-frame callback on every multitouch device (Apple's
MultitouchSupport, opened with `dlopen` as the old app did) and calls `onFrame(time, [id, x, y, …])` on the main thread
for each frame with a finger down, and once with an empty list when the last lifts; `reattach()` registers again after a
wake or a reconnecting trackpad; `stop()` takes it all down. Loading the module opens nothing; the trackpad is read only
after `start`. What a tap is lives in `apps/desktop/src/main/touch-tap.ts` (the recognizer, tested on recorded frames).

- **Built:** by `apps/desktop/scripts/build.ts`, like `screen.node`, to `out/main/native/touches.node`; where it can't be
  built the app runs without the gesture.
- **Off switch:** the tray's "Four-Finger Tap Hides the Dispatch Pill" checkbox (the app's prefs file). Never started in a
  headless or test run.
