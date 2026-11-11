// The Agent tool starting from a plugin's agent definition: the definition brings words only (its instructions before
// the bot's brief; its backend, model and effort where the bot left them out, under the same checks); the folder and
// the computer are always the bot's; the result says whose definition it used.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentDefinitionOf } from "../../runtime-sdk/turn-loop/glossary";
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

test("a definition's words go before the brief; its backend and model fill what the bot left out, checked the same", async () => {
  const { agent, started, checked } = setup();
  const out = await agent.run({ agent: "alpha:study-buddy", prompt: "Summarise the Nile chapter.", root: "home/Studio/egypt" });
  expect(out.isError).toBe(false);
  expect(out.text).toContain("with alpha's agent definition study-buddy");
  expect(started[0]).toMatchObject({ backend: "clover-code", model: "anthropic/claude-haiku-5-5", root: "home/Studio/egypt", title: "Study buddy", prompt: "Write notes.md, sourced.\n\n---\n\nSummarise the Nile chapter." });
  expect(checked).toEqual(["anthropic/claude-haiku-5-5"]);
  // The bot's own choices win; the folder and the computer are only ever the bot's.
  await agent.run({ agent: "alpha:study-buddy", prompt: "x", root: "home/Studio/b", backend: "codex", model: "anthropic/claude-sonnet-5-5", computer: "Laptop" });
  expect(started[1]).toMatchObject({ backend: "codex", model: "anthropic/claude-sonnet-5-5", root: "home/Studio/b", computer: "Laptop" });
});

test("a definition can't widen anything: its model is checked, its backend must be one offered, and it never names the folder", async () => {
  const bad = setup({ model: "openrouter/qwen-4-max" });
  expect(await bad.agent.run({ agent: "alpha:study-buddy", prompt: "x", root: "home/Studio/a" })).toEqual({ text: "not allowed", isError: true });
  expect(bad.started).toHaveLength(0);
  const odd = setup({ backend: "made-up" });
  expect((await odd.agent.run({ agent: "alpha:study-buddy", prompt: "x", root: "home/Studio/a" })).text).toContain("no agent backend made-up");
  const { agent, started } = setup();
  expect((await agent.run({ agent: "alpha:study-buddy", prompt: "x" })).isError).toBe(true);
  expect((await agent.run({ agent: "nope:x", prompt: "x", root: "home/Studio/a" })).text).toContain("no agent definition nope:x");
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
