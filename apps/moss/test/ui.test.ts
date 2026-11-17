// MOSS for real, in Electron, against the fake engine: it starts headless (no window shown, no Dock icon, no focus, no
// sound), connects with `surface: "moss"`, registers its own answer key, reports its presence, and draws the three
// columns from the engine's data: the bots with their living faces and their moods in words, the selected bot's
// conversation with its attachment and the card the router placed in it, the strip with another bot's card, and the
// side panel with the live picture and the routines. Its own page has the bridge and no Node; no plugin part is in it.
//
// CI runs it (CI=true and MOSS_UI_TESTS=1). Locally it runs only when MOSS_UI_LOCAL_ELECTRON names an Electron that can
// never come to the front (a copy with LSBackgroundOnly on macOS: `bun run scripts/background-electron.ts <dir>`).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startFakeEngine, type FakeEngine } from "./fake-engine/engine";
import { pagePng } from "./picture";

const root = join(import.meta.dir, "..");
const ci = process.env.CI === "true" && process.env.MOSS_UI_TESTS === "1";
const localElectron = process.env.MOSS_UI_LOCAL_ELECTRON;
const enabled = ci || (localElectron !== undefined && localElectron !== "");

function electron(): string {
  return localElectron !== undefined && localElectron !== "" ? localElectron : (createRequire(join(root, "package.json"))("electron") as string);
}

function refuseForegroundElectron(): void {
  if (ci || process.platform !== "darwin") return;
  const plist = join(dirname(dirname(localElectron!)), "Info.plist");
  const value = spawnSync("plutil", ["-extract", "LSBackgroundOnly", "raw", plist], { encoding: "utf8" });
  if (value.status !== 0 || value.stdout.trim() !== "true") throw new Error(`MOSS_UI_LOCAL_ELECTRON (${localElectron}) is not a background-only Electron`);
}

interface Facts {
  ok: boolean;
  origin: string;
  node: boolean;
  bridge: string;
  columns: string[];
  rows: number;
  faces: number;
  moods: string[];
  bubbles: number;
  attachments: number;
  cards: string[];
  cardFrames: number;
  composer: string | null;
  panel: number;
  picture: number;
  hello: { surface: string | null; mountPoints: string[] | null; release: unknown };
  visibleWindows: number;
  name: string;
  log: string[];
}

let work: string;
const tmp: string[] = [];

beforeAll(() => {
  if (!enabled) return;
  refuseForegroundElectron();
  work = mkdtempSync(join(tmpdir(), "moss-ui-"));
  tmp.push(work);
  const built = spawnSync(process.execPath, ["run", "scripts/build.ts", "--test-build"], { cwd: root, encoding: "utf8" });
  expect(built.status, built.stderr).toBe(0);
  // The build takes longer than a hook's default 5 s on a slow runner.
}, 180_000);

afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

async function smoke(e: FakeEngine, home: string, bot: string): Promise<{ facts: Facts | undefined; output: string }> {
  const out = join(home, "smoke.json");
  const env: NodeJS.ProcessEnv = { ...process.env, MOSS_HOME: home, MOSS_USER_DATA: join(home, "user-data"), MOSS_TEST_FRONT: "1", MOSS_TEST_BOT: bot, MOSS_TEST_CARDS: "2", ELECTRON_ENABLE_LOGGING: "1" };
  delete env.MOSS_PROFILE;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.MOSS_APP_TOKEN;
  const child = spawn(electron(), [root, `--moss-smoke=${out}`], { env, stdio: ["ignore", "pipe", "pipe"] });
  pid = child.pid;
  let output = "";
  child.stdout.on("data", (d: Buffer) => { output += d.toString(); });
  child.stderr.on("data", (d: Buffer) => { output += d.toString(); });
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 90_000);
    child.on("exit", () => { clearTimeout(t); resolve(); });
  });
  void e;
  return { facts: existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) as Facts : undefined, output: output.slice(-6000) };
}

let pid: number | undefined;

describe.skipIf(!enabled)("MOSS in Electron, headless, against the fake engine", () => {
  test("connects as moss and draws the three columns with the bots, a conversation, its cards and the side panel", async () => {
    const home = mkdtempSync(join(tmpdir(), "mu-"));
    tmp.push(home);
    const e = await startFakeEngine({ home, picturePng: await pagePng(), frameMs: 300, peerPid: () => pid });
    try {
      const { facts, output } = await smoke(e, home, "juniper");
      expect(facts, output).toBeDefined();
      const f = facts!;
      expect(f.ok, output).toBe(true);
      // Headless: nothing shown. The app is MOSS, the bots app, never MOSS Code.
      expect(f.visibleWindows).toBe(0);
      expect(f.name).toBe("MOSS");
      // The hello: the moss surface, which mounts nothing from plugins.
      expect(f.hello.surface).toBe("moss");
      expect(f.hello.mountPoints).toEqual([]);
      const hello = e.calls().find((c) => c.method === "protocol.hello")?.params as Record<string, unknown>;
      expect(hello).toMatchObject({ role: "app", surface: "moss" });
      // Its own page: the bridge, no Node.
      expect(f.origin).toBe("moss-app://app");
      expect(f.node).toBe(false);
      expect(f.bridge).toBe("object");
      // The three columns.
      expect(f.columns).toEqual(["list", "conversation", "panel"]);
      // Eight bots, each with a face and its mood in words (eight moods).
      expect(f.rows).toBe(8);
      expect(f.faces).toBeGreaterThanOrEqual(9); // the rows' and the header's
      expect(new Set(f.moods).size).toBe(8);
      // The conversation, its attachment, the composer.
      expect(f.bubbles).toBe(4);
      expect(f.attachments).toBe(1);
      expect(f.composer).toBe("Message Juniper");
      // Juniper's card in the conversation, Kite's in the strip, each in its own sealed frame.
      expect(f.cards.sort()).toEqual(["conversation", "strip"]);
      expect(f.cardFrames).toBe(2);
      // The side panel: the live picture and the routines.
      expect(f.picture).toBe(1);
      expect(f.panel).toBe(3);
      // MOSS registered its own key, said where it is, and reported its presence showing Juniper.
      const methods = e.calls().map((c) => c.method);
      for (const m of ["device.programKey.set", "release.record", "presence.report", "events.subscribe", "card.placement"]) expect(methods, m).toContain(m);
      expect(e.keys.keyOf("devstudio0000000001", "moss")).toBeDefined();
      // (The last report, as MOSS quits, says its window is gone.)
      const reports = e.calls().filter((c) => c.method === "presence.report").map((c) => c.params as { windows: { window: string; focused: boolean; showing: unknown }[] });
      expect(reports.some((r) => r.windows[0]?.window === "main" && r.windows[0].focused && JSON.stringify(r.windows[0].showing) === JSON.stringify({ kind: "bot", id: "juniper" }))).toBe(true);
      expect(reports.at(-1)?.windows).toEqual([]);
      // MOSS never asked to stop the engine.
      expect(methods).not.toContain("pair.quit");
    } finally {
      await e.close();
    }
  }, 120_000);
});
