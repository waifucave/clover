// The `setup` unit (lane SG, the owner's 2026-11-20 ruling): the setup guide in both apps on a fresh home, with no model
// provider added and no default model. MOSS Code and MOSS (the bots app), from source, headless, both over the unit's own
// engine; each row drives the apps' own windows through their DevTools ports with trusted input (clicks, typed text), and
// reads the engine's answer (`setup.state`) beside what the windows show.
//
// Its rows run in order on one home: (1) both apps open the guide by themselves on the fresh home; in MOSS, Skip for now
// leaves it usable (a message to MOSS is answered with the plain sentence that leads to adding a provider) and the
// engine keeps the skip, and Settings opens the guide again; (2) in MOSS Code's guide, a key typed in its own field adds
// the provider, whose recommended model becomes the default with nothing to pick, and Start lands on a new code session,
// whose first turn (no model of its own) is answered on that default; (3) a second provider leaves the default as it was,
// the picker in MOSS's guide sets the other provider's model, and MOSS's next turn runs on it.
//
// With MOSS_ACCEPT_RENDERS set, each step of the guide is pictured: MOSS in light and dark, MOSS Code in its theme. A
// picture, never a check.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { Cdp } from "./cdp";
import { TITLE_INSTRUCTION } from "../../packages/core/src/agent/titles";
import { activeCatalog } from "../../packages/core/src/runtime-sdk/model-plugins/catalog-source";
import { lightModelOn } from "../../packages/core/src/runtime-sdk/model-plugins/light-model";
import type { MossClient } from "./client";
import type { FakeProvider } from "./fake-anthropic";
import type { Status } from "./steps";

export const SETUP_OPEN_STEP = "the setup guide on a fresh home (no provider, no default model): MOSS Code and MOSS each open it by themselves (the engine's setup.state says a provider and a model are missing); in MOSS, Skip for now leaves the app usable (a message to MOSS is answered with the plain sentence that leads to adding a provider, no provider called) and the engine keeps the skip for both apps; MOSS's Settings opens it again";
export const SETUP_ONE_STEP = "the setup guide in MOSS Code: a key typed in the guide's own field adds the provider; its family's default (Claude Opus 5.5 at medium) is the default with nothing to pick, shown chosen with its effort in the guide's model step; Start lands on a new code session, and a code session with no model of its own gets its first reply on that default";
export const SETUP_PICK_STEP = "two providers: a second one added leaves the default as it was; the picker in MOSS's guide (Change) sets the other provider's model as the default (the engine's setup.state), Talk to MOSS opens her conversation ready to type, and her next turn runs on the picked model";

/** The owner's default for the Claude family, as Anthropic serves it. */
export const CLAUDE_DEFAULT = "anthropic/claude-opus-5-5";

export const SETUP_CARD_STEP = "a card raised while MOSS's guide is open: the guide (which covers the window) steps aside, the approval card is drawn on top in MOSS's window and a real press on its Approve answers it, and the guide is back, at the step it was on, once no card waits";
// Lane LM (the owner, 2026-11-21: "a light model per family"): on the one-provider home the first turn ran on Claude's
// default; its conversation title, a background job, is asked of Claude's light model.
export const SETUP_LIGHT_STEP = "the light model: on that home with one Anthropic key, the conversation title MOSS writes in the background is asked of Claude's light model (Haiku 5.5) while the turn itself ran on the default (Opus 5.5)";
// The light row is the last of the list (the pictures keep their numbers) and runs right after the one-provider row.
export const SETUP_STEPS: readonly string[] = [SETUP_OPEN_STEP, SETUP_ONE_STEP, SETUP_PICK_STEP, SETUP_CARD_STEP, SETUP_LIGHT_STEP];

/** The second provider: one more on the Anthropic wire, pointed at the run's fake (`providers.<id>.baseUrl`). */
export const SECOND_PROVIDER = "deepseek-anthropic";
export const SECOND_PLUGIN = `moss/model-${SECOND_PROVIDER}`;
export const SECOND_MODEL = `${SECOND_PROVIDER}/deepseek-v4-pro`;

export interface SetupUnitCtx {
  root: string;
  logs: string;
  userHome: string;
  fake: FakeProvider;
  /** The run's dummy key: the only key there is. */
  dummyKey: string;
  /** MOSS Code's main process's own client role, the run's (`appDriver`). */
  driver(): Promise<MossClient>;
  startCodeApp(port: number, appearance: string): { proc: ChildProcess; log: string };
  startMossApp(port: number): { proc: ChildProcess; log: string };
  freePort(): number;
  endChild(proc: ChildProcess): Promise<boolean>;
  alive(proc: ChildProcess): boolean;
  readLog(path: string): string;
  until<T>(what: string, ms: number, probe: () => Promise<T | undefined> | T | undefined, every?: number): Promise<T>;
  fail(msg: string): never;
  record(name: string, status: Status, detail: string): void;
  statusOf(err: unknown): Status;
  why(err: unknown): string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface SetupState { ready: boolean; missing: string[]; providers: string[]; default?: { model: string; source: string; effort?: string }; recommended?: Record<string, { model: string; effort?: string }>; dismissed: boolean }

/** One document of an app's window through its DevTools port: trusted clicks and typing, as a person's. */
class Doc {
  constructor(private readonly x: SetupUnitCtx, readonly cdp: Cdp, private readonly match: (url: string) => boolean, private readonly name: string) {}

  async session(): Promise<string> {
    const d = await this.x.until(`${this.name}'s document`, 60_000, async () => (await this.cdp.documents()).find((x) => this.match(x.url)), 300);
    return d.session;
  }

