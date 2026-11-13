// The Voice section of Settings (`settings.section`), filled by Clover Voice: which voice mode speaks for the bots and
// hears push-to-talk on this computer. It lists the voice modes that are on and running (`speech.modes`) and keeps the
// user's choice in Clover Voice's own `active` setting (this computer's), which the core reads to pick the active one;
// empty is Clover Voice. A chosen mode that stops is shown as not running, and the core speaks with Clover Voice
// meanwhile (and says so once).
import { useCallback, useEffect, useId, useState } from "react";
import { usePluginApi } from "./sdk";
import { S } from "./strings";

/** Clover Voice's plugin id: the choice stored as empty. */
const CLOVER_VOICE = "clover/voice";

interface Mode { pluginId: string; id: string; name: string; active: boolean }

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 300);

export function VoiceSection() {
  const api = usePluginApi();
  const labelId = useId();
  const [modes, setModes] = useState<Mode[] | undefined>(undefined);
  const [chosen, setChosen] = useState<string>("");
  const [error, setError] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const [list, stored] = await Promise.all([api.speech!.modes(), api.settings.get<string>("active")]);
      setModes(list);
      setChosen(typeof stored === "string" ? stored : "");
      setError(undefined);
    } catch (err) {
      setModes([]);
      setError(reasonOf(err));
    }
  }, [api]);

  useEffect(() => {
    void load();
    return api.settings.watch("active", () => void load());
  }, [api, load]);

  const choose = async (pluginId: string) => {
    const value = pluginId === CLOVER_VOICE ? "" : pluginId;
    setChosen(value);
    try {
      await api.settings.set("active", value);
      await load();
    } catch (err) {
      setError(S.failed(reasonOf(err)));
    }
  };

  if (modes === undefined) return null;
  const selected = chosen === "" ? CLOVER_VOICE : chosen;
  const running = modes.some((m) => m.pluginId === selected);
  return (
    <>
      <div className="cl-settings__row" role="group" aria-labelledby={labelId}>
        <div className="cl-settings__text">
          <span className="cl-settings__label" id={labelId}>{S.active}</span>
          <span className="cl-settings__detail">{modes.length === 0 ? S.activeNone : S.activeDetail}</span>
        </div>
        {modes.length > 0 && (
          <div className="cl-settings__control">
            <select className="cl-settings__select" aria-label={S.active} data-testid="voice-active" value={selected} onChange={(e) => void choose(e.target.value)}>
              {modes.map((m) => (
                <option key={m.pluginId} value={m.pluginId}>{m.name}</option>
              ))}
              {!running && <option value={selected}>{S.activeOff(selected)}</option>}
            </select>
          </div>
        )}
      </div>
      <p className="cl-settings__note">{S.offNote}</p>
      {error !== undefined && <p className="cl-settings__note" role="alert">{error}</p>}
    </>
  );
}
