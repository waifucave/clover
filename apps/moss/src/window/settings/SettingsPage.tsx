// MOSS's own Settings, built in (spec §6.10, R8): the account; the keys and sign-ins for models and voices (a key is typed
// into MOSS's own field, goes to the engine once and is never shown again); each computer's approval level (a sensitive
// change: the engine raises a sealed card, which the router places in this window); the devices; and one page per bot:
// its name, its instructions, its model, its face (made from its name, or with its shape and colour pinned, §6.9) and its
// settings from plugins, drawn GENERICALLY from each plugin's declared bot-scoped settings and their schema
// (`bot.pluginSettings`). A bot's voice is one of those, not a field of the bot. No control here is one plugin's.
//
// Every change calls the bridge straight from the person's click, change or Enter (main takes it only after a press).
import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { bridge } from "../bridge";
import { Face } from "../faces/Face";
import { makeBot, PALETTE, SHAPES, type Shape } from "../faces/living-bots";
import type { BotEdit, BotRecordRow, BotRow, BotSetting, ModelRow, SettingsView } from "../../shared/view";
import type { BotFace, Level } from "@waifucave/moss-protocol";

export const LEVELS: readonly { value: Level; label: string }[] = [
  { value: "read-only", label: "Read only" },
  { value: "ask", label: "Ask before every action" },
  { value: "ask-risky", label: "Ask before risky actions" },
  { value: "accept-edits", label: "Ask before risky actions, edits allowed" },
  { value: "automatic", label: "Fully automatic" },
];

type Section = { kind: "general" } | { kind: "bot"; id: string };

export function SettingsPage(props: { bots: BotRow[]; strip?: ReactNode; bot?: string }) {
  const [section, setSection] = useState<Section>(props.bot !== undefined ? { kind: "bot", id: props.bot } : { kind: "general" });
  // Opened again on a bot (the side panel's settings button) or on the account: follow it.
  useEffect(() => { setSection(props.bot !== undefined ? { kind: "bot", id: props.bot } : { kind: "general" }); }, [props.bot]);
  const bot = section.kind === "bot" ? props.bots.find((b) => b.id === section.id) : undefined;
  return (
    <main className="page" data-col="conversation" data-page="settings" aria-label="Settings">
      <header className="page__head"><h1>Settings</h1></header>
      {props.strip}
      <div className="ma2-settings">
        <nav className="ma2-settings__nav" aria-label="Settings sections">
          <button type="button" className={`nav-item${section.kind === "general" ? " is-on" : ""}`} aria-current={section.kind === "general" ? "page" : undefined} onClick={() => setSection({ kind: "general" })} data-section="general">
            <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="5.5" r="2.6" /><path d="M2.8 14a5.2 5.2 0 0 1 10.4 0" /></svg>
            <span>Account and keys</span>
          </button>
          {props.bots.length > 0 ? <p className="ma2-settings__group">Bots</p> : null}
          {props.bots.map((b) => (
            <button key={b.id} type="button" className={`nav-item ma2-settings__bot${bot?.id === b.id ? " is-on" : ""}`} aria-current={bot?.id === b.id ? "page" : undefined} onClick={() => setSection({ kind: "bot", id: b.id })} data-section={`bot:${b.id}`}>
              <Face name={b.name} {...(b.face !== undefined ? { face: b.face } : {})} mood="idle" size={22} surface="list" />
              <span>{b.name}</span>
            </button>
          ))}
        </nav>
        <div className="page__body ma2-body">
          {bot !== undefined ? <BotPage key={bot.id} bot={bot} /> : <General />}
        </div>
      </div>
    </main>
  );
}

function Card(props: { title: string; children: ReactNode; note?: string; id?: string }) {
  return (
    <section className="settings-section" {...(props.id !== undefined ? { "data-settings": props.id } : {})}>
      <h2>{props.title}</h2>
      {props.note !== undefined ? <p className="muted small ma2-note">{props.note}</p> : null}
      {props.children}
    </section>
  );
}

function Waiting(props: { what: string }) {
  return <p className="muted">Waiting for the engine's {props.what}.</p>;
}

