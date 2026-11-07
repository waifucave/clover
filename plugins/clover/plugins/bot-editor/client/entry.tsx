// The bot editor on the runtime: the `main` entry keyed `bot-editor`, opened from a bot's tab (its Edit button) or
// Settings' Bots page with `params.bot`. It reads the bot (`bots.read`), the avatars the installed packs offer (the
// `avatar.packs` point it declares), the model catalog and the installed themes, and writes the user layer through
// the core (`bot.setUserLayer`, user-only: the `clover` layer's call is the user's, §5.5). A change that comes back as
// a card waits on it, and the field says so.
import { useEffect, useState } from "react";
import type { AvatarPackEntry, BotView, CoreClient, PointEntry } from "../../shell/runtime/types";
import { plain } from "../../shell/runtime/views";
import { BotEditor } from "./BotEditor";
import { useApprovals, useCore, usePluginApi } from "./sdk";
import type { AvatarChoice, BotEditorModel, BotField, BotPatch } from "./types";

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
    const o = m as { id?: unknown; label?: unknown; name?: unknown; provider?: unknown; efforts?: unknown };
    if (typeof o.id !== "string") return [];
    const label = typeof o.label === "string" ? o.label : typeof o.name === "string" ? o.name : o.id;
    const efforts = Array.isArray(o.efforts) ? o.efforts.filter((x): x is string => typeof x === "string") : [];
    return [{ id: o.id, label, ...(typeof o.provider === "string" ? { detail: o.provider } : {}), ...(efforts.length ? { efforts } : {}) }];
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

export function BotEditorEntry({ props }: { props: BotEditorEntryProps }) {
  const api = usePluginApi();
  const core = useCore();
  const { cards } = useApprovals();
  const id = props.params?.bot;
  const [bot, setBot] = useState<BotView | undefined>(undefined);
  const [avatars, setAvatars] = useState<AvatarChoice[]>([]);
  const [models, setModels] = useState<BotEditorModel[]>([]);
  const [themes, setThemes] = useState<{ id: string; name: string }[]>([]);
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const [waiting, setWaiting] = useState<{ field: BotField; card: string } | undefined>(undefined);

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
    const toChoices = (entries: PointEntry<AvatarPackEntry>[], names: Record<string, string>): AvatarChoice[] =>
      entries.map((e) => ({
        id: `${e.pluginId}#${e.entryId}`,
        name: e.value.name ?? e.entryId,
        pack: names[e.pluginId] ?? e.pluginId,
        file: e.value.file,
        format: e.value.format,
        ...(e.value.portrait ? { portraitUrl: e.value.portrait } : {}),
      }));
    void Promise.all([api.points.entries<AvatarPackEntry>("avatar.packs").catch(() => []), core?.call("plugin.list", {}).catch(() => undefined)]).then(([entries, list]) => {
      if (!live) return;
      const names = Object.fromEntries((list?.plugins ?? []).map((p) => [p.id, plain(p.name)]));
      setAvatars(toChoices(entries, names));
    });
    const stop = api.points.watch<AvatarPackEntry>("avatar.packs", (entries) => setAvatars(toChoices(entries, {})));
    core?.call("models.catalog", {}).then((c) => live && setModels(modelsOf(c)), () => undefined);
    void themesOf(core).then((t) => live && setThemes(t));
    return () => {
      live = false;
      stop();
    };
  }, [api, core]);

  useEffect(() => {
    if (waiting && !cards.some((c) => c.id === waiting.card)) setWaiting(undefined);
  }, [waiting, cards]);

  if (!bot) return <div className="cl-bot-editor cl-bot-editor--loading" role="status" />;

  const change = (patch: BotPatch) => {
    if (!core) return;
    if (patch.avatar !== undefined) setPicked(patch.avatar?.file);
    void core.call("bot.setUserLayer", { id: bot.id, patch }).then((r) => {
      if (!r.applied) setWaiting({ field: Object.keys(patch)[0] as BotField, card: r.card });
    }, () => undefined);
  };

  return (
    <BotEditor
      bot={{ id: bot.id, name: plain(bot.name), ...(bot.portrait ? { portraitUrl: bot.portrait } : {}) }}
      own={bot.userLayer.filter((f): f is BotField => f !== "lan") /* the LAN switch isn't an editor field yet (lane D) */}
      model={{ value: bot.model, ...(bot.effort ? { effort: bot.effort } : {}), models }}
      {...(bot.voice ? { voice: bot.voice } : {})}
      avatars={avatars}
      {...(picked && bot.userLayer.includes("avatar") ? { avatar: picked } : {})}
      themes={themes}
      {...(bot.theme ? { theme: bot.theme } : {})}
      {...(waiting ? { waiting: waiting.field } : {})}
      onChange={change}
      onBack={() => props.navigate?.({ route: "bot", params: { bot: bot.id } })}
    />
  );
}
