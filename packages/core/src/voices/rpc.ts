// The listening half's methods (protocol app area), until push-to-talk is re-founded: `voice.listen`, the app's
// push-to-talk audio for the active voice mode, on the computer the user talks on (§6.6); `voice.status`, whether
// push-to-talk for a bot would be heard (the composer shows its hold-to-talk control only then). The speaking half's
// methods went with the core's player path: Clover Voice speaks on its own.
import { APP_METHODS } from "@waifucave/clover-protocol";
import { ContractError } from "../contracts/common";
import { handler, requireUser, type MethodHandler } from "../bots/rpc";
import type { VoiceSlot } from "./slot";

export interface VoicesMethodsDeps {
  /** The voice slot (§6.6): the active voice mode hears push-to-talk. Without it, push-to-talk is refused. */
  slot?: VoiceSlot;
}

export function voicesMethods(deps: VoicesMethodsDeps): Record<string, MethodHandler> {
  const M = APP_METHODS;
  return {
    [M.voiceListen.name]: handler(M.voiceListen, async (p, ctx) => {
      requireUser(ctx, "talk to a bot");
      if (deps.slot === undefined) throw new ContractError("unsupported", "push-to-talk isn't served here");
      return deps.slot.listen(p);
    }),
    [M.voiceStatus.name]: handler(M.voiceStatus, async (p) => ({ listens: deps.slot !== undefined ? await deps.slot.listens(p.bot) : false })),
  };
}
