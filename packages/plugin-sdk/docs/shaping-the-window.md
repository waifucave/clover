# Shaping the window while your bot's tab shows

A bot's tab owns its page: the top bar, the sidebar and the right-hand panels are part of it. A bot plugin reshapes them with **data only**.
No plugin script ever runs in the shell's document: the shell draws every one of its own parts (title, buttons, sidebar, panels) in the
shape you declare, wherever your layout puts them, and a press on one is the app's own press. What you draw yourself lives in your own
frame, placed by your layout.

All of it applies only while your bot's tab shows, switches cleanly when the user leaves (other tabs are stock), respects reduced motion,
and costs nothing while idle.

## 1. Shape tokens (`theme.json`, the `shell` block)

`shell.tokens` (and `shell.dark.tokens`) take colour groups (`bar`, `sidebar`, `accent`; see `formats/shell.ts`) and **shape** names. Each shape
name stands alone; a value outside its choices or range is dropped and that part stays the shell's own. Numbers are whole CSS pixels, as strings.

| Token | Values | Meaning |
|---|---|---|
| `bar.mode` | `standard` `none` `float` | the translucent bar (default), no bar, a bar inset from the edges |
| `bar.height` | 28-96 | bar height |
| `bar.inset`, `bar.radius` | 0-32, 0-40 | a floating bar's margin and corner |
| `sidebar.mode` | `edge` `float` `rail` | beside the page (default); a card over the page, which then runs under it; a float that rests as a narrow icon rail |
| `sidebar.start` | `expanded` `collapsed` | how it rests when the tab opens (the user's toggle then rules, per bot, for the window's life) |
| `sidebar.width` | 180-360 | expanded width |
| `sidebar.inset`, `sidebar.radius` | 0-32, 0-40 | a floating sidebar's margin and corner |
| `sidebar.density` | `compact` `regular` `roomy` | row height |
| `sidebar.material` | `glass` `solid` `none` | the window's material through a tint (default), a solid fill, nothing of its own (your scene shows through and rows float on it) |
| `panel.mode` | `column` `drawer` `float` `sheet` | the standard right column; a drawer over the right edge; a card; a sheet up from the bottom |
| `panel.width`, `panel.radius` | 280-720, 0-40 | a drawer's or card's width, its corner |

## 2. Parts your layout places (`layout.json` spots)

Place these like any spot (`{ "spot": "chrome.title" }`); they are only drawn by the shell, so they take your `class`/`css` for position and size, never content.

| Spot | Draws |
|---|---|
| `chrome.title` | the bot's name (opens the tab's menu where the host has one) |
| `chrome.action` with key `edit` / `session` / `browser` | one button: the bot editor, the details panel, the browser panel |
| `chrome.actions` | every button not placed one by one (other plugins' `bot.header.action` buttons included) |
| `chrome.sidebar` | the sidebar's show/hide button |
| `chrome.drag` | a region that drags the window |
| `chrome.panels` | where the panels show, instead of the window's own column; give its container a size and a shape (`panel.mode` does not apply) |

**What leaves the bar.** A part you place leaves the standard bar. With `bar.mode: "none"` a part you do not place is **not shown**: there is
no title, no buttons. Two exceptions, so the user can never be stranded: the **sidebar's button** and **a place to drag the window**. If you
place neither `chrome.sidebar` nor `chrome.drag`, the shell adds a minimal fallback (a small button beside the sidebar, a thin strip at the top).

**The safe area.** On macOS the native window buttons (traffic lights) stay where they are. Your layout's CSS is told how far they reach:
`--cl-safe-left` and `--cl-safe-top` (CSS lengths); nothing of yours may sit under them. With a floating sidebar, `--cl-sidebar-reserve` is
how far in from the left it reaches (0 when it sits at the edge); keep cards clear of it, or let a scene run under it on purpose. A bot tab's
stock layout is padded by that reach automatically.

## 3. Named shell actions for your own frames

A control you draw in **your own frame** (a button in your scene) reaches the shell through one small set of named actions, and only on a real
click or key press in that frame (the same rule as the Plugins page's calls; any other is refused). `useShellAction()` from
`@waifucave/clover-plugin-sdk/ui`:

| Action | Argument | Effect |
|---|---|---|
| `sidebar.toggle` | none | show or hide the sidebar |
| `panel.toggle` | `session` or `browser` | open or close that panel |
| `bot.edit` | none | open the bot's editor |

Nothing else of the shell is reachable, and an action is applied only while a bot of the asking plugin shows its tab. A third-party bot gets exactly
the same seam in its own frames as the bundled ones.

## Not available

Decoration slots in the sidebar's header and footer are not part of the shape: draw them in your scene behind a `sidebar.material: "none"`
sidebar. Code, plugin manager and other tabs are never reshaped.
