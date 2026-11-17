// The person's own models: a folder or a file they pick in this plugin's Settings section (the app's own picker, which
// hands the page a token, never a path) is copied into this plugin's own data, `<data>/shared/own/imported/<id>/`, which
// it shares with its own pages only (`/_d/moss%2Fcharacter/own/…`), and listed in its `ownModels` setting. The checks
// are the ones the core's import had (spec revision 19 moved the figure here with them):
//   * what a model is comes from the formats the installed renderers declare (`moss.character.formats`, an entry's
//     `entry` extensions): the shallowest entry file roots the model, and a format no renderer that is on draws is
//     refused, naming it;
//   * only files of the packs' kinds come along (the kinds and sizes `moss.character.packs` declares), at most
//     IMPORT_CAPS.files of them, each under its kind's cap and IMPORT_CAPS.totalBytes in all, counted again as written;
//     nothing runs, links and dot files are left behind;
//   * a plain-text credit, license or readme at the top is kept as the model's credit note (the first 300 characters).
// Removing one deletes its copy and its line, and the figure picked goes back to the default when it was that one.
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FileStat } from "@waifucave/moss-plugin-sdk";

const MiB = 1024 * 1024;
export const IMPORT_CAPS = { files: 512, totalBytes: 192 * MiB, depth: 8 } as const;
/** The kinds a model's files may be, with their caps: the same as an avatar pack's (moss.json `moss.character.packs`). */
export const MODEL_KINDS: readonly { ext: readonly string[]; maxBytes: number }[] = [
  { ext: [".json"], maxBytes: 8 * MiB },
  { ext: [".moc3", ".vrm", ".glb", ".bin"], maxBytes: 128 * MiB },
  { ext: [".png", ".webp", ".jpg", ".jpeg"], maxBytes: 128 * MiB },
  { ext: [".wav", ".mp3", ".ogg"], maxBytes: 16 * MiB },
  { ext: [".txt"], maxBytes: 1 * MiB },
];
const CREDIT_NAMES = ["credit", "credits", "license", "licence", "terms", "terms of use", "readme", "read me", "クレジット", "ライセンス", "利用規約", "規約", "使用条款", "使用规则", "使用说明", "许可", "授权", "说明", "读我", "お読みください", "説明"];
const CREDIT_MAX_BYTES = 64 * 1024;

/** A format a renderer declares, as an import reads it. */
export interface ImportFormat { format: string; name: string; entry: readonly string[]; on: boolean }
export interface OwnModel { name: string; format: string; file: string; credit?: string }

/** What the host half reads a pick through: its `files` API on the pick's token (`grant:<uuid>`, `grant:<uuid>/<path>`). */
export interface PickReader {
  stat(path: string, opts?: { noFollow?: boolean }): Promise<FileStat | null>;
  list(path: string): Promise<FileStat[]>;
  readBytes(path: string): Promise<Uint8Array>;
}

export class ImportRefused extends Error {}
const refuse = (why: string): never => { throw new ImportRefused(why); };
const lower = (s: string) => s.toLowerCase();
const kindOf = (rel: string) => MODEL_KINDS.find((k) => k.ext.some((e) => lower(rel).endsWith(e)));
const entryOf = (rel: string, f: ImportFormat) => f.entry.some((e) => lower(rel).endsWith(lower(e)));
const sizeText = (n: number) => (n % MiB === 0 ? `${n / MiB} MiB` : n >= 1024 ? `${Math.floor(n / 1024)} KiB` : `${n} bytes`);
const plainPart = (p: string) => p !== "" && p !== "." && p !== ".." && !p.startsWith(".") && !p.includes("\\") && !/[\u0000-\u001f]/.test(p) && p.length <= 200;
const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** A credit note as plain text: control characters out, white space folded, at most 300 characters. */
export function plainNote(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "").replace(/\s+/g, " ").trim().slice(0, 300);
}

function decode(data: Uint8Array): string | undefined {
  for (const label of ["utf-8", "gbk", "shift_jis"]) {
    try {
      return new TextDecoder(label, { fatal: true }).decode(data);
    } catch {
      /* next */
    }
  }
  return undefined;
}

interface Item { rel: string; size: number; path: string }

/** The files under a picked folder, at most IMPORT_CAPS.depth deep: no link, no dot file. */
async function walk(reader: PickReader, root: string): Promise<Item[]> {
  const out: Item[] = [];
  const visit = async (dir: string, prefix: string, depth: number): Promise<void> => {
    if (depth > IMPORT_CAPS.depth) return;
    for (const s of await reader.list(dir)) {
      const name = baseName(s.path);
      if (!plainPart(name) || s.type === "symlink" || s.type === "other") continue;
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      if (s.type === "dir") await visit(`${dir}/${name}`, rel, depth + 1);
      else out.push({ rel, size: s.size, path: `${dir}/${name}` });
      if (out.length > 20_000) refuse("that folder holds too many files to be a model");
    }
  };
  await visit(root, "", 0);
  return out;
}

/** What the installed renderers import, in words. */
function whatImports(formats: readonly ImportFormat[]): string {
  const on = formats.filter((f) => f.on && f.entry.length > 0);
  return on.length === 0 ? "no installed renderer imports a model" : `a model is a folder holding, or a file that is, ${on.map((f) => `a ${f.entry.join(" or ")} (${f.name})`).join(", or ")}`;
}

