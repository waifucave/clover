// Test helper: Clover Voice's real host module (plugins/clover/plugins/voice) on a fake plugin host, its `speech.*` and
// `voices.*` answered by a voice slot's own handlers as `clover/voice` (what the plugin host's gate would run).
import * as cloverVoice from "../../../../../plugins/clover/plugins/voice/host/index";
import type { FakePluginHost } from "../../contracts/fakes/plugin-host";
import { CLOVER_VOICE, type VoiceSlot } from "../slot";

/** Clover Voice's `voiceModes` entry, as the registry lists it. */
export const CLOVER_VOICE_ENTRY = { pluginId: CLOVER_VOICE, entryId: "clover-voice", state: "active", value: { name: "Clover Voice", handler: "voice" } };

/** `entries` with Clover Voice on `voiceModes` too. */
export function withCloverVoice(entries: (point: string) => unknown[]): (point: string) => unknown[] {
  return (point) => (point === "voiceModes" ? [CLOVER_VOICE_ENTRY] : entries(point));
}

/** Defines Clover Voice on `host`, whose plugin API (the fake host's router) answers `speech.*` and `voices.*` with
 *  `slot`'s handlers, as the plugin host's gate would; the fake host starts the module with that API. */
export function startCloverVoice(host: FakePluginHost, slot: () => VoiceSlot, granted: Record<string, string[]> = {}): void {
  host.define(CLOVER_VOICE, cloverVoice as never, { source: "bundled" });
  host.serveApi(async (call) => {
    const h = slot().apiHandlers()[call.path as keyof ReturnType<VoiceSlot["apiHandlers"]>];
    if (h === undefined) throw new Error(`no plugin API is served in this test (${call.path})`);
    return h({ pluginId: call.pluginId, process: call.process, caller: call.caller, record: { granted: granted[call.pluginId] ?? [] }, path: call.path } as never, call.args);
  });
}