const KIND_WORDS: Record<string, string> = { desktop: "Computer", laptop: "Computer", phone: "Phone", tablet: "Tablet", cloud: "Cloud computer", browser: "Browser" };

// ---------------------------------------------------------------------------------------------
// The account, keys and sign-ins, approval levels and devices
// ---------------------------------------------------------------------------------------------

function General() {
  const [s, setS] = useState<SettingsView | undefined>(undefined);
  const load = (): void => { void bridge().settings().then(setS); };
  useEffect(load, []);
  const [levelNote, setLevelNote] = useState<string | undefined>(undefined);
  const level = async (computer: string, value: string): Promise<void> => {
    setLevelNote((await bridge().setLevel(computer, value)) ? "Look for the card to confirm the change." : "The engine didn't take the change.");
    load();
  };
  return (
    <>
      <Card title="Account" id="account">
        {s === undefined ? null : s.account === "waiting" ? <Waiting what="account" /> : s.account.signedIn ? (
          <div className="ma2-account">
            <span className="account__dot" aria-hidden="true">{(s.account.name ?? s.account.email ?? "?").slice(0, 1).toUpperCase()}</span>
            <span className="ma2-account__who">
              {s.account.name !== undefined ? <strong>{s.account.name}</strong> : null}
              {s.account.email !== undefined ? <span className="muted">{s.account.email}</span> : null}
            </span>
            <span className="chip chip--on">Signed in</span>
          </div>
        ) : <p className="muted">Not signed in. Signing in links your computers and phone.</p>}
      </Card>
      <Card title="Keys and sign-ins" id="keys" note="For the models and voices your plugins bring. A key you paste here is kept by MOSS's engine and is never shown again.">
        {s === undefined ? null : s.signIns === "waiting" ? <Waiting what="sign-ins" /> : s.signIns.length === 0 ? <p className="muted">No model or voice needs a key yet.</p> : (
          <ul className="kv ma2-keys">
            {s.signIns.map((x) => <SignInRow key={`${x.pluginId}#${x.index}`} row={x} onChanged={load} />)}
          </ul>
        )}
      </Card>
      <Card title="Approval level" id="level" note="How much a bot may do on each computer before it asks you. A change asks you on a card first.">
        {s === undefined ? null : s.computers === "waiting" ? <Waiting what="computers" /> : (
          <ul className="kv">
            {s.computers.map((c) => (
              <li key={c.name} data-computer={c.name}>
                <span>{c.name}</span>
                <Pick
                  value={c.level} label={`${c.name}'s approval level`} button="Change" onSave={(v) => void level(c.name, v)}
                  options={[...(LEVELS.some((l) => l.value === c.level) ? [] : [{ value: c.level, label: c.level }]), ...LEVELS]}
                />
              </li>
            ))}
          </ul>
        )}
        {levelNote !== undefined ? <p className="add__note" role="status">{levelNote}</p> : null}
      </Card>
      <Card title="Devices" id="devices">
        {s === undefined ? null : s.devices === "waiting" ? <Waiting what="devices" /> : s.devices.length === 0 ? <p className="muted">Only this computer.</p> : (
          <ul className="kv">{s.devices.map((d) => <li key={d.id}><span>{d.name}</span><span className="muted">{KIND_WORDS[d.kind] ?? d.kind}</span></li>)}</ul>
        )}
      </Card>
    </>
  );
}

type SignIn = Exclude<SettingsView["signIns"], "waiting">[number];

/** One of a plugin's sign-ins. A key goes from MOSS's own field to the engine once: the field is emptied the moment it is
 *  sent, and nothing the person typed is ever drawn back (no echo, no "last four"). */
