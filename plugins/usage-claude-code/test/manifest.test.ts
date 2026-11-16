// The claude-code source's manifest and its handler agree: the entry the Usage plugin's point takes names a handler the host
// module exports, with the methods its `provides` lists, and the program it runs is the one program the plugin names
// outside its sandbox (what its OK card says).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { source } from "../host/index";

const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "moss.json"), "utf8")) as {
  id: string; host: { process: string; outside: { programs: string[]; read?: string[] } };
  contributes: { "usage.sources": Array<{ id: string; handler: string; provides: string[] }> };
};

describe("usage-claude-code", () => {
  test("the entry's handler exports what it provides", () => {
    const [entry] = manifest.contributes["usage.sources"];
    expect(entry!.id).toBe("claude-code");
    expect(entry!.handler).toBe("source");
    for (const p of entry!.provides) expect(typeof (source as Record<string, unknown>)[p === "usage" ? "ingest" : p]).toBe("function");
  });

  test("it names one program, and runs in a process of its own", () => {
    expect(manifest.host.outside.programs).toEqual(["claude"]);
    expect(manifest.host.process).toBe("own");
  });

  test("it reads no sign-in file", () => {
    for (const folder of manifest.host.outside.read ?? []) expect(folder).not.toMatch(/auth|token|credential|\.claude\.json|oauth/i);
  });
});
