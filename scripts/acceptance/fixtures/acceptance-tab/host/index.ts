// The acceptance fixture's host half: the one line this plugin puts on the island (its `island.line` entry `job`), which the
// run sets and clears with the command `acceptance-tab.say`. The line lives in the plugin's synced store, so the command's
// handler and the point's handler agree whichever worker runs them.
interface Api {
  storage: { synced: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> } };
}
let kept: Api | undefined;
export function start(api: Api): void {
  kept = api;
}
const store = (ctx: { api?: Api }): Api["storage"]["synced"] => (ctx.api ?? kept)!.storage.synced;

/** `acceptance-tab.say { text?, progress? }`: show this line; no text: remove it. */
export async function say(args: { text?: string; progress?: number }, ctx: { api?: Api }): Promise<{ ok: true }> {
  await store(ctx).set("line", typeof args.text === "string" ? { text: args.text, icon: "sync", ...(typeof args.progress === "number" ? { progress: args.progress } : {}), bot: "alpha" } : null);
  return { ok: true };
}

/** The island's `island.line` handler: the line as it is now, or nothing. */
export async function islandLine(_args: unknown, ctx: { api?: Api }): Promise<unknown> {
  return (await store(ctx).get("line")) ?? undefined;
}
