// The bot side's one `SessionGrants` (R10), which the daemon hands to the browser too: a grant the user gave for one
// session is the one every reader sees, and only their own yes on the card grants it.
import { afterEach, describe, expect, test } from "bun:test";
import type { ApprovalDecision, ApprovalRequest } from "../../contracts/approval-broker";
import { flush } from "../../contracts/fakes/clock";
import { personsBrowserCard, personsBrowserGrants } from "../../browser/service";
import { USER_BROWSER_PARTITION_GRANT } from "../../sessions/grants";
import { ALPHA_FOLDER, boot, pluginFromFolder, removeTemps, tempDir } from "./fixtures";

afterEach(() => removeTemps());

describe("the bot side's SessionGrants", () => {
  test("one instance over the side's host: the browser's port grants on the person's card, and the side sees it", async () => {
    const asked: ApprovalRequest[] = [];
    let answer: ApprovalDecision = { allowed: true, by: "level" };
    const approvals = { request: async (req: ApprovalRequest) => (asked.push(req), answer) };
    const b = await boot({ home: tempDir(), plugins: (await pluginFromFolder(ALPHA_FOLDER, { bundled: true })).inputs, approvals: approvals as never });
    const grants = b.side.grants!;
    expect(grants).toBeDefined();
    const browser = personsBrowserGrants(grants);
    // A yes that isn't the person's own on the card grants nothing.
    expect(await browser.ensure("b_alpha", personsBrowserCard("Studio"))).toBe(false);
    expect(grants.has("b_alpha", USER_BROWSER_PARTITION_GRANT)).toBe(false);
    answer = { allowed: true, by: "card", cardId: "card_1" };
    expect(await browser.ensure("b_alpha", personsBrowserCard("Studio"))).toBe(true);
    await flush();
    // The same instance: the bot side and the browser read the one grant, and it isn't asked again.
    expect(grants.has("b_alpha", USER_BROWSER_PARTITION_GRANT)).toBe(true);
    expect(browser.has("b_alpha")).toBe(true);
    expect(await browser.ensure("b_alpha", personsBrowserCard("Studio"))).toBe(true);
    expect(asked).toHaveLength(2);
    expect(asked[1]).toMatchObject({ kind: "confirm", session: "b_alpha", bot: "alpha" });
    await b.shutdown();
  });

  test("no grants without a broker that can ask", async () => {
    const b = await boot({ home: tempDir(), plugins: (await pluginFromFolder(ALPHA_FOLDER, { bundled: true })).inputs });
    expect(b.side.grants).toBeUndefined();
    await b.shutdown();
  });
});
