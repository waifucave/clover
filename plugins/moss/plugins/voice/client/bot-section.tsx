// MOSS Voice's section of a bot's editor (`bot.editor.section`): the bot's voice, this plugin's own setting for that
// bot (`provider`, `voice`, `model`), with a reset back to none; else the default the plugin that brings the bot gives (shown as
// such). Voices come with the voice providers that fill this plugin's providers point (Fish Audio, or another you add);
// when the provider isn't set up, it says why the voice can't speak. Its switch turns this one bot's voice off (the
// user's own bot setting, `silent`), whatever voice it has.
import type { BotRef } from "./local";
import type { EntryProps } from "@waifucave/moss-plugin-sdk";
import { usePluginApi } from "@waifucave/moss-plugin-sdk/ui";
import { useEffect, useId, useState } from "react";
import { S } from "./strings";

export function BotVoiceSection({ props }: EntryProps<{ bot: BotRef }>) {
  const api = usePluginApi();
  const id = useId();
  const bot = props.bot.id;
  const [voice, setVoice] = useState<{ provider?: string; voice?: string; from?: "user" | "bot"; why?: string; off?: true } | undefined>(undefined);
  const speaksId = useId();

  useEffect(() => {
    let live = true;
    const read = (): void => {
      // A bot's voice is the host half's to read (a page reads only its plugin's plain settings).
      void Promise.resolve(api.host.call<{ provider?: string; voice?: string; from?: "user" | "bot"; why?: string; off?: true } | null>("voiceOf", { bot })).then((v) => { if (live) setVoice(v ?? undefined); }, () => undefined);
    };
    read();
    const off = api.settings.watch(null, read);
    return () => {
      live = false;
      off();
    };
  }, [api, bot]);

  const setOff = async (off: boolean): Promise<void> => {
    setVoice((v) => ({ ...(v ?? {}), ...(off ? { off: true as const } : { off: undefined }) }));
    await Promise.resolve(api.host.call("setOff", { bot, off })).catch(() => undefined);
  };

  const reset = async (): Promise<void> => {
    setVoice(undefined);
    await Promise.resolve(api.host.call("forget", { bot })).catch(() => undefined);
  };

  return (
    <>
    <section className="cl-bot-editor__row" aria-labelledby={id} data-voice-section="">
      <div className="cl-bot-editor__text">
        <span className="cl-bot-editor__label" id={id}>{S.voice}</span>
        <span className="cl-bot-editor__detail">{voice?.from === "bot" ? S.byBot : S.voiceDetail}</span>
        {voice?.why !== undefined && <span className="cl-bot-editor__detail" role="note" data-voice-why="">{voice.why}</span>}
      </div>
      <div className="cl-bot-editor__control">
        <span className="cl-bot-editor__value">{voice?.provider !== undefined && voice.voice !== undefined ? S.voiceOf(voice.provider, voice.voice) : S.noVoice}</span>
        {voice?.from === "user" && (
          <button type="button" className="cl-bot-editor__reset" onClick={() => void reset()}>
            {S.reset}
          </button>
        )}
      </div>
    </section>
    <section className="cl-bot-editor__row" aria-labelledby={speaksId} data-voice-off="">
      <div className="cl-bot-editor__text">
        <span className="cl-bot-editor__label" id={speaksId}>{S.speaks}</span>
        <span className="cl-bot-editor__detail">{S.speaksDetail}</span>
      </div>
      <div className="cl-bot-editor__control">
        <button type="button" role="switch" aria-checked={voice?.off !== true} aria-label={S.speaks} className="cl-settings__switch" onClick={() => void setOff(voice?.off !== true)}>
          <span className="cl-settings__knob" />
        </button>
      </div>
    </section>
    </>
  );
}
