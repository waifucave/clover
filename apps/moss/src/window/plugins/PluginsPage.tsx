// The Plugins page (spec §6.10, §6.7, G10): the installed plugins and, for each tool, two separate settings side by side:
// whether bots have it at all (off / on demand / always on, the plugin's declared default marked) and what happens when a
// bot uses it (always allow / ask / always block). "Off" hides the tool; "Always block" leaves it in sight and refuses
// every use, and the page says so in words. A plugin is added from a file or a link; the engine raises its OK card, the
// router places it in this window and MOSS's sealed frame draws it: this page only starts the install.
//
// Every control calls the bridge straight from the person's click or Enter (main takes a change only right after a press).
// Nothing here is specific to one plugin.
import { useEffect, useState, type KeyboardEvent } from "react";
import { bridge } from "../bridge";
import type { PluginRow, ToolRow } from "../../shared/view";
import type { ToolAvailability } from "@waifucave/moss-protocol";

export const AVAILABILITY: readonly { value: ToolAvailability; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "on-demand", label: "On demand" },
  { value: "always", label: "Always on" },
];
export const PERMISSION: readonly { value: ToolRow["permission"]; label: string }[] = [
  { value: "allow", label: "Always allow" },
  { value: "ask", label: "Ask" },
  { value: "deny", label: "Always block" },
];

/** What MOSS shows of a plugin, said once for the page (MOSS can't tell a plugin's parts apart without its manifest). */
export const WHAT_MOSS_SHOWS = "In MOSS, a plugin's tools, models and voices work right away. Parts that draw on your screen run in the background, with no window. Parts that need a window wait for MOSS Code.";

export function PluginsPage(props: { strip?: React.ReactNode }) {
  const [plugins, setPlugins] = useState<PluginRow[] | "waiting" | undefined>(undefined);
  const [link, setLink] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | undefined>(undefined);
  const load = (): void => { void bridge().plugins().then((p) => setPlugins("waiting" in p ? "waiting" : p)); };
  useEffect(load, []);
  const add = async (from: { link: string } | { file: true }): Promise<void> => {
    const r = await bridge().addPlugin(from);
    setNote(r.ok ? { ok: true, text: "Look for its card. Nothing runs until you OK it." } : { ok: false, text: r.why });
    if (r.ok) { setLink(""); load(); }
  };
  const onLinkKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter" && link.trim() !== "") { e.preventDefault(); void add({ link: link.trim() }); }
  };
  const availability = async (t: ToolRow, a: ToolAvailability): Promise<void> => {
    if (a !== t.availability && await bridge().setAvailability(t.server, t.tool, a)) load();
  };
  const permission = async (t: ToolRow, p: ToolRow["permission"]): Promise<void> => {
    if (p !== t.permission && await bridge().setPermission(t.server, t.tool, p)) load();
  };
  return (
    <main className="page" data-col="conversation" data-page="plugins" aria-label="Plugins">
      <header className="page__head"><h1>Plugins</h1></header>
      {props.strip}
      <div className="page__body ma2-body">
        <p className="ma2-lede" data-what-moss-shows>{WHAT_MOSS_SHOWS}</p>
        <section className="add">
          <h2>Add a plugin</h2>
          <p className="muted">Tools, models, voices, or something that shows on your screen. It runs only after you OK its card.</p>
          <div className="add__row">
            <input type="url" placeholder="A link (https://… or npm:name)" value={link} onChange={(e) => setLink(e.target.value)} onKeyDown={onLinkKey} aria-label="A plugin's link" spellCheck={false} />
            <button type="button" className="text-button text-button--solid" disabled={link.trim() === ""} onClick={() => void add({ link: link.trim() })}>Add</button>
            <button type="button" className="text-button" onClick={() => void add({ file: true })}>From a file…</button>
          </div>
          {note !== undefined ? <p className={`add__note${note.ok ? "" : " ma2-why"}`} role="status">{note.text}</p> : null}
        </section>
        <section className="ma2-legend" aria-label="What the two settings mean">
          <p><strong>Bots get it</strong> decides whether bots see a tool at all: <em>Off</em> hides it, <em>On demand</em> lets them look it up when they need it, <em>Always on</em> puts it in every turn. The plugin's own choice is marked <span className="ma2-default-mark">default</span>.</p>
          <p><strong>When a bot uses it</strong> decides what happens then: <em>Always allow</em> runs it, <em>Ask</em> follows your approval level, <em>Always block</em> refuses every use while the tool stays in sight.</p>
        </section>
        {plugins === "waiting" ? <p className="muted">Waiting for the engine's plugins.</p> : null}
        {Array.isArray(plugins) && plugins.length === 0 ? <p className="muted">No plugins yet.</p> : null}
        {Array.isArray(plugins) ? plugins.map((p) => (
          <section key={p.id} className="plugin ma2-plugin" data-plugin={p.id}>
            <h2>{p.name}{!p.enabled ? <span className="chip chip--paused">Turned off</span> : null}</h2>
            {p.tools.length === 0 ? <p className="muted">No tools: its models, voices or parts work without a setting here.</p> : (
              <ul className="ma2-tools">
                <li className="ma2-tools__head" aria-hidden="true">
                  <span>Tool</span><span>Bots get it</span><span>When a bot uses it</span>
                </li>
                {p.tools.map((t) => (
                  <li key={`${t.server}/${t.tool}`} className="ma2-tool" data-tool={t.tool} data-server={t.server}>
                    <span className="ma2-tool__name">{t.tool}</span>
                    <Choice
                      label={`${t.tool}: bots get it`} kind="availability" value={t.availability} options={AVAILABILITY}
                      {...(t.declared !== undefined ? { declared: t.declared } : {})} onPick={(a) => void availability(t, a)}
                    />
                    <Choice label={`${t.tool}: when a bot uses it`} kind="permission" value={t.permission} options={PERMISSION} onPick={(x) => void permission(t, x)} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        )) : null}
      </div>
    </main>
  );
}

/** One setting as a row of choices (a radio group of buttons); the declared default, if any, carries a mark. */
function Choice<T extends string>(props: { label: string; kind: string; value: T; declared?: T; options: readonly { value: T; label: string }[]; onPick: (v: T) => void }) {
  return (
    <span className={`seg ma2-seg ma2-seg--${props.kind}`} role="radiogroup" aria-label={props.label} data-setting={props.kind}>
      {props.options.map((o) => {
        const on = props.value === o.value;
        const declared = props.declared === o.value;
        return (
          <button
            key={o.value} type="button" role="radio" aria-checked={on} data-value={o.value} {...(declared ? { "data-declared": "true" } : {})}
            className={`${on ? "is-on" : ""}${o.value === "deny" || o.value === "off" ? ` ma2-seg__${o.value}` : ""}`}
            title={declared ? `${o.label} (the plugin's default)` : o.label}
            onClick={() => props.onPick(o.value)}
          >
            {o.label}{declared ? <span className="ma2-default-mark" aria-label="the plugin's default">default</span> : null}
          </button>
        );
      })}
    </span>
  );
}
