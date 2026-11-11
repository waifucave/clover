// The Agent tool starting from a plugin's agent definition: the definition brings words only (its instructions before
// the bot's brief), never a backend, a model, an effort, a folder or a computer; the result says whose definition it used.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeOk, validateManifest, PLUGIN_API_VERSION } from "@waifucave/clover-plugin-sdk";
import { describeSession } from "../../bots/tools";
import { agentDefinitionOf, plainName } from "../../runtime-sdk/turn-loop/glossary";
import { agentToolDefs, type AgentDefinitionView } from "../tools";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

function setup(def?: Partial<AgentDefinitionView>) {
  const started: Record<string, unknown>[] = [];
  const manager = { start: async (p: Record<string, unknown>) => (started.push(p), { sessionId: "a_1", transcript: "t.jsonl" }) } as never;
  const checked: string[] = [];
  const study: AgentDefinitionView = { pluginId: "alpha", id: "study-buddy", name: "Study buddy", prompt: "Write notes.md, sourced.", backend: "clover-code", model: "anthropic/claude-haiku-5-5", ...def };
  const [agent] = agentToolDefs(manager, { bot: "alpha", session: "b_alpha", origin: "user" }, {
    backends: () => ["clover-code", "codex"],
    checkModel: async (m) => (checked.push(m), m.startsWith("openrouter/") ? { ok: false as const, reason: "not allowed" } : { ok: true as const }),
    definition: (name) => (name === "alpha:study-buddy" ? study : undefined),
  });
  return { agent: agent!, started, checked };
}

test("a definition brings its words only: its instructions before the brief; the backend, model, folder and computer are the bot's", async () => {
  const { agent, started, checked } = setup();
  const out = await agent.run({ agent: "alpha:study-buddy", prompt: "Summarise the Nile chapter.", backend: "clover-code", root: "home/Studio/egypt" });
  expect(out.isError).toBe(false);
  expect(out.text).toContain("with alpha's agent definition study-buddy");
  // The start names the definition, from the registry's view (never the bot's words): its record and its row say it.
  expect(started[0]).toMatchObject({ definition: { pluginId: "alpha", id: "study-buddy" } });
  expect(started[0]).toMatchObject({ backend: "clover-code", root: "home/Studio/egypt", title: "Study buddy", prompt: "Write notes.md, sourced.\n\n---\n\nSummarise the Nile chapter." });
  // Its own backend and model are never taken (the controller's ruling): with none from the bot, none is used.
  expect(started[0]!.model).toBeUndefined();
  expect(checked).toEqual([]);
  await agent.run({ agent: "alpha:study-buddy", prompt: "x", root: "home/Studio/b", backend: "codex", model: "anthropic/claude-sonnet-5-5", computer: "Laptop" });
  expect(started[1]).toMatchObject({ backend: "codex", model: "anthropic/claude-sonnet-5-5", root: "home/Studio/b", computer: "Laptop" });
  expect(checked).toEqual(["anthropic/claude-sonnet-5-5"]);
});

test("a definition never names the backend: without the bot's, the call is refused; an unknown definition is too", async () => {
  const { agent, started } = setup({ backend: "clover-code" });
  expect((await agent.run({ agent: "alpha:study-buddy", prompt: "x", root: "home/Studio/a" })).isError).toBe(true);
  expect((await agent.run({ agent: "alpha:study-buddy", prompt: "x", backend: "clover-code" })).isError).toBe(true);
  expect((await agent.run({ agent: "nope:x", prompt: "x", backend: "clover-code", root: "home/Studio/a" })).text).toContain("no agent definition nope:x");
  expect(started).toHaveLength(0);
});

test("agentDefinitionOf reads a definition by Glossary's name, as words only, from a plugin whose entries reach the session", () => {
  const folder = mkdtempSync(join(tmpdir(), "clover-agentdef-"));
  temps.push(folder);
  mkdirSync(join(folder, "agents"), { recursive: true });
  writeFileSync(join(folder, "agents", "study-buddy.md"), "---\nname: study-buddy\ndescription: x\n---\n\nRead the folder, write notes.md.\n");
  const value = { id: "study-buddy", name: { en: "Study buddy" }, backend: "clover-code", instructions: "agents/study-buddy.md", root: "/", computer: "Other", plugins: { only: ["x"] } };
  const reg = {
    entries: (p: string) => (p === "agents" ? [{ point: "agents", pluginId: "alpha", ref: "agents/0", entryId: "study-buddy", value, state: "active" }] : []),
    get: (id: string) => (id === "alpha" ? { id, folder } : undefined),
  } as never;
  const def = agentDefinitionOf(reg, "alpha:study-buddy");
  expect(def).toEqual({ pluginId: "alpha", id: "study-buddy", name: "Study buddy", prompt: "Read the folder, write notes.md.", backend: "clover-code" });
  expect(agentDefinitionOf(reg, "alpha:other")).toBeUndefined();
  expect(agentDefinitionOf(reg, "alpha:study-buddy", () => false)).toBeUndefined();
});

test("a definition's name is plain text of at most 80 characters; a backend, model or effort that isn't a plain id is dropped", () => {
  expect(plainName("Study\u202e buddy\n\tnow")).toBe("Study buddy now");
  expect(plainName("x".repeat(200))).toHaveLength(80);
  const folder = mkdtempSync(join(tmpdir(), "clover-agentdef-"));
  temps.push(folder);
  const value = { id: "odd", name: "Odd\u0000 one", backend: "clover-code; rm -rf", model: "anthropic/claude-haiku-5-5", effort: "High Effort" };
  const reg = {
    entries: (p: string) => (p === "agents" ? [{ point: "agents", pluginId: "alpha", ref: "agents/0", entryId: "odd", value, state: "active" }] : []),
    get: (id: string) => (id === "alpha" ? { id, folder } : undefined),
  } as never;
  expect(agentDefinitionOf(reg, "alpha:odd")).toEqual({ pluginId: "alpha", id: "odd", name: "Odd one", prompt: "", model: "anthropic/claude-haiku-5-5" });
});

test("an agent's row says which plugin's definition it started from", () => {
  const line = describeSession({ id: "agent_1", kind: "agent", computer: "Studio", status: "idle", startedAt: 1, updatedAt: 1, backend: "clover-code", definition: "alpha:study-buddy", title: "anything the bot wrote" }, () => undefined, "b_alpha");
  expect(line).toContain("from the agent definition alpha:study-buddy");
});

test("the OK card names each agent definition a plugin brings", () => {
  const report = validateManifest({
    manifest: 1, id: "luna", name: "Luna", version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` },
    contributes: { agents: [{ id: "study-buddy", name: { en: "Study buddy" }, backend: "clover-code", instructions: "agents/study.md" }, "agents/reviewer.md"] },
  });
  expect(report.issues.filter((i) => i.severity === "error")).toEqual([]);
  const lines = describeOk(report);
  expect(lines).toContain("It adds an agent definition Study buddy: instructions an agent follows when your bot hands it work.");
  expect(lines).toContain("It adds an agent definition reviewer: instructions an agent follows when your bot hands it work.");
});
