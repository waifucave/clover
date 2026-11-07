// The sealed card in a real Electron (E-M3's own end-to-end, the review's ask): a fixture part with the `approvals`
// capability places its card's field and its two buttons as sealed frames from the app's own scheme, and a click in a
// button arrives at the fake daemon as a schema-valid `card.answer` with lane B's `{via:"device", device, at,
// signature}` proof — signed by the answer key. Edges in the same run's companions: a covered click, an opacity-covered
// click, a computer-use-acting click and a second click are all refused; the fallback card's own answer lands; a
// markup label renders as text.
//
// The click is driven with `webContents.sendInputEvent` at the button's real coordinates, which produces trusted
// events (no `trust` knob exists in production). `CLOVER_SMOKE_SEALED_CLICK` names the card, element and options the
// smoke run clicks once everything has drawn. `CLOVER_SMOKE_SEALED_FALLBACK=1` makes the smoke run click the fallback
// window's Approve button instead.
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

function env(h: string, registryPath: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, CLOVER_HOME: h, CLOVER_DAEMON_BIN: fakeBin, CLOVER_FAKE_UI: registryPath, ...extra };
  delete e.CLOVER_PROFILE;
  delete e.ELECTRON_RUN_AS_NODE;
  delete e.CLOVER_APP_TOKEN;
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
// A card whose approve option's label carries markup: the page must render it as text, not HTML (blocking 2).
const CARD_MARKUP = {
  ...CARD,
  options: [
    { id: "allow_once", kind: "approve", label: "<b>Allow</b>" },
    { id: "deny", kind: "deny", label: "Deny" },
  ],
};

function cardRegistry(path: string, withFixture = true): string {
  const plugins = [...cloverViews(), alphaView()];
  if (withFixture) plugins.push(folderView(join(FIXTURES, "fixture-card")));
  writeFileSync(path, JSON.stringify({ plugins }));
  return path;
}