function SignInRow(props: { row: SignIn; onChanged: () => void }) {
  const r = props.row;
  const signedIn = r.state === "signed-in";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<string | undefined>(undefined);
  const sendKey = async (): Promise<void> => {
    const key = draft.trim();
    setDraft("");
    if (key === "") return;
    const res = await bridge().signIn(r.pluginId, r.index, key);
    if ("ok" in res) { setNote(res.why); return; }
    setNote(res.state === "signed-in" ? "Key saved." : "The key wasn't taken.");
    setEditing(false);
    props.onChanged();
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") { e.preventDefault(); void sendKey(); }
    if (e.key === "Escape") { setDraft(""); setEditing(false); }
  };
  const browser = async (): Promise<void> => {
    const res = await bridge().signIn(r.pluginId, r.index);
    setNote("ok" in res ? res.why : res.state === "signed-in" ? "Signed in." : "Finish signing in in your browser.");
    props.onChanged();
  };
  const signOut = async (): Promise<void> => {
    setNote((await bridge().signOut(r.pluginId, r.index)) ? "Look for the card to confirm signing out." : "The engine didn't take it.");
  };
  const askKey = r.method === "api-key" && (!signedIn || editing);
  return (
    <li className="ma2-key" data-sign-in={`${r.pluginId}#${r.index}`} data-method={r.method}>
      <span className="ma2-key__who">
        <span>{r.name}</span>
        <span className={`chip${signedIn ? " chip--on" : " chip--paused"}`}>{signedIn ? (r.account ?? (r.method === "api-key" ? "Key saved" : "Signed in")) : r.method === "api-key" ? "No key" : "Signed out"}</span>
      </span>
      <span className="ma2-key__do">
        {askKey ? (
          <>
            <input
              type="password" className="ma2-field" placeholder="Paste a key" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey}
              autoComplete="off" spellCheck={false} autoCapitalize="off" aria-label={`${r.name}'s key`} data-key-field
            />
            <button type="button" className="text-button text-button--solid" disabled={draft.trim() === ""} onClick={() => void sendKey()}>Save</button>
            {editing ? <button type="button" className="text-button" onClick={() => { setDraft(""); setEditing(false); }}>Cancel</button> : null}
          </>
        ) : null}
        {r.method === "api-key" && signedIn && !editing ? <button type="button" className="text-button" onClick={() => setEditing(true)}>Replace key</button> : null}
        {(r.method === "oauth-pkce" || r.method === "custom") && !signedIn ? <button type="button" className="text-button text-button--solid" onClick={() => void browser()}>Sign in…</button> : null}
        {signedIn && r.method !== "core" && !editing ? <button type="button" className="text-button" onClick={() => void signOut()}>Sign out</button> : null}
      </span>
      {note !== undefined ? <p className="add__note ma2-key__note" role="status">{note}</p> : null}
    </li>
  );
}

// ---------------------------------------------------------------------------------------------
// One bot's own page
// ---------------------------------------------------------------------------------------------

