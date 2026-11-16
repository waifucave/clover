# MOSS Code's logo

The logo is the Shards mark: a disc cut into four pieces and joined again, the gaps showing one colour, the seam. It comes from the owner's Shards icon kit. The mark and app-icon SVGs live in `assets/brand/moss-code/` (`mark/`, `mark/small/`, `app-icon/`); the kit's own icon files are committed where the build takes them.

| Colour | Hex |
| --- | --- |
| Accent, the seam | `#E5A72E` |
| Night | `#161A33` |
| Paper | `#F6F4EE` |
| Ink | `#1B1D2B` |

**The mark on Night is the app logo.**

The mark is recut for small sizes (the gaps widen, and below 32 px it drops to three pieces). `mark/small/shards-mark-<16|24|40|64>-*.svg` are those cuts; `scripts/brand-icons.ts` picks the cut by the pixel width it draws.

## Where each file goes

| Use | Source | Output |
| --- | --- | --- |
| App icon, macOS | kit `app-icon/macos/app.icns` | `apps/desktop/build/icon.icns`, supplied as the kit made it |
| App icon, Windows | kit `app-icon/windows/app.ico` | `apps/desktop/build/icon.ico`, supplied |
| App icon, Linux (deb, rpm, AppImage) | kit `app-icon/rounded/app-icon-<n>.png` | `apps/desktop/build/icons/<n>x<n>.png`, 16 to 512 px, supplied |
| MOSS Code Dev (`bun run dev:app`) | `app-icon/app-icon-paper.svg` | `apps/desktop/resources/icons/dev-dock.png` (macOS Dock, on the grid) and `dev-window.png`, drawn: the paper tile, so it is not mistaken for the release app |
| Menu bar, macOS | `mark/small/*-black.svg` | `trayTemplate.png` (18 pt) and `tray16Template.png` (16 pt), each with its `@2x`: template images, which macOS tints for the bar |
| Tray, Windows and Linux | `mark/small/*-white.svg` on a dark taskbar, `*-black.svg` on a light one | `tray-on-dark.png`, `tray-on-light.png`, each with its `@2x`; swapped when the theme changes |
| In-app brand mark (sidebar, conversation, plugin index) | `mark/shards-mark-white.svg` (the single-colour cut) | the `MossMark` components draw its path in `currentColor`. They wear `plugin.moss.mark`: Night on light themes, Paper on dark ones |
| Web companion: favicon, touch icon, PWA icons | kit `web/` | `services/web/src/icons/`: `favicon.svg`, `apple-touch-icon.png` (180 px), `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` (supplied) and `favicon-32.png` (drawn) |
| Web companion header | `mark/shards-mark-on-light.svg`, `shards-mark-on-dark.svg` | `mark-light.svg` on a light page, `mark-dark.svg` on a dark one |

## Rebuilding

The drawn rasters come from the SVG sources, by `scripts/brand-icons.ts`. Never edit an output by hand. To change the logo:

1. Replace the SVGs (and, for the supplied files, the kit's icon files they stand beside).
2. Run `bun scripts/brand-icons.ts`.
3. Commit the sources, the outputs and `assets/brand/moss-code/outputs.json` together.

The script does the following:

- It draws with `@resvg/resvg-js` at exactly the locked version, so nothing depends on the machine it runs on.
- It records the SHA-256 of every source, every drawn output and every supplied file in `outputs.json`.
- `--check` writes nothing. It fails if any drawn output differs from what the script would write.
- `--preview <png>` also draws a contact sheet of the set.

`scripts/brand-icons.test.ts` checks the committed files against `outputs.json`, on every OS. It fails when a file was edited by hand, or when a source changed and the script wasn't rerun.

The older `docs/brand.md` and the other files directly in `assets/brand/` belong to the predecessor app. They are not MOSS's.
