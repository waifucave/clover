// The acceptance-points fixture's host half: the plugin API a host half has, each call's answer handed back for the run
// to check. Its watches start with the host half and keep what they hear for `report`. No network, no other process.
interface Api {
  points: {
    entries(point: string): Promise<{ pluginId: string; entryId: string }[]>;
    watch(point: string, listener: (entries: unknown[]) => void): () => void;
    call(point: string, entry: { pluginId: string; entryId: string }, field: string, args?: unknown): Promise<unknown>;
  };
  storage: { synced: { set(k: string, v: unknown): Promise<void>; delete(k: string): Promise<void>; keys(): Promise<string[]>; watch(l: (k: string) => void): () => void } };
  settings: { get(k: string): Promise<unknown>; watch(k: string | null, l: (k: string) => void): () => void };
  conversation?: { note(s: string, n: { label?: string; text: string }): Promise<void>; send(s: string, t: string): Promise<void> };
}

const POINT = "acceptance-points.items";
let api: Api | undefined;
const heard = { store: [] as string[], settings: [] as string[], points: [] as number[] };

export async function start(given: Api): Promise<void> {
  api = given;
  api.storage.synced.watch((k) => heard.store.push(k));
  api.settings.watch("mood", (k) => heard.settings.push(k));
  api.points.watch(POINT, (entries) => heard.points.push(entries.length));
}

export async function probe(args: { session: string }): Promise<Record<string, unknown>> {
  const a = api!;
  const entries = await a.points.entries(POINT);
  const first = entries[0];
  const called = first === undefined ? "no entry" : await a.points.call(POINT, { pluginId: first.pluginId, entryId: first.entryId }, "greet", { who: "probe" });
  await a.storage.synced.set("acceptance-a", 1);
  await a.storage.synced.set("acceptance-b", 2);
  const keys = (await a.storage.synced.keys()).sort();
  await a.storage.synced.delete("acceptance-a");
  const keysAfter = (await a.storage.synced.keys()).sort();
  let posted: string;
  try {
    await a.conversation!.note(args.session, { label: "Acceptance points", text: "ACCEPTANCE-POINTS-NOTE" });
    await a.conversation!.send(args.session, "ACCEPTANCE-POINTS-SEND ACCEPTANCE-TAG-PTSSEND");
    posted = "posted";
  } catch (err) {
    posted = `refused: ${err instanceof Error ? err.message : String(err)}`;
  }
  return { entries: entries.map((e) => `${e.pluginId}:${e.entryId}`), called, keys, keysAfter, mood: await a.settings.get("mood"), posted };
}

export async function report(): Promise<typeof heard> {
  return heard;
}
