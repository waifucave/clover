// Files that come with a point's entries (a general piece of §5.4's points): a point's declaration may say, per `path`
// field of its entries, which kinds of inert data file sit beside the file the field names (`files`). The app then serves
// those files, the entry's file's folder and below, to every layer, as the kind's one fixed media type: a 3D model's
// binaries, a word list's JSON, a sound bank's audio. Nothing in a kind runs: no document, script, style, SVG, HTML or
// wasm is ever served this way, whatever extension a declaration gives it.

/** The kinds of data file. A closed set: each is served as one fixed, inert media type (nosniff, never a document, a
 *  script, a style, SVG, HTML or wasm). */
export const DATA_FILE_TYPES = ["json", "binary", "image", "audio", "text"] as const;
export type DataFileType = (typeof DATA_FILE_TYPES)[number];

/** The media type each kind is served with (an `image` is served as its raster type, by its extension). */
export const DATA_FILE_MEDIA: Readonly<Record<DataFileType, string>> = {
  json: "application/json",
  binary: "application/octet-stream",
  image: "image/png",
  audio: "audio/mpeg",
  text: "text/plain",
};

const MiB = 1024 * 1024;
/** The most a declaration may ask for, per kind of file, in bytes: a declared `maxBytes` above it is refused at install,
 *  and whoever serves a file clamps to it again. */
export const DATA_FILE_CAPS: Readonly<Record<DataFileType, number>> = {
  json: 8 * MiB,
  binary: 128 * MiB,
  image: 128 * MiB,
  audio: 16 * MiB,
  text: 1 * MiB,
};

/** One kind of file a declaration lets an entry's path field bring: its extensions (lower case, with the dot), its type
 *  and a cap. */
export interface DataFileKind {
  readonly ext: readonly string[];
  readonly type: DataFileType;
  readonly maxBytes?: number;
}

/** The clamped cap for a kind of file: the declared one, never above the kind's hard limit. */
export function clampDataFileCap(type: DataFileType, declared: number | undefined): number {
  const hard = DATA_FILE_CAPS[type];
  return declared === undefined || !Number.isFinite(declared) || declared < 1 ? hard : Math.min(Math.floor(declared), hard);
}

/** The longest of `extensions` (lower case, with the dot) that `name` ends with, case-blind; undefined when none. */
export function extensionOf(name: string, extensions: readonly string[]): string | undefined {
  const n = name.toLowerCase();
  return [...extensions].sort((a, b) => b.length - a.length).find((e) => n.endsWith(e));
}

/** The kind a file is, by its extension (the longest match wins), and its clamped cap; undefined for a file of no
 *  declared kind, which is never served. */
export function dataFileKind(kinds: readonly DataFileKind[], name: string): { type: DataFileType; maxBytes: number } | undefined {
  let best: { ext: string; type: DataFileType; maxBytes?: number | undefined } | undefined;
  for (const k of kinds) {
    const ext = extensionOf(name, k.ext);
    if (ext !== undefined && (best === undefined || ext.length > best.ext.length)) best = { ext, type: k.type, maxBytes: k.maxBytes };
  }
  return best === undefined ? undefined : { type: best.type, maxBytes: clampDataFileCap(best.type, best.maxBytes) };
}

/** "a, b or c". */
export function orList(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}
