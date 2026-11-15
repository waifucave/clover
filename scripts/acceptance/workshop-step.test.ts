// The workshop row's own parts, held without a run: the plugin Alpha writes is the tool template's, valid, with its
// edits each landing exactly once; the scripted fake calls each tool of the row with exactly the input the row means
// (the longest Write included); the peer bot's fixture is valid; a step's failure names it; and what "waits on a card"
// means is read whole.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateManifest } from "../../packages/plugin-sdk/src/index";
import { templateFiles } from "../../packages/plugin-sdk/src/templates/index";
import { validatePluginFolder } from "../../packages/core/src/registry/validate";
import { startFakeAnthropic } from "./fake-anthropic";
import { FULL_STEPS } from "./steps";
import { CARDS_STEP } from "./cards-step";
import {
  ADD_CAPABILITY, BUILT_BY_ALPHA, DEVICES_LINE, DROP_ID, DROP_NAME, DROP_TOOL, dropCommand, dropFiles, GREETING, NOTIFY_LINE, PEER_ID, SECOND_REQUEST, WORKSHOP_ID, WORKSHOP_NAME, WORKSHOP_STEP,
  WORKSHOP_TOOL, answerFor, callText, reloadMiss, stepOf, waitingProblems, workshopFiles,
} from "./workshop-step";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const count = (text: string, part: string) => text.split(part).length - 1;

describe("the plugin Alpha builds", () => {
  test("is the tool template's files with its tool renamed, and validates", async () => {
    const files = workshopFiles();
    const made = templateFiles("tool", { id: WORKSHOP_ID, name: WORKSHOP_NAME });
    if ("error" in made) throw new Error(made.error);
    expect(Object.keys(files)).toEqual(Object.keys(made.files));
    expect(files["clover.json"]).toContain(`"${WORKSHOP_TOOL}": "preload"`);
    expect(files["host/index.ts"]).toContain(`name: "${WORKSHOP_TOOL}"`);
    expect(files["host/index.ts"]).not.toContain('"hello"');
    const root = realpathSync(mkdtempSync(join(tmpdir(), "lane-d-workshop-")));
    temps.push(root);
    const dir = join(root, WORKSHOP_ID);
    for (const [p, body] of Object.entries(files)) await Bun.write(join(dir, p), body);
    const v = await validatePluginFolder(dir, { os: "macos" });
    expect(v.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(v.plugin?.toolNames).toEqual([`mcp__${WORKSHOP_ID}__${WORKSHOP_TOOL}`]);
  });

  test("each edit's old text is in its file exactly once, and the capability edit makes a manifest that asks for notify", () => {
    const files = workshopFiles();
    expect(count(files["host/index.ts"]!, GREETING.first)).toBe(1);
    const edited = files["host/index.ts"]!.replace(GREETING.first, GREETING.second);
    expect(count(edited, GREETING.second)).toBe(1);
    expect(count(files["clover.json"]!, ADD_CAPABILITY.old)).toBe(1);
    const asked = JSON.parse(files["clover.json"]!.replace(ADD_CAPABILITY.old, ADD_CAPABILITY.new)) as Record<string, unknown>;
    const r = validateManifest(asked);
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(r.capabilities).toEqual(["notify"]);
    // 5b's request goes on the manifest as step 5 left it, once, and comes back out to exactly that.
    const stepFive = files["clover.json"]!.replace(ADD_CAPABILITY.old, ADD_CAPABILITY.new);
    expect(count(stepFive, SECOND_REQUEST.old)).toBe(1);
    const second = stepFive.replace(SECOND_REQUEST.old, SECOND_REQUEST.new);
    expect(validateManifest(JSON.parse(second)).capabilities).toEqual(["notify", "devices.read"]);
    expect(second.replace(SECOND_REQUEST.new, SECOND_REQUEST.old)).toBe(stepFive);
    expect(answerFor(GREETING.second)).toBe("Hi again, Acceptance!");
    expect(answerFor(GREETING.first)).toBe("Hello, Acceptance!");
  });
});

test("the plugin Alpha drops in is the tool template's under its own id and tool, valid, and the move names both folders", async () => {
  const files = dropFiles();
  expect(files["clover.json"]).toContain(`"${DROP_TOOL}": "preload"`);
  expect(files["host/index.ts"]).toContain(GREETING.first);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lane-a-drop-")));
  temps.push(root);
  for (const [p, body] of Object.entries(files)) await Bun.write(join(root, DROP_ID, p), body);
  const v = await validatePluginFolder(join(root, DROP_ID), { os: "macos" });
  expect(v.issues.filter((i) => i.severity === "error")).toEqual([]);
  expect(v.plugin?.toolNames).toEqual([`mcp__${DROP_ID}__${DROP_TOOL}`]);
  expect(JSON.parse(files["clover.json"]!).name).toBe(DROP_NAME);
  expect(dropCommand("/h/scratch/alpha/ws-dropped", "/h/plugins")).toBe('mv "/h/scratch/alpha/ws-dropped" "/h/plugins"/');
});

test("the peer bot's fixture is a valid plain bot with no code", async () => {
  const v = await validatePluginFolder(resolve(import.meta.dir, "fixtures", PEER_ID), { os: "macos" });
  expect(v.issues.filter((i) => i.severity === "error")).toEqual([]);
  expect(v.plugin?.class).toBe("data");
  expect(v.plugin?.contributions.map((c) => c.point)).toEqual(["bot"]);
});

test("the scripted fake calls each of the row's tools with exactly the row's input", async () => {
  const fake = startFakeAnthropic({ key: "dummy-key", writePath: "/nonexistent/lane-d", writeContent: "x" });
  try {
    const tools = ["Glossary", "Read", "Write", "Edit", "Bash", "PluginValidate", "PluginInstall", "PluginStatus", "mcp__builder__PluginNew", `mcp__${WORKSHOP_ID}-tools__${WORKSHOP_TOOL}`, `mcp__${DROP_ID}-tools__${DROP_TOOL}`];
    const home = "/Users/someone/.clover";
    const files = workshopFiles();
    const calls: [string, Record<string, unknown>, string][] = [
      ["PluginNew", { template: "tool", id: WORKSHOP_ID, name: WORKSHOP_NAME }, "mcp__builder__PluginNew"],
      ...Object.entries(files).map(([p, content]) => ["Write", { file_path: `${home}/scratch/alpha/${WORKSHOP_ID}/${p}`, content }, "Write"] as [string, Record<string, unknown>, string]),
      ["PluginValidate", { folder: WORKSHOP_ID }, "PluginValidate"],
      ["PluginInstall", { folder: WORKSHOP_ID }, "PluginInstall"],
      ["PluginStatus", { id: WORKSHOP_ID }, "PluginStatus"],
      [WORKSHOP_TOOL, { name: "Acceptance" }, `mcp__${WORKSHOP_ID}-tools__${WORKSHOP_TOOL}`],
      ["Edit", { file_path: `${home}/plugins/${WORKSHOP_ID}/host/index.ts`, old_string: GREETING.first, new_string: GREETING.second }, "Edit"],
      ["Edit", { file_path: `${home}/plugins/${WORKSHOP_ID}/clover.json`, old_string: ADD_CAPABILITY.old, new_string: ADD_CAPABILITY.new }, "Edit"],
      ["Edit", { file_path: `${home}/plugins/${WORKSHOP_ID}/clover.json`, old_string: SECOND_REQUEST.old, new_string: SECOND_REQUEST.new }, "Edit"],
      ...Object.entries(dropFiles()).map(([p, content]) => ["Write", { file_path: `${home}/scratch/alpha/${DROP_ID}/${p}`, content }, "Write"] as [string, Record<string, unknown>, string]),
      ["Bash", { command: dropCommand(`${home}/scratch/alpha/${DROP_ID}`, `${home}/plugins`), description: "Install the plugin by moving it into the plugins folder" }, "Bash"],
      [DROP_TOOL, { name: "Acceptance" }, `mcp__${DROP_ID}-tools__${DROP_TOOL}`],
    ];
    for (const [tool, input, name] of calls) {
      const text = callText(tool, input);
      expect(text.length).toBeLessThan(4000); // the fake reads the last 4,000 characters of the user's text
      const r = await fetch(`${fake.url}/v1/messages`, {
        method: "POST", headers: { "x-api-key": "dummy-key", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 10, tools: tools.map((t) => ({ name: t, input_schema: { type: "object" } })), messages: [{ role: "user", content: [{ type: "text", text }] }] }),
      });
      const body = await r.json() as { content: { type: string; name?: string; input?: unknown }[] };
      const use = body.content.find((b) => b.type === "tool_use");
      expect({ tool, name: use?.name, input: use?.input }).toEqual({ tool, name, input });
    }
  } finally {
    fake.close();
  }
});

