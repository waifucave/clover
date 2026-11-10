// The keyed fetch's key never reaches the plugin that asked for it, in any form (spec §5.4 strips it from the response
// headers; the coordinator's condition on carrying `net.fetch` across the plugin host widens that to everything the
// plugin gets back): a header (stripped), the body, a redirect's URL, an error's message. A service that echoes the key
// (an endpoint that returns the request's headers, a redirect that puts it in a URL) can't hand it to the plugin.
//
// * The keys are the values the plugin's token sources gave its keyed fetch (current ones and the newer ones a 401
//   retry took), held in the daemon's memory for that plugin, never written anywhere.
// * Each occurrence is masked with as many `*` as it has bytes, so a body's length (and its `content-length`) stays
//   true. A key split across two pieces of a body is still masked: the last bytes of each piece wait for the next.
// * Exact bytes only: a JSON-escaped, base64 or percent-encoded echo of the key isn't recognised. Keys shorter than
//   `MIN_KEY_CHARS` aren't looked for (they would mask ordinary text).
import type { KeyedTokenSource } from "@waifucave/clover-provider-runtime";
import { ContractError } from "../../contracts/common";

export const MIN_KEY_CHARS = 8;
const MASK = 0x2a; // "*"

/** The values a plugin's token sources hand out, kept as they are handed out (a live set). */
export function noteKeys(source: KeyedTokenSource, keys: Set<string>): KeyedTokenSource {
  const note = <T extends { value: string } | null>(t: T): T => {
    if (t !== null && typeof t.value === "string" && t.value.length >= MIN_KEY_CHARS) keys.add(t.value);
    return t;
  };
  return {
    current: async () => note(await source.current()),
    newer: async (generation) => note(await source.newer(generation)),
  };
}

/** A text with every key masked. */
export function maskText(text: string, keys: Iterable<string>): string {
  let out = text;
  for (const k of keys) if (k.length >= MIN_KEY_CHARS && out.includes(k)) out = out.split(k).join("*".repeat(Buffer.byteLength(k)));
  return out;
}

const indexOf = (hay: Buffer, needle: Buffer, from: number): number => hay.indexOf(needle, from);

/** A byte stream with every key masked, a key split across pieces included. */
export function maskStream(body: ReadableStream<Uint8Array>, keys: Set<string>): ReadableStream<Uint8Array> {
  let tail: Buffer = Buffer.alloc(0);
  const needles = (): Buffer[] => [...keys].filter((k) => k.length >= MIN_KEY_CHARS).map((k) => Buffer.from(k));
  /** Masks every needle in `buf`, in place. */
  const maskAll = (buf: Buffer, ns: Buffer[]) => {
    for (const n of ns) for (let at = indexOf(buf, n, 0); at >= 0; at = indexOf(buf, n, at + n.length)) buf.fill(MASK, at, at + n.length);
  };
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const ns = needles();
        const longest = ns.reduce((m, n) => Math.max(m, n.length), 0);
        const buf = Buffer.concat([tail, Buffer.from(chunk)]);
        maskAll(buf, ns);
        // Hold back what could be the start of a key that the next piece completes.
        const keep = Math.min(buf.length, Math.max(0, longest - 1));
        const ready = buf.subarray(0, buf.length - keep);
        tail = Buffer.from(buf.subarray(buf.length - keep));
        if (ready.length > 0) controller.enqueue(new Uint8Array(ready));
      },
      flush(controller) {
        if (tail.length === 0) return;
        maskAll(tail, needles());
        controller.enqueue(new Uint8Array(tail));
        tail = Buffer.alloc(0);
      },
    }),
  );
}

/** A response with every key masked: the headers (any header holding one is dropped, as the keyed fetch does), the
 *  status text and the body. */
export function maskResponse(res: Response, keys: Set<string>): Response {
  const headers = new Headers();
  const present = [...keys];
  res.headers.forEach((value, name) => {
    if (name === "set-cookie") return;
    if (!present.some((k) => k.length >= MIN_KEY_CHARS && value.includes(k))) headers.append(name, value);
  });
  for (const c of res.headers.getSetCookie()) if (!present.some((k) => k.length >= MIN_KEY_CHARS && c.includes(k))) headers.append("set-cookie", c);
  return new Response(res.body === null ? null : maskStream(res.body, keys), { status: res.status, statusText: maskText(res.statusText, keys), headers });
}

/** An error with its message masked; its name and `code` kept. */
export function maskError(err: unknown, keys: Set<string>): unknown {
  if (!(err instanceof Error)) return err;
  const masked = maskText(err.message, keys);
  if (masked === err.message) return err;
  if (err instanceof ContractError) return new ContractError(err.code, masked, err.detail);
  const out = new Error(masked) as Error & { code?: unknown; detail?: unknown };
  out.name = err.name;
  const e = err as Error & { code?: unknown; detail?: unknown };
  if (e.code !== undefined) out.code = e.code;
  if (e.detail !== undefined) out.detail = e.detail;
  return out;
}
