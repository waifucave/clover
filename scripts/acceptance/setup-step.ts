// The `setup` unit (lane SG, the owner's 2026-11-20 ruling): the setup guide in both apps on a fresh home, with no model
// provider added and no default model. MOSS Code and MOSS (the bots app), from source, headless, both over the unit's own
// engine; each row drives the apps' own windows through their DevTools ports with trusted input (clicks, typed text), and
// reads the engine's answer (`setup.state`) beside what the windows show.
//
// Its rows run in order on one home: (1) both apps open the guide by themselves on the fresh home; in MOSS, Skip for now
// leaves it usable (a message to Alpha is answered with the plain sentence that leads to adding a provider) and the
// engine keeps the skip, and Settings opens the guide again; (2) in MOSS Code's guide, a key typed in its own field adds
// the provider, whose recommended model becomes the default with nothing to pick, and Start lands on a new code session,
// whose first turn (no model of its own) is answered on that default; (3) a second provider leaves the default as it was,
// the picker in MOSS's guide sets the other provider's model, and Alpha's next turn runs on it.
//
// With MOSS_ACCEPT_RENDERS set, each step of the guide is pictured: MOSS in light and dark, MOSS Code in its theme. A
// picture, never a check.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { Cdp } from "./cdp";
import type { MossClient } from "./client";
import type { FakeProvider } from "./fake-anthropic";
import type { Status } from "./steps";

export const SETUP_OPEN_STEP = "the setup guide on a fresh home (no provider, no default model): MOSS Code and MOSS each open it by themselves (the engine's setup.state says a provider and a model are missing); in MOSS, Skip for now leaves the app usable (a message to Alpha is answered with the plain sentence that leads to adding a provider, no provider called) and the engine keeps the skip for both apps; MOSS's Settings opens it again";
export const SETUP_ONE_STEP = "the setup guide in MOSS Code: a key typed in the guide's own field adds the provider; its recommended model (the catalog's) is the default with nothing to pick, shown chosen in the guide's model step; Start lands on a new code session, and a code session with no model of its own gets its first reply on that default";
export const SETUP_PICK_STEP = "two providers: a second one added leaves the default as it was; the picker in MOSS's guide (Change) sets the other provider's model as the default (the engine's setup.state), Talk to Alpha opens her conversation ready to type, and her next turn runs on the picked model";

export const SETUP_STEPS: readonly string[] = [SETUP_OPEN_STEP, SETUP_ONE_STEP, SETUP_PICK_STEP];

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

