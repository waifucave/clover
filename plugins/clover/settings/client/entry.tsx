// Settings on the runtime: the `main` entry keyed `settings`, which the shell shows as a dialog over the tab under it.
// Only Clover's own settings: the account, the devices, appearance (the theme plugin, the language), notifications,
// the plugins with their states, OKs and logs, each computer's level, and the bots, which open in the bot editor.
//
// It reads and changes them through the core, as the `clover` layer may (§5.5): `plugin.list` and `plugin.get` for the
// plugins, `plugin.setEnabled`, `plugin.logs`, `ui.settings` and `ui.set` for the theme and language, `account.status`.
// The computers, devices and bots come through the plugin API. A sensitive change (a computer's level, removing a
// device) comes back as a sealed card, and the window closes Settings while it waits (the shell's `cardPending`).
// Light, dark or system and the text size have no place in B's `UiSettings` yet, so they are this plugin's own
// settings until B says where they live.
import { useEffect, useState } from "react";
import type { CoreClient, PairingChanged, PluginDetail, PluginSummary } from "../../shell/runtime/types";
import { deviceKind, plain } from "../../shell/runtime/views";
import { LanguageChooser } from "./LanguageChooser";
import { Spot, useCore, usePluginApi, useSpotEntries } from "./sdk";
import { SettingsModal } from "./SettingsModal";
import { S } from "./strings";
import type { ExtraSection, Language, SettingsSection, SettingsValues } from "./types";

export interface SettingsEntryProps {
  route?: string;
  /** The section to open on: one of Clover's, an added one's id, or `languages` for the language chooser. */
  params?: { section?: string };
  navigate?: (route: { route: string; params: Record<string, string> }) => void;
  close?: () => void;
}

/** What each capability lets a plugin do, in plain words, as its OK says. */
const OK_WORDS: Record<string, string> = {
  "conversation.read": "Reads your bots' conversations",
  "conversation.post": "Posts notes and messages to bots",
  "memory.read": "Reads your bots' memories",
  "bots.read": "Sees your bots",
  "routines.read": "Sees your routines",
  "computers.read": "Sees your computers",
  "computers.control": "Controls the screen and input of your computers",
  approvals: "Restyles approval cards",
  files: "Reads and writes files in your folders",
  terminal: "Runs commands on your computers",
  browser: "Drives the Clover Browser",
  "usage.read": "Reads your usage",
  "logs.read": "Reads Clover's logs",
  notify: "Sends you notifications",
  audio: "Can hear your microphone",
  "devices.read": "Sees your devices",
};

export function okWords(detail: Pick<PluginDetail, "capabilities" | "networkHosts">): string[] {
  const out: string[] = [];
  for (const c of detail.capabilities) {
    if (c.startsWith("network:")) continue;
    if (c.startsWith("call:")) out.push(`Runs ${c.slice(5)}'s commands`);
    else out.push(OK_WORDS[c] ?? c);
  }
  for (const h of detail.networkHosts) out.push(`Reaches ${h}`);
  return out;
}

const SOURCES: Record<PluginSummary["source"], string> = {
  bundled: "Bundled",
  index: "From the plugin index",
  npm: "From npm",
  local: "From a folder",
  wrapped: "Wrapped by Clover",
  dev: "A development folder",
};

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
  // The base theme is the plain one (spec, open question 14).
  const name = (id: string) => (id === "clover/base-theme" ? "Plain" : plain(plugins.find((p) => p.id === id)?.name) || id);
  const themes = (pluginUi?.plugins ?? []).flatMap((p) => p.themes.map((t) => ({ id: `${p.pluginId}#${t.id}`, name: p.themes.length > 1 ? `${name(p.pluginId)}: ${t.id}` : name(p.pluginId) })));
  const langs = new Set<string>(["en-US"]);
  for (const p of pluginUi?.plugins ?? []) for (const l of p.locales) langs.add(l.lang);
  return {
    plugins,
    details,
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
  const [logs, setLogs] = useState<{ name: string; lines: string[] } | undefined>(undefined);
  const [loaded, setLoaded] = useState<Loaded | undefined>(undefined);
  const [revision, setRevision] = useState(0);
  const [computers, setComputers] = useState<Awaited<ReturnType<NonNullable<NonNullable<typeof api.computers>["list"]>>>>([]);
  const [devices, setDevices] = useState<Awaited<ReturnType<NonNullable<typeof api.devices>["list"]>>>([]);
  const [bots, setBots] = useState<{ id: string; name: string }[]>([]);
  const [own, setOwn] = useState<{ appearance?: SettingsValues["appearance"]; notifications?: SettingsValues["notifications"] }>({});
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
    void Promise.all([api.settings.get<SettingsValues["appearance"]>("appearance"), api.settings.get<SettingsValues["notifications"]>("notifications")]).then(
      ([appearance, notifications]) => live && setOwn({ ...(appearance ? { appearance } : {}), ...(notifications ? { notifications } : {}) }),
      () => undefined,
    );
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
    appearance: own.appearance ?? { theme: "system", textSize: "default" },
    language: { id: loaded?.language ?? "en-US", name: languageOf(loaded?.language ?? "en-US").native },
    notifications: own.notifications ?? { needsYou: true, agentDone: true, routineFailed: true, sounds: false },
    plugins: (loaded?.plugins ?? []).map((p) => ({
      id: p.id,
      name: plain(p.name),
      source: SOURCES[p.source],
      state: p.state,
      enabled: p.enabled,
      ...(p.reason ? { reason: p.reason } : {}),
      oks: loaded?.details[p.id] ? okWords(loaded.details[p.id]!) : [],
    })),
    themes: loaded?.themes ?? [],
    theme: loaded?.globalTheme ?? loaded?.themes[0]?.id ?? "",
    levels: computers.map((c) => ({ computer: c.name, ...(c.link === "self" ? { here: true } : {}), level: c.level })),
    levelOptions: [
      { id: "read-only", label: "Read only" },
      { id: "ask", label: "Ask first" },
      { id: "ask-risky", label: "Ask when risky" },
      { id: "accept-edits", label: "Accept edits" },
      { id: "automatic", label: "Fully automatic" },
    ],
    devices: devices.map((d) => ({ id: d.id, name: d.name, kind: deviceKind(d), ...(d.isThis ? { here: true } : {}), ...(d.isMain ? { main: true } : {}) })),
    bots,
  };

  const onChange = (path: string, value: unknown) => {
    const [head, key, field] = path.split(".");
    if (head === "appearance" && key) {
      const next = { ...values.appearance, [key]: value } as SettingsValues["appearance"];
      setOwn((o) => ({ ...o, appearance: next }));
      void api.settings.set("appearance", next);
    } else if (head === "notifications" && key) {
      const next = { ...values.notifications, [key]: value } as SettingsValues["notifications"];
      setOwn((o) => ({ ...o, notifications: next }));
      void api.settings.set("notifications", next);
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
      onSection={(s) => {
        setLogs(undefined);
        setSection(s);
      }}
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
