// The `clover` layer's bindings: lane F's parts are entries of the UI API's shape (F-M2), bound as they are (index.ts);
// only the shell gets a wrapper, for what the app's main process tells a window and F's shell doesn't hear yet: the
// app's commands (Settings from ⌘, or the menu, a bot's tab or a session from a notification or `app.show`), and the
// window's material behind its sidebar. A command starts the shell again at that place (asked of lane F: hear them
// with `useLayerMessage` and keep the tab under Settings).
import { useState } from "react";
import { useLayerMessage, useMountContext, type EntryProps } from "@waifucave/clover-plugin-sdk/ui";
import { Shell as FShell, type ShellProps, type ShellStart } from "@clover-child/shell";

export function Shell({ props, tokens, entry }: EntryProps<ShellProps>) {
  const ctx = useMountContext();
  const [at, setAt] = useState<{ n: number; start?: ShellStart }>({ n: 0 });
  const go = (start: ShellStart) => setAt((s) => ({ n: s.n + 1, start }));
  useLayerMessage((m) => {
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
  const shell: ShellProps = { ...props, translucent: ctx.material !== "none", ...(at.start !== undefined ? { start: at.start } : {}) };
  return <FShell key={at.n} props={shell} tokens={tokens} entry={entry} />;
}
