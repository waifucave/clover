// Two rows on a plugin that holds a plugin (try 15, lane E-c):
//
// * CHILD_STEP: a child plugin of a plugin installed from a folder (the `acceptance-kids` fixture: a parent with no parts
//   of its own and the child `pager`) works as a plugin of its own, in the real app: the one OK card names the child; the
//   child runs; its tool (`kids_ping`, served under `acceptance-kids-pager-tools`) is offered to Alpha and answers; its
//   page, opened from its own sidebar app button, draws its words in a frame of its own layer; and the parent's detail on
//   the Plugins page lists the child's tool.
// * NOTIFY_STEP: the core's own updates reach the notifier plugins: a turn Alpha runs that the user didn't start (the
//   child's command sends her a message as a plugin) ends, and the bundled desktop notifier is asked to show "message"
//   for her (the headless app says it shows none, by the banner's id); the user's own turn asks for none.
import { resolve } from "node:path";
import { clickTree, callTurn, fail, installFromPage, leave, openDetail, SIDEBAR_ITEMS, sleep, treeDocs, until, type ExampleCtx } from "./example-steps";

export const CHILD_STEP = "a child plugin of a folder-installed plugin works on its own: its OK card names it, it runs, its tool is offered to Alpha and answers, its page opens from its own sidebar button and draws in a frame of its own layer, and the parent's detail on the Plugins page lists its tool";
export const NOTIFY_STEP = "the core's updates reach the notifier plugins: a turn Alpha runs that the user didn't start ends, and the desktop notifier is asked to show her message (the headless app says it shows none, by its id); the user's own turn asks for none";

const FIXTURE = resolve(import.meta.dir, "fixtures", "acceptance-kids");
const PARENT = "acceptance-kids";
const CHILD = "acceptance-kids/pager";
const SHOWN = /notify: a headless run shows no notification \(([^)]*)\)/g;

const stateOf = async (ctx: ExampleCtx, id: string) => (await ctx.rpc.request<{ plugin: { state: string } }>("plugin.get", { id }).catch(() => undefined))?.plugin.state;

async function install(ctx: ExampleCtx): Promise<{ card: string; text: string }> {
  const got = await installFromPage(ctx, FIXTURE, PARENT);
  await until(`${CHILD} running`, 60_000, async () => ((await stateOf(ctx, CHILD)) === "running" ? true : undefined), async () => `its state is ${String(await stateOf(ctx, CHILD))}`);
  return got;
}

