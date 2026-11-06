// Settings on the runtime: the `main` entry keyed `settings`, which the shell shows as a dialog over the tab under it.
// Only Clover's own settings: the account, the devices, appearance (the theme plugin, the language), notifications,
// the plugins with their states, OKs and logs, each computer's level, and the bots, which open in the bot editor.
//
// It reads and changes them through the core, as the `clover` layer may (§5.5): `plugin.list` and `plugin.get` for the
// plugins, `plugin.setEnabled`, `plugin.logs`, `ui.settings` and `ui.set` for the theme and language, `account.status`.
// The computers, devices and bots come through the plugin API. A sensitive change (a computer's level, removing a
// device) comes back as a sealed card, and the window closes Settings while it waits (the shell's `cardPending`).
// Light, dark or system and the text size are the user's UI choices, through `ui.settings` and `ui.set` with the theme
// and the language (`UiAppearance` below: fields asked of lane B for `UiSettings`, which lane E's runtime applies).
// Notifications are each notifier plugin's own declared settings, as every plugin's are (`plugin.settings.get` and
// `plugin.settings.set`, §5.1): the plugin reads them, so no switch here is one nothing reads.
import { useEffect, useState } from "react";
import type { CoreClient, CoreMethods, PairingChanged, PluginDetail, PluginSummary } from "../../shell/runtime/types";
import { deviceKind, plain } from "../../shell/runtime/views";
import { LanguageChooser } from "./LanguageChooser";
import { Spot, useCore, usePluginApi, useSpotEntries } from "./sdk";
import { SettingsModal } from "./SettingsModal";
import { S } from "./strings";
import type { ExtraSection, Language, PluginSettingsGroup, SettingField, SettingsSection, SettingsValues } from "./types";

/** The UI choices `ui.settings` carries beside the theme and language: light, dark or the system's, and the text size
 *  (asked of lane B for `UiSettings`; lane E's runtime applies them to every window). */
interface UiAppearance {
  appearance?: "light" | "dark" | "system";
  textSize?: "small" | "default" | "large";
}

export interface SettingsEntryProps {
  route?: string;
  /** The section to open on: one of Clover's, an added one's id, or `languages` for the language chooser; and an item
   *  in it to bring into view and mark (lane E's `useOpen`: a device's id on Devices, a plugin's id on Plugins, a
   *  computer's name on Levels, a bot's id on Bots). */
  params?: { section?: string; item?: string };
  navigate?: (route: { route: string; params: Record<string, string> }) => void;
  close?: () => void;
}

export function okWords(detail: Pick<PluginDetail, "capabilities" | "networkHosts">): string[] {
  const out: string[] = [];
  for (const c of detail.capabilities) {
    if (c.startsWith("network:")) continue;
    if (c.startsWith("call:")) out.push(S.okCall(c.slice(5)));
    else out.push(S.okWord(c));
  }
  for (const h of detail.networkHosts) out.push(S.okHost(h));
  return out;
}


/** The languages Settings offers: English, built in, and every installed pack's. */
const LANGUAGE_NAMES: Record<string, { native: string; name: string }> = {
  en: { native: "English", name: "English" },
  "en-US": { native: "English (United States)", name: "English (United States)" },
  de: { native: "Deutsch", name: "German" },
  es: { native: "Español", name: "Spanish" },
  fr: { native: "Français", name: "French" },
  ja: { native: "日本語", name: "Japanese" },
  "pt-BR": { native: "Português (Brasil)", name: "Portuguese (Brazil)" },
};
const languageOf = (lang: string): Language => ({ id: lang, ...(LANGUAGE_NAMES[lang] ?? { native: lang, name: lang }) });

interface Loaded {
  plugins: PluginSummary[];
  /** Each plugin's declared settings, by its id (those that declare any). */
  settings: Record<string, SettingField[]>;
  /** The plugins that notify (`notifiers`). */
  notifiers: string[];
  appearance: NonNullable<UiAppearance["appearance"]>;
  textSize: NonNullable<UiAppearance["textSize"]>;
  details: Record<string, PluginDetail>;
  account?: string;
  language: string;
  globalTheme?: string;
  themes: { id: string; name: string }[];
  languages: Language[];
}