function BotPage(props: { bot: BotRow }) {
  const id = props.bot.id;
  const [rec, setRec] = useState<BotRecordRow | "waiting" | undefined>(undefined);
  const [models, setModels] = useState<ModelRow[] | "waiting" | undefined>(undefined);
  const [note, setNote] = useState<string | undefined>(undefined);
  const load = (): void => { void bridge().botRecord(id).then((r) => setRec("waiting" in r ? "waiting" : r)); };
  useEffect(() => {
    load();
    void bridge().models().then((m) => setModels("waiting" in m ? "waiting" : m));
  }, [id]);
  const edit = async (patch: BotEdit, said: string): Promise<boolean> => {
    const ok = await bridge().editBot(id, patch);
    setNote(ok ? said : "The engine didn't take the change.");
    if (ok) load();
    return ok;
  };
  if (rec === undefined) return null;
  if (rec === "waiting") return <Card title={props.bot.name}><Waiting what="bots" /></Card>;
  return (
    <div className="ma2-bot" data-bot-page={id}>
      <header className="ma2-bot__head" data-settings="name">
        <Face name={rec.name} {...(rec.face !== undefined ? { face: rec.face } : {})} mood={props.bot.mood} size={56} surface="page" />
        <div className="ma2-bot__who">
          <NameField name={rec.name} onSave={(name) => edit({ name }, "Name saved.")} />
          <p className="muted small">Changes apply from {rec.name}'s next turn.</p>
        </div>
      </header>
      {note !== undefined ? <p className="add__note" role="status">{note}</p> : null}
      <Card title="Model" id="model">
        {models === undefined ? null : models === "waiting" ? <Waiting what="models" /> : (
          <Pick
            value={rec.model ?? ""} label={`${rec.name}'s model`} data="model-picker" onSave={(v) => void edit({ model: v === "" ? null : v }, "Model saved.")}
            options={[
              { value: "", label: "Your default model" },
              ...(rec.model !== undefined && !models.some((m) => m.id === rec.model) ? [{ value: rec.model, label: rec.model }] : []),
              ...models.map((m) => ({ value: m.id, label: `${m.title} · ${m.provider}${m.ready ? "" : " (not signed in)"}` })),
            ]}
          />
        )}
      </Card>
      <PluginSettings bot={id} />
      <Card title="Face" id="face" note="A face is made from the name. Pin a shape or a colour to keep it.">
        <FacePicker name={rec.name} {...(rec.face !== undefined ? { face: rec.face } : {})} onPick={(face, said) => void edit({ face }, said)} />
      </Card>
      <Card title="Instructions" id="instructions" note="Who the bot is, how it talks, what it cares about.">
        <Instructions name={rec.name} bytes={rec.instructionsBytes} onSave={(instructions) => edit({ instructions }, "Instructions replaced.")} />
      </Card>
    </div>
  );
}

function NameField(props: { name: string; onSave: (name: string) => Promise<boolean> }) {
  const [v, setV] = useState(props.name);
  useEffect(() => { setV(props.name); }, [props.name]);
  const changed = v.trim() !== "" && v.trim() !== props.name;
  const save = (): void => { if (changed) void props.onSave(v.trim()); };
  return (
    <div className="ma2-inline">
      <input className="ma2-field ma2-name" value={v} maxLength={80} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); save(); } }} aria-label="The bot's name" />
      <button type="button" className="text-button text-button--solid" disabled={!changed} onClick={save}>Save</button>
    </div>
  );
}

/** The instructions file's text is not served by the engine yet (only its size), so the box starts empty and saving
 *  replaces the file; it never sends an empty box. */
function Instructions(props: { name: string; bytes: number; onSave: (text: string) => Promise<boolean> }) {
  const [v, setV] = useState("");
  const save = async (): Promise<void> => { if (v.trim() !== "" && await props.onSave(v)) setV(""); };
  return (
    <>
      <p className="muted small" data-instructions-size>{props.bytes === 0 ? `${props.name} has no instructions yet.` : `${props.name}'s instructions file holds ${sizeWords(props.bytes)}. What you write here replaces it.`}</p>
      <textarea className="ma2-field ma2-instructions" rows={5} value={v} onChange={(e) => setV(e.target.value)} placeholder={`Who ${props.name} is, how ${props.name} talks…`} aria-label={`${props.name}'s instructions`} />
      <div className="ma2-inline ma2-inline--end">
        <button type="button" className="text-button text-button--solid" disabled={v.trim() === ""} onClick={() => void save()}>{props.bytes === 0 ? "Save instructions" : "Replace instructions"}</button>
      </div>
    </>
  );
}

export function sizeWords(bytes: number): string {
  return bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}

const SHAPE_WORDS: Record<Shape, string> = { ball: "Ball", drop: "Drop", dome: "Dome", bowl: "Bowl", pill: "Pill", loaf: "Loaf", tile: "Tile", peak: "Peak", gem: "Gem", cup: "Cup" };

/** The face: the kit's shapes and colours to pin, and "from the name" to clear a pin. The eyes and the temper come from
 *  the name (a bot's record pins only shape and colour, §6.9). */
