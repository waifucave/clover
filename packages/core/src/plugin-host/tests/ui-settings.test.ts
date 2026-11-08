// The user's UI choices: read, changed, checked, and told to the app.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uiSettingsFile, uiSettingsMethods } from "../ui-settings";

const APP = { caller: { kind: "user", client: "app" } } as never;
const LAYER = (pluginId: string) => ({ caller: { kind: "plugin", pluginId } }) as never;

describe("ui.settings and ui.set", () => {
  test("defaults, a change kept and told to the app, a layer's change refused, overrides checked", async () => {
    const home = mkdtempSync(join(tmpdir(), "clover-b2-uiset-"));
    const events: unknown[] = [];
    const m = uiSettingsMethods({ home, emit: (e) => void events.push(e) });
    expect(await m["ui.settings"]!({}, APP)).toEqual({ picks: [], lists: [] });
    expect(await m["ui.set"]!({ patch: { language: "pt-BR", appearance: "dark" } }, APP)).toEqual({ applied: true });
    expect(await m["ui.settings"]!({}, APP)).toEqual({ picks: [], lists: [], language: "pt-BR", appearance: "dark" });
    expect(JSON.parse(readFileSync(uiSettingsFile(home), "utf8")).language).toBe("pt-BR");
    expect(events).toEqual([{ type: "ui_settings_changed", settings: { picks: [], lists: [], language: "pt-BR", appearance: "dark" } }]);
    // The clover tree's layer applies; another layer's change waits for a card.
    expect(await m["ui.set"]!({ patch: { textSize: "large" } }, LAYER("clover/settings"))).toEqual({ applied: true });
    expect((await m["ui.set"]!({ patch: { textSize: "small" } }, LAYER("luna")).catch((e: Error) => e.message)) as string).toContain("card");
    // CSS overrides need the theme cleaner: refused, nothing written.
    expect((await m["ui.set"]!({ patch: { overrides: { css: "body { background: url(https://x) }" } } }, APP).catch((e: Error) => e.message)) as string).toContain("theme cleaner");
    expect(((await m["ui.settings"]!({}, APP)) as { overrides?: unknown }).overrides).toBeUndefined();
  });
});