async function load(core: CoreClient): Promise<Loaded> {
  const quiet = <T,>(p: Promise<T>) => p.catch(() => undefined);
  const [list, account, ui, pluginUi] = await Promise.all([
    quiet(core.call("plugin.list", {})),
    quiet(core.call("account.status", {})),
    quiet(core.call("ui.settings", {})),
    quiet(core.call("plugin.ui", {})),
  ]);
  const plugins = list?.plugins ?? [];
  const details: Record<string, PluginDetail> = {};
  await Promise.all(plugins.map(async (p) => {
    const d = await quiet(core.call("plugin.get", { id: p.id }));
    if (d) details[p.id] = d.plugin;
  }));
  // Each plugin's declared settings: the core's values (`plugin.settings.get`), with the manifest's choices and limits.
  const declared = (d: PluginDetail | undefined) => ((d?.manifest as { settings?: Record<string, { options?: unknown; min?: unknown; max?: unknown }> } | undefined)?.settings ?? {});
  const notifiers = plugins.filter((p) => {
    const c = (details[p.id]?.manifest as { contributes?: { notifiers?: unknown } } | undefined)?.contributes?.notifiers;
    return Array.isArray(c) && c.length > 0;
  }).map((p) => p.id);
  const settings: Record<string, SettingField[]> = {};
  await Promise.all(plugins.filter((p) => Object.keys(declared(details[p.id])).length > 0 || notifiers.includes(p.id)).map(async (p) => {
    const got = await quiet(core.call("plugin.settings.get", { id: p.id }));
    const manifest = declared(details[p.id]);
    settings[p.id] = (got?.settings ?? []).filter((v) => v.scope !== "bot").map((v) => {
      const m = manifest[v.key];
      const options = Array.isArray(m?.options)
        ? (m.options as unknown[]).flatMap((o) => (typeof o === "string" ? [{ value: o, title: o }] : o && typeof o === "object" && typeof (o as { value?: unknown }).value === "string" ? [{ value: (o as { value: string }).value, title: plain((o as { title?: unknown }).title as never) || (o as { value: string }).value }] : []))
        : undefined;
      return {
        key: v.key, type: v.type, title: plain(v.title), set: v.set, required: v.required,
        ...(v.description !== undefined ? { description: plain(v.description) } : {}),
        ...(v.value !== undefined ? { value: v.value } : {}),
        ...(v.defaultPending ? { defaultPending: true } : {}),
        ...(options ? { options } : {}),
        ...(typeof m?.min === "number" ? { min: m.min } : {}),
        ...(typeof m?.max === "number" ? { max: m.max } : {}),
      };
    });
  }));
  const look = (ui ?? {}) as UiAppearance;
  // The base theme is the plain one (spec, open question 14).
  const name = (id: string) => (id === "clover/base-theme" ? "Plain" : plain(plugins.find((p) => p.id === id)?.name) || id);
  const themes = (pluginUi?.plugins ?? []).flatMap((p) => p.themes.map((t) => ({ id: `${p.pluginId}#${t.id}`, name: p.themes.length > 1 ? `${name(p.pluginId)}: ${t.id}` : name(p.pluginId) })));
  const langs = new Set<string>(["en-US"]);
  for (const p of pluginUi?.plugins ?? []) for (const l of p.locales) langs.add(l.lang);
  return {
    plugins,
    details,
    settings,
    notifiers,
    appearance: look.appearance ?? "system",
    textSize: look.textSize ?? "default",
    ...(account?.user ? { account: account.user.name ?? account.user.email ?? "" } : {}),
    language: ui?.language ?? "en-US",
    ...(ui?.globalTheme ? { globalTheme: ui.globalTheme } : {}),
    themes,
    languages: [...langs].map(languageOf),
  };
}

