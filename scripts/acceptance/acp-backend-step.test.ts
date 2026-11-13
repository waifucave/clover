// The ACP row's own parts, held without a run: the fixture with the run's paths written in is a valid plugin whose one
// entry is an ACP backend the core reads into a row (its quirks file passes the core's schema), the fake agent's config
// carries the same quirks and a script of one turn, and the fake agent file the fixture points at is there.
import { afterAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validatePluginFolder } from "../../packages/core/src/registry/validate";
import { readQuirksFile } from "../../packages/core/src/agents/plugin-backends";
import { FULL_STEPS } from "./steps";
import { ACP_BACKEND_STEP, ACP_ID, ACP_REPLY, FAKE_ACP_AGENT, agentConfig, fixtureWith } from "./acp-backend-step";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const FIXTURE = resolve(import.meta.dir, "fixtures", ACP_ID);

test("the row is in the table, the fake agent file is there, and the fixture holds placeholders only for the run's paths", () => {
  expect(FULL_STEPS).toContain(ACP_BACKEND_STEP);
  expect(existsSync(FAKE_ACP_AGENT)).toBe(true);
  const all = ["clover.json", "quirks.json"].map((f) => readFileSync(join(FIXTURE, f), "utf8")).join("\n");
  expect([...new Set(all.match(/__[A-Z]+__/g))].sort()).toEqual(["__BUN__", "__CONFIG__", "__FAKE__"]);
});

test("with the run's paths in, the fixture validates and the core reads its quirks file; the fake's config carries the quirks and one scripted turn", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lane-d-acp-")));
  temps.push(root);
  const folder = join(root, ACP_ID);
  cpSync(FIXTURE, folder, { recursive: true });
  const config = join(root, "agent.json");
  const written = fixtureWith({ "clover.json": readFileSync(join(folder, "clover.json"), "utf8"), "quirks.json": readFileSync(join(folder, "quirks.json"), "utf8") }, { bun: process.execPath, fake: FAKE_ACP_AGENT, config });
  for (const [name, body] of Object.entries(written)) writeFileSync(join(folder, name), body);
  expect(Object.values(written).join("")).not.toMatch(/__[A-Z]+__/);
  const v = await validatePluginFolder(folder, { os: "macos" });
  expect(v.issues.filter((i) => i.severity === "error")).toEqual([]);
  expect(v.plugin?.contributions.map((c) => c.point)).toEqual(["agentBackends"]);
  const file = readQuirksFile(folder, "quirks.json");
  expect(file.quirks.launch.identity.versionArgs).toEqual([FAKE_ACP_AGENT, config, "--version"]);
  const manifest = JSON.parse(written["clover.json"]!) as { contributes: { agentBackends: { command: string; args: string[] }[] } };
  expect(manifest.contributes.agentBackends[0]).toMatchObject({ command: process.execPath, args: [FAKE_ACP_AGENT, config, "acp"] });
  const cfg = JSON.parse(agentConfig(written["quirks.json"]!, { report: join(root, "r.ndjson"), selection: join(root, "s.json") })) as { quirks: unknown; script: unknown[][]; version: string };
  expect(cfg.quirks).toEqual(file.quirks);
  expect(cfg.version).toMatch(new RegExp(file.quirks.launch.identity.versionPattern));
  expect(cfg.script).toHaveLength(1);
  expect(JSON.stringify(cfg.script)).toContain(ACP_REPLY);
});
