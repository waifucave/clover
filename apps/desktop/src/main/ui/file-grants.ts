// What a third-party plugin's page may do with the user's files (the `files` capability's picker calls). The page asks
// main for a native dialog (open, folder, save); the user chooses; the page gets a TOKEN (`grant:<uuid>`), the name and the
// size, never the path. The token is bound to one plugin. Main registers it with the core (`plugin.grant.add`, which refuses
// places no plugin may hold and keeps the record), so the plugin's host half (and its own processes) can use it in
// `files.*`; main keeps its own in-memory copy for one more use: the media route (`/_g/<uuid>` on the plugin's own layer
// origin, `grantResponse`), which serves a file the plugin holds a READ grant for, with HTTP range support, and nothing else.
import { closeSync, constants, createReadStream, fstatSync, openSync, realpathSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { basename, dirname, join } from "node:path";
import { apiCallAllowed } from "@waifucave/clover-plugin-sdk";

export type GrantKind = "file" | "folder";
/** What the core is told: a folder picked for writing carries read too, a save grant also reads its one file (the core adds it). */
export type GrantAccess = "read" | "write";

export interface Grant {
  token: string;
  pluginId: string;
  /** The real path (links followed when it was picked), main's alone: it never reaches a page. */
  path: string;
  kind: GrantKind;
  access: GrantAccess;
  name: string;
  size?: number;
}

/** What a page is handed for one pick. */
export interface GrantView {
  token: string;
  name: string;
  kind: GrantKind;
  access: "read" | "write" | "readwrite";
  size?: number;
}

export const TOKEN_PREFIX = "grant:";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The most grants main holds for one plugin (the oldest goes first); the core keeps its own records. */
export const GRANTS_PER_PLUGIN = 256;

export class FileGrants {
  readonly #held = new Map<string, Grant>();

  constructor(private readonly makeId: () => string = () => crypto.randomUUID()) {}

  /** Records a grant for a plugin and returns it. */
  issue(pluginId: string, input: { path: string; kind: GrantKind; access: GrantAccess; size?: number }): Grant {
    const mine = [...this.#held.values()].filter((g) => g.pluginId === pluginId);
    for (const g of mine.slice(0, Math.max(0, mine.length - GRANTS_PER_PLUGIN + 1))) this.#held.delete(g.token);
    const token = `${TOKEN_PREFIX}${this.makeId()}`;
    const grant: Grant = { token, pluginId, path: input.path, kind: input.kind, access: input.access, name: neutralName(input.path), ...(input.size !== undefined ? { size: input.size } : {}) };
    this.#held.set(token, grant);
    return grant;
  }

  /** A plugin's own grant by its token; another plugin's token is nothing. */
  get(pluginId: string, token: string): Grant | undefined {
    const g = this.#held.get(token);
    return g !== undefined && g.pluginId === pluginId ? g : undefined;
  }

  forget(pluginId: string, token: string): boolean {
    return this.get(pluginId, token) !== undefined && this.#held.delete(token);
  }

  /** The grant a `/_g/<uuid>` request names, for the plugin whose layer it is. */
  byId(pluginId: string, id: string): Grant | undefined {
    return UUID.test(id) ? this.get(pluginId, `${TOKEN_PREFIX}${id}`) : undefined;
  }
}

/** What a page may see of a grant. */
export function viewOf(g: Grant): GrantView {
  const access = g.kind === "folder" ? (g.access === "write" ? "readwrite" : "read") : g.access;
  return { token: g.token, name: g.name, kind: g.kind, access, ...(g.size !== undefined ? { size: g.size } : {}) };
}

/** The last part of a path, as a name a page may show: no control characters, capped. */
function neutralName(path: string): string {
  // eslint-disable-next-line no-control-regex
  return (basename(path.replace(/[\\/]+$/, "")) || "file").replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, "").slice(0, 120) || "file";
}

// ---------------------------------------------------------------------------------------------------------------------
// The calls

export type PickMethod = "files.pickOpen" | "files.pickFolder" | "files.pickSave";
export const PICK_METHODS: ReadonlySet<string> = new Set(["files.pickOpen", "files.pickFolder", "files.pickSave"]);

export interface DialogRequest {
  kind: "open" | "folder" | "save";
  multiple: boolean;
  filters: { name: string; extensions: string[] }[] | undefined;
  suggestedName: string | undefined;
  forWriting: boolean;
}

export interface PickRoute {
  method: string;
  params: unknown;
  plugin: { id: string; capabilities: ReadonlySet<string> | readonly string[] };
  windowId: number;
  /** The user's own key press or click in the calling frame, spent (one pick per gesture). */
  takeGesture(windowId: number): boolean;
  /** Main's native dialog: the chosen paths, none when the user cancels. */
  dialog(windowId: number, request: DialogRequest): Promise<string[]>;
  grants: FileGrants;
  /** Tells the core (`plugin.grant.add`). A refusal throws with the reason the user may be shown; a core without the call
   *  answers `"unserved"`. */
  register(grant: Grant): Promise<"ok" | "unserved">;
  log(line: string): void;
  refuse(why: string): Error;
}

const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** A dialog's filters from what a page named: `{ name, extensions }` with plain extensions only. */
export function cleanFilters(v: unknown): { name: string; extensions: string[] }[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.slice(0, 8).flatMap((f: unknown) => {
    const x = obj(f);
    const ext = Array.isArray(x.extensions) ? x.extensions.filter((e): e is string => typeof e === "string" && /^[A-Za-z0-9]{1,10}$/.test(e)).slice(0, 32) : [];
    return typeof x.name === "string" && x.name.length > 0 && x.name.length <= 64 && ext.length > 0 ? [{ name: x.name, extensions: ext }] : [];
  });
  return out.length > 0 ? out : undefined;
}

/** A suggested file name: a plain name, never a path. */
export function cleanSuggested(v: unknown): string | undefined {
  // eslint-disable-next-line no-control-regex
  return typeof v === "string" && v.length > 0 && v.length <= 120 && !/[\\/\u0000-\u001f]/.test(v) && v !== "." && v !== ".." ? v : undefined;
}

/** `files.pickOpen`, `files.pickFolder`, `files.pickSave`: only for a plugin whose OK includes `files`, only right after the
 *  user's own key press or click in the calling frame, and only through the native dialog. */
export async function routePick(r: PickRoute): Promise<{ grants: GrantView[] } | { cancelled: true }> {
  if (!PICK_METHODS.has(r.method)) throw r.refuse("not a file pick");
  if (!apiCallAllowed(r.method as "files.pickOpen", "ui", [...r.plugin.capabilities])) throw r.refuse(`${r.method} needs the files capability, which this plugin doesn't hold`);
  if (!r.takeGesture(r.windowId)) {
    r.log(`files: ${r.plugin.id}: ${r.method} refused (no key press or click of the user's just before)`);
    throw r.refuse(`${r.method} goes only right after the user's own key press or click`);
  }
  const p = obj(r.params);
  const request: DialogRequest = {
    kind: r.method === "files.pickOpen" ? "open" : r.method === "files.pickFolder" ? "folder" : "save",
    multiple: r.method === "files.pickOpen" && p.multiple === true,
    filters: r.method === "files.pickFolder" ? undefined : cleanFilters(p.filters),
    suggestedName: r.method === "files.pickSave" ? cleanSuggested(p.suggestedName) : undefined,
    forWriting: r.method === "files.pickFolder" && p.forWriting === true,
  };
  const paths = await r.dialog(r.windowId, request);
  if (paths.length === 0) return { cancelled: true };
  const views: GrantView[] = [];
  const issued: Grant[] = [];
  let unserved = false;
  try {
    for (const raw of paths.slice(0, request.multiple ? 64 : 1)) {
      const found = resolvePicked(raw, request);
      const grant = r.grants.issue(r.plugin.id, found);
      issued.push(grant);
      // The core judges the real path: it refuses what no plugin may hold, with a sentence the user may be shown.
      if ((await r.register(grant)) === "unserved") unserved = true;
      views.push(viewOf(grant));
    }
  } catch (err) {
    for (const g of issued) r.grants.forget(r.plugin.id, g.token);
    throw err;
  }
  if (unserved) r.log(`files: ${r.plugin.id}: the core keeps no grants yet; the page's token works for the media URL only`);
  return { grants: views };
}

/** The real path of a picked item and what it is. A save target that doesn't exist yet is its folder's real path and the name. */
export function resolvePicked(path: string, request: Pick<DialogRequest, "kind" | "forWriting">): { path: string; kind: GrantKind; access: GrantAccess; size?: number } {
  if (path.includes("\0")) throw new Error("not a path");
  if (request.kind === "save") {
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      real = join(realpathSync(dirname(path)), basename(path));
    }
    return { path: real, kind: "file", access: "write" };
  }
  const real = realpathSync(path);
  const st = statSync(real);
  if (request.kind === "folder") {
    if (!st.isDirectory()) throw new Error("not a folder");
    return { path: real, kind: "folder", access: request.forWriting ? "write" : "read" };
  }
  if (!st.isFile()) throw new Error("not a file");
  return { path: real, kind: "file", access: "read", size: st.size };
}

