// The acceptance-points row's page half: the fixture's component reaching the plugin API on its own layer connection
// (`layer.token`, role `layer`, `plugin.layer.call` and `plugin.layer.watch`, the route the SDK's `usePluginApi` takes),
// one member from each area a component reaches since components got the whole catalog, each answer checked:
// files (write, read back as bytes and text, a folder watch heard, remove), memory, routines, usage, logs, notify (muted
// first, so nothing shows on the screen: the refusal says the core's notify service judged it), conversation.note,
// commands.run, points.call and net.fetch (the run's own loopback site, declared on the fixture's OK).
export interface LayerLink {
  request<T = unknown>(method: string, params: unknown): Promise<T>;
  /** Every `plugin_api_event` this connection was sent so far. */
  apiEvents(): { watch?: string; value?: unknown; ended?: { reason: string } }[];
}

export interface PageProbeInput {
  layer: LayerLink;
  pluginId: string;
  /** This computer's name in the tree (`home/<computer>/…` is the run's user home). */
  computer: string;
  /** A folder the run made in its user home, as the tree names it (`home/<computer>/<folder>`), for the watch. */
  watchFolder: string;
  session: string;
  bot: string;
  /** The run's loopback site the fixture's OK lists, and what it answers at `/page`. */
  site: { url: string; body: string };
  /** Mutes and unmutes the fixture's notifications (the user's `notify.setMuted`). */
  setMuted(muted: boolean): Promise<void>;
  sleep(ms: number): Promise<void>;
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const fromB64 = (v: unknown) => (typeof v === "object" && v !== null && typeof (v as { $bytes?: unknown }).$bytes === "string" ? Buffer.from((v as { $bytes: string }).$bytes, "base64").toString("utf8") : undefined);

/** Runs the page's probe; what came back wrong, and a one-line account of what was answered. */
export async function pageProbe(o: PageProbeInput): Promise<{ wrong: string[]; said: string[] }> {
  const wrong: string[] = [];
  const said: string[] = [];
  // Paced under the layer's calls-per-second cap, so no answer is the cap's.
  const call = async <T = unknown>(c: string, args: unknown[]): Promise<T> => {
    await o.sleep(80);
    return ((await o.layer.request<{ result: T }>("plugin.layer.call", { call: c, args })).result);
  };
  const refusalOf = async (c: string, args: unknown[]): Promise<string> => call(c, args).then(() => "answered", (e: unknown) => (e instanceof Error ? e.message : String(e)));
  const area = async (name: string, run: () => Promise<string | undefined>) => {
    try {
      const bad = await run();
      if (bad !== undefined) wrong.push(`${name}: ${bad}`);
      else said.push(name);
    } catch (err) {
      wrong.push(`${name} failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}`);
    }
  };

  // Its layer hears the plugins area's events, a watch's values among them (the SDK subscribes the same way).
  await o.layer.request("events.subscribe", { areas: ["plugins"] });
  await area("files", async () => {
    const path = `${o.watchFolder}/page.txt`;
    const { watch } = await o.layer.request<{ watch: string }>("plugin.layer.watch", { call: "files.watch", args: [o.watchFolder, null] });
    await call("files.write", [path, { $bytes: b64("ACCEPTANCE-PAGE-FILE") }]);
    let heard = false;
    for (let i = 0; i < 100 && !heard; i++) {
      heard = o.layer.apiEvents().some((e) => e.watch === watch && JSON.stringify(e.value ?? "").includes("page.txt"));
      if (!heard && i % 30 === 29) await call("files.write", [path, { $bytes: b64("ACCEPTANCE-PAGE-FILE") }]);
      if (!heard) await o.sleep(100);
    }
    await o.layer.request("plugin.layer.unwatch", { watch });
    const bytes = fromB64(await call("files.readBytes", [path]));
    const text = await call<string>("files.readText", [path]);
    await call("files.remove", [path]);
    if (!heard) return `its watch of ${o.watchFolder} heard nothing of page.txt (${JSON.stringify(o.layer.apiEvents()).slice(0, 200)})`;
    if (bytes !== "ACCEPTANCE-PAGE-FILE" || text !== "ACCEPTANCE-PAGE-FILE") return `read back ${JSON.stringify(bytes)} as bytes and ${JSON.stringify(text)} as text`;
    return undefined;
  });
  await area("memory", async () => {
    const list = await call<unknown>("memory.list", [o.bot]);
    return Array.isArray(list) ? undefined : `memory.list gave ${JSON.stringify(list).slice(0, 120)}`;
  });
  await area("routines", async () => {
    const list = await call<unknown>("routines.list", []);
    return Array.isArray(list) ? undefined : `routines.list gave ${JSON.stringify(list).slice(0, 120)}`;
  });
  await area("usage", async () => {
    const rows = await call<unknown>("usage.summary", [{ from: 0, to: Date.now(), groupBy: "source" }]);
    return Array.isArray(rows) ? undefined : `usage.summary gave ${JSON.stringify(rows).slice(0, 120)}`;
  });
  await area("logs", async () => {
    const lines = await call<unknown>("logs.read", [{ plugin: o.pluginId }, { lines: 20 }]);
    return Array.isArray(lines) && lines.every((l) => typeof l === "string") ? undefined : `logs.read gave ${JSON.stringify(lines).slice(0, 120)}`;
  });
  await area("notify", async () => {
    await o.setMuted(true);
    try {
      const why = await refusalOf("notify.send", [{ title: "Acceptance points", body: "muted: never shown" }]);
      return why.includes("muted") ? undefined : `notify.send while muted answered ${JSON.stringify(why).slice(0, 160)}`;
    } finally {
      await o.setMuted(false);
    }
  });
  await area("conversation.note", async () => {
    await call("conversation.note", [o.session, { label: "Acceptance points page", text: "ACCEPTANCE-POINTS-PAGE-NOTE" }]);
    return undefined;
  });
  await area("commands.run", async () => {
    const r = await call<{ store?: unknown } | undefined>("commands.run", [`${o.pluginId}.report`, {}]);
    return r !== undefined && Array.isArray(r.store) ? undefined : `commands.run ${o.pluginId}.report gave ${JSON.stringify(r).slice(0, 120)}`;
  });
  await area("points.call", async () => {
    const r = await call<unknown>("points.call", [`${o.pluginId}.items`, { pluginId: `${o.pluginId}/filler`, entryId: "hello" }, "greet", { who: "page" }]);
    return r === "hello page from the filler" ? undefined : `points.call gave ${JSON.stringify(r).slice(0, 120)}`;
  });
  await area("net.fetch", async () => {
    const r = await call<{ $response?: { status: number; body: string } }>("net.fetch", [`${o.site.url}/page`]);
    const body = r?.$response === undefined ? undefined : Buffer.from(r.$response.body, "base64").toString("utf8");
    return r?.$response?.status === 200 && body === o.site.body ? undefined : `net.fetch gave ${JSON.stringify(r).slice(0, 160)}`;
  });
  // What a component never reaches: a host half's own secret.
  await area("secrets.get refused", async () => {
    const why = await refusalOf("secrets.get", ["none"]);
    return why.includes("host code") ? undefined : `secrets.get answered ${JSON.stringify(why).slice(0, 120)}`;
  });
  return { wrong, said };
}