  async eval<T>(js: string): Promise<T> {
    return (await this.cdp.evaluate(await this.session(), js)) as T;
  }

  async waitFor<T>(what: string, js: string, ms = 30_000): Promise<T> {
    return this.x.until(what, ms, async () => {
      const v = await this.eval<T>(js).catch(() => undefined);
      return v === null || v === undefined || v === false || v === "" ? undefined : v;
    }, 250);
  }

  /** A trusted click on the element, once it holds still and is the one at its own centre. */
  async click(selector: string, text?: string): Promise<void> {
    const s = await this.session();
    let last: { x: number; y: number } | undefined;
    const at = await this.x.until(`${this.name}'s ${selector}${text !== undefined ? ` "${text}"` : ""}, holding still`, 20_000, async () => {
      await this.eval(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find((x) => ${JSON.stringify(text ?? null)} === null || (x.innerText || '').includes(${JSON.stringify(text ?? "")})); e?.scrollIntoView({ block: 'center' }); return true; })()`).catch(() => undefined);
      const p = await this.cdp.centerOf(s, selector, text);
      if (p === undefined) { last = undefined; return undefined; }
      const steady = last !== undefined && Math.abs(last.x - p.x) < 1 && Math.abs(last.y - p.y) < 1;
      last = p;
      if (!steady) return undefined;
      const hit = await this.eval<boolean>(`((x, y, sel) => { const t = document.elementFromPoint(x, y); return !!t && !!t.closest(sel) && !t.closest(sel).disabled; })(${p.x}, ${p.y}, ${JSON.stringify(selector)})`).catch(() => false);
      return hit ? p : undefined;
    }, 150);
    await this.cdp.click(s, at.x, at.y);
    await sleep(200);
  }

  /** Types into a field as the keyboard does: focused by a click, then the text inserted. */
  async type(selector: string, text: string): Promise<void> {
    await this.click(selector);
    await this.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.focus(); e.select?.(); return true; })()`);
    await this.cdp.send("Input.insertText", { text }, await this.session());
    await sleep(150);
  }

  /** A picture of the window, for the owner (a render, never a check): one per scheme asked. */
  async picture(dir: string | undefined, name: string, schemes: readonly ("light" | "dark")[], before?: (scheme: "light" | "dark") => Promise<void> | void): Promise<string[]> {
    if (dir === undefined) return [];
    mkdirSync(dir, { recursive: true });
    const s = await this.session();
    const out: string[] = [];
    await this.cdp.send("Emulation.setDeviceMetricsOverride", { width: 1180, height: 760, deviceScaleFactor: 2, mobile: false }, s).catch(() => undefined);
    for (const scheme of schemes) {
      await before?.(scheme);
      for (const d of await this.cdp.documents()) await this.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] }, d.session).catch(() => undefined);
      // The scheme taken (the page's own media query says so), then a frame drawn after it: an offscreen window that has
      // nothing new to paint can hand back its last frame, which was the other scheme's.
      await this.x.until(`${this.name} in the ${scheme} scheme`, 10_000, async () => ((await this.eval<boolean>(`matchMedia('(prefers-color-scheme: dark)').matches === ${scheme === "dark"}`).catch(() => false)) ? true : undefined), 100).catch(() => undefined);
      await this.eval("(() => { const b = document.body; b.style.outline = '1px solid transparent'; return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => { b.style.outline = ''; r(true); }))); })()").catch(() => undefined);
      await sleep(1_200);
      const shot = await this.cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" }, s);
      const file = join(dir, `${name}-${scheme}.png`);
      writeFileSync(file, Buffer.from(shot.data, "base64"));
      out.push(file);
    }
    for (const d of await this.cdp.documents()) await this.cdp.send("Emulation.setEmulatedMedia", { features: [] }, d.session).catch(() => undefined);
    await this.cdp.send("Emulation.clearDeviceMetricsOverride", {}, s).catch(() => undefined);
    // Two schemes that came out byte for byte the same are one scheme drawn twice: said, so the pictures aren't trusted.
    if (out.length === 2 && readFileSync(out[0]!).equals(readFileSync(out[1]!))) console.error(`acceptance: setup pictures: ${name}'s light and dark pictures are the same bytes`);
    return out;
  }
}

async function setupState(c: MossClient): Promise<SetupState> {
  return c.request<SetupState>("setup.state", {});
}

/** A turn in a session over the run's client: sent, then its events once a reply or an error ends it. */
async function turnIn(x: SetupUnitCtx, c: MossClient, session: string, text: string): Promise<{ type: string; text?: string; message?: string; code?: string }[]> {
  const sent = await c.request<{ seq: number }>("session.send", { id: session, message: { text, clientMessageId: randomUUID() } }, 30_000);
  return x.until(`the turn after "${text.slice(0, 30)}" to end`, 120_000, async () => {
    const { events } = await c.request<{ events: { seq?: number; type: string; text?: string; message?: string; code?: string }[] }>("session.history", { id: session, limit: 500 });
    const after = events.filter((e) => typeof e.seq === "number" && e.seq > sent.seq);
    return after.some((e) => e.type === "turn_completed" || e.type === "agent_error" || e.type === "turn_failed") ? after : undefined;
  }, 500);
}

