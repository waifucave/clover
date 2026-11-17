// `app.tab.command`'s stream commands (`stream`, `stream-control`), which the engine sends the program that runs the pages
// (`browser.stream`'s video and lane HS's `host.tab.frame` jpegs) but the protocol's command schema doesn't list yet (lane
// L's): checked here, field by field, before they reach the tab's streamer. Pure: no Electron import.
import type { AppTabCommand, StreamCodec } from "./contract";

const CODECS: readonly StreamCodec[] = ["h264", "vp8", "jpeg"] as readonly StreamCodec[];
const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const kbps = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 100_000;

/** The stream command in `params`, or undefined when it is none (the protocol's own schema then judges it). */
export function streamCommandOf(params: unknown): { id: string; command: Extract<AppTabCommand, { kind: "stream" | "stream-control" }> } | undefined {
  if (params === null || typeof params !== "object") return undefined;
  const p = params as { id?: unknown; command?: unknown };
  const c = (p.command ?? {}) as Record<string, unknown>;
  if (!str(p.id, 128) || (c.kind !== "stream" && c.kind !== "stream-control") || !str(c.stream, 64)) return undefined;
  if (c.kind === "stream") {
    if (typeof c.on !== "boolean") return undefined;
    if (c.maxKbps !== undefined && !kbps(c.maxKbps)) return undefined;
    if (c.codecs !== undefined && (!Array.isArray(c.codecs) || c.codecs.length === 0 || c.codecs.length > 4 || !c.codecs.every((x) => CODECS.includes(x as StreamCodec)))) return undefined;
    return { id: p.id, command: { kind: "stream", stream: c.stream, on: c.on, ...(c.maxKbps !== undefined ? { maxKbps: c.maxKbps as number } : {}), ...(c.codecs !== undefined ? { codecs: c.codecs as StreamCodec[] } : {}) } };
  }
  if (c.keyframe !== undefined && typeof c.keyframe !== "boolean") return undefined;
  if (c.kbps !== undefined && !kbps(c.kbps)) return undefined;
  return { id: p.id, command: { kind: "stream-control", stream: c.stream, ...(c.keyframe !== undefined ? { keyframe: c.keyframe as boolean } : {}), ...(c.kbps !== undefined ? { kbps: c.kbps as number } : {}) } };
}
