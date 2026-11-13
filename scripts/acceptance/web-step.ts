// A web page part (checklist row 1.90; spec §5.5 "Web pages"): a `ui` entry of kind `web` instead of `component`. The
// `acceptance-webpart` fixture (no code: a page in its own folder at the conversation spot) is installed from its folder
// the user's way, its OK card pressed in the window, and its page must draw in an isolated view of its own (a document
// on `clover-web://`, never a plugin layer's or the app's origin) that reaches nothing of the app: no bridge, no Node.
import { resolve } from "node:path";
import { fail, sleep, until, type ExampleCtx } from "./example-steps";

export const WEB_STEP = "a web page part: a plugin whose ui entry is a web page installs from a folder, its OK card (which says it shows web pages) is pressed, and its page draws in a sealed view on clover-web:// with no bridge to the app and no Node";

const FIXTURE_DIR = resolve(import.meta.dir, "fixtures", "acceptance-webpart");
const PLUGIN_ID = "acceptance-webpart";
const MARK = "ACCEPTANCE-WEB-PART (scripted)";

/** What the page wrote of its own reach (its text), or why it isn't sealed. Exported for the unit test. */
export function sealedProblem(text: string): string | undefined {
  if (!text.includes(MARK)) return `the page's script didn't run (its text reads "${text.replace(/\s+/g, " ").slice(0, 120)}")`;
  const m = /bridge: (\w+); node: (\w+); page: (\w+)/.exec(text);
  if (m === null) return `the page reports nothing of its reach ("${text.replace(/\s+/g, " ").slice(0, 120)}")`;
  if (m[1] !== "none") return "the web page can see one of the app's bridges";
  if (m[2] !== "none") return "the web page can see Node";
  return undefined;
}

export async function webStep(ctx: ExampleCtx, _session: string): Promise<string> {
  const { cdp, rpc } = ctx;
  const done: string[] = [];
  let installed = false;
  /** The web page's document: on the folder-page scheme, carrying the fixture's mark. */
  const webDoc = async () => (await cdp.documents()).find((d) => d.url.startsWith("clover-web://") && d.text.includes("ACCEPTANCE-WEB-PART"));
  try {
    if (await webDoc() !== undefined) fail("a web page of this fixture is already drawn before it is installed");
    const r = await rpc.request<{ id: string; card?: string }>("plugin.install", { source: { from: "folder", path: FIXTURE_DIR } }, 60_000);
    if (r.id !== PLUGIN_ID) fail(`${PLUGIN_ID} installed as ${r.id}`);
    installed = true;
    const cardId = await ctx.pressCard(`${PLUGIN_ID}'s OK card`, (c) => c.kind === "plugin-ok" && c.pluginId === PLUGIN_ID);
    const card = (await rpc.request<{ card: unknown }>("card.get", { id: cardId }).catch(() => undefined))?.card;
    // The card is gone once answered, so it may not read; when it does, it says what the plugin is.
    if (card !== undefined && !JSON.stringify(card).includes("shows web pages")) fail("the OK card doesn't say the plugin shows web pages");
    done.push("installed from its folder, its OK card pressed");
    const info = await rpc.request<{ plugin: { state: string } }>("plugin.get", { id: PLUGIN_ID });
    if (["found", "refused", "invalid", "off", "waiting"].includes(info.plugin.state)) fail(`${PLUGIN_ID} is ${info.plugin.state} after its OK`);

    const doc = await until("the web page's document (clover-web://)", 60_000, async () => await webDoc(), async () =>
      (await cdp.documents()).map((d) => `${d.url.slice(0, 60)}: ${d.text.replace(/\s+/g, " ").slice(0, 60)}`).join(" || "));
    // The script has run once its reach line is written.
    const text = await until("the page's own reach line", 15_000, async () => {
      const t = String(await cdp.evaluate(doc.session, "document.body ? document.body.innerText : ''").catch(() => ""));
      return t.includes("bridge:") ? t : undefined;
    });
    const bad = sealedProblem(text);
    if (bad !== undefined) fail(bad);
    done.push(`the page drew on ${doc.url.replace(/^(clover-web:\/\/[^/]*\/).*/, "$1…")} and reads "${text.replace(/\s+/g, " ").trim()}"`);
    // Its origin isn't a plugin layer's: the app's own pages and layers are on other schemes.
    if (doc.url.startsWith("clover-plugin://") || doc.url.startsWith("clover-core://")) fail(`the web page is on ${doc.url.slice(0, 30)}`);
    return done.join("; ");
  } finally {
    if (installed) {
      const rm = await rpc.request<{ card?: string }>("plugin.remove", { id: PLUGIN_ID }).catch(() => undefined);
      if (rm?.card !== undefined) await ctx.approveCard(rm.card).catch(() => undefined);
      // Its view goes with its part, so the conversation is Alpha's again for the rows after.
      for (let i = 0; i < 30 && (await webDoc()) !== undefined; i++) await sleep(300);
    }
  }
}
