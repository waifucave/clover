// The engine's build stamp (src/engine-build.ts): none from source, the compiled-in 14 digits in a build that defines it, and
// nothing for a value that isn't a stamp.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENGINE_BUILD } from "../src/engine-build";

const out = mkdtempSync(join(tmpdir(), "moss-engine-build-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

async function builtWith(define: string, name: string): Promise<string | undefined> {
  const r = await Bun.build({ entrypoints: [join(import.meta.dir, "..", "src", "engine-build.ts")], outdir: join(out, name), define: { __MOSS_ENGINE_BUILD__: define }, ...{ macros: false } });
  expect(r.success).toBe(true);
  return (await import(join(out, name, "engine-build.js")) as { ENGINE_BUILD: string | undefined }).ENGINE_BUILD;
}

test("a checkout, a test and the dev daemon have no stamp; a build that defines one carries it as the string", async () => {
  expect(ENGINE_BUILD).toBeUndefined();
  expect(await builtWith("20261120090807", "stamped")).toBe("20261120090807");
  expect(await builtWith("false", "false")).toBeUndefined();
  expect(await builtWith("123", "short")).toBeUndefined();
});