export async function setupUnit(x: SetupUnitCtx): Promise<void> {
  const renders = process.env.MOSS_ACCEPT_RENDERS === undefined || process.env.MOSS_ACCEPT_RENDERS === "" ? undefined : process.env.MOSS_ACCEPT_RENDERS;
  const done = new Set<string>();
  const apps: { proc: ChildProcess; log: string }[] = [];
  const cdps: Cdp[] = [];
  let code: Doc | undefined;
  let moss: Doc | undefined;
  const row = async (name: string, run: () => Promise<string>): Promise<void> => {
    done.add(name);
    try {
      x.record(name, "PASS", await run());
    } catch (err) {
      const n = SETUP_STEPS.indexOf(name) + 1;
      const shots: string[] = [];
      for (const [doc, which] of [[code, "code"], [moss, "moss"]] as const) {
        if (doc === undefined) continue;
        const s = await doc.session().catch(() => undefined);
        const r = s === undefined ? undefined : await doc.cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" }, s).catch(() => undefined);
        if (r !== undefined) { writeFileSync(join(x.logs, `setup-row-${n}-${which}.png`), Buffer.from(r.data, "base64")); shots.push(`logs/setup-row-${n}-${which}.png`); }
      }
      x.record(name, x.statusOf(err), `${x.why(err)}${shots.length > 0 ? ` (pictures: ${shots.join(", ")})` : ""}`);
    }
  };
  try {
    const c = await x.driver();
    await c.request("events.subscribe", { areas: ["sessions", "approvals"] }).catch(() => undefined);
    const appearance = join(x.root, "setup-appearance");
    const codePort = x.freePort();
    const codeApp = x.startCodeApp(codePort, appearance);
    apps.push(codeApp);
    const codeCdp = await x.until("MOSS Code's DevTools port", 120_000, async () => {
      if (!x.alive(codeApp.proc)) x.fail(`MOSS Code exited: ${x.readLog(codeApp.log).trim().split("\n").slice(-3).join(" | ").slice(0, 300)}`);
      try { return await Cdp.connect(codePort); } catch { return undefined; }
    }, 500);
    cdps.push(codeCdp);
    code = new Doc(x, codeCdp, (u) => u === "moss-core://app/", "MOSS Code's root");
    const mossPort = x.freePort();
    const mossApp = x.startMossApp(mossPort);
    apps.push(mossApp);
    const mossCdp = await x.until("MOSS's DevTools port", 120_000, async () => {
      if (!x.alive(mossApp.proc)) x.fail(`MOSS exited: ${x.readLog(mossApp.log).trim().split("\n").slice(-3).join(" | ").slice(0, 300)}`);
      try { return await Cdp.connect(mossPort); } catch { return undefined; }
    }, 500);
    cdps.push(mossCdp);
    moss = new Doc(x, mossCdp, (u) => u.startsWith("moss-app://app/"), "MOSS's window");
    const s: Ctx = { x, c, code, moss, renders, appearance, codeLog: codeApp.log, mossLog: mossApp.log };
    await row(SETUP_OPEN_STEP, () => openRow(s));
    await row(SETUP_ONE_STEP, () => oneRow(s));
    await row(SETUP_LIGHT_STEP, () => lightRow(s));
    await row(SETUP_PICK_STEP, () => pickRow(s));
    await row(SETUP_CARD_STEP, () => cardRow(s));
  } catch (err) {
    const why = `the setup unit's apps couldn't be started and driven: ${x.why(err)}`;
    for (const name of SETUP_STEPS) if (!done.has(name)) x.record(name, x.statusOf(err), why);
  } finally {
    for (const d of cdps) d.close();
    for (const a of apps) await x.endChild(a.proc);
  }
}

interface Ctx {
  x: SetupUnitCtx;
  c: MossClient;
  code: Doc;
  moss: Doc;
  renders: string | undefined;
  appearance: string;
  codeLog: string;
  mossLog: string;
  /** The one-provider row's first turn: where its requests start in the fake's list, and the model it ran on. */
  turn?: { since: number; upstream: string };
}

const CODE_STEP = (step: string) => `[data-moss-welcome-step=${step}]`;
const MOSS_STEP = (step: string) => `[data-setup-step=${step}]`;

/** MOSS Code's pictures in its own theme, light and dark (its theme follows the appearance file, a test seam). */
async function codePicture(s: Ctx, name: string): Promise<string[]> {
  return s.code.picture(s.renders, `moss-code-setup-${name}`, ["light", "dark"], async (scheme) => { writeFileSync(s.appearance, scheme); await sleep(600); });
}
async function mossPicture(s: Ctx, name: string): Promise<string[]> {
  return s.moss.picture(s.renders, `moss-setup-${name}`, ["light", "dark"]);
}

