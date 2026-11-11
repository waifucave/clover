// `bot.importAvatar`: copies a model the user owns into the fenced folder `<home>/user-layers/avatars/<bot>/` and
// names it as the bot's avatar (`user:<folder>/<entry file>`), so no layer is ever handed a raw path. What a model is
// comes from the installed renderers' `avatar.formats` declarations, never from a format named here: a folder or a zip
// holding a format's entry file (`entry.extensions`), or one file of a format that imports single files
// (`import.accepts`). Only the files of the format's declared kinds come along, each under its kind's clamped cap
// (`files.kinds`, `clampAvatarCap`) and at most `files.maxFiles` of them: nothing runs, and a zip's folders, PSDs and
// anything else are left behind. A model of a format whose renderer isn't installed and on is refused, naming the
// format. Names may be CJK and a zip's may be GBK or Shift-JIS.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, extname, join, resolve } from "node:path";
import { AvatarFormatEntry, avatarFileKind, BUNDLED_AVATAR_FORMATS, extensionOf, orList, type AvatarFormatDecl } from "@waifucave/clover-plugin-sdk";
import type { PluginRegistry } from "../contracts/plugin-registry";
import { ContractError } from "../contracts/common";
import { entryData, listEntries } from "../browser/headless/unzip";
import { userAvatarsDir } from "./paths";
import { neutralNote } from "./user-layer";

const MiB = 1024 * 1024;
export const AVATAR_IMPORT_CAPS = { files: 512, fileBytes: 128 * MiB, totalBytes: 192 * MiB, zipBytes: 512 * MiB } as const;

/** The formats an import reads: `active`, the installed renderers' that are on (a model of one of these imports), and
 *  `known`, every declaration the registry holds (a model of one of these whose renderer is off is refused by name). */
export interface AvatarFormats {
  active: readonly AvatarFormatDecl[];
  known: readonly AvatarFormatDecl[];
}

/** Clover's own two, as an import with no registry reads them (tests, a core built without one). */
export const SHIPPED_FORMATS: AvatarFormats = { active: BUNDLED_AVATAR_FORMATS, known: BUNDLED_AVATAR_FORMATS };

type Source = "folder" | "zip" | "file";
const accepts = (d: AvatarFormatDecl, source: Source) => (d.import?.accepts ?? ["folder", "zip", "file"]).includes(source);
/** What names a model inside a folder or zip: a format's entry extensions, less an archive (a zip isn't unpacked twice). */
const entryExtensions = (d: AvatarFormatDecl) => d.entry.extensions.filter((e) => e !== ".zip");
/** What one picked file of a format may be: its entry extensions, and the extensions of its kinds when its model is that
 *  one file (`files.maxFiles` 1, as a VRM's `.glb`). */
const fileExtensions = (d: AvatarFormatDecl) => [...new Set([...entryExtensions(d), ...(d.files.maxFiles === 1 ? d.files.kinds.flatMap((k) => k.ext) : [])])];
/** A format's name in English (a `Text` in several languages gives its `en`). */
export const formatName = (d: Pick<AvatarFormatDecl, "name">): string => (typeof d.name === "string" ? d.name : d.name.en);
const nameOf = formatName;
/** A cap in words: whole MiB, else KiB, else bytes. */
const sizeText = (n: number) => (n % MiB === 0 ? `${n / MiB} MiB` : n >= 1024 ? `${Math.floor(n / 1024)} KiB` : `${n} bytes`);

/** The formats the registry's `avatar.formats` entries declare: `active` from the renderers that are on, `known` from
 *  every one it holds. An entry that doesn't parse is left out. */
export function avatarFormatsOf(registry: Pick<PluginRegistry, "entries">): AvatarFormats {
  const all = registry.entries("avatar.formats").flatMap((c) => {
    const parsed = AvatarFormatEntry.safeParse(c.value);
    return parsed.success ? [{ decl: parsed.data as AvatarFormatDecl, on: c.state === "active" }] : [];
  });
  return { active: all.filter((x) => x.on).map((x) => x.decl), known: all.map((x) => x.decl) };
}

/** What `bot.avatarFormats` answers: each format an import takes now, with what the picker offers for it. */
export function importableFormats(f: AvatarFormats): { format: string; name: string; accepts: Source[]; files: string[]; entries: string[] }[] {
  return f.active.map((d) => ({
    format: d.format, name: nameOf(d), accepts: (["folder", "zip", "file"] as const).filter((s) => accepts(d, s)),
    files: accepts(d, "file") ? fileExtensions(d) : [], entries: entryExtensions(d),
  }));
}