function FacePicker(props: { name: string; face?: BotFace; onPick: (face: BotFace | null, said: string) => void }) {
  const pinned = props.face ?? {};
  const made = makeBot(props.name, { ...(pinned.shape !== undefined ? { shape: pinned.shape as Shape } : {}), ...(pinned.color !== undefined ? { color: pinned.color } : {}) });
  const pick = (shape: string | undefined, color: string | undefined): void => {
    const next: BotFace = { ...(shape !== undefined ? { shape } : {}), ...(color !== undefined ? { color } : {}) };
    props.onPick(shape === undefined && color === undefined ? null : next, "Face saved.");
  };
  return (
    <div className="ma2-face">
      <p className="ma2-face__label">Shape</p>
      <div className="ma2-swatches" role="radiogroup" aria-label="Shape">
        <button type="button" role="radio" aria-checked={pinned.shape === undefined} className={`ma2-swatch ma2-swatch--name${pinned.shape === undefined ? " is-on" : ""}`} onClick={() => pick(undefined, pinned.color)} title="Made from the name">From the name</button>
        {SHAPES.map((s) => (
          <button key={s} type="button" role="radio" aria-checked={pinned.shape === s} className={`ma2-swatch ma2-swatch--shape${pinned.shape === s ? " is-on" : ""}`} onClick={() => pick(s, pinned.color)} title={SHAPE_WORDS[s]} aria-label={SHAPE_WORDS[s]} data-shape={s}>
            <Face name={props.name} face={{ ...pinned, shape: s }} mood="idle" size={34} surface="page" />
          </button>
        ))}
      </div>
      <p className="ma2-face__label">Colour</p>
      <div className="ma2-swatches" role="radiogroup" aria-label="Colour">
        <button type="button" role="radio" aria-checked={pinned.color === undefined} className={`ma2-swatch ma2-swatch--name${pinned.color === undefined ? " is-on" : ""}`} onClick={() => pick(pinned.shape, undefined)} title="Made from the name">From the name</button>
        {PALETTE.map(([c, hex]) => (
          <button key={c} type="button" role="radio" aria-checked={pinned.color === c} className={`ma2-swatch ma2-swatch--color${pinned.color === c ? " is-on" : ""}`} onClick={() => pick(pinned.shape, c)} title={c} aria-label={c} data-color={c}>
            <span style={{ background: hex }} />
          </button>
        ))}
      </div>
      <p className="muted small" data-face-traits>Eyes {made.eye.kind}, temper {made.temper}: both from the name.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// A bot's settings from plugins, drawn from each setting's declared schema
// ---------------------------------------------------------------------------------------------

/** Every plugin's bot-scoped settings for this bot, grouped by plugin. Each field is drawn from its schema alone (its
 *  type, title, description, options, min and max), so any plugin's settings show the same way. */
export function PluginSettings(props: { bot: string }) {
  const [rows, setRows] = useState<BotSetting[] | "waiting" | undefined>(undefined);
  const load = (): void => { void bridge().botSettings(props.bot).then((r) => setRows("waiting" in r ? "waiting" : r)); };
  useEffect(load, [props.bot]);
  const set = async (r: BotSetting, value: unknown): Promise<void> => {
    if (await bridge().setBotSetting(props.bot, r.pluginId, r.key, value)) load();
  };
  if (rows === undefined) return null;
  if (rows === "waiting") return <Card title="From plugins"><Waiting what="plugins" /></Card>;
  if (rows.length === 0) return <Card title="From plugins"><p className="muted">No plugin has a setting for this bot.</p></Card>;
  const groups = new Map<string, { name: string; rows: BotSetting[] }>();
  for (const r of rows) {
    const g = groups.get(r.pluginId) ?? { name: r.pluginName, rows: [] };
    g.rows.push(r);
    groups.set(r.pluginId, g);
  }
  return (
    <>
      {[...groups.entries()].map(([pluginId, g]) => (
        <section key={pluginId} className="settings-section" data-plugin-settings={pluginId}>
          <h2>{g.name}<span className="muted small ma2-from">&nbsp;· plugin</span></h2>
          <ul className="kv ma2-plugin-settings">
            {g.rows.map((r) => <SettingField key={`${r.pluginId}/${r.key}`} row={r} onSet={(v) => void set(r, v)} />)}
          </ul>
        </section>
      ))}
    </>
  );
}

function SettingField(props: { row: BotSetting; onSet: (value: unknown) => void }) {
  const r = props.row;
  return (
    <li className="ma2-setting" data-bot-setting={r.key} data-type={r.type}>
      <span className="ma2-setting__text">
        <span>{r.title}{!r.set ? <span className="muted small"> · default</span> : null}</span>
        {r.description !== undefined ? <span className="muted small">{r.description}</span> : null}
      </span>
      <span className="ma2-setting__control"><Control row={r} onSet={props.onSet} /></span>
    </li>
  );
}

/** A choice from a list, sent with its own button: a native menu can stay open longer than main's press lasts, so the
 *  write goes from the button's click (or Enter on the list), never from the menu's change. */
function Pick(props: { value: string; label: string; options: readonly { value: string; label: string; disabled?: boolean }[]; onSave: (value: string) => void; button?: string; data?: string }) {
  const [v, setV] = useState(props.value);
  useEffect(() => { setV(props.value); }, [props.value]);
  const changed = v !== props.value;
  const save = (): void => { if (changed) props.onSave(v); };
  return (
    <span className="ma2-inline ma2-pick">
      <select value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); save(); } }} aria-label={props.label} {...(props.data !== undefined ? { [`data-${props.data}`]: "" } : {})}>
        {props.options.map((o) => <option key={o.value} value={o.value} {...(o.disabled === true ? { disabled: true } : {})}>{o.label}</option>)}
      </select>
      {changed ? <button type="button" className="text-button text-button--solid" onClick={save}>{props.button ?? "Save"}</button> : null}
    </span>
  );
}

