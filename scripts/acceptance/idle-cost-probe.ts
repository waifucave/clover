// What an idle Clover costs, measured as the owner's app is drawn: the main window, the island and the pill really shown and
// composited, throttled as a hidden or covered window is, yet invisible (opacity 0, deaf to the mouse: `showInvisible`,
// apps/desktop/src/main/index.ts) so nothing shows on the screen and nothing takes a click. Not part of the acceptance run.
//
//   PROBE_NO_CAPTURE=1 \
//   PROBE_APP_ENV='{"CLOVER_TEST_INVISIBLE":"1","CLOVER_IPC_STATS":"1"}' \
//   IDLE_CASES=alpha,plain IDLE_SECONDS=60 IDLE_HISTORY=88 \
//   scripts/heavy scripts/pinned-bun scripts/acceptance/ui-probe.ts scripts/acceptance/idle-cost-probe.ts
//
// and again with the main window away (the pill and the island still shown):
//
//   PROBE_NO_CAPTURE=1 PROBE_APP_ENV='{"CLOVER_TEST_INVISIBLE":"hidden","CLOVER_IPC_STATS":"1"}' IDLE_CASES=none scripts/heavy …
//
// Cases (IDLE_CASES, comma list, run in order): `alpha` opens Alpha's tab, `plain` the first other bot's tab, `none` leaves the
// window as it opened. Each waits 8 s (what opening a tab starts is not idle), then IDLE_SECONDS of nothing, and prints the app's
// own `ipc:` lines (messages by channel, CPU by process; ipc-stats.ts) and their mean. IDLE_HISTORY=N first gives Alpha's
// conversation N turns (the fake provider answers), so what scales with history shows: the owner's has 176 messages (88 turns).
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseIpcLine } from "../../apps/desktop/src/main/ui/ipc-stats";
import type { Cdp } from "./cdp";
import type { CloverClient } from "./client";
import { shellDoc, treeDocs } from "./ui-steps";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SIDEBAR_ITEMS = ".cl-sidebar button, .cl-sidebar a, .cl-sidebar [role=link]";
const say = (line: string) => process.stdout.write(`${line}\n`);

async function openTab(cdp: Cdp, name: string): Promise<void> {
  const end = Date.now() + 30_000;
  for (;;) {
    for (const d of await treeDocs(cdp)) {
      const c = await cdp.centerOf(d.session, SIDEBAR_ITEMS, name).catch(() => undefined);
      if (c !== undefined) {
        await cdp.click(d.session, c.x, c.y);
        await sleep(1_500);
        return;
      }
    }
    if (Date.now() > end) throw new Error(`no "${name}" in the sidebar within 30 s`);
    await sleep(500);
  }
}

async function seed(rpc: CloverClient, turns: number): Promise<number> {
  const bots = (await rpc.request<{ bots: { id: string; mainSession: string }[] }>("bot.list", {})).bots;
  const alpha = bots.find((b) => b.id === "alpha");
  if (alpha === undefined) throw new Error("no Alpha to give a history");
  const count = async () => (await rpc.request<{ events: Record<string, unknown>[] }>("session.history", { id: alpha.mainSession, limit: 500 })).events.filter((e) => e.type === "assistant_message").length;
  let have = await count();
  for (let i = 0; i < turns; i++) {
    await rpc.request("session.send", { id: alpha.mainSession, message: { text: `Idle probe turn ${i + 1}: say something short.`, clientMessageId: `idle-${i}` } }, 30_000);
    const end = Date.now() + (i === 0 ? 30_000 : 15_000);
    while ((have = await count()) <= i && Date.now() < end) await sleep(150);
  }
  if (have < turns) throw new Error(`the history stopped at ${have} replies of ${turns}: a turn got no answer within its wait`);
  return have;
}

export async function run(ctx: { cdp: Cdp; rpc: CloverClient; home: string; root: string; logs: string; dummyKey: string }): Promise<void> {
  const { cdp, rpc } = ctx;
  const cases = (process.env.IDLE_CASES ?? "alpha").split(",").map((s) => s.trim()).filter((s) => s !== "");
  const seconds = Number(process.env.IDLE_SECONDS ?? "60");
  const history = Number(process.env.IDLE_HISTORY ?? "0");
  const appLog = join(ctx.home, "logs", "app.log");
  const readLog = () => { try { return readFileSync(appLog, "utf8"); } catch { return ""; } };
  const report = join(ctx.logs, "idle-cost.txt");
  const out = (line: string) => { say(line); try { appendFileSync(report, `${line}\n`); } catch { /* the console has it */ } };

  const end = Date.now() + 120_000;
  while ((await shellDoc(cdp)) === undefined) {
    if (Date.now() > end) { out("the shell never drew (the window may be away: the app log is the evidence)"); break; }
    await sleep(500);
  }
  if (history > 0) {
    // The fake provider needs a key signed in, as the acceptance run's step 2 does (the run's own dummy, never a real one).
    const auth = await rpc.request<{ auth: { index: number; method: string }[] }>("plugin.auth.list", { id: "clover/model-anthropic" });
    const entry = auth.auth.find((a) => a.method === "api-key");
    if (entry === undefined) throw new Error("no api-key sign-in on clover/model-anthropic");
    await rpc.request("plugin.auth.signIn", { id: "clover/model-anthropic", index: entry.index, key: ctx.dummyKey });
  }
  if (history > 0) out(`history: Alpha's conversation now has ${await seed(rpc, history)} replies`);
  for (const c of cases) {
    if (c === "alpha") await openTab(cdp, "Alpha");
    else if (c === "plain") {
      const bots = (await rpc.request<{ bots: { id: string; name?: string }[] }>("bot.list", {})).bots;
      const other = bots.find((b) => b.id !== "alpha");
      if (other === undefined) { out("case plain: no other bot to open"); continue; }
      await openTab(cdp, other.name ?? other.id);
    }
    await sleep(8_000);
    const from = readLog().length;
    await sleep(seconds * 1_000);
    const lines = readLog().slice(from).split("\n").filter((l) => l.includes("ipc: "));
    out(`case ${c}: ${seconds} s idle, ${lines.length} ipc lines`);
    for (const l of lines) out(`  ${l.slice(l.indexOf("ipc: "))}`);
    const parsed = lines.flatMap((l) => { const p = parseIpcLine(l); return p === undefined ? [] : [p]; });
    if (parsed.length === 0) { out("  (no ipc lines: CLOVER_IPC_STATS=1 missing from PROBE_APP_ENV?)"); continue; }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const by = (type: string) => mean(parsed.map((p) => p.cpu.filter((x) => x.type === type).reduce((a, x) => a + x.percent, 0)));
    out(`  mean: main ${by("Browser").toFixed(1)}%, windows ${by("Tab").toFixed(1)}% together, GPU ${by("GPU").toFixed(1)}%, ${mean(parsed.map((p) => p.inPerSecond)).toFixed(1)} msgs/s in, ${mean(parsed.map((p) => p.outPerSecond)).toFixed(1)}/s out`);
  }
}
