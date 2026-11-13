// Push-to-talk (try 15, lane E-listen; spec §6.6): the app records while the user holds the composer's talk button and hands
// the audio to the bot's listening voice plugin. The run's fixture voice (`acceptance-voice`: no key, no network) is installed
// the user's way and set as Alpha's voice (her user layer), and the row holds the button down with real mouse events, as a
// person does, so main sees the press (a recording starts only after one).
//
// No real microphone: the test build's recorder takes a generated 1.2 s tone clip in place of getUserMedia (listen.ts's
// `clipSource`), so no run opens a device or raises a system prompt; the row proves the real constructor was never reached
// (a counter on `navigator.mediaDevices.getUserMedia`) and that the shell frame's Permissions-Policy allows the microphone
// for the recorder (`permissionsPolicy`, which asks nothing of the user). What the row proves is the path around the device:
// the press, main's hold, the numbered pieces crossing the daemon into the plugin, and the plugin's words back in the box.
import { resolve } from "node:path";
import { composerDoc } from "./ui-steps";
import { fail, sleep, treeDocs, until, type ExampleCtx, toAlphasTab } from "./example-steps";

export const LISTEN_STEP = "push-to-talk: the talk button shows only where the bot's voice listens; held, the app records a generated clip (never the microphone) and the numbered pieces reach the voice plugin whole and in order, and its words land in the composer's box";

const VOICE_DIR = resolve(import.meta.dir, "fixtures", "acceptance-voice");
const VOICE_ID = "acceptance-voice";
const BUTTON = ".cl-composer__voice";
const BOX = ".cl-composer textarea";
/** What the fixture's `listen` answers for the clip: 5 chunks (16,000 bytes) twice, then the last 2 chunks (6,400 bytes) at the release. */
const HEARD = "heard 3 pieces, 38400 bytes of pcm16-16k";

