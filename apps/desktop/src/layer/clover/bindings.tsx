// The `clover` layer's bindings: each bundled part is bound as its own client entry exports it (index.ts), as any plugin's
// part is. The shell's `app.root` entry (its own folder's `WindowShell`) hears what main tells that part; the one thing
// left here is the app's push-to-talk recorder, which the Voice plugin's own listening half replaces (lane A).
import type { EntryProps } from "@waifucave/clover-plugin-sdk/ui";
import { useListenRecorder } from "./listen-hooks";
import { Shell as WindowShell, type ShellProps } from "@waifucave/clover-plugin-shell/client";

export function Shell(p: EntryProps<ShellProps>) {
  // Push-to-talk: the shell records (never a plugin) when main says the user's press asked for it, and sends the audio back.
  useListenRecorder();
  return <WindowShell {...p} />;
}
