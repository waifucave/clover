// An agent backend from a plugin (checklist 1.51 and 4.25), with a fake in place of a vendor's CLI. The fixture
// (scripts/acceptance/fixtures/acceptance-acp) is a plugin whose `agentBackends` entry is an ACP backend; its program is
// the fake ACP agent the core's backend conformance suite runs (packages/core/src/agents/testing/fake-acp-agent.ts),
// a real process speaking ACP over stdio, scripted to say one line and call the Clover server it is given.
//
// 1. Installed from its folder (the run writes the program's and the config's absolute paths in first, as the echo fixture
//    gets its targets): its OK card pressed in the window, it runs, and `agent.backends` lists the backend: installed,
//    named beside its plugin, marked as acting without asking (a third party's) and as not sandboxed.
// 2. A coding session started on it the way the app starts one (`agent.start`, no bot): the fake agent's reply is in the
//    session's conversation, and the agent's own report shows what crossed the wire: the prompt, and the Clover server
//    it was given at `session/new`, which it started and called (`Glossary`, the one tool a coding session the user
//    drives is given); the call's answer is in the session too.
// Removed afterwards, whatever happened.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fail, leave, until, type ExampleCtx } from "./example-steps";

export const ACP_BACKEND_STEP = "an agent backend from a plugin (ACP, a fake agent in place of a vendor's CLI): the fixture plugin installs from its folder behind its OK card, pressed in the window, and agent.backends lists its backend; a coding session started on it from the app's own method gets the fake agent's reply, and the agent was given the Clover server, which it started and called";

export const ACP_ID = "acceptance-acp";
export const ACP_NAME = "Acceptance ACP";
export const ACP_REPLY = "ACCEPTANCE-ACP-REPLY: hello from the fake agent";
export const ACP_PROMPT = "ACCEPTANCE-ACP-PROMPT: say hello and list your tools";
const FIXTURE = resolve(import.meta.dir, "fixtures", ACP_ID);
/** The fake agent the core's backend conformance suite runs. */
export const FAKE_ACP_AGENT = resolve(import.meta.dir, "..", "..", "packages", "core", "src", "agents", "testing", "fake-acp-agent.ts");

type Ev = Record<string, unknown> & { type?: string };
interface Card { id: string; kind: string; session?: string; pluginId?: string }
interface Backend { id: string; name: string; pluginId: string; protocol: string; computers: { installed: boolean; sandboxed: boolean; marks: string[]; version?: string }[] }

/** The fixture's files with the run's paths written in: its manifest's command and arguments, and the quirks file's
 *  version check (the program is `<bun> <fake> <config> --version`). Pure, so a test can check the result. */
export function fixtureWith(files: Record<string, string>, paths: { bun: string; fake: string; config: string }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, body] of Object.entries(files)) out[name] = body.replaceAll("__BUN__", paths.bun).replaceAll("__FAKE__", paths.fake).replaceAll("__CONFIG__", paths.config);
  return out;
}

/** The fake agent's config: the quirks file's quirks (the fake bends the protocol as they say), the script of its one
 *  turn, and where it reports what it saw. */
export function agentConfig(quirksFile: string, o: { report: string; selection: string }): string {
  const file = JSON.parse(quirksFile) as { quirks: unknown };
  return JSON.stringify({
    quirks: file.quirks,
    version: "fake-agent 1.0.0",
    report: o.report,
    selection: o.selection,
    // One turn: its reply, then the Clover server's Glossary (no permission asked of the client: the call is the
    // bridge's own, judged by the daemon), then its closing words.
    script: [[{ say: ACP_REPLY }, { mcp: { server: "$bridge", tool: "Glossary", input: { query: "tool" }, ask: false } }, { say: " Done." }]],
  });
}

const reportOf = (file: string): { type: string; [k: string]: unknown }[] => {
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string });
  } catch {
    return [];
  }
};

export async function acpBackendStep(ctx: ExampleCtx): Promise<string> {
  try {
    return await run(ctx);
  } finally {
    await leave(ctx, ACP_ID);
  }
}

