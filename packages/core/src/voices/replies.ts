// Speaking a bot's replies (spec §6.6, the first version's cut): when a turn of a bot's MAIN conversation ends on its
// own (`end_turn`), the reply it ended with (the turn's last assistant message) is spoken with the bot's voice
// (`VoiceService.speak`, which sends `voice.play` to the app here). Owner: lane D.
//
// * Only with the user's setting on (`UiSettings.voice.speakReplies`, unset is on), read at each turn's end.
// * A bot with no voice, a voice plugin that isn't installed or doesn't speak, no key, a provider the user hasn't
//   allowed: nothing is spoken and the text is as it always was; the reason is logged once per bot and reason.
// * Not side threads, routines' runs, agents or coding sessions; not a stopped, failed or cut-off turn; not the
//   greeting (recorded by the core, never a turn).
import type { SessionView } from "@waifucave/clover-protocol";
import type { SessionRecord } from "../contracts/session-host";
import type { Unsubscribe } from "../contracts/common";

export interface ReplySpeakerOptions {
  host: {
    watch(fn: (view: SessionView) => void): Unsubscribe;
    subscribe(id: string, fn: (record: SessionRecord) => void): Unsubscribe;
    list(): SessionView[];
  };
  /** Where a reply goes to be spoken: the voice slot's active voice mode (`VoiceSlot.reply`), which says it in its turn. */
  voices: { speak(o: { bot: string; session: string; text: string }): Promise<unknown> };
  /** The user's `voice.speakReplies` now. */
  enabled(): boolean;
  warn?: (message: string) => void;
}

/** Starts speaking the replies of every bot's main conversation here; the returned function stops it. */
export function speakReplies(o: ReplySpeakerOptions): Unsubscribe {
  const followed = new Map<string, Unsubscribe>();
  const warned = new Set<string>();
  const follow = (view: SessionView) => {
    if (view.kind !== "bot" || view.bot === undefined || followed.has(view.id)) return;
    const bot = view.bot;
    let last: string | undefined;
    followed.set(view.id, o.host.subscribe(view.id, (r) => {
      if (r.type === "turn_started") last = undefined;
      else if (r.type === "driver" && r.event.type === "assistant_message" && typeof r.event.text === "string" && r.event.text.trim() !== "") last = r.event.text;
      else if (r.type === "turn_ended") {
        const text = last;
        last = undefined;
        if (r.end.reason !== "end_turn" || text === undefined || !o.enabled()) return;
        void o.voices.speak({ bot, session: view.id, text }).catch((err: unknown) => {
          const why = err instanceof Error ? err.message : String(err);
          if (warned.has(`${bot}\0${why}`)) return;
          warned.add(`${bot}\0${why}`);
          o.warn?.(`${bot}'s reply wasn't spoken: ${why}`);
        });
      }
    }));
  };
  for (const v of o.host.list()) follow(v);
  const offWatch = o.host.watch(follow);
  return () => {
    offWatch();
    for (const off of followed.values()) off();
    followed.clear();
  };
}
