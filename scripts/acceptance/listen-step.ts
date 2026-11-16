// Push-to-talk (spec §6.6, F1's listening half): Clover Voice's own hold-to-talk button (its `composer.action` entry,
// key `voice`) records while the user holds it and streams the audio to its own host half; on the release the voice
// picked writes it down and the words go to the bot as the user's message (`user.send`, one send after the press and
// release main saw). The run's fixture voice (`acceptance-voice`: no key, no network) is installed the user's way and set
// as Alpha's voice (Clover Voice's own setting for her); the button appears with no window focus, and the row holds it
// with real mouse events, as a person does.
//
// No real microphone: the test build's recorder takes a generated 1.2 s tone clip in place of getUserMedia (Clover
// Voice's `clipSource`), so no run opens a device or raises a system prompt; the row proves the real door was never
// reached (a counter on `navigator.mediaDevices.getUserMedia`) and that the recording document's Permissions-Policy
// allows the microphone (`permissionsPolicy`, which asks nothing of the user). What it proves is the path around the
// device: the press, the recording whole in Clover Voice's host half, the voice's words, and the user's message.
import { resolve } from "node:path";
import { fail, sleep, treeDocs, until, type ExampleCtx, toAlphasTab } from "./example-steps";
import { VOICE_MODE_CLAUSE, voiceModeClause, type Talk } from "./voice-mode-step";

export const LISTEN_STEP = `push-to-talk: Clover Voice's talk button shows only where the bot's voice listens, with no window focus needed; held, it records a generated clip (never the microphone) and the recording reaches the voice whole, and its words are sent as the user's message, not put in the box; ${VOICE_MODE_CLAUSE}`;

const VOICE_DIR = resolve(import.meta.dir, "fixtures", "acceptance-voice");
const VOICE_ID = "acceptance-voice";
const BUTTON = ".cl-voice-talk__button";
const BOX = ".cl-composer textarea";
/** What the fixture's `listen` answers for the clip: 1.2 s of 16 kHz 16-bit PCM. */
const HEARD = "heard 38400 bytes of pcm16-16k";