/** Copies the picked folder or file (`token`; a file's own name as the picker gave it, `pickedName`) into `dataFolder`'s shared `own/imported/<id>/`: the model's line. */
export async function importModel(reader: PickReader, token: string, formats: readonly ImportFormat[], dataFolder: string, id: string, pickedName?: string): Promise<OwnModel> {
  if (!/^[a-z0-9-]{1,40}$/.test(id)) refuse("not an import id");
  const st = await reader.stat(token, { noFollow: true });
  if (st === null) refuse("that pick is gone");
  const items = st!.type === "dir" ? await walk(reader, token) : st!.type === "file" ? [{ rel: plainPart(pickedName ?? "") ? pickedName! : baseName(st!.path), size: st!.size, path: token }] : refuse("that is neither a folder nor a file");
  // The shallowest entry file of a known format roots the model (then the first by name); one whose renderer is off is refused by name.
  const entries = items.flatMap((i) => {
    const f = formats.find((x) => entryOf(i.rel, x));
    return f === undefined ? [] : [{ item: i, format: f }];
  }).sort((a, b) => a.item.rel.split("/").length - b.item.rel.split("/").length || (a.item.rel < b.item.rel ? -1 : 1));
  const chosen = entries.find((e) => e.format.on) ?? entries[0];
  if (chosen === undefined) refuse(`nothing there is a model an installed renderer draws: ${whatImports(formats)}`);
  if (!chosen!.format.on) refuse(`that is a ${chosen!.format.name} model (format \`${chosen!.format.format}\`), and no installed renderer that is on draws it: install one, or turn it on in Plugins`);
  const slash = chosen!.item.rel.lastIndexOf("/");
  const base = slash < 0 ? "" : chosen!.item.rel.slice(0, slash + 1);
  const keep = items.filter((i) => i.rel.startsWith(base) && kindOf(i.rel) !== undefined).map((i) => ({ ...i, rel: i.rel.slice(base.length) }));
  if (keep.length > IMPORT_CAPS.files) refuse(`that model has ${keep.length} files; the most is ${IMPORT_CAPS.files}`);
  let declared = 0;
  for (const i of keep) {
    const cap = kindOf(i.rel)!.maxBytes;
    if (i.size > cap) refuse(`${i.rel} is over ${sizeText(cap)}`);
    declared += i.size;
  }
  if (declared > IMPORT_CAPS.totalBytes) refuse(`that model is ${Math.ceil(declared / MiB)} MiB; the most is ${IMPORT_CAPS.totalBytes / MiB} MiB`);

  // The credit note: one plain-text file at the top of the pick, by a short list of names.
  const rank = (rel: string) => CREDIT_NAMES.indexOf(lower(rel.replace(/\.(txt|md)$/i, "")).trim());
  const note = items.filter((i) => !i.rel.includes("/") && /\.(txt|md)$/i.test(i.rel) && i.size <= CREDIT_MAX_BYTES && rank(i.rel) >= 0).sort((a, b) => rank(a.rel) - rank(b.rel))[0];
  let credit: string | undefined;
  if (note !== undefined) {
    const data = await reader.readBytes(note.path).catch(() => undefined);
    const text = data !== undefined && data.length <= CREDIT_MAX_BYTES ? decode(data) : undefined;
    const plain = text === undefined ? "" : plainNote(text);
    if (plain !== "") credit = plain;
  }

  // Written whole into a staging folder (the REAL bytes counted again), then renamed into place.
  const shared = join(dataFolder, "shared");
  const target = join(shared, "own", "imported", id);
  const staging = join(shared, "own", "imported", `.staging-${id}`);
  rmSync(staging, { recursive: true, force: true });
  try {
    let bytes = 0;
    for (const i of keep) {
      const data = await reader.readBytes(i.path);
      const cap = kindOf(i.rel)!.maxBytes;
      if (data.length > cap) refuse(`${i.rel} is over ${sizeText(cap)}`);
      bytes += data.length;
      if (bytes > IMPORT_CAPS.totalBytes) refuse(`that model is over ${IMPORT_CAPS.totalBytes / MiB} MiB`);
      const file = join(staging, ...i.rel.split("/"));
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, data, { mode: 0o600 });
    }
    rmSync(target, { recursive: true, force: true });
    renameSync(staging, target);
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    throw e;
  }
  const entry = chosen!.item.rel.slice(base.length);
  const name = baseName(entry).replace(/\.(model3\.json|json|vrm|glb)$/i, "") || chosen!.format.name;
  return { name, format: chosen!.format.format, file: ["own", "imported", id, entry].join("/"), ...(credit !== undefined ? { credit } : {}) };
}

/** Removes one of the person's own models' copy (only under `own/`). */
export function removeModelFiles(dataFolder: string, file: string): void {
  const parts = file.split("/");
  if (parts[0] !== "own" || parts.length < 3 || !parts.every(plainPart)) refuse("not one of your own models");
  // The model's own folder: `own/imported/<id>` for an import, `own/<bot>/<folder>` for one moved from an earlier MOSS.
  rmSync(join(dataFolder, "shared", ...parts.slice(0, 3)), { recursive: true, force: true });
}