function Control(props: { row: BotSetting; onSet: (value: unknown) => void }) {
  const r = props.row;
  if (r.type === "enum") {
    const opts = r.options ?? [];
    const value = typeof r.value === "string" ? r.value : "";
    return (
      <Pick
        value={value} label={r.title} onSave={(v) => props.onSet(v)}
        options={[...(value === "" || !opts.some((o) => o.value === value) ? [{ value, label: "Choose…", disabled: true }] : []), ...opts.map((o) => ({ value: o.value, label: o.title }))]}
      />
    );
  }
  if (r.type === "boolean") {
    return (
      <label className="ma2-switch">
        <input type="checkbox" role="switch" checked={r.value === true} onChange={(e) => props.onSet(e.target.checked)} aria-label={r.title} />
        <span aria-hidden="true" />
      </label>
    );
  }
  return <Typed row={r} onSet={props.onSet} />;
}

/** A typed value (a string, a number, a colour or a secret): set with Enter or the Set button. A secret's field starts
 *  empty and is emptied once sent; its value is never drawn. */
function Typed(props: { row: BotSetting; onSet: (value: unknown) => void }) {
  const r = props.row;
  const secret = r.type === "secret";
  const start = secret || r.value === undefined || r.value === null ? "" : String(r.value);
  const [v, setV] = useState(start);
  useEffect(() => { setV(start); }, [start]);
  const valid = r.type !== "number" || (v.trim() !== "" && Number.isFinite(Number(v)) && (r.min === undefined || Number(v) >= r.min) && (r.max === undefined || Number(v) <= r.max));
  const dirty = v !== start && valid && (!secret || v !== "");
  const commit = (): void => {
    if (!dirty) return;
    props.onSet(r.type === "number" ? Number(v) : v);
    if (secret) setV("");
  };
  return (
    <span className="ma2-inline">
      <input
        className="ma2-field" type={secret ? "password" : r.type === "number" ? "number" : r.type === "color" ? "color" : "text"} value={v}
        {...(r.type === "number" && r.min !== undefined ? { min: r.min } : {})} {...(r.type === "number" && r.max !== undefined ? { max: r.max } : {})}
        {...(secret ? { autoComplete: "off", placeholder: r.set ? "Set; type to replace" : "Not set" } : {})}
        onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }} aria-label={r.title} aria-invalid={!valid}
      />
      <button type="button" className="text-button" disabled={!dirty} onClick={commit}>Set</button>
    </span>
  );
}