export interface ImportedAvatar {
  /** `user:<folder>/<path>`: the bot's avatar `file` in its user layer; the core serves it, never a raw path. */
  file: string;
  /** The format, as its renderer declares it (`avatar.formats`). */
  format: string;
  files: number;
  bytes: number;
  /** The model's own credit or terms note: plain text, the first 300 characters of the top level's readme, license,
   *  credit or terms file. Absent when the model carries none. */
  credit?: string;
}

export interface Item {
  rel: string;
  read(): Uint8Array;
  size: number;
  /** A read that never produces more than `max` bytes (a zip's entry is inflated no further than that): for a file read
   *  only to see what it says, whose declared size an archive can lie about. */
  readUpTo?(max: number): Uint8Array;
}

const ext = (name: string) => extname(name).slice(1).toLowerCase();

/** A zip entry's name as written: UTF-8 when the archive says so or it decodes cleanly, else GBK, then Shift-JIS. */
export function decodeZipName(raw: Uint8Array, utf8Flag: boolean): string {
  if (utf8Flag) return new TextDecoder().decode(raw);
  for (const label of ["utf-8", "gbk", "shift_jis"]) {
    try {
      return new TextDecoder(label, { fatal: true }).decode(raw);
    } catch {
      /* next */
    }
  }
  return new TextDecoder("latin1").decode(raw);
}

function cleanRel(name: string): string | undefined {
  const rel = name.replace(/\\/g, "/");
  const parts = rel.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.length === 0 || rel.startsWith("/") || parts.some((p) => p === ".." || p.startsWith(".") || /[\u0000-\u001f]/.test(p) || p.length > 200)) return undefined;
  return parts.join("/");
}

function fromFolder(root: string): Item[] {
  const out: Item[] = [];
  const walk = (dir: string, prefix: string, depth: number) => {
    if (depth > 8) return;
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith(".")) continue;
      const full = join(dir, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      if (st.isDirectory()) walk(full, rel, depth + 1);
      else if (st.isFile()) out.push({ rel, size: st.size, read: () => readFileSync(full) });
      if (out.length > 20_000) throw new ContractError("invalid", "that folder holds too many files to be a model");
    }
  };
  walk(root, "", 0);
  return out;
}

function fromZip(path: string): Item[] {
  if (statSync(path).size > AVATAR_IMPORT_CAPS.zipBytes) throw new ContractError("invalid", `that zip is over ${AVATAR_IMPORT_CAPS.zipBytes / MiB} MiB`);
  const zip = readFileSync(path);
  let entries;
  try {
    entries = listEntries(zip, decodeZipName);
  } catch (e) {
    throw new ContractError("invalid", `that isn't a readable zip: ${(e as Error).message}`);
  }
  const out: Item[] = [];
  for (const entry of entries) {
    if (entry.isDir || entry.isSymlink) continue;
    const rel = cleanRel(entry.name);
    if (rel === undefined) continue;
    out.push({
      rel,
      size: entry.size,
      read: () => entryData(zip, entry, (d) => Bun.hash.crc32(d), AVATAR_IMPORT_CAPS.fileBytes),
      readUpTo: (max) => entryData(zip, entry, (d) => Bun.hash.crc32(d), max),
    });
  }
  return out;
}

/** Names (without the extension) of the top-level text files that carry a model's credit or terms, most telling first:
 *  credit, license, terms, readme, and their common Chinese and Japanese names. */
const CREDIT_NAMES = ["credit", "credits", "license", "licence", "terms", "terms of use", "readme", "read me", "クレジット", "ライセンス", "利用規約", "規約", "使用条款", "使用规则", "使用说明", "许可", "授权", "说明", "读我", "お読みください", "説明"];
const CREDIT_MAX_BYTES = 64 * 1024;
/** A staging folder untouched this long belongs to an import that died. */
const STALE_STAGING_MS = 60 * 60_000;

/** The credit note of a model: one plain-text file (.txt or .md, at most 64 KB) at the TOP level of the picked folder or
 *  zip, by a short name list. Read as text only (UTF-8, else GBK, else Shift-JIS), never run or served; neutralised. */
