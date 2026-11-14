// The bots' Browser tool on the real path, against the run's own fixture site (never the live web, never the owner's own
// browser or its profile): Alpha's session calls `Browser` through the fake model's tool_use, the core's turn loop, the
// plugin host, the tool's host half, `api.browser.*` (the core's browser service) and the app's browser host, which
// draws the page offscreen in the bot's own partition. The fixture is a local server the app reaches by NAME
// (`CLOVER_TEST_BROWSER_NAMES`, apps/desktop/src/main/browser/test-names.ts: a test or acceptance build only): the name
// resolves to a public-kind address and is dialled to this server, so the network filter judges it as any web address.
// Loopback itself stays refused to a bot's tab, and a row below holds that.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callTurn, until, type ExampleCtx } from "./example-steps";
import { islandCardHolds, islandDrawsOkCard, islandShooter, islandUsageText, settingsDrawnProblem, settingsUsageText, usageDrawnProblem } from "./usage-drawn";

export const BROWSER_STEP = "the bot's Browser tool opens a fixture page in its own tab (drawn offscreen), reads its text and elements, takes a picture, navigates it (one tab), is refused a loopback address, and its first click on a site raises one card (Always allow kept for that bot and site), its next click there raises none, and a click on another site asks again; the bundled panel's layer lists that tab, shows it, hears the change as an event and hides it; the diff panel's layer reads a coding session's changed and new file and the column's layer its outputs, context and connectors; and the usage plugin's layer reads the bot's counted tokens, which its Settings section and island tab draw";

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
  heard(type: string): { type: string; tab?: { id: string; place?: string }; watch?: string; value?: { method?: string; params?: unknown }; ended?: { reason?: string } }[];
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
  if (openLayer === undefined) fail("panel: this run has no layer token door (the app's layer.token from source, the harness's on a test-marked core)");
  else {
    const back = await browse(ctx, session, { verb: "navigate", url: fixture.url });
    if (back.isError) fail(`navigate before the panel: ${back.text.slice(0, 200)}`);
    const panel = await openLayer("clover/browser-view");
    try {
      await panel.request("events.subscribe", { areas: ["browser", "plugins"] });
      const listed = (await panel.request("browser.tabs", { owner: { kind: "bot", bot: "alpha" } })) as { tabs: { id: string; place: string }[] };
      if (listed.tabs.length !== 1 || listed.tabs[0]!.place !== "headless") fail(`the panel saw ${JSON.stringify(listed.tabs).slice(0, 300)}, not the bot's one tab out of sight`);
      const id = listed.tabs[0]!.id;
      const shown = (await panel.request("browser.show", { id, view: "browser", viewport: { width: 800, height: 600 } })) as { tab: { place: string } };
      if (shown.tab.place !== "shown") fail(`browser.show left the tab ${shown.tab.place}`);
      const deadline = Date.now() + 10_000;
      while (!panel.heard("tab_changed").some((e) => e.tab?.id === id && e.tab.place === "shown") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      if (!panel.heard("tab_changed").some((e) => e.tab?.id === id && e.tab.place === "shown")) fail("the panel heard no tab_changed for the tab it showed");
      // `browser.onCdpEvent` (2.32): the panel's component watches the tab's page events through the core's layer route, and a
      // navigation the person makes in the panel reaches it as Page.* events; only the page's own domain comes through.
      const watch = (await panel.request("plugin.layer.watch", { call: "browser.onCdpEvent", args: [id, null] })) as { watch: string };
      await panel.request("browser.navigate", { id, url: fixture.otherUrl });
      const cdpDeadline = Date.now() + 15_000;
      const cdpHeard = () => panel.heard("plugin_api_event").filter((e) => e.watch === watch.watch && typeof e.value?.method === "string");
      while (!cdpHeard().some((e) => /^Page\.(frameNavigated|loadEventFired|domContentEventFired)$/.test(e.value!.method!)) && Date.now() < cdpDeadline) await new Promise((r) => setTimeout(r, 100));
      const methods = [...new Set(cdpHeard().map((e) => e.value!.method!))];
      if (!methods.some((m) => /^Page\.(frameNavigated|loadEventFired|domContentEventFired)$/.test(m))) fail(`the panel's onCdpEvent heard no page event after a navigation (heard: ${methods.join(", ") || "none"}; every watch event: ${JSON.stringify(panel.heard("plugin_api_event")).slice(0, 400)}; the tab now: ${JSON.stringify(panel.heard("tab_changed").slice(-1)).slice(0, 300)})`);
      if (methods.some((m) => !m.startsWith("Page."))) fail(`the panel's onCdpEvent heard more than the page's own events: ${methods.join(", ")}`);
      await panel.request("plugin.layer.unwatch", { watch: watch.watch });
      const hidden = (await panel.request("browser.hide", { id })) as { tab: { place: string } };
      if (hidden.tab.place !== "headless") fail(`browser.hide left the tab ${hidden.tab.place}`);
      lines.push(`panel: lists the bot's tab, shows it (the change reaches the panel as an event), hears its page events (${methods.slice(0, 3).join(", ")}), hides it again`);
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
  // 9b. The terminal and files panels' own layers (rows 2.33, 4.16, 4.18): each reads the session as its component does
  // (`conversation.get`: the folder and the computer it runs on), then the files panel lists that folder and reads a file in
  // it through `files.*`, and the terminal panel opens a shell there, types a line and hears it come back as `terminal_output`.
  // The diff panel (4.17) reads a coding session's folder changes (`session.diff`), and the slim column its outputs, context
  // and connectors (`session.outputs`/`context`/`connectors`), each from its own layer.
  if (openLayer === undefined) fail("panels: this run has no layer token door");
  else {
    const filesLayer = await openLayer("clover/panel-files");
    try {
      const conv = (await filesLayer.request("plugin.layer.call", { call: "conversation.get", args: [session] })) as { result: { root?: string; computer?: string } };
      // A bot's conversation has no folder (a coding session's has: `root`); the clause uses the computer's home folder in the tree.
      const computer = conv.result.computer;
      const root = conv.result.root ?? `home/${computer}`;
      if (typeof computer !== "string") fail(`the files panel's conversation.get gave no computer (${JSON.stringify(conv.result).slice(0, 200)})`);
      else {
        const listed = (await filesLayer.request("plugin.layer.call", { call: "files.list", args: [root] })) as { result: { path: string; type: string }[] };
        if (!Array.isArray(listed.result)) fail(`the files panel's files.list of the session folder gave ${JSON.stringify(listed).slice(0, 200)}`);
        const first = listed.result.find((s) => s.type === "file");
        let readNote = "no file in the folder to read";
        if (first !== undefined) {
          const text = (await filesLayer.request("plugin.layer.call", { call: "files.readText", args: [first.path] })) as { result: unknown };
          if (typeof text.result !== "string") fail(`the files panel's files.readText of ${first.path} gave ${JSON.stringify(text).slice(0, 200)}`);
          readNote = `reads ${first.path.split("/").pop()}`;
        }
        lines.push(`files panel: lists the session folder (${listed.result.length} entries), ${readNote}`);
        const term = await openLayer("clover/panel-terminal");
        try {
          await term.request("events.subscribe", { areas: ["computers"] });
          const open = (await term.request("terminal.open", { computer, cwd: root, session, cols: 80, rows: 24 })) as { terminalId: string };
          await term.request("terminal.resize", { terminalId: open.terminalId, cols: 100, rows: 30 });
          await term.request("terminal.write", { terminalId: open.terminalId, data: "echo clover-panel-$((20+22))\r" });
          const until2 = Date.now() + 15_000;
          const out = () => term.heard("terminal_output").map((e) => (e as unknown as { terminalId: string; data: string })).filter((e) => e.terminalId === open.terminalId).map((e) => e.data).join("");
          while (!/clover-panel-42/.test(out()) && Date.now() < until2) await new Promise((r) => setTimeout(r, 100));
          if (!/clover-panel-42/.test(out())) fail(`the terminal panel's shell never answered the typed line (heard ${JSON.stringify(out().slice(-200))})`);
          await term.request("terminal.close", { terminalId: open.terminalId });
          lines.push("terminal panel: opens a shell in the session folder, resizes it, takes a typed line and hears its output, closes it");
        } finally {
          term.close();
        }
      }
    } finally {
      filesLayer.close();
    }
    // The diff panel (4.17): a real coding session (Clover's own coding agent, started the app's way with no prompt) on a
    // git folder in the user's home with one committed file changed and one new file; the panel's own layer reads its
    // changes (`session.diff`) and gets both, with their hunks, the branch as the base.
    const computerName = (await ctx.rpc.request<{ computers: { name: string }[] }>("computer.list", {})).computers[0]?.name ?? fail("computer.list lists no computer");
    const work = join(ctx.userHome, "diff-work");
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    const gitIn = (...args: string[]) => {
      const r = spawnSync("git", args, { cwd: work, encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: work, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Acceptance", GIT_AUTHOR_EMAIL: "acceptance@example.invalid", GIT_COMMITTER_NAME: "Acceptance", GIT_COMMITTER_EMAIL: "acceptance@example.invalid" } });
      if (r.status !== 0) fail(`git ${args.join(" ")} in the diff folder: ${r.stderr.slice(0, 200)}`);
    };
    gitIn("init", "-q", "-b", "main");
    writeFileSync(join(work, "notes.txt"), "first line\nsecond line\n");
    gitIn("add", "notes.txt");
    gitIn("commit", "-q", "-m", "the first commit");
    writeFileSync(join(work, "notes.txt"), "first line\nSECOND LINE, changed\n");
    writeFileSync(join(work, "fresh.txt"), "a new file\n");
    const coding = (await ctx.rpc.request<{ session: string }>("agent.start", { backend: "clover-code", computer: computerName, root: `home/${computerName}/diff-work` }, 60_000)).session;
    const diffLayer = await openLayer("clover/panel-diff");
    try {
      type DiffFile = { path: string; status: string; added: number; removed: number; hunks?: { lines: { kind: string; text: string }[] }[] };
      const d = (await diffLayer.request("session.diff", { id: coding })) as { base: string; target: string; files: DiffFile[]; notice?: string };
      const changed = d.files.find((f) => f.path === "notes.txt");
      const added = d.files.find((f) => f.path === "fresh.txt");
      const lineKinds = changed?.hunks?.flatMap((h) => h.lines.map((l) => `${l.kind}:${l.text}`)) ?? [];
      if (d.base !== "main" || d.target !== "working tree") fail(`the diff panel's session.diff compared ${d.base} with ${d.target}, not main with the working tree`);
      if (changed === undefined || changed.status !== "modified" || changed.added !== 1 || changed.removed !== 1 || !lineKinds.includes("del:second line") || !lineKinds.includes("add:SECOND LINE, changed")) fail(`the changed file read ${JSON.stringify(changed).slice(0, 300)}`);
      if (added === undefined || added.status !== "added" || added.added !== 1 || added!.hunks?.[0]?.lines[0]?.text !== "a new file") fail(`the new file read ${JSON.stringify(added).slice(0, 300)}`);
      if (d.files.length !== 2) fail(`session.diff listed ${d.files.map((f) => f.path).join(", ")}, not just the two files`);
      lines.push(`diff panel: a coding session (${coding}) on a git folder; its layer's session.diff compared main with the working tree and gave notes.txt changed (+1 −1, its hunk) and fresh.txt added`);
    } finally {
      diffLayer.close();
    }
    // The column's reads (the slim column's context and outputs, a coding session's connectors), from the column's own
    // layer: a file delivered to the coding session's outputs folder is listed by name and kind; Alpha's last measured
    // turn against her model's window; the coding session's plugin MCP servers counted.
    const column = await openLayer("clover/panel");
    try {
      mkdirSync(join(ctx.home, "outputs", coding), { recursive: true });
      writeFileSync(join(ctx.home, "outputs", coding, "summary.md"), "# What changed\n");
      const outs = (await column.request("session.outputs", { id: coding, limit: 4 })) as { items: { id: string; name: string; kind: string }[]; more: number };
      if (JSON.stringify(outs) !== JSON.stringify({ items: [{ id: "summary.md", name: "summary.md", kind: "page" }], more: 0 })) fail(`the column's session.outputs gave ${JSON.stringify(outs).slice(0, 300)}`);
      const ctxUse = (await column.request("session.context", { id: session })) as { used: number; tokens: number; window: number } | null;
      if (ctxUse === null || !(ctxUse.used > 0 && ctxUse.used <= 1) || !(ctxUse.tokens > 0) || !(ctxUse.window > 0)) fail(`the column's session.context for Alpha gave ${JSON.stringify(ctxUse)}`);
      const conns = (await column.request("session.connectors", { id: coding })) as { total: number; needSignIn: number };
      if (!Number.isInteger(conns.total) || !Number.isInteger(conns.needSignIn) || conns.needSignIn > conns.total) fail(`the column's session.connectors gave ${JSON.stringify(conns)}`);
      lines.push(`column: session.outputs lists summary.md (a page); session.context reads Alpha's last turn at ${ctxUse!.tokens} of ${ctxUse!.window} tokens; session.connectors counts ${conns.total} servers for the coding session, ${conns.needSignIn} waiting for a sign-in`);
    } finally {
      column.close();
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
    // The card on the island's top, the pointer on it: the window it sits in keeps the size it was given (a hovered card is drawn
    // a little grown, and was once read as a bigger room: the window followed, the pointer left, and the card flipped between
    // two heights, its buttons not showing at each turn), and its buttons show.
    let logFrom = 0;
    const held = await islandCardHolds(ctx.cdp, 5_000, () => { logFrom = ctx.appLog().length; });
    const after = ctx.appLog().slice(logFrom).split("\n");
    const resized = after.filter((l) => /surface: island bounds/.test(l));
    const hidden = after.filter((l) => /sealed: .* button:(approve|deny) not visible/.test(l));
    if (resized.length > 0) fail(`the island card's window was resized ${resized.length} time(s) while the pointer rested on the card (${resized.slice(0, 3).map((l) => l.replace(/^\S+\s+/, "")).join("; ")}); readings: ${held.states.map((x) => `[${x.at}ms ${x.sig}]`).join(" ")}`);
    if (hidden.length > 0) fail(`the island card's buttons stopped showing ${hidden.length} time(s) while the pointer rested on it`);
    if (!held.review) fail("the plugin's OK card on the island has no Review row to measure with");
    lines.push(`island plugin-ok card: its window held its size for 5 s under the pointer, its buttons kept showing, ${held.states.length} reading(s) of the card`);
    // One place at a time (the owner's ruling): the window in front, the island lets go of the card and the app's own card takes it
    // (no conversation draws a plugin's OK); the window back, the island takes it again. The seam says which, a headless window
    // never being the focused one.
    if (ctx.setMainFront === undefined) fail("this run has no seam to say the window is in front");
    {
      const seen = (re: RegExp) => ctx.appLog().split("\n").some((l) => re.test(l) && l.includes(okCard.id));
      ctx.setMainFront!(true);
      await until("the OK card moved to the window's own card", 20_000, async () => (seen(/moved to the window's own card \(window foreground\)/) ? true : undefined));
      await until("the island let go of the OK card", 20_000, async () => ((await islandDrawsOkCard(ctx.cdp)) ? undefined : true));
      ctx.setMainFront!(false);
      await until("the OK card moved back to the island", 20_000, async () => (seen(/moved to the island \(window not foreground\)/) ? true : undefined));
      await until("the island drew the OK card again", 30_000, async () => ((await islandDrawsOkCard(ctx.cdp)) ? true : undefined));
      lines.push("one place at a time: with the window in front the OK card left the island for the app's own card, and with it back the island drew it again");
    }
    const okText = JSON.stringify((await ctx.rpc.request<{ card: unknown }>("card.get", { id: okCard.id })).card);
    await ctx.pressCard("the third-party tab's OK card", (c) => c.id === okCard.id);
    await until("the third-party tab's plugin running", 60_000, async () => ((await ctx.rpc.request<{ plugin: { state: string } }>("plugin.get", { id: tabId }).catch(() => undefined))?.plugin.state === "running" ? true : undefined));
    // The app's own card is gone with the answer. The window that took the card while Clover was in front was once kept in no
    // list (the island had shown the card's buttons first), so nothing closed it: it stayed open beside the island's card.
    await until("the app's own card for the answered OK card closed", 15_000, async () => ((await ctx.cdp.documents()).some((d) => d.url.startsWith(`clover-sealed://card/${encodeURIComponent(okCard.id)}/own`)) ? undefined : true));
    lines.push("the app's own card closed with the answer");
    if (process.env.CLOVER_ACCEPT_RENDERS) writeFileSync(join(process.env.CLOVER_ACCEPT_RENDERS, "third-party-tab-ok-card.json"), okText);
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
      try { island = await islandUsageText(ctx.cdp, shooter?.shoot, { label: "Weather · Acceptance tab", words: "21 degrees and clear", say: (line) => ctx.rpc.request("command.run", { name: "acceptance-tab.say", args: line }, 30_000) }); } catch (e) { islandError = (e as Error).message; }
      await shooter?.done();
    });
    if (islandError !== undefined || island === undefined) fail(`the island's Usage tab: ${islandError ?? "the click raised no card to hold the island open"}`);
    const islandProblem = usageDrawnProblem(island!);
    if (islandProblem !== undefined) fail(`the island's Usage tab drew, but ${islandProblem}`);
    if (!/\[devices\] Computers \d+ of \d+ online/.test(island!)) fail(`the island's Devices tab drew no rows (${island!.slice(-200)})`);
    const lineRead = /\[line\] (.*)/.exec(island!)?.[1];
    if (lineRead === undefined) fail(`the island drew no line from the third-party plugin (${island!.slice(-200)})`);
    lines.push(`island line: the third-party plugin's line is drawn in the island's rows with its name and the bot's: ${lineRead}`);
    lines.push(`devices tab read: ${/\[devices\] (.*)/.exec(island!)?.[1]?.slice(0, 120) ?? ""}`);
    lines.push("usage drawn: the Settings Usage section and the island's Usage tab show Clover's counted tokens; a third-party plugin's tab sits on the dots and draws its own words");
    // Removed again, so no later step meets its tab.
    const gone = await ctx.rpc.request<{ card?: string }>("plugin.remove", { id: tabId }).catch(() => undefined);
    if (gone?.card !== undefined) await ctx.pressCard("the third-party tab's removal card", (c) => c.id === gone.card);
  }
  // Closed again, so no later step meets the tab.
  await browse(ctx, session, { verb: "tabs" }).catch(() => undefined);
  return lines.join("; ");
}
