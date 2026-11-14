// The bot editor on the runtime: the `main` entry keyed `bot-editor`, opened from a bot's tab (its Edit button) or
// Settings' Bots page with `params.bot`. It reads the bot (`bots.read`), the model catalog and the installed themes,
// draws the sections other plugins add (`bot.editor.section`: the avatar's is the character plugin's), and writes the user layer through
// the core (`bot.setUserLayer`, user-only: the `clover` layer's call is the user's, §5.5). A change that comes back as
// a card waits on it, and the field says so.
import { useEffect, useState } from "react";
import type { BotView, CoreClient } from "../../shell/runtime/types";
import { plain } from "../../shell/runtime/views";
import { BotEditor } from "./BotEditor";
import { Spot, useApprovals, useCore, usePluginApi } from "./sdk";
import { S } from "./strings";
import { SettingsSection } from "./SettingsSection";
import type { BotEditorModel, BotField, BotPatch, HiddenPartChoice, StockSetting, TabPatchChoice } from "./types";

export interface BotEditorEntryProps {
  route?: string;
  params?: { bot?: string };
  navigate?: (route: { route: string; params: Record<string, string> }) => void;
}

/** The catalog's models, read defensively (its Clover shape is lanes A's and B's). */
export function modelsOf(catalog: unknown): BotEditorModel[] {
  const list = (catalog as { models?: unknown[] } | undefined)?.models;
  if (!Array.isArray(list)) return [];
  return list.flatMap((m) => {
    const o = m as { id?: unknown; label?: unknown; name?: unknown; provider?: unknown; providerName?: unknown; efforts?: unknown };
    if (typeof o.id !== "string") return [];
    const label = typeof o.label === "string" ? o.label : typeof o.name === "string" ? o.name : o.id;
    const efforts = Array.isArray(o.efforts) ? o.efforts.filter((x): x is string => typeof x === "string") : [];
    return [{ id: o.id, label, ...(typeof o.providerName === "string" ? { detail: o.providerName } : typeof o.provider === "string" ? { detail: o.provider } : {}), ...(efforts.length ? { efforts } : {}) }];
  });
}

/** The base theme reads as the plain one (spec, open question 14: "theme including a plain one"). */
const PLAIN_THEME_PLUGIN = "clover/base-theme";

async function themesOf(core: CoreClient | undefined): Promise<{ id: string; name: string }[]> {
  if (!core) return [];
  const [ui, list] = await Promise.all([core.call("plugin.ui", {}).catch(() => undefined), core.call("plugin.list", {}).catch(() => undefined)]);
  const name = (id: string) => (id === PLAIN_THEME_PLUGIN ? "Plain" : plain(list?.plugins.find((p) => p.id === id)?.name) || id);
  return (ui?.plugins ?? []).flatMap((p) => p.themes.map((t) => ({ id: `${p.pluginId}#${t.id}`, name: p.themes.length > 1 ? `${name(p.pluginId)}: ${t.id}` : name(p.pluginId) })));
}

/** The plugins whose layout patches rearrange a bot's tab (a `ui` entry on `bot.tab` with `layout`, for that bot or
 *  every bot the plugin dresses), in turn order, each on unless the user switched it off for this bot (`lists` on
 *  `bot.tab`). The app draws the tab from the same rule (layout.ts); this is only the list the user switches. */
export async function tabPatchesOf(core: CoreClient | undefined, bot: string): Promise<TabPatchChoice[]> {
  if (!core) return [];
  const [ui, list, settings] = await Promise.all([
    core.call("plugin.ui", {}).catch(() => undefined),
    core.call("plugin.list", {}).catch(() => undefined),
    core.call("ui.settings", {}).catch(() => undefined),
  ]);
  const off = ((settings as { lists?: { spot: string; bot?: string; hidden: string[] }[] } | undefined)?.lists ?? []).filter((l) => l.spot === "bot.tab" && (l.bot === undefined || l.bot === bot)).flatMap((l) => l.hidden);
  const name = (id: string) => plain(list?.plugins.find((p) => p.id === id)?.name) || id;
  const out: (TabPatchChoice & { order: number; pluginId: string; entry: string })[] = [];
  for (const p of ui?.plugins ?? []) {
    for (const e of p.ui as Record<string, unknown>[]) {
      if (e.spot !== "bot.tab" || typeof e.layout !== "string") continue;
      const when = (e.when as { bot?: string | string[] } | undefined)?.bot;
      const scope = p.bot !== undefined ? [p.pluginId] : p.bots !== "all" ? p.bots : when === undefined ? "all" : typeof when === "string" ? [when] : when;
      if (scope !== "all" && !scope.includes(bot)) continue;
      const entry = typeof e.id === "string" ? e.id : "bot.tab";
      const ref = `${p.pluginId}#${entry}`;
      out.push({ ref, name: name(p.pluginId), on: !off.some((r) => r === ref || r === p.pluginId), order: typeof e.order === "number" ? e.order : 500, pluginId: p.pluginId, entry });
    }
  }
  out.sort((a, b) => a.order - b.order || (a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0) || (a.entry < b.entry ? -1 : 1));
  return out.map(({ ref, name: n, on }) => ({ ref, name: n, on }));
}

