import { describe, expect, test } from "bun:test";
import { parseCodeArgs, runCodeCommand, treeRootOf } from "../src/code-cli";

describe("clover code", () => {
  test("arguments", () => {
    expect(parseCodeArgs(["src", "--backend", "cursor", "-p", "fix it"])).toEqual({ kind: "ok", args: { folder: "src", backend: "cursor", prompt: "fix it" } });
    expect(parseCodeArgs(["--model"]).kind).toBe("usage");
    expect(parseCodeArgs(["a", "b", "--backend", "x"]).kind).toBe("usage");
    expect(parseCodeArgs(["--what", "x"]).kind).toBe("usage");
    expect(parseCodeArgs([]).kind).toBe("usage");
  });

  test("a local folder becomes its folder-tree path; one outside the home has none", () => {
    expect(treeRootOf(undefined, { cwd: "/Users/me/project1", home: "/Users/me", computer: "Studio" })).toEqual({ ok: true, root: "home/Studio/project1", computer: "Studio" });
    expect(treeRootOf("../x", { cwd: "/Users/me/project1", home: "/Users/me", computer: "Studio" })).toEqual({ ok: true, root: "home/Studio/x", computer: "Studio" });
    expect(treeRootOf("home/Desk/repo/", { cwd: "/", home: "/Users/me" })).toEqual({ ok: true, root: "home/Desk/repo", computer: "Desk" });
    expect(treeRootOf("/etc", { cwd: "/", home: "/Users/me", computer: "Studio" }).ok).toBe(false);
    expect(treeRootOf(".", { cwd: "/Users/me", home: "/Users/me" }).ok).toBe(false);
    expect(treeRootOf(".", { cwd: "/Users/me", home: "/Users/me", computer: "bad name" }).ok).toBe(false);
  });

  test("it asks the daemon for agent.start and says what started", async () => {
    const calls: [string, unknown][] = [];
    const lines: string[] = [];
    const code = await runCodeCommand(["--backend", "cursor", "--model", "m1"], {
      connect: async () => ({ request: async (method, params) => (calls.push([method, params]), { session: "agent_abc" }), close: () => {} }),
      log: (l) => lines.push(l), error: (l) => lines.push(l), cwd: "/Users/me/project1", home: "/Users/me", env: { CLOVER_COMPUTER: "Studio" },
    });
    expect(code).toBe(0);
    expect(calls).toEqual([["agent.start", { backend: "cursor", computer: "Studio", root: "home/Studio/project1", model: "m1" }]]);
    expect(lines).toEqual(["Started coding session agent_abc (cursor) in home/Studio/project1."]);
    const failed = await runCodeCommand(["--backend", "cursor"], {
      connect: async () => ({ request: async () => { throw new Error("no agent backend named cursor"); }, close: () => {} }),
      log: () => {}, error: (l) => lines.push(l), cwd: "/Users/me", home: "/Users/me", env: { CLOVER_COMPUTER: "Studio" },
    });
    expect(failed).toBe(1);
    expect(lines.at(-1)).toBe("clover code: no agent backend named cursor");
  });
});
