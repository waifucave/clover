// Where a Live2D model's files come from, each read with a cap: its folder over the network (a URL inside the bot's
// plugin), a `.zip` archive, or memory. An archive is refused before anything is inflated when what it declares is
// over the budget, so a small file that would inflate to gigabytes never gets the chance.

import { findSettingsFiles, MemoryFileSource, sourceFromZip } from "@waifucave/mochi2d/headless";
import { LIVE2D_BUDGETS, Live2dRefusal, type Live2dBudgets, type Live2dSource } from "./validate";

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

/** What a `.zip`'s central directory declares: its entries and their inflated sizes. Throws for an archive it can't
 *  read, and for ZIP64 (a model has no need of it). */
export function zipDeclared(bytes: Uint8Array): { entries: number; inflated: number; largest: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Live2dRefusal("settings", "the archive has no central directory");
  const entries = view.getUint16(end + 10, true);
  const size = view.getUint32(end + 12, true);
  const offset = view.getUint32(end + 16, true);
  if (entries === 0xffff || size === 0xffffffff || offset === 0xffffffff || offset + size > bytes.length) throw new Live2dRefusal("settings", "the archive's directory is unreadable or ZIP64");
  let at = offset;
  let inflated = 0;
  let largest = 0;
  for (let i = 0; i < entries; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) throw new Live2dRefusal("settings", "the archive's directory is damaged");
    const uncompressed = view.getUint32(at + 24, true);
    if (uncompressed === 0xffffffff) throw new Live2dRefusal("too-large", "an archive entry is ZIP64");
    inflated += uncompressed;
    largest = Math.max(largest, uncompressed);
    at += 46 + view.getUint16(at + 28, true) + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return { entries, inflated, largest };
}

/** A `.zip` of a model folder: refused whole when its directory declares more than the budget, then each entry read
 *  through Mochi2D's archive reader and held to its cap. */
export function zipSource(bytes: Uint8Array, budgets: Live2dBudgets = LIVE2D_BUDGETS): { source: Live2dSource; settingsPath: string } {
  if (bytes.byteLength > budgets.totalBytes) throw tooLarge("the archive", budgets.totalBytes);
  const declared = zipDeclared(bytes);
  if (declared.entries > budgets.files * 4) throw new Live2dRefusal("too-many-files", `the archive holds ${declared.entries} entries`);
  if (declared.inflated > budgets.totalBytes * 2 || declared.largest > budgets.totalBytes) throw tooLarge("the archive, inflated,", budgets.totalBytes);
  const zip = sourceFromZip("avatar.zip", bytes);
  const settings = findSettingsFiles(zip)[0];
  if (!settings) throw new Live2dRefusal("settings", "the archive holds no .model3.json");
  return {
    settingsPath: settings,
    source: {
      read: async (path, cap) => {
        const data = await zip.read(path);
        if (data.byteLength > cap) throw tooLarge(path, cap);
        return data;
      },
    },
  };
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