async function openRow(s: Ctx): Promise<string> {
  const st = await setupState(s.c);
  if (st.ready || st.missing.join(",") !== "provider,model" || st.default !== undefined) s.x.fail(`a fresh home's setup.state isn't "a provider and a model missing": ${JSON.stringify(st)}`);
  // Both apps open the guide by themselves.
  await s.code.waitFor("MOSS Code's setup guide, open by itself at its first step", `!!document.querySelector('${CODE_STEP("providers")}')`, 60_000);
  await s.moss.waitFor("MOSS's setup guide, open by itself at its first step", `!!document.querySelector('${MOSS_STEP("providers")}')`, 60_000);
  await s.moss.waitFor("MOSS's guide listing the model providers", "!!document.querySelector('[data-setup-provider]')", 60_000);
  const pictures = [...await codePicture(s, "1-providers"), ...await mossPicture(s, "1-providers")];
  // MOSS: Skip for now. The guide goes; the engine keeps the skip.
  await s.moss.click("[data-setup=skip]");
  await s.moss.waitFor("MOSS's guide closed after Skip for now", `!document.querySelector('${MOSS_STEP("providers")}')`);
  const skipped = await s.x.until("the engine keeping the skip (setup.state)", 10_000, async () => ((await setupState(s.c)).dismissed ? true : undefined), 300);
  void skipped;
  // MOSS is usable: MOSS's conversation is there, and a message to her is answered with the sentence that leads on.
  await s.moss.waitFor("MOSS's conversation in MOSS", "document.querySelector('main.conversation')?.getAttribute('aria-label') ?? null", 30_000);
  const asked = s.x.fake.requests.length;
  await s.moss.type("[data-composer] textarea", "hello, is anyone there?");
  await s.moss.click("button.send");
  const alpha = await s.c.request<{ bots: { id: string; mainSession: string }[] }>("bot.records", {}).then((r) => r.bots.find((b) => b.id === "alpha"));
  if (alpha === undefined) s.x.fail("no MOSS record");
  const refused = await s.x.until("MOSS's turn refused with the no-default-model sentence", 60_000, async () => {
    const page = await s.c.request<{ events: { type: string; message?: string; code?: string }[] }>("bot.conversation", { id: "alpha", limit: 50 }).catch(() => undefined);
    return page?.events.find((e) => e.type === "agent_error" && e.code === "no_default_model");
  }, 500);
  if (!/add a model provider/.test(refused.message ?? "")) s.x.fail(`the refusal doesn't lead to adding a provider: "${refused.message}"`);
  if (s.x.fake.requests.length !== asked) s.x.fail(`the refused turn still reached a provider (${s.x.fake.requests.length - asked} request(s))`);
  // MOSS's Settings opens it again.
  await s.moss.click(".nav-item.account");
  await s.moss.click("[data-open-setup]");
  await s.moss.waitFor("MOSS's guide opened again from Settings", `!!document.querySelector('${MOSS_STEP("providers")}')`);
  return `setup.state on the fresh home: ${JSON.stringify({ ready: st.ready, missing: st.missing })}; MOSS Code's and MOSS's guides opened by themselves; MOSS's Skip for now kept by the engine (dismissed: true); MOSS's turn refused: "${refused.message!.slice(0, 90)}", no provider called; Settings opened it again${pictures.length > 0 ? `; pictures: ${pictures.length}` : ""}`;
}

async function oneRow(s: Ctx): Promise<string> {
  // MOSS Code's guide is still open (opened before MOSS's skip). Anthropic's key, typed in the guide's own field.
  const plugin = "moss/model-anthropic";
  await s.code.waitFor("Anthropic in MOSS Code's guide", `!!document.querySelector('[data-moss-provider="${plugin}"]')`, 60_000);
  // The provider order: the ones people have come first (added, sign-ins, the big API-key providers), not the alphabet.
  const firsts = await s.code.eval<string[]>("[...document.querySelectorAll('[data-moss-provider]')].slice(0, 6).map((e) => e.getAttribute('data-moss-provider'))");
  if (firsts.findIndex((id) => id === plugin) < 0 || firsts.findIndex((id) => id === plugin) > 5) s.x.fail(`Anthropic isn't among the guide's first providers: ${firsts.join(", ")}`);
  // Each provider is a closed row: Anthropic's opened by a click.
  await s.code.click(`[data-moss-open="${plugin}"]`);
  const field = `[data-moss-key="${plugin}#0"]`;
  const accept = `[data-moss-terms="${plugin}"]`;
  if (await s.code.eval<boolean>(`!!document.querySelector('${accept}')`)) await s.code.click(accept);
  await s.code.type(field, s.x.dummyKey);
  await s.code.click(`[data-moss-save="${plugin}#0"]`);
  await s.code.waitFor("Anthropic signed in, in the guide", `!!document.querySelector('[data-moss-auth="${plugin}#0"] .moss-page__ok')`, 30_000);
  const st = await s.x.until("the engine's default from the one provider", 30_000, async () => { const x = await setupState(s.c); return x.ready ? x : undefined; }, 300);
  const rec = st.recommended?.anthropic?.model;
  if (rec === undefined) s.x.fail(`setup.state names no recommended model for anthropic: ${JSON.stringify(st)}`);
  // The owner's Claude default: Opus 5.5 at medium.
  if (rec !== CLAUDE_DEFAULT) s.x.fail(`Anthropic's recommended model is ${rec}, not ${CLAUDE_DEFAULT}`);
  if (st.default?.model !== rec || st.default.effort !== "medium") s.x.fail(`the default is ${JSON.stringify(st.default)}, not Anthropic's recommended ${rec} at medium`);
  if (JSON.stringify(st.providers) !== JSON.stringify(["anthropic"])) s.x.fail(`setup.state's providers: ${JSON.stringify(st.providers)}`);
  await s.code.click("[data-moss-welcome=next]");
  const shown = await s.code.waitFor<string>("the guide's model step, the default shown chosen", `document.querySelector('${CODE_STEP("model")} [data-moss-default]')?.getAttribute('data-moss-default') ?? null`);
  if (shown !== rec) s.x.fail(`the guide shows ${shown} chosen, not ${rec}`);
  const words = await s.code.eval<string>(`document.querySelector('${CODE_STEP("model")} [data-moss-default]')?.textContent ?? ''`);
  if (!/Claude Opus 5\.5 · medium/.test(words)) s.x.fail(`the guide's model step says "${words}", not the model and its effort ("Claude Opus 5.5 · medium")`);
  const pictures = [...await codePicture(s, "2-model")];
  await s.code.click("[data-moss-welcome=next]");
  await s.code.waitFor("the guide's done step", `!!document.querySelector('${CODE_STEP("done")}')`);
  // The done step names the model as step 2 did: name · effort (provider).
  const codeDone = await s.code.eval<string>(`document.querySelector('${CODE_STEP("done")} [data-moss-done-model]')?.getAttribute('data-moss-done-model') ?? ''`);
  if (codeDone === "" || !words.includes(codeDone)) s.x.fail(`MOSS Code's done step names "${codeDone}", not the model step 2 showed ("${words}")`);
  pictures.push(...await codePicture(s, "3-done"));
  await s.code.click("[data-moss-welcome=start]");
  await s.code.waitFor("the guide closed", `!document.querySelector('[data-moss-welcome-step]')`);
  // It landed on the coding side: the shell's new-session page.
  await s.x.until("MOSS Code on a new code session (the shell's coding side)", 30_000, async () => {
    for (const d of await s.code.cdp.documents()) {
      const has = await s.code.cdp.evaluate(d.session, "!!document.querySelector('.cl-new-session')").catch(() => false);
      if (has === true) return true;
    }
    return undefined;
  }, 500);
  // A code session with no model of its own: its first turn is answered on the default.
  const computer = (await s.c.request<{ computers: { name: string }[] }>("computer.list", {})).computers[0]?.name;
  if (computer === undefined) s.x.fail("computer.list lists no computer");
  mkdirSync(join(s.x.userHome, "setup-work"), { recursive: true });
  const session = (await s.c.request<{ session: string }>("agent.start", { backend: "moss-code", computer, root: `home/${computer}/setup-work` }, 60_000)).session;
  await s.c.request("session.attach", { id: session });
  const asked = s.x.fake.requests.length;
  const events = await turnIn(s.x, s.c, session, "ACCEPTANCE-REPLY: first words");
  const mine = s.x.fake.requests.slice(asked).filter((r) => r.path.endsWith("/messages"));
  const upstream = rec!.slice(rec!.indexOf("/") + 1);
  if (!events.some((e) => e.type === "assistant_message" && (e.text ?? "").includes("ACCEPTANCE-REPLY-OK"))) s.x.fail(`the code session's first turn got no reply (${events.map((e) => e.type).join(", ")}${events.find((e) => e.type === "agent_error")?.message ? `: ${events.find((e) => e.type === "agent_error")!.message}` : ""})`);
  if (!mine.some((r) => r.model === upstream)) s.x.fail(`the turn didn't run on the default ${rec}: the fake saw ${[...new Set(mine.map((r) => r.model))].join(", ") || "no request"}`);
  s.turn = { since: asked, upstream };
  return `the key typed in MOSS Code's guide signed Anthropic in; setup.state: ready, default ${st.default!.model} at ${st.default!.effort} (${st.default!.source}), the Claude family's default; the guide's model step showed it chosen; Start landed on the shell's new code session; a code session with no model of its own got its reply on ${upstream}${pictures.length > 0 ? `; pictures: ${pictures.length}` : ""}`;
}

