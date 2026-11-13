// The plugin API's served areas on the app (lane A, try 15's gate: one clause per area): a folder-installed plugin's
// host tool, called by the bot, reads its own log (no capability) and is refused Clover's (no `logs.read`); reads the
// usage rows (`usage.read`), Alpha's memory (`memory.read`) and the routines (`routines.read`); runs its own command
// and is refused another plugin's (no `call:`); hands the app a silent clip as Alpha's voice and opens a push-to-talk
// watch (`audio`); and is refused the clover tree's keys. Kept apart from run.ts (which starts a run when loaded) so the
// verdict can be unit-tested.

export const API_AREAS_STEP = "the plugin API's served areas: a folder-installed plugin's tool reads its own log, the usage rows, Alpha's memory and the routines, runs its own command, plays a silent clip as Alpha's voice and listens for push-to-talk; Clover's log, another plugin's command and the clover tree's keys are refused";

/** The probe's answer, `acceptance-api-pong k=v …`, as pairs. */
export function apiProbePairs(text: string): Record<string, string> {
  const at = text.indexOf("acceptance-api-pong");
  if (at < 0) return {};
  return Object.fromEntries(text.slice(at).split(/\s+/).slice(1).filter((kv) => kv.includes("=")).map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
}

/** What is wrong with the probe's answer, one clause each; empty when every area answered as served. */
export function apiProbeWrong(said: Record<string, string>): string[] {
  const wrong: string[] = [];
  const want = (k: string, ok: (v: string) => boolean, what: string) => {
    const v = said[k];
    if (v === undefined || !ok(v)) wrong.push(`${k}: ${what} (got ${v ?? "nothing"})`);
  };
  want("own-log", (v) => v === "read", "its own log, with the line it just wrote");
  want("core-log", (v) => v.startsWith("refused:"), "Clover's log refused without logs.read");
  want("usage", (v) => /^rows:\d+$/.test(v), "the usage rows");
  want("memory", (v) => /^alpha:\d+$/.test(v), "Alpha's memory listed");
  want("routines", (v) => /^listed:\d+$/.test(v), "the routines listed");
  want("own-command", (v) => v.startsWith("pong_by_"), "its own command run");
  want("other-command", (v) => v.startsWith("refused:"), "another plugin's command refused without call:");
  want("audio-play", (v) => v === "handed", "a silent clip handed to the app as Alpha's voice");
  want("audio-listen", (v) => v === "watched", "a push-to-talk watch opened");
  want("keys", (v) => v.startsWith("refused:"), "the clover tree's keys refused");
  return wrong;
}
