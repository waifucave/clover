# `vendor/srt-win`: Clover's Windows launcher (lane C, C-M2 part 2)

The Bash fence on Windows runs bots' commands as a dedicated per-user sandbox principal
(`clover-sb-` + 8 hex chars of the owner's SID) through the `srt-win` launcher, vendored from
`anthropics/sandbox-runtime` (Apache-2.0) at the pinned tag/commit in
`packages/core/src/fence/win-sandbox.ts` (`SRT_WIN_TAG`, `SRT_WIN_COMMIT`).

- `vendor/srt-win-src/` is the pinned source tree. It is a **build input, never
  committed**: `scripts/build-srt-win.ps1` clones it at the pinned commit and
  verifies `HEAD` before building. (Same pattern as `.clover-sdk/`.)
- `vendor/srt-win/srt-win.exe` is the static-CRT build lane M's CI makes and
  signs; the Authenticode digest check in `packages/core/src/fence/windows-launcher.ts`
  (`SRT_WIN_PINS`) fails closed on a mismatch, exit 3 on every launch.
- `vendor/srt-win/SHA256` records the measured hash next to the binary once
  lane M's first trusted build lands; the core constant is the check that
  matters (`sandbox setup` and every launch verify it, exit 3 on mismatch).

License: the launcher's own `LICENSE` (Apache-2.0) applies to everything under
`vendor/srt-win-src/` and to `srt-win.exe`; see the upstream repo.