/** The parts plugins' `hide` entries take out of a bot's tab (a hide for that bot, or every bot its plugin dresses; a
 *  list spot's only with its `target`), each with what it is called, the hiding plugin's name, and whether the user
 *  switched that hide off for this bot (`shown` naming it). The app resolves the tab from the same entries (spots.ts). */
export async function hiddenPartsOf(core: CoreClient | undefined, bot: string): Promise<{ parts: HiddenPartChoice[]; lists: { spot: string; bot?: string; order: string[]; hidden: string[]; shown?: string[] }[] }> {
  if (!core) return { parts: [], lists: [] };
  const [ui, list, settings] = await Promise.all([
    core.call("plugin.ui", {}).catch(() => undefined),
    core.call("plugin.list", {}).catch(() => undefined),
    core.call("ui.settings", {}).catch(() => undefined),
  ]);
  const lists = ((settings as { lists?: { spot: string; bot?: string; order: string[]; hidden: string[]; shown?: string[] }[] } | undefined)?.lists ?? []);
  const name = (id: string) => plain(list?.plugins.find((p) => p.id === id)?.name) || id;
  const views = ui?.plugins ?? [];
  // A target's own title, when its plugin's entry has one.
  const titleOf = (target: string): string | undefined => {
    const [pid, eid] = target.split("#");
    const e = (views.find((p) => p.pluginId === pid)?.ui as Record<string, unknown>[] | undefined)?.find((x) => (typeof x.id === "string" ? x.id : x.spot) === eid);
    return e === undefined ? undefined : plain(e.title as never) || undefined;
  };
  const out: HiddenPartChoice[] = [];
  for (const p of views) {
    for (const e of p.ui as Record<string, unknown>[]) {
      if (e.hide !== true || typeof e.spot !== "string") continue;
      const when = (e.when as { bot?: string | string[] } | undefined)?.bot;
      const scope = p.bot !== undefined ? [p.pluginId] : p.bots !== "all" ? p.bots : when === undefined ? "all" : typeof when === "string" ? [when] : when;
      if (scope !== "all" && !scope.includes(bot)) continue;
      const target = typeof e.target === "string" ? e.target : undefined;
      const key = typeof e.key === "string" ? e.key : undefined;
      const ref = `${p.pluginId}#${typeof e.id === "string" ? e.id : e.spot}`;
      const mine = lists.find((l) => l.spot === e.spot && l.bot === bot) ?? lists.find((l) => l.spot === e.spot && l.bot === undefined);
      out.push({
        ref,
        spot: e.spot,
        title: target !== undefined ? (titleOf(target) ?? target) : S.partOf(e.spot, key),
        by: name(p.pluginId),
        shown: mine?.shown?.includes(ref) === true,
      });
    }
  }
  return { parts: out, lists };
}

/** The bot's plugin's settings as `plugin.settings.get` gives them, for the stock section: every kind but a secret. */
export function stockSettingsOf(rows: readonly { key: string; type: string; title: unknown; description?: unknown; scope?: string; options?: (string | { value: string; title: unknown })[]; min?: number; max?: number; value?: unknown }[]): StockSetting[] {
  return rows.flatMap((r): StockSetting[] => {
    const title = plain(r.title as never) || r.key;
    const description = plain(r.description as never);
    const base = { key: r.key, title, ...(description ? { description } : {}), perBot: r.scope === "bot", ...(r.value !== undefined ? { value: r.value } : {}) };
    if (r.type === "string" || r.type === "color") return [{ ...base, type: r.type }];
    if (r.type === "boolean") return [{ ...base, type: "boolean" }];
    if (r.type === "number") return [{ ...base, type: "number", ...(r.min !== undefined ? { min: r.min } : {}), ...(r.max !== undefined ? { max: r.max } : {}) }];
    if (r.type === "enum") return [{ ...base, type: "enum", options: (r.options ?? []).map((o) => (typeof o === "string" ? { value: o, title: o } : { value: o.value, title: plain(o.title as never) || o.value })) }];
    return [];
  });
}

