// The left column (spec §6.10): a search, a "+" that makes a bot from a name and one of the models the person has set
// up (so its first turn has a credential), one row per bot (its living face, its
// name, the last line of its activity, the time and an unread dot), and at the bottom the Plugins page and the person's
// account (MOSS's Settings). Every word a bot wrote is drawn as text, never as markup.
import { useEffect, useState, type KeyboardEvent } from "react";
import { Face, MoodWords } from "../faces/Face";
import { bridge, shortTime } from "../bridge";
import type { BotRow, ModelRow, MossView } from "../../shared/view";

export type Page = { bot: string } | { page: "plugins" | "settings" };

export function BotList(props: { view: MossView; page: Page; onPage: (p: Page) => void }) {
  const [query, setQuery] = useState("");
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [why, setWhy] = useState<string | undefined>(undefined);
  /** The models the person has set up (signed in), for the new bot: its first turn then has a credential. */
  const [models, setModels] = useState<ModelRow[] | "waiting" | undefined>(undefined);
  const [model, setModel] = useState<string>("");
  useEffect(() => {
    if (!naming) return;
    let live = true;
    void bridge().models().then((m) => {
      if (!live) return;
      const ready = "waiting" in m ? "waiting" as const : m.filter((x) => x.ready);
      setModels(ready);
      setModel((now) => ready === "waiting" ? "" : ready.some((x) => x.id === now) ? now : ready[0]?.id ?? "");
    });
    return () => { live = false; };
  }, [naming]);
  const noModel = Array.isArray(models) && models.length === 0;
  const q = query.trim().toLowerCase();
  const bots = props.view.bots.filter((b) => q === "" || b.name.toLowerCase().includes(q) || (b.last?.text.toLowerCase().includes(q) ?? false));
  const selected = "bot" in props.page ? props.page.bot : undefined;
  const make = async (): Promise<void> => {
    const n = name.trim();
    if (n === "" || noModel || models === undefined) return;
    const r = await bridge().createBot(n, model === "" ? undefined : model);
    if (r.ok) {
      setNaming(false);
      setName("");
      setWhy(undefined);
      props.onPage({ bot: r.id });
    } else setWhy(r.why);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") void make();
    if (e.key === "Escape") { setNaming(false); setName(""); setWhy(undefined); }
  };
  const waiting = props.view.pieces.bots === "waiting";
  return (
    <nav className="list" data-col="list" aria-label="Bots">
      <div className="list__top">
        <label className="search">
          <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.6" /><path d="M10.6 10.6 14 14" /></svg>
          <input type="search" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search bots" />
        </label>
        <button type="button" className="icon-button" aria-label="New bot" title="New bot" onClick={() => { setNaming(true); setWhy(undefined); }}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>
        </button>
      </div>
      {naming ? (
        <div className="new-bot">
          <Face name={name.trim() === "" ? "bot" : name} mood="listening" size={36} />
          <input autoFocus placeholder="Name your bot" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={onKey} aria-label="The new bot's name" maxLength={80} />
          <button type="button" className="text-button" data-make-bot onClick={() => void make()} disabled={name.trim() === "" || noModel || models === undefined}>Make</button>
          {Array.isArray(models) && models.length > 0 ? (
            <select className="new-bot__model" value={model} onChange={(e) => setModel(e.target.value)} aria-label="The new bot's model" data-new-bot-model>
              {models.map((m) => <option key={m.id} value={m.id}>{m.title} · {m.provider}</option>)}
            </select>
          ) : null}
          {noModel ? <p className="new-bot__why" role="status" data-new-bot-no-model>No model is set up yet. Sign in to a model's plugin in Settings first.</p> : null}
          {why !== undefined ? <p className="new-bot__why" role="status">{why}</p> : null}
        </div>
      ) : null}
      <ul className="rows">
        {bots.map((b) => <BotItem key={b.id} bot={b} selected={b.id === selected} onOpen={() => props.onPage({ bot: b.id })} />)}
      </ul>
      {bots.length === 0 ? <p className="list__empty">{waiting ? "Waiting for the engine's bots." : q !== "" ? "No bot matches." : "No bots yet. Make one with +."}</p> : null}
      <div className="list__bottom">
        <button type="button" className={`nav-item${"page" in props.page && props.page.page === "plugins" ? " is-on" : ""}`} onClick={() => props.onPage({ page: "plugins" })}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1.2" /><rect x="9" y="2.5" width="4.5" height="4.5" rx="1.2" /><rect x="2.5" y="9" width="4.5" height="4.5" rx="1.2" /><rect x="9" y="9" width="4.5" height="4.5" rx="1.2" /></svg>
          Plugins
        </button>
        <button type="button" className={`nav-item account${"page" in props.page && props.page.page === "settings" ? " is-on" : ""}`} onClick={() => props.onPage({ page: "settings" })}>
          <span className="account__dot" aria-hidden="true">Y</span>
          <span className="account__name">You</span>
          <svg className="account__gear" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.2" /><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M3.6 12.4 5 11M11 5l1.4-1.4" /></svg>
        </button>
      </div>
    </nav>
  );
}

function BotItem(props: { bot: BotRow; selected: boolean; onOpen: () => void }) {
  const b = props.bot;
  const line = b.last === undefined ? undefined : `${b.last.from === "user" ? "You: " : ""}${b.last.text}`;
  return (
    <li>
      <button type="button" className={`row${props.selected ? " is-on" : ""}${b.unread ? " is-unread" : ""}`} data-bot-row={b.id} onClick={props.onOpen} aria-current={props.selected ? "true" : undefined}>
        <Face name={b.name} {...(b.face !== undefined ? { face: b.face } : {})} mood={b.mood} size={44} />
        <span className="row__text">
          <span className="row__head">
            <span className="row__name">{b.name}</span>
            {b.last !== undefined ? <span className="row__time">{shortTime(b.last.at)}</span> : null}
          </span>
          <span className="row__line">
            <MoodWords mood={b.mood} {...(b.tool !== undefined ? { tool: b.tool } : {})} />
            {line !== undefined ? <span className="row__last">{line}</span> : null}
          </span>
        </span>
        {b.unread ? <span className="row__unread" aria-label="Unread" /> : null}
      </button>
    </li>
  );
}
