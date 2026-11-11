// The `bot.stage` entry: where the bot's character stands. It asks the `avatar` spot for the bot's file, keyed by its
// format (`vrm`, `live2d`, or a renderer plugin's own); a bot with no avatar has nothing on its stage, and one whose
// format no installed renderer draws shows its portrait.
import { useEffect, useState } from "react";
import type { BotRef, BotView, EntryProps } from "../../shell/runtime/types";
import { AvatarSpeechProvider, Spot, useBotSpeech, usePluginApi, useVoiceControls } from "./sdk";

/** The bot as the daemon holds it now: read once, then followed through `bots.watch` (a model pick, a new avatar). */
function useLiveBot(bot: BotRef): BotView | undefined {
  const api = usePluginApi();
  const [now, setNow] = useState<BotView | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void api.bots?.get(bot.id).then((b) => live && setNow((was) => was ?? b), () => undefined);
    const stop = api.bots?.watch((b) => { if (live && b.id === bot.id) setNow(b); });
    return () => { live = false; stop?.(); };
  }, [api, bot.id]);
  return now;
}

/** The stage's one small control for a bot that has a voice: pressing while it speaks stops it; otherwise it switches
 *  spoken replies off or on (the app's one mute). Plain tooltip. */
function VoiceChip({ bot }: { bot: string }) {
  const v = useVoiceControls(bot);
  const label = v.speaking ? "Stop speaking" : v.speakReplies ? "Mute spoken replies" : "Unmute spoken replies";
  return (
    <button type="button" className="cl-bot-stage__chip" data-voice={v.speaking ? "speaking" : v.speakReplies ? "on" : "muted"} title={label} aria-label={label} aria-pressed={!v.speakReplies}
      onClick={() => (v.speaking ? v.stop() : v.toggle())}>
      {v.speaking ? "\u25A0" : v.speakReplies ? "\u266A" : "\u266A\u0338"}
    </button>
  );
}

export function BotStage({ props }: EntryProps<{ bot: BotRef }>) {
  const bot = useLiveBot(props.bot);
  const speech = useBotSpeech(props.bot.id);
  const avatar = bot?.avatar;
  if (!bot || avatar === undefined) return null;
  const portrait = bot.portrait === undefined ? undefined : <img className="cl-bot-stage__portrait" src={bot.portrait} alt="" />;
  return (
    <div className="cl-bot-stage" data-format={avatar.format} data-speaking={speech.speaking ? "true" : undefined}>
      <AvatarSpeechProvider feed={speech.feed} speaking={speech.speaking}>
        <Spot name="avatar" spotKey={avatar.format} props={{ bot: props.bot, src: avatar.src, file: avatar.src, format: avatar.format, name: bot.name, speaking: speech.speaking, ...(bot.portrait === undefined ? {} : { portrait: bot.portrait }) }} fallback={portrait} />
      </AvatarSpeechProvider>
      {bot.voice !== undefined ? <VoiceChip bot={props.bot.id} /> : null}
    </div>
  );
}
