// What `clover-core __fetch-probe` (main.ts; scripts/verify-sealed-core.ts's probe) may be asked to fetch: a loopback
// URL (the gate's own servers) or the one fixed Apple URL its OS-store check uses, with a nonce key of exactly 32 hex
// characters. Anything else is refused (exit 2) before a request is made, so a shipped binary can't be used to send an
// arbitrary header to an arbitrary host (#243 check 2).

/** The one non-loopback URL: an Apple-rooted host whose CA is in the OS store, not in Bun's bundled roots. */
export const FETCH_PROBE_APPLE_URL = "https://gdmf.apple.com/v2/pmv";
export const FETCH_PROBE_KEY = /^[a-f0-9]{32}$/;
const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

/** Why the probe refuses this URL and key, or undefined. */
export function fetchProbeRefusal(url: string, key: string): string | undefined {
  if (!FETCH_PROBE_KEY.test(key)) return "the key must be 32 lowercase hex characters";
  if (url === FETCH_PROBE_APPLE_URL) return undefined;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "not a URL";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "only http and https";
  if (u.username !== "" || u.password !== "") return "no credentials in the URL";
  if (!LOOPBACK.has(u.hostname)) return `only loopback (127.0.0.1, ::1, localhost) or ${FETCH_PROBE_APPLE_URL}`;
  return undefined;
}
