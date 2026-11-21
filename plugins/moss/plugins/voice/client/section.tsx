// The Voice section of Settings (`settings.section`), filled by MOSS Voice: whether replies are spoken at all ("Speak
// replies", this plugin's own `speakReplies`). Which voice speaks
// isn't kept here: its own point `moss.voice.modes` takes one filler at a time (P4), and Settings draws its picker (titled "Voice")
// and tells the user when the one they picked stops.
import { usePluginApi } from "@waifucave/moss-plugin-sdk/ui";
import { useCallback, useEffect, useId, useState } from "react";
import { S } from "./strings";

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 300);

export function VoiceSection() {
  const api = usePluginApi();
  const speakId = useId();
  const [speak, setSpeak] = useState<boolean | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      setSpeak((await api.settings.get<boolean>("speakReplies")) !== false);
      setError(undefined);
    } catch (err) {
      setSpeak(true);
      setError(reasonOf(err));
    }
  }, [api]);

  useEffect(() => {
    // Subscribe first, then read (a change between the read's answer and the subscription taking effect would be lost).
    const off = api.settings.watch("speakReplies", () => void load());
    void load();
    return off;
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

  if (speak === undefined) return null;
  return (
    <>
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
