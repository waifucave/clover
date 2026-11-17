// MOSS's window (spec §6.10, the owner's picture of 2026-11-16): the bots on the left, the selected bot's one
// conversation in the middle, its screen and routines on the right when asked for. Built in and fixed: no plugin part is
// mounted anywhere in it. What it shows comes from MOSS's main process as plain data (shared/view.ts).
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { bridge } from "./bridge";
import { BotList, type Page } from "./list/BotList";
import { Conversation } from "./conversation/Conversation";
import { Strip } from "./cards/CardFrame";
import { SidePanel } from "./panel/SidePanel";
import { PluginsPage } from "./plugins/PluginsPage";
import { SettingsPage } from "./settings/SettingsPage";
import { faceMotion } from "./faces/Face";
import type { MossView } from "../shared/view";

declare const __MOSS_TEST_BUILD__: string | false;

const EMPTY: MossView = { connection: { kind: "connecting" }, pieces: {}, bots: [], cards: [] };

const CONNECTION_WORDS: Record<MossView["connection"]["kind"], string> = {
  connecting: "Connecting to MOSS's engine…",
  "starting-engine": "Starting MOSS's engine…",
  connected: "",
  reconnecting: "The engine went away. Reconnecting…",
  behind: "MOSS needs an update to talk to this engine.",
  refused: "The engine refused MOSS.",
  unavailable: "MOSS can't reach its engine.",
  stopped: "MOSS stopped.",
};

export function App() {
  const [view, setView] = useState<MossView>(EMPTY);
  const [page, setPage] = useState<Page | undefined>(undefined);
  const [panel, setPanel] = useState(false);
  /** The bot whose own choices Settings opens on (the side panel's settings button), if any. */
  const [settingsBot, setSettingsBot] = useState<string | undefined>(undefined);
  const [, setTick] = useState(0);
  useEffect(() => {
    void bridge().view().then(setView);
    return bridge().onView(setView);
  }, []);
  // The times beside the rows move on.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  // The first bot opens by itself; a removed bot's page goes back to the first.
  const shown: Page | undefined = page !== undefined && ("page" in page || view.bots.some((b) => b.id === page.bot)) ? page : view.bots[0] !== undefined ? { bot: view.bots[0].id } : undefined;
  const showingKey = shown === undefined ? "none" : "bot" in shown ? `bot:${shown.bot}` : `page:${shown.page}`;
  useEffect(() => {
    // Presence: main checks the bot against the ones it knows and reports it with the window's focus (§3.5).
    bridge().showing(shown === undefined ? { page: "none" } : "bot" in shown ? { bot: shown.bot } : { page: shown.page });
  }, [showingKey]);
  if (typeof __MOSS_TEST_BUILD__ === "string") {
    // The test build's hook for the UI test and the renders: open a bot, its panel or a page, and hold the faces still.
    (window as unknown as { __mossTest: unknown }).__mossTest = {
      go: (g: { bot?: string; panel?: boolean; page?: "plugins" | "settings"; calm?: boolean }) => {
        if (g.calm !== undefined) faceMotion.calm = g.calm;
        if (g.page !== undefined) { setSettingsBot(g.page === "settings" ? g.bot : undefined); setPage({ page: g.page }); }
        else if (g.bot !== undefined && g.bot !== "") setPage({ bot: g.bot });
        if (g.panel !== undefined) setPanel(g.panel);
      },
    };
  }
  const bot = shown !== undefined && "bot" in shown ? view.bots.find((b) => b.id === shown.bot) : undefined;
  const names = useMemo(() => new Map(view.bots.map((b) => [b.id, b.name])), [view.bots]);
  const inConversation = bot === undefined ? [] : view.cards.filter((c) => c.place === "conversation" && c.bot === bot.id);
  // The strip: every card the router placed in this window that this conversation doesn't draw.
  const stripCards = view.cards.filter((c) => !inConversation.includes(c));
  const strip = <Strip cards={stripCards} botName={(id) => names.get(id)} onOpen={(id) => setPage({ bot: id })} />;
  const banner = CONNECTION_WORDS[view.connection.kind];
  return (
    <div className={`window${bot !== undefined && panel ? " has-panel" : ""}`}>
      <BotList view={view} page={shown ?? { page: "plugins" }} onPage={(p) => { setSettingsBot(undefined); setPage(p); }} />
      <div className="middle">
        {banner !== "" ? <p className="banner" role="status">{view.connection.reason ?? banner}</p> : null}
        {shown !== undefined && "page" in shown && shown.page === "plugins" ? <PluginsPage strip={strip} />
          : shown !== undefined && "page" in shown && shown.page === "settings" ? <SettingsPage bots={view.bots} strip={strip} {...(settingsBot !== undefined ? { bot: settingsBot } : {})} />
          : bot !== undefined ? <Conversation bot={bot} cards={inConversation} strip={strip} panelOpen={panel} onPanel={() => setPanel((p) => !p)} />
          : <main className="conversation conversation--empty" data-col="conversation">{strip}<p className="muted">{view.pieces.bots === "waiting" ? "Waiting for the engine's bots." : "Make a bot with + to start."}</p></main>}
      </div>
      {bot !== undefined && panel ? <SidePanel bot={bot} onClose={() => setPanel(false)} onSettings={() => { setSettingsBot(bot.id); setPage({ page: "settings" }); }} /> : null}
    </div>
  );
}

const root = document.getElementById("moss");
if (root !== null) createRoot(root).render(<App />);
