// Lane D's voice methods (protocol app area): `voice.listen`, the app's push-to-talk audio for a bot's listening voice
// plugin, on the computer the user talks on (§6.6); `voice.status`, whether the bot's voice listens; `voice.stop`, the user ending a bot's speech; `voice.played`, the app's player saying an utterance ended; and `voice.speak`, the
// user asking to hear one past reply. `voice.play` goes the other way, from `VoiceService.speak`.
// Owner: lane D.
import { APP_METHODS, type SessionView } from "@waifucave/clover-protocol";
import { ContractError } from "../contracts/common";
import type { SessionRecord } from "../contracts/session-host";
import { handler, requireUser, type MethodHandler } from "../bots/rpc";
import type { VoiceService } from "./service";
import type { VoiceSlot } from "./slot";

export interface VoicesMethodsDeps {
  voices: VoiceService;
  /** The voice slot (§6.6): the active voice mode hears push-to-talk, says asked replies and takes the user's stop.
   *  Without it (a test of the transport alone) the service answers as before the slot. */
  slot?: VoiceSlot;
  /** The sessions, for `voice.speak`: the reply is read from the log, never taken from the caller. */
  host?: {
    get(id: string): SessionView | undefined;
    history(id: string, opts?: { afterSeq?: number; limit?: number }): SessionRecord[];
  };
}

export function voicesMethods(deps: VoicesMethodsDeps): Record<string, MethodHandler> {
  const M = APP_METHODS;
  return {
    [M.voiceListen.name]: handler(M.voiceListen, async (p, ctx) => {
      requireUser(ctx, "talk to a bot");
      return deps.slot !== undefined ? deps.slot.listen(p) : deps.voices.listen(p);
    }),
    [M.voiceStatus.name]: handler(M.voiceStatus, async (p) => ({ listens: deps.slot !== undefined ? await deps.slot.listens(p.bot) : deps.voices.listens(p.bot) })),
    // The app's player says an utterance ended: the voice mode's queue goes on (the slot ignores one it isn't waiting on).
    [M.voicePlayed.name]: handler(M.voicePlayed, async (p) => {
      deps.slot?.played(p.bot, p.utterance);
      return { ok: true as const };
    }),
    [M.voiceStop.name]: handler(M.voiceStop, async (p, ctx) => {
      requireUser(ctx, "stop a bot's speech");
      if (deps.slot !== undefined) await deps.slot.stop(p.bot);
      else deps.voices.stop(p.bot);
      return { ok: true as const };
    }),
    [M.voiceSpeak.name]: handler(M.voiceSpeak, async (p, ctx) => {
      requireUser(ctx, "ask a bot to speak a reply");
      const host = deps.host;
      if (host === undefined) throw new ContractError("unsupported", "replies can't be spoken here");
      const view = host.get(p.session);
      if (view === undefined) throw new ContractError("not_found", `no session ${p.session}`);
      // A bot's main conversation only: the speak button is under its replies.
      if (view.kind !== "bot" || view.bot === undefined) throw new ContractError("invalid", "only a bot's main conversation's replies are spoken");
      const [record] = host.history(p.session, { afterSeq: p.seq - 1, limit: 1 });
      const text = record?.seq === p.seq && record.type === "driver" && record.event.type === "assistant_message" && typeof record.event.text === "string" ? record.event.text : undefined;
      if (text === undefined || text.trim() === "") throw new ContractError("invalid", `${p.seq} isn't one of ${view.bot}'s replies in this conversation`);
      return deps.slot !== undefined ? deps.slot.asked({ bot: view.bot, session: p.session, text }) : deps.voices.speakAsked({ bot: view.bot, session: p.session, text });
    }),
  };
}