test("a step's failure names the step, once", async () => {
  const err = await stepOf("2. PluginInstall lands it", async () => { throw new Error("no OK card"); }).catch((e: Error) => e);
  expect((err as Error).message).toBe("2. PluginInstall lands it: no OK card");
  const again = await stepOf("2. PluginInstall lands it", async () => { throw err; }).catch((e: Error) => e);
  expect((again as Error).message).toBe("2. PluginInstall lands it: no OK card");
});

test("waiting on its OK card: the card names the new line, the plugin paused, nothing granted; each miss is named", () => {
  expect(waitingProblems({ cardLine: true, state: "found", granted: [], cap: "notify" })).toEqual([]);
  const all = waitingProblems({ cardLine: false, state: "running", granted: ["notify"], cap: "notify" });
  expect(all).toHaveLength(3);
  expect(all[0]).toContain("doesn't name what notify lets it do");
  expect(all[1]).toContain("kept running while the card waits");
  expect(all[2]).toContain("`notify` was granted");
});

test("the lines the OK card must carry are the capability catalog's own", async () => {
  const { CAPABILITIES } = await import("../../packages/plugin-sdk/src/index");
  const ok = (name: string) => (CAPABILITIES as readonly { name: string; ok: string }[]).find((c) => c.name === name)?.ok;
  expect(ok("notify")).toBe(NOTIFY_LINE);
  expect(ok("devices.read")).toBe(DEVICES_LINE);
});

test("a reload that never came says how long the row waited and what the tree hash did", () => {
  expect(reloadMiss(20_300, "h1", { state: "running", treeHash: "h1" })).toBe("waited 20.3 s; its tree hash never changed (the edit wasn't seen); its state is running");
  expect(reloadMiss(20_000, "h1", { state: "found", treeHash: "h2" })).toBe("waited 20.0 s; its tree hash changed; its state is found");
  expect(reloadMiss(1_000, "h1", undefined)).toContain("no tree hash");
});

test("the row sits after the card-placing row, and its name says each step", () => {
  expect(FULL_STEPS.indexOf(WORKSHOP_STEP)).toBe(FULL_STEPS.indexOf(CARDS_STEP) + 1);
  for (const part of ["PluginNew", "PluginValidate", "PluginInstall", "PluginStatus", "Edit in place", "capability", "answered No", "another bot", "the drop"]) expect(WORKSHOP_STEP).toContain(part);
  expect(BUILT_BY_ALPHA).toBe("Built by Alpha. Alpha can change its code later without asking, within what this card lists.");
});
