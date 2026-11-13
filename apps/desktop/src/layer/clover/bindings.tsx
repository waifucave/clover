// The `clover` layer's bindings: lane F's parts are entries of the UI API's shape (F-M2), bound as they are (index.ts);
// only the shell gets a wrapper, for what the app's main process tells a window and F's shell doesn't hear yet: the
// app's commands (Settings from ⌘, or the menu, a bot's tab or a session from a notification or `app.show`), and the
// window's material behind its sidebar. A command starts the shell again at that place (asked of lane F: hear them
// with `useLayerMessage` and keep the tab under Settings).
import { useState } from "react";
import { useLayerMessage, useMountContext, useShellReport, useWindowDrag, type EntryProps } from "@waifucave/clover-plugin-sdk/ui";
import { useListenRecorder } from "./listen-hooks";
import { useVoicePlayback } from "./voice-hooks";
import { Shell as FShell, type ShellProps, type ShellStart } from "@clover-child/shell";

export function Shell({ props, tokens, entry }: EntryProps<ShellProps>) {
  const ctx = useMountContext();
  // The window's title areas move it: the CSS region is ignored inside a frame (see `useWindowDrag`).
  useWindowDrag();
  // The bot's voice: the pieces main forwards play here, and the stage reads what plays.
  useVoicePlayback();
  // Push-to-talk: the shell records (never a plugin) when main says the user's press asked for it, and sends the audio back.
  useListenRecorder();
  // An act of the window a bot's own plugin asked for through `shell.*` (main checked the capability, whose tab shows and the user's press): handed to the shell.
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
  return <FShell key={at.n} props={shell} tokens={tokens} entry={entry} />;
}
