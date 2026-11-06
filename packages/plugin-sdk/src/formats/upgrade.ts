// Upgrading a file to the newest version of its format (spec §5.1 "Formats"; `clover plugin validate --upgrade`). A
// format file names its format and version in its first key (`{ "manifest": 1 }`, `{ "theme": 1 }`); the app reads
// every version it has shipped, and this rewrites an older one step by step. Version 1 is the first of each format, so
// there is nothing to rewrite yet: a step is added here, from N to N + 1, when a format's version rises.
import { FORMATS, type FormatName } from "../version";

/** `UPGRADES[format][n]` turns a version-`n` document into version `n + 1`. */
export const UPGRADES: { readonly [F in FormatName]: Readonly<Record<number, (doc: Record<string, unknown>) => Record<string, unknown>>> } = {
  manifest: {}, theme: {}, layout: {}, locale: {}, index: {}, revocations: {},
};

/** The format a parsed JSON document is in, from its version key, or undefined for any other JSON. */
export function formatOf(doc: unknown): { format: FormatName; version: number } | undefined {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return undefined;
  for (const format of Object.keys(FORMATS) as FormatName[]) {
    const v = (doc as Record<string, unknown>)[format];
    if (typeof v === "number" && Number.isInteger(v) && v >= 1) return { format, version: v };
  }
  return undefined;
}

export type UpgradeResult =
  | { status: "current"; format: FormatName; version: number }
  | { status: "upgraded"; format: FormatName; from: number; to: number; doc: Record<string, unknown> }
  /** A newer format than this Clover reads: "needs a newer Clover". */
  | { status: "newer"; format: FormatName; version: number; reads: number }
  /** No step leads on from this version (a version this Clover never shipped). */
  | { status: "unknown"; format: FormatName; version: number };

/** Brings a document to its format's newest version. */
export function upgradeDocument(doc: Record<string, unknown>): UpgradeResult | undefined {
  const f = formatOf(doc);
  if (!f) return undefined;
  const newest = FORMATS[f.format];
  if (f.version > newest) return { status: "newer", format: f.format, version: f.version, reads: newest };
  if (f.version === newest) return { status: "current", format: f.format, version: f.version };
  let out = structuredClone(doc);
  for (let v = f.version; v < newest; v++) {
    const step = UPGRADES[f.format][v];
    if (!step) return { status: "unknown", format: f.format, version: f.version };
    out = { ...step(out), [f.format]: v + 1 };
  }
  return { status: "upgraded", format: f.format, from: f.version, to: newest, doc: out };
}
