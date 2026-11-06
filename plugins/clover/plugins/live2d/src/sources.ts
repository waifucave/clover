// Where a Live2D model's files come from, each read with a cap: its folder over the network (a URL inside the bot's
// plugin), a `.zip` archive, or memory. An archive is extracted by Clover itself (`zip.ts`, ruling R5): every entry's
// real inflated bytes count against its cap, and an archive whose directory already declares too much is refused before
// anything inflates.

import { MemoryFileSource } from "@waifucave/mochi2d/headless";
import { LIVE2D_BUDGETS, Live2dRefusal, type Live2dBudgets, type Live2dSource } from "./validate";
import { openZip, settingsIn } from "./zip";

function tooLarge(what: string, cap: number): Live2dRefusal {
  return new Live2dRefusal("too-large", `${what} is over ${cap} bytes`);
}

/** A response's body, never more than `cap`: a Content-Length over it is refused before the body is read, and the body
 *  streams in until it passes the cap, then stops (a server may send more than it says). */
export async function readCapped(response: Response, cap: number, what: string): Promise<Uint8Array> {
  if (!response.ok) throw new Live2dRefusal("missing", `${what}: the server answered ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > cap) {
    await response.body?.cancel().catch(() => {});
    throw tooLarge(what, cap);
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const whole = new Uint8Array(await response.arrayBuffer());
    if (whole.byteLength > cap) throw tooLarge(what, cap);
    return whole;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      throw tooLarge(what, cap);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** The model's folder over the network: each path relative to the settings file's URL, which never leaves it (the
 *  validator resolved it inside the folder). */
export function urlSource(settingsUrl: string, fetcher: (url: string) => Promise<Response> = (u) => fetch(u)): { source: Live2dSource; settingsPath: string } {
  const base = new URL(settingsUrl, globalThis.location?.href ?? "http://localhost/");
  const name = decodeURIComponent(base.pathname.split("/").pop() ?? "model.model3.json");
  const folder = new URL(".", base);
  return {
    settingsPath: name,
    source: {
      read: async (path, cap) => readCapped(await fetcher(new URL(path.split("/").map(encodeURIComponent).join("/"), folder).href), cap, path),
    },
  };
}

/** What a `.zip`'s central directory declares: its entries and their inflated sizes (an early refusal only; the real
 *  bytes are counted as they inflate). */
export function zipDeclared(bytes: Uint8Array): { entries: number; inflated: number; largest: number } {
  const { names, declared } = openZip(bytes);
  return { entries: names.length, inflated: declared.reduce((s, n) => s + n, 0), largest: Math.max(0, ...declared) };
}

/** A `.zip` of a model folder, extracted here: refused whole when its directory declares more than the budget, then
 *  each entry inflated with its cap counted on the real bytes. Mochi2D only ever gets the extracted files. */
export function zipSource(bytes: Uint8Array, budgets: Live2dBudgets = LIVE2D_BUDGETS): { source: Live2dSource; settingsPath: string } {
  if (bytes.byteLength > budgets.totalBytes) throw tooLarge("the archive", budgets.totalBytes);
  const archive = openZip(bytes, budgets.files * 4);
  const inflated = archive.declared.reduce((s, n) => s + n, 0);
  if (inflated > budgets.totalBytes * 2 || Math.max(0, ...archive.declared) > budgets.totalBytes) throw tooLarge("the archive, inflated,", budgets.totalBytes);
  const settings = settingsIn(archive.names);
  if (!settings) throw new Live2dRefusal("settings", "the archive holds no .model3.json");
  return { settingsPath: settings, source: { read: (path, cap) => archive.read(path, cap) } };
}

/** Files in memory (the placeholder, the tests). */
export function memorySource(files: Record<string, Uint8Array> | ReadonlyMap<string, Uint8Array>): Live2dSource {
  const memory = MemoryFileSource.fromFiles(files instanceof Map ? Object.fromEntries(files) : (files as Record<string, Uint8Array>));
  return {
    read: async (path, cap) => {
      const data = await memory.read(path);
      if (data.byteLength > cap) throw tooLarge(path, cap);
      return data;
    },
  };
}
