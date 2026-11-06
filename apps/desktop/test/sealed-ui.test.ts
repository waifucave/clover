// The sealed card in a real Electron (E-M3's own end-to-end, the review's ask): a fixture part with the `approvals`
// capability places its card's field and its two buttons as sealed frames from the app's own scheme, and a click in a
// button arrives at the fake daemon as a schema-valid `card.answer` with lane B's `{via:"device", device, at,
// signature}` proof — signed by the answer key. Edges in the same run's companions: a click the frame never saw the
// button visible for is refused (the window's own IOv2), and computer use acting blocks the answer at the app's own
// gate (B3), never reaching the core.
//
// The app's own test-only knob: `CLOVER_TEST_SEALED_TRUST=1` adds `trust=1` to a sealed frame's URL, and the frame's
// page then lets a headless run's synthetic `pointerdown` count as the user's own (skips `isTrusted` and the 400 ms
// settle). `CLOVER_SMOKE_SEALED_CLICK` names the card and element the smoke run clicks once everything has drawn.
// The same click without `trust=1` is the covered-button case: the page's own `isTrusted` check refuses and no answer
// lands.
//
// CI runs it (CI=true and CLOVER_UI_TESTS=1; Linux under xvfb). Locally it runs only when CLOVER_UI_LOCAL_ELECTRON
// names a background-only Electron, as the UI smoke's rule.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CardAnswerProof } from "@waifucave/clover-protocol";
import { readCalls, startFakeDaemon, type FakeDaemon } from "./fake-core/fake-daemon";
import { cloverViews, alphaView, folderView, FIXTURES } from "./fake-core/registry";

const root = join(import.meta.dir, "..");
const ci = process.env.CI === "true" && process.env.CLOVER_UI_TESTS === "1";
const localElectron = process.env.CLOVER_UI_LOCAL_ELECTRON;
const enabled = ci || (localElectron !== undefined && localElectron !== "");
const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
const exe = process.platform === "win32" ? ".exe" : "";
const require = createRequire(join(root, "package.json"));

function electron(): string {
  return localElectron !== undefined && localElectron !== "" ? localElectron : (require("electron") as string);
}

/** A local run's Electron must never come to the front: on macOS a copy whose Info.plist sets `LSBackgroundOnly`
 *  (`bun run scripts/background-electron.ts` makes one). The test refuses any other. */
function refuseForegroundElectron(): void {
  if (ci || process.platform !== "darwin") return;
  const plist = join(dirname(dirname(localElectron!)), "Info.plist");
  const value = spawnSync("plutil", ["-extract", "LSBackgroundOnly", "raw", plist], { encoding: "utf8" });
  if (value.status !== 0 || value.stdout.trim() !== "true") {
    throw new Error(`CLOVER_UI_LOCAL_ELECTRON (${localElectron}) is not a background-only Electron; make one with \`bun run scripts/background-electron.ts <dir>\``);
  }
}