export function SettingsEntry({ props }: { props: SettingsEntryProps }) {
  const api = usePluginApi();
  const core = useCore();
  // `languages` opens the language chooser over Appearance (the welcome guide's and the gallery's door).
  const start = props.params?.section;
  const [section, setSection] = useState<SettingsSection | string>(start && start !== "languages" ? start : "appearance");
  const [picking, setPicking] = useState(start === "languages");
  const [item, setItem] = useState<string | undefined>(props.params?.item);
  // A place can open Settings again while it is open (the island's Devices tab at another device).
  useEffect(() => {
    if (start === "languages") setPicking(true);
    else if (start) setSection(start);
    setItem(props.params?.item);
  }, [start, props.params?.item]);
  const [logs, setLogs] = useState<{ name: string; lines: string[] } | undefined>(undefined);
  const [loaded, setLoaded] = useState<Loaded | undefined>(undefined);
  const [revision, setRevision] = useState(0);
  const [computers, setComputers] = useState<Awaited<ReturnType<NonNullable<NonNullable<typeof api.computers>["list"]>>>>([]);
  const [devices, setDevices] = useState<Awaited<ReturnType<NonNullable<typeof api.devices>["list"]>>>([]);
  const [bots, setBots] = useState<{ id: string; name: string }[]>([]);
  const [pairing, setPairing] = useState<{ id: string; code?: string; words?: string[]; confirming?: boolean; ended?: string } | undefined>(undefined);

  // The pairing moves on through lane H's `pairing_changed`: the side that showed the code hears the four words once
  // the other device joins, a card waits, and it ends with the device added, or failed, or expired.
  useEffect(() => {
    if (!core || !pairing) return;
    return core.on("pairing_changed", (event) => {
      const e = event as unknown as PairingChanged;
      if (e.pairingId !== pairing.id) return;
      if (e.step === "words" && e.words) setPairing((p) => (p ? { ...p, words: e.words } : p));
      else if (e.step === "card") setPairing((p) => (p ? { ...p, confirming: true } : p));
      else if (e.step === "done") setPairing(undefined);
      else if (e.step === "expired") setPairing((p) => (p ? { id: p.id, ended: S.pairExpired } : p));
      else if (e.step === "failed") setPairing((p) => (p ? { id: p.id, ended: S.pairFailed(plain(e.reason)) } : p));
    });
  }, [core, pairing?.id]);

  useEffect(() => {
    let live = true;
    if (core) load(core).then((l) => live && setLoaded(l), () => undefined);
    api.computers?.list?.().then((c) => live && setComputers(c), () => undefined);
    api.devices?.list().then((d) => live && setDevices(d), () => undefined);
    api.bots?.list().then((b) => live && setBots(b.map((x) => ({ id: x.id, name: plain(x.name) }))), () => undefined);
    return () => {
      live = false;
    };
  }, [api, core, revision]);

  const extra: ExtraSection[] = useSpotEntries("settings.section").entries.map((e) => {
    const ref = `${e.pluginId}#${e.id}`;
    return { id: ref, title: typeof e.fields?.title === "string" ? e.fields.title : e.pluginId, render: () => <Spot name="settings.section" only={ref} /> };
  });

  const main = computers.find((c) => c.isMain)?.name ?? "";
  const values: SettingsValues = {
    account: { name: loaded?.account ?? "", main },
    appearance: { theme: loaded?.appearance ?? "system", textSize: loaded?.textSize ?? "default" },
    language: { id: loaded?.language ?? "en-US", name: languageOf(loaded?.language ?? "en-US").native },
    notifiers: (loaded?.notifiers ?? []).map((id): PluginSettingsGroup => ({ pluginId: id, name: plain(loaded?.plugins.find((p) => p.id === id)?.name) || id, fields: loaded?.settings[id] ?? [] })),
    plugins: (loaded?.plugins ?? []).map((p) => ({
      id: p.id,
      name: plain(p.name),
      source: S.source(p.source),
      state: p.state,
      enabled: p.enabled,
      ...(p.reason ? { reason: p.reason } : {}),
      oks: loaded?.details[p.id] ? okWords(loaded.details[p.id]!) : [],
      ...(loaded?.settings[p.id]?.length ? { settings: loaded.settings[p.id] } : {}),
    })),
    themes: loaded?.themes ?? [],
    theme: loaded?.globalTheme ?? loaded?.themes[0]?.id ?? "",
    levels: computers.map((c) => ({ computer: c.name, ...(c.link === "self" ? { here: true } : {}), level: c.level })),
    levelOptions: (["read-only", "ask", "ask-risky", "accept-edits", "automatic"] as const).map((id) => ({ id, label: S.levelName(id) })),
    devices: devices.map((d) => ({ id: d.id, name: d.name, kind: deviceKind(d), ...(d.isThis ? { here: true } : {}), ...(d.isMain ? { main: true } : {}) })),
    bots,
  };

  const onChange = (path: string, value: unknown) => {
    const [head, key, field] = path.split(".");
    if (head === "appearance" && key && core) {
      // Light, dark or the system's (`theme` here) and the text size: the user's UI choices, which every window follows.
      const patch: UiAppearance = key === "theme" ? { appearance: value as UiAppearance["appearance"] } : key === "textSize" ? { textSize: value as UiAppearance["textSize"] } : {};
      setLoaded((l) => (l ? { ...l, ...(patch.appearance ? { appearance: patch.appearance } : {}), ...(patch.textSize ? { textSize: patch.textSize } : {}) } : l));
      void core.call("ui.set", { patch: patch as unknown as CoreMethods["ui.set"]["params"]["patch"] }).then(() => setRevision((r) => r + 1), () => setRevision((r) => r + 1));
    } else if (head === "theme" && typeof value === "string" && core) {
      // A theme is `<plugin-id>#<theme-id>` (B's `ThemeRef`).
      if (value.includes("#")) void core.call("ui.set", { patch: { globalTheme: value } }).then(() => setRevision((r) => r + 1));
    } else if (head === "plugins" && key && field === "enabled" && core) {
      void core.call("plugin.setEnabled", { id: key, enabled: value === true }).then(() => setRevision((r) => r + 1));
    }
  };

  if (picking) {
    return (
      <LanguageChooser
        languages={loaded?.languages ?? [languageOf("en-US")]}
        current={values.language.id}
        onPick={(lang) => {
          setPicking(false);
          void core?.call("ui.set", { patch: { language: lang } }).then(() => setRevision((r) => r + 1));
        }}
        onClose={() => setPicking(false)}
      />
    );
  }

  return (
    <SettingsModal
      section={section}
      {...(core
        ? {
            onPluginSetting: (id: string, key: string, value: unknown) =>
              void core.call("plugin.settings.set", { id, key, value: value as never }).then(() => setRevision((r) => r + 1), () => setRevision((r) => r + 1)),
          }
        : {})}
      onSection={(s) => {
        setLogs(undefined);
        setSection(s);
        setItem(undefined);
      }}
      {...(item !== undefined ? { item } : {})}
      onClose={() => props.close?.()}
      values={values}
      onChange={onChange}
      onOpenLanguage={() => setPicking(true)}
      {...(props.navigate ? { onOpenPluginManager: () => props.navigate!({ route: "plugins", params: {} }), onEditBot: (id: string) => props.navigate!({ route: "bot-editor", params: { bot: id } }) } : {})}
      {...(core
        ? {
            onOpenPluginLogs: (id: string) =>
              void core.call("plugin.logs", { id, lines: 200 }).then((r) => setLogs({ name: values.plugins.find((p) => p.id === id)?.name ?? id, lines: r.lines })),
            onRequestLevel: (computer: string, level: string) => void core.call("computer.setLevel", { name: computer, level: level as never }),
            onRemoveDevice: (id: string) => void core.call("device.revoke", { id }),
            // Switching on a found plugin is loading it, a sensitive change: the core answers with its OK on a sealed
            // card (the controller's ruling S2, which lane B pins), and the list follows once the user answers.
            onReviewOk: (id: string) => void core.call("plugin.setEnabled", { id, enabled: true }).then(() => setRevision((r) => r + 1)),
            onMakeMain: (id: string) => void core.call("main.set", { device: id }),
            onPairBegin: () =>
              void core.call("device.pair.begin", {}).then((p) => setPairing({ id: p.pairingId, ...(p.code ? { code: p.code } : {}), ...(p.words ? { words: p.words } : {}) })),
            onPairJoin: (code: string) =>
              void core.call("device.pair.join", { code }).then((p) => setPairing({ id: p.pairingId, ...(p.code ? { code: p.code } : {}), ...(p.words ? { words: p.words } : {}) })),
            onPairConfirm: () => {
              if (!pairing?.words) return;
              setPairing({ ...pairing, confirming: true });
              void core.call("device.pair.confirm", { pairingId: pairing.id, words: pairing.words }).then((r) => {
                // Applied at once (the user's own terminal) or after its card: either way the list shows the device.
                if (r.applied) setPairing(undefined);
              });
            },
            onPairCancel: () => {
              if (pairing && pairing.ended === undefined) void core.call("device.pair.cancel", { pairingId: pairing.id });
              setPairing(undefined);
            },
          }
        : {})}
      {...(logs ? { logs: { ...logs, onBack: () => setLogs(undefined) } } : {})}
      {...(pairing ? { pairing: { ...(pairing.code ? { code: pairing.code } : {}), ...(pairing.words ? { words: pairing.words } : {}), ...(pairing.confirming ? { confirming: true } : {}), ...(pairing.ended !== undefined ? { ended: pairing.ended } : {}) } } : {})}
      extraSections={extra}
    />
  );
}
