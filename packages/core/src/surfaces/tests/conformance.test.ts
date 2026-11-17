// The three contracts' conformance suites against the engine's real door, router and program-key table (lane RT), and
// the cases the suites leave out: the island that crashes and comes back, the table kept on disk, a hand-over.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { programAnswerKeyRotateStatement, programAnswerKeyStatement, programCardAnswerSigningInput, type AnswerKeyHolder, type PresenceReport } from "@waifucave/moss-protocol";
import { runCardRouterConformance } from "../../contracts/conformance/card-router";
import { runProgramAnswerKeysConformance } from "../../contracts/conformance/program-keys";
import { runSurfaceDoorConformance } from "../../contracts/conformance/surface-door";
import { FakeClock } from "../../contracts/fakes/clock";
import { EngineCardRouter } from "../card-router";
import { EngineSurfaceDoor } from "../door";
import { ProgramKeyTable } from "../program-keys";

runSurfaceDoorConformance((...args) => new EngineSurfaceDoor(...args));
runCardRouterConformance((...args) => new EngineCardRouter(...args));
runProgramAnswerKeysConformance(() => {
  const legacy = new Map<string, { publicKey: string; held: AnswerKeyHolder }>();
  const table = new ProgramKeyTable({ legacy: (d) => legacy.get(d) });
  return Object.assign(table, { legacyKey: (device: string, key: { publicKey: string; held: AnswerKeyHolder }) => void legacy.set(device, key) });
});

const shows = (window: string, focused: boolean, showing: PresenceReport["windows"][number]["showing"]): PresenceReport => ({ windows: [{ window, focused, visible: true, showing }] });

describe("the engine's router, beyond the suite", () => {
  test("the island crashes and comes back: elsewhere during the gap, the island on its return", () => {
    const router = new EngineCardRouter({ clock: new FakeClock(), hostLive: true });
    const door = new EngineSurfaceDoor({ legacy: false });
    const sync = () => router.hostLive(door.islandLive());
    door.watch(sync);
    door.admit({ connId: 1, role: "app", surface: "host" });
    sync();
    router.pending({ id: "card_aaaaaa", bot: "alpha" });
    expect(router.placementOf("card_aaaaaa")).toEqual({ kind: "island" });
    door.closed(1);
    expect(router.placementOf("card_aaaaaa")).toEqual({ kind: "elsewhere" });
    // Restarted after its backoff (safe mode or not: the host's mount draws cards either way).
    door.admit({ connId: 2, role: "app", surface: "host" });
    expect(router.placementOf("card_aaaaaa")).toEqual({ kind: "island" });
  });

  test("until the host is built, today's code window draws the island; MOSS's window alone draws none", () => {
    const door = new EngineSurfaceDoor();
    door.admit({ connId: 1, role: "app", surface: "moss" });
    expect(door.islandLive()).toBe(false);
    door.admit({ connId: 2, role: "app" });
    expect(door.islandLive()).toBe(true);
    expect(new EngineSurfaceDoor({ legacy: false }).islandLive()).toBe(false);
  });

  test("a window's own windows: the server reads the connection's own report", () => {
    const router = new EngineCardRouter({ clock: new FakeClock() });
    router.report({ connId: 7, program: "code" }, shows("main", true, { kind: "bot", id: "a" }));
    expect(router.windowsOf(7)).toEqual([{ program: "code", window: "main", focused: true }]);
    expect(router.windowsOf(8)).toEqual([]);
  });
});

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
async function makeKey() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const publicKey = b64(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  const sign = async (s: string) => new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, new TextEncoder().encode(s)));
  return { publicKey, sign };
}
const DEVICE = "studiodevice0001";

describe("the engine's program-key table, beyond the suite", () => {
  test("kept on disk; a hand-over replaces a key only through replace, and never another program's", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moss-program-keys-"));
    try {
      const file = join(dir, "devices", "program-keys.json");
      const now = 1_781_270_000_000;
      const table = new ProgramKeyTable({ file, now: () => now });
      const a = await makeKey();
      const b = await makeKey();
      const reg = async (program: "moss" | "host", k: typeof a) => ({ device: DEVICE, program, publicKey: k.publicKey, held: "app-keychain" as const, signature: b64(await k.sign(programAnswerKeyStatement({ device: DEVICE, program, publicKey: k.publicKey, held: "app-keychain" }))) });
      expect(await table.register(await reg("moss", a))).toEqual({ applied: true });
      expect(new ProgramKeyTable({ file }).keyOf(DEVICE, "moss")?.publicKey).toBe(a.publicKey);
      const next = await reg("moss", b);
      expect(await table.register(next)).toEqual({ applied: false, card: true });
      const handOver = { from: a.publicKey, at: now, signature: b64(await a.sign(programAnswerKeyRotateStatement({ device: DEVICE, program: "moss", from: a.publicKey, to: b.publicKey, at: now }))) };
      expect(await table.checkHandOver(next, handOver)).toBe("ok");
      // The same hand-over can't move the host's key: it names the program.
      expect(await table.checkHandOver({ ...next, program: "host" }, handOver)).toBe("no-current-key");
      expect(await table.checkHandOver(next, { ...handOver, at: now - 6 * 60_000 })).toBe("stale");
      expect(await table.checkHandOver(next, { ...handOver, signature: b64(await b.sign("x")) })).toBe("bad-signature");
      expect(table.keyOf(DEVICE, "moss")?.publicKey).toBe(a.publicKey);
      await table.replace(next, handOver);
      expect(new ProgramKeyTable({ file }).keyOf(DEVICE, "moss")?.publicKey).toBe(b.publicKey);
      // An answer signed by moss's key is moss's alone.
      const answer = programCardAnswerSigningInput({ program: "moss", id: "card_abcdef", hash: "00", option: "approve", at: 1 });
      expect(await table.verify(DEVICE, "moss", new TextEncoder().encode(answer), await b.sign(answer))).toBe(true);
      expect(await table.verify(DEVICE, "host", new TextEncoder().encode(answer), await b.sign(answer))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("MOSS Code's key is the device's single key while it has one", async () => {
    const one = await makeKey();
    const table = new ProgramKeyTable({ legacy: () => ({ publicKey: one.publicKey, held: "app-keychain" }) });
    expect(table.keyOf(DEVICE, "code")?.publicKey).toBe(one.publicKey);
    const other = await makeKey();
    const r = { device: DEVICE, program: "code" as const, publicKey: other.publicKey, held: "app-keychain" as const, signature: b64(await other.sign(programAnswerKeyStatement({ device: DEVICE, program: "code", publicKey: other.publicKey, held: "app-keychain" }))) };
    expect(await table.register(r)).toEqual({ applied: false, card: true });
    expect(table.keyOf(DEVICE, "code")?.publicKey).toBe(one.publicKey);
  });
});
