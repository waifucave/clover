// A fixture plugin installed from its folder only when it isn't installed already. The full table installs some
// fixtures in an earlier row (acceptance-echo: the hook and stdio rows); a later row that installs the same folder again
// is refused ("already installed; remove it first"), while the same row run alone (`--only-stage`) starts on a fresh home.

export interface PluginRpc {
  request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T>;
}

/** The plugin `id`, installed from `folder` when it isn't there yet. `installedHere` says which: true when this call
 *  installed it (its OK card is pending, and the caller removes it after), false when an earlier row had (the caller
 *  uses it as it is and leaves it installed). */
export async function pluginOnce(rpc: PluginRpc, id: string, folder: string): Promise<{ id: string; installedHere: boolean }> {
  const there = await rpc.request<{ plugin?: { id?: string } }>("plugin.get", { id }).catch(() => undefined);
  if (there?.plugin != null) return { id, installedHere: false };
  const installed = await rpc.request<{ id: string }>("plugin.install", { source: { from: "folder", path: folder } }, 60_000);
  return { id: installed.id, installedHere: true };
}
