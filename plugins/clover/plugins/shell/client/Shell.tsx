// The default shell: the `app.root` entry. It holds the route (what `main` shows) and the panels open on each tab, and
// it places every spot it declares (spec §5.5): the sidebar, `main` keyed by route, the panel host keyed by panel, the
// column beside the conversation, the status bar, and a dialog layer for Settings. What fills each spot is another
// entry, mounted through `<Spot>`; the shell draws only the frame (`Window`), the panel host and its toggles.
//
// Routes (`main`'s keys): `bot` (a bot's tab, which `bot.tab` holds), `agent` (an agent's or a coding session's live
// tab), `settings` (a dialog over the tab under it), `plugins`, and the keys app buttons open (`archive`), plus
// `bot-editor`. Panels by tab (the owner's item 90): a coding session has its column, the terminal, the changes, the
// files and the browser; a bot's tab has its slim column (`bot.side`) and the browser, and one of its coding agents
// opens in the panel as a live tab of its own.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { BotRef, EntryProps, SessionKind, SessionView } from "../runtime/types";
import { useLiveList, useLoad } from "./data";
import { IconEdit } from "./icons";
import { PanelEmpty, PanelHost } from "./PanelHost";
import { belongsIn, PanelToggles, toggleView, VIEWS_BY_KIND } from "./PanelToggles";
import type { PanelView } from "./panel-types";
import { Palette, paletteCommand, fieldsOf, type PaletteCommand } from "./Palette";
import { Spot, useApprovals, useCore, useLayerMessage, usePluginApi, useSpotEntries, useT } from "./sdk";
import { bindings, chordOf, commandFor, currentPlatform, parseChord, PALETTE_KEY, sameChord } from "./shortcuts";
import { setTranslator } from "../runtime/strings";
import { S } from "./strings";
import { plain } from "../runtime/views";
import { Window } from "./Window";

/** What `main` shows: B's `main` props (`route`, `params`). */
export interface ShellRoute {
  route: string;
  params: Record<string, string>;
}

/** Where the shell starts, for the gallery and the tests: not part of `app.root`'s props in the app. */
export interface ShellStart {
  route?: ShellRoute;
  /** The tab under Settings, when `route` is Settings. */
  under?: ShellRoute;
  /** The panels open on the tab shown; `session` is the column beside the conversation. */
  panels?: string[];
  /** A bot's coding agent open in the panel. */
  agent?: string;
  /** One of the tab's outputs open in the panel (a tree path). */
  output?: string;
  /** The command palette open. */
  palette?: boolean;
}

export interface ShellProps {
  /** The window has a system material behind it (lane E): the sidebar lets it through. */
  translucent?: boolean;
  start?: ShellStart;
}

const tabKey = (r: ShellRoute | undefined) => (r ? `${r.route}:${r.params.bot ?? r.params.session ?? ""}` : "");

function NothingHere({ title }: { title: string }) {
  return (
    <div className="cl-shell-empty" role="status">
      <p className="cl-shell-empty__title">{title}</p>
      <p className="cl-shell-empty__detail">{S.nothingHereDetail}</p>
    </div>
  );
}

