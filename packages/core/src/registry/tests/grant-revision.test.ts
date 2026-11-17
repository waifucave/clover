// A grant made before revision 19 reads NEITHER kind of data (no bots' conversations, no code sessions) until the plugin
// asks again (the controller's ruling of 2026-11-17, spec §3.6). The OK record keeps the catalog revision it was given at;
// the plugin keeps its other grants and its OK card is raised again; the user's yes records the revision; the bundled
// plugins are approved again by themselves.
import { describe, expect, test } from "bun:test";
import { catalogPointDecl } from "@waifucave/moss-plugin-sdk";
import { GRANT_REVISION } from "@waifucave/moss-protocol";
import type { Manifest } from "../../contracts/sdk-types";
import { RegistryCore, type OkCardRaiser } from "../core";
import { memoryRegistryStore } from "../state";

const manifest = (over: Partial<Manifest> = {}): Manifest => ({ manifest: 1, name: "Luna", capabilities: ["conversation.read", "sessions.read", "notify"], ...over });
const READS = ["conversation.read", "sessions.read"];

describe("an OK from before revision 19", () => {
  test("reads neither kind, keeps its other grants, asks again, and a yes gives the reads back (across a restart too)", async () => {
    const store = memoryRegistryStore();
    const a = new RegistryCore({ catalog: catalogPointDecl, store });
    a.putAll([{ id: "luna", manifest: manifest(), treeHash: "sha256:1", approved: false }]);
    expect(await a.approve("luna", "sha256:1")).toBe("approved");
    expect(a.get("luna")!.granted).toEqual(expect.arrayContaining([...READS, "notify"]));
    expect(a.get("luna")!.okRevision).toBe(GRANT_REVISION);

    // The record as an older build kept it: no revision.
    for (const p of Object.values(store.state.plugins)) delete (p as { okRevision?: number }).okRevision;
    const shown: string[] = [];
    const answers: (() => void)[] = [];
    const cards: OkCardRaiser = { raise: (req, answered) => (shown.push(req.id), answers.push(() => answered({ approved: true })), `card_ok${shown.length}`) };
    const b = new RegistryCore({ catalog: catalogPointDecl, store, cards });
    b.putAll([{ id: "luna", manifest: manifest(), treeHash: "sha256:1" }]);
    const old = b.get("luna")!;
    expect(old.state).toBe("running");
    expect(old.granted).toEqual(["notify"]);
    for (const r of READS) expect(old.granted).not.toContain(r);
    expect(b.staleGrants()).toEqual(["luna"]);

    // It asks again, for the tree it runs; it goes on running on its other grants meanwhile.
    expect(await b.askStaleGrantsAgain()).toEqual(["luna"]);
    expect(shown).toEqual(["luna"]);
    expect(b.get("luna")!.granted).toEqual(["notify"]);
    expect(await b.approve("luna", "sha256:1")).toBe("approved");
    expect(b.get("luna")!.granted).toEqual(expect.arrayContaining([...READS, "notify"]));
    expect(b.staleGrants()).toEqual([]);

    // The yes is kept: after a restart it reads both again, and asks nothing.
    const c = new RegistryCore({ catalog: catalogPointDecl, store });
    c.putAll([{ id: "luna", manifest: manifest(), treeHash: "sha256:1" }]);
    expect(c.get("luna")!.granted).toEqual(expect.arrayContaining([...READS, "notify"]));
    expect(c.staleGrants()).toEqual([]);
  });

  test("a tree whose CHILD part holds the read asks again too (the top lists neither)", async () => {
    const store = memoryRegistryStore();
    const tree = [
      { id: "suite", manifest: manifest({ capabilities: ["notify"] }), treeHash: "sha256:s", approved: false },
      { id: "suite/part", manifest: manifest({ capabilities: ["conversation.read"] }), treeHash: "sha256:s" },
    ];
    const a = new RegistryCore({ catalog: catalogPointDecl, store });
    a.putAll(tree);
    await a.approve("suite", "sha256:s");
    expect(a.get("suite/part")!.granted).toContain("conversation.read");
    for (const p of Object.values(store.state.plugins)) delete (p as { okRevision?: number }).okRevision;
    const shown: string[] = [];
    const cards: OkCardRaiser = { raise: (req) => (shown.push(req.id), `card_ok${shown.length}`) };
    const b = new RegistryCore({ catalog: catalogPointDecl, store, cards });
    b.putAll(tree.map((t) => ({ ...t, approved: undefined })));
    expect(b.get("suite/part")!.granted).toEqual([]);
    expect(b.staleGrants()).toEqual(["suite"]);
    expect(await b.askStaleGrantsAgain()).toEqual(["suite"]);
    expect(shown).toEqual(["suite"]);
  });

  test("a plugin whose grants the split didn't narrow asks nothing; a bundled one is approved again by itself", async () => {
    const store = memoryRegistryStore();
    const a = new RegistryCore({ catalog: catalogPointDecl, store });
    a.putAll([
      { id: "plain", manifest: manifest({ capabilities: ["notify"] }), treeHash: "sha256:p", approved: false },
      { id: "bundled", manifest: manifest(), treeHash: "sha256:b", approved: true, source: "bundled" },
    ]);
    await a.approve("plain", "sha256:p");
    for (const p of Object.values(store.state.plugins)) delete (p as { okRevision?: number }).okRevision;
    const b = new RegistryCore({ catalog: catalogPointDecl, store });
    b.putAll([
      { id: "plain", manifest: manifest({ capabilities: ["notify"] }), treeHash: "sha256:p" },
      { id: "bundled", manifest: manifest(), treeHash: "sha256:b", approved: true, source: "bundled" },
    ]);
    expect(b.staleGrants()).toEqual([]);
    expect(b.get("plain")!.granted).toEqual(["notify"]);
    expect(b.get("bundled")!.granted).toEqual(expect.arrayContaining([...READS, "notify"]));
    expect(b.get("bundled")!.okRevision).toBe(GRANT_REVISION);
  });

  test("a new plugin OK'd now is stamped; an update that applies keeps an old OK old (the reads stay out until it asks)", async () => {
    const store = memoryRegistryStore();
    const a = new RegistryCore({ catalog: catalogPointDecl, store });
    a.putAll([{ id: "luna", manifest: manifest(), treeHash: "sha256:1", approved: false }]);
    await a.approve("luna", "sha256:1");
    for (const p of Object.values(store.state.plugins)) delete (p as { okRevision?: number }).okRevision;
    const b = new RegistryCore({ catalog: catalogPointDecl, store });
    b.putAll([{ id: "luna", manifest: manifest(), treeHash: "sha256:1" }]);
    // The restored update (an approved input, the tree changed in a way that applies) is not a new OK.
    b.putAll([{ id: "luna", manifest: manifest(), treeHash: "sha256:2", change: "applies", approved: true }]);
    expect(b.get("luna")!.granted).toEqual(["notify"]);
    expect(b.get("luna")!.okRevision).toBeUndefined();
  });
});
