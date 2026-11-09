# Clover's logo

The logo is one clover path, in eight colour variants. The sources live in `assets/brand/clover/`, as 512 px SVGs on a 200 viewBox. The plated variants put the clover on a rounded square (`rx` 40). Each source holds one plain path and nothing else: no scripts, styles, images or links.

| Colour | Hex |
| --- | --- |
| Green | `#3D7655` |
| Dark | `#191919` |
| White | `#FFFFFF` |

**White on green is the app logo.**

## Where each variant goes

| Use | Variant | Output |
| --- | --- | --- |
| App icon, macOS | white on green | `apps/desktop/build/icon.icns`: on Apple's icon grid (a 1024 canvas, an 824 px body centred), 16 to 1024 px at @1x and @2x |
| App icon, Windows | white on green | `apps/desktop/build/icon.ico`: as drawn, 16 to 256 px |
| App icon, Linux (deb, rpm, AppImage) | white on green | `apps/desktop/build/icons/<n>x<n>.png`: as drawn, 16 to 512 px |
| Clover Dev (`bun run dev:app`) | green on dark | `apps/desktop/resources/icons/dev-dock.png` (macOS Dock, on the grid) and `dev-window.png` (Windows and Linux windows) |
| Menu bar, macOS | dark on transparent, in black | `trayTemplate.png` (18 pt) and `tray16Template.png` (16 pt), each with its `@2x`: template images, which macOS tints for the bar |
| Tray, Windows and Linux | white on transparent on a dark taskbar; dark on transparent on a light one | `tray-on-dark.png`, `tray-on-light.png`, each with its `@2x`; swapped when the theme changes |
| In-app brand mark (sidebar, conversation; later the About page and onboarding) | green on transparent on light themes; white on transparent on dark ones | the `CloverMark` and `IconClover` components draw the source path in `currentColor`. They wear `plugin.clover.mark`, which the base theme sets to `#3D7655` (light) and `#FFFFFF` (dark) |
| Web companion: favicon, touch icon, PWA icons | white on green | `services/web/src/icons/`: `favicon.svg`, `favicon-32.png`, `apple-touch-icon.png` (180 px), and `icon-192.png`, `icon-512.png` and `icon-maskable-512.png` for `manifest.webmanifest` |
| Web companion header | green on transparent on a light page; white on transparent on a dark one | `mark-green.svg`, `mark-white.svg` |

The other variants (green on white, white on dark, dark on white) are kept for whatever needs them next: a store listing, a social card, a print.

**Maskable icons.** The maskable PWA icon and the touch icon put the plate full bleed, without rounded corners, and keep the clover inside the 80 % safe circle. The platform cuts its own shape.

## Rebuilding

Every raster comes from the sources, drawn by `scripts/brand-icons.ts`. Never edit an output by hand. To change the logo:

1. Edit the SVGs.
2. Run `bun scripts/brand-icons.ts`.
3. Commit the sources, the outputs and `assets/brand/clover/outputs.json` together.

The script does the following:

- It draws with `@resvg/resvg-js` at exactly the locked version, and writes the `.icns` and `.ico` containers itself, so nothing depends on the machine it runs on.
- `--check` writes nothing. It fails if any output differs from what the script would write.
- `--preview <png>` also draws a contact sheet of the whole set.

`scripts/brand-icons.test.ts` checks the committed files against `outputs.json`, on every OS. It fails when an output was edited by hand, or when a source changed and the script wasn't rerun.

The Winter-era `docs/brand.md` and the other files in `assets/brand/` belong to the predecessor app. They are not Clover's.
