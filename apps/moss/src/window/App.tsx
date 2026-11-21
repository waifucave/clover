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
import { SetupGuide, type SetupStep } from "./setup/SetupGuide";
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
  /** The setup guide: `auto` until the engine's setup says whether it opens by itself; `open` once shown (it stays
   *  until the person finishes or skips it, even as the setup gets ready under it); `closed` after. Settings opens it. */
  const [guide, setGuide] = useState<"auto" | "open" | "closed">("auto");
  const [guideStep, setGuideStep] = useState<SetupStep | undefined>(undefined);
  useEffect(() => {
    if (guide === "auto" && view.setup !== undefined && !view.setup.ready && !view.setup.dismissed) setGuide("open");
  }, [guide, view.setup?.ready, view.setup?.dismissed]);
  /** The test build's renders may draw a page without the strip, so the page itself shows whole. */
  const [stripShown, setStripShown] = useState(true);
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
      go: (g: { bot?: string; panel?: boolean; page?: "plugins" | "settings"; calm?: boolean; strip?: boolean; guide?: SetupStep | false }) => {
        if (g.calm !== undefined) faceMotion.calm = g.calm;
        if (g.guide !== undefined) { setGuideStep(g.guide === false ? undefined : g.guide); setGuide(g.guide === false ? "closed" : "open"); }
        setStripShown(g.strip !== false);
        if (g.page !== undefined) { setSettingsBot(g.page === "settings" ? g.bot : undefined); setPage({ page: g.page }); }
        else if (g.bot !== undefined && g.bot !== "") setPage({ bot: g.bot });
        if (g.panel !== undefined) setPanel(g.panel);
      },
    };
  }
  const bot = shown !== undefined && "bot" in shown ? view.bots.find((b) => b.id === shown.bot) : undefined;
  /** The default bot (MOSS, id alpha, `default-bot.ts`), else the first: where the finished setup guide lands. */
  const defaultBot = view.bots.find((b) => b.id === "alpha") ?? view.bots[0];
  const names = useMemo(() => new Map(view.bots.map((b) => [b.id, b.name])), [view.bots]);
  const inConversation = bot === undefined ? [] : view.cards.filter((c) => c.place === "conversation" && c.bot === bot.id);
  // The strip: every card the router placed in this window that this conversation doesn't draw.
  const stripCards = view.cards.filter((c) => !inConversation.includes(c));
  const guideAside = view.cards.length > 0 || view.setupWaits === true;
  const strip = !stripShown ? null : <Strip cards={stripCards} botName={(id) => names.get(id)} onOpen={(id) => setPage({ bot: id })} />;
  const banner = CONNECTION_WORDS[view.connection.kind];
  return (
    <div className={`window${bot !== undefined && panel ? " has-panel" : ""}`}>
      <BotList view={view} page={shown ?? { page: "plugins" }} onPage={(p) => { setSettingsBot(undefined); setPage(p); }} />
      <div className="middle">
        {banner !== "" ? <p className="banner" role="status">{view.connection.reason ?? banner}</p> : null}
        {view.notice !== undefined ? <p className="banner banner--notice" role="status" data-notice>{view.notice}</p> : null}
        {shown !== undefined && "page" in shown && shown.page === "plugins" ? <PluginsPage strip={strip} />
          : shown !== undefined && "page" in shown && shown.page === "settings" ? <SettingsPage bots={view.bots} strip={strip} onSetupGuide={() => { setGuideStep("providers"); setGuide("open"); }} {...(settingsBot !== undefined ? { bot: settingsBot } : {})} />
          : bot !== undefined ? <Conversation bot={bot} cards={inConversation} strip={strip} panelOpen={panel} onPanel={() => setPanel((p) => !p)} {...(view.talk !== undefined ? { talk: view.talk } : {})} />
          : <main className="conversation conversation--empty" data-col="conversation">{strip}<p className="muted">{view.pieces.bots === "waiting" ? "Waiting for the engine's bots." : "Make a bot with + to start."}</p></main>}
      </div>
      {guide === "open" ? (
        // A card waiting in this window (an approval, a plugin's OK, the old home's copy) comes first: the guide, which
        // covers the whole window, steps aside (kept as it is, its step too) and is back once no card waits.
        <div className="setup-holder" hidden={guideAside} data-setup-aside={guideAside ? "yes" : "no"}>
        <SetupGuide
          setup={view.setup} botName={defaultBot?.name ?? "your bot"} {...(guideStep !== undefined ? { initialStep: guideStep } : {})}
          onClose={() => setGuide("closed")}
          onDone={() => {
            setGuide("closed");
            if (defaultBot !== undefined) setPage({ bot: defaultBot.id });
            // Ready to type: the composer takes the focus once her conversation is drawn.
            setTimeout(() => document.querySelector<HTMLTextAreaElement>("[data-composer] textarea")?.focus(), 50);
          }}
        />
        </div>
      ) : null}
      {bot !== undefined && panel ? <SidePanel bot={bot} cardsKey={view.cards.map((c) => c.id).join(",")} onClose={() => setPanel(false)} onSettings={() => { setSettingsBot(bot.id); setPage({ page: "settings" }); }} /> : null}
    </div>
  );
}

const root = document.getElementById("moss");
if (root !== null) createRoot(root).render(<App />);