async function run(ctx: ExampleCtx): Promise<string> {
  const { rpc, root } = ctx;
  const done: string[] = [];
  const work = join(root, "acp-backend");
  const folder = join(work, "plugin-src", ACP_ID);
  const config = join(work, "agent", "agent.json");
  const report = join(work, "agent", "report.ndjson");

  // The fixture with the run's paths in, and the fake agent's config beside it (outside the plugin's folder).
  mkdirSync(dirname(config), { recursive: true });
  cpSync(FIXTURE, folder, { recursive: true });
  const written = fixtureWith({ "clover.json": readFileSync(join(folder, "clover.json"), "utf8"), "quirks.json": readFileSync(join(folder, "quirks.json"), "utf8") }, { bun: process.execPath, fake: FAKE_ACP_AGENT, config });
  for (const [name, body] of Object.entries(written)) writeFileSync(join(folder, name), body);
  writeFileSync(config, agentConfig(written["quirks.json"]!, { report, selection: join(work, "agent", "selection.json") }));

  // 1. Installed; its OK card pressed in the window; its backend listed.
  const installed = await rpc.request<{ id: string; card?: string }>("plugin.install", { source: { from: "folder", path: folder } }, 60_000);
  if (installed.id !== ACP_ID) fail(`the fixture installed as ${installed.id}`);
  const ok = await until(`${ACP_ID}'s OK card`, 60_000, async () => (await rpc.request<{ cards: Card[] }>("card.list")).cards.find((c) => c.kind === "plugin-ok" && c.pluginId === ACP_ID));
  const okText = JSON.stringify((await rpc.request<{ card: unknown }>("card.get", { id: ok.id })).card);
  if (!okText.includes(ACP_NAME)) fail(`its OK card doesn't name it: ${okText.slice(0, 400)}`);
  const before = (await rpc.request<{ backends: Backend[] }>("agent.backends", {})).backends;
  if (before.some((b) => b.id === ACP_ID)) fail("its backend is listed before the user's OK");
  await ctx.pressCard(`${ACP_ID}'s OK card`, (c) => c.id === ok.id);
  const stateOf = async () => (await rpc.request<{ plugin: { state: string } }>("plugin.get", { id: ACP_ID }).catch(() => undefined))?.plugin.state;
  await until(`${ACP_ID} running after its OK`, 60_000, async () => {
    const s = await stateOf();
    return s === "running" || s === "enabled" ? true : undefined;
  }, async () => `it is ${(await stateOf()) ?? "gone"}`);
  const listed = await until("its backend in agent.backends", 30_000, async () => (await rpc.request<{ backends: Backend[] }>("agent.backends", {})).backends.find((b) => b.id === ACP_ID),
    async () => `listed: ${(await rpc.request<{ backends: Backend[] }>("agent.backends", {})).backends.map((b) => b.id).join(", ")}`);
  const here = listed.computers[0];
  if (listed.protocol !== "acp" || listed.pluginId !== ACP_ID) fail(`its backend row reads ${JSON.stringify(listed).slice(0, 300)}`);
  if (here === undefined || !here.installed) fail(`its backend isn't installed on this computer: ${JSON.stringify(here)}`);
  if (!listed.name.includes(`(${ACP_ID})`)) fail(`its backend is named "${listed.name}", not beside its plugin`);
  if (!here!.marks.includes("unasked-actions") || here!.sandboxed) fail(`a third party's backend should count as acting without asking and unsandboxed: ${JSON.stringify(here)}`);
  done.push(`1 OK card pressed; agent.backends lists "${listed.name}" (acp, installed${here!.version === undefined ? "" : ` ${here!.version}`}, marks ${here!.marks.join("+") || "none"})`);

  // 2. A coding session on it, the way the app starts one.
  const computer = (await rpc.request<{ computers: { name: string }[] }>("computer.list", {})).computers[0]?.name;
  if (computer === undefined) fail("computer.list lists no computer");
  mkdirSync(join(ctx.userHome, "acp-work"), { recursive: true });
  const started = await rpc.request<{ session: string }>("agent.start", { backend: ACP_ID, computer, root: `home/${computer}/acp-work`, prompt: ACP_PROMPT }, 60_000);
  const session = started.session;
  const answered = new Set<string>();
  const history = (): Promise<Ev[]> => ctx.history(session).catch(() => [] as Ev[]);
  const heard = await until("the fake agent's reply in the coding session", 90_000, async () => {
    for (const c of (await rpc.request<{ cards: Card[] }>("card.list")).cards) {
      if (c.session !== session || answered.has(c.id)) continue;
      answered.add(c.id);
      await ctx.approveCard(c.id);
    }
    const evs = await history();
    return evs.find((e) => JSON.stringify(e).includes(ACP_REPLY));
  }, async () => {
    const r = reportOf(report);
    const evs = await history();
    return `the agent's report: ${r.map((x) => x.type).join(", ") || "none (it never started)"}; the session's events: ${evs.slice(-6).map((e) => `${e.type}${e.text ? `:${String(e.text).slice(0, 60)}` : ""}${e.error ? `:${JSON.stringify(e.error).slice(0, 100)}` : ""}`).join(" | ") || "none"}`;
  });
  void heard;
  const r = reportOf(report);
  const prompt = r.find((x) => x.type === "prompt");
  if (prompt === undefined || !String(prompt.text).includes(ACP_PROMPT)) fail(`the agent never got the prompt (report: ${r.map((x) => x.type).join(", ")})`);
  const made = r.find((x) => x.type === "session");
  const servers = Array.isArray(made?.servers) ? (made!.servers as string[]) : [];
  const clover = servers.find((s) => /clover/i.test(s));
  if (clover === undefined) fail(`the agent was given no Clover server at session/new (servers: ${servers.join(", ") || "none"})`);
  const spawned = r.find((x) => x.type === "mcp-started" && x.server === clover);
  if (spawned === undefined) fail(`the agent never started the ${clover} server (report: ${r.map((x) => x.type).join(", ")})`);
  const result = await until("the agent's call of the Clover server", 60_000, async () => reportOf(report).find((x) => x.type === "mcp-result"));
  if (result.isError === true) fail(`the Clover server's Glossary answered an error: ${String(result.text).slice(0, 300)}`);
  const text = String(result.text);
  if (text.trim() === "") fail("the Clover server's Glossary answered nothing");
  // The session's own conversation carries the call too (the agent's tool call, completed).
  const finished = await until("the turn to end", 60_000, async () => ((await history()).some((e) => e.type === "turn_completed") ? true : undefined),
    async () => `events: ${(await history()).slice(-6).map((e) => String(e.type)).join(", ")}`);
  void finished;
  done.push(`2 agent.start on it (session ${session}): the fake agent's reply "${ACP_REPLY.slice(0, 40)}…" is in the conversation; its report shows the prompt, the server "${clover}" given at session/new, started, and its Glossary call answered ("${text.replace(/\s+/g, " ").slice(0, 120)}")`);
  return done.join("; ");
}