// ---------------------------------------------------------------------------------------------------------------------
// The media route

const MEDIA: Readonly<Record<string, string>> = {
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska", ogv: "video/ogg",
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", flac: "audio/flac",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif",
};

/** The type a granted file is served as: a picture, sound or video by its extension, anything else opaque bytes. Never a
 *  document, a script, SVG or wasm; with nosniff the browser takes our word. */
export function grantMediaType(path: string): string {
  return MEDIA[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";
}

/** One `Range` header against a size: the start and end (inclusive), `"whole"` for none, or `"unsatisfiable"`. One range only. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | "whole" | "unsatisfiable" {
  if (header === null || header === "") return "whole";
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (m === null) return "unsatisfiable";
  const [, a, b] = m as unknown as [string, string, string];
  if (a === "" && b === "") return "unsatisfiable";
  if (size === 0) return "unsatisfiable";
  if (a === "") {
    const n = Number(b);
    if (!Number.isSafeInteger(n) || n <= 0) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  const end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return "unsatisfiable";
  return { start, end };
}

/** What `/_g/<id>` answers for the plugin whose layer asked: its own READ grant on a file, with range support, or a refusal.
 *  Another plugin's token, a folder, a save-only grant, a file that is no longer the one picked (a link swapped in, a
 *  non-regular file) are all refused; there is no listing. */
export function grantResponse(grants: FileGrants, pluginId: string, id: string, rangeHeader: string | null, headers: Record<string, string>): Response {
  const grant = grants.byId(pluginId, id);
  if (grant === undefined || grant.kind !== "file") return new Response("forbidden", { status: 403, headers });
  // A save grant also reads its one file (the core's rule), so the plugin can play what it exported.
  let fd: number | undefined;
  try {
    if (realpathSync(grant.path) !== grant.path) return new Response("forbidden", { status: 403, headers });
    fd = openSync(grant.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error("not a regular file");
    const base = { ...headers, "Content-Type": grantMediaType(grant.path), "Accept-Ranges": "bytes", "Content-Security-Policy": "default-src 'none'; sandbox" };
    const range = parseRange(rangeHeader, st.size);
    if (range === "unsatisfiable") {
      closeSync(fd);
      return new Response("range not satisfiable", { status: 416, headers: { ...headers, "Content-Range": `bytes */${st.size}` } });
    }
    if (st.size === 0) {
      closeSync(fd);
      return new Response(new Uint8Array(0), { headers: { ...base, "Content-Length": "0" } });
    }
    const [start, end, status] = range === "whole" ? [0, st.size - 1, 200] : [range.start, range.end, 206];
    const stream = createReadStream(grant.path, { fd, start, end, autoClose: true });
    fd = undefined;
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
      status,
      headers: { ...base, "Content-Length": String(end - start + 1), ...(status === 206 ? { "Content-Range": `bytes ${start}-${end}/${st.size}` } : {}) },
    });
  } catch {
    if (fd !== undefined) closeSync(fd);
    return new Response("not found", { status: 404, headers });
  }
}
