// The microphone, for the `ui` session's frames (the `microphone` capability, spec §5.4): `getUserMedia({ audio: true })`
// works in a frame of a plugin that holds it, for audio alone, and in no other frame. `hardenSession` refuses every
// permission to every frame; the two handlers here (Chromium asks the check, then the request) are the one exception.
//
// A plugin and its children share one layer (a third party's tree as the bundled one), so any of them that holds it opens
// it for that layer's frames, by the same rule for every layer. On a real build the system's own question comes first (the
// first time, on a Mac); a test or acceptance build answers the check and the request but never asks the system, and no
// test calls getUserMedia.

/** What the handlers answer for a microphone: yes only for audio, from a frame whose layer holds `microphone`, in a window. */
export function micPermission(q: { permission: string; mediaTypes?: readonly string[]; requestingUrl: string; windowId: number | undefined }, layerScheme: string, holds: (layer: string) => boolean): boolean {
  if (q.permission !== "media" || q.windowId === undefined) return false;
  if (q.mediaTypes === undefined || q.mediaTypes.length === 0 || q.mediaTypes.some((t) => t !== "audio")) return false;
  const layer = pluginLayerOf(q.requestingUrl, layerScheme);
  return layer !== undefined && holds(layer);
}

/** The two handlers the `ui` session gets, built from what main knows so a test can drive them with fake `details` without
 *  Electron. `windowOf` is the window a web contents belongs to (a visible window or a hidden background window alike);
 *  `holds` is read at each question, so a capability that goes is refused at once. */
export function micHandlers(env: {
  layerScheme: string;
  holds: (layer: string) => boolean;
  windowOf: (wc: unknown) => number | undefined;
  testBuild: boolean;
  systemProblem: () => Promise<string | undefined>;
}) {
  const request = (wc: unknown, permission: string, callback: (ok: boolean) => void, details: { mediaTypes?: readonly string[]; requestingUrl: string }): void => {
    const ok = micPermission({ permission, mediaTypes: details.mediaTypes, requestingUrl: details.requestingUrl, windowId: env.windowOf(wc) }, env.layerScheme, env.holds);
    if (ok && !env.testBuild) void env.systemProblem().then((problem) => callback(problem === undefined), () => callback(false));
    else callback(ok);
  };
  const check = (wc: unknown, permission: string, origin: string, details: { mediaType?: string; requestingUrl?: string }): boolean =>
    micPermission({ permission, mediaTypes: details.mediaType === undefined || details.mediaType === "unknown" ? undefined : [details.mediaType], requestingUrl: details.requestingUrl ?? origin, windowId: env.windowOf(wc) }, env.layerScheme, env.holds);
  return { request, check };
}

/** The layer a plugin frame's address names (`<scheme>://<layer>/…`), or undefined for any other address. */
export function pluginLayerOf(url: string, layerScheme: string): string | undefined {
  const prefix = `${layerScheme}://`;
  if (!url.startsWith(prefix)) return undefined;
  const host = url.slice(prefix.length).split(/[/?#]/)[0];
  return host !== undefined && /^[a-z0-9][a-z0-9._-]*$/.test(host) ? host : undefined;
}
