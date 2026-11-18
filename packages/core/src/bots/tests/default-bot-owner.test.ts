// The default bot (Alpha) is answered as owned by the plugin `alpha` only while that plugin is MOSS's own bundled one, which
// still serves her room tools. A different plugin that takes the top id `alpha` after hers is removed gets nothing of her.
import { afterEach, describe, expect, test } from "bun:test";
import { botOwnerPlugin } from "../../runtime-sdk/turn-loop/only-backends";
import { ALPHA_FOLDER, boot, pluginFromFolder, removeTemps, tempDir } from "./fixtures";

afterEach(removeTemps);

describe("whose bot the default bot is (own-bot)", () => {
  test("the bundled alpha plugin owns her; a plugin with her id that is not the bundled one owns nothing of her; none installed, none", async () => {
    const bundled = await pluginFromFolder(ALPHA_FOLDER, { bundled: true });
    const a = await boot({ home: tempDir(), plugins: bundled.inputs, botSource: "records", defaultBot: true, modelOffer: () => "offered" });
    expect(a.bots.has("alpha")).toBe(true);
    expect(botOwnerPlugin("alpha")).toBe("alpha");
    await a.shutdown();

    const stranger = await pluginFromFolder(ALPHA_FOLDER);
    const b = await boot({ home: tempDir(), plugins: stranger.inputs, botSource: "records", defaultBot: true, modelOffer: () => "offered" });
    expect(b.bots.has("alpha")).toBe(true);
    expect(botOwnerPlugin("alpha")).toBeUndefined();
    await b.shutdown();

    const c = await boot({ home: tempDir(), plugins: [], botSource: "records", defaultBot: true, modelOffer: () => "offered" });
    expect(botOwnerPlugin("alpha")).toBeUndefined();
    await c.shutdown();
  });
});
