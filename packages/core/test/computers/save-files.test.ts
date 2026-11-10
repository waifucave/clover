// The MCP router's saveFiles: a call's files land in its saveTo or the session's scratch folder, and that folder is
// named only when there is a file to save. A session whose scratch has no folder-tree name (a Clover home outside the
// user's home) still gets a text-only result back, as the acceptance run's plugin Echo tool does.
import { expect, test } from "bun:test";
import { saveFiles, type McpResult } from "../../src/computers/mcp";

const as = { kind: "session", sessionId: "b_alpha", sessionKind: "bot", bot: "alpha" } as const;

test("a text-only result never names the folder; a file names it once, and a folder that can't be named fails the call", async () => {
  const written: string[] = [];
  const holder = { write: async (path: string) => { written.push(path); } } as never;
  let asked = 0;
  const noTree = () => { asked++; throw new Error("the scratch folder isn't inside the user's home"); };
  const text: McpResult = { content: [{ type: "text", text: "acceptance-echo-pong: hi" }] };
  expect(await saveFiles(holder, text, noTree, "call_1", as)).toEqual(text);
  expect(asked).toBe(0);
  const files: McpResult = { content: [{ type: "image", data: "AAAA", mimeType: "image/png" }, { type: "image", data: "BBBB", mimeType: "image/png" }] };
  let named = 0;
  const r = await saveFiles(holder, files, () => { named++; return "home/Studio/scratch/"; }, "call_2", as);
  expect(named).toBe(1);
  expect(written).toEqual(["home/Studio/scratch/call_2-0.png", "home/Studio/scratch/call_2-1.png"]);
  expect(r.content.map((c) => (c as { text?: string }).text)).toEqual(["Saved an image to home/Studio/scratch/call_2-0.png", "Saved an image to home/Studio/scratch/call_2-1.png"]);
  await expect(saveFiles(holder, files, noTree, "call_3", as)).rejects.toThrow("isn't inside the user's home");
  // A plain string folder still works as before.
  await saveFiles(holder, files, "home/Studio/designs", "call_4", as);
  expect(written.at(-1)).toBe("home/Studio/designs/call_4-1.png");
});
