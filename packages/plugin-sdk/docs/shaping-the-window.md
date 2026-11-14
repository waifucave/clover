# Drawing the window around your bot's tab

A bot's tab owns its page: the top bar and the right-hand panels are part of it. The left sidebar is not: it is the app's own and looks exactly the
same on every tab, so a bot gets nothing of it (spec §5.5, "Bots is part of the app with a plug"). A bot plugin reshapes what it gets the way every plugin
does everything else in Clover: **it draws its own parts, in its own frames, and calls the plugin API to make the app do things.** The app never draws a
plugin's styles for it, and no plugin script ever runs in the shell's document. All of this applies only while your bot's tab shows, switches
cleanly when the user leaves (other tabs are stock), respects reduced motion, and costs nothing while idle.

## 1. The primary path: your plugin draws it, the app does it

| Where | How your plugin fills it |
|---|---|
| Controls in your page (a title, buttons, a handle to drag the window, a bar of your own, or no bar at all with the controls scattered through the page) | `bot.controls`, a spot of your tab; your layout places it, your component draws it in your own frame |
| The top bar | the `bar` spot, with `when.bot` (from a child plugin of the bot); or, with the theme token `bar.mode: "none"`, no bar at all |
| The panels' container | `chrome.panels` in your layout (the cell the panels show in, drawn however your page draws it) or the theme's `panel.mode`; the panel's **content** stays the panel plugin's own frame |

What your controls do are plugin-API calls, `PluginApi.shell` (the `shell.*` calls below), each a capability-gated, ordinary layer call.

### The calls

Declare `shell.read` and/or `shell.control` in your manifest. A plugin reaches the window only **while one of its own bots shows its tab** (a bot's id
begins with its plugin's id): a plugin that draws a bot's bar changes nothing while another bot's tab shows, and reads nothing of where the user is
the rest of the time.

| Call | What it does | Capability | By the user's click? |
|---|---|---|---|
| `shell.state()` / `shell.watch(fn)` | where the window is: the tab showing, the shown bot, the sidebar (folded or not, bots or code side, its measured width), the panels open and offered, the safe area | `shell.read` | no |
| `shell.apps()` | the sidebar's app buttons (what each opens, its title, its icon), read by the app itself | `shell.read` | no |
| `shell.account()` | the account row: who is signed in and which computer this is; its press is `shell.openSettings` | `shell.read` | no |
| `shell.toggleSidebar()` / `shell.setSidebar(collapsed)` | fold the sidebar to a rail, or open it | `shell.control` | yes |
| `shell.togglePanel(view)` / `openPanel` / `closePanel` | a panel view of this tab (`session`, `browser`, ...) | `shell.control` | yes |
| `shell.openBotEditor()` | the bot's editor (the pencil) | `shell.control` | yes |
| `shell.go(target)` | show a bot's tab, a session, the code or bots side, an app, or the Plugins / Archive page | `shell.control` | yes |
| `shell.openSettings(section?)` | the settings screen | `shell.control` | yes |
| `shell.dragWindow()` | from a press on a region you mark: the window follows the pointer until it lets go | `shell.control` | the user's press, which the app saw itself (it moves the window from its own sight of the pointer; only in the top strip of the window, and never while a card waits) |
| `shell.provide(["sidebar", "drag"])` | says your controls offer a way to fold or open the sidebar and a region that drags the window (the sidebar itself always stays) | `shell.control` | no |

"By the user's click" means: counts only inside the user's own key press or click in the calling frame (any other is refused and does nothing), one call
per gesture, as the Plugins page's calls do. For other reads, use the existing calls: `bots.list` / `bots.watch` (`bots.read`),
`conversation.list` (`conversation.read`).

### The fallback rule

With no bar (`bar.mode: "none"`), the window must never strand the user. If your controls do not call `shell.provide` for a way to show the sidebar
and a region that drags the window, the shell adds a minimal handle for each one nothing offers (a small button beside the sidebar, a thin strip at the
top). Calling `shell.provide` is your promise that you draw them.

### The safe area

On macOS the native window buttons (traffic lights) stay where they are. `shell.state().safeArea` says how far they reach from the window's top left
(0 on a system that draws them at the other end), and your layout's CSS gets the same as `--cl-safe-left` and `--cl-safe-top`. Your tab starts at the
sidebar's right edge (`shell.state().sidebar.width`), so the buttons reach into it only by `safeArea.left` less that width: none while the sidebar,
open or folded to its rail, lies under them, as the stock one always does on macOS.

## 2. The cell's shape: theme `shell` tokens

A plugin that fills the bar or the panel container still gets its *cell* from the app, and the shape of the cell is data: the `shell` block of your
theme takes shape names beside the colour groups (`bar` and `accent`, which reach the bar and the panels). Each name stands alone; a value outside its
choices or range is dropped and that part stays the shell's own. Numbers are whole CSS pixels, as strings. The sidebar's names (`sidebar`, its
colours, `sidebar.mode`, `.width` and the rest) are not offered: the theme check warns about each, and it changes nothing.

| Token | Values | Meaning |
|---|---|---|
| `bar.mode` | `standard` `none` `float` | the translucent bar (default), no bar, a bar inset from the edges |
| `bar.height`, `bar.inset`, `bar.radius` | 28-96, 0-32, 0-40 | height; a floating bar's margin and corner |
| `panel.mode` | `column` `drawer` `float` `sheet` | the standard right column; a drawer over the right edge; a card; a sheet up from the bottom |
| `panel.width`, `panel.radius` | 280-720, 0-40 | a drawer's or card's width and corner |

## 3. The secondary path: the stock parts, moved or restyled

A plugin that wants the stock bar but moved or restyled does it with data only: the `chrome.*` spots of its layout (`chrome.title`,
`chrome.action` keyed `edit` / `session` / `browser`, `chrome.actions`, `chrome.sidebar`, `chrome.drag`, `chrome.panels`) place the shell's own parts
where the layout puts them (a press on one is the app's own press), the shape tokens above restyle them, and the layout's cleaned, scoped CSS dresses them. A part
you place leaves the standard bar; with `bar.mode: "none"`, a part you do not place is not shown, except the sidebar's button and a place to drag the window.

## Narrow windows

The sidebar rests as the user left it, the same on every tab (one fold for the window). Your tab is the window less the sidebar: size your parts by
your tab's own width (a container query on your layout's root, or `shell.state().sidebar.width` in a frame), and your layout can hide parts with
`hideBelow`. The panels' cell is yours to place: a layout that places `chrome.panels` shapes the panels itself, and the theme's `panel.mode` shapes
only the stock column used when no layout places that cell.

## Not available

Anything of the sidebar for a bot: its look, its shape, its rows or a sidebar of the bot's own. A "new conversation" call and unread counts: the stock sidebar has neither wired (its New chat button and unread dot are not fed), so there is nothing to expose; the bots' state is read through `bots.list`. Code, the plugin manager and other tabs are never reshaped.