/** Start the app against the fake daemon, click via the smoke run, and return the run's output. */
async function runApp(opts: {
  click?: { cardId?: string; element?: string; cover?: boolean; opacity?: number; doubleClick?: boolean };
  acting?: boolean;
  fallback?: boolean;
  card?: Record<string, unknown>;
  withFixture?: boolean;
}): Promise<{ home: string; output: string; status: number | null }> {
  const h = home();
  const reg = cardRegistry(join(h, "reg.json"), opts.withFixture !== false);
  const registry = JSON.parse(readFileSync(reg, "utf8")) as { plugins?: unknown[] };
  // The app proves itself to the daemon over `protocol.prove`: the daemon must report this app's own pid. Spawn the
  // app first (it retries the connection), learn its pid, then start the fake daemon bound to it.
  const app = spawn(electron(), [root, "--clover-smoke", `--log-net-log=${join(h, "net.json")}`], {
    env: env(h, reg, {
      ...(opts.click !== undefined ? { CLOVER_SMOKE_SEALED_CLICK: JSON.stringify(opts.click) } : {}),
      ...(opts.fallback === true ? { CLOVER_SMOKE_SEALED_FALLBACK: "1" } : {}),
      CLOVER_SMOKE_SETTLE_MS: "3000",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  apps.push(app);
  let output = "";
  app.stdout?.on("data", (d) => (output += d));
  app.stderr?.on("data", (d) => (output += d));
  const card = opts.card ?? CARD;
  // Lane B's event envelope carries the shared-clock time the event happened: the app ignores a `core.event`
  // without it (E-M3's own local finding).
  const fake = await startFakeDaemon({ home: h, ui: registry.plugins, cards: [{ card }], prove: app.pid, events: [{ jsonrpc: "2.0", method: "core.event", params: { type: "card_pending", ts: Date.now(), card: CARD } }], ...(opts.acting !== undefined ? { acting: opts.acting } : {}) });
  fakes.push(fake);
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
  fake.write([{ jsonrpc: "2.0", method: "core.event", params: { type: "card_requested", ts: Date.now(), card } }]);
  const code = await new Promise<number | null>((resolve) => app.on("exit", (code) => resolve(code)));
  await fake.close();
  return { home: h, output, status: code };
}

function answerCallsOf(home: string): { event: string; method: string; params: { id: unknown; option: unknown; proof: unknown } }[] {
  return readCalls(home).filter((c) => c.event === "request" && c.method === "card.answer") as { event: string; method: string; params: { id: unknown; option: unknown; proof: unknown } }[];
}

describe.if(enabled)("the sealed card in Electron (E-M3 end-to-end)", () => {
  test("an uncovered trusted press lands as a schema-valid card.answer with proof", async () => {
    const r = await runApp({ click: { cardId: CARD_ID, element: "button:allow_once" } });
    const answers = answerCallsOf(r.home);
    expect(answers, r.output).toHaveLength(1);
    const answer = answers[0]!;
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

  test("a covered press does not land", async () => {
    const r = await runApp({ click: { cardId: CARD_ID, element: "button:allow_once", cover: true } });
    expect(r.output).toContain("sealed-click: frame found");
    expect(r.output).toContain("sealed-click: press sent at");
    // The press reached the sealed page itself (not just the main frame), and the page refused it.
    expect(r.output).toContain("presses=[[");
    expect(answerCallsOf(r.home), r.output).toHaveLength(0);
  }, 120_000);

  test("a semi-transparent (opacity) cover does not land", async () => {
    const r = await runApp({ click: { cardId: CARD_ID, element: "button:allow_once", opacity: 0 } });
    expect(r.output).toContain("sealed-click: frame found");
    expect(r.output).toContain("sealed-click: press sent at");
    // The press reached the sealed page itself (not just the main frame), and the page refused it.
    expect(r.output).toContain("presses=[[");
    expect(answerCallsOf(r.home), r.output).toHaveLength(0);
  }, 120_000);

  test("a press while computer use is acting does not land (B3)", async () => {
    const r = await runApp({ click: { cardId: CARD_ID, element: "button:allow_once" }, acting: true });
    expect(r.output).toContain("sealed-click: frame found");
    expect(r.output).toContain("sealed-click: press sent at");
    // The press reached the sealed page itself (not just the main frame), and the app refused it.
    expect(r.output).toContain("presses=[[");
    expect(answerCallsOf(r.home), r.output).toHaveLength(0);
  }, 120_000);

  test("a second press does not land", async () => {
    const r = await runApp({ click: { cardId: CARD_ID, element: "button:allow_once", doubleClick: true } });
    expect(answerCallsOf(r.home), r.output).toHaveLength(1);
  }, 120_000);

  test("the fallback card's answer lands", async () => {
    const r = await runApp({ fallback: true, withFixture: false, card: CARD });
    expect(r.output).toContain("sealed-click: fallback frame found");
    expect(r.output).toContain("sealed-click: fallback press sent at");
    const answers = answerCallsOf(r.home);
    expect(answers, r.output).toHaveLength(1);
    const answer = answers[0]!;
    expect(answer.params.id).toBe(CARD_ID);
    const proof = CardAnswerProof.safeParse(answer.params.proof);
    expect(proof.success, r.output).toBe(true);
  }, 120_000);

  test("a markup label renders as text", async () => {
    const r = await runApp({ click: { cardId: CARD_ID, element: "button:allow_once" }, card: CARD_MARKUP });
    expect(r.output).toContain("sealed-click: frame found");
    expect(r.output).toContain("sealed-click: press sent at");
    expect(r.output).toContain("hasBold=false");
    expect(r.output).toContain("&lt;b&gt;");
    const answers = answerCallsOf(r.home);
    expect(answers, r.output).toHaveLength(1);
    const answer = answers[0]!;
    expect(answer.params.id).toBe(CARD_ID);
    expect(answer.params.option).toBe("allow_once");
  }, 120_000);
});

void version;