export function creditNote(items: readonly Item[]): string | undefined {
  // A zip that wraps everything in one folder (the usual way) has that folder as its top level.
  const first = new Set(items.map((i) => i.rel.split("/")[0]));
  const wrapper = first.size === 1 && items.every((i) => i.rel.includes("/")) ? `${[...first][0]}/` : "";
  const top = items
    .filter((i) => i.rel.startsWith(wrapper) && !i.rel.slice(wrapper.length).includes("/"))
    .map((i) => ({ ...i, rel: i.rel.slice(wrapper.length) }))
    .filter((i) => /\.(txt|md)$/i.test(i.rel) && i.size <= CREDIT_MAX_BYTES);
  const rank = (i: Item) => CREDIT_NAMES.indexOf(i.rel.replace(/\.(txt|md)$/i, "").trim().toLowerCase());
  const chosen = top.filter((i) => rank(i) >= 0).sort((a, b) => rank(a) - rank(b))[0];
  if (chosen === undefined) return undefined;
  let data: Uint8Array;
  try {
    // Its own reader: never more than the cap and one byte more is inflated (an archive's declared size can lie).
    data = chosen.readUpTo === undefined ? chosen.read() : chosen.readUpTo(CREDIT_MAX_BYTES + 1);
  } catch {
    return undefined;
  }
  if (data.length > CREDIT_MAX_BYTES) return undefined;
  let text: string | undefined;
  for (const label of ["utf-8", "gbk", "shift_jis"]) {
    try {
      text = new TextDecoder(label, { fatal: true }).decode(data);
      break;
    } catch {
      /* next */
    }
  }
  const note = neutralNote(text ?? "");
  return note === "" ? undefined : note;
}

/** A model of a format whose renderer isn't on: refused, naming the format. */
function noRenderer(d: AvatarFormatDecl): ContractError {
  return new ContractError("invalid", `that is a ${nameOf(d)} model (format \`${d.format}\`), and no installed renderer draws ${nameOf(d)} models: install one, or turn it on in Plugins`);
}

/** What the installed renderers import, in words: "a folder or a zip holding a .model3.json, or a .vrm or .glb file". */
function whatImports(f: AvatarFormats): string {
  const held = [...new Set(f.active.filter((d) => accepts(d, "folder") || accepts(d, "zip")).flatMap(entryExtensions))];
  const files = [...new Set(f.active.filter((d) => accepts(d, "file")).flatMap(fileExtensions))];
  const parts = [...(held.length > 0 ? [`a folder or a zip holding a ${orList(held)}`] : []), ...(files.length > 0 ? [`a ${orList(files)} file`] : [])];
  return parts.length === 0 ? "no installed renderer imports a model" : `an avatar is ${parts.join(", or ")}`;
}

export function importAvatar(home: string, bot: string, source: string, formats: AvatarFormats = SHIPPED_FORMATS): ImportedAvatar {
  const path = resolve(source);
  if (!existsSync(path)) throw new ContractError("not_found", `nothing at ${path}`);
  const st = statSync(path);
  const kind: Source = st.isDirectory() ? "folder" : ext(path) === "zip" ? "zip" : "file";
  const active = (d: AvatarFormatDecl) => formats.active.some((a) => a.format === d.format);

  let items: Item[];
  let keep: Item[];
  let entry: string;
  let decl: AvatarFormatDecl;
  if (kind === "file") {
    // One file: the format that imports single files and names this extension (its renderer on, else refused by name).
    const of = (list: readonly AvatarFormatDecl[]) => list.filter((d) => accepts(d, "file")).find((d) => extensionOf(path, fileExtensions(d)) !== undefined);
    const found = of(formats.active) ?? of(formats.known);
    if (found === undefined) throw new ContractError("invalid", whatImports(formats));
    if (!active(found)) throw noRenderer(found);
    decl = found;
    const cap = Math.min(avatarFileKind(decl, path)?.maxBytes ?? AVATAR_IMPORT_CAPS.fileBytes, AVATAR_IMPORT_CAPS.fileBytes);
    if (st.size > cap) throw new ContractError("invalid", `that model is over ${sizeText(cap)}`);
    items = [{ rel: basename(path), size: st.size, read: () => readFileSync(path) }];
    keep = items;
    entry = basename(path);
  } else {
    items = kind === "folder" ? fromFolder(path) : fromZip(path);
    // The shallowest entry file of a format that imports this kind of source (then the first by name) roots the model:
    // everything of its declared kinds under its folder is its own.
    const candidates = (list: readonly AvatarFormatDecl[]) => list.filter((d) => accepts(d, kind));
    const entries = (list: readonly AvatarFormatDecl[]) => items
      .flatMap((i) => {
        const d = candidates(list).find((c) => extensionOf(i.rel, entryExtensions(c)) !== undefined);
        return d === undefined ? [] : [{ item: i, decl: d }];
      })
      .sort((a, b) => a.item.rel.split("/").length - b.item.rel.split("/").length || (a.item.rel < b.item.rel ? -1 : 1));
    const model = entries(formats.active)[0] ?? entries(formats.known)[0];
    if (model === undefined) {
      throw new ContractError("invalid", `nothing in there is a model an installed renderer draws: ${whatImports(formats)}`);
    }
    if (!active(model.decl)) throw noRenderer(model.decl);
    decl = model.decl;
    const slash = model.item.rel.lastIndexOf("/");
    const base = slash < 0 ? "" : model.item.rel.slice(0, slash + 1);
    keep = items.filter((i) => i.rel.startsWith(base) && avatarFileKind(decl, i.rel) !== undefined).map((i) => ({ ...i, rel: i.rel.slice(base.length) }));
    entry = model.item.rel.slice(base.length);
  }
  const credit = creditNote(items);
  const capOf = (rel: string) => Math.min(avatarFileKind(decl, rel)?.maxBytes ?? AVATAR_IMPORT_CAPS.fileBytes, AVATAR_IMPORT_CAPS.fileBytes);
  const installed = installModel(home, bot, keep, entry, decl.format, AVATAR_IMPORT_CAPS, { files: Math.min(decl.files.maxFiles ?? AVATAR_IMPORT_CAPS.files, AVATAR_IMPORT_CAPS.files), capOf });
  return credit === undefined ? installed : { ...installed, credit };
}

