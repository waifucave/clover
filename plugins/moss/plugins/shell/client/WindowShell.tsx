// The window's shell as the part that fills `app.root`: the shell (Shell.tsx) with what the window's main process tells
// the part in that spot, whichever plugin's it is (F2b: no plugin id decides it, and nothing of this is the app's own
// code): the app's commands (Settings from ⌘, or the menu, a bot's tab or a session from a notification or `app.show`),
// a window act a bot's own plugin asked for through `shell.*` (`shell-act`: main checked the capability, whose tab shows
// and the user's press), which chrome parts a bot's plugin provides (`shell-provides`), the window's material behind
// its sidebar, and its title areas that move it. A command starts the shell again at that place.
import { useState } from "react";
import { useLayerMessage, useMountContext, useShellReport, useWindowDrag } from "@waifucave/moss-plugin-sdk/ui";
import type { EntryProps } from "@waifucave/moss-plugin-sdk";
import { Shell, type ShellProps, type ShellStart } from "./Shell";

export function WindowShell({ props, tokens, entry }: EntryProps<ShellProps>) {
  const ctx = useMountContext();
  // The window's title areas move it: the CSS region is ignored inside a frame (see `useWindowDrag`).
  useWindowDrag();
  const [provides, setProvides] = useState({ sidebar: false, drag: false });
  const [act, setAct] = useState<ShellProps["act"]>(undefined);
  const [at, setAt] = useState<{ n: number; start?: ShellStart }>({ n: 0 });
  const go = (start: ShellStart) => setAt((s) => ({ n: s.n + 1, start }));
  useLayerMessage((m) => {
    if (m.type === "shell-act") setAct((a) => ({ n: (a?.n ?? 0) + 1, act: m.act }));
    if (m.type === "shell-provides") setProvides((p) => (p.sidebar === m.sidebar && p.drag === m.drag ? p : { sidebar: m.sidebar, drag: m.drag }));
    if (m.type !== "command") return;
    const args = m.args ?? {};
    if (m.name === "open-settings") {
      go({ route: { route: "settings", params: { ...(args.section !== undefined ? { section: args.section } : {}), ...(args.item !== undefined ? { item: args.item } : {}) } } });
    }
    if (m.name === "open-bot" && args.bot !== undefined) go({ route: { route: "bot", params: { bot: args.bot } } });
    if (m.name === "open-session" && args.session !== undefined) {
      // A bot's main conversation is its tab; any other session is an agent's or a coding session's.
      const main = /^([a-z0-9-]+):main$/.exec(args.session);
      go({ route: main !== null ? { route: "bot", params: { bot: main[1]! } } : { route: "agent", params: { session: args.session } } });
    }
  });
  const report = useShellReport();
  const shell: ShellProps = { ...props, report, provides, translucent: ctx.material !== "none", ...(at.start !== undefined ? { start: at.start } : {}), ...(act !== undefined ? { act } : {}) };
  return <Shell key={at.n} props={shell} tokens={tokens} entry={entry} />;
}
