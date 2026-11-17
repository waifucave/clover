// MOSS's Quit (lane HS's rule, packages/core/src/ipc/moss.ts `pair.quit`): the person's Quit tells the engine
// (`pair.quit { handOver: false }`), which stops itself only when MOSS is the last window of ours and no host owns the
// screen, and stops nothing otherwise. Without it, a MOSS-only session with no host would leave an engine nobody can see
// or stop. A window that merely closes while MOSS keeps running (macOS) tells nothing; nor does a quit the engine asked
// for (`app.quit`: it is stopping or updating already).

export interface QuitClient {
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
}

/** Whether closing MOSS's last window quits it: on macOS the app stays until quit (headless runs leave). */
export function windowsClosedQuits(platform: NodeJS.Platform, headless: boolean): boolean {
  return platform !== "darwin" || headless;
}

/** Tells the engine the person quits MOSS, unless the engine asked for the quit or MOSS isn't connected; at most `ms`. */
export async function tellQuit(o: { client: QuitClient | undefined; engineAsked: boolean; log: (line: string) => void; ms?: number }): Promise<"told" | "not-told"> {
  if (o.engineAsked) { o.log("quit: the engine asked for it; nothing to tell"); return "not-told"; }
  if (o.client === undefined) { o.log("quit: not connected; nothing to tell"); return "not-told"; }
  try {
    await o.client.request("pair.quit", { handOver: false }, o.ms ?? 2_000);
    o.log("quit: told the engine (pair.quit, no hand-over)");
    return "told";
  } catch (err) {
    o.log(`quit: the engine didn't take pair.quit (${err instanceof Error ? err.message.slice(0, 120) : "error"})`);
    return "not-told";
  }
}
