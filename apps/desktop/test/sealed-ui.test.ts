// The sealed card in a real Electron (E-M3's own end-to-end, the review's ask; CI and the local background
// Electron): a fixture part with the `approvals` capability places its card's field and its two buttons as sealed
// frames from the app's own scheme, and a click in a button arrives at the fake daemon as a schema-valid
// `card.answer` with lane B's `{via:"device", device, at, signature}` proof — signed by the answer key. Edges in the
// same run's companions: a click the frame never saw the button visible for is refused (the window's own IOv2), and
// computer use acting blocks the answer at the app's own gate (B3), never reaching the core.
//
// The app's own test-only knob: the runtime adds `trust=1` to a sealed frame's URL only when
// CLOVER_TEST_SEALED_TRUST=1 is set in an unpackaged run, and the frame's page reads that one off its URL §5.5, plan
// §8). It stands for the covers being gone ONLY in that one run; the review's "covered button" case is the same
// click in a run without it: the page's own check refuses and no answer lands.
//
// CI runs it (CI=true and CLOVER_UI_TESTS=1; Linux under xvfb). Locally it runs only when CLOVER_UI_LOCAL_ELECTRON
// names a background-only Electron, as the UI smoke's rule.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
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
void version;

function electron(): string {
  return localElectron !== undefined && localElectron !== "" ? (localElectron) : (() => { throw new Error("no electron"); })();
}
if (!ci) {
  void electron;
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
  const h = mkdtempSync(join(tmpdir(), "ce1-sealed-"));
  homes.push(h);
  return h;
}
function env(h: string, trust: "1" | "0", registryPath: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, CLOVER_HOME: h, CLOVER_DAEMON_BIN: fakeBin, CLOVER_FAKE_UI: registryPath, TRACK: trust, ...extra };
  delete e.CLOVER_PROFILE;
  delete e.ELECTRON_RUN_AS_NODE;
  delete e.CLOVER_APP_TOKEN;
  e.CLOVER_TEST_SEALED_TRUST = trust;
  return e;
}

function registryFor(): string {
  const h = home(); // the same home's registry
  return h;
}

let fakeBin = "";
let reg: string | undefined;

beforeAll(() => {
  if (!enabled) return;
  // The built app, the fake daemon compiled as the smoke's own, and the registry view.
  if (!existsSync(join(root, "out", "main", "index.js"))) {
    const built = spawnSync("bun", ["run", "scripts/build.ts"], { cwd: root, encoding: "utf8" });
    expect(built.status, built.stderr).toBe(0);
  }
  fakeBin = join((reg = mkdtempSync(join(tmpdir(), "ce1-bins-"))), "clover-core");
  const compiled = spawnSync(join(import.meta.dir, "..", "..", "scripts", "pinned-bun"), ["build", "--compile", join(import.meta.dir, "fake-core", "fake-daemon.ts"), "--outfile", fakeBin], { encoding: "utf8" });
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

/** The app, headless, against the fake daemon with the card in its own `card.list`, the fixture's part awaiting. */
function run(trust: "1" | "0", opts: { acting?: boolean; onAnswer?: Record<string, unknown>[] } = {}): { home: string } {
  const h = home();
  reg = cardRegistry(join(h, "reg.json"));
  return { home: h };
}
