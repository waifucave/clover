// The bot editor on the runtime: the `main` entry keyed `bot-editor`, opened from a bot's tab (its Edit button) or
// Settings' Bots page with `params.bot`. It reads the bot (`bots.read`), the avatars the installed packs offer (the
// `avatar.packs` point it declares), the model catalog and the installed themes, and writes the user layer through
// the core (`bot.setUserLayer`, user-only: the `clover` layer's call is the user's, §5.5). A change that comes back as
// a card waits on it, and the field says so.
import { useEffect, useState } from "react";
import { displayText } from "@waifucave/clover-plugin-sdk/plain";
import type { AvatarPackEntry, BotView, CoreClient, PointEntry } from "../../shell/runtime/types";

/** What the editor reads of an `avatar.formats` entry (a renderer's declaration of the format it draws). */
interface AvatarFormatView {
  format: string;
  name: string | { en: string; [lang: string]: string };
  entry: { extensions: string[] };
  files: { kinds: { ext: string[] }[]; maxFiles?: number };
  import?: { accepts: ("folder" | "zip" | "file")[] };
}

/** One format's ways in, as the core's import takes them: an entry file in a folder or zip, or one picked file (its
 *  entry extensions, and its kinds' when its model is that one file). */
function takesOf(f: AvatarFormatView): string {
  const accepts = f.import?.accepts ?? ["folder", "zip", "file"];
  const entries = f.entry.extensions.filter((e) => e !== ".zip");
  const held = accepts.some((a) => a !== "file") ? entries : [];
  const files = accepts.includes("file") ? [...new Set([...entries, ...(f.files.maxFiles === 1 ? f.files.kinds.flatMap((k) => k.ext) : [])])] : [];
  return S.avatarTakes(plain(f.name), held, files);
}
import { plain } from "../../shell/runtime/views";
import { BotEditor } from "./BotEditor";
import { useApprovals, useCore, usePluginApi } from "./sdk";
import { S } from "./strings";
import type { AvatarChoice, AvatarImporter, BotEditorModel, BotField, BotPatch, TabPatchChoice } from "./types";

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

/** The text of a refusal: the core's plain reason (main has cut any path out), capped. */
function reasonOf(err: unknown): string {
  return shown(err instanceof Error ? err.message : String(err), 300);
}

/** Text from a file or the core, as plain text: the shared cleaner, capped. */
const shown = (text: string, max: number): string => displayText(text, max) ?? "";

function sizeOf(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function BotEditorEntry({ props }: { props: BotEditorEntryProps }) {
  const api = usePluginApi();
  const core = useCore();
  const { cards } = useApprovals();
  const id = props.params?.bot;
  const [bot, setBot] = useState<BotView | undefined>(undefined);
  const [avatars, setAvatars] = useState<AvatarChoice[]>([]);
  const [formats, setFormats] = useState<AvatarFormatView[]>([]);
  const [models, setModels] = useState<BotEditorModel[]>([]);
  const [themes, setThemes] = useState<{ id: string; name: string }[]>([]);
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const [pick, setPick] = useState<{ token: string; name: string } | undefined>(undefined);
  const [importing, setImporting] = useState(false);
  const [importStatus, setImportStatus] = useState<AvatarImporter["status"]>(undefined);
  const [waiting, setWaiting] = useState<{ field: BotField; card: string } | undefined>(undefined);
  const [tabPatches, setTabPatches] = useState<TabPatchChoice[]>([]);

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
    // The formats the installed renderers declare: what an import of the user's own model takes, and their names.
    void api.points.entries<AvatarFormatView>("avatar.formats").catch(() => []).then((entries) => live && setFormats(entries.map((e) => e.value)));
    const stopFormats = api.points.watch<AvatarFormatView>("avatar.formats", (entries) => setFormats(entries.map((e) => e.value)));
    core?.call("models.list", {}).then((c) => live && setModels(modelsOf(c)), () => undefined);
    void themesOf(core).then((t) => live && setThemes(t));
    return () => {
      live = false;
      stop();
      stopFormats();
    };
  }, [api, core]);

  useEffect(() => {
    if (waiting && !cards.some((c) => c.id === waiting.card)) setWaiting(undefined);
  }, [waiting, cards]);

  useEffect(() => {
    if (!id) return;
    let live = true;
    void tabPatchesOf(core, id).then((t) => live && setTabPatches(t));
    return () => {
      live = false;
    };
  }, [core, id]);

  if (!bot) return <div className="cl-bot-editor cl-bot-editor--loading" role="status" />;

  const change = (patch: BotPatch) => {
    if (!core) return;
    if (patch.avatar !== undefined) setPicked(patch.avatar?.file);
    void core.call("bot.setUserLayer", { id: bot.id, patch }).then((r) => {
      if (!r.applied) setWaiting({ field: Object.keys(patch)[0] as BotField, card: r.card });
    }, () => undefined);
  };

  // Main's picker gives a token and a name (never a path); the import is a second click and hands the token back once.
  const importer: AvatarImporter | undefined = core
    ? {
        ...(pick ? { picked: { name: pick.name } } : {}),
        busy: importing,
        takes: formats.map(takesOf),
        ...(importStatus ? { status: importStatus } : {}),
        onPick: (kind) => {
          setImportStatus(undefined);
          core.call("ui.pick", { kind, use: "bot.importAvatar" }).then(
            (r) => {
              if ("cancelled" in r) {
                setPick(undefined);
                setImportStatus({ tone: "info", text: S.pickCancelled });
              } else setPick({ token: r.token, name: shown(r.name, 80) });
            },
            (err: unknown) => setImportStatus({ tone: "danger", text: S.failed(reasonOf(err)) }),
          );
        },
        ...(bot.userLayer.includes("avatar") && bot.avatar?.src.startsWith("/_a/") ? { replaces: true } : {}),
        ...(bot.avatar?.credit !== undefined && bot.userLayer.includes("avatar") ? { credit: bot.avatar.credit } : {}),
        onCredit: (text) => {
          void core.call("bot.setUserLayer", { id: bot.id, patch: { avatarCredit: text === "" ? null : text } }).then(() => undefined, () => undefined);
        },
        onImport: () => {
          if (!pick) return;
          setImporting(true);
          setImportStatus(undefined);
          core.call("bot.importAvatar", { id: bot.id, path: pick.token }).then(
            (r) => {
              setPick(undefined);
              setImporting(false);
              const named = formats.find((f) => f.format === r.format)?.name;
              setImportStatus({ tone: "ok", text: S.imported(r.name ?? (named === undefined ? r.format : plain(named)), r.files, sizeOf(r.bytes)) });
            },
            (err: unknown) => {
              // The token is spent whether or not the import went: pick again.
              setPick(undefined);
              setImporting(false);
              setImportStatus({ tone: "danger", text: S.failed(reasonOf(err)) });
            },
          );
        },
      }
    : undefined;

  return (
    <BotEditor
      bot={{ id: bot.id, name: plain(bot.name), ...(bot.portrait ? { portraitUrl: bot.portrait } : {}) }}
      own={bot.userLayer}
      model={{ value: bot.model, ...(bot.effort ? { effort: bot.effort } : {}), models }}
      {...(bot.voice ? { voice: bot.voice } : {})}
      avatars={avatars}
      {...(importer ? { importer } : {})}
      {...(picked && bot.userLayer.includes("avatar") ? { avatar: picked } : {})}
      themes={themes}
      {...(bot.theme ? { theme: bot.theme } : {})}
      lan={bot.lan === true}
      {...(waiting ? { waiting: waiting.field } : {})}
      tabPatches={tabPatches}
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
