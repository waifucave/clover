// The acceptance-points-page fixture's page: its sidebar app button's component, which the window mounts in a frame of
// the plugin's own layer as soon as it runs. On mount it reaches the plugin API through the UI SDK's own
// `usePluginApi` (the app's main process carries each call on the layer's own connection to the core), one member of
// each area a component reaches, and hands what came back to its host half (`host.call("pageReport")`), whose `report`
// command gives it to the run, which checks each answer. Where it writes, which conversation it notes in and which
// site it fetches come from its settings, which the run sets once the plugin runs.
import { useEffect, useState } from "react";
import { usePluginApi } from "@waifucave/clover-plugin-sdk/ui";

const said = (e: unknown) => `refused: ${(e instanceof Error ? e.message : String(e)).slice(0, 240)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const listed = (v: unknown) => (Array.isArray(v) ? "a list" : `gave ${JSON.stringify(v)?.slice(0, 80)}`);

export function AcceptancePointsPage() {
  const api = usePluginApi();
  const [state, setState] = useState("waiting");
  useEffect(() => {
    let live = true;
    void (async () => {
      // Its settings, once the run has set them (read again each second: the page may mount first).
      let folder = "";
      let site = "";
      let session = "";
      for (let i = 0; i < 120 && live && (folder === "" || site === "" || session === ""); i++) {
        folder = String((await api.settings.get("pageFolder").catch(() => "")) ?? "");
        site = String((await api.settings.get("pageSite").catch(() => "")) ?? "");
        session = String((await api.settings.get("pageSession").catch(() => "")) ?? "");
        if (folder === "" || site === "" || session === "") await sleep(1_000);
      }
      if (!live) return;
      setState("probing");
      const out: Record<string, unknown> = {};
      // Under the layer's calls-per-second cap.
      const pace = () => sleep(150);
      // files: a folder watch heard, bytes written and read back as bytes and as text, then removed.
      try {
        const heard: unknown[] = [];
        const off = await api.files.watch(folder, (c: unknown) => heard.push(c));
        const path = `${folder}/page.txt`;
        for (let i = 0; i < 40 && !JSON.stringify(heard).includes("page.txt"); i++) {
          if (i % 15 === 0) await api.files.write(path, new TextEncoder().encode("ACCEPTANCE-PAGE-FILE"));
          await sleep(200);
        }
        off();
        await pace();
        const bytes = await api.files.readBytes(path);
        const text = await api.files.readText(path);
        // The folder's listing, a move, a glob and a grep over it, then the moved file removed.
        await pace();
        const listing = (await api.files.list(folder)).map((f: { path?: string; name?: string }) => String(f.path ?? f.name ?? ""));
        const moved = `${folder}/page-moved.txt`;
        await api.files.move(path, moved);
        await pace();
        const globbed = (await api.files.glob("*.txt", { cwd: folder })).paths;
        const grepped = (await api.files.grep("ACCEPTANCE-PAGE-FILE", { cwd: folder })).matches.map((x: { path: string }) => x.path);
        await api.files.remove(moved);
        out.files = {
          heard: JSON.stringify(heard).includes("page.txt"), bytes: bytes instanceof Uint8Array ? new TextDecoder().decode(bytes) : `not bytes: ${typeof bytes}`, text,
          listed: listing.some((p: string) => p.endsWith("page.txt")), globbed: globbed.some((p: string) => p.endsWith("page-moved.txt")), grepped: grepped.some((p: string) => p.endsWith("page-moved.txt")),
        };
      } catch (e) {
        out.files = said(e);
      }
      await pace();
      out.memory = await api.memory.list("alpha").then(listed, said);
      await pace();
      out.routines = await api.routines.list().then(listed, said);
      await pace();
      out.usage = await api.usage.summary({ from: 0, to: Date.now(), groupBy: "source" }).then(listed, said);
      await pace();
      out.logs = await api.logs.read({ plugin: api.plugin.id }, { lines: 20 }).then(listed, said);
      await pace();
      // Muted by the run before its OK: the core's notify service answers, and nothing shows on the screen.
      out.notify = await api.notify.send({ title: "Acceptance points page", body: "muted: never shown" }).then(() => "sent", said);
      await pace();
      out.note = await api.conversation.note(session, { label: "Acceptance points page", text: "ACCEPTANCE-POINTS-PAGE-NOTE" }).then(() => "noted", said);
      await pace();
      out.commandsList = await api.commands.list().then((v: { name: string }[]) => (v.some((c) => c.name === `${api.plugin.id}.report`) ? "its own listed" : `gave ${JSON.stringify(v.map((c) => c.name)).slice(0, 120)}`), said);
      await pace();
      // Its own string, from its own locale file (`locales`), with its placeholder filled.
      out.t = api.t(`${api.plugin.id}.greeting`, { who: "page" });
      out.command = await api.commands.run(`${api.plugin.id}.report`, {}).then((v: unknown) => (typeof v === "object" && v !== null ? "its report" : `gave ${JSON.stringify(v)?.slice(0, 80)}`), said);
      await pace();
      out.point = await api.points.call(`${api.plugin.id}.items`, { pluginId: api.plugin.id, entryId: "hello" }, "greet", { who: "page" }).then((v: unknown) => v, said);
      await pace();
      out.fetch = await api.net.fetch(`${site}/page`).then(async (r: Response) => ({ status: r.status, body: await r.text() }), said);
      await pace();
      await api.host.call("pageReport", out).catch(() => undefined);
      if (live) setState("reported");
    })();
    return () => {
      live = false;
    };
  }, [api]);
  // A question the run names (its `pageQuestion` setting: the session, the call, the question and the answer), answered
  // through `conversation.answer` (the plugin's `conversation.post`), the outcome handed to its host half.
  useEffect(() => {
    let live = true;
    void (async () => {
      for (let i = 0; i < 600 && live; i++) {
        const raw = String((await api.settings.get("pageQuestion").catch(() => "")) ?? "");
        if (raw !== "") {
          let answered: string;
          try {
            const q = JSON.parse(raw) as { session: string; callId: string; question: string; answer: string };
            await api.conversation.answer(q.session, q.callId, { [q.question]: q.answer });
            answered = `answered ${q.callId}`;
          } catch (e) {
            answered = said(e);
          }
          await api.host.call("pageAnswer", answered).catch(() => undefined);
          return;
        }
        await sleep(1_000);
      }
    })();
    return () => {
      live = false;
    };
  }, [api]);
  return <span data-acceptance-points-page="badge" data-state={state}>•</span>;
}
