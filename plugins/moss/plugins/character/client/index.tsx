// The avatar plugin's client entry (spec revision 19, G7: the platform has no avatar; this bundled plugin is one figure at a
// time): `FigurePanel` fills a panel of its own beside every session, `FigureOnScreen` is its window on the screen (off
// until the person turns it on), and `FigureSettings` is its Settings section, where the person picks the figure. It
// imports no CSS: `client.css` lists the stylesheet.
export { FigurePanel, FigureOnScreen } from "./places";
export { FigureSettings } from "./settings";
