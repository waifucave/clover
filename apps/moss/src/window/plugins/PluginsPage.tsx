// The Plugins page (spec §6.10, §3.4, G10): the installed plugins and, per tool, off / on demand / always on beside its
// permission; a plugin is added from a folder or a link behind the normal OK card (the engine raises it, the router
// places it in this window, MOSS's sealed frame draws it). Plugins that change the interface need MOSS Code; parts that
// draw on the screen run on the background host, never in this window.
import { useEffect, useState } from "react";
import { bridge } from "../bridge";
import type { PluginRow, ToolRow } from "../../shared/view";
import type { ToolAvailability } from "@waifucave/moss-protocol";

const AVAILABILITY: { value: ToolAvailability; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "on-demand", label: "On demand" },
  { value: "always", label: "Always on" },
];
const PERMISSION: Record<ToolRow["permission"], string> = { allow: "Always allow", ask: "Asks first", deny: "Always block" };

export function PluginsPage(props: { strip?: React.ReactNode }) {
  const [plugins, setPlugins] = useState<PluginRow[] | "waiting" | undefined>(undefined);
  const [link, setLink] = useState("");
  const [note, setNote] = useState<string | undefined>(undefined);
  const load = (): void => { void bridge().plugins().then((p) => setPlugins("waiting" in p ? "waiting" : p)); };
  useEffect(load, []);
  const add = async (from: { link: string } | { file: true }): Promise<void> => {
    const r = await bridge().addPlugin(from);
    setNote(r.ok ? "Look for its card: it runs only after your OK." : r.why);
    if (r.ok) { setLink(""); load(); }
  };
  const set = async (t: ToolRow, a: ToolAvailability): Promise<void> => {
    if (await bridge().setAvailability(t.server, t.tool, a)) load();
  };
  return (
    <main className="page" data-col="conversation" data-page="plugins" aria-label="Plugins">
      <header className="page__head"><h1>Plugins</h1></header>
      {props.strip}
      <div className="page__body">
        <section className="add">
          <h2>Add a plugin</h2>
          <p className="muted">Tools, models, voices, or something that shows on your screen. It runs only after you OK its card.</p>
          <div className="add__row">
            <input type="url" placeholder="A link (https://… or npm:name)" value={link} onChange={(e) => setLink(e.target.value)} aria-label="A plugin's link" />
            <button type="button" className="text-button text-button--solid" disabled={link.trim() === ""} onClick={() => void add({ link })}>Add</button>
            <button type="button" className="text-button" onClick={() => void add({ file: true })}>From a folder…</button>
          </div>
          {note !== undefined ? <p className="add__note" role="status">{note}</p> : null}
        </section>
        {plugins === "waiting" ? <p className="muted">Waiting for the engine's plugins.</p> : null}
        {Array.isArray(plugins) ? plugins.map((p) => (
          <section key={p.id} className="plugin" data-plugin={p.id}>
            <h2>{p.name}{!p.enabled ? <span className="chip chip--paused">Off</span> : null}</h2>
            {p.tools.length === 0 ? <p className="muted">No tools.</p> : (
              <ul className="tools">
                {p.tools.map((t) => (
                  <li key={`${t.server}/${t.tool}`} className="tool" data-tool={t.tool}>
                    <span className="tool__name">{t.tool}</span>
                    <span className="tool__perm">{PERMISSION[t.permission]}</span>
                    <span className="seg" role="radiogroup" aria-label={`${t.tool}: when bots have it`}>
                      {AVAILABILITY.map((a) => (
                        <button key={a.value} type="button" role="radio" aria-checked={t.availability === a.value} className={t.availability === a.value ? "is-on" : ""} onClick={() => void set(t, a.value)}>{a.label}</button>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )) : null}
        <p className="muted small">Plugins that change how a window looks need MOSS Code.</p>
      </div>
    </main>
  );
}