export async function childStep(ctx: ExampleCtx, session: string): Promise<string> {
  const { cdp, rpc } = ctx;
  const done: string[] = [];
  try {
    const { card, text } = await install(ctx);
    if (!text.includes("Kids pager")) fail(`the OK card ${card} doesn't name the child (Kids pager): ${text.slice(0, 400)}`);
    const list = await rpc.request<{ plugins: { id: string; parent?: string; state: string }[] }>("plugin.list", {});
    const kid = list.plugins.find((p) => p.id === CHILD);
    if (kid?.parent !== PARENT || kid.state !== "running") fail(`plugin.list has the child as ${JSON.stringify(kid)}`);
    done.push(`installed from its folder, one OK card ${card} naming the child; ${CHILD} running under ${PARENT}`);

    // Its tool, offered to Alpha under the child's own server key, called by the fake model.
    const ping = await callTurn(ctx, session, "kids_ping", {});
    if (!ping.called.includes("acceptance-kids-pager-tools")) fail(`the tool was offered as ${ping.called}, not under the child's server`);
    if (ping.result.isError || !ping.result.text.includes("kids-pong")) fail(`kids_ping answered ${JSON.stringify(ping.result)}`);
    done.push(`its tool ${ping.called} answered "kids-pong"${ping.cards.length > 0 ? ` after ${ping.cards.length} card(s)` : " with no card"}`);

    // Its page, from its own sidebar button: drawn in a frame of the child's layer.
    const layerDocs = async () => (await cdp.documents()).filter((d) => d.url.startsWith("clover-plugin://acceptance-kids"));
    let lastPress = 0;
    const page = await until("its page drawn in a frame of its own layer", 60_000, async () => {
      for (const d of await layerDocs()) {
        const words = String(await cdp.evaluate(d.session, "document.querySelector('[data-acceptance-kids=\"main\"]')?.textContent ?? ''").catch(() => ""));
        if (words.includes("Kids pager page")) return { url: d.url, words };
      }
      // The window reloads to frame a layer installed after it was served: pressed again until the page is drawn.
      if (Date.now() - lastPress > 5_000) {
        lastPress = Date.now();
        await clickTree(cdp, "its app button in the sidebar", SIDEBAR_ITEMS, "Kids pager", 10_000).catch(() => undefined);
      }
      return undefined;
    }, async () => `layer documents: ${(await layerDocs()).map((d) => d.url).join(", ") || "none"}`);
    done.push(`its page, opened from its sidebar button, drew "${page.words}" in ${page.url.slice(0, 60)}`);

    // The parent's detail on the Plugins page lists the child's tool.
    await openDetail(cdp, "Acceptance kids");
    const tools = await until("the detail's tool list", 20_000, async () => {
      for (const d of await treeDocs(cdp)) {
        const t = (await cdp.evaluate(d.session, "[...document.querySelectorAll('.cl-plugin-index__tool')].map((e) => e.textContent)").catch(() => [])) as string[];
        if (t.length > 0) return t;
      }
      return undefined;
    });
    if (!tools.includes("kids_ping")) fail(`the parent's detail lists the tools ${JSON.stringify(tools)}, not the child's kids_ping`);
    done.push(`the parent's detail lists ${JSON.stringify(tools)}`);
    return done.join("; ");
  } finally {
    await leave(ctx, PARENT);
  }
}

export async function notifyStep(ctx: ExampleCtx, session: string): Promise<string> {
  const { rpc } = ctx;
  const done: string[] = [];
  const banners = (id: string) => [...ctx.appLog().matchAll(SHOWN)].filter((m) => m[1] === id).length;
  const ID = "clover/notifications:message:alpha";
  try {
    await install(ctx);
    if ((await stateOf(ctx, "clover/notifications")) !== "running") fail(`the desktop notifier is ${String(await stateOf(ctx, "clover/notifications"))}`);
    // The user's own turn: no banner for it.
    const before = banners(ID);
    await ctx.turn(session, "hello", 60_000);
    await sleep(2_500);
    if (banners(ID) !== before) fail("the user's own turn asked the notifier for a message banner");
    done.push("the user's own turn asked for no banner");
    // A turn that isn't the user's: the child's command sends Alpha a message as a plugin; the fake model answers; its end
    // is her message to the user.
    const ran = await rpc.request<{ result: { sent?: boolean } }>("command.run", { name: "acceptance-kids.nudge", args: { session } }, 30_000);
    if (ran.result?.sent !== true) fail(`the command answered ${JSON.stringify(ran)}`);
    const notifierLog = async () => `the notifier's log: ${((await rpc.request<{ lines: string[] }>("plugin.logs", { id: "clover/notifications", lines: 12 }).catch(() => ({ lines: ["(unreadable)"] }))).lines.join(" | ") || "empty")}; the app log has ${[...ctx.appLog().matchAll(SHOWN)].map((m) => m[1]).join(", ") || "no notify lines"}`;
    await until(`the desktop notifier asked to show ${ID}`, 60_000, async () => (banners(ID) > before ? true : undefined), notifierLog);
    done.push(`the child's command made Alpha's turn (not the user's); when it ended the desktop notifier was asked to show ${ID} (the headless app showed none and said so)`);
    return done.join("; ");
  } finally {
    await leave(ctx, PARENT);
  }
}
