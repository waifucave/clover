// Which entries show in a UI spot (spec §5.5), as a pure function: the app's plugin runtime decides this (lane E), and
// this stand-in decides it the same way for the gallery and the tests until E-M1 lands.
//
// - A list spot shows every entry that applies, by `order` (default 500) then plugin id, unless the user reordered or
//   hid some (`UiSettings.lists`).
// - A single spot or a keyed cell shows one: of the entries for that key (exact keys first, then `*` patterns, then
//   entries with no key, which fill every key that has none of its own), the one the rules below pick. A `hide` entry
//   that wins shows nothing; a key the spot `keep`s can't be hidden.
// - `when` decides whether an entry applies: `bot` against the tab's bot, `session` against the session's kind, `os`,
//   `surface`.
//
// Which entry wins (§5.5): 1. the user's pick, for this bot first, then globally; 4. the most specific `when.bot`
// (one bot, then some, then all; a bot's own plugin's entries count as limited to that bot); 5. one the user
// installed over a bundled one; 6. the most recently enabled, which marks the spot as a conflict for Settings' badge.
// Steps 2 (the smaller part) and 3 (the bot layout's preference) need the part tree and layouts, which only the real
// runtime knows; they are lane E's.
import type { SessionKind, UiSettings } from "./types";

export type SpotShape = "single" | "list" | "keyed";

export interface SpotDecl {
  shape: SpotShape;
  /** Keys that can't be hidden (`conversation.message`'s `approval`). */
  keep?: readonly string[];
}

/** A `ui` entry as the runtime holds it: the manifest's fields, plus where it came from. */
export interface UiEntry {
  pluginId: string;
  /** The entry's `id`, which defaults to its spot. */
  id: string;
  spot: string;
  key?: string;
  order?: number;
  when?: { bot?: string | string[]; session?: SessionKind | SessionKind[]; os?: string[]; surface?: string | string[] };
  hide?: boolean;
  component?: string;
  /** The spot's own fields: a title, an icon, what an app button opens. */
  fields?: Record<string, unknown>;
  /** Shipped with Clover, or installed by the user. */
  source: "bundled" | "installed";
  /** When its plugin was last switched on, for step 6. */
  enabledAt: number;
  /** The bot whose plugin this entry comes from, if any: its entries count as limited to that bot. */
  botPlugin?: string;
}

export interface SpotContext {
  bot?: string;
  sessionKind?: SessionKind;
  os?: string;
  surface?: string;
}

export interface Resolved {
  entries: UiEntry[];
  /** Step 6 decided: Settings shows a conflict badge with a picker. */
  conflict: boolean;
}

export const entryRef = (e: Pick<UiEntry, "pluginId" | "id">) => `${e.pluginId}#${e.id}`;

const asList = <T>(v: T | readonly T[] | undefined): readonly T[] | undefined => (v === undefined ? undefined : Array.isArray(v) ? v : [v as T]);

/** Whether an entry's `when` holds in this context. A condition the context can't answer doesn't hold. */
export function applies(entry: UiEntry, ctx: SpotContext): boolean {
  const bots = asList(entry.when?.bot) ?? (entry.botPlugin ? [entry.botPlugin] : undefined);
  if (bots && (ctx.bot === undefined || !bots.includes(ctx.bot))) return false;
  const sessions = asList(entry.when?.session);
  if (sessions && (ctx.sessionKind === undefined || !sessions.includes(ctx.sessionKind))) return false;
  if (entry.when?.os && (ctx.os === undefined || !entry.when.os.includes(ctx.os))) return false;
  const surfaces = asList(entry.when?.surface);
  if (surfaces && (ctx.surface === undefined || !surfaces.includes(ctx.surface))) return false;
  return true;
}

/** How well an entry's key covers a key: 3 exact, 2 a `*` pattern, 1 no key (the default filler), 0 not at all. */
export function keyFit(entryKey: string | undefined, key: string): number {
  if (entryKey === undefined) return 1;
  if (entryKey.endsWith("*")) return key.startsWith(entryKey.slice(0, -1)) ? 2 : 0;
  return entryKey === key ? 3 : 0;
}

/** Step 4: one bot (3), some bots (2), all (1). */
function botSpecificity(e: UiEntry): number {
  const bots = asList(e.when?.bot) ?? (e.botPlugin ? [e.botPlugin] : undefined);
  if (!bots) return 1;
  return bots.length === 1 ? 3 : 2;
}

export function resolveSpot(
  spot: string,
  decl: SpotDecl,
  all: readonly UiEntry[],
  ctx: SpotContext,
  key?: string,
  settings?: Pick<UiSettings, "picks" | "lists">,
): Resolved {
  const here = all.filter((e) => e.spot === spot && applies(e, ctx));

  if (decl.shape === "list") {
    const list = settings?.lists.find((l) => l.spot === spot && l.bot === ctx.bot) ?? settings?.lists.find((l) => l.spot === spot && l.bot === undefined);
    const hidden = new Set(list?.hidden ?? []);
    const shown = here.filter((e) => !e.hide && !hidden.has(entryRef(e)));
    const placed = new Map((list?.order ?? []).map((ref, i) => [ref, i] as const));
    shown.sort((a, b) => {
      const pa = placed.get(entryRef(a));
      const pb = placed.get(entryRef(b));
      if (pa !== undefined || pb !== undefined) return (pa ?? Number.MAX_SAFE_INTEGER) - (pb ?? Number.MAX_SAFE_INTEGER);
      return (a.order ?? 500) - (b.order ?? 500) || a.pluginId.localeCompare(b.pluginId) || a.id.localeCompare(b.id);
    });
    return { entries: shown, conflict: false };
  }

  const kept = key !== undefined && (decl.keep ?? []).includes(key);
  let candidates = here.filter((e) => !(kept && e.hide));
  if (decl.shape === "keyed") {
    if (key === undefined) return { entries: [], conflict: false };
    const best = Math.max(0, ...candidates.map((e) => keyFit(e.key, key)));
    candidates = best === 0 ? [] : candidates.filter((e) => keyFit(e.key, key) === best);
  }
  if (candidates.length === 0) return { entries: [], conflict: false };

  // 1. The user's pick, for this bot first, then globally. A pick of nothing hides the part (not where it's kept).
  const pickFor = (bot: string | undefined) => settings?.picks.find((p) => p.spot === spot && (p.key ?? undefined) === key && p.bot === bot);
  const pick = (ctx.bot !== undefined ? pickFor(ctx.bot) : undefined) ?? pickFor(undefined);
  if (pick) {
    if (pick.entry === null && !kept) return { entries: [], conflict: false };
    const picked = candidates.find((e) => entryRef(e) === pick.entry);
    if (picked) return { entries: picked.hide ? [] : [picked], conflict: false };
  }

  // 4, 5 and 6.
  const ranked = [...candidates].sort(
    (a, b) =>
      botSpecificity(b) - botSpecificity(a) ||
      Number(b.source === "installed") - Number(a.source === "installed") ||
      b.enabledAt - a.enabledAt,
  );
  const [first, second] = ranked;
  const conflict = second !== undefined && botSpecificity(first!) === botSpecificity(second) && first!.source === second.source;
  return { entries: first!.hide ? [] : [first!], conflict };
}
