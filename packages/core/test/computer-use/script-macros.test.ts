// ComputerV2: a model-written script importing a macro (#289's review S1). The worker strips a script's TypeScript
// with Bun's transpiler, captured before `Bun` is withheld; with macros on, `import … with { type: "macro" }` would run
// that module in the worker, outside the script's scope and past every global withheld from it. The worker's
// transpiler (`scriptTranspiler`, the one `runAutomationWorker` builds) has macros off: the run ends with the error,
// and the macro never runs.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scriptTranspiler, type ScriptBun } from "../../src/computer-use/worker/entry";
import { createAutomationRuntime } from "../../src/computer-use/worker/runtime";
import type { WorkerToHost } from "../../src/computer-use/worker/bridge";

describe("a model script's macro import is refused, never run", () => {
  const fixture = () => {
    const dir = mkdtempSync(join(tmpdir(), "clover-script-macro-"));
    const ran = join(dir, "macro-ran.txt");
    const mac = join(dir, "mac.ts");
    writeFileSync(mac, `import { writeFileSync } from "node:fs";\nexport function grab(): string { writeFileSync(${JSON.stringify(ran)}, String(process.pid)); return "PID:" + process.pid; }\n`);
    const script = `import { grab } from ${JSON.stringify(mac)} with { type: "macro" };\nconst x: string = grab();\nprint(x);\n`;
    return { ran, script };
  };

  test("the worker's transpiler throws \"Macros are disabled\", and the macro's module doesn't run", () => {
    const { ran, script } = fixture();
    const t = scriptTranspiler((globalThis as { Bun?: ScriptBun }).Bun)!;
    expect(() => t.transformSync(script)).toThrow(/Macros are disabled/);
    expect(existsSync(ran)).toBe(false);
  });

  test("through the automation runtime: the run ends with the error, nothing printed, the macro never ran", async () => {
    const { ran, script } = fixture();
    const t = scriptTranspiler((globalThis as { Bun?: ScriptBun }).Bun)!;
    const out: WorkerToHost[] = [];
    const rt = createAutomationRuntime({ post: (m) => { out.push(m); }, transpile: (code) => t.transformSync(code) });
    rt.handle({ op: "run", runId: "r1", code: script });
    const deadline = Date.now() + 5_000;
    while (!out.some((m) => m.op === "done") && Date.now() < deadline) await Bun.sleep(5);
    const done = out.find((m) => m.op === "done") as Extract<WorkerToHost, { op: "done" }> | undefined;
    expect(done?.error?.message).toMatch(/Macros are disabled/);
    expect(out.filter((m) => m.op === "print")).toEqual([]);
    expect(existsSync(ran)).toBe(false);
  });
});
