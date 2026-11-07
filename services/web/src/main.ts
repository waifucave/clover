// The web companion's page (spec §8.4): pair once with a computer from the link it shows, then chat with its bots
// over a direct WebRTC link. What the page may do is the core's `web` call list (chat and read-only activity, spec
// §14 item 5); the computer refuses anything else. Everything is drawn with textContent: nothing from the computer or
// the URL is ever parsed as HTML.

import { Companion, type Connection, PairingError, type PairRecord } from "./app";
import { DEFAULT_ICE_SERVERS, readInvite, type RtcEnvironment, type StreamCodec } from "../protocol";
import { IndexedDbStore } from "./store";
import { type BrowserTab, decodableCodecs, ownerLabel, TabList, TabStreamInbox, tabTitle, TabWatch, type WatchState } from "./tabs";

interface PageConfig {
  handshake: string;
  allowedHandshakes?: string[];
}

interface BotView {
  id: string;
  name: string;
  mainSession: string;
  state?: string;
}

const app = document.getElementById("app")!;
const status = document.getElementById("status")!;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: { text?: string; className?: string } = {}, ...children: Node[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.text !== undefined) node.textContent = props.text;
  if (props.className) node.className = props.className;
  for (const child of children) node.append(child);
  return node;
}

function button(text: string, onClick: () => void, primary = false): HTMLButtonElement {
  const b = el("button", { text, ...(primary ? { className: "primary" } : {}) });
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

/** What the current screen lets go of when the page moves on (a tab list's events, a watched tab's stream). */
let leaveScreen: (() => void) | null = null;

function show(...nodes: Node[]): void {
  const leave = leaveScreen;
  leaveScreen = null;
  leave?.();
  app.replaceChildren(...nodes);
}

// Closing or leaving the page stops a watched tab's stream on the computer too.
addEventListener("pagehide", () => {
  const leave = leaveScreen;
  leaveScreen = null;
  leave?.();
});

function setStatus(text: string): void {
  status.textContent = text;
}

/** "Firefox on Linux", from what the browser says about itself. */
function browserName(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "A browser";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

const rtc: RtcEnvironment = {
  createPeerConnection: (config) => new RTCPeerConnection(config) as unknown as ReturnType<RtcEnvironment["createPeerConnection"]>,
  iceServers: DEFAULT_ICE_SERVERS,
};

let companion: Companion;
let connection: Connection | null = null;
/** The connection's `browser.stream` streams, to the watched tab (one per link). */
let inbox: TabStreamInbox | null = null;
/** What this browser decodes: asked once, as the page loads, and kept. */
let codecs: StreamCodec[] | Promise<StreamCodec[]> | null = null;
function browserCodecs(): StreamCodec[] | Promise<StreamCodec[]> {
  if (codecs === null) {
    const asked = decodableCodecs().then(
      (c) => (codecs = c),
      () => (codecs = ["jpeg"] as StreamCodec[]),
    );
    codecs = asked;
  }
  return codecs;
}

function closeConnection(): void {
  inbox?.close();
  inbox = null;
  connection?.close();
  connection = null;
}

async function main(): Promise<void> {
  const config = (await (await fetch("/config.json")).json()) as PageConfig;
  companion = new Companion({
    store: new IndexedDbStore(),
    rtc,
    handshake: config.handshake,
    ...(config.allowedHandshakes ? { allowedHandshakes: config.allowedHandshakes } : {}),
    name: browserName(),
  });
  const invite = readInvite(location.hash);
  // The invite's secret leaves the address bar at once: it is only needed for this one pairing.
  if (location.hash) history.replaceState(null, "", location.pathname);
  void browserCodecs();
  if (invite) return pairScreen(invite);
  return home();
}

async function home(): Promise<void> {
  setStatus("");
  const paired = await companion.paired();
  if (paired.length === 0) {
    show(
      el(
        "div",
        { className: "card" },
        el("h2", { text: "Pair this browser" }),
        el("p", { text: "On your computer, open Clover's Devices and choose Add a browser. Then open the link it shows here, or scan its code." }),
      ),
    );
    return;
  }
  const list = el("ul", { className: "list" });
  for (const record of paired) {
    list.append(el("li", {}, el("span", { text: record.computerName }), button("Connect", () => void connect(record), true)));
  }
  show(el("div", { className: "card" }, el("h2", { text: "Your computers" }), list));
  if (paired.length === 1) void connect(paired[0]!);
}

function pairScreen(invite: NonNullable<ReturnType<typeof readInvite>>): void {
  const computer = invite.name ?? "your computer";
  const go = button(`Pair with ${computer}`, () => void pair(), true);
  show(el("div", { className: "card" }, el("h2", { text: `Pair with ${computer}` }), el("p", { text: "This lets this browser chat with your bots on that computer." }), go));

  async function pair(): Promise<void> {
    go.disabled = true;
    setStatus("Pairing…");
    try {
      const record = await companion.pair(invite, {
        onWords: (words) =>
          show(
            el(
              "div",
              { className: "card" },
              el("h2", { text: "Check the words" }),
              el("p", { text: `${computer} should show these four words. If they match, confirm there.` }),
              el("div", { className: "words" }, ...words.map((w) => el("span", { text: w }))),
              el("p", { className: "muted", text: "Waiting for your confirmation on the computer…" }),
            ),
          ),
      });
      setStatus("Paired");
      await connect(record);
    } catch (err) {
      setStatus("");
      const message =
        err instanceof PairingError && err.code === "expired"
          ? "This pairing link has expired. Make a new one on your computer."
          : err instanceof PairingError && err.code === "refused"
            ? "Pairing was declined or ended on the computer."
            : "Pairing didn't work. Make a new link on your computer and try again.";
      show(el("div", { className: "card" }, el("p", { className: "error", text: message })));
    }
  }
}

async function connect(record: PairRecord): Promise<void> {
  closeConnection();
  setStatus(`Connecting to ${record.computerName}…`);
  try {
    connection = await companion.connect(record, { onEnded: () => void home() });
  } catch {
    setStatus(`${record.computerName} isn't reachable`);
    show(
      el(
        "div",
        { className: "card" },
        el("p", { text: `Couldn't reach ${record.computerName}. It may be asleep or offline.` }),
        button("Try again", () => void connect(record), true),
        button("Forget this computer", () => void forget(record)),
      ),
    );
    return;
  }
  setStatus(`Connected to ${record.computerName}`);
  connection.link.onClose(() => {
    setStatus(`Disconnected from ${record.computerName}`);
  });
  await bots(record);
}

async function forget(record: PairRecord): Promise<void> {
  closeConnection();
  await companion.forget(record);
  await home();
}

async function bots(record: PairRecord): Promise<void> {
  const link = connection!.link;
  const { bots } = await link.request<{ bots: BotView[] }>("bot.list", {});
  const list = el("ul", { className: "list" });
  for (const bot of bots) list.append(el("li", {}, el("span", { text: bot.name }), button("Open", () => void chat(record, bot), true)));
  if (bots.length === 0) list.append(el("li", { className: "muted", text: "No bots yet." }));
  show(
    el("div", { className: "card" }, el("h2", { text: "Bots" }), list),
    el("div", { className: "actions" }, button("Browser tabs", () => void tabs(record, bots)), button("Forget this computer", () => void forget(record))),
  );
}

/** The computer's open tabs, kept current; each can be watched live. */
async function tabs(record: PairRecord, botList: BotView[]): Promise<void> {
  const link = connection!.link;
  const names = new Map(botList.map((b) => [b.id, b.name]));
  const list = el("ul", { className: "list tabs" });
  const note = el("p", { className: "muted", text: "Loading…" });
  const draw = (all: BrowserTab[]) => {
    note.textContent = all.length === 0 ? `No tabs are open on ${record.computerName}.` : "";
    list.replaceChildren(
      ...all.map((tab) => {
        const where = tab.heldByUser ? "In use on the computer" : tab.place === "shown" ? "Shown on the computer" : "";
        return el(
          "li",
          {},
          el(
            "div",
            { className: "tab" },
            el("span", { className: "title", text: tabTitle(tab) }),
            el("span", { className: "url", text: tab.url }),
            el("span", { className: "muted", text: [ownerLabel(tab.owner, names), where].filter(Boolean).join(" · ") }),
          ),
          button("Watch", () => void watch(record, botList, tab), true),
        );
      }),
    );
  };
  const tabList = new TabList(link, draw);
  show(
    el("div", { className: "card" }, el("h2", { text: `Tabs on ${record.computerName}` }), note, list),
    el("div", { className: "actions" }, button("All bots", () => void bots(record))),
  );
  leaveScreen = () => void tabList.close();
  try {
    await tabList.open();
  } catch {
    note.textContent = `${record.computerName} didn't list its tabs.`;
  }
}

/** One tab, live. Viewing only: nothing done here reaches the tab. */
async function watch(record: PairRecord, botList: BotView[], tab: BrowserTab): Promise<void> {
  const link = connection!.link;
  inbox ??= new TabStreamInbox(link);
  const canvas = el("canvas", { className: "live" });
  canvas.setAttribute("aria-label", `${tabTitle(tab)}, live from ${record.computerName}`);
  const ctx = canvas.getContext("2d");
  const said = el("p", { className: "muted", text: "Starting…" });
  const say = (state: WatchState) => {
    said.textContent =
      state.kind === "starting" ? "Starting…"
      : state.kind === "live" ? `Live from ${record.computerName}. Viewing only.`
      : state.kind === "ended" ? (state.reason === "closed" ? "The tab was closed." : state.reason === "stopped" ? "The stream stopped." : `The stream failed${state.message ? `: ${state.message}` : "."}`)
      : `Can't show this tab: ${state.message}`;
  };
  // The screen is drawn at once; the watch waits for the codecs itself, and asks nothing if the person left meanwhile.
  const watching = new TabWatch(link, inbox, tab.id, {
    codecs: browserCodecs(),
    onState: say,
    onPicture: (p) => {
      if (canvas.width !== p.width || canvas.height !== p.height) {
        canvas.width = p.width;
        canvas.height = p.height;
      }
      ctx?.drawImage(p.image, 0, 0);
      p.close();
    },
  });
  show(
    el("div", { className: "card" }, el("h2", { text: tabTitle(tab) }), el("p", { className: "url", text: tab.url }), canvas, said),
    el("div", { className: "actions" }, button("Back to tabs", () => void tabs(record, botList))),
  );
  leaveScreen = () => void watching.leave();
  await watching.start();
}

/** One line of the transcript from a session event, when it carries text. */
function line(event: Record<string, unknown>): HTMLElement | null {
  const text = typeof event.text === "string" ? event.text : typeof event.content === "string" ? event.content : null;
  if (!text) return null;
  const user = typeof event.type === "string" && event.type.startsWith("user");
  return el("div", { className: user ? "msg user" : "msg" }, el("span", { className: "who", text: user ? "You" : String(event.type ?? "") }), document.createTextNode(text));
}

async function chat(record: PairRecord, bot: BotView): Promise<void> {
  const link = connection!.link;
  const transcript = el("div", { className: "transcript" });
  const input = el("textarea");
  input.placeholder = `Message ${bot.name}`;
  input.rows = 2;
  const send = el("button", { text: "Send", className: "primary" });
  send.type = "submit";
  const composer = el("form", { className: "composer" }, input, send);
  show(el("div", { className: "card" }, el("h2", { text: bot.name }), transcript, composer), el("div", {}, button("All bots", () => void bots(record))));

  const append = (event: Record<string, unknown>) => {
    const node = line(event);
    if (!node) return;
    transcript.append(node);
    transcript.scrollTop = transcript.scrollHeight;
  };
  // Listeners first, so nothing typed or streamed while the history loads is lost.
  link.onNotify("event", (event) => {
    const e = event as Record<string, unknown>;
    if (e.sessionId === undefined || e.sessionId === bot.mainSession) append(e);
  });
  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    const clientMessageId = crypto.randomUUID();
    void link.request("session.send", { id: bot.mainSession, message: { text, clientMessageId, sentAt: Date.now() } }).catch(() => {
      append({ type: "error", text: "Not sent: the computer couldn't be reached." });
    });
  });
  const history = await link.request<{ events: Record<string, unknown>[] }>("session.history", { id: bot.mainSession, limit: 50 });
  transcript.prepend(...history.events.map(line).filter((n): n is HTMLElement => n !== null));
  await link.request("session.attach", { id: bot.mainSession });
}

void main().catch(() => show(el("div", { className: "card" }, el("p", { className: "error", text: "Something went wrong loading the page." }))));
