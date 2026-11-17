// Where the figure shows: a panel of this plugin's own beside a session (MOSS Code's window, the `panel` spot under a key of
// its own), and a window on the screen (`app.surface`), shown only while the person has turned it on (`onScreen`).
import type { EntryProps } from "@waifucave/moss-plugin-sdk";
import { useSurface } from "@waifucave/moss-plugin-sdk/ui";
import { useEffect } from "react";
import { useSetting } from "./choice";
import { Figure } from "./figure";

/** The window's size on the screen, in CSS pixels. */
export const SCREEN_SIZE = { width: 260, height: 340 } as const;

export function FigurePanel({ props }: EntryProps<{ app?: string; session?: string }>) {
  return <Figure place="panel" {...(typeof props.session === "string" ? { session: props.session } : {})} />;
}

export function FigureOnScreen() {
  const on = useSetting<boolean>("onScreen") === true;
  const surface = useSurface();
  useEffect(() => {
    surface({ visible: on, ...SCREEN_SIZE });
  }, [surface, on]);
  return on ? <Figure place="screen" /> : null;
}
