// The UI test: launch the app, let it open its window, and read back what it is. CI ONLY (plan §8: no app
// window on a developer's screen) — it needs both CI=true and CLOVER_UI_TESTS=1, which only the app job in
// .github/workflows/ci.yml sets; on Linux that job runs it under xvfb.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const enabled = process.env.CI === "true" && process.env.CLOVER_UI_TESTS === "1";
const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;

interface Smoke { ok: boolean; [key: string]: unknown }

function smoke(executable: string, args: string[]): { status: number | null; facts: Smoke | undefined; output: string } {
  const outFile = join(mkdtempSync(join(tmpdir(), "clover-ui-smoke-")), "smoke.json");
  const env: NodeJS.ProcessEnv = { ...process.env, CLOVER_SMOKE_OUT: outFile, ELECTRON_ENABLE_LOGGING: "1" };
  delete env.CLOVER_PROFILE; // the dist identity
  delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(executable, [...args, "--clover-smoke"], { env, encoding: "utf8", timeout: 90_000 });
  const facts = existsSync(outFile) ? (JSON.parse(readFileSync(outFile, "utf8")) as Smoke) : undefined;
  return { status: r.status, facts, output: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? `\n${r.error.message}` : ""}` };
}

function expectOneLockedDownWindow(facts: Smoke | undefined, output: string): void {
  expect(facts, output).toBeDefined();
  expect(facts!).toMatchObject({
    ok: true, profile: "dist", appId: "com.waifucave.clover", name: "Clover", windows: 1, title: "Clover", heading: "Clover",
    options: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    rendererHasNoNode: true,
  });
  // The OS reports a process's sandbox on macOS and Windows only.
  if (process.platform !== "linux") expect(facts!.rendererSandboxed).toBe(true);
}

/** The unpacked app electron-builder made for this OS and architecture (`bun run dist`), if any. */
function packagedExecutable(): string | undefined {
  const dist = join(root, "out", "dist");
  const candidates = process.platform === "darwin"
    ? [join(dist, `mac-${process.arch}`, "Clover.app", "Contents", "MacOS", "Clover"), join(dist, "mac", "Clover.app", "Contents", "MacOS", "Clover")]
    : process.platform === "win32"
      ? [join(dist, "win-unpacked", "Clover.exe")]
      : [join(dist, process.arch === "x64" ? "linux-unpacked" : `linux-${process.arch}-unpacked`, "clover")];
  return candidates.find((c) => existsSync(c));
}

describe.if(enabled)("the app's window (UI test, CI only)", () => {
  test("electron runs the built main process: one sandboxed window with its page", () => {
    if (!existsSync(join(root, "out", "main", "index.js"))) {
      const built = spawnSync("bun", ["run", "scripts/build.ts"], { cwd: root, encoding: "utf8" });
      expect(built.status, built.stderr).toBe(0);
    }
    const electron = createRequire(join(root, "package.json"))("electron") as string;
    const r = smoke(electron, [root]);
    expectOneLockedDownWindow(r.facts, r.output);
    expect(r.facts!.packaged).toBe(false);
    expect(r.status, r.output).toBe(0);
  }, 120_000);

  test("the unsigned packaged app opens the same window", () => {
    const executable = packagedExecutable();
    expect(executable, "run `bun run dist` first (the app job does)").toBeDefined();
    const r = smoke(executable!, []);
    expectOneLockedDownWindow(r.facts, r.output);
    expect(r.facts!).toMatchObject({ packaged: true, version });
    expect(r.status, r.output).toBe(0);
  }, 120_000);
});
