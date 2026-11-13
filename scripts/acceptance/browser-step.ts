// The bots' Browser tool on the real path, against the run's own fixture site (never the live web, never the owner's own
// browser or its profile): Alpha's session calls `Browser` through the fake model's tool_use, the core's turn loop, the
// plugin host, the tool's host half, `api.browser.*` (the core's browser service) and the app's browser host, which
// draws the page offscreen in the bot's own partition. The fixture is a local server the app reaches by NAME
// (`CLOVER_TEST_BROWSER_NAMES`, apps/desktop/src/main/browser/test-names.ts: a test or acceptance build only): the name
// resolves to a public-kind address and is dialled to this server, so the network filter judges it as any web address.
// Loopback itself stays refused to a bot's tab, and a row below holds that.
import { callTurn, type ExampleCtx } from "./example-steps";

export const BROWSER_STEP = "the bot's Browser tool opens a fixture page in its own tab (drawn offscreen), reads its text and elements, takes a picture, navigates it (one tab), and is refused a loopback address";

export const FIXTURE_NAME = "browser-fixture.test";

export interface BrowserFixture {
  /** The app's `CLOVER_TEST_BROWSER_NAMES` value. */
  readonly names: string;
  /** The address of the fixture as a bot is told it. */
  readonly url: string;
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
<form onsubmit="return false"><label>Name <input aria-label="Name" type="text"></label><button type="button">Say hello</button></form>`;
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
  return { names: `${FIXTURE_NAME}=${server.port}`, url: `http://${FIXTURE_NAME}:${server.port}/`, seen, loopbackUrl: `http://127.0.0.1:${server.port}/`, stop: () => server.stop(true) };
}

class Failed extends Error {}
const fail = (m: string): never => { throw new Failed(m); };

/** One `Browser` call; its text, or its refusal. */
async function browse(ctx: ExampleCtx, session: string, input: Record<string, unknown>) {
  const r = await callTurn(ctx, session, "Browser", input);
  return { text: r.result.text.replace(/\s+/g, " ").trim(), isError: r.result.isError, cards: r.cards };
}

export async function browserStep(ctx: ExampleCtx, session: string, fixture: BrowserFixture): Promise<string> {
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
  // Closed again, so no later step meets the tab.
  await browse(ctx, session, { verb: "tabs" }).catch(() => undefined);
  return lines.join("; ");
}
