// Alpha's own pieces of her tab, as a plugin's client components, each in a frame of her plugin: the living scene behind the page (`AlphaHeader`), her
// controls in the top band (`AlphaControls`) and her room, everything she keeps in front of the stage (`AlphaRoom`: her name, what she is doing, the
// pinned note, the day's tally, the stage tools; the way to every other tab is the window's own sidebar, beside her tab). They read only through the
// plugin API (`bots`, `conversation`, `shell`, her stage's store) and draw in the tab's own tokens; nothing here is special-cased for Alpha by the app.
import { AlphaScene } from "./backdrop";
import type { BotRef } from "./live";
export { AlphaScene };
export { AlphaControls } from "./controls";
export { AlphaRoom } from "./room";

/** Her header part is her living scene (the sky and the meadow behind the whole tab). */
export function AlphaHeader({ props }: { props: { bot: BotRef } }) {
  return <AlphaScene props={{ bot: props.bot }} />;
}
