// Alpha's pin under her replies: her own `ui` entry on the conversation's list spot, for her bot only, shown under her
// finished replies and nothing else; pressing it calls her server's `pinReply` (server/test/pin-reply.test.ts holds what
// gets pinned).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SPOTS } from "../../../../packages/plugin-sdk/src/catalogs/spots";
import { pinnableText } from "../../client/reply-item";

const ALPHA = join(import.meta.dir, "..", "..");
const manifest = JSON.parse(readFileSync(join(ALPHA, "clover.json"), "utf8"));

describe("the pin under her replies", () => {
  test("her entry on conversation.message.extra, for her own bot, with the capability the spot needs", () => {
    const entry = (manifest.contributes.ui as { spot: string; id?: string; component?: string; when?: { bot?: unknown } }[]).find((u) => u.spot === "conversation.message.extra");
    expect(entry).toEqual({ spot: "conversation.message.extra", id: "pin", component: "AlphaPinReply", when: { bot: "alpha" } });
    const spot = SPOTS.find((s) => s.name === "conversation.message.extra")!;
    for (const need of spot.needs ?? []) expect(manifest.capabilities).toContain(need);
    expect(readFileSync(join(ALPHA, "client", "index.tsx"), "utf8")).toContain('export { AlphaPinReply } from "./pin-reply";');
  });

  test("only under one of her finished replies: not a user's message, one still arriving, an empty one or a tool row", () => {
    expect(pinnableText({ kind: "bot", id: "m1", at: 1, text: "Done. I'll ring at 8:00." })).toBe("Done. I'll ring at 8:00.");
    for (const item of [{ kind: "user", text: "hi" }, { kind: "bot", text: "Half", streaming: true }, { kind: "bot", text: "  " }, { kind: "tool", name: "Read" }, null, undefined, "text"]) {
      expect(pinnableText(item)).toBeUndefined();
    }
  });
});
