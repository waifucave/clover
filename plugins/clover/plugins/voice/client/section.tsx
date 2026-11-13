// The Voice section of Settings (`settings.section`), filled by Clover Voice: which voice mode speaks for the bots and
// hears push-to-talk on this computer. It lists the voice modes that are on and running (`speech.modes`) and keeps the
// user's choice in Clover Voice's own `active` setting (this computer's), which the core reads to pick the active one;
// empty is Clover Voice. A chosen mode that stops is shown as not running, and the core speaks with Clover Voice
// meanwhile (and says so once). Its "Speak replies" switch is the app's `voice.speakReplies` (the stage's chip is the quick
// mute of the same setting), written by the user's click.
import { useCallback, useEffect, useId, useState } from "react";
import { useCore, usePluginApi } from "./sdk";
import { S } from "./strings";

/** Clover Voice's plugin id: the choice stored as empty. */
const CLOVER_VOICE = "clover/voice";

interface Mode { pluginId: string; id: string; name: string; active: boolean }

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 300);

export function VoiceSection() {
  const api = usePluginApi();
  const core = useCore();
  const labelId = useId();
  const speakId = useId();
  /** `voice.speakReplies`: unset is on. */
  const [speak, setSpeak] = useState(true);
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

  useEffect(() => {
    if (core === undefined) return;
    let live = true;
    const apply = (settings: unknown): void => {
      const on = (settings as { voice?: { speakReplies?: boolean } } | null | undefined)?.voice?.speakReplies;
      if (live) setSpeak(on !== false);
    };
    void Promise.resolve(core.call("ui.settings", {})).then((r) => apply((r as { settings?: unknown } | undefined)?.settings ?? r), () => undefined);
    const off = core.on("ui_settings_changed", (e) => apply((e as { settings?: unknown }).settings));
    return () => {
      live = false;
      off();
    };
  }, [core]);

  const toggleSpeak = async () => {
    const next = !speak;
    setSpeak(next);
    try {
      await core?.call("ui.set", { patch: { voice: { speakReplies: next } } });
    } catch (err) {
      setSpeak(!next);
      setError(S.failed(reasonOf(err)));
    }
  };

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
        )}
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
