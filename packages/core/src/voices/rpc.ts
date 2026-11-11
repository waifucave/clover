// Lane D's voice methods (protocol app area): `voice.listen`, the app's push-to-talk audio for a bot's listening voice
// plugin, on the computer the user talks on (§6.6), and `voice.stop`, the user ending a bot's speech. `voice.play` goes the other way, from `VoiceService.speak`.
// Owner: lane D.
import { APP_METHODS } from "@waifucave/clover-protocol";
import { handler, requireUser, type MethodHandler } from "../bots/rpc";
import type { VoiceService } from "./service";

export function voicesMethods(deps: { voices: VoiceService }): Record<string, MethodHandler> {
  const M = APP_METHODS;
  return {
    [M.voiceListen.name]: handler(M.voiceListen, async (p, ctx) => {
      requireUser(ctx, "talk to a bot");
      return deps.voices.listen(p);
    }),
    [M.voiceStop.name]: handler(M.voiceStop, async (p, ctx) => {
      requireUser(ctx, "stop a bot's speech");
      deps.voices.stop(p.bot);
      return { ok: true as const };
    }),
  };
}