/** Checks the declared sizes, then writes the files counting the REAL bytes (an archive's declared sizes can lie),
 *  into a staging folder renamed whole into place. Exported for its tests, which hand it items that lie. */
export function installModel(home: string, bot: string, keep: readonly Item[], entry: string, format: string, caps: Record<keyof typeof AVATAR_IMPORT_CAPS, number> = AVATAR_IMPORT_CAPS, kinds: { files?: number; capOf?(rel: string): number } = {}): ImportedAvatar {
  const most = Math.min(kinds.files ?? caps.files, caps.files);
  const capOf = (rel: string) => Math.min(kinds.capOf?.(rel) ?? caps.fileBytes, caps.fileBytes);
  if (keep.length > most) throw new ContractError("invalid", `that model has ${keep.length} files; the most is ${most}`);
  let total = 0;
  for (const i of keep) {
    if (i.size > capOf(i.rel)) throw new ContractError("invalid", `${i.rel} is over ${sizeText(capOf(i.rel))}`);
    total += i.size;
  }
  if (total > caps.totalBytes) throw new ContractError("invalid", `that model is ${Math.ceil(total / MiB)} MiB; the most is ${caps.totalBytes / MiB} MiB`);

  const dir = userAvatarsDir(home, bot);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // A random tail: two imports in one millisecond never share a folder.
  const folder = `m-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
  const staging = join(dir, `.staging-${folder}`);
  try {
    let bytes = 0;
    for (const i of keep) {
      const target = join(staging, ...i.rel.split("/"));
      mkdirSync(join(target, ".."), { recursive: true });
      const data = i.read();
      bytes += data.length;
      if (data.length > capOf(i.rel)) throw new ContractError("invalid", `${i.rel} is over ${sizeText(capOf(i.rel))}`);
      if (bytes > caps.totalBytes) throw new ContractError("invalid", `that model is over ${caps.totalBytes / MiB} MiB`);
      writeFileSync(target, data, { mode: 0o600 });
    }
    renameSync(staging, join(dir, folder));
    // The earlier models go; another import's staging folder never does (it is its own import's to finish or clean up), and
    // only a staging folder left by an import that died, long untouched, is cleared.
    for (const old of readdirSync(dir)) {
      if (old === folder) continue;
      if (old.startsWith(".staging-")) {
        try {
          if (Date.now() - statSync(join(dir, old)).mtimeMs < STALE_STAGING_MS) continue;
        } catch {
          continue;
        }
      }
      rmSync(join(dir, old), { recursive: true, force: true });
    }
    return { file: `user:${folder}/${entry}`, format, files: keep.length, bytes };
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    throw e;
  }
}

/** The file on disk a `user:` avatar names, or undefined when it names something outside the bot's own folder. */
export function userAvatarFile(home: string, bot: string, rel: string): string | undefined {
  const parts = rel.split("/");
  if (parts.some((p) => p === "" || p === "." || p === ".." || p.includes("\\") || p.startsWith("."))) return undefined;
  const root = userAvatarsDir(home, bot);
  const file = join(root, ...parts);
  return file.startsWith(root + "/") ? file : undefined;
}
