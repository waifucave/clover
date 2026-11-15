// The Voice section of Settings (`settings.section`), filled by Clover Voice: which voice speaks for the bots on this
// computer, and whether replies are spoken at all.
// * The choice lists Clover Voice and each voice mode another plugin offers on this plugin's own point
//   (`clover.voice.modes`), and keeps the user's click in this plugin's `active` setting (this computer's; empty is
//   Clover Voice). A chosen mode that is no longer on shows as not running, and Clover Voice speaks meanwhile.
// * "Speak replies" is this plugin's own `speakReplies` (the stage's chip is the quick mute of the same setting).
import { useCallback, useEffect, useId, useState } from "react";
import { usePluginApi } from "./sdk";
import { S } from "./strings";

/** The modes point (host/index.ts `MODES`). */
const MODES = "clover.voice.modes";

interface Mode { pluginId: string; name: string }

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 300);

export function VoiceSection() {
  const api = usePluginApi();
  const labelId = useId();
  const speakId = useId();
  const self = api.plugin.id;
  const [speak, setSpeak] = useState(true);
  const [modes, setModes] = useState<Mode[] | undefined>(undefined);
  const [chosen, setChosen] = useState<string>("");
  const [error, setError] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const [entries, stored, on] = await Promise.all([
        api.points.entries<{ name?: unknown }>(MODES).catch(() => []), api.settings.get<string>("active"), api.settings.get<boolean>("speakReplies"),
      ]);
      const seen = new Set<string>();
      const others: Mode[] = [];
      for (const e of entries) {
        if (seen.has(e.pluginId)) continue;
        seen.add(e.pluginId);
        others.push({ pluginId: e.pluginId, name: typeof e.value.name === "string" ? e.value.name : e.pluginId });
      }
      setModes([{ pluginId: self, name: "Clover Voice" }, ...others]);
      setChosen(typeof stored === "string" ? stored : "");
      setSpeak(on !== false);
      setError(undefined);
    } catch (err) {
      setModes([{ pluginId: self, name: "Clover Voice" }]);
      setError(reasonOf(err));
    }
  }, [api, self]);

  useEffect(() => {
    void load();
    const off = api.settings.watch(null, () => void load());
    const offModes = api.points.watch(MODES, () => void load());
    return () => {
      off();
      offModes();
    };
  }, [api, load]);

  const toggleSpeak = async () => {
    const next = !speak;
    setSpeak(next);
    try {
      await api.settings.set("speakReplies", next);
    } catch (err) {
      setSpeak(!next);
      setError(S.failed(reasonOf(err)));
    }
  };

  const choose = async (pluginId: string) => {
    const value = pluginId === self ? "" : pluginId;
    setChosen(value);
    try {
      await api.settings.set("active", value);
      await load();
    } catch (err) {
      setError(S.failed(reasonOf(err)));
    }
  };

  if (modes === undefined) return null;
  const selected = chosen === "" ? self : chosen;
  const running = modes.some((m) => m.pluginId === selected);
  return (
    <>
      <div className="cl-settings__row" role="group" aria-labelledby={labelId}>
        <div className="cl-settings__text">
          <span className="cl-settings__label" id={labelId}>{S.active}</span>
          <span className="cl-settings__detail">{S.activeDetail}</span>
        </div>
        <div className="cl-settings__control">
          <div className="cl-settings__segmented" role="radiogroup" aria-label={S.active} data-testid="voice-active">
            {modes.map((m) => (
              <button key={m.pluginId} type="button" role="radio" aria-checked={m.pluginId === selected} className="cl-settings__segment" onClick={() => void choose(m.pluginId)}>
                {m.name}
              </button>
            ))}
            {!running && (
              <button type="button" role="radio" aria-checked={true} className="cl-settings__segment" disabled>
                {S.activeOff(selected)}
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="cl-settings__row" role="group" aria-labelledby={speakId}>
        <div className="cl-settings__text">
          <span className="cl-settings__label" id={speakId}>{S.speak}</span>
          <span className="cl-settings__detail">{S.speakDetail}</span>
        </div>
        <div className="cl-settings__control">
          <button type="button" role="switch" aria-checked={speak} aria-label={S.speak} className="cl-settings__switch" onClick={() => void toggleSpeak()}>
            <span className="cl-settings__knob" />
          </button>
        </div>
      </div>
      <p className="cl-settings__note">{S.offNote}</p>
      {error !== undefined && <p className="cl-settings__note" role="alert">{error}</p>}
    </>
  );
}
