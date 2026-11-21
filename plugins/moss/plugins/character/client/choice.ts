// Which figure shows: the avatar plugin's own one-at-a-time rule (spec revision 19, G7: the platform has no figure slot;
// this plugin keeps one figure at a time). The person's pick is the plugin's own setting `figure`:
//   * `pack:<plugin>#<entry>`: an entry of `moss.character.packs`;
//   * `url:<file>`: a pack's figure as an earlier MOSS kept it (its file's URL), matched to the pack entry with that file;
//   * `own:<format>:<path>`: one of the person's own models this plugin keeps in its data folder (moved there from an
//     earlier MOSS), served to this plugin's own layer at `/_d/moss%2Fcharacter/<path>`.
// With none picked (or the pick gone), the first pack whose format a renderer draws stands in.
import type { PointEntry } from "@waifucave/moss-plugin-sdk";
import { usePluginApi } from "@waifucave/moss-plugin-sdk/ui";
import { useEffect, useState } from "react";
import { cleanFigureCapabilities, type FigureCapability } from "./figure-cues";

export const RENDERER_SPOT = "moss.character.renderer";
export const FORMATS_POINT = "moss.character.formats";
export const PACKS_POINT = "moss.character.packs";
export const FIGURE_POINT = "moss.character.figure";

/** A renderer's declaration of its format (`moss.character.formats`), with the plugin that draws it. */
export interface FormatDecl { format: string; name: string; renderer: string; capabilities: FigureCapability[] }

/** A figure the person may pick. */
export interface FigureChoice {
  /** The setting's value that picks it. */
  id: string;
  name: string;
  /** Where its model's entry file is served from. */
  src: string;
  format: string;
  portrait?: string;
  /** The plugin it comes from (a pack), or "own". */
  from: string;
  license?: string;
}

/** One of the person's own models, as the `ownModels` setting lists them. */
export interface OwnModel { name: string; format: string; file: string; credit?: string }

const text = (v: unknown, lang = "en"): string | undefined => {
  if (typeof v === "string") return v;
  if (typeof v === "object" && v !== null && typeof (v as { en?: unknown }).en === "string") return ((v as Record<string, string>)[lang] ?? (v as { en: string }).en);
  return undefined;
};

/** The person's own models as the setting holds them (a JSON list); anything else reads as none. */
export function ownModelsOf(raw: unknown): OwnModel[] {
  if (typeof raw !== "string" || raw === "") return [];
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out: OwnModel[] = [];
  for (const m of list.slice(0, 64)) {
    const o = m as Record<string, unknown> | null;
    if (o === null || typeof o !== "object" || typeof o.file !== "string" || typeof o.format !== "string" || !/^[a-z0-9-]{1,32}$/.test(o.format)) continue;
    if (o.file === "" || o.file.split("/").some((s) => s === "" || s === "." || s === ".." || s.startsWith("."))) continue;
    out.push({ name: typeof o.name === "string" && o.name !== "" ? o.name.slice(0, 80) : o.file.split("/").pop()!, format: o.format, file: o.file, ...(typeof o.credit === "string" && o.credit !== "" ? { credit: o.credit.slice(0, 300) } : {}) });
  }
  return out;
}

/** Where a file this plugin shares with its own pages (its data folder's `shared/`) is served to its own layer. */
export const ownUrl = (path: string): string => `/_d/${encodeURIComponent("moss/character")}/${path.split("/").map(encodeURIComponent).join("/")}`;

/** Every figure the person may pick: each pack entry, then each own model. */
export function choicesOf(packs: readonly PointEntry[], own: readonly OwnModel[]): FigureChoice[] {
  const out: FigureChoice[] = [];
  for (const e of packs) {
    const v = e.value as Record<string, unknown>;
    if (typeof v.file !== "string" || v.file === "" || typeof v.format !== "string") continue;
    out.push({
      id: `pack:${e.pluginId}#${e.entryId}`, name: text(v.name) ?? e.entryId, src: v.file, format: v.format, from: e.pluginId,
      ...(typeof v.portrait === "string" && v.portrait !== "" ? { portrait: v.portrait } : {}),
      ...(typeof v.license === "string" && v.license !== "" ? { license: v.license } : {}),
    });
  }
  for (const m of own) out.push({ id: `own:${m.format}:${m.file}`, name: m.name, src: ownUrl(m.file), format: m.format, from: "own", ...(m.credit !== undefined ? { license: m.credit } : {}) });
  return out;
}

/** The figure that shows: the person's pick when it is there and a renderer draws its format, else the first that one
 *  draws. */
export function chosen(pick: string, choices: readonly FigureChoice[], formats: readonly FormatDecl[]): FigureChoice | undefined {
  const drawn = (c: FigureChoice) => formats.some((f) => f.format === c.format);
  const byPick = pick.startsWith("url:") ? choices.find((c) => c.src === pick.slice(4) || c.src.endsWith(pick.slice(4))) : choices.find((c) => c.id === pick);
  if (byPick !== undefined && drawn(byPick)) return byPick;
  return choices.find(drawn);
}

export function formatsOf(entries: readonly PointEntry[]): FormatDecl[] {
  const out: FormatDecl[] = [];
  for (const e of entries) {
    const v = e.value as Record<string, unknown>;
    if (typeof v.format !== "string" || out.some((f) => f.format === v.format)) continue;
    out.push({ format: v.format, name: text(v.name) ?? v.format, renderer: e.pluginId, capabilities: cleanFigureCapabilities(v.capabilities) });
  }
  return out;
}

/** A point this plugin declares, read and followed. */
export function usePoint(point: string): PointEntry[] | undefined {
  const api = usePluginApi();
  const [entries, setEntries] = useState<PointEntry[] | undefined>(undefined);
  useEffect(() => {
    let live = true;
    // Subscribe first, then read: a change between the read's answer and a later subscription taking effect would be lost for good.
    const stop = api.points.watch(point, (e) => live && setEntries(e));
    void api.points.entries(point).then((e) => live && setEntries(e), () => live && setEntries([]));
    return () => { live = false; stop(); };
  }, [api, point]);
  return entries;
}

/** One of this plugin's own settings, read and followed. */
export function useSetting<T>(key: string): T | undefined {
  const api = usePluginApi();
  const [value, setValue] = useState<T | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const read = () => void api.settings.get<T>(key).then((v) => live && setValue(v), () => undefined);
    // The watch says which key changed; the value is read again. Subscribe first, then read: a change between the first
    // read's answer and the subscription taking effect would be lost for good (the figure stayed on its old pick).
    const stop = api.settings.watch(key, read);
    read();
    return () => { live = false; stop(); };
  }, [api, key]);
  return value;
}

/** What the figure is now: the choices, the renderers' formats, and the one that shows. */
export function useFigure(): { choices: FigureChoice[]; formats: FormatDecl[]; shown: FigureChoice | undefined; pick: string; ready: boolean } {
  const packs = usePoint(PACKS_POINT);
  const formatEntries = usePoint(FORMATS_POINT);
  const pick = useSetting<string>("figure") ?? "";
  const own = ownModelsOf(useSetting<string>("ownModels"));
  const formats = formatsOf(formatEntries ?? []);
  const choices = choicesOf(packs ?? [], own);
  return { choices, formats, shown: chosen(pick, choices, formats), pick, ready: packs !== undefined && formatEntries !== undefined };
}
