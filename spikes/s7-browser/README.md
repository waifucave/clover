# Spike S7: the Clover Browser

Lane L's M0 (plan §4 L, spec §12.1 and §14.1 item 7). The findings are in
[docs/research/2026-11-05-s7-browser.md](../../docs/research/2026-11-05-s7-browser.md).

Everything that launches Electron or a browser runs in CI (`.github/workflows/spike-s7.yml`, on every push to
`lane/l-m0`), never on a developer's Mac: even a headless browser can take the front there. The runners refuse to
start unless `CI=true` (or `S7_ALLOW_LOCAL=1`, for a machine nobody is using).

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
| 1, 2, 6 on macOS, Windows, Linux X11 | the Electron probe: hidden ⇄ shown moves, throttling, pictures, cost, the streamed view | `bun scripts/probe.ts --checks=move,throttle,capture,cost,stream --out=out/results/electron.json` (Linux: under `xvfb-run`, `-- --ozone-platform=x11`) |
| 3, Wayland | the same probe under a headless Weston, no X server | `scripts/ci/weston.sh bun scripts/probe.ts --checks=move,throttle,capture,cost,stream --out=out/results/electron-wayland.json -- --ozone-platform=wayland` |
| 4, Electron where no display exists | the probe on Ozone's headless platform, x64 and arm64 | `bun scripts/probe.ts --checks=move,throttle,capture,cost -- --ozone-platform=headless` |
| 2, five hidden minutes | timer rates past Chrome's intensive throttling | `bun scripts/probe.ts --checks=long` (under `xvfb-run`) |
| 4, Chrome for Testing | pinned install, starts, background tabs, a resize, screenshots, screencast, per-bot profiles, cost | `bun src/cft/run.ts --out=out/results/cft.json` |
| 4, a bare Linux server | the libraries a clean `ubuntu:24.04` lacks for the headless shell | `scripts/ci/cft-deps.sh <browser dir> <binary> <out>` |
| 5, the pair | login item, start, app crash, crash loop → safe mode, daemon crash, tray Quit, a user's start, the daemon's Quit | `bun scripts/build.ts --daemon && bun src/pair/run.ts --daemon-bin=out/pair/clover-core-s7 --electron=$(node -p "require('electron')") --app-dir=out/pair/app --out=out/results/pair.json` |
| All | Markdown tables from every job's JSON | `bun src/summarize.ts <results folder>` |

## Layout

```text
prototype/
  src/shared/    marker (a timestamp drawn as cells, read back from any picture), stats, the test server, process memory
  src/pages/     the probe page every tab loads; the viewer and streamer for the streamed view
  src/electron/  the probe's main process: the tab host (detached, hidden window, shown, OSR), the checks, streaming
  src/cft/       the pinned installer (pins.json, our own zip reader), a CDP client over the pipe, the runner
  src/pair/      the minimal daemon (lock, socket, crash restarts, safe mode), the minimal app, login items, the runner
  scripts/       build, the probe launcher, CI helpers (AppArmor profile, Weston, user manager, server deps)
  test/          unit tests (launch nothing)
  fixtures/      a 2-second VP8 + Opus clip (30 KB) for the media checks
results/         the CI summaries the report quotes
```
