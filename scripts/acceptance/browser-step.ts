// The bots' Browser tool on the real path, against the run's own fixture site (never the live web, never the owner's own
// browser or its profile): Alpha's session calls `Browser` through the fake model's tool_use, the core's turn loop, the
// plugin host, the tool's host half, `api.browser.*` (the core's browser service) and the app's browser host, which
// draws the page offscreen in the bot's own partition. The fixture is a local server the app reaches by NAME
// (`CLOVER_TEST_BROWSER_NAMES`, apps/desktop/src/main/browser/test-names.ts: a test or acceptance build only): the name
// resolves to a public-kind address and is dialled to this server, so the network filter judges it as any web address.
// Loopback itself stays refused to a bot's tab, and a row below holds that.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { callTurn, until, type ExampleCtx } from "./example-steps";
import { islandShooter, islandUsageText, settingsDrawnProblem, settingsUsageText, usageDrawnProblem } from "./usage-drawn";

export const BROWSER_STEP = "the bot's Browser tool opens a fixture page in its own tab (drawn offscreen), reads its text and elements, takes a picture, navigates it (one tab), is refused a loopback address, and its first click on a site raises one card (Always allow kept for that bot and site), its next click there raises none, and a click on another site asks again; the bundled panel's layer lists that tab, shows it, hears the change as an event and hides it; and the usage plugin's layer reads the bot's counted tokens, which its Settings section and island tab draw";

export const FIXTURE_NAME = "browser-fixture.test";
/** A second name for the same server: another site, as the browser and the approval judge it. */
export const OTHER_NAME = "browser-other.test";

export interface BrowserFixture {
  /** The app's `CLOVER_TEST_BROWSER_NAMES` value. */
  readonly names: string;
  /** The address of the fixture as a bot is told it. */
  readonly url: string;
  /** The same page under the other name: another site. */
  readonly otherUrl: string;
  /** Every request the fixture saw: its path and the User-Agent. */
  readonly seen: { path: string; agent: string }[];
  /** The loopback address of the same server: what a bot's tab must be refused. */
  readonly loopbackUrl: string;
  stop(): void;
}

const HOME = `<!doctype html><meta charset="utf-8"><title>Browser fixture home</title>
<h1>Browser fixture home</h1>
<p>This page is served by the acceptance run, nothing else.</p>
<a href="/second">Go to the second page</a>
<form onsubmit="return false"><label>Name <input aria-label="Name" type="text"></label><button type="button" onclick="document.getElementById('said').textContent='hello was clicked'">Say hello</button></form>
<p id="said"></p>`;
const SECOND = `<!doctype html><meta charset="utf-8"><title>Browser fixture second</title><h1>Browser fixture second page</h1><p>You followed the link.</p>`;

export function startBrowserFixture(): BrowserFixture {
  const seen: { path: string; agent: string }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req) {
      const u = new URL(req.url);
      seen.push({ path: u.pathname, agent: req.headers.get("user-agent") ?? "" });
      const html = u.pathname === "/" ? HOME : u.pathname === "/second" ? SECOND : undefined;
      return html === undefined ? new Response("not found", { status: 404 }) : new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  return { names: `${FIXTURE_NAME}=${server.port};${OTHER_NAME}=${server.port}`, url: `http://${FIXTURE_NAME}:${server.port}/`, otherUrl: `http://${OTHER_NAME}:${server.port}/`, seen, loopbackUrl: `http://127.0.0.1:${server.port}/`, stop: () => server.stop(true) };
}

class Failed extends Error {}
const fail = (m: string): never => { throw new Failed(m); };

/** One `Browser` call; its text, or its refusal. */
async function browse(ctx: ExampleCtx, session: string, input: Record<string, unknown>, opts: { always?: boolean } = {}) {
  const r = await callTurn(ctx, session, "Browser", input, opts);
  return { text: r.result.text.replace(/\s+/g, " ").trim(), isError: r.result.isError, cards: r.cards };
}

/** The bundled panel's layer connection, as its component's plugin makes it: opened by the run through the app's `layer.token`. */
export interface PanelLink {
  request(method: string, params?: unknown): Promise<unknown>;
  /** The `core.event`s of `type` heard so far. */
  heard(type: string): { type: string; tab?: { id: string; place?: string } }[];
  close(): void;
}

