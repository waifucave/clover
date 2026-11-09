// The no-macros guard of a process that runs the model's code (security/no-macros.ts), measured in child processes
// (a Bun.plugin is process-wide, so never in this test runner): a macro is refused in the guarded thread, no Worker
// can start (so none runs one), the guard can't be cleared; and the controls, unguarded, where the macro runs in the
// main thread AND in a Worker. Plus the one ordering the guard can't fix: node:worker_threads imported before it.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MACRO_IMPORTER, MACRO_REFUSAL_SUFFIX, macroRefusal } from "../no-macros";

const GUARD = join(import.meta.dir, "..", "no-macros.ts");

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "clover-no-macros-"));
  const marker = join(dir, "macro-ran.txt");
  writeFileSync(join(dir, "mac.ts"), `import { appendFileSync } from "node:fs";\nexport function grab(): string { appendFileSync(${JSON.stringify(marker)}, "ran;"); return "x"; }\n`);
  writeFileSync(join(dir, "host.ts"), `import { grab } from "./mac.ts" with { type: "macro" };\nexport const v = grab();\n`);
  return { dir, marker, host: join(dir, "host.ts") };
}

/** Runs `body` in a fresh Bun process (top-level await allowed), prints its JSON result. */
function child(dir: string, body: string): Record<string, unknown> {
  const file = join(dir, `child-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(file, `${body}\n`);
  const r = spawnSync(process.execPath, [file], { cwd: dir, encoding: "utf8", timeout: 30_000 });
  const line = (r.stdout ?? "").trim().split("\n").at(-1) ?? "";
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    throw new Error(`the child printed no result: ${r.stdout}\n${r.stderr}`);
  }
}

const attempt = (name: string, code: string) => `try { ${code}; out[${JSON.stringify(name)}] = "ran"; } catch (e) { out[${JSON.stringify(name)}] = String((e as Error).message ?? e); }`;
const workerRun = (ctor: string, host: string) =>
  `const C: any = ${ctor}; await new Promise<void>((res) => { const w = new C(${JSON.stringify(host)}); const done = () => { try { w.terminate(); } catch {} res(); }; if ("on" in w) w.on("error", () => done()); else w.onerror = () => done(); setTimeout(done, 1500); })`;

describe("the refusal's text, for lane B's generated guard", () => {
  test("a macro frame's importer, and the message with its phrase", () => {
    expect(MACRO_IMPORTER.test("macro//abc123.js")).toBe(true);
    expect(MACRO_IMPORTER.test("macro://abc123.js")).toBe(true);
    expect(MACRO_IMPORTER.test("/home/x/macro//a.js")).toBe(false);
    expect(macroRefusal("./mac.ts")).toBe(`refused ./mac.ts${MACRO_REFUSAL_SUFFIX}`);
    expect(MACRO_REFUSAL_SUFFIX).toContain("a Bun macro");
  });
});

describe("guardScriptProcess (the automation, workflow and runtime workflow workers)", () => {
  test("guarded: the macro is refused in this thread, no Worker starts by either constructor, the guard stays; the macro never ran", () => {
    const { dir, marker, host } = fixture();
    try {
      const out = child(dir, [
        `import { guardScriptProcess } from ${JSON.stringify(GUARD)};`,
        `const out: Record<string, unknown> = {};`,
        `await guardScriptProcess("the probe");`,
        attempt("import", `await import(${JSON.stringify(host)})`),
        attempt("webWorker", workerRun("Worker", host)),
        attempt("threadsWorker", workerRun(`(await import("node:worker_threads")).Worker`, host)),
        attempt("threadsDefault", workerRun(`(await import("node:worker_threads")).default.Worker`, host)),
        attempt("clearAll", `(await import("bun")).plugin.clearAll()`),
        `console.log(JSON.stringify(out));`,
      ].join("\n"));
      // Bun reports the refusal as a MacroLoadError (the guard's message goes to stderr); the control below shows the same
      // import running unguarded.
      expect(String(out.import)).toMatch(/MacroLoadError|a Bun macro/);
      for (const k of ["webWorker", "threadsWorker", "threadsDefault"]) expect(String(out[k])).toContain("the probe starts no Worker");
      expect(String(out.clearAll)).toContain("the no-macros guard stays");
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("control, unguarded: the macro runs in the main thread and in a Worker", () => {
    const { dir, marker, host } = fixture();
    try {
      child(dir, [`const out: Record<string, unknown> = {};`, attempt("import", `await import(${JSON.stringify(host)})`), `console.log(JSON.stringify(out));`].join("\n"));
      expect(existsSync(marker)).toBe(true);
      rmSync(marker);
      child(dir, [`const out: Record<string, unknown> = {};`, attempt("webWorker", workerRun("Worker", host)), `console.log(JSON.stringify(out));`].join("\n"));
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("control, the main-thread guard alone doesn't reach a Worker: the macro runs there (why Workers are refused)", () => {
    const { dir, marker, host } = fixture();
    try {
      child(dir, [
        `import { installNoMacrosGuard } from ${JSON.stringify(GUARD)};`,
        `const out: Record<string, unknown> = {};`,
        `installNoMacrosGuard();`,
        attempt("webWorker", workerRun("Worker", host)),
        `console.log(JSON.stringify(out));`,
      ].join("\n"));
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("node:worker_threads imported before the guard keeps a live Worker: the guard fails closed, nothing runs", () => {
    const { dir } = fixture();
    try {
      const out = child(dir, [
        `import * as early from "node:worker_threads";`,
        `import { guardScriptProcess } from ${JSON.stringify(GUARD)};`,
        `const out: Record<string, unknown> = { early: typeof early.Worker };`,
        attempt("guard", `await guardScriptProcess("the probe")`),
        `console.log(JSON.stringify(out));`,
      ].join("\n"));
      expect(String(out.guard)).toContain("a Worker constructor is still live");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
