// The avatar plugin's Settings section (`settings.section`): the figures the installed packs offer (and the person's own
// models it keeps), one picked at a time, and whether it also shows on the screen. Each is this plugin's own setting,
// changed by the person's press here (`settings.set`).
import { usePluginApi } from "@waifucave/moss-plugin-sdk/ui";
import { useId, useState } from "react";
import { ownModelsOf, useFigure, useSetting } from "./choice";
import { S } from "./strings";

const initial = (name: string) => name.trim().charAt(0).toUpperCase() || "?";

export function FigureSettings() {
  const api = usePluginApi();
  const labelId = useId();
  const { choices, formats, shown, ready } = useFigure();
  const onScreen = useSetting<boolean>("onScreen") === true;
  const followBots = useSetting<boolean>("followBots") !== false;
  const own = ownModelsOf(useSetting<string>("ownModels"));
  const [said, setSaid] = useState<string | undefined>(undefined);
  if (!ready) return null;
  const set = (key: string, value: unknown) => void api.settings.set(key, value).catch(() => undefined);
  // The app's own picker hands a token, never a path; the host half copies the model into this plugin's own data.
  const add = async (pick: "folder" | "file") => {
    const r = pick === "folder" ? await api.files?.pickFolder?.() : await api.files?.pickOpen?.({ multiple: false });
    const grant = r !== undefined && "grants" in r ? r.grants[0] : undefined;
    if (grant === undefined) return;
    setSaid(S.adding);
    const answer = await api.host.call<{ model?: { name: string }; refused?: string }>("importModel", { token: grant.token, name: grant.name }, { timeoutMs: 120_000 }).catch((e: unknown): { model?: { name: string }; refused?: string } => ({ refused: e instanceof Error ? e.message : String(e) }));
    setSaid(answer.model !== undefined ? S.added(answer.model.name) : answer.refused);
  };
  const remove = async (file: string) => {
    const answer = await api.host.call<{ removed?: true; refused?: string }>("removeModel", { file }).catch((e: unknown) => ({ refused: e instanceof Error ? e.message : String(e) }));
    setSaid(answer.refused);
  };
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
      <div className="cl-figure-settings__own">
        <span className="cl-figure-settings__label">{S.yours}</span>
        <span className="cl-figure-settings__detail">{S.yoursDetail}</span>
        {own.length > 0 && (
          <ul className="cl-figure-settings__own-list">
            {own.map((m) => (
              <li key={m.file}>
                <span className="cl-figure-settings__name">{m.name}</span>
                <button type="button" className="cl-figure-settings__remove" data-own={m.file} onClick={() => void remove(m.file)}>{S.remove(m.name)}</button>
              </li>
            ))}
          </ul>
        )}
        <div className="cl-figure-settings__add">
          <button type="button" data-add="folder" onClick={() => void add("folder")}>{S.addFolder}</button>
          <button type="button" data-add="file" onClick={() => void add("file")}>{S.addFile}</button>
        </div>
        {said !== undefined && <p className="cl-figure-settings__said" role="status">{said}</p>}
      </div>
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
