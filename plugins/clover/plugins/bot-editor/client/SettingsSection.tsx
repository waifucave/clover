// A bot's settings on its Edit page: a stock section headed with the bot's name, drawn from the plugin's `settings` with the
// same controls the Plugins page's detail draws (a switch, a choice, text, a colour, a number), each saved on the user's click
// (a switch or a choice) or on Save or Enter (text and a number) through `plugin.settings.set`. A secret is never drawn here:
// a key is entered in the app's own key dialog.
import { useEffect, useId, useState } from "react";
import { S } from "./strings";
import type { StockSetting } from "./types";

function Control({ s, onSet }: { s: StockSetting; onSet: (key: string, value: unknown) => void }) {
  const held = s.type === "number" ? (typeof s.value === "number" ? String(s.value) : "") : typeof s.value === "string" ? s.value : "";
  const [draft, setDraft] = useState(held);
  useEffect(() => setDraft(held), [held]);
  if (s.type === "boolean") {
    return (
      <button type="button" role="switch" aria-checked={s.value === true} aria-label={s.title} className="cl-bot-editor__switch" onClick={() => onSet(s.key, s.value !== true)} />
    );
  }
  if (s.type === "enum") {
    const value = typeof s.value === "string" ? s.value : "";
    return (
      <select className="cl-bot-editor__select" aria-label={s.title} value={value} onChange={(e) => e.target.value !== value && onSet(s.key, e.target.value)}>
        {s.options.some((o) => o.value === value) ? null : <option value={value} disabled>{value}</option>}
        {s.options.map((o) => <option key={o.value} value={o.value}>{o.title}</option>)}
      </select>
    );
  }
  const changed = draft !== held;
  const value = s.type === "number" ? (draft.trim() === "" ? null : Number(draft)) : draft;
  return (
    <form className="cl-bot-editor__inline" onSubmit={(e) => { e.preventDefault(); if (changed) onSet(s.key, value); }}>
      <input
        className="cl-bot-editor__input"
        aria-label={s.title}
        spellCheck={false}
        {...(s.type === "number" ? { type: "number", inputMode: "decimal" as const, ...(s.min !== undefined ? { min: s.min } : {}), ...(s.max !== undefined ? { max: s.max } : {}), step: "any" } : {})}
        {...(s.type === "color" ? { placeholder: "#rrggbb" } : {})}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <button type="submit" className="cl-bot-editor__button" disabled={!changed}>{S.save}</button>
    </form>
  );
}

export function SettingsSection({ bot, settings, note, onSet }: { bot: { id: string; name: string }; settings: readonly StockSetting[]; note?: string; onSet: (key: string, value: unknown) => void }) {
  const head = useId();
  if (settings.length === 0) return null;
  return (
    <section className="cl-bot-editor__settings" aria-labelledby={head} data-bot-settings={bot.id}>
      <h2 className="cl-bot-editor__settings-title" id={head}>{bot.name}</h2>
      {settings.map((s) => (
        <div className="cl-bot-editor__row" key={s.key}>
          <div className="cl-bot-editor__text">
            <span className="cl-bot-editor__label">{s.title}</span>
            {s.description && <span className="cl-bot-editor__detail">{s.description}</span>}
          </div>
          <div className="cl-bot-editor__control">
            <Control s={s} onSet={onSet} />
          </div>
        </div>
      ))}
      {note && <p className="cl-bot-editor__waiting" role="status">{note}</p>}
    </section>
  );
}
