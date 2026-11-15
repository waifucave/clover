// The `bot.stage` entry: where the bot's character stands. It asks the `avatar` spot for the bot's file, keyed by its
// format (`vrm`, `live2d`, or a renderer plugin's own); a bot with no avatar has nothing on its stage, and one whose
// format no installed renderer draws shows its portrait.
import { useEffect, useMemo, useState } from "react";
import type { BotRef, BotView, EntryProps } from "../../shell/runtime/types";
import { AvatarControlHub, AvatarControlProvider, AvatarSpeechProvider, Spot, cleanAvatarCue, useBotSpeech, usePluginApi, useVoiceControls } from "./sdk";

/** The bot as the daemon holds it now: read once, then followed through `bots.watch` (a model pick, a new avatar). */
function useLiveBot(bot: BotRef): BotView | undefined {
  const api = usePluginApi();
  const [now, setNow] = useState<BotView | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void api.bots?.get(bot.id).then((b) => live && setNow((was) => was ?? b), () => undefined);
    const stop = api.bots?.watch((b) => { if (live && b.id === bot.id) setNow((was) => (was !== undefined && JSON.stringify(was) === JSON.stringify(b) ? was : b)); });
    return () => { live = false; stop?.(); };
  }, [api, bot.id]);
  return now;
}

/** The renderer's side of the public figure calls (`avatar.*`): a hub the renderer under this stage takes cues from and
 *  publishes to. What it publishes (the renderer, its capabilities from `avatar.formats`, the model's names, the figure's
 *  box) goes to the core as `avatar.report`, which judges each cue a bot plugin asks for; a cue it lets through comes
 *  back as the core's `clover.avatar.cue` message for this stage. Nothing is reported for a format no renderer declares. */
function useAvatarHub(bot: string, format: string | undefined): AvatarControlHub | undefined {
  const api = usePluginApi();
  const [decl, setDecl] = useState<{ renderer: string; capabilities: string[] } | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const read = (list: readonly { pluginId: string; value: Record<string, unknown> }[]) => {
      const e = list.find((x) => x.value.format === format);
      if (live) setDecl(e === undefined ? undefined : { renderer: e.pluginId, capabilities: Array.isArray(e.value.capabilities) ? (e.value.capabilities as string[]) : [] });
    };
    void api.points?.entries("avatar.formats").then(read, () => undefined);
    const stop = api.points?.watch("avatar.formats", read);
    return () => { live = false; stop?.(); };
  }, [api, format]);
  const hub = useMemo(() => {
    if (format === undefined || decl === undefined) return undefined;
    const report = (state: { names?: unknown; box?: unknown }) => {
      void api.avatar?.report?.(bot, { format, renderer: decl.renderer, capabilities: decl.capabilities, ...(state.names !== undefined ? { names: state.names } : {}), ...(state.box !== undefined ? { box: state.box } : {}) } as never).catch(() => undefined);
    };
    const h = new AvatarControlHub(report);
    report({});
    return h;
  }, [api, bot, format, decl]);
  useEffect(() => {
    if (hub === undefined) return;
    const off = api.host.on("clover.avatar.cue", (value) => {
      const v = value as { bot?: unknown; cue?: unknown } | null;
      const cue = v?.bot === bot ? cleanAvatarCue(v.cue) : undefined;
      if (cue !== undefined) hub.cue(cue);
    });
    return () => {
      off();
      hub.close();
      void api.avatar?.report?.(bot, undefined).catch(() => undefined);
    };
  }, [api, bot, hub]);
  return hub;
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

/** How the stage frames the figure, as the avatar spot's `framing` prop: the theme's `--clover-avatar-framing` (`full`, `bust`, `waist`)
 *  and its `--clover-avatar-crop` (the part of the figure's height to show, 0.2 to 1) and `--clover-avatar-headroom` (the room above
 *  the head, a fraction of the figure, 0 to 0.6; 0.03 when it says none), each only when valid. CSS variables do not cross into a
 *  renderer's own frame, so the stage reads them and hands them over as data. */
export interface AvatarFraming { mode?: "full" | "bust" | "waist"; crop?: number; headroom?: number }

export function readFraming(style: { getPropertyValue(name: string): string }): AvatarFraming | undefined {
  const mode = style.getPropertyValue("--clover-avatar-framing").trim();
  const num = (n: string): number => Number.parseFloat(style.getPropertyValue(n));
  const show = num("--clover-avatar-crop");
  const headroom = num("--clover-avatar-headroom");
  const out: AvatarFraming = {
    ...(mode === "full" || mode === "bust" || mode === "waist" ? { mode } : {}),
    ...(Number.isFinite(show) && show >= 0.2 && show <= 1 ? { crop: show, headroom: Number.isFinite(headroom) && headroom >= 0 && headroom <= 0.6 ? headroom : 0.03 } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The stage's framing, read from its element and read again when it resizes (a bot's layout may switch it with the window's shape). */
function useFraming(el: HTMLElement | null): AvatarFraming | undefined {
  const [framing, setFraming] = useState<AvatarFraming | undefined>(undefined);
  useEffect(() => {
    if (!el || typeof getComputedStyle !== "function") return;
    const read = () => setFraming((was) => {
      const now = readFraming(getComputedStyle(el));
      return JSON.stringify(was) === JSON.stringify(now) ? was : now;
    });
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return framing;
}

export function BotStage({ props }: EntryProps<{ bot: BotRef }>) {
  const bot = useLiveBot(props.bot);
  const speech = useBotSpeech(props.bot.id);
  const avatar = bot?.avatar;
  const hub = useAvatarHub(props.bot.id, avatar?.format);
  const [stageEl, setStageEl] = useState<HTMLElement | null>(null);
  const framing = useFraming(stageEl);
  if (!bot || avatar === undefined) return null;
  const portrait = bot.portrait === undefined ? undefined : <img className="cl-bot-stage__portrait" src={bot.portrait} alt="" />;
  return (
    <div ref={setStageEl} className="cl-bot-stage" data-format={avatar.format} data-speaking={speech.speaking ? "true" : undefined}>
      <AvatarSpeechProvider feed={speech.feed} speaking={speech.speaking}>
        <AvatarControlProvider hub={hub}>
        <Spot name="avatar" spotKey={avatar.format} props={{ bot: props.bot, src: avatar.src, file: avatar.src, format: avatar.format, name: bot.name, speaking: speech.speaking, ...(framing === undefined ? {} : { framing }), ...(bot.portrait === undefined ? {} : { portrait: bot.portrait }) }} fallback={portrait} />
        </AvatarControlProvider>
      </AvatarSpeechProvider>
      {bot.voice !== undefined ? <VoiceChip bot={props.bot.id} /> : null}
    </div>
  );
}