export function Shell({ props }: EntryProps<ShellProps>) {
  // Every part under the shell reads its `clover.` keys through the app's table for the `clover` layer (lane E's
  // `useT()`), in the user's language; what it lacks reads in the part's own English.
  setTranslator(useT());
  const api = usePluginApi();
  const bots = useLiveList(api.bots ? () => api.bots!.list() : undefined, api.bots?.watch, (a, b) => a.id === b.id, [api]);
  const [route, setRoute] = useState<ShellRoute | undefined>(props.start?.route);
  // Settings opens over the tab the user was on, which stays under it.
  const [under, setUnder] = useState<ShellRoute | undefined>(props.start?.under);
  const startTab = props.start?.route?.route === "settings" ? props.start.under : props.start?.route;
  const [panels, setPanels] = useState<Record<string, string[]>>(() => (startTab && props.start?.panels ? { [tabKey(startTab)]: props.start.panels } : {}));
  const [agents, setAgents] = useState<Record<string, string | undefined>>(() => (startTab && props.start?.agent ? { [tabKey(startTab)]: props.start.agent } : {}));

  useEffect(() => {
    if (!route && bots && bots[0]) setRoute({ route: "bot", params: { bot: bots[0].id } });
  }, [route, bots]);

  const dialog = route?.route === "settings" ? route : undefined;
  const shown = dialog ? under : route;
  const sessions = useLoad(() => api.conversation?.list?.() ?? Promise.resolve([] as SessionView[]), [api, tabKey(shown)]);
  const bot = shown?.route === "bot" ? bots?.find((b) => b.id === shown.params.bot) : undefined;
  const botRef: BotRef | undefined = bot ? { id: bot.id, name: plain(bot.name) } : undefined;
  const session = shown?.route === "agent" ? sessions?.find((s) => s.id === shown.params.session) : undefined;
  const kind: SessionKind | undefined = shown?.route === "bot" ? "bot" : shown?.route === "agent" ? (session?.kind ?? "agent") : undefined;
  const tabSession = bot?.mainSession ?? session?.id;
  const key = tabKey(shown);
  const open = panels[key] ?? [];
  const agent = agents[key];
  const agentSession = agent ? sessions?.find((s) => s.id === agent) : undefined;

  const navigate = (next: ShellRoute) => {
    if (next.route === "settings" && route?.route !== "settings") setUnder(route);
    setRoute(next);
  };
  const closeDialog = () => setRoute(under);

  // The app's commands to this window (lane E's `useLayerMessage`): Settings from ⌘, or the menu, or a place that opens
  // it at a section and an item, over the tab that was showing; a bot's tab; or a session, from a notification or
  // `app.show`. A bot's main conversation is its tab; any other session opens as an agent's tab.
  useLayerMessage((m) => {
    if (m.type !== "command") return;
    const args = m.args ?? {};
    if (m.name === "open-settings") {
      navigate({ route: "settings", params: { ...(args.section !== undefined ? { section: args.section } : {}), ...(args.item !== undefined ? { item: args.item } : {}) } });
    } else if (m.name === "open-bot" && args.bot !== undefined) {
      navigate({ route: "bot", params: { bot: args.bot } });
    } else if (m.name === "open-session" && args.session !== undefined) {
      const main = (bots ?? []).find((b) => b.mainSession === args.session) ?? (/^([a-z0-9-]+):main$/.exec(args.session) ? { id: args.session.slice(0, -5) } : undefined);
      navigate(main ? { route: "bot", params: { bot: main.id } } : { route: "agent", params: { session: args.session } });
    }
  });
  // The command palette (Search opens it, and ⌘K / Ctrl+K), and the plugin commands' shortcuts while this window has
  // the focus: the user's own bindings (synced) win over a command's default key, and a core shortcut over both.
  const core = useCore();
  const [palette, setPalette] = useState<{ start?: string } | undefined>(props.start?.palette ? {} : undefined);
  const [commands, setCommands] = useState<PaletteCommand[]>([]);
  const [userKeys, setUserKeys] = useState<Record<string, string | null>>({});
  const [defaults, setDefaults] = useState<{ name: string; key?: string }[]>([]);
  const platform = useMemo(currentPlatform, []);
  useEffect(() => {
    if (!core) return;
    const load = () =>
      void core.call("command.list", {}).then(
        (r) => {
          setCommands(r.commands.map(paletteCommand));
          setDefaults(r.commands.map((c) => ({ name: c.name, ...(c.key ? { key: c.key } : {}) })));
        },
        () => undefined,
      );
    load();
    return core.on("commands_changed", load);
  }, [core]);
  useEffect(() => {
    const store = api.storage?.synced;
    if (!store) return;
    const read = () => void store.get<Record<string, string | null>>("shortcuts").then((v) => setUserKeys(v ?? {}), () => undefined);
    read();
    return store.watch((k) => k === "shortcuts" && read());
  }, [api]);
  const bound = useMemo(() => bindings(defaults, userKeys, platform), [defaults, userKeys, platform]);
  const runCommand = (name: string, args: Record<string, unknown> | undefined) =>
    core ? core.call("command.run", { name, ...(args !== undefined ? { args } : {}) }).then(() => undefined) : Promise.reject(new Error(S.noCore));
  const rebind = (name: string, keyText: string | null) => {
    const next = { ...userKeys, [name]: keyText };
    setUserKeys(next);
    void api.storage?.synced.set("shortcuts", next).catch(() => undefined);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const chord = chordOf(e);
      if (sameChord(parseChord(PALETTE_KEY)!, chord, platform)) {
        e.preventDefault();
        setPalette((p) => (p ? undefined : {}));
        return;
      }
      if (palette || route?.route === "settings") return;
      // A key with no modifier never fires while the user types.
      const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
      if (typing && !chord.ctrl && !chord.meta && !chord.alt) return;
      const name = commandFor(chord, bound, platform);
      if (!name) return;
      e.preventDefault();
      const c = commands.find((x) => x.name === name);
      if (c && fieldsOf(c.args).length > 0) setPalette({ start: name });
      else void runCommand(name, undefined).catch(() => undefined);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const setOpen = (next: string[]) => setPanels((p) => ({ ...p, [key]: next }));
  const openAgent = (id: string) => {
    setAgents((a) => ({ ...a, [key]: id }));
    if (!open.includes("agent")) setOpen(toggleView(open, "agent"));
  };
  // One of the tab's outputs, opened from its column into the right panel (`panel` keyed `output`).
  const [outputs, setOutputs] = useState<Record<string, string | undefined>>(() => (startTab && props.start?.output ? { [tabKey(startTab)]: props.start.output } : {}));
  const output = outputs[key];
  const openOutput = (path: string) => {
    setOutputs((o) => ({ ...o, [key]: path }));
    if (!open.includes("output")) setOpen(toggleView(open, "output"));
  };

  // Any card this window will draw: one in a session it shows (the tab's, the agent's in the panel), or one raised
  // from a dialog (a level change, removing a device), which has no session.
  const { cards } = useApprovals();
  const showing = new Set([tabSession, agent].filter((s): s is string => s !== undefined));
  const cardPending = cards.some((c) => c.session === undefined || showing.has(c.session));

  const appButtons = useSpotEntries("sidebar.app").entries;
  const title = (() => {
    if (!shown) return "";
    if (shown.route === "bot") return plain(bot?.name);
    if (shown.route === "agent") return session?.title ?? S.views.agent!;
    if (shown.route === "plugins") return S.plugins;
    if (shown.route === "bot-editor") return S.editBot(plain(bots?.find((b) => b.id === shown.params.bot)?.name));
    const app = appButtons.find((e) => e.fields?.opens === shown.route);
    return typeof app?.fields?.title === "string" ? app.fields.title : shown.route;
  })();

  // A bot's tab says whose it is (`bot`, its id: the browser shows that bot's tabs, a code session the person's own).
  const panelProps = (id: string): Record<string, unknown> =>
    id === "output"
      ? { app: id, session: tabSession, sessionKind: kind, path: output }
      : id === "agent" && agentSession
      ? { app: id, session: agentSession.id, sessionKind: agentSession.kind, ...(botRef ? { bot: botRef.id } : {}) }
      : { app: id, session: tabSession, sessionKind: kind, ...(botRef ? { bot: botRef.id } : {}) };
  const views: PanelView[] = kind
    ? open
        .filter((id) => id !== "session")
        .map((id) => ({
          id,
          title: id === "agent" ? (agentSession?.title ?? S.views.agent!) : id === "output" ? (output?.split("/").pop() ?? S.output) : (S.views[id] ?? id),
          content: (header: HTMLElement | null, usedLast: boolean) => (
            <Spot
              name="panel"
              spotKey={id}
              props={{ ...panelProps(id), header, usedLast }}
              fallback={<PanelEmpty id={id} title={S.views[id] ?? id} onFindPlugin={(k) => navigate({ route: "plugins", params: { spot: "panel", key: k } })} />}
            />
          ),
        }))
        .filter((v) => belongsIn(v, kind))
    : [];

  const side: ReactNode =
    kind && open.includes("session")
      ? kind === "bot" && botRef
        ? <Spot name="bot.side" props={{ bot: botRef, session: tabSession, sessionKind: "bot", openAgent: agent, onOpenAgent: openAgent, onOpenOutput: openOutput, navigate }} />
        : <Spot name="panel" spotKey="session" props={{ app: "session", session: tabSession, sessionKind: kind, navigate, onOpenOutput: openOutput }} />
      : undefined;

  const toggles = kind ? (
    <>
      {botRef && <Spot name="bot.header.action" props={{ bot: botRef }} />}
      {botRef && (
        <button type="button" className="cl-panel-toggle" aria-label={S.editBot(botRef.name)} title={S.editBot(botRef.name)} onClick={() => navigate({ route: "bot-editor", params: { bot: botRef.id } })}>
          <IconEdit />
        </button>
      )}
      <PanelToggles kind={kind} open={open} onToggle={(id) => setOpen(toggleView(open, id))} available={VIEWS_BY_KIND[kind]} />
    </>
  ) : undefined;

  const statusEntries = useSpotEntries("status").entries;
  const status = statusEntries.length > 0 ? <Spot name="status" /> : undefined;

  const main = !shown ? (
    <NothingHere title={S.loading} />
  ) : shown.route === "bot" ? (
    botRef ? <Spot name="bot.tab" spotKey={botRef.id} props={{ bot: botRef, onOpenAgent: openAgent }} fallback={<NothingHere title={S.nothingHere} />} /> : <NothingHere title={S.loading} />
  ) : (
    <Spot name="main" spotKey={shown.route} props={{ route: shown.route, params: shown.params, navigate }} fallback={<NothingHere title={S.nothingHere} />} />
  );

  return (
    <Window
      translucent={props.translucent}
      sidebar={<Spot name="sidebar" props={{ route: shown ?? { route: "bot", params: {} }, navigate, onSearch: () => setPalette({}) }} />}
      title={title}
      {...(shown?.route === "bot" && botRef ? { heading: <Spot name="bot.header" props={{ bot: botRef }} fallback={title} /> } : {})}
      toggles={toggles}
      side={side}
      panel={views.length > 0 && kind ? <PanelHost kind={kind} views={views} onClose={(id) => setOpen(open.filter((v) => v !== id))} onExpand={() => undefined} /> : undefined}
      dialog={
        palette ? (
          <Palette
            commands={commands}
            places={[
              ...(bots ?? []).map((b) => ({ id: `bot:${b.id}`, title: plain(b.name), detail: S.paletteBot, go: () => navigate({ route: "bot", params: { bot: b.id } }) })),
              ...(sessions ?? []).filter((s) => s.kind !== "bot").map((s) => ({ id: `session:${s.id}`, title: s.title ?? s.id, detail: S.paletteSession, go: () => navigate({ route: "agent", params: { session: s.id } }) })),
            ]}
            bound={bound}
            platform={platform}
            onRun={runCommand}
            onRebind={rebind}
            onClose={() => setPalette(undefined)}
            {...(palette.start ? { start: palette.start } : {})}
          />
        ) : dialog ? (
          <Spot name="main" spotKey="settings" props={{ route: "settings", params: dialog.params, navigate, close: closeDialog }} />
        ) : undefined
      }
      cardPending={cardPending}
      onCloseDialog={() => (palette ? setPalette(undefined) : closeDialog())}
      status={status}
    >
      {main}
    </Window>
  );
}
