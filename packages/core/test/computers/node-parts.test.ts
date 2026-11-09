// The computer node's own parts in the daemon (lane J's `nodeParts`): the paste card through the broker, and the safety
// reviewer for another computer's calls, which fails closed.
import { describe, expect, test } from "bun:test";
import { ReviewerNoRunnableModel, type ReviewInput } from "../../src/agent/reviewer";
import type { ApprovalRequest } from "../../src/contracts/approval-broker";
import { confirmPasteVia, nodeParts, PASTE_CARD_LINES, PASTE_CARD_TEXT, pasteCardRequest, peerReviewer, reviewInputFor, type SafetyReviewer } from "../../src/computers/node-parts";

const PEER = { kind: "peer", device: "d_laptop", sessionId: "s_code" } as const;

describe("the paste card", () => {
  test("a confirm card: each line on its own, hiding characters out, the lines capped", () => {
    const r = pasteCardRequest("echo one\r\nrm -rf x‮\u0007\n\n", { computer: "Studio", terminalId: "t1" });
    expect(r).toMatchObject({ kind: "confirm", origin: "user", computers: ["Studio"], effect: "execute" });
    expect(r.options).toEqual([{ id: "approve", kind: "approve", label: "Paste" }, { id: "deny", kind: "deny", label: "Don't paste" }]);
    expect(r.fields.title).toEqual({ type: "text", text: PASTE_CARD_TEXT.title });
    expect(r.fields.command).toEqual({ type: "list", items: ["echo one", "rm -rf x"] });
    const many = pasteCardRequest(Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n"), { computer: "Studio", terminalId: "t1" });
    const items = (many.fields.command as { items: string[] }).items;
    expect(items).toHaveLength(PASTE_CARD_LINES);
    expect(items.at(-1)).toBe("…and 301 more lines");
  });

  test("confirmPaste is true only on the person's yes", async () => {
    const asked: ApprovalRequest[] = [];
    let allowed = false;
    const confirm = confirmPasteVia({ request: async (r) => { asked.push(r); return { allowed, by: "card" } as never; } }, () => "Studio");
    expect(await confirm("a\nb", "t1")).toBe(false);
    allowed = true;
    expect(await confirm("a\nb", "t1")).toBe(true);
    expect(asked.map((r) => r.kind)).toEqual(["confirm", "confirm"]);
    // Without a broker, the node gets no confirmPaste: such a paste is refused with a reason (tree/terminals.ts).
    expect(nodeParts({ computer: () => "Studio" }).terminals).toEqual({});
    expect(nodeParts({ computer: () => "Studio", approvals: { request: async () => ({ allowed: true }) as never } }).terminals!.confirmPaste).toBeDefined();
  });
});

describe("the safety reviewer for another computer's calls", () => {
  test("a Bash call is shown as a command, another tool as an external call, a tree change by its paths and size alone", () => {
    expect(reviewInputFor({ computer: "Studio", method: "tool.run", params: { tool: "Bash", input: { command: "ls -la", cwd: "home/Studio" } }, as: PEER, effect: "execute" }))
      .toEqual({ class: "bash", command: "ls -la", justification: "Asked of Studio by another of the user's computers (device d_laptop)." });
    expect(reviewInputFor({ computer: "Studio", method: "tool.run", params: { tool: "mcp__blender__render", input: { scene: 1 } }, as: PEER })).toMatchObject({ class: "external" });
    const w = reviewInputFor({ computer: "Studio", method: "tree.write", params: { path: "home/Studio/a.md", data: { encoding: "utf8", text: "TOP SECRET CONTENT" } }, as: PEER, effect: "edit" });
    expect(w).toEqual({ class: "fs", precis: "tree.write path: home/Studio/a.md, 18 characters (Asked of Studio by another of the user's computers (device d_laptop).)" });
    expect(JSON.stringify(w)).not.toContain("TOP SECRET");
    expect(reviewInputFor({ computer: "Studio", method: "tree.move", params: { from: "home/Studio/a", to: "home/Studio/b" }, as: PEER, effect: "move" }))
      .toMatchObject({ class: "fs", precis: expect.stringContaining("from: home/Studio/a, to: home/Studio/b") });
  });

  test("safe only on a safe verdict; it fails closed with no reviewer, no runnable model, or any failure", async () => {
    const call = { computer: "Studio", method: "tool.run", params: { tool: "Bash", input: { command: "make" } }, as: PEER, effect: "execute" as const };
    const seen: ReviewInput[] = [];
    const says = (f: () => Promise<{ verdict: "safe" | "unsafe"; reason: string }>): SafetyReviewer => ({ review: async (i) => { seen.push(i); return f(); } });
    expect(await peerReviewer(says(async () => ({ verdict: "safe", reason: "a build" })))(call)).toBe("safe");
    expect(await peerReviewer(says(async () => ({ verdict: "unsafe", reason: "deletes" })))(call)).toBe("risky");
    expect(seen).toHaveLength(2);
    const lines: string[] = [];
    expect(await peerReviewer(undefined)(call)).toBe("unavailable");
    expect(await peerReviewer(says(async () => { throw new ReviewerNoRunnableModel("no-default-model", "nothing pinned"); }), (l) => lines.push(l))(call)).toBe("unavailable");
    expect(await peerReviewer(says(async () => { throw new Error("timeout"); }), (l) => lines.push(l))(call)).toBe("unavailable");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("needs the user's answer");
  });
});
