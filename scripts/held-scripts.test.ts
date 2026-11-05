// C0 review S6: the held scripts refuse before they do anything (`held-scripts.ts`). Checked by reading the scripts,
// never by running them: a run that got past the refusal would build, register or publish what it must not.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HELD_SCRIPTS, heldScriptRefusal, refuseHeldScript, type HeldScript } from "./held-scripts";

const ROOT = join(import.meta.dir, "..");
const held = Object.entries(HELD_SCRIPTS) as [HeldScript, (typeof HELD_SCRIPTS)[HeldScript]][];

/** `text` with comments and import statements removed. */
function withoutImportsAndComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/import\s+(?:type\s+)?[\s\S]*?\s+from\s+"[^"]+";/g, "")
    .replace(/import\s+"[^"]+";/g, "");
}

describe("held scripts", () => {
  test("package.json runs each held package script from the file that refuses", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    for (const [name, h] of held) {
      if (name === "release") continue; // run as `bun scripts/release.ts`, not a package script
      expect(pkg.scripts[name]).toBe(`bun run ${h.file}`);
    }
  });

  test("each script refuses first: as its main guard's first statement, or before any statement at all", () => {
    for (const [name, h] of held) {
      const text = readFileSync(join(ROOT, h.file), "utf8");
      const call = `refuseHeldScript(${JSON.stringify(name)});`;
      expect(text.split(call).length - 1, `${h.file} calls it once`).toBe(1);
      const guard = "if (import.meta.main) {";
      if (text.includes(guard)) {
        expect(text.split(guard).length - 1, `${h.file} has one main guard`).toBe(1);
        expect(text.slice(text.indexOf(guard) + guard.length).trimStart().startsWith(call), h.file).toBe(true);
      } else {
        expect(withoutImportsAndComments(text.slice(0, text.indexOf(call))).trim(), `${h.file}: only imports before the refusal`).toBe("");
      }
    }
  });

  test("the refusal says until when and why, and exits 1", () => {
    for (const [name, h] of held) {
      const lines: string[] = [];
      let code: number | undefined;
      expect(() => refuseHeldScript(name, (c) => { code = c; throw new Error("exited"); }, (l) => lines.push(l))).toThrow("exited");
      expect(code).toBe(1);
      expect(lines).toEqual([heldScriptRefusal(name)]);
      expect(lines[0]).toContain(`refuses to run in the Clover repo until ${h.until}: `);
    }
    expect(HELD_SCRIPTS["dev:helper"].until).toBe("opensky");
    expect(HELD_SCRIPTS["dev:headless"].until).toBe("opensky");
    expect(HELD_SCRIPTS.release.until).toBe("C7");
    expect(HELD_SCRIPTS["tap:publish"].until).toBe("C7");
  });
});