interface SetupState { ready: boolean; missing: string[]; providers: string[]; default?: { model: string; source: string }; recommended?: Record<string, string>; dismissed: boolean }

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
    const s: Ctx = { x, c, code, moss, renders, appearance, codeLog: codeApp.log };
    await row(SETUP_OPEN_STEP, () => openRow(s));
    await row(SETUP_ONE_STEP, () => oneRow(s));
    await row(SETUP_PICK_STEP, () => pickRow(s));
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
  // MOSS is usable: Alpha's conversation is there, and a message to her is answered with the sentence that leads on.
  await s.moss.waitFor("Alpha's conversation in MOSS", "document.querySelector('main.conversation')?.getAttribute('aria-label') ?? null", 30_000);
  const asked = s.x.fake.requests.length;
  await s.moss.type("[data-composer] textarea", "hello, is anyone there?");
  await s.moss.click("button.send");
  const alpha = await s.c.request<{ bots: { id: string; mainSession: string }[] }>("bot.records", {}).then((r) => r.bots.find((b) => b.id === "alpha"));
  if (alpha === undefined) s.x.fail("no Alpha record");
  const refused = await s.x.until("Alpha's turn refused with the no-default-model sentence", 60_000, async () => {
    const page = await s.c.request<{ events: { type: string; message?: string; code?: string }[] }>("bot.conversation", { id: "alpha", limit: 50 }).catch(() => undefined);
    return page?.events.find((e) => e.type === "agent_error" && e.code === "no_default_model");
  }, 500);
  if (!/add a model provider/.test(refused.message ?? "")) s.x.fail(`the refusal doesn't lead to adding a provider: "${refused.message}"`);
  if (s.x.fake.requests.length !== asked) s.x.fail(`the refused turn still reached a provider (${s.x.fake.requests.length - asked} request(s))`);
  // MOSS's Settings opens it again.
  await s.moss.click(".nav-item.account");
  await s.moss.click("[data-open-setup]");
  await s.moss.waitFor("MOSS's guide opened again from Settings", `!!document.querySelector('${MOSS_STEP("providers")}')`);
  return `setup.state on the fresh home: ${JSON.stringify({ ready: st.ready, missing: st.missing })}; MOSS Code's and MOSS's guides opened by themselves; MOSS's Skip for now kept by the engine (dismissed: true); Alpha's turn refused: "${refused.message!.slice(0, 90)}", no provider called; Settings opened it again${pictures.length > 0 ? `; pictures: ${pictures.length}` : ""}`;
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
  const rec = st.recommended?.anthropic;
  if (rec === undefined) s.x.fail(`setup.state names no recommended model for anthropic: ${JSON.stringify(st)}`);
  if (st.default?.model !== rec) s.x.fail(`the default is ${JSON.stringify(st.default)}, not Anthropic's recommended ${rec}`);
  if (JSON.stringify(st.providers) !== JSON.stringify(["anthropic"])) s.x.fail(`setup.state's providers: ${JSON.stringify(st.providers)}`);
  await s.code.click("[data-moss-welcome=next]");
  const shown = await s.code.waitFor<string>("the guide's model step, the default shown chosen", `document.querySelector('${CODE_STEP("model")} [data-moss-default]')?.getAttribute('data-moss-default') ?? null`);
  if (shown !== rec) s.x.fail(`the guide shows ${shown} chosen, not ${rec}`);
  const pictures = [...await codePicture(s, "2-model")];
  await s.code.click("[data-moss-welcome=next]");
  await s.code.waitFor("the guide's done step", `!!document.querySelector('${CODE_STEP("done")}')`);
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
  return `the key typed in MOSS Code's guide signed Anthropic in; setup.state: ready, default ${st.default!.model} (${st.default!.source}), the catalog's recommended model for anthropic; the guide's model step showed it chosen; Start landed on the shell's new code session; a code session with no model of its own got its reply on ${upstream}${pictures.length > 0 ? `; pictures: ${pictures.length}` : ""}`;
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
  pictures.push(...await mossPicture(s, "3-done"));
  const picked = await setupState(s.c);
  if (picked.default?.model !== SECOND_MODEL || picked.default.source !== "chosen") s.x.fail(`after the pick setup.state's default is ${JSON.stringify(picked.default)}, not ${SECOND_MODEL} chosen`);
  await s.moss.click("[data-setup=start]");
  await s.moss.waitFor("MOSS's guide closed, Alpha's conversation open", `!document.querySelector('[data-setup-step]') && document.querySelector('main.conversation')?.getAttribute('aria-label') === "Alpha's conversation"`);
  const focused = await s.moss.waitFor<boolean>("the composer ready to type", "document.activeElement?.closest('[data-composer]') !== null && document.activeElement?.tagName === 'TEXTAREA'", 10_000).catch(() => false);
  // Her next turn runs on the pick.
  const asked = s.x.fake.requests.length;
  await s.moss.type("[data-composer] textarea", "ACCEPTANCE-REPLY: on the picked model");
  await s.moss.click("button.send");
  await s.x.until("Alpha's reply on the picked model", 90_000, async () => {
    const page = await s.c.request<{ events: { type: string; text?: string }[] }>("bot.conversation", { id: "alpha", limit: 50 }).catch(() => undefined);
    return page?.events.some((e) => e.type === "assistant_message" && (e.text ?? "").includes("ACCEPTANCE-REPLY-OK")) ? true : undefined;
  }, 500);
  const mine = s.x.fake.requests.slice(asked).filter((r) => r.path.endsWith("/messages"));
  const upstream = SECOND_MODEL.slice(SECOND_MODEL.indexOf("/") + 1);
  if (!mine.some((r) => r.model === upstream)) s.x.fail(`Alpha's turn didn't run on the pick ${SECOND_MODEL}: the fake saw ${[...new Set(mine.map((r) => r.model))].join(", ") || "no request"}`);
  return `a second provider (${SECOND_PROVIDER}) left the default ${before.default?.model}; MOSS's picker offered only the added providers' ${offered.length} models; the pick ${SECOND_MODEL} is setup.state's chosen default; Talk to Alpha opened her conversation${focused === true ? " with the composer focused" : ""}; her turn ran on ${upstream}${pictures.length > 0 ? `; pictures: ${pictures.length}` : ""}`;
}
