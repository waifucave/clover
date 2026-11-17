// Alpha's pin in her replies' row of actions: a data entry on the conversation's `conversation.message.action` (no frame,
// no component), for her own bot, on finished replies; its icon a small stroke pin in her folder with a muted tone in each
// appearance (server/test/pin-reply.test.ts holds what a press pins).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ALPHA = join(import.meta.dir, "..", "..");
const manifest = JSON.parse(readFileSync(join(ALPHA, "moss.json"), "utf8"));

test("her pin left MOSS Code's window with her bot's tab (lane MC): no window entry names her bot", () => {
  expect(manifest.contributes.ui).toBeUndefined();
  expect(manifest.contributes.bot).toBeUndefined();
});

test("its icon: a 16 px stroke pin, a muted tone in the light and another in the dark, nothing that runs", () => {
  const svg = readFileSync(join(ALPHA, "assets", "pin.svg"), "utf8");
  expect(svg).toContain('width="16" height="16"');
  expect(svg).toContain("@media (prefers-color-scheme:dark)");
  expect(svg).toContain('d="M9 4h6l-1 5 3 3H7l3-3z"');
  expect(svg).not.toMatch(/<script|on[a-z]+=|href=|url\(/i);
});