const homes: string[] = [];
const fakes: FakeDaemon[] = [];
const apps: ChildProcess[] = [];
afterAll(async () => {
  for (const a of apps.splice(0)) { try { a.kill("SIGKILL"); } catch { /* gone */ } }
  for (const f of fakes.splice(0)) await f.close().catch(() => undefined);
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function home(): string {
  // Short, for the Unix socket's path limit.
  const h = mkdtempSync(join(tmpdir(), "ce1-sealed-"));
  homes.push(h);
  return h;
}

function env(h: string, trust: "1" | "0", registryPath: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, CLOVER_HOME: h, CLOVER_DAEMON_BIN: fakeBin, CLOVER_FAKE_UI: registryPath, ...extra };
  delete e.CLOVER_PROFILE;
  delete e.ELECTRON_RUN_AS_NODE;
  delete e.CLOVER_APP_TOKEN;
  e.CLOVER_TEST_SEALED_TRUST = trust;
  return e;
}

let fakeBin = "";
beforeAll(() => {
  if (!enabled) return;
  if (!ci) refuseForegroundElectron();
  if (!existsSync(join(root, "out", "main", "index.js"))) {
    const built = spawnSync("bun", ["run", "scripts/build.ts"], { cwd: root, encoding: "utf8" });
    expect(built.status, built.stderr).toBe(0);
  }
  fakeBin = join(mkdtempSync(join(tmpdir(), "ce1-bins-")), `clover-core${exe}`);
  const compiled = spawnSync("bun", ["build", "--compile", join(import.meta.dir, "fake-core", "fake-daemon.ts"), "--outfile", fakeBin], { encoding: "utf8" });
  expect(compiled.status, compiled.stderr).toBe(0);
});

const CARD_ID = "card_0a1b2c3d";
const CARD = {
  id: CARD_ID,
  kind: "tool",
  computer: null,
  origin: "user",
  issuedAt: 1700000000000,
  expiresAt: null,
  hash: "b".repeat(64),
  fields: { title: { type: "text", text: "Run a command?" } },
  options: [
    { id: "allow_once", kind: "approve", label: "Allow" },
    { id: "deny", kind: "deny", label: "Deny" },
  ],
};

function cardRegistry(path: string): string {
  writeFileSync(path, JSON.stringify({ plugins: [...cloverViews(), alphaView(), folderView(join(FIXTURES, "fixture-card"))] }));
  return path;
}

/** Start the app against the fake daemon, click the sealed button via the smoke run, and return the run's output. */
async function runApp(trust: "1" | "0", opts: { acting?: boolean } = {}): Promise<{ home: string; output: string; status: number | null }> {
  const h = home();
  const reg = cardRegistry(join(h, "reg.json"));
  const fake = await startFakeDaemon({ home: h, cards: [{ card: CARD }], ...(opts.acting !== undefined ? { acting: opts.acting } : {}) });
  fakes.push(fake);
  const netlog = join(h, "net.json");
  const app = spawn(electron(), [root, "--clover-smoke", `--log-net-log=${netlog}`], {
    env: env(h, trust, reg, {
      CLOVER_SMOKE_SEALED_CLICK: JSON.stringify({ cardId: CARD_ID, element: "button:allow_once" }),
      CLOVER_SMOKE_SETTLE_MS: "3000",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  apps.push(app);
  let output = "";
  app.stdout?.on("data", (d) => (output += d));
  app.stderr?.on("data", (d) => (output += d));
  const until = async (check: () => boolean, ms: number, what: string) => {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error(`timed out: ${what}\n${output.slice(-4000)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };
  const events = () => readCalls(h).map((c) => (c.event === "request" ? `request ${String(c.method)}` : c.event));
  // Wait for the app to connect to the daemon, then tell it about the card (the plugin layer hears card_requested).
  await until(() => events().includes("request plugin.ui"), 40_000, "the app connected to the daemon");
  fake.write([{ jsonrpc: "2.0", method: "core.event", params: { type: "card_requested", card: CARD } }]);
  const code = await new Promise<number | null>((resolve) => app.on("exit", (code) => resolve(code)));
  await fake.close();
  return { home: h, output, status: code };
}

describe.if(enabled)("the sealed card in Electron (E-M3 end-to-end)", () => {
  test("a placed sealed button's click arrives at the fake daemon as a schema-valid card.answer", async () => {
    const r = await runApp("1");
    const answerCalls = readCalls(r.home).filter((c) => c.event === "request" && c.method === "card.answer");
    expect(answerCalls, r.output).toHaveLength(1);
    const answer = answerCalls[0]! as { event: string; method: string; params: { id: unknown; option: unknown; proof: unknown } };
    expect(answer.params.id).toBe(CARD_ID);
    expect(answer.params.option).toBe("allow_once");
    const proof = CardAnswerProof.safeParse(answer.params.proof);
    expect(proof.success, r.output).toBe(true);
    if (proof.success) {
      expect(proof.data).toMatchObject({ via: "device" });
      expect(typeof (proof.data as { device?: string }).device).toBe("string");
      expect(typeof proof.data.at).toBe("number");
      expect(typeof (proof.data as { signature?: string }).signature).toBe("string");
    }
  }, 120_000);

  test("without the trust knob the same click is refused (covered button: no card.answer lands)", async () => {
    const r = await runApp("0");
    const answerCalls = readCalls(r.home).filter((c) => c.event === "request" && c.method === "card.answer");
    expect(answerCalls, r.output).toHaveLength(0);
  }, 120_000);

  test("computer use acting blocks the answer at the app's own gate (B3)", async () => {
    const r = await runApp("1", { acting: true });
    const answerCalls = readCalls(r.home).filter((c) => c.event === "request" && c.method === "card.answer");
    expect(answerCalls, r.output).toHaveLength(0);
  }, 120_000);
});

void version;