export function BotEditorEntry({ props }: { props: BotEditorEntryProps }) {
  const api = usePluginApi();
  const core = useCore();
  const { cards } = useApprovals();
  const id = props.params?.bot;
  const [bot, setBot] = useState<BotView | undefined>(undefined);
  const [models, setModels] = useState<BotEditorModel[]>([]);
  const [themes, setThemes] = useState<{ id: string; name: string }[]>([]);
  const [waiting, setWaiting] = useState<{ field: BotField; card: string } | undefined>(undefined);
  const [tabPatches, setTabPatches] = useState<TabPatchChoice[]>([]);
  const [stock, setStock] = useState<StockSetting[]>([]);
  const [stockNote, setStockNote] = useState<string | undefined>(undefined);
  const [stockRev, setStockRev] = useState(0);
  const [hidden, setHidden] = useState<{ parts: HiddenPartChoice[]; lists: { spot: string; bot?: string; order: string[]; hidden: string[]; shown?: string[] }[] }>({ parts: [], lists: [] });

  useEffect(() => {
    if (!id) return;
    let live = true;
    api.bots?.get(id).then((b) => live && setBot(b), () => undefined);
    const stop = api.bots?.watch((b) => b.id === id && setBot(b));
    return () => {
      live = false;
      stop?.();
    };
  }, [api, id]);

  useEffect(() => {
    let live = true;
    core?.call("models.list", {}).then((c) => live && setModels(modelsOf(c)), () => undefined);
    void themesOf(core).then((t) => live && setThemes(t));
    return () => {
      live = false;
    };
  }, [core]);

  // The bot's plugin's settings (the bot's id is its plugin's): read again after each save.
  useEffect(() => {
    if (!id || !core) return;
    let live = true;
    void core.call("plugin.settings.get", { id, bot: id }).then((r) => live && setStock(stockSettingsOf(r.settings as never)), () => live && setStock([]));
    return () => {
      live = false;
    };
  }, [core, id, stockRev]);

  useEffect(() => {
    if (waiting && !cards.some((c) => c.id === waiting.card)) setWaiting(undefined);
  }, [waiting, cards]);

  useEffect(() => {
    if (!id) return;
    let live = true;
    void tabPatchesOf(core, id).then((t) => live && setTabPatches(t));
    void hiddenPartsOf(core, id).then((h) => live && setHidden(h));
    return () => {
      live = false;
    };
  }, [core, id]);

  if (!bot) return <div className="cl-bot-editor cl-bot-editor--loading" role="status" />;

  const change = (patch: BotPatch) => {
    if (!core) return;
    void core.call("bot.setUserLayer", { id: bot.id, patch }).then((r) => {
      if (!r.applied) setWaiting({ field: Object.keys(patch)[0] as BotField, card: r.card });
    }, () => undefined);
  };

  return (
    <BotEditor
      bot={{ id: bot.id, name: plain(bot.name), ...(bot.portrait ? { portraitUrl: bot.portrait } : {}) }}
      own={bot.userLayer.filter((f): f is BotField => f !== "avatar")}
      model={{ value: bot.model, ...(bot.effort ? { effort: bot.effort } : {}), models }}
      {...(bot.voice ? { voice: bot.voice } : {})}
      sections={
        <>
          <SettingsSection
            bot={{ id: bot.id, name: plain(bot.name) }}
            settings={stock}
            {...(stockNote ? { note: stockNote } : {})}
            onSet={(key, value) => {
              if (!core) return;
              setStockNote(undefined);
              const perBot = stock.find((s) => s.key === key)?.perBot === true;
              void core.call("plugin.settings.set", { id: bot.id, key, value, ...(perBot ? { bot: bot.id } : {}), noSecret: true }).then(
                (r) => {
                  if ((r as { applied?: boolean }).applied === false) setStockNote(S.waiting);
                  setStockRev((n) => n + 1);
                },
                () => setStockRev((n) => n + 1),
              );
            }}
          />
          <Spot name="bot.editor.section" props={{ bot: { id: bot.id, name: bot.name } }} />
        </>
      }
      themes={themes}
      {...(bot.theme ? { theme: bot.theme } : {})}
      lan={bot.lan === true}
      {...(waiting ? { waiting: waiting.field } : {})}
      tabPatches={tabPatches}
      hiddenParts={hidden.parts}
      onHiddenPart={(part, shown) => {
        if (!core) return;
        // This bot's list for that spot: its `shown` with the hide switched off (or on again); main keeps the rest.
        const was = hidden.lists.find((l) => l.spot === part.spot && l.bot === bot.id)?.shown ?? [];
        const next = shown ? [...new Set([...was, part.ref])] : was.filter((r) => r !== part.ref);
        void core.call("ui.set", { patch: { lists: [{ spot: part.spot, bot: bot.id, order: [], hidden: [], shown: next }] } }).then(
          () => setHidden((h) => ({
            parts: h.parts.map((x) => (x.ref === part.ref ? { ...x, shown } : x)),
            lists: [...h.lists.filter((l) => !(l.spot === part.spot && l.bot === bot.id)), { spot: part.spot, bot: bot.id, order: [], hidden: [], shown: next }],
          })),
          () => undefined,
        );
      }}
      onTabPatch={(ref, on) => {
        if (!core) return;
        // One bot's switched-off patches, whole: main merges them into the stored lists (tree-calls `tabPatchParams`).
        const next = tabPatches.map((t) => (t.ref === ref ? { ...t, on } : t));
        void core.call("ui.set", { patch: { lists: [{ spot: "bot.tab", bot: bot.id, order: [], hidden: next.filter((t) => !t.on).map((t) => t.ref) }] } }).then(
          () => setTabPatches(next),
          () => undefined,
        );
      }}
      onChange={change}
      onBack={() => props.navigate?.({ route: "bot", params: { bot: bot.id } })}
    />
  );
}
