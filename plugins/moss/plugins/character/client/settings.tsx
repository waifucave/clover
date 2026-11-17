// The avatar plugin's Settings section (`settings.section`): the figures the installed packs offer (and the person's own
// models it keeps), one picked at a time, and whether it also shows on the screen. Each is this plugin's own setting,
// changed by the person's press here (`settings.set`).
import { usePluginApi } from "@waifucave/moss-plugin-sdk/ui";
import { useId } from "react";
import { useFigure, useSetting } from "./choice";
import { S } from "./strings";

const initial = (name: string) => name.trim().charAt(0).toUpperCase() || "?";

export function FigureSettings() {
  const api = usePluginApi();
  const labelId = useId();
  const { choices, formats, shown, ready } = useFigure();
  const onScreen = useSetting<boolean>("onScreen") === true;
  const followBots = useSetting<boolean>("followBots") !== false;
  if (!ready) return null;
  const set = (key: string, value: unknown) => void api.settings.set(key, value).catch(() => undefined);
  return (
    <section className="cl-figure-settings" aria-labelledby={labelId}>
      <div className="cl-figure-settings__text">
        <span className="cl-figure-settings__label" id={labelId}>{S.avatar}</span>
        <span className="cl-figure-settings__detail">{S.settingsDetail}</span>
      </div>
      {choices.length === 0 ? <p className="cl-figure-settings__empty">{S.none}</p> : (
        <ul className="cl-figure-settings__figures" role="radiogroup" aria-label={S.pick}>
          {choices.map((c) => {
            const drawn = formats.some((f) => f.format === c.format);
            return (
              <li key={c.id}>
                <button type="button" role="radio" aria-checked={shown?.id === c.id} disabled={!drawn} className="cl-figure-settings__figure" data-figure={c.id} onClick={() => set("figure", c.id)}>
                  {c.portrait ? <img className="cl-figure-settings__face" src={c.portrait} alt="" /> : <span className="cl-figure-settings__face" aria-hidden="true">{initial(c.name)}</span>}
                  <span className="cl-figure-settings__name">{c.name}</span>
                  <span className="cl-figure-settings__from">{c.from === "own" ? S.own : drawn ? S.from(c.from) : S.notDrawn(c.format)}</span>
                  {c.license !== undefined && <span className="cl-figure-settings__from" title={S.license}>{c.license}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <label className="cl-figure-settings__switch">
        <input type="checkbox" checked={onScreen} onChange={(e) => set("onScreen", e.currentTarget.checked)} />
        <span>{S.onScreen}</span>
      </label>
      <span className="cl-figure-settings__detail">{S.onScreenDetail}</span>
      <label className="cl-figure-settings__switch">
        <input type="checkbox" checked={followBots} onChange={(e) => set("followBots", e.currentTarget.checked)} />
        <span>{S.followBots}</span>
      </label>
    </section>
  );
}
