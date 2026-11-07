// `clover plugin validate`: the report and the OK's text, --json, a non-zero exit on an error, and --upgrade.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPluginValidate } from "../src/plugin-validate-cli";

const folder = (files: Record<string, string>, name = "tarot") => {
  const root = join(mkdtempSync(join(tmpdir(), "clover-b-validate-")), name);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
};
const manifest = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ manifest: 1, id: "tarot", name: "Tarot", version: "1.0.0", engines: { clover: "^1.0.0" }, ...over });

describe("clover plugin validate", () => {
  test("prints the class, what it adds, its hosts and the OK's text; exits 0", async () => {
    const root = folder({
      "clover.json": manifest({ capabilities: ["network:api.example.com"], contributes: { themes: [{ id: "night", file: "tab/theme.json" }] } }),
      "tab/theme.json": JSON.stringify({ theme: 1, name: "Night", tokens: {} }),
    });
    const run = await runPluginValidate([root]);
    expect(run.code).toBe(0);
    expect(run.output).toContain("tarot (data)");
    expect(run.output).toContain("network hosts: api.example.com");
    expect(run.output).toContain("The OK will say:");
    expect(run.output).toContain("tree hash: sha256:");
    expect(run.output.trim().endsWith("valid")).toBe(true);
  });

  test("--json is the whole report, and an error exits 1", async () => {
    const root = folder({ "clover.json": manifest({ id: "taro" }) });
    const run = await runPluginValidate([root, "--json"]);
    expect(run.code).toBe(1);
    const report = JSON.parse(run.output);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i: { severity: string }) => i.severity === "error")).toBe(true);
  });

  test("--upgrade says a newer format needs a newer Clover, and leaves current files alone", async () => {
    const current = folder({ "clover.json": manifest() });
    const before = readFileSync(join(current, "clover.json"), "utf8");
    const run = await runPluginValidate([current, "--upgrade"]);
    expect(run.output).toContain("every file is in its format's newest version");
    expect(readFileSync(join(current, "clover.json"), "utf8")).toBe(before);
    const newer = folder({ "clover.json": manifest(), "tab/theme.json": JSON.stringify({ theme: 9, name: "Future" }) });
    const r2 = await runPluginValidate([newer, "--upgrade"]);
    expect(r2.code).toBe(1);
    expect(r2.output).toContain("tab/theme.json: theme format 9 needs a newer Clover");
  });

  test("a bad option is a usage error", async () => {
    expect((await runPluginValidate(["--nope"])).code).toBe(2);
  });
});