async function lightRow(s: Ctx): Promise<string> {
  if (s.turn === undefined) s.x.fail("the one-provider row didn't run, so there is no first turn to read the title's request against");
  const { since, upstream } = s.turn!;
  const light = lightModelOn(activeCatalog(), "anthropic", "claude");
  if (light === undefined) s.x.fail("the catalog has no light model for Claude on anthropic");
  const lightWire = light!.tag.slice(light!.tag.indexOf("/") + 1);
  const wire = (activeCatalog().models.find((m) => m.key === light!.tag) as { upstreamId?: string } | undefined)?.upstreamId ?? lightWire;
  // The title job's request carries the title instruction; the turn's carries the session's own prompt.
  const isTitle = (r: { path: string; body?: unknown }) => r.path.endsWith("/messages") && JSON.stringify(r.body ?? "").includes(TITLE_INSTRUCTION);
  const title = await s.x.until("the title job's request to the fake", 60_000, async () => s.x.fake.requests.slice(since).find(isTitle), 500);
  if (title.model !== wire) s.x.fail(`the title was asked of ${String(title.model)}, not Claude's light model ${wire}`);
  if (wire === upstream) s.x.fail(`the light model (${wire}) is the default (${upstream}): the row proves nothing`);
  const turns = s.x.fake.requests.slice(since).filter((r) => r.path.endsWith("/messages") && !isTitle(r));
  if (turns.length === 0 || turns.some((r) => r.model !== upstream)) s.x.fail(`the turn's own requests were not all on the default ${upstream}: ${[...new Set(turns.map((r) => r.model))].join(", ") || "none"}`);
  return `on the one-Anthropic-key home the title's request named ${wire} (Claude's light model) while the turn's ${turns.length} request(s) named ${upstream}, the default`;
}