export async function listenStep(ctx: ExampleCtx, _session: string): Promise<string> {
  await toAlphasTab(ctx);
  const { cdp, rpc } = ctx;
  const done: string[] = [];
  let installed = false;
  let voiced = false;
  const state = async () => (await rpc.request<{ plugin: { state: string } }>("plugin.get", { id: VOICE_ID }).catch(() => undefined))?.plugin.state;
  /** The first tree document where `expr` is truthy: its session and value. */
  const inTree = async <T>(expr: string): Promise<{ session: string; value: T } | undefined> => {
    for (const d of await treeDocs(cdp)) {
      try {
        const value = (await cdp.evaluate(d.session, expr)) as T;
        if (value !== null && value !== undefined && value !== false) return { session: d.session, value };
      } catch { /* a frame that is going */ }
    }
    return undefined;
  };
  try {
    const box = await until("the composer's text box", 30_000, () => composerDoc(cdp));
    // Alpha has no voice yet: text-only, so no talk button (the daemon says her voice doesn't listen).
    await sleep(1_000);
    if ((await cdp.centerOf(box.session, BUTTON)) !== undefined) fail("the composer shows a talk button for a bot with no voice");
    done.push("with no voice, the composer has no talk button");

    // The fixture voice, installed from its folder the user's way (its OK card pressed in the window), then Alpha's voice.
    const r = await rpc.request<{ id: string }>("plugin.install", { source: { from: "folder", path: VOICE_DIR } }, 60_000);
    if (r.id !== VOICE_ID) fail(`${VOICE_ID} installed as ${r.id}`);
    installed = true;
    await ctx.pressCard(`${VOICE_ID}'s OK card`, (c) => c.kind === "plugin-ok" && c.pluginId === VOICE_ID);
    await until(`${VOICE_ID} running`, 30_000, async () => ((await state()) === "running" ? true : undefined));
    await rpc.request("bot.setUserLayer", { id: "alpha", patch: { voice: { provider: VOICE_ID, voice: "tone" } } });
    voiced = true;
    const status = await rpc.request<{ listens: boolean }>("voice.status", { bot: "alpha" });
    if (status.listens !== true) fail(`voice.status says ${JSON.stringify(status)} for Alpha with a listening voice`);

    // The talk button appears (the composer re-reads the daemon's answer when the voice changes, or when the window is focused).
    const at = await until("the composer's talk button", 60_000, async () => {
      const d = await composerDoc(cdp);
      if (d === undefined) return undefined;
      const c = await cdp.centerOf(d.session, BUTTON);
      return c === undefined ? undefined : { session: d.session, c };
    }, async () => "no talk button in the composer");
    done.push("with a listening voice set, the talk button shows");

    // A counter on the real constructor's door: the generated clip must never reach it.
    for (const d of await treeDocs(cdp)) {
      await cdp.evaluate(d.session, `(() => {
        const m = navigator.mediaDevices;
        if (!m || m.__listenProbe) return;
        m.__listenProbe = 0;
        const real = m.getUserMedia ? m.getUserMedia.bind(m) : undefined;
        m.getUserMedia = (...a) => { m.__listenProbe++; return real ? real(...a) : Promise.reject(new Error('none')); };
      })()`).catch(() => undefined);
    }

    // Held with real mouse events (main sees the press), released after the clip has played.
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.c.x, y: at.c.y }, at.session);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.c.x, y: at.c.y, button: "left", clickCount: 1, buttons: 1 }, at.session);
    try {
      await until("the listening line while the button is held", 10_000, async () => ((await cdp.evaluate(at.session, "!!document.querySelector('.cl-composer__listening')")) === true ? true : undefined));
      await sleep(1_500);
    } finally {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.c.x, y: at.c.y, button: "left", clickCount: 1, buttons: 0 }, at.session);
    }
    done.push("held, the composer showed its listening line");

    // What the fixture heard lands in the box; the line is gone.
    const text = await until("what the voice heard in the composer's box", 30_000, async () => {
      const v = String(await cdp.evaluate(at.session, `document.querySelector('${BOX}') ? document.querySelector('${BOX}').value : ''`).catch(() => ""));
      return v.includes("heard ") ? v : undefined;
    }, async () => `box: "${String(await cdp.evaluate(at.session, `document.querySelector('${BOX}') ? document.querySelector('${BOX}').value : ''`).catch(() => "?")).slice(0, 120)}"; notice: "${String(await cdp.evaluate(at.session, "document.querySelector('.cl-composer')?.innerText ?? ''").catch(() => "?")).slice(0, 200)}"`);
    if (!text.includes(HEARD)) fail(`the box shows "${text.slice(0, 120)}", not "${HEARD}"`);
    done.push(`the plugin's words "${HEARD}" landed in the box (3 numbered pieces, 38,400 bytes, whole and in order)`);
    if ((await cdp.evaluate(at.session, "!!document.querySelector('.cl-composer__listening')")) === true) fail("the listening line stays after the release");
    // The hold was one: a second recording didn't start by itself.
    const counters = await inTree<string>("(() => { const d = document.documentElement.dataset; return d.listenStarts === undefined ? null : JSON.stringify({ starts: +d.listenStarts, source: d.listenSource, pieces: +d.listenPieces, bytes: +d.listenBytes, probe: (navigator.mediaDevices && navigator.mediaDevices.__listenProbe) || 0 }); })()");
    if (counters === undefined) fail("the shell frame shows no recorder counters (a test build marks them on its root)");
    const c = JSON.parse(counters!.value) as { starts: number; source: string; pieces: number; bytes: number; probe: number };
    if (c.source !== "clip") fail(`the recorder's source was ${c.source}, not the generated clip`);
    if (c.starts !== 1 || c.pieces !== 3 || c.bytes !== 38_400) fail(`the recorder's counters read ${JSON.stringify(c)}; wanted 1 start, 3 pieces, 38400 bytes`);
    if (c.probe !== 0) fail(`getUserMedia was called ${c.probe} time(s): the real microphone was asked for`);
    done.push(`the recorder ran the generated clip once (${c.starts} start, ${c.pieces} pieces, ${c.bytes} bytes), and getUserMedia was never called`);
    // The document that recorded (the one with the counters) is the clover layer's own, and the browser's Permissions-Policy for its
    // frame allows the microphone; a document of any other layer (Alpha's, a plugin's) does not (the real device is never asked).
    // Two readings must agree: the browser's own state for the frame (CDP `Page.getPermissionsPolicyState`: the header and the
    // iframe's `allow` together) and the page's own view (`document.featurePolicy`, the shipped name; `permissionsPolicy` where it exists).
    const policyOf = async (session: string): Promise<{ href: string; browser: boolean | undefined; page: "allowed" | "blocked" | "unavailable" }> => {
      const page = String(await cdp.evaluate(session, "(() => { const p = document.permissionsPolicy || document.featurePolicy; return location.href.slice(0, 60) + ' ' + (!p || !p.allowsFeature ? 'unavailable' : p.allowsFeature('microphone') ? 'allowed' : 'blocked'); })()")).split(" ");
      const browser = await (async () => {
        const tree = (await cdp.send("Page.getFrameTree", {}, session)) as { frameTree: { frame: { id: string } } };
        const state = (await cdp.send("Page.getPermissionsPolicyState", { frameId: tree.frameTree.frame.id }, session)) as { states: { feature: string; allowed: boolean }[] };
        return state.states.find((x) => x.feature === "microphone")?.allowed;
      })().catch(() => undefined);
      return { href: page[0]!, browser, page: page[1] as "allowed" | "blocked" | "unavailable" };
    };
    const mine = await policyOf(counters!.session);
    if (!mine.href.startsWith("clover-plugin://clover/") || mine.browser !== true || mine.page === "blocked") fail(`the recording document ${mine.href}: the browser's Permissions-Policy state says the microphone is ${String(mine.browser)}, the page says ${mine.page}; it must be allowed for the recorder`);
    const others: string[] = [];
    for (const d of await cdp.documents()) {
      if (d.session === counters!.session || d.url.startsWith("clover-plugin://clover/") || !d.url.startsWith("clover-plugin://")) continue;
      const v = await policyOf(d.session).catch(() => undefined);
      if (v === undefined) continue;
      if (v.browser === true || v.page === "allowed") fail(`a document of another layer allows the microphone: ${v.href} (browser ${String(v.browser)}, page ${v.page})`);
      others.push(v.href.slice(0, 30));
    }
    done.push(`the recording document's Permissions-Policy allows the microphone for it (browser state ${String(mine.browser)}, page ${mine.page})${others.length > 0 ? `, and blocks it in ${others.length} other layer document(s)` : ""} (no prompt was raised)`);
    return done.join("; ");
  } finally {
    if (voiced) await rpc.request("bot.setUserLayer", { id: "alpha", patch: { voice: null } }).catch(() => undefined);
    if (installed) {
      const rm = await rpc.request<{ card?: string }>("plugin.remove", { id: VOICE_ID }).catch(() => undefined);
      if (rm?.card !== undefined) await ctx.approveCard(rm.card).catch(() => undefined);
    }
  }
}
