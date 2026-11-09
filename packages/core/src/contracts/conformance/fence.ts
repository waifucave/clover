// The Fence conformance suite (review S15). `runFenceConformance(make)` registers every case against the
// implementation `make` builds; `tests/fence.test.ts` runs it against FakeFence, and the lane that writes the real
// one runs it there through a harness with the same drivers. What it pins:
// what is fenced on each OS, how operations are judged, agents' roots, and
// the policy a sandbox enforces.
import { describe, expect, test } from "bun:test";
import { type FakeFence } from "../fakes/fence";
import { CLOUD_METADATA_ADDRESSES, FENCED_KINDS, policyAllows, foldName, foldPath, judge, windowsAlias, type FencedKind } from "../fence";

/** What the suite drives: the contract and the fake's own drivers (what a test does to the world around it),
 *  as public members, so a real implementation's harness can provide them. */
export type FenceHarness = Pick<FakeFence, keyof FakeFence>;
/** Builds the implementation under test from the options the fake takes. */
export type FenceFactory = (...args: ConstructorParameters<typeof FakeFence>) => FenceHarness;

/** Cases an implementation can run as todo: `real-paths`, an agent root judged by its real path through a real
 *  symlink (the fake compares strings; lane C's real fence must pass it). */
export type FencePendingCase = "real-paths";

/** A real folder and real symlinks, for the `real-paths` case (the suites import no file system of their own). */
export interface FenceDisk {
  /** A new empty folder, by its real path. */
  folder(): string;
  /** A new symlink to `target`, by its path. */
  link(target: string): string;
}