async function pickRow(s: Ctx): Promise<string> {
  const before = await setupState(s.c);
  // The second provider, signed in as the person would (its plugin's key), over the run's client.
  const auth = await s.c.request<{ auth: { index: number; method: string }[] }>("plugin.auth.list", { id: SECOND_PLUGIN });
  const entry = auth.auth.find((a) => a.method === "api-key");
  if (entry === undefined) s.x.fail(`${SECOND_PLUGIN} has no api-key sign-in`);
  const signed = await s.c.request<{ state: string }>("plugin.auth.signIn", { id: SECOND_PLUGIN, index: entry!.index, key: s.x.dummyKey });
  if (signed.state !== "signed-in") s.x.fail(`${SECOND_PLUGIN} is ${signed.state}`);
  const two = await s.x.until("setup.state with both providers", 30_000, async () => { const x = await setupState(s.c); return x.providers.includes(SECOND_PROVIDER) ? x : undefined; }, 300);
  if (two.default?.model !== before.default?.model) s.x.fail(`adding a second provider changed the default: ${before.default?.model} → ${two.default?.model}`);
  // In MOSS's guide (opened again from Settings in the first row): Next, Change, the picker, Next.
  await s.moss.waitFor("MOSS's guide at its first step", `!!document.querySelector('${MOSS_STEP("providers")}')`);
  await s.moss.waitFor("MOSS's guide counting the providers added", "Number(document.querySelector('[data-setup-ready]')?.getAttribute('data-setup-ready') ?? 0) >= 2 || null", 30_000);
  await s.moss.click("[data-setup=next]");
  await s.moss.waitFor("MOSS's model step, the default shown chosen", `document.querySelector('${MOSS_STEP("model")} [data-setup-default]')?.getAttribute('data-setup-default') ?? null`);
  const pictures = [...await mossPicture(s, "2-model")];
  // Step 2 as shown ("Claude Opus 5.5 · medium · Anthropic"), Next with it unchanged, and the done step names the same
  // model the same way; the picture of step 3 comes from here, so the set reads as one walk-through. Then Back.
  const step2 = await s.moss.eval<string>(`(() => { const c = document.querySelector('${MOSS_STEP("model")} .setup__chosen'); if (!c) return ''; const p = c.querySelectorAll('span.muted'); return (c.querySelector('strong')?.textContent ?? '') + (p[p.length - 1]?.textContent ?? ''); })()`);
  await s.moss.click("[data-setup=next]");
  const done1 = await s.moss.waitFor<string>("MOSS's done step with the model step 2 showed", `document.querySelector('${MOSS_STEP("done")} [data-setup-done-model]')?.getAttribute('data-setup-done-model') ?? null`);
  if (step2 === "" || done1 !== step2) s.x.fail(`MOSS's done step names "${done1}", step 2 showed "${step2}"`);
  const kept = await setupState(s.c);
  if (kept.default?.model !== before.default?.model || kept.default?.effort !== before.default?.effort) s.x.fail(`Next with the shown default changed it: ${JSON.stringify(kept.default)} (was ${JSON.stringify(before.default)})`);
  pictures.push(...await mossPicture(s, "3-done"));
  await s.moss.click("[data-setup=back]");
  await s.moss.waitFor("MOSS's model step again", `!!document.querySelector('${MOSS_STEP("model")} [data-setup-default]')`);
  await s.moss.click("[data-setup=change]");
  await s.moss.waitFor("the guide's picker", "!!document.querySelector('[data-setup-model-picker]')");
  pictures.push(...await mossPicture(s, "2-model-picker"));
  const offered = await s.moss.eval<string[]>("[...document.querySelectorAll('[data-setup-model-picker] option')].map((o) => o.value)");
  if (!offered.includes(SECOND_MODEL)) s.x.fail(`the picker doesn't offer ${SECOND_MODEL} (${offered.length} offered)`);
  if (offered.some((m) => !m.startsWith("anthropic/") && !m.startsWith(`${SECOND_PROVIDER}/`))) s.x.fail(`the picker offers a model of a provider not added: ${offered.find((m) => !m.startsWith("anthropic/") && !m.startsWith(`${SECOND_PROVIDER}/`))}`);
  // The person's pick: the select changed the way a keyboard choice does, then Next pressed.
  await s.moss.click("[data-setup-model-picker]");
  await s.moss.eval(`(() => { const el = document.querySelector('[data-setup-model-picker]'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(el, ${JSON.stringify(SECOND_MODEL)}); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  for (const type of ["keyDown", "keyUp"]) await s.moss.cdp.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, await s.moss.session()).catch(() => undefined);
  await s.moss.click("[data-setup=next]");
  await s.moss.waitFor("MOSS's done step", `!!document.querySelector('${MOSS_STEP("done")}')`);
  const picked = await setupState(s.c);
  if (picked.default?.model !== SECOND_MODEL || picked.default.source !== "chosen") s.x.fail(`after the pick setup.state's default is ${JSON.stringify(picked.default)}, not ${SECOND_MODEL} chosen`);
  // The done step names the pick as the picker listed it, its effort (as stored) and its provider.
  const pickedTitle = await s.moss.eval<string>(`[...document.querySelectorAll('option')].find((o) => o.value === ${JSON.stringify(SECOND_MODEL)})?.textContent ?? ''`).catch(() => "");
  const done2 = await s.moss.eval<string>(`document.querySelector('${MOSS_STEP("done")} [data-setup-done-model]')?.getAttribute('data-setup-done-model') ?? ''`);
  const effortSaid = picked.default.effort !== undefined ? ` · ${picked.default.effort}` : "";
  if (!done2.includes(effortSaid) || (picked.default.effort === undefined && /· (low|medium|high|xhigh|max) ·/.test(done2)) || (pickedTitle !== "" && !done2.startsWith(pickedTitle))) s.x.fail(`MOSS's done step names "${done2}" for the pick ${SECOND_MODEL} (stored effort ${picked.default.effort ?? "none"})`);
  await s.moss.click("[data-setup=start]");
  await s.moss.waitFor("the MOSS guide closed, the default bot's conversation open", `!document.querySelector('[data-setup-step]') && document.querySelector('main.conversation')?.getAttribute('aria-label') === "MOSS's conversation"`);
  const focused = await s.moss.waitFor<boolean>("the composer ready to type", "document.activeElement?.closest('[data-composer]') !== null && document.activeElement?.tagName === 'TEXTAREA'", 10_000).catch(() => false);
  // Her next turn runs on the pick.
  const asked = s.x.fake.requests.length;
  await s.moss.type("[data-composer] textarea", "ACCEPTANCE-REPLY: on the picked model");
  await s.moss.click("button.send");
  await s.x.until("MOSS's reply on the picked model", 90_000, async () => {
    const page = await s.c.request<{ events: { type: string; text?: string }[] }>("bot.conversation", { id: "alpha", limit: 50 }).catch(() => undefined);
    return page?.events.some((e) => e.type === "assistant_message" && (e.text ?? "").includes("ACCEPTANCE-REPLY-OK")) ? true : undefined;
  }, 500);
  const mine = s.x.fake.requests.slice(asked).filter((r) => r.path.endsWith("/messages"));
  const upstream = SECOND_MODEL.slice(SECOND_MODEL.indexOf("/") + 1);
  if (!mine.some((r) => r.model === upstream)) s.x.fail(`MOSS's turn didn't run on the pick ${SECOND_MODEL}: the fake saw ${[...new Set(mine.map((r) => r.model))].join(", ") || "no request"}`);
  return `a second provider (${SECOND_PROVIDER}) left the default ${before.default?.model}; MOSS's picker offered only the added providers' ${offered.length} models; the pick ${SECOND_MODEL} is setup.state's chosen default; Talk to MOSS opened her conversation${focused === true ? " with the composer focused" : ""}; her turn ran on ${upstream}${pictures.length > 0 ? `; pictures: ${pictures.length}` : ""}`;
}

/** What is drawn at the centre of an element of MOSS's page: whether the element itself (or something in it) is the
 *  topmost there, and else what covers it. */
async function topmostAt(s: Ctx, selector: string): Promise<{ on: boolean; cover: string }> {
  return s.moss.eval<{ on: boolean; cover: string }>(`((sel) => {
    const e = document.querySelector(sel);
    if (!e) return { on: false, cover: 'not drawn' };
    // In view first, as the person scrolls to it: a card below the fold is at no point of the window yet.
    e.scrollIntoView({ block: 'nearest' });
    const r = e.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) return { on: false, cover: 'out of view' };
    if (r.width === 0 || r.height === 0) return { on: false, cover: 'no size' };
    // The middle of the part of it the window shows (a card taller than the window shows only a part).
    const top = Math.max(r.top, 0), bottom = Math.min(r.bottom, innerHeight);
    const t = document.elementFromPoint(r.left + r.width / 2, top + (bottom - top) / 2);
    const on = !!t && (t === e || e.contains(t));
    return { on, cover: t ? (t.closest('[class]')?.className || t.tagName) : 'nothing' };
  })(${JSON.stringify(selector)})`);
}

/** A real press on a card's Approve in MOSS's window (the pointer in, the sealed page's ready mark, a trusted click),
 *  as moss-step.ts presses it; one more press when the card says press again. What MOSS said. */
async function pressApprove(s: Ctx, cardId: string): Promise<string> {
  const prefix = `moss-sealed://card/${encodeURIComponent(cardId)}/own`;
  const doc = await s.x.until(`the card ${cardId}'s sealed frame in MOSS's window`, 30_000, async () => (await s.moss.cdp.documents()).find((d) => d.url.startsWith(prefix)), 300);
  const sel = ".seal-button[data-kind=approve]:not([data-remember])";
  const tried: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    // The card grows to its own height once its frame draws and the conversation scrolls under it: the person waits
    // for it to settle, scrolls the button into view and presses.
    let last = -1;
    await s.x.until("the card's frame at its own height", 10_000, async () => {
      const h = await s.moss.eval<number>(`document.querySelector('iframe[data-card-frame=${JSON.stringify(cardId)}]')?.getBoundingClientRect().height ?? -1`);
      const steady = h > 0 && h === last;
      last = h;
      return steady ? true : undefined;
    }, 300).catch(() => undefined);
    const inFrame = await s.x.until("the card's Approve button", 15_000, () => s.moss.cdp.centerOf(doc.session, sel), 250);
    await s.moss.eval(`((id, y) => {
      const f = document.querySelector('iframe[data-card-frame="' + id + '"]');
      if (!f) return false;
      let p = f.parentElement;
      while (p && !(p.scrollHeight > p.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(p).overflowY))) p = p.parentElement;
      if (!p) return true;
      const pr = p.getBoundingClientRect(), fr = f.getBoundingClientRect();
      p.scrollTop += (fr.top + y) - (pr.top + pr.height / 2);
      return true;
    })(${JSON.stringify(cardId)}, ${inFrame.y})`);
    await sleep(400);
    const btn = await s.x.until("the card's Approve button", 15_000, () => s.moss.cdp.centerOf(doc.session, sel), 250);
    const from = s.x.readLog(s.mossLog).length;
    await s.moss.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: btn.x, y: btn.y, button: "none", buttons: 0 }, doc.session).catch(() => undefined);
    await s.x.until("the sealed page's ready-to-answer mark", 15_000, async () => ((await s.moss.cdp.evaluate(doc.session, "document.body.dataset.ready ?? 'none'").catch(() => "gone")) === "yes" ? true : undefined), 100);
    await sleep(200);
    await s.moss.cdp.click(doc.session, btn.x, btn.y);
    const said = await s.x.until(`MOSS's answer for the card ${cardId}`, 15_000, () => {
      const text = s.x.readLog(s.mossLog).slice(from);
      if (text.includes(`sealed: answer accepted for ${cardId}`)) return "accepted";
      const word = /sealed: press on \S+: (covered|no-pointer|opening|late)\b/.exec(text.split("\n").filter((l) => l.includes(`press on ${cardId}`)).join("\n"))?.[1];
      if (word !== undefined) return word;
      if (new RegExp(`sealed: a press over ${cardId} [^\\n]*reached no sealed page`).test(text)) return "missed";
      return /sealed: answer refused \([^\n]*/.exec(text)?.[0];
    }, 200).catch(() => "unheard");
    if (said === "accepted") return attempt === 0 ? "pressed once" : `pressed again after "${tried.join(", ")}"`;
    if (attempt === 0 && (said === "late" || said === "missed" || said === "no-pointer" || said === "opening" || said === "unheard")) { tried.push(said); continue; }
    s.x.fail(`the press on the card's Approve in MOSS: ${said}${tried.length > 0 ? ` (before it: ${tried.join(", ")})` : ""}`);
  }
  return s.x.fail(`the card's Approve in MOSS was not answered at 2 presses (${tried.join(", ")})`);
}

