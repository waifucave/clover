# Spike S7: the Clover Browser

Lane L's M0 (plan §4 L, spec §12.1 and §14.1 item 7). The findings are in
[docs/research/2026-11-05-s7-browser.md](../../docs/research/2026-11-05-s7-browser.md).

Everything that launches Electron or a browser runs in CI (`.github/workflows/spike-s7.yml`, on every push to
`lane/l-m0`; M1 retargets the trigger when this becomes the browser suite), never on a developer's Mac: even a
headless browser can take the front there. The runners refuse to start unless `GITHUB_ACTIONS=true`, which only
GitHub's runners set (`CI=true` is not enough: some agent harnesses set it on a Mac), or `S7_ALLOW_LOCAL=1`, for a
spare machine nobody is using.

Every runner checks what the report concludes and exits 1 when an assertion fails (round eight), after writing all
it measured: no reload on a move, the 1×1 host drawing and `capturePage` working in it, a never-shown window drawing
nothing, the host never taking focus, its click-through and (Windows) window styles, a resting tab waking, every tab
in a shared host drawing, Chrome for Testing's pin, pipe, sandbox and steps, and the pair's restarts and Quits. From
round thirteen also Winter's model: an offscreen tab drawing with no window and putting none on screen, no reload
through the viewport, each kind of input through it, the pair's held lock, and the known gaps pinned (a plain HTML5
drag, a window the page opens, a dialog's native box). So a green run means those held.

The prototype lives in `prototype/`, with its own `package.json` and lockfile. It sits one level down on purpose: the
repo's workspaces match `spikes/*`, and a member there would change the root lockfiles.

## Setup

```sh
cd spikes/s7-browser/prototype
bun install --frozen-lockfile        # Electron 42+ fetches no binary at install
node node_modules/electron/install.js   # CI: fetch the Electron binary (not needed to typecheck or test)
bun run build                        # pages, the probe's main, the pair's app; add --daemon to compile the daemon
```

## One command per check

Safe anywhere (they launch nothing):

| Check | Command |
| :- | :- |
| Typecheck | `bun run typecheck` |
| Unit tests (marker, zip reader, login items, pins, framing) | `bun test` |

CI only (each is one job in `spike-s7.yml`):

| Question | What runs | Command |
| :- | :- | :- |
| 1, 2, 6 on macOS, Windows, Linux X11 | the Electron probe: hidden ⇄ shown moves, throttling (with the throttling-on controls), pictures, cost, the streamed view, a resting tab waking in the host, one host for four tabs, the host's invariants (focus, click-through, Windows styles, and on X11 the shaped host; X11 needs `xdotool` and `xwininfo`) | `bun scripts/probe.ts --checks=move,throttle,capture,cost,stream,wake,shared,hostcheck --out=out/results/electron.json` (Linux: under `xvfb-run`, `-- --ozone-platform=x11`) |
| 2, at a device scale factor of 2 | pictures (and the 1x override), cost and the shared host at 2× | `bun scripts/probe.ts --checks=capture,cost,shared --out=out/results/electron-dsf2.json -- --force-device-scale-factor=2` |
| 3, Wayland | the same probe under a headless Weston, no X server | `scripts/ci/weston.sh bun scripts/probe.ts --checks=move,throttle,capture,cost,stream,wake,shared,hostcheck --out=out/results/electron-wayland.json -- --ozone-platform=wayland` |
| 4, Electron where no display exists | the probe on Ozone's headless platform, x64 and arm64 | `bun scripts/probe.ts --checks=move,throttle,capture,cost,wake,shared,hostcheck -- --ozone-platform=headless` |
| Winter's model (round twelve), macOS, Windows, X11, Weston | bot tabs as never-shown offscreen windows (their size, shared textures where the GPU composites, their rate with no window, pictures, cost against the host window) and one shown through a viewport page that draws its frames and sends input back (the no-reload oracle, mouse, wheel, keys, IME, paste, `<select>`, cursor, drag, file chooser, a window the page opens, resize, find, DevTools, the accessibility tree, latency and frames against a native view); macOS also with bitmaps, Windows also on WARP | `bun scripts/probe.ts --checks=osr,viewport --out=out/results/electron-viewport.json` (Linux as above; `S7_VIEWPORT_MODE=bitmap` forces bitmaps) |
| JavaScript dialogs (round twelve) | `alert`, `confirm` and `prompt` answered over CDP in an offscreen tab, a host-window tab and an offscreen tab with `disableDialogs`, with the windows on screen before, during and after (CGWindowList, EnumWindows, xdotool) | `bun scripts/probe.ts --checks=dialogs --out=out/results/electron-dialogs.json`, a step of its own: a native box may stay up |
| 2, five hidden minutes | timer rates past Chrome's intensive throttling | `bun scripts/probe.ts --checks=long` (under `xvfb-run`) |
| 4, Chrome for Testing | pinned install (fails closed without a pin), starts over the DevTools pipe, background tabs, a resize, media in a browser of its own, screenshots, screencast, per-bot profiles, cost | `bun src/cft/run.ts --only=install …` first (launches nothing), then on Linux `scripts/ci/apparmor.sh` for each browser, then `S7_EXPECT_SANDBOX=1 bun src/cft/run.ts --out=out/results/cft.json` (one step: `--only=start,tabs,media,screenshots,profiles,cost`; `--posix-reader=worker` reads the pipe on a worker thread) |
| 4, a bare Linux server | the libraries a clean `ubuntu:24.04` lacks for the headless shell | `scripts/ci/cft-deps.sh <browser dir> <binary> <out>` |
| 5, the pair | login item, start, app crash, crash loop → safe mode, daemon crash, tray Quit, a user's start, the daemon's Quit, the lock held by another process (exit 1, then up once free) | `bun scripts/build.ts --daemon && bun src/pair/run.ts --daemon-bin=out/pair/clover-core-s7 --electron=$(node -p "require('electron')") --app-dir=out/pair/app --out=out/results/pair.json` |
| All | Markdown tables from every job's JSON | `bun src/summarize.ts <results folder>` |

