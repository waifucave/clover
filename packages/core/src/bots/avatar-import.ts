// `bot.importAvatar`: copies a model the user owns into the fenced folder `<home>/user-layers/avatars/<bot>/` and
// names it as the bot's avatar (`user:<folder>/<model3.json>`), so no layer is ever handed a raw path. A folder, a zip
// or one `.vrm`/`.glb`. Only the files a model draws from are kept (JSON, `.moc3`, images, the VRM): nothing runs, and a
// zip's folders, PSDs and anything else are left behind. Names may be CJK and a zip's may be GBK or Shift-JIS.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { ContractError } from "../contracts/common";
import { entryData, listEntries } from "../browser/headless/unzip";
import { userAvatarsDir } from "./paths";

const MiB = 1024 * 1024;
export const AVATAR_IMPORT_CAPS = { files: 512, fileBytes: 128 * MiB, totalBytes: 192 * MiB, zipBytes: 512 * MiB } as const;
const MODEL_EXT = new Set(["json", "moc3", "png", "webp", "jpg", "jpeg"]);
const SINGLE_EXT = new Set(["vrm", "glb"]);

export interface ImportedAvatar {
  /** `user:<folder>/<path>`: the bot's avatar `file` in its user layer; the core serves it, never a raw path. */
  file: string;
  format: "live2d" | "vrm";
  files: number;
  bytes: number;
}

interface Item { rel: string; read(): Uint8Array; size: number }

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
    });
  }
  return out;
}

export function importAvatar(home: string, bot: string, source: string): ImportedAvatar {
  const path = resolve(source);
  if (!existsSync(path)) throw new ContractError("not_found", `nothing at ${path}`);
  const st = statSync(path);
  const kind = st.isDirectory() ? "folder" : ext(path);
  let items: Item[];
  let single: { rel: string; format: "vrm" } | undefined;
  if (kind === "folder") items = fromFolder(path);
  else if (kind === "zip") items = fromZip(path);
  else if (SINGLE_EXT.has(kind)) {
    if (st.size > AVATAR_IMPORT_CAPS.fileBytes) throw new ContractError("invalid", `that model is over ${AVATAR_IMPORT_CAPS.fileBytes / MiB} MiB`);
    items = [{ rel: basename(path), size: st.size, read: () => readFileSync(path) }];
    single = { rel: basename(path), format: "vrm" };
  } else throw new ContractError("invalid", "an avatar is a folder or a zip holding a .model3.json, or a .vrm or .glb file");

  let keep: Item[];
  let entry: string;
  let format: "live2d" | "vrm";
  if (single !== undefined) {
    keep = items;
    entry = single.rel;
    format = "vrm";
  } else {
    // the shallowest *.model3.json (then the first by name) roots the model: everything under its folder is its own
    const models = items.filter((i) => i.rel.toLowerCase().endsWith(".model3.json")).sort((a, b) => a.rel.split("/").length - b.rel.split("/").length || (a.rel < b.rel ? -1 : 1));
    const model = models[0];
    if (model === undefined) throw new ContractError("invalid", "no .model3.json in there: a Live2D model has one next to its .moc3");
    const slash = model.rel.lastIndexOf("/");
    const base = slash < 0 ? "" : model.rel.slice(0, slash + 1);
    keep = items.filter((i) => i.rel.startsWith(base) && MODEL_EXT.has(ext(i.rel))).map((i) => ({ ...i, rel: i.rel.slice(base.length) }));
    entry = model.rel.slice(base.length);
    format = "live2d";
  }
  if (keep.length > AVATAR_IMPORT_CAPS.files) throw new ContractError("invalid", `that model has ${keep.length} files; the most is ${AVATAR_IMPORT_CAPS.files}`);
  let total = 0;
  for (const i of keep) {
    if (i.size > AVATAR_IMPORT_CAPS.fileBytes) throw new ContractError("invalid", `${i.rel} is over ${AVATAR_IMPORT_CAPS.fileBytes / MiB} MiB`);
    total += i.size;
  }
  if (total > AVATAR_IMPORT_CAPS.totalBytes) throw new ContractError("invalid", `that model is ${Math.ceil(total / MiB)} MiB; the most is ${AVATAR_IMPORT_CAPS.totalBytes / MiB} MiB`);

  const dir = userAvatarsDir(home, bot);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const folder = `m-${Date.now().toString(36)}`;
  const staging = join(dir, `.staging-${folder}`);
  rmSync(staging, { recursive: true, force: true });
  try {
    let bytes = 0;
    for (const i of keep) {
      const target = join(staging, ...i.rel.split("/"));
      mkdirSync(join(target, ".."), { recursive: true });
      const data = i.read();
      bytes += data.length;
      writeFileSync(target, data, { mode: 0o600 });
    }
    renameSync(staging, join(dir, folder));
    for (const old of readdirSync(dir)) if (old !== folder) rmSync(join(dir, old), { recursive: true, force: true });
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
