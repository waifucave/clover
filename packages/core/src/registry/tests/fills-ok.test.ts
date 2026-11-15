// A point's `fills` line (§5.4): the declarer's words on each filler's OK card, attributed to the declarer and made plain;
// a filler whose card gains such a line asks for its OK again, whether it added the entry or the declarer changed its
// words; a point with no `fills` adds nothing; the core's own points carry theirs in the catalog.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION, fillsLine, fillsOkLines, validateManifest } from "@waifucave/clover-plugin-sdk";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { classifyChange, updateAddsTrigger, workshopAdds, type OkSnapshot } from "../changes";
import { openPluginRegistry } from "../open";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const ENGINES = { clover: `^${PLUGIN_API_VERSION}` };

const deck = (fills: unknown) => JSON.stringify({
  manifest: 1, id: "deck", name: "Deck Studio", version: "1.0.0", engines: ENGINES,
  host: { entry: "host/index.ts", runtime: "bun", declares: {
    "deck.voices": { shape: "list", title: "Deck voices", fields: { type: "object", properties: { id: { type: "string" } } }, ...(fills === undefined ? {} : { fills }) },
    "deck.plain": { shape: "list", fields: { type: "object", properties: { id: { type: "string" } } } },
  } },
});
const fan = (points: string[]) => JSON.stringify({
  manifest: 1, id: "fan", name: "Fan", version: "1.0.0", engines: ENGINES, contributes: Object.fromEntries(points.map((p) => [p, [{ id: "x" }]])),
});

function write(dir: string, manifest: string, host = false): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "clover.json"), manifest);
  if (host) {
    mkdirSync(join(dir, "host"), { recursive: true });
    writeFileSync(join(dir, "host", "index.ts"), "export function start() {}\n");
  }
}

describe("a point's fills line", () => {
  test("its fillers' cards say the declarer's words, by the declarer's name; a change of them asks the fillers again", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "clover-fills-")));
    temps.push(home);
    const deckDir = join(home, "plugins", "deck");
    const fanDir = join(home, "plugins", "fan");
    write(deckDir, deck({ ok: "it is given\nwhat you type‮" }), true);
    write(fanDir, fan(["deck.voices", "deck.plain"]));
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker: new FakeApprovalBroker({ clock: new FakeClock() }), secrets: new MemorySecretStore(), settleMs: 50, sandboxed: true });
    const reg = opened.registry;
    const ok = async (id: string) => { await reg.approve(id, reg.get(id)!.treeHash!); };
    try {
      await ok("deck");
      await opened.folders.refresh(fanDir);
      const LINE = 'Fills Deck Studio\'s (deck) "Deck voices": it is given what you type.';
      // Plain text, the declarer named; the point with no `fills` adds nothing.
      expect(opened.folders.okText("fan", "macos", false, true).lines.filter((l) => l.includes("Fills"))).toEqual([LINE]);
      await ok("fan");
      expect(reg.get("fan")!.state).not.toBe("found");
      // The declarer changes its words: the filler is read again and asks again, its card saying the new words.
      write(deckDir, deck({ ok: "it is given everything you say", warns: true }), true);
      await opened.folders.refresh(deckDir);
      await ok("deck");
      await opened.folders.refresh(deckDir);
      for (let i = 0; i < 100 && reg.get("fan")!.state !== "found"; i++) await Bun.sleep(20);
      expect(reg.get("fan")!.state).toBe("found");
      expect(opened.folders.okText("fan", "macos", false, true).lines).toContain('Careful: Fills Deck Studio\'s (deck) "Deck voices": it is given everything you say.');
      await ok("fan");
      // The declarer's own tree gets no line for its own point.
      expect(opened.folders.okText("deck", "macos", false, true).lines.some((l) => l.startsWith("Fills") || l.startsWith("Careful: Fills"))).toBe(false);
    } finally {
      opened.close();
    }
  });

  test("an edit that fills such a point asks again, even before anything else changed; one with no new line applies", () => {
    const snap = (okHash: string, fills?: string[]): OkSnapshot => ({ okHash, files: [], plugins: {}, cards: "", codePaths: [], ...(fills === undefined ? {} : { fills }) });
    expect(classifyChange(snap("a", []), snap("a", ["Fills X's \"Y\": z."]))).toBe("asks-again");
    expect(classifyChange(snap("a", ["Fills X's \"Y\": z."]), snap("a", ["Fills X's \"Y\": z."]))).toBe("applies");
    // An older snapshot, with no fills kept: a line now shown asks.
    expect(classifyChange(snap("a"), snap("a", ["Fills X's \"Y\": z."]))).toBe("asks-again");
    expect(classifyChange(snap("a", ["Fills X's \"Y\": z."]), snap("a", []))).toBe("applies");
  });

  test("the core's points carry theirs in the catalog; a line is bounded and plain", () => {
    const report = validateManifest({ manifest: 1, id: "talk", name: "Talk", engines: ENGINES, host: { entry: "host/index.ts" }, contributes: { voiceModes: [{ id: "talk", name: "Talk", handler: "voice" }], voices: [{ id: "talk", name: "Talk", speak: false, listen: true, handler: "voice" }] } }, { folderName: "talk" });
    expect([...fillsOkLines([report])].sort()).toEqual([
      'Fills Clover\'s "Voice listening": plugins you allow can ask it to transcribe, using your account with it.',
      'Fills Clover\'s "Voice": when you choose it in Settings, it hears what you say with push-to-talk.',
    ]);
    const long = fillsLine({ by: "A\u0007B", title: "T".repeat(500), ok: `x${"y".repeat(1000)}` });
    expect(long.length).toBeLessThan(500);
    expect(long).toStartWith('Fills A B\'s "');
    // A plugin's point names its declarer by name and id; an empty name (once plain) falls back to the id; zero-width and
    // direction marks go too.
    expect(fillsLine({ by: "Voice\u200b\u061c", id: "acme", title: "Modes", ok: "it hears you" })).toBe('Fills Voice\'s (acme) "Modes": it hears you.');
    expect(fillsLine({ by: "\u200b\u200f", id: "acme", title: "Modes", ok: "it hears you" })).toBe('Fills acme\'s "Modes": it hears you.');
  });

  test("a declarer's change of its fills words is its own update trigger", () => {
    const fp = (fillsDecl?: string) => ({
      class: "code" as const, capabilities: [], networkHosts: [], helperPermissions: [], hookEvents: [], fetchesCode: [], addons: false, adult: false,
      runs: "{}", defaults: "{}", reaches: "{}", dynamicHosts: false, label: "{}", agentBackends: "[]", ...(fillsDecl === undefined ? {} : { fillsDecl }),
    });
    const snap = (p: ReturnType<typeof fp>): OkSnapshot => ({ okHash: "a", files: [], plugins: { "": p }, cards: "", codePaths: [] });
    expect(updateAddsTrigger(snap(fp()), snap(fp("[]")))).toBeUndefined();
    expect(updateAddsTrigger(snap(fp("[]")), snap(fp('[{"point":"x.y","fills":{"ok":"a"}}]')))).toContain("what its points' fillers are told");
    expect(workshopAdds(snap(fp('[{"point":"x.y","fills":{"ok":"a"}}]')), snap(fp('[{"point":"x.y","fills":{"ok":"b"}}]')))).toContain("what its points' fillers are told");
  });
});
