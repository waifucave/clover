// The Clover Browser in a real Electron (spec §12.1, lane L): bot tabs offscreen with no window, one shown through
// the viewport without reloading, the person's selecting and copying through it, the app's own allow list and URL
// rule, a page's windows and dialogs, and the screen-reader hybrid. CI ONLY, like the UI test: it shows a window, so
// it needs both CI=true and CLOVER_UI_TESTS=1, which only the app job in .github/workflows/ci.yml sets (under xvfb
// on Linux). `test/browser/fixture-main.ts` does the driving; this file builds it, runs it and reads its answers.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROWSER_ASSETS } from "../src/main/browser/assets";

const root = join(import.meta.dir, "..");
const enabled = process.env.CI === "true" && process.env.CLOVER_UI_TESTS === "1";

interface Step { name: string; ok: boolean; detail: unknown; ms: number }
interface Result { platform: string; electron: string; steps: Step[]; fatal?: string }

async function build(dir: string): Promise<{ main: string; preload: string; html: string }> {
  const main = await Bun.build({ entrypoints: [join(import.meta.dir, "browser", "fixture-main.ts")], outdir: dir, target: "node", format: "esm", external: ["electron"], naming: "fixture-main.mjs" });
  if (!main.success) throw new Error(main.logs.map(String).join("\n"));
  const preload = await Bun.build({ entrypoints: [join(root, BROWSER_ASSETS.preload.entry)], outdir: dir, target: "node", format: "cjs", external: ["electron"], naming: "viewport-preload.cjs" });
  if (!preload.success) throw new Error(preload.logs.map(String).join("\n"));
  const html = join(dir, "browser-viewport.html");
  copyFileSync(join(root, BROWSER_ASSETS.html.from), html);
  return { main: join(dir, "fixture-main.mjs"), preload: join(dir, "viewport-preload.cjs"), html };
}

describe.if(enabled)("the Clover Browser in Electron (CI only)", () => {
  test("every step of the fixture passes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clover-browser-test-"));
    const built = await build(dir);
    const out = join(dir, "result.json");
    const electron = createRequire(join(root, "package.json"))("electron") as string;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CLOVER_BROWSER_TEST_OUT: out,
      CLOVER_BROWSER_TEST_PRELOAD: built.preload,
      CLOVER_BROWSER_TEST_HTML: built.html,
      ELECTRON_ENABLE_LOGGING: "1",
    };
    delete env.ELECTRON_RUN_AS_NODE;
    // Its own user-data folder, never the real app's; no proxy at start, as the app runs (lane E), and a net log of
    // everything the process sent.
    const netlog = join(dir, "netlog.json");
    const r = spawnSync(electron, [`--user-data-dir=${join(dir, "user-data")}`, "--no-proxy-server", `--log-net-log=${netlog}`, built.main], { env, encoding: "utf8", timeout: 300_000 });
    const output = `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? `\n${r.error.message}` : ""}`;
    expect(existsSync(out), output.slice(-4000)).toBe(true);
    const result = JSON.parse(readFileSync(out, "utf8")) as Result;
    console.log(JSON.stringify(result, null, 2));
    expect(result.fatal).toBeUndefined();
    const failed = result.steps.filter((s) => !s.ok);
    expect(failed, `${JSON.stringify(failed, null, 2)}\n--- electron's output, last 3000 characters ---\n${output.slice(-3000)}`).toEqual([]);
    expect(result.steps.length).toBeGreaterThanOrEqual(24);

    // The net log: no WPAD or PAC lookup ran, and no spellchecker dictionary was fetched (lane E's netlogs found both).
    expect(existsSync(netlog), "no net log").toBe(true);
    const text = readFileSync(netlog, "utf8");
    let log: { constants?: { logEventTypes?: Record<string, number> }; events?: { type: number; params?: unknown }[] };
    try {
      log = JSON.parse(text);
    } catch {
      log = JSON.parse(`${text.replace(/,\s*$/, "")}]}`); // a log cut short at exit: Chromium's own repair
    }
    const names = new Map(Object.entries(log.constants?.logEventTypes ?? {}).map(([name, id]) => [id, name]));
    const events = log.events ?? [];
    const pacOrWpad = events.map((e) => names.get(e.type) ?? "").filter((n) => /^(PAC_FILE_DECIDER|WPAD)/.test(n));
    const lookedUp = events.map((e) => JSON.stringify(e.params ?? {})).filter((p) => /"host":"wpad|\/\/wpad[./:]|\.bdic|gvt1\.com/i.test(p));
    console.log(`net log: ${events.length} events, ${pacOrWpad.length} PAC/WPAD, ${lookedUp.length} wpad or dictionary hosts`);
    expect(events.length).toBeGreaterThan(0);
    expect(pacOrWpad).toEqual([]);
    expect(lookedUp).toEqual([]);
  }, 360_000);
});
