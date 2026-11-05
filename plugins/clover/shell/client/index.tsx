// The shell plugin's client entry (`client.entry` in clover.json): the window frame that fills `app.root`
// and declares the `sidebar`, `main` and `panel` spots, and the bot tab's layout inside `main`. The
// sidebar itself is its own plugin (`plugins/clover/sidebar`). It imports no CSS: `client.css` lists the
// stylesheet (lane B).
export { BotTab, Window, type WindowProps } from "./Window";
export { TOKENS } from "./tokens";