export async function browserStep(ctx: ExampleCtx, session: string, fixture: BrowserFixture, openLayer?: (pluginId: string) => Promise<PanelLink>): Promise<string> {
  const lines: string[] = [];
  // 1. Open the fixture page in the bot's own tab.
  const opened = await browse(ctx, session, { verb: "open", url: fixture.url });
  if (opened.isError) fail(`open: ${opened.text.slice(0, 300)}`);
  lines.push(`open: ${opened.text.slice(0, 80)}`);
  // 2. Read it: its heading and its link and field as elements.
  const read = await browse(ctx, session, { verb: "read" });
  if (read.isError || !/Browser fixture home/.test(read.text) || !/Go to the second page/.test(read.text) || !/Name/.test(read.text)) fail(`read: ${read.text.slice(0, 400)}`);
  lines.push("read: the heading, the link and the field");
  // 3. A picture of it.
  const shot = await browse(ctx, session, { verb: "screenshot" });
  if (shot.isError) fail(`screenshot: ${shot.text.slice(0, 300)}`);
  lines.push(`screenshot: ${shot.text.slice(0, 60)}`);
  // 4. Navigate it (one tab per bot: the same tab), and read the second page.
  const nav = await browse(ctx, session, { verb: "navigate", url: `${fixture.url}second` });
  if (nav.isError) fail(`navigate: ${nav.text.slice(0, 300)}`);
  const second = await browse(ctx, session, { verb: "read" });
  if (second.isError || !/Browser fixture second page/.test(second.text)) fail(`read after navigate: ${second.text.slice(0, 400)}`);
  lines.push("navigate: the second page");
  const tabs = await browse(ctx, session, { verb: "tabs" });
  if (tabs.isError || (tabs.text.match(/tab_/g) ?? []).length !== 1) fail(`tabs: one tab per bot expected: ${tabs.text.slice(0, 300)}`);
  lines.push("one tab");
  // 5. The server saw a real browser's requests, and only for the fixture's own paths.
  const paths = fixture.seen.map((s) => s.path);
  if (!paths.includes("/") || !paths.includes("/second")) fail(`the fixture saw ${paths.join(", ") || "nothing"}: the page was not loaded by the app's browser`);
  if (!fixture.seen.some((s) => /Chrome|Electron/.test(s.agent))) fail(`no request came from a browser (${fixture.seen.map((s) => s.agent.slice(0, 30)).join(" | ")})`);
  lines.push(`the fixture saw ${paths.length} request(s) from the browser`);
  // 6. Loopback is refused to a bot's tab, whatever the name: the filter's rule holds.
  const before = fixture.seen.length;
  const loop = await browse(ctx, session, { verb: "navigate", url: fixture.loopbackUrl });
  const reached = fixture.seen.length > before;
  if (reached) fail(`a bot's tab reached the loopback address (${fixture.loopbackUrl}): ${loop.text.slice(0, 200)}`);
  lines.push("loopback refused");
  // 7. Acting: one card per bot and site. Looking above raised none; the first click on this site asks, and "Always allow"
  // keeps the answer for this bot and site; the next click here runs with no card; the same page under another name is
  // another site and asks again.
  const looked = fixture.seen.length;
  if (looked === 0) fail("the fixture saw nothing before the acting clauses");
  const buttonRef = async (url: string): Promise<string> => {
    const nav = await browse(ctx, session, { verb: "navigate", url });
    if (nav.isError) fail(`navigate ${url}: ${nav.text.slice(0, 200)}`);
    if (nav.cards.length > 0) fail(`navigate (a looking verb) raised ${nav.cards.join("; ")}`);
    const page = await browse(ctx, session, { verb: "read" });
    // A read lists each element as `<ref> <role> "<name>" at …`: the button's own line, not the first ref on the page (the link's).
    const m = /\b(e\d+) button "Say hello"/.exec(page.text);
    if (page.isError || m === null) fail(`read of ${url} showed no "Say hello" element: ${page.text.slice(0, 300)}`);
    return m![1]!;
  };
  const ref = await buttonRef(fixture.url);
  const first = await browse(ctx, session, { verb: "click", ref }, { always: true });
  if (first.isError) fail(`the first click: ${first.text.slice(0, 300)}`);
  if (first.cards.length !== 1 || !first.cards[0]!.includes("Always allow")) fail(`the first click on a site raised ${first.cards.length} card(s) (${first.cards.join("; ") || "none"}), not the one card answered with Always allow`);
  // The click reached the button (the page says so), and the page is still the one that was read.
  const afterClick = await browse(ctx, session, { verb: "read" });
  if (afterClick.isError || !/hello was clicked/.test(afterClick.text)) fail(`the first click did not reach the button: the page reads ${afterClick.text.slice(0, 300)}; the click said: ${first.text.slice(0, 200)}; the fixture's last requests: ${fixture.seen.slice(-6).map((r) => r.path).join(" ")}`);
  const again = await browse(ctx, session, { verb: "click", ref });
  if (again.isError || again.cards.length > 0) fail(`the next click on the same site: ${again.cards.length} card(s) (${again.cards.join("; ")}), ${again.text.slice(0, 200)}`);
  const otherRef = await buttonRef(fixture.otherUrl);
  const other = await browse(ctx, session, { verb: "click", ref: otherRef });
  if (other.cards.length !== 1) fail(`a click on another site raised ${other.cards.length} card(s) (${other.cards.join("; ") || "none"}), not one`);
  lines.push("click: one card on the first site (Always allow kept), none on the next, one on another site");
  // 8. The person's panel (the bundled browser view's own layer): it lists the bot's tab, places it in its view and hears
  // that change as an event, takes it back out of sight; the tab stays the bot's and draws nothing on screen of its own.
  if (openLayer === undefined) lines.push("panel: not run here (this target has no layer token door)");
  else {
    const back = await browse(ctx, session, { verb: "navigate", url: fixture.url });
    if (back.isError) fail(`navigate before the panel: ${back.text.slice(0, 200)}`);
    const panel = await openLayer("clover/browser-view");
    try {
      await panel.request("events.subscribe", { areas: ["browser"] });
      const listed = (await panel.request("browser.tabs", { owner: { kind: "bot", bot: "alpha" } })) as { tabs: { id: string; place: string }[] };
      if (listed.tabs.length !== 1 || listed.tabs[0]!.place !== "headless") fail(`the panel saw ${JSON.stringify(listed.tabs).slice(0, 300)}, not the bot's one tab out of sight`);
      const id = listed.tabs[0]!.id;
      const shown = (await panel.request("browser.show", { id, view: "browser", viewport: { width: 800, height: 600 } })) as { tab: { place: string } };
      if (shown.tab.place !== "shown") fail(`browser.show left the tab ${shown.tab.place}`);
      const deadline = Date.now() + 10_000;
      while (!panel.heard("tab_changed").some((e) => e.tab?.id === id && e.tab.place === "shown") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      if (!panel.heard("tab_changed").some((e) => e.tab?.id === id && e.tab.place === "shown")) fail("the panel heard no tab_changed for the tab it showed");
      const hidden = (await panel.request("browser.hide", { id })) as { tab: { place: string } };
      if (hidden.tab.place !== "headless") fail(`browser.hide left the tab ${hidden.tab.place}`);
      lines.push("panel: lists the bot's tab, shows it (the change reaches the panel as an event), hides it again");
    } finally {
      panel.close();
    }
  }
  // 9. The turns above were counted: the usage plugin's own layer (capability `usage.read`) reads the day's usage grouped by
  // bot and finds Alpha's tokens, as its island tab and its Settings section do (row 4.19; the tab and section's drawing is held
  // by the plugin's component tests).
  if (openLayer === undefined) lines.push("usage: not run here (this target has no layer token door)");
  else {
    const usage = await openLayer("clover/usage");
    try {
      const deadline = Date.now() + 20_000;
      let alpha: { key: string; inputTokens: number; outputTokens: number } | undefined;
      while (alpha === undefined && Date.now() < deadline) {
        const r = (await usage.request("usage.summary", { from: Date.now() - 24 * 3_600_000, to: Date.now() + 3_600_000, groupBy: "bot" })) as { groups: { key: string; inputTokens: number; outputTokens: number }[] };
        alpha = r.groups.find((g) => g.key === "alpha" && g.inputTokens + g.outputTokens > 0);
        if (alpha === undefined) await new Promise((r2) => setTimeout(r2, 1000));
      }
      if (alpha === undefined) fail("the usage plugin's layer found no tokens for alpha after the turns (usage.summary grouped by bot)");
      lines.push(`usage: the usage plugin's layer reads ${alpha!.inputTokens} in / ${alpha!.outputTokens} out for alpha`);
    } finally {
      usage.close();
    }
  }
  // 10. The same usage, as drawn: the Settings window's Usage section, and the island's Usage tab while a card keeps the island
  // open (the click on the other site raises one; it is pressed after the tab is read). Offscreen, in the app's own frames.
  if (ctx.inspectTurn === undefined) lines.push("usage drawn: not run here (this run has no inspected turn)");
  else {
    // A third-party plugin's tab, installed from its folder and OK'd on its card: it sits on the island's dots beside Usage and
    // Devices, labelled with its plugin's name, and is drawn by its own frame.
    const tabId = "acceptance-tab";
    const tabFolder = join(import.meta.dir, "fixtures", tabId);
    if (!existsSync(join(tabFolder, "client", "index.tsx"))) fail("the third-party tab fixture is missing");
    await ctx.rpc.request("plugin.install", { source: { from: "folder", path: tabFolder } }, 60_000);
    const okCard = await until("the third-party tab's OK card", 60_000, async () => (await ctx.rpc.request<{ cards: { id: string; kind: string; pluginId?: string }[] }>("card.list")).cards.find((c) => c.kind === "plugin-ok" && c.pluginId === tabId));
    const okText = JSON.stringify((await ctx.rpc.request<{ card: unknown }>("card.get", { id: okCard.id })).card);
    await ctx.pressCard("the third-party tab's OK card", (c) => c.id === okCard.id);
    await until("the third-party tab's plugin running", 60_000, async () => ((await ctx.rpc.request<{ plugin: { state: string } }>("plugin.get", { id: tabId }).catch(() => undefined))?.plugin.state === "running" ? true : undefined));
    lines.push(`third-party tab OK card says: ${okText.replace(/\s+/g, " ").slice(0, 600)}`);
    const settings = await settingsUsageText(ctx.cdp).catch((e: unknown) => fail(`the Settings Usage section: ${(e as Error).message}`));
    const settingsProblem = settingsDrawnProblem(settings);
    if (settingsProblem !== undefined) fail(`the Settings Usage section drew, but ${settingsProblem}`);
    const otherButton = await buttonRef(fixture.otherUrl);
    let island: string | undefined;
    let islandError: string | undefined;
    await ctx.inspectTurn(session, `ACCEPTANCE-CALL Browser ${JSON.stringify({ verb: "click", ref: otherButton })}`, 150_000, async () => {
      const renders = process.env.CLOVER_ACCEPT_RENDERS;
      const shooter = renders ? islandShooter(ctx.cdp, renders, ctx.setAppearance) : undefined;
      try { island = await islandUsageText(ctx.cdp, shooter?.shoot, { label: "Weather · Acceptance tab", words: "21 degrees and clear" }); } catch (e) { islandError = (e as Error).message; }
      await shooter?.done();
    });
    if (islandError !== undefined || island === undefined) fail(`the island's Usage tab: ${islandError ?? "the click raised no card to hold the island open"}`);
    const islandProblem = usageDrawnProblem(island!);
    if (islandProblem !== undefined) fail(`the island's Usage tab drew, but ${islandProblem}`);
    lines.push("usage drawn: the Settings Usage section and the island's Usage tab show Clover's counted tokens; a third-party plugin's tab sits on the dots and draws its own words");
    // Removed again, so no later step meets its tab.
    const gone = await ctx.rpc.request<{ card?: string }>("plugin.remove", { id: tabId }).catch(() => undefined);
    if (gone?.card !== undefined) await ctx.pressCard("the third-party tab's removal card", (c) => c.id === gone.card);
  }
  // Closed again, so no later step meets the tab.
  await browse(ctx, session, { verb: "tabs" }).catch(() => undefined);
  return lines.join("; ");
}
