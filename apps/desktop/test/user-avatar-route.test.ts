// `/_a/<bot>/…`: the user's own avatar model, served only from the bot's own folder, by its real path, never an SVG.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commonHeaders } from "../src/main/ui/documents";
import { userAvatarFile } from "../src/main/ui/files";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const registry = [
  { id: "alpha", isBot: true, avatarFormats: [] },
  { id: "tool", isBot: false, avatarFormats: [] },
  { id: "renderer", isBot: false, avatarFormats: [{ format: "live2d", extensions: [".model3.json"], find: "cubism-model3" as const, kinds: [{ ext: [".json"], type: "json" as const, maxBytes: 8 << 20 }, { ext: [".png"], type: "image" as const, maxBytes: 32 << 20 }] }] },
];

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "uav-"));
  roots.push(dir);
  mkdirSync(join(dir, "alpha", "m-1"), { recursive: true });
  writeFileSync(join(dir, "alpha", "m-1", "a.model3.json"), "{}");
  writeFileSync(join(dir, "alpha", "m-1", "x.svg"), "<svg/>");
  writeFileSync(join(dir, "secret.json"), "{}");
  return dir;
}

describe("the user's avatar route", () => {
  test("serves a model file of an installed bot", () => {
    const dir = setup();
    expect(userAvatarFile(dir, registry, "/_a/alpha/m-1/a.model3.json")).toMatchObject({ type: expect.stringContaining("json") });
  });

  test("a link planted after the import is not followed out of the bot's folder", () => {
    const dir = setup();
    symlinkSync(join(dir, "secret.json"), join(dir, "alpha", "m-1", "planted.json"));
    expect(userAvatarFile(dir, registry, "/_a/alpha/m-1/planted.json")).toBe("forbidden");
    symlinkSync(dir, join(dir, "alpha", "m-1", "up"));
    expect(userAvatarFile(dir, registry, "/_a/alpha/m-1/up/secret.json")).toBe("forbidden");
  });

  test("never an SVG, an unknown bot, or a path that climbs", () => {
    const dir = setup();
    expect(userAvatarFile(dir, registry, "/_a/alpha/m-1/x.svg")).toBe("forbidden");
    expect(userAvatarFile(dir, registry, "/_a/tool/m-1/a.model3.json")).toBe("forbidden");
    expect(userAvatarFile(dir, registry, "/_a/alpha/..%2Fsecret.json")).toBe("missing");
    expect(userAvatarFile(dir, registry, "/_a/alpha/m-1/nope.json")).toBe("missing");
  });

  test("every response carries nosniff", () => {
    expect(commonHeaders()["X-Content-Type-Options"]).toBe("nosniff");
  });
});