## Layout

```text
prototype/
  src/shared/    marker (a timestamp drawn as cells, read back from any picture), stats, the test server, process memory
  src/pages/     the probe page every tab loads; the viewer and streamer for the streamed view; round twelve's page
                 (vp-page), its popup, and the viewport page with its preload (vp-viewer, vp-preload)
  src/electron/  the probe's main process: the tab host (no window, never-shown window, 1x1 and opacity-0 host
                 windows, shown, OSR), a cover window, the checks, streaming; viewport.ts (round twelve: offscreen
                 tabs, the viewport, dialogs) and winlist.ts (the windows on screen, per OS)
  src/cft/       the pinned installer (pins.json, our own zip reader), a CDP client over the pipe (fdpipe.ts on macOS
                 and Linux, winpipe.ts on Windows), the runner
  src/pair/      the minimal daemon (lock, socket, crash restarts, safe mode), the minimal app, login items, the runner
  scripts/       build, the probe launcher, CI helpers (AppArmor profile, Weston, user manager, server deps)
  test/          unit tests (launch nothing)
  fixtures/      a 2-second VP8 + Opus clip (30 KB) for the media checks
results/         every round's JSON from CI, with summary.md (bun src/summarize.ts) per round
  round1/        the first run: what broke and why
  round2/        what makes a hidden tab draw (host windows), the Windows supervisor, the pins
  round3/        the DevTools pipe without EOFs, covered host windows
  round4/        Linux Chrome for Testing only (the rest was cancelled for round five): media plays there
  round5/        a browser per Chrome for Testing step and a trace of the pipe; a cover that occludes on Windows;
                 the 1x1 host at opacity 0 on Windows (its macOS jobs waited for a runner and were cancelled)
  round6/        Linux Chrome for Testing twice, the pipe read by createReadStream and by a worker thread
  round7/        the native pipe tried first, node's stdio pipes never on the way (the Linux stall's suspect)
  final/         the first full run on the PR (on 5bae76e66): every job, macOS's opacity-0 1x1 host included
  round8/        the review's experiments: throttling-on controls under a cover, Linux Chrome for Testing
                 sandboxed from the start, a device scale factor of 2, persist: partitions, the wake from rest,
                 one shared host, the host's invariants, and assertions in every runner. Two jobs failed them: on
                 X11 a click at the 1x1 host's pixel landed on the host, and at a scale factor of 2 on Windows a
                 host tab without the CDP override laid out at 0x0 and drew nothing
  round9/        the X11 host with an empty window shape (setShape([])), the scale-factor-2 runs asserting the
                 design (the override), captures scaled to 1280x800, and tab capture's own error on Wayland. The
                 shaped host drew and took no click, but the click landed on the window below's corner, a resize
                 handle; on Windows at 2x the 4x31 host's content was 0 wide, and its tabs drew nothing
  round10/       the click well inside the window below (not resizable), and a 32x32 host on Windows: every job
                 and all 172 checks passed
  round11/       the daemon lock classified by a pure function and tested on macOS, Windows and Linux, and a
                 daemon that finds the lock held exits 0 only when another daemon answers on the socket
  round12/       Winter's model in Electron: offscreen bot tabs, one shown through a viewport, dialogs over CDP
                 (viewport jobs only; the first try hung on Linux asking for shared textures without a GPU)
  round13/       the whole workflow again with round twelve's checks asserted, and the pair's held lock
```

The report quotes round two for the Electron tables (rounds three and eight to ten re-ran them on every OS, and round
five on all but macOS, whose jobs were cancelled; what draws and what doesn't agreed), and later
rounds where it says so. A push whose head commit's message contains `[cft only]` runs only the unit and Chrome for
Testing jobs, and one with `[viewport only]` only the unit and viewport jobs; pushes that change only `results/` don't start the workflow. `results/round1/summary.md` is the summary
job's own artifact from that run.
