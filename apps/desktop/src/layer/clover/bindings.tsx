// The `clover` layer's bindings: lane F's parts are entries of the UI API's shape (F-M2), bound as they are (index.ts);
// only the shell gets a wrapper, for the window's material behind its sidebar. The app's commands (Settings from ⌘, or
// the menu, a bot's tab or a session from a notification or `app.show`) the shell hears itself with `useLayerMessage`
// (F-M3), keeping the tab under Settings.
import { useMountContext, type EntryProps } from "@waifucave/clover-plugin-sdk/ui";
import { Shell as FShell, type ShellProps } from "@clover-child/shell";

export function Shell({ props, tokens, entry }: EntryProps<ShellProps>) {
  const ctx = useMountContext();
  return <FShell props={{ ...props, translucent: ctx.material !== "none" }} tokens={tokens} entry={entry} />;
}