export function runFenceConformance(make: FenceFactory, opts: { pending?: readonly FencePendingCase[]; disk?: FenceDisk } = {}): void {
  const pendingOr = (key: FencePendingCase) => (opts.pending?.includes(key) || !opts.disk ? test.todo : test);
  const HOME = "/Users/me";
  const CLOVER = `${HOME}/.clover`;
  const AGENT = "/opt/homebrew/lib/node_modules/@zed-industries/codex-acp";
  const fence = (os: "macos" | "linux" | "windows" = "macos", devFolders: string[] = []) =>
    make({ os, home: HOME, cloverHome: CLOVER, temp: "/tmp", devFolders, agentInstalls: [AGENT], bots: ["alpha"] });

  describe("Fence", () => {
    // Windows' path forms (#234's check 6): `pluginLoadDenies` gives a UNC share's denies at the share and a `\\?\` path's
    // both as written and in its plain form, in backslashes, and `writesPluginLoadDeny` compares them folded. Which of
    // those forms the Windows sandbox compares a real path in is the Windows sandbox lane's to pin, in its own
    // conformance case, so that a deny written here is one its sandbox actually matches.
    test("no runner writes a node_modules above a folder plugin code loads from, on every OS (#234's check 4, H1)", () => {
      const session = (bot: string | undefined, sessionKind: "bot" | "agent" | "coding") =>
        ({ kind: "session", sessionId: `s_${sessionKind}`, sessionKind, ...(bot ? { bot } : {}) }) as const;
      for (const os of ["macos", "linux", "windows"] as const) {
        const f = fence(os, [`${HOME}/dev/luna`]);
        const above = [`${HOME}/node_modules`, `${CLOVER}/node_modules`, `${CLOVER}/plugins/node_modules`, "/Users/node_modules", "/node_modules", `${HOME}/dev/node_modules`];
        for (const caller of [session("luna", "bot"), session(undefined, "coding"), session("luna", "agent"), { kind: "plugin", pluginId: "tarot" } as const]) {
          const p = f.forCaller(caller).policy();
          expect([os, p.denyWrite]).toEqual([os, expect.arrayContaining(above)]);
          expect(policyAllows(p, "write", `${HOME}/node_modules/dep/package.json`, os)).toBe(false);
          expect(policyAllows(p, "write", `${HOME}/notes/node_modules.txt`, os)).toBe(true);
          for (const op of [{ op: "write", path: `${HOME}/node_modules/dep/package.json` }, { op: "write", path: `${HOME}/NODE_MODULES/dep/index` },
            { op: "move", path: `${HOME}/stuff`, to: `${HOME}/node_modules` }, { op: "delete", path: `${HOME}/dev/node_modules` }] as const) {
            expect([os, op, f.forCaller(caller).check(op).allowed]).toEqual([os, op, false]);
          }
          expect(f.forCaller(caller).check({ op: "write", path: `${HOME}/notes/a.txt` }).allowed).toBe(true);
        }
        // The user's own reach isn't judged.
        expect(f.forCaller({ kind: "user", client: "app" }).check({ op: "write", path: `${HOME}/node_modules/x` }).allowed).toBe(true);
      }
    });

    test("macOS fences every item but the secrets file and key files, which the Keychain holds", () => {
      const kinds = new Set(fence("macos", [`${HOME}/dev/luna`]).fencedSet().map((i) => i.kind));
      const expected = FENCED_KINDS.filter((k) => k !== "secrets-file" && k !== "key-file");
      for (const k of expected) expect(kinds.has(k)).toBe(true);
      // Nothing else but lane M's self-update files, pending until B names the kind (the fake names it; the real
      // fence only with `enforceAhead`, off for this suite).
      for (const k of kinds) expect([...expected, "self-update"].includes(k)).toBe(true);
    });

    test("Windows and Linux also hide the secrets file and key files from reads", () => {
      for (const os of ["linux", "windows"] as const) {
        const f = fence(os);
        const secrets = f.fencedSet().find((i) => i.kind === "secrets-file")!;
        expect(secrets.deny).toBe("read-write");
        expect(f.check({ op: "read", path: secrets.path })).toEqual({ allowed: false, reason: "secrets-file", path: secrets.path });
      }
    });

    test("a write inside any fenced item is refused, with its kind", () => {
      const f = fence("linux", [`${HOME}/dev/luna`]);
      for (const item of f.fencedSet()) {
        if (item.deny === "caller") continue; // the caller's: below
        const verdict = f.check({ op: "write", path: `${item.path}/x` });
        expect(verdict).toEqual({ allowed: false, reason: item.kind as FencedKind, path: item.path });
      }
    });

    test("an agent's root is never inside the Clover home, nor inside or holding a fenced item (#197's check 3)", () => {
      for (const os of ["macos", "windows", "linux"] as const) {
        const f = fence(os);
        for (const root of [`${CLOVER}/plugins/tarot`, `${CLOVER}/plugins`, `${CLOVER}/settings`, `${CLOVER}/plugin-data`]) {
          expect([os, root, f.checkAgentRoot(root).allowed]).toEqual([os, root, false]);
        }
        expect(f.checkAgentRoot(`${HOME}/projects/site`)).toEqual({ allowed: true });
      }
      const f = fence("macos");
      expect(f.checkAgentRoot(AGENT)).toMatchObject({ allowed: false, reason: "agent-installs" });
      expect(f.checkAgentRoot(`${HOME}/Library/LaunchAgents`)).toMatchObject({ allowed: false, reason: "login-start" });
      expect(f.checkAgentRoot(`${HOME}/Library`).allowed).toBe(false); // it holds fenced items
    });

    test("bot-memory: every bot's sessions read and write every bot's memory (the owner's ruling of November 9, amended); nothing else does, listed bot or not (#197's check 4)", () => {
      const f = make({ os: "macos", home: HOME, cloverHome: CLOVER, temp: "/tmp", bots: ["luna", "alpha", "pack/tarot"] });
      const mem = (bot: string) => `${CLOVER}/bots/${bot}/memory`;
      expect(f.fencedSet().filter((i) => i.kind === "bot-memory")).toEqual([
        { kind: "bot-memory", path: mem("luna"), deny: "caller", bot: "luna" },
        { kind: "bot-memory", path: mem("alpha"), deny: "caller", bot: "alpha" },
        { kind: "bot-memory", path: mem("pack--tarot"), deny: "caller", bot: "pack/tarot" },
      ]);
      const reach = (caller: Parameters<typeof f.forCaller>[0] | undefined, path: string) => {
        const c = caller === undefined ? { check: (op: Parameters<typeof f.check>[0]) => f.check(op) } : f.forCaller(caller);
        return [c.check({ op: "read", path }).allowed, c.check({ op: "write", path }).allowed];
      };
      const session = (bot: string | undefined, sessionKind: "bot" | "side-thread" | "agent" | "coding") =>
        ({ kind: "session", sessionId: `s_${sessionKind}`, sessionKind, ...(bot ? { bot } : {}) }) as const;
      const main = session("luna", "bot");
      expect(reach(main, `${mem("luna")}/MEMORY.md`)).toEqual([true, true]);
      expect(reach(session("luna", "side-thread"), `${mem("luna")}/MEMORY.md`)).toEqual([true, true]);
      expect(reach(main, `${mem("alpha")}/MEMORY.md`)).toEqual([true, true]);
      expect(reach(session("luna", "agent"), `${mem("luna")}/MEMORY.md`)).toEqual([false, false]); // its own agents not
      expect(reach(session(undefined, "coding"), `${mem("luna")}/MEMORY.md`)).toEqual([false, false]);
      expect(reach({ kind: "plugin", pluginId: "tarot" }, `${mem("luna")}/MEMORY.md`)).toEqual([false, false]);
      expect(reach({ kind: "peer", device: "desk0000000000000001", sessionId: "s_r", bot: "luna" }, `${mem("luna")}/MEMORY.md`)).toEqual([false, false]);
      expect(reach(undefined, `${mem("luna")}/MEMORY.md`)).toEqual([false, false]);
      expect(reach(session("pack/tarot", "bot"), `${mem("pack--tarot")}/MEMORY.md`)).toEqual([true, true]);
      // A bot the fence doesn't list (not made yet, synced before the list catches up, or removed): the same rule, so
      // a coding session can't seed a future bot's memory.
      expect(reach(session(undefined, "coding"), `${mem("newbot")}/MEMORY.md`)).toEqual([false, false]);
      expect(reach(undefined, `${mem("newbot")}/n.md`)).toEqual([false, false]);
      expect(reach(session("newbot", "bot"), `${mem("newbot")}/n.md`)).toEqual([true, true]);
      // Spellings: case, folding and `..` reach the same folder.
      expect(reach(main, `${CLOVER}/bots/ALPHA/Memory/n.md`)).toEqual([true, true]);
      expect(reach(main, `${CLOVER}/bots/luna/../alpha/memory/n.md`)).toEqual([true, true]);
      expect(reach(session(undefined, "coding"), `${CLOVER}/bots/luna/../alpha/memory/n.md`)).toEqual([false, false]);
      expect(reach(main, `${CLOVER}/bots/LUNA/MEMORY/n.md`)).toEqual([true, true]);
      // bots/ and bots/<x> hold memory: never deleted, moved or written over; the memory folder itself neither.
      for (const op of [{ op: "delete", path: `${CLOVER}/bots/luna` }, { op: "move", path: `${CLOVER}/bots/luna`, to: `${CLOVER}/bots/x` }, { op: "delete", path: `${CLOVER}/bots` }, { op: "delete", path: mem("luna") }, { op: "write", path: `${CLOVER}/bots/newbot` }] as const) {
        expect([op, f.forCaller(main).check(op).allowed]).toEqual([op, false]);
      }
      expect(f.forCaller(main).check({ op: "move", path: `${mem("luna")}/a.md`, to: `${mem("alpha")}/a.md` }).allowed).toBe(true);
      expect(f.forCaller(session(undefined, "coding")).check({ op: "move", path: `${mem("luna")}/a.md`, to: `${mem("alpha")}/a.md` }).allowed).toBe(false);
      // The rest of a bot's folder isn't memory: the bots read it (the owner's ruling of November 9), no runner writes it.
      expect(f.forCaller(session("luna", "agent")).check({ op: "write", path: `${CLOVER}/bots/luna/agents/a_1.jsonl` }).allowed).toBe(false);
      expect(f.forCaller(main).check({ op: "read", path: `${CLOVER}/bots/luna/agents/a_1.jsonl` }).allowed).toBe(true);
      expect(f.forCaller(main).check({ op: "write", path: `${CLOVER}/bots/luna/agents/a_1.jsonl` }).allowed).toBe(false);
      // Another bot's, a coding session's or a plugin's write into luna's agent log would put words in luna's context
      // (#213's review): each is refused, with every spelling, link-free path and folding; the user and the core write it.
      const log = `${CLOVER}/bots/luna/agents/a_1.jsonl`;
      for (const [name, caller] of [
        ["another bot", session("alpha", "bot")], ["another bot's side thread", session("alpha", "side-thread")],
        ["a coding session", session(undefined, "coding")], ["an agent of another bot", session("alpha", "agent")],
        ["a plugin", { kind: "plugin", pluginId: "luna" }], ["a peer", { kind: "peer", device: "desk0000000000000001", sessionId: "s_1", bot: "luna" }],
      ] as const) {
        for (const op of [{ op: "write", path: log }, { op: "write", path: `${CLOVER}/BOTS/Luna/agents/a_2.jsonl` }, { op: "write", path: `${CLOVER}/bots/alpha/../luna/agents/a_3.jsonl` },
          { op: "delete", path: log }, { op: "move", path: `${CLOVER}/scratch/alpha/x`, to: log }] as const) {
          expect([name, op, f.forCaller(caller).check(op).allowed]).toEqual([name, op, false]);
        }
      }
      expect(f.forCaller({ kind: "user", client: "app" }).check({ op: "write", path: log }).allowed).toBe(true);
      expect(f.forCaller({ kind: "core" }).check({ op: "write", path: log }).allowed).toBe(true);
      expect(reach(main, `${CLOVER}/bots/luna/agents/a_1.jsonl`)).toEqual([true, false]);
      // Runners: every runner is denied the whole Clover home, every bot's memory with it; the owning bot's main
      // conversation and side threads get their own back (`ownMemory`), and no other bot's.
      for (const c of [main, session("luna", "side-thread"), session(undefined, "coding"), session("luna", "agent"), { kind: "plugin", pluginId: "tarot" } as const]) {
        const p = f.forCaller(c).policy();
        expect(p.denyRead).toContain(CLOVER);
        expect(p.denyWrite).toContain(CLOVER);
        // C's base (J's ruling): every bot's memory by its pattern, known or not, and the agents folder for every runner.
        expect(p.denyRead).toContain(`${CLOVER}/bots/*/memory`);
        expect(p.denyWrite).toContain(`${CLOVER}/bots/*/memory`);
        expect(p.denyWrite.some((d) => `${CLOVER}/bots/luna/agents/a_1.jsonl`.startsWith(d))).toBe(true);
        expect(policyAllows(p, "read", `${mem("alpha")}/MEMORY.md`)).toBe(false);
      }
      expect(f.forCaller(main).policy().ownMemory).toBe(mem("luna"));
      expect(f.forCaller(session("luna", "side-thread")).policy().ownMemory).toBe(mem("luna"));
      expect(f.forCaller(session("pack/tarot", "bot")).policy().ownMemory).toBe(mem("pack--tarot"));
      // A coding session's runner, and the bot's own agents', reach neither its memory nor any other.
      expect(f.forCaller(session(undefined, "coding")).policy().ownMemory).toBeUndefined();
      expect(f.forCaller(session("luna", "agent")).policy().ownMemory).toBeUndefined();
      expect(f.forCaller({ kind: "plugin", pluginId: "tarot" }).policy().ownMemory).toBeUndefined();
      expect(f.touches([`${mem("newbot")}/a`])).toMatchObject({ kind: "bot-memory", path: mem("newbot") });
      expect(f.forCaller(main).context).toEqual({ sessionId: "s_bot", memoryOf: "luna" });
    });

    pendingOr("real-paths")("an agent root is judged by its real path: a symlink to the home, or into the Clover home, is refused (#197's check 4)", () => {
      const disk = opts.disk!;
      const home = disk.folder();
      const f = make({ os: "macos", home, cloverHome: `${home}/.clover`, temp: "/tmp" });
      expect(f.checkAgentRoot(disk.link(home)).allowed).toBe(false);
      const intoClover = disk.link(`${home}/.clover`);
      // A root that doesn't exist yet is judged by its nearest existing ancestor's real path.
      expect(f.checkAgentRoot(`${intoClover}/plugins/new-plugin`).allowed).toBe(false);
      expect(f.checkAgentRoot(`${disk.link(disk.folder())}/project`).allowed).toBe(true);
    });

    test("a runner's sandbox, by the reference order (policyAllows): its own memory's insides, never the folder; no other bot's (#197's check 5)", () => {
      const f = fence("macos");
      const mem = (bot: string) => `${CLOVER}/bots/${bot}/memory`;
      const session = (bot: string | undefined, sessionKind: "bot" | "side-thread" | "agent" | "coding") =>
        ({ kind: "session", sessionId: "s_1", sessionKind, ...(bot ? { bot } : {}) }) as const;
      const owner = f.forCaller(session("luna", "bot")).policy();
      expect(owner.ownMemory).toBe(mem("luna"));
      expect(policyAllows(owner, "write", `${mem("luna")}/MEMORY.md`)).toBe(true);
      expect(policyAllows(owner, "read", `${mem("luna")}/notes/a.md`)).toBe(true);
      expect(policyAllows(owner, "read", `${mem("alpha")}/MEMORY.md`)).toBe(false);
      expect(policyAllows(owner, "write", `${mem("newbot")}/MEMORY.md`)).toBe(false);
      // A `/` boundary, never a bare prefix.
      expect(policyAllows(owner, "write", `${CLOVER}/bots/luna/memory-x/a.md`)).toBe(false); // not memory: the home denies it
      expect(policyAllows(owner, "read", `${CLOVER}/bots/luna/memory-x/a.md`)).toBe(true); // its own bot's folder, read
      expect(policyAllows(owner, "write", `${CLOVER}/bots/luna-x/memory/a.md`)).toBe(false);
      // Unlinking or renaming the folder itself, or a folder that holds it, stays denied.
      for (const path of [mem("luna"), `${CLOVER}/bots/luna`, `${CLOVER}/bots`]) {
        expect([path, policyAllows(owner, "unlink", path), policyAllows(owner, "rename", path)]).toEqual([path, false, false]);
      }
      expect(policyAllows(owner, "unlink", `${mem("luna")}/old.md`)).toBe(true);
      // A coding session's runner, and the bot's own agent's, reach neither.
      for (const c of [session(undefined, "coding"), session("luna", "agent")]) {
        const p = f.forCaller(c).policy();
        expect(p.ownMemory).toBeUndefined();
        expect([policyAllows(p, "read", `${mem("luna")}/MEMORY.md`), policyAllows(p, "write", `${mem("alpha")}/MEMORY.md`)]).toEqual([false, false]);
      }
    });

    test("the Clover home is default-deny for every tool and runner but a bot's sessions, which read it; the per-caller ways in (the controller's and the owner's rulings)", () => {
      const f = fence("macos");
      const session = (bot: string | undefined, sessionKind: "bot" | "side-thread" | "agent" | "coding", sessionId = "s_1") =>
        ({ kind: "session", sessionId, sessionKind, ...(bot ? { bot } : {}) }) as const;
      const reach = (caller: Parameters<typeof f.forCaller>[0] | undefined, path: string) => {
        const check = caller === undefined ? (op: Parameters<typeof f.check>[0]) => f.check(op) : f.forCaller(caller).check;
        return [check({ op: "read", path }).allowed, check({ op: "write", path }).allowed];
      };
      const main = session("luna", "bot");
      const callers = { main, side: session("luna", "side-thread"), agent: session("luna", "agent"), coding: session(undefined, "coding"), other: session("alpha", "bot", "s_9"),
        plugin: { kind: "plugin", pluginId: "tarot" } as const, peer: { kind: "peer", device: "desk0000000000000001", sessionId: "s_1", bot: "luna" } as const };
      // Everything a conversation lives in, and every other top folder: no caller writes it; only a bot's sessions read it
      // (the owner's ruling of November 9), never what `BOT_READ_DENIED` names (plugin data, the run folders…).
      const bots = new Set<unknown>([main, callers.side, callers.other]);
      for (const top of ["projects", "sdk/projects", "sessions", "transcripts", "diffs", "cache/runs", "logs", "usage", "routines", "routines/x", "plugin-data", "plugin-data/x", "whatever-comes-next"]) {
        for (const [name, c] of [...Object.entries(callers), ["none", undefined] as const]) {
          expect([top, name, reach(c, `${CLOVER}/${top}/x.json`)]).toEqual([top, name, [bots.has(c) && !top.startsWith("plugin-data") && top !== "cache/runs", false]]);
        }
      }
      // 1. A session's own outputs, read and write; another session's, neither.
      for (const c of [main, callers.side, callers.coding]) expect(reach(c, `${CLOVER}/outputs/s_1/report.md`)).toEqual([true, true]);
      // A delegated agent gets no way into the home, its own session's outputs included (#234's review, F4).
      expect(reach(callers.agent, `${CLOVER}/outputs/s_1/report.md`)).toEqual([false, false]);
      expect(reach(session("luna", "agent", "s_5"), `${CLOVER}/outputs/s_5/report.md`)).toEqual([false, false]);
      expect(reach(callers.other, `${CLOVER}/outputs/s_1/report.md`)).toEqual([true, false]); // a bot reads it, never writes
      expect(reach(callers.peer, `${CLOVER}/outputs/s_1/report.md`)).toEqual([false, false]);
      // 2. Every bot's scratch, for every bot's main conversation and side threads (the owner's ruling of November 9).
      expect([reach(main, `${CLOVER}/scratch/luna/a.md`), reach(callers.side, `${CLOVER}/scratch/luna/a.md`), reach(callers.other, `${CLOVER}/scratch/luna/a.md`)]).toEqual([[true, true], [true, true], [true, true]]);
      for (const c of [callers.agent, callers.coding, callers.plugin]) expect(reach(c, `${CLOVER}/scratch/luna/a.md`)).toEqual([false, false]);
      // Its own routines too, read and write, for the same two; another bot's, and every other caller, neither.
      expect([reach(main, `${CLOVER}/routines/luna/morning.md`), reach(callers.side, `${CLOVER}/routines/luna/morning.md`)]).toEqual([[true, true], [true, true]]);
      expect(reach(session("newbot", "side-thread"), `${CLOVER}/routines/newbot/a.md`)).toEqual([true, true]);
      for (const c of [callers.agent, callers.coding, callers.plugin, callers.peer, undefined]) expect(reach(c, `${CLOVER}/routines/luna/morning.md`)).toEqual([false, false]);
      // Another bot's routines: read, never written.
      expect(reach(callers.other, `${CLOVER}/routines/luna/morning.md`)).toEqual([true, false]);
      expect(reach(main, `${CLOVER}/routines/alpha/morning.md`)).toEqual([true, false]);
      // A plugin's own data folder, read and write, for that plugin alone, by its own id (`/` as `--`); never a bot's or
      // a session's, not even for a session the plugin acts for.
      expect(reach(callers.plugin, `${CLOVER}/plugin-data/tarot/deck.json`)).toEqual([true, true]);
      expect(reach({ kind: "plugin", pluginId: "pack/tarot" }, `${CLOVER}/plugin-data/pack--tarot/deck.json`)).toEqual([true, true]);
      expect(reach({ kind: "plugin", pluginId: "pack/tarot" }, `${CLOVER}/plugin-data/pack/tarot/deck.json`)).toEqual([false, false]);
      expect(reach(callers.plugin, `${CLOVER}/plugin-data/TAROT/deck.json`)).toEqual([true, true]);
      expect(reach(callers.plugin, `${CLOVER}/plugin-data/luna/x.json`)).toEqual([false, false]);
      expect(reach(callers.plugin, `${CLOVER}/plugin-data/tarot/../luna/x.json`)).toEqual([false, false]);
      for (const c of [main, callers.side, callers.agent, callers.coding, callers.peer, undefined]) expect(reach(c, `${CLOVER}/plugin-data/tarot/deck.json`)).toEqual([false, false]);
      expect(reach(session("tarot", "bot"), `${CLOVER}/plugin-data/tarot/deck.json`)).toEqual([false, false]);
      expect(reach(callers.plugin, `${CLOVER}/scratch/tarot/a.md`)).toEqual([false, false]);
      expect(reach(callers.plugin, `${CLOVER}/routines/tarot/a.md`)).toEqual([false, false]);
      // 3. Its own bot folder, read; its memory, read and write; an unlisted bot's the same way.
      expect(reach(main, `${CLOVER}/bots/luna/agents/a_1.jsonl`)).toEqual([true, false]);
      expect(reach(main, `${CLOVER}/bots/luna/memory/MEMORY.md`)).toEqual([true, true]);
      expect(reach(session("newbot", "bot"), `${CLOVER}/bots/newbot/memory/MEMORY.md`)).toEqual([true, true]);
      expect(reach(main, `${CLOVER}/bots/newbot/agents/x`)).toEqual([true, false]);
      // Links and `..`, case and folding, don't walk around it: a bot reads the settings, never writes them.
      expect(reach(main, `${CLOVER}/scratch/luna/../../settings/settings.json`)).toEqual([true, false]);
      expect(reach(callers.coding, `${CLOVER}/scratch/luna/../../settings/settings.json`)).toEqual([false, false]);
      expect(reach(main, `${CLOVER}/outputs/s_1/../s_9/x`)).toEqual([true, false]);
      expect(reach(main, `${CLOVER}/SCRATCH/LUNA/a.md`)).toEqual([true, true]);
      expect(reach(session("luna", "bot", ".."), `${CLOVER}/outputs/x`)).toEqual([true, false]);
      expect(reach(session("..", "bot", ".."), `${CLOVER}/outputs/x`)).toEqual([false, false]); // no bot: no way in
      // The folders themselves are never written over, deleted or moved.
      for (const path of [`${CLOVER}/outputs/s_1`, `${CLOVER}/scratch/luna`, `${CLOVER}/routines/luna`, `${CLOVER}/routines`, `${CLOVER}/bots/luna`, `${CLOVER}/bots/luna/memory`]) {
        expect([path, f.forCaller(main).check({ op: "delete", path }).allowed]).toEqual([path, false]);
        expect([path, f.forCaller(main).check({ op: "move", path, to: `${CLOVER}/scratch/luna/moved` }).allowed]).toEqual([path, false]);
      }
      for (const path of [`${CLOVER}/plugin-data/tarot`, `${CLOVER}/plugin-data`]) {
        expect([path, f.forCaller(callers.plugin).check({ op: "delete", path }).allowed]).toEqual([path, false]);
      }
      // Moves stay inside the folder: out of it, or in from another, is refused.
      expect(f.forCaller(main).check({ op: "move", path: `${CLOVER}/routines/luna/a.md`, to: `${CLOVER}/routines/luna/b.md` }).allowed).toBe(true);
      expect(f.forCaller(main).check({ op: "move", path: `${CLOVER}/routines/luna/a.md`, to: `${CLOVER}/routines/alpha/a.md` }).allowed).toBe(false);
      expect(f.forCaller(callers.plugin).check({ op: "move", path: `${CLOVER}/plugin-data/tarot/a`, to: `${CLOVER}/plugin-data/luna/a` }).allowed).toBe(false);
      // The user's surfaces and the core reach it freely, less what is fenced by kind.
      expect(reach({ kind: "user", client: "app" }, `${CLOVER}/sessions/s_1.jsonl`)).toEqual([true, false]);
      // Runners, by the reference order: the same three ways in, and the home denied otherwise.
      const p = f.forCaller(main).policy();
      expect([p.ownOutputs, p.ownScratch, p.ownBot, p.ownRoutines, p.ownMemory, p.ownPluginData]).toEqual([`${CLOVER}/outputs/s_1`, `${CLOVER}/scratch/luna`, `${CLOVER}/bots/luna`, `${CLOVER}/routines/luna`, `${CLOVER}/bots/luna/memory`, undefined]);
      expect([policyAllows(p, "write", `${CLOVER}/routines/luna/a.md`), policyAllows(p, "write", `${CLOVER}/routines/alpha/a.md`), policyAllows(p, "unlink", `${CLOVER}/routines/luna`), policyAllows(p, "rename", `${CLOVER}/routines`)]).toEqual([true, false, false, false]);
      expect(policyAllows(p, "write", `${CLOVER}/plugin-data/tarot/a`)).toBe(false);
      const plugin = f.forCaller(callers.plugin).policy();
      expect([plugin.ownPluginData, plugin.ownOutputs, plugin.ownScratch, plugin.ownRoutines, plugin.ownBot, plugin.ownMemory]).toEqual([`${CLOVER}/plugin-data/tarot`, undefined, undefined, undefined, undefined, undefined]);
      expect([policyAllows(plugin, "read", `${CLOVER}/plugin-data/tarot/a`), policyAllows(plugin, "write", `${CLOVER}/plugin-data/tarot/a`), policyAllows(plugin, "write", `${CLOVER}/plugin-data/luna/a`), policyAllows(plugin, "unlink", `${CLOVER}/plugin-data/tarot`), policyAllows(plugin, "read", `${CLOVER}/routines/tarot/a`)]).toEqual([true, true, false, false, false]);
      expect(f.forCaller({ kind: "plugin", pluginId: "../x" } as never).policy().ownPluginData).toBeUndefined();
      expect([policyAllows(p, "write", `${CLOVER}/outputs/s_1/a`), policyAllows(p, "write", `${CLOVER}/scratch/luna/a`), policyAllows(p, "read", `${CLOVER}/bots/luna/agents/x`), policyAllows(p, "write", `${CLOVER}/bots/luna/agents/x`)]).toEqual([true, true, true, false]);
      expect([policyAllows(p, "read", `${CLOVER}/projects/x.jsonl`), policyAllows(p, "read", `${CLOVER}/sessions/s_1.jsonl`), policyAllows(p, "unlink", `${CLOVER}/outputs/s_1`)]).toEqual([false, false, false]);
      const coding = f.forCaller(callers.coding).policy();
      expect([coding.ownOutputs, coding.ownScratch, coding.ownBot, coding.ownRoutines, coding.ownMemory, coding.ownPluginData]).toEqual([`${CLOVER}/outputs/s_1`, undefined, undefined, undefined, undefined, undefined]);
      const agent = f.forCaller(callers.agent).policy();
      expect([agent.ownOutputs, agent.ownScratch, agent.ownBot, agent.ownRoutines, agent.ownMemory, agent.ownPluginData]).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
      expect(policyAllows(agent, "write", `${CLOVER}/outputs/s_1/a`)).toBe(false);
    });

    test("a bot id that isn't one reaches no memory: `..` and `LUNA` (#197's check 5)", () => {
      const f = fence("macos");
      for (const bot of ["..", "LUNA", "../../settings", "a"]) {
        const c = f.forCaller({ kind: "session", sessionId: "s_1", sessionKind: "bot", bot } as never);
        expect([bot, c.context.memoryOf, c.policy().ownMemory]).toEqual([bot, undefined, undefined]);
        expect([bot, c.check({ op: "read", path: `${CLOVER}/bots/luna/memory/MEMORY.md` }).allowed]).toEqual([bot, false]);
      }
    });

    test("sessions-runtime: write-denied; a session reads only its own state (#197's check 4)", () => {
      const f = fence("macos");
      const RT = `${CLOVER}/sessions-runtime`;
      const own = { kind: "session", sessionId: "s_1", sessionKind: "bot", bot: "luna" } as const;
      const other = { kind: "session", sessionId: "s_2", sessionKind: "coding" } as const;
      expect(f.check({ op: "write", path: `${RT}/s_1.json` })).toEqual({ allowed: false, reason: "sessions-runtime", path: RT });
      expect(f.forCaller(own).check({ op: "write", path: `${RT}/s_1.json` }).allowed).toBe(false);
      // The home default-deny: no tool reads runtime state, its own session's included (a bot's, `BOT_READ_DENIED`); the
      // core reads it for the session.
      expect(f.forCaller(own).check({ op: "read", path: `${RT}/s_1.json` }).allowed).toBe(false);
      expect(f.forCaller(other).check({ op: "read", path: `${RT}/s_1.json` })).toEqual({ allowed: false, reason: "sessions-runtime", path: RT });
      expect(f.check({ op: "read", path: `${RT}/s_1.json` }).allowed).toBe(false);
      expect(f.forCaller({ kind: "user", client: "app" }).check({ op: "read", path: `${RT}/s_1.json` }).allowed).toBe(true);
      expect(policyAllows(f.forCaller(own).policy(), "read", `${RT}/s_1.json`)).toBe(false);
    });

    test("reads outside the Clover home are free; inside it, the home default-deny (the controller's ruling)", () => {
      const f = fence();
      expect(f.check({ op: "read", path: `${HOME}/project/README.md` })).toEqual({ allowed: true });
      expect(f.check({ op: "read", path: `${CLOVER}/settings/settings.json` })).toEqual({ allowed: false, reason: "clover-home", path: CLOVER });
      expect(f.check({ op: "read", path: `${CLOVER}/run/core.sock` }).allowed).toBe(false);
      expect(f.check({ op: "list", path: CLOVER }).allowed).toBe(false);
      expect(f.forCaller({ kind: "user", client: "app" }).check({ op: "read", path: `${CLOVER}/settings/settings.json` })).toEqual({ allowed: true });
    });

    test("the registry's own records are fenced: its OKs, the installed list and the 18+ confirmation (review S8)", () => {
      const f = fence();
      for (const kind of ["plugin-oks", "installed-plugins", "adult-confirmation"] as const) {
        const item = f.fencedSet().find((i) => i.kind === kind)!;
        expect(item.deny).toBe("write");
        expect(f.check({ op: "write", path: item.path })).toEqual({ allowed: false, reason: kind, path: item.path });
      }
    });

    test("routine files are their own bot's alone; the installed plugins folder is fenced (#197's check 2): bots get plugins in by the OK card", () => {
      const f = fence();
      expect(f.check({ op: "write", path: `${CLOVER}/plugins/luna/clover.json` })).toEqual({ allowed: false, reason: "plugins", path: `${CLOVER}/plugins` });
      expect(f.check({ op: "write", path: `${CLOVER}/routines/alpha/morning.md` })).toEqual({ allowed: false, reason: "clover-home", path: CLOVER });
      expect(f.check({ op: "write", path: `${HOME}/project/README.md` })).toEqual({ allowed: true });
    });

    test("deleting or moving a folder that holds a fenced item is refused (renaming an ancestor moves it)", () => {
      const f = fence();
      expect(f.check({ op: "delete", path: CLOVER }).allowed).toBe(false);
      expect(f.check({ op: "move", path: CLOVER, to: "/tmp/stolen" }).allowed).toBe(false);
      expect(f.check({ op: "move", path: `${HOME}/a`, to: `${CLOVER}/settings/a` }).allowed).toBe(false);
      expect(f.check({ op: "delete", path: `${CLOVER}/plugins/old` }).allowed).toBe(false);
      expect(f.check({ op: "delete", path: `${CLOVER}/routines/old` }).allowed).toBe(false);
      expect(f.check({ op: "delete", path: `${HOME}/project/old` }).allowed).toBe(true);
    });

    test("development folders are fenced while on, and changes reach watchers", () => {
      const f = fence();
      let changes = 0;
      f.watch(() => changes++);
      expect(f.check({ op: "write", path: `${HOME}/dev/luna/host/index.ts` }).allowed).toBe(true);
      f.addDevFolder(`${HOME}/dev/luna`);
      expect(f.check({ op: "write", path: `${HOME}/dev/luna/host/index.ts` })).toEqual({ allowed: false, reason: "dev-folders", path: `${HOME}/dev/luna` });
      f.removeDevFolder(`${HOME}/dev/luna`);
      expect(f.check({ op: "write", path: `${HOME}/dev/luna/host/index.ts` }).allowed).toBe(true);
      expect(changes).toBe(2);
    });

    test("touches finds a fenced item reached by any path, for the always-a-card rule", () => {
      const f = fence();
      expect(f.touches([`${HOME}/project/a.ts`])).toBeNull();
      expect(f.touches([`${HOME}/project/a.ts`, `${CLOVER}/levels/x.json`])?.kind).toBe("levels");
      expect(f.touches([HOME])?.kind).toBeDefined();
    });

    test("an agent's root may not hold the Clover home or a development folder", () => {
      const f = fence("macos", [`${HOME}/dev/luna`]);
      expect(f.checkAgentRoot(`${HOME}/project`)).toEqual({ allowed: true });
      expect(f.checkAgentRoot(HOME)).toEqual({ allowed: false, reason: "clover-home", path: CLOVER });
      expect(f.checkAgentRoot("/")).toEqual({ allowed: false, reason: "clover-home", path: CLOVER });
      expect(f.checkAgentRoot(`${HOME}/dev`)).toEqual({ allowed: false, reason: "dev-folders", path: `${HOME}/dev/luna` });
      expect(f.checkAgentRoot(`${HOME}/dev/luna`).allowed).toBe(false);
    });

    test("the policy: write in home and temp, less the fenced set; no network; the OS's closed doors; metadata blocked", () => {
      const mac = fence("macos").policy();
      expect(mac.allowWrite).toEqual([HOME, "/tmp"]);
      expect(mac.denyWrite).toContain(`${CLOVER}/credentials`);
      // The read-denied list includes the run folder; an implementation may hide more (lane C keeps `runtimes/`).
      expect(mac.denyRead).toContain(`${CLOVER}/run`);
      expect(mac.denyRead).toContain(`${HOME}/Library/Application Support/Clover/Partitions`);
      expect(mac.denyWrite).toEqual(expect.arrayContaining([`${CLOVER}/sessions`, `${CLOVER}/usage`, `${HOME}/Library/LaunchAgents`]));
      // The installed plugins folder is write-denied, not read-denied (#197's check 2).
      expect(fence("macos").check({ op: "write", path: `${CLOVER}/plugins/tarot/clover.json` })).toEqual({ allowed: false, reason: "plugins", path: `${CLOVER}/plugins` });
      expect(fence("macos").forCaller({ kind: "user", client: "app" }).check({ op: "read", path: `${CLOVER}/plugins/tarot/clover.json` }).allowed).toBe(true);
      // An OK'd coding agent's install folder is write-denied, not read-denied (lane K).
      expect(mac.denyWrite).toContain(AGENT);
      expect(mac.denyRead).not.toContain(AGENT);
      expect(fence("macos").check({ op: "write", path: `${AGENT}/dist/index.js` })).toEqual({ allowed: false, reason: "agent-installs", path: AGENT });
      expect(fence("macos").check({ op: "read", path: `${AGENT}/dist/index.js` }).allowed).toBe(true);
      expect(mac.closedDoors).toEqual(["open", "launchctl", "osascript"]);
      expect(mac.blockedAddresses).toEqual([...CLOUD_METADATA_ADDRESSES]);
      expect(mac.network).toBe("none");
      expect(fence("linux").policy().closedDoors).toEqual(["systemd-run"]);
      expect(fence("linux").policy().denyRead).toContain(`${CLOVER}/secrets.enc`);
      expect(fence("windows").policy().closedDoors).toContain("schtasks");
    });

    test("a fenced name in another case, not on disk yet, is refused on every OS (J-M1's review, B1)", () => {
      for (const os of ["macos", "windows", "linux"] as const) {
        const f = fence(os);
        for (const path of [`${CLOVER}/RULES/allow.json`, `${CLOVER}/Settings/settings.json`, `${CLOVER}/LEVELS/computer.json`, `${HOME}/.Clover/trust/x.json`]) {
          expect([os, path, f.check({ op: "write", path }).allowed]).toEqual([os, path, false]);
        }
        expect(f.check({ op: "move", path: `${HOME}/a.json`, to: `${CLOVER}/CONNECTORS/a.json` }).allowed).toBe(false);
        expect(f.touches([`${CLOVER}/Rules`])).not.toBeNull();
        expect(f.checkAgentRoot(`${HOME}/.CLOVER`).allowed).toBe(false);
      }
    });

    test("names a disk folds beyond lower case are refused: the long s, the Kelvin sign, ß (#179's review, F1)", () => {
      for (const os of ["macos", "windows", "linux"] as const) {
        const f = fence(os);
        // ſ (U+017F) upper-cases to S; the Kelvin sign (U+212A) is K; both open the fenced folder on APFS and NTFS.
        expect(f.check({ op: "write", path: `${CLOVER}/\u017Fettings/settings.json` })).toEqual({ allowed: false, reason: "settings", path: `${CLOVER}/settings` });
        expect(f.check({ op: "write", path: `${CLOVER}/rule\u017F/allow.json` })).toMatchObject({ allowed: false, reason: "saved-rules" });
        expect(f.check({ op: "write", path: `${CLOVER}/tru\u017Ft/x.json` })).toMatchObject({ allowed: false, reason: "trust" });
        expect(f.check({ op: "write", path: `${CLOVER}/plugins-state/o\u212As/x.json` })).toMatchObject({ allowed: false, reason: "plugin-oks" });
        expect(f.check({ op: "move", path: `${HOME}/a`, to: `${CLOVER}/\u212Aeys` })).toMatchObject({ allowed: false, reason: "clover-home" });
        expect(f.touches([`${CLOVER}/\u017Fettings`])).toMatchObject({ kind: "settings" });
        // ß folds to ss, and a name that isn't ASCII where Clover names things is refused whatever it folds to.
        expect(f.check({ op: "write", path: `${CLOVER}/\u00DFettings/x.json` })).toEqual({ allowed: false, reason: "clover-home", path: CLOVER });
        expect(f.check({ op: "write", path: `${CLOVER}/plugins-state/\u00F6ks/x.json` })).toMatchObject({ allowed: false, reason: "clover-home" });
        expect(f.check({ op: "read", path: `${CLOVER}/\u0455ettings/settings.json` })).toMatchObject({ allowed: false, reason: "clover-home" });
        // Where Clover doesn't name things (a bot's memory and scratch), any name is the bot's own.
        const luna = f.forCaller({ kind: "session", sessionId: "s_luna", sessionKind: "bot", bot: "luna" });
        expect(luna.check({ op: "write", path: `${CLOVER}/bots/luna/memory/\u65E5\u8A18.md` }).allowed).toBe(true);
        expect(luna.check({ op: "write", path: `${CLOVER}/scratch/luna/caf\u00E9.md` }).allowed).toBe(true);
        // A bot's own routines, likewise (C's #205; the home default-deny lets a bot's own sessions alone in).
        const alpha = f.forCaller({ kind: "session", sessionId: "s_alpha", sessionKind: "bot", bot: "alpha" });
        expect(alpha.check({ op: "write", path: `${CLOVER}/routines/alpha/caf\u00E9.md` }).allowed).toBe(true);
        expect(f.check({ op: "write", path: `${HOME}/\u017Fettings.json` }).allowed).toBe(true);
      }
      expect(foldName("Stra\u00DFe")).toBe("strasse");
      expect(foldName("\u212A")).toBe("k");
      expect(foldName("\u017F")).toBe("s");
      expect(foldName(".clover. ", "windows")).toBe(".clover");
      expect(foldPath("C:\\Users\\Me", "windows")).toBe("c:/users/me");
    });

    test("on Windows a stream or an 8.3 short name is refused wherever it is (J's rules, #179's review check 2)", () => {
      const win = fence("windows");
      for (const path of [`${CLOVER}/settings/settings.json::$DATA`, `${CLOVER}/settings/settings.json:x`, `${HOME}/CLOVER~1/settings/settings.json`, `${HOME}/notes~2.md`]) {
        expect([path, win.check({ op: "write", path })]).toEqual([path, { allowed: false, reason: "alias", path }]);
        expect(win.check({ op: "read", path }).allowed).toBe(false);
      }
      expect(win.check({ op: "move", path: `${HOME}/a.json`, to: `${HOME}/CLOVER~1/rules/a.json` })).toMatchObject({ reason: "alias" });
      expect(windowsAlias("C:/Users/me/a.json")).toBeUndefined();
      // Elsewhere a colon or a tilde is part of a name.
      expect(fence("linux").check({ op: "write", path: `${HOME}/notes~2.md` }).allowed).toBe(true);
      expect(fence("macos").check({ op: "write", path: `${HOME}/a:b.txt` }).allowed).toBe(true);
    });

    test("judge is the shared rule, usable over any set", () => {
      const set = [{ kind: "settings" as const, path: "/c/settings", deny: "write" as const }];
      expect(judge(set, { op: "write", path: "/c/settings/a" }).allowed).toBe(false);
      expect(judge(set, { op: "read", path: "/c/settings/a" }).allowed).toBe(true);
    });
  });
}