async function cardRow(s: Ctx): Promise<string> {
  // MOSS's guide opened again (the person's way is Settings; the test hook opens it at the same step) over her
  // conversation, and it covers the window.
  await s.moss.eval("(window.__mossTest.go({ bot: 'alpha' }), true)");
  await s.moss.waitFor("MOSS's conversation shown", `document.querySelector('main.conversation')?.getAttribute('aria-label') === "MOSS's conversation"`);
  await s.moss.eval("(window.__mossTest.go({ guide: 'model' }), true)");
  await s.moss.waitFor("MOSS's guide open at its model step", `!!document.querySelector('${MOSS_STEP("model")}') && document.querySelector('.setup-holder')?.hidden === false`);
  const covered = await topmostAt(s, "main.conversation");
  if (covered.on) s.x.fail("MOSS's guide is open but her conversation is still the topmost thing drawn: the guide doesn't cover the window");
  // A card for this window while the guide is open: her turn's Write asks for approval.
  const before = new Set((await s.c.request<{ cards: { id: string }[] }>("card.list")).cards.map((k) => k.id));
  // session.send on her record's main session (the driver's connection on a packaged run is the cli role, which has
  // no user.send).
  const own = (await s.c.request<{ bots: { id: string; mainSession: string }[] }>("bot.records", {})).bots.find((b) => b.id === "alpha")?.mainSession;
  if (own === undefined) s.x.fail("bot.records lists no default bot (alpha)");
  await s.c.request("session.send", { id: own, message: { text: "ACCEPTANCE-WRITE while the guide is open", clientMessageId: randomUUID() } }, 30_000);
  const card = await s.x.until("the Write's approval card", 90_000, async () => (await s.c.request<{ cards: { id: string; kind: string }[] }>("card.list")).cards.find((k) => !before.has(k.id)), 300);
  const place = await s.x.until("the router's place for the card", 20_000, async () => {
    const r = await s.c.request<{ placements: { card: string; place: { kind: string; program?: string; window?: string } }[] }>("card.placement", { ids: [card.id] });
    const p = r.placements.find((x) => x.card === card.id)?.place;
    return p !== undefined && (p.kind === "conversation" || p.kind === "strip") ? p : undefined;
  }, 300);
  if (place.program !== "moss") s.x.fail(`the router placed the card in ${place.program}/${place.window}, not in MOSS's window`);
  const frame = `iframe[data-card-frame=${JSON.stringify(card.id)}]`;
  await s.moss.waitFor("the card's frame drawn in MOSS's window", `!!document.querySelector(${JSON.stringify(frame)})`, 30_000);
  // Where it is drawn, as it is drawn: the topmost thing at the card's centre is the card, not the guide.
  const shown = await s.x.until("the card the topmost thing at its own centre", 10_000, async () => {
    const t = await topmostAt(s, frame);
    return t.on ? t : undefined;
  }, 250).catch(async () => s.x.fail(`the card is drawn ${place.kind === "conversation" ? "in her conversation" : "in MOSS's strip"} but covered there by ${(await topmostAt(s, frame)).cover}, with the guide ${await s.moss.eval<string>("document.querySelector('.setup-holder')?.dataset.setupAside ?? 'gone'") === "yes" ? "aside" : "over it"}`));
  void shown;
  const aside = await s.moss.eval<string | null>("document.querySelector('.setup-holder')?.dataset.setupAside ?? null");
  if (aside !== "yes") s.x.fail(`the guide didn't step aside for the card (${aside ?? "gone"})`);
  const pressed = await pressApprove(s, card.id);
  await s.x.until("the card answered", 15_000, async () => ((await s.c.request<{ cards: { id: string }[] }>("card.list")).cards.some((k) => k.id === card.id) ? undefined : true), 300);
  // Back once no card waits, at the step it was on.
  await s.moss.waitFor("MOSS's guide back at its model step once no card waits", `!!document.querySelector('${MOSS_STEP("model")}') && document.querySelector('.setup-holder')?.hidden === false`, 30_000);
  await s.moss.waitFor("the guide topmost again", `(() => { const r = document.querySelector('.setup__card')?.getBoundingClientRect(); if (!r) return false; const t = document.elementFromPoint(r.left + r.width / 2, r.top + 20); return !!t && !!t.closest('.setup'); })()`, 10_000);
  // Leave it closed for whatever runs next.
  await s.moss.eval("(window.__mossTest.go({ guide: false }), true)");
  return `the guide open at its model step covered MOSS's conversation; the Write's approval card (placed ${place.kind} of ${place.program}/${place.window}) was the topmost thing at its centre with the guide aside; Approve ${pressed}; the guide was back at its model step`;
}
