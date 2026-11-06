// A plugin's declared settings (spec §5.1 "Settings": a plugin's manifest declares its settings and the default shell
// shows them; a secret goes straight to the credential store). Each field by its type: a switch, a choice, a number or
// a line of text, a colour, or a secret, which shows only whether one is stored and is never read back. A change goes
// to the core (`plugin.settings.set`), which the plugin hears through its own `settings.watch`.
import { useId, useState, type FormEvent } from "react";
import { S } from "./strings";
import type { PluginSettingsGroup, SettingField } from "./types";

function Field({ field, onSet }: { field: SettingField; onSet: (value: unknown) => void }) {
  const id = useId();
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const shown = draft ?? (field.value === undefined || field.value === null ? "" : String(field.value));
  const commit = (e?: FormEvent) => {
    e?.preventDefault();
    if (draft === undefined) return;
    if (field.type === "number") {
      const n = Number(draft);
      if (draft.trim() === "" || !Number.isFinite(n)) return setError(S.settingNumber);
      if (field.min !== undefined && n < field.min) return setError(S.settingMin(field.min));
      if (field.max !== undefined && n > field.max) return setError(S.settingMax(field.max));
      onSet(n);
    } else onSet(draft);
    setError(undefined);
    setDraft(undefined);
  };
  let control;
  if (field.type === "boolean") {
    const on = field.value === true;
    control = (
      <button type="button" role="switch" aria-checked={on} aria-labelledby={id} className="cl-settings__switch" onClick={() => onSet(!on)}>
        <span className="cl-settings__knob" />
      </button>
    );
  } else if (field.type === "enum") {
    control = (
      <select className="cl-settings__select" aria-labelledby={id} value={shown} onChange={(e) => onSet(e.target.value)}>
        {shown === "" && <option value="">{S.settingChoose}</option>}
        {(field.options ?? []).map((o) => (
          <option key={o.value} value={o.value}>
            {o.title}
          </option>
        ))}
      </select>
    );
  } else if (field.type === "secret") {
    control = (
      <form className="cl-settings__secret" onSubmit={(e) => {
        e.preventDefault();
        if (draft) onSet(draft);
        setDraft(undefined);
      }}>
        <input className="cl-settings__input" type="password" autoComplete="off" aria-labelledby={id} placeholder={field.set ? S.secretStored : S.secretNone} value={draft ?? ""} onChange={(e) => setDraft(e.target.value)} />
        <button type="submit" className="cl-settings__button" disabled={!draft}>
          {S.save}
        </button>
        {field.set && (
          <button type="button" className="cl-settings__button" aria-label={S.secretRemove(field.title)} onClick={() => onSet(null)}>
            {S.removeLabel}
          </button>
        )}
      </form>
    );
  } else {
    control = (
      <form className="cl-settings__secret" onSubmit={commit}>
        <input
          className="cl-settings__input"
          type={field.type === "number" ? "number" : field.type === "color" ? "color" : "text"}
          aria-labelledby={id}
          value={shown}
          {...(field.min !== undefined ? { min: field.min } : {})}
          {...(field.max !== undefined ? { max: field.max } : {})}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commit()}
        />
      </form>
    );
  }
  return (
    <div className="cl-settings__row" role="group" aria-labelledby={id} data-setting={field.key}>
      <div className="cl-settings__text">
        <span className="cl-settings__label" id={id}>
          {field.title}
        </span>
        {field.description && <span className="cl-settings__detail">{field.description}</span>}
        {field.defaultPending && <span className="cl-settings__detail">{S.defaultPending}</span>}
        {field.required && !field.set && field.value === undefined && <span className="cl-settings__detail cl-settings__reason">{S.settingRequired}</span>}
        {error && (
          <span className="cl-settings__detail cl-settings__reason" role="alert">
            {error}
          </span>
        )}
      </div>
      <div className="cl-settings__control">{control}</div>
    </div>
  );
}

/** One plugin's settings, each a row. */
export function PluginSettings({ group, onSet, heading = true }: { group: PluginSettingsGroup; onSet?: (pluginId: string, key: string, value: unknown) => void; heading?: boolean }) {
  return (
    <div className="cl-settings__plugin-settings" role="group" aria-label={S.settingsOf(group.name)}>
      {heading && <h4 className="cl-settings__minorhead">{group.name}</h4>}
      {group.fields.map((f) => (
        <Field key={f.key} field={f} onSet={(v) => onSet?.(group.pluginId, f.key, v)} />
      ))}
    </div>
  );
}