export async function listenStep(ctx: ExampleCtx, session: string): Promise<string> {
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
  /** The talk button's document and place, if it shows. */
  const button = async (): Promise<{ session: string; c: { x: number; y: number } } | undefined> => {
    for (const d of await treeDocs(cdp)) {
      const c = await cdp.centerOf(d.session, BUTTON).catch(() => undefined);
      if (c !== undefined) return { session: d.session, c };
    }
    return undefined;
  };
  const alphaSession = (await rpc.request<{ bots: { id: string; mainSession: string }[] }>("bot.list", {})).bots.find((b) => b.id === "alpha")?.mainSession ?? session;
  /** The user's messages in Alpha's conversation that carry `words`. */
  const sentWith = async (words: string): Promise<number> => (await ctx.history(alphaSession)).filter((e) => (e as { type?: unknown }).type === "user_message" && JSON.stringify(e).includes(words)).length;
  /** Holds the talk button with real mouse events (main sees the press and the release) while the clip plays, and waits for
   *  the user's message with `words` in Alpha's conversation. */
  const talk: Talk = async (words) => {
    const at = await until("the talk button", 30_000, button, async () => "no talk button in the composer");
    const before = await sentWith(words);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.c.x, y: at.c.y }, at.session);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.c.x, y: at.c.y, button: "left", clickCount: 1, buttons: 1 }, at.session);
    try {
      await until("the talk button listening while it is held", 10_000, async () => ((await cdp.evaluate(at.session, "!!document.querySelector('.cl-voice-talk[data-voice-talk=listening]')")) === true ? true : undefined));
      await sleep(1_500);
    } finally {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.c.x, y: at.c.y, button: "left", clickCount: 1, buttons: 0 }, at.session);
    }
    await until(`the user's message "${words}" in Alpha's conversation`, 40_000, async () => ((await sentWith(words)) > before ? true : undefined),
      async () => `the button says "${String(await cdp.evaluate(at.session, "document.querySelector('.cl-voice-talk')?.innerText ?? ''").catch(() => "?")).slice(0, 160)}"; app: ${ctx.appLog().split("\n").filter((l) => /send:|voice/i.test(l)).slice(-4).join(" | ").slice(-800)}`);
    return at.session;
  };
  try {
    await until("the composer's text box", 30_000, () => inTree<boolean>(`!!document.querySelector('${BOX}')`));
    // Alpha has no voice yet: text-only, so no talk button (Clover Voice's host half says her voice doesn't listen).
    await sleep(1_000);
    if ((await button()) !== undefined) fail("the composer shows a talk button for a bot with no voice");
    done.push("with no voice, the composer has no talk button");

    // The fixture voice, installed from its folder the user's way (its OK card pressed in the window), then Alpha's voice.
    const r = await rpc.request<{ id: string }>("plugin.install", { source: { from: "folder", path: VOICE_DIR } }, 60_000);
    if (r.id !== VOICE_ID) fail(`${VOICE_ID} installed as ${r.id}`);
    installed = true;
    await ctx.pressCard(`${VOICE_ID}'s OK card`, (c) => c.kind === "plugin-ok" && c.pluginId === VOICE_ID);
    await until(`${VOICE_ID} running`, 30_000, async () => ((await state()) === "running" ? true : undefined));
    for (const [key, value] of [["provider", VOICE_ID], ["voice", "tone"]] as const) await rpc.request("plugin.settings.set", { id: "clover/voice", key, value, bot: "alpha" });
    voiced = true;

    // The talk button appears by itself: it reads Clover Voice's own settings as they change (no window focus given).
    await until("the talk button", 30_000, button, async () => "no talk button in the composer");
    done.push("with a listening voice set, the talk button shows, with no window focus given");

    // A counter on the real device's door that only counts: it never reaches the real getUserMedia, so even a wrong source
    // opens no device. The generated clip must never come here.
    for (const d of await treeDocs(cdp)) {
      await cdp.evaluate(d.session, `(() => {
        const m = navigator.mediaDevices;
        if (!m || m.__listenProbe) return;
        m.__listenProbe = 0;
        m.getUserMedia = () => { m.__listenProbe++; return Promise.reject(new Error('the acceptance run never opens a microphone')); };
      })()`).catch(() => undefined);
    }

    // Held with real mouse events (main sees the press and the release), released after the clip has played.
    const recorded = await talk(HEARD);
    done.push(`held and released, the voice's words "${HEARD}" (the whole 1.2 s clip, 38,400 bytes) were sent to Alpha as the user's message`);
    const box = String(await cdp.evaluate(recorded, `document.querySelector('${BOX}') ? document.querySelector('${BOX}').value : ''`).catch(() => ""));
    if (box.includes("heard ")) fail(`the words landed in the composer's box too: "${box.slice(0, 120)}"`);
    if ((await cdp.evaluate(recorded, "!!document.querySelector('.cl-voice-talk[data-voice-talk=listening]')")) === true) fail("the talk button still says it is listening after the release");
    done.push("the composer's box stayed as it was, and the button stopped listening");
    // The hold was one: a second recording didn't start by itself.
    const counters = await inTree<string>("(() => { const d = document.documentElement.dataset; return d.voiceTalkStarts === undefined ? null : JSON.stringify({ starts: +d.voiceTalkStarts, source: d.voiceTalkSource, bytes: +d.voiceTalkBytes, probe: (navigator.mediaDevices && navigator.mediaDevices.__listenProbe) || 0 }); })()");
    if (counters === undefined) fail("the talk button's document shows no recorder counters (a test build marks them on its root)");
    const c = JSON.parse(counters!.value) as { starts: number; source: string; bytes: number; probe: number };
    if (c.source !== "clip") fail(`the recorder's source was ${c.source}, not the generated clip`);
    if (c.starts !== 1 || c.bytes !== 38_400) fail(`the recorder's counters read ${JSON.stringify(c)}; wanted 1 start, 38400 bytes`);
    if (c.probe !== 0) fail(`getUserMedia was called ${c.probe} time(s): the real microphone was asked for`);
    done.push(`the recorder ran the generated clip once (${c.starts} start, ${c.bytes} bytes), and getUserMedia was never called`);
    // The document that recorded (the one with the counters) is the clover layer's own (Clover Voice's button is drawn there), and the
    // browser's Permissions-Policy for its frame allows the microphone; a document of a layer that doesn't hold `microphone` (Alpha's,
    // the fixture voice's) does not (the real device is never asked).
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
    if (!mine.href.startsWith("clover-plugin://clover/") || mine.browser !== true || mine.page === "blocked") fail(`the recording document ${mine.href}: the browser's Permissions-Policy state says the microphone is ${String(mine.browser)}, the page says ${mine.page}; it must be allowed for Clover Voice's button`);
    const others: string[] = [];
    for (const d of await cdp.documents()) {
      if (d.session === counters!.session || d.url.startsWith("clover-plugin://clover/") || !d.url.startsWith("clover-plugin://")) continue;
      const v = await policyOf(d.session).catch(() => undefined);
      if (v === undefined) continue;
      if (v.browser === true || v.page === "allowed") fail(`a document of another layer allows the microphone: ${v.href} (browser ${String(v.browser)}, page ${v.page})`);
      others.push(v.href.slice(0, 30));
    }
    done.push(`the recording document's Permissions-Policy allows the microphone for it (browser state ${String(mine.browser)}, page ${mine.page})${others.length > 0 ? `, and blocks it in ${others.length} other layer document(s)` : ""} (no prompt was raised)`);
    // The second voice's clause, with Alpha's voice still the run's tone voice; it holds the button again while that voice is picked.
    done.push(...(await voiceModeClause(ctx, talk)));
    return done.join("; ");
  } finally {
    if (voiced) for (const key of ["provider", "voice"]) await rpc.request("plugin.settings.set", { id: "clover/voice", key, value: null, bot: "alpha" }).catch(() => undefined);
    if (installed) {
      const rm = await rpc.request<{ card?: string }>("plugin.remove", { id: VOICE_ID }).catch(() => undefined);
      if (rm?.card !== undefined) await ctx.approveCard(rm.card).catch(() => undefined);
    }
  }
}
