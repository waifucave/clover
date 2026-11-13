// The island clause's own fixture plugin: a valid manifest under its own id, one host command and nothing else, so its OK
// card is raised in every run and never collides with acceptance-echo, which an earlier row of the full table installs.
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateManifest } from "../../packages/plugin-sdk/src/manifest/validate";

const dir = join(import.meta.dir, "fixtures", "acceptance-island");

test("acceptance-island is a valid manifest with its own id, one command, no server and no hook", () => {
  const manifest = JSON.parse(readFileSync(join(dir, "clover.json"), "utf8")) as { id: string; host: { entry: string }; contributes: Record<string, unknown[]> };
  expect(manifest.id).toBe("acceptance-island");
  expect(Object.keys(manifest.contributes)).toEqual(["commands"]);
  expect(existsSync(join(dir, manifest.host.entry))).toBe(true);
  const report = validateManifest(manifest);
  expect([report.ok, report.id]).toEqual([true, "acceptance-island"]);
});

test("it shares no id with the echo fixture the full table installs earlier", () => {
  const echo = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "acceptance-echo", "clover.json"), "utf8")) as { id: string };
  expect(echo.id).not.toBe("acceptance-island");
});
