// Clover Voice's chip on a bot's stage (`bot.stage.action`, the stage's own spot for small controls): for a bot that
// has a voice, pressing while it speaks stops it; otherwise it switches spoken replies off or on (this plugin's
// "Speak replies"). Whether the bot speaks is the device's speech turn: held by this plugin for this bot.
import type { BotRef } from "./local";
import type { EntryProps } from "@waifucave/clover-plugin-sdk";
import { usePluginApi } from "@waifucave/clover-plugin-sdk/ui";
import { useEffect, useState } from "react";
import { S } from "./strings";
import { DEVICE_SPEECH } from "./player";

export function VoiceChip({ props }: EntryProps<{ bot: BotRef }>) {
  const api = usePluginApi();
  const bot = props.bot.id;
  const [voiced, setVoiced] = useState(false);
  const [on, setOn] = useState(true);
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => {
    let live = true;
    const read = (): void => {
      // A bot's voice is the host half's to read (a page reads only its plugin's plain settings).
      void Promise.resolve(api.host.call<unknown>("voiceOf", { bot })).then((v) => { if (live) setVoiced(v !== null && typeof v === "object"); }, () => undefined);
      void api.settings.get<boolean>("speakReplies").then((x) => { if (live) setOn(x !== false); }, () => undefined);
    };
    read();
    const off = api.settings.watch(null, read);
    const mine = (s: { holder?: { plugin: string; note?: string } }) => s.holder?.plugin === api.plugin.id && s.holder.note === bot;
    void api.turns.state(DEVICE_SPEECH).then((s) => { if (live) setSpeaking(mine(s)); }, () => undefined);
    const offTurn = api.turns.watch(DEVICE_SPEECH, (s) => setSpeaking(mine(s)));
    return () => {
      live = false;
      off();
      offTurn();
    };
  }, [api, bot]);

  if (!voiced) return null;
  const label = speaking ? S.stopSpeaking : on ? S.mute : S.unmute;
  return (
    <button type="button" className="cl-bot-stage__chip" data-voice={speaking ? "speaking" : on ? "on" : "muted"} title={label} aria-label={label} aria-pressed={!on}
      onClick={() => {
        if (speaking) {
          setSpeaking(false);
          void Promise.resolve(api.host.call("stop", { bot })).catch(() => undefined);
          return;
        }
        setOn(!on);
        void Promise.resolve(api.settings.set("speakReplies", !on)).catch(() => setOn(on));
      }}>
      {speaking ? "■" : on ? "♪" : "♪̸"}
    </button>
  );
}
