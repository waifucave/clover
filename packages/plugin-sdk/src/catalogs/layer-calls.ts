// What a plugin's components reach of the plugin API, derived from the catalog (`API_CALLS`), so a member the catalog
// gives components can't be missing from the core's route or from the components' API object (the served-truth test
// holds both to this):
//
// * `COMPONENT_CALLS`: every member whose `where` includes components (`ui`, `both`) and that the catalog doesn't mark
//   `notYet`. The core's `plugin.layer.call` (and the app's `plugin.layer.api`) take exactly these, into the same API
//   router a host half's calls go through, as the component's process (`ui`): the same capability, fence and limits.
// * `LISTENER_ARGS`: the members that take a listener, and where it is. A listener can't cross a connection, so a
//   component's call of one goes through `plugin.layer.watch`: the core puts its own listener in that place and sends
//   each value back as `plugin_api_event` to that layer connection alone. A type-level check holds the table to the
//   API's signatures.
// * `toLayerWire` / `fromLayerWire`: what crosses the layer connection for bytes (`{ $bytes: base64 }`) and a
//   `net.fetch` response (`{ $response: … }`), which JSON can't carry as they are.
import type { ApiCallArgs } from "./api-signatures";
import { API_CALLS, type ApiCallInfo, type ApiCallPath } from "./api-calls";

/** The members a component may call, by the catalog. */
export const COMPONENT_CALLS: ReadonlySet<ApiCallPath> = new Set(
  (Object.entries(API_CALLS) as [ApiCallPath, ApiCallInfo][]).filter(([, v]) => (v.where === "ui" || v.where === "both") && v.notYet === undefined).map(([k]) => k),
);

/** Whether a component may call `path` (by the catalog). */
export function isComponentCall(path: string): path is ApiCallPath {
  return (COMPONENT_CALLS as ReadonlySet<string>).has(path);
}

/** Where a member's listener is, and whether the member resolves its unsubscribe (`files.watch`) rather than
 *  returning it. */
export interface ListenerArg {
  at: number;
  async?: true;
}

/** Every member that takes a listener (a function argument), where it is. */
export const LISTENER_ARGS = {
  "points.watch": { at: 1 },
  "host.on": { at: 1 },
  "storage.synced.watch": { at: 0 },
  "settings.watch": { at: 1 },
  "conversation.follow": { at: 1 },
  "bots.watch": { at: 0 },
  "computers.watch": { at: 0 },
  "devices.watch": { at: 0 },
  "approvals.watch": { at: 0 },
  "files.watch": { at: 1, async: true },
  "files.onDrop": { at: 0 },
  "browser.onCdpEvent": { at: 1 },
  "browser.watch": { at: 0 },
  "terminal.onData": { at: 1 },
  "shell.watch": { at: 0 },
  "usage.watch": { at: 0 },
  "logs.follow": { at: 1 },
  "avatar.watch": { at: 0 },
  "audio.onRecording": { at: 0 },
  "voices.speak": { at: 2 },
  "voices.listen": { at: 2 },
} as const satisfies Partial<Record<ApiCallPath, ListenerArg>>;

/** The members whose arguments include a function, by the API's own signatures. */
type TakesListener<P extends ApiCallPath> = Extract<ApiCallArgs<P>[number], (...args: never[]) => unknown> extends never ? never : P;
type ListenerPaths = { [P in ApiCallPath]: TakesListener<P> }[ApiCallPath];
// The table names exactly those members: a new one with a listener fails the typecheck here until it is added.
/** The members `PluginApi` types as absent (`NotYet`: `browser.watch` and `browser.onCdpEvent`, the person's panel's):
 *  their listener place is the table's word alone. */
type Untyped = { [P in ApiCallPath]: unknown[] extends ApiCallArgs<P> ? P : never }[ApiCallPath];
type Missing = Exclude<ListenerPaths, keyof typeof LISTENER_ARGS>;
type Extra = Exclude<keyof typeof LISTENER_ARGS, ListenerPaths | Untyped>;
const _listenersInStep: [Missing, Extra] extends [never, never] ? true : { missing: Missing; extra: Extra } = true;
void _listenersInStep;

/** Where `path`'s listener is, if it takes one. */
export function listenerArgOf(path: string): ListenerArg | undefined {
  return (LISTENER_ARGS as Record<string, ListenerArg>)[path];
}

/** A `net.fetch` response as it crosses a layer connection. */
export interface WireResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  /** base64 */
  body: string;
}

const B64 = typeof Buffer !== "undefined";
function bytesToBase64(b: Uint8Array): string {
  if (B64) return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("base64");
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
function base64ToBytes(s: string): Uint8Array<ArrayBuffer> {
  if (B64) return new Uint8Array(Buffer.from(s, "base64"));
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A `Response` as it crosses a layer connection, its body read whole up to `maxBytes` (past it: `too_large`). */
export async function responseToLayerWire(res: Response, maxBytes: number): Promise<{ $response: WireResponse }> {
  const headers: [string, string][] = [];
  res.headers.forEach((value, name) => headers.push([name, value]));
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (res.body !== null) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw Object.assign(new Error(`the response's body is over ${maxBytes} bytes, more than a component is handed`), { code: "too_large" });
      }
      chunks.push(value);
    }
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    body.set(c, at);
    at += c.byteLength;
  }
  return { $response: { status: res.status, statusText: res.statusText, headers, body: bytesToBase64(body) } };
}

/** A value made fit for a layer connection: bytes as `{ $bytes }`; functions and promises left out (a handle a
 *  component can't hold); everything else as JSON takes it. A `Response` is the caller's to turn into `{ $response }`
 *  first (its body is read asynchronously). */
export function toLayerWire(v: unknown, depth = 0): unknown {
  if (depth > 32) return null;
  if (v instanceof Uint8Array) return { $bytes: bytesToBase64(v) };
  if (v instanceof ArrayBuffer) return { $bytes: bytesToBase64(new Uint8Array(v)) };
  if (typeof v === "function" || (typeof v === "object" && v !== null && typeof (v as { then?: unknown }).then === "function")) return undefined;
  if (Array.isArray(v)) return v.map((x) => toLayerWire(x, depth + 1) ?? null);
  if (typeof v === "object" && v !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const w = toLayerWire(x, depth + 1);
      if (w !== undefined) out[k] = w;
    }
    return out;
  }
  return v;
}

/** The value back from a layer connection: `{ $bytes }` as bytes, `{ $response }` as a `Response` (the page's side
 *  only: the core reads a component's arguments with `responses: false`, so nothing it is handed becomes one). */
export function fromLayerWire(v: unknown, opts: { responses?: boolean } = {}, depth = 0): unknown {
  if (depth > 32 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => fromLayerWire(x, opts, depth + 1));
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 1 && typeof o.$bytes === "string") return base64ToBytes(o.$bytes);
  if (opts.responses !== false && keys.length === 1 && typeof o.$response === "object" && o.$response !== null) {
    const r = o.$response as WireResponse;
    return new Response(r.status === 204 || r.status === 304 ? null : base64ToBytes(r.body), { status: r.status, statusText: r.statusText, headers: r.headers });
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o)) out[k] = fromLayerWire(x, opts, depth + 1);
  return out;
}
