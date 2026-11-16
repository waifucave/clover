// The split's pure rules (spec revision 19): reads by kind, the release's standings, where a press may come from, who may
// edit a bot's instructions, the programs' identities and the mount lists.
import { describe, expect, test } from "bun:test";
import {
  MOSS_METHODS, PROGRAM_IDENTIFIERS, SURFACE_MOUNTS, compareReleases, defaultAvailability, instructionsEditRule, isKindFamily,
  kindCapability, pluginMayCall, pressMatchesPlacement, programAnswerKeyStatement, programCardAnswerSigningInput, programOfIdentifier,
  releaseStanding, grantReadsBots, cardAnswerSigningInput,
} from "../src/index";

describe("reads by kind (§3.6)", () => {
  test("one mapping for every family, the conversation pair included", () => {
    expect(kindCapability("activity.read.*", "bots")).toBe("activity.read.bots");
    expect(kindCapability("picture.read.*", "sessions")).toBe("picture.read.sessions");
    expect(kindCapability("conversation.*", "sessions")).toBe("sessions.read");
    expect(kindCapability("conversation.*", "bots")).toBe("conversation.read");
    expect([isKindFamily("activity.read.*"), isKindFamily("call:*"), isKindFamily("network:*"), isKindFamily("bots.read")]).toEqual([true, false, false, false]);
  });

  test("a method gated by a family: the kind it reaches decides; none refuses (session.history re-gated by kind, as lane AF will)", () => {
    const history = { ...MOSS_METHODS.get("session.history")!, capability: "conversation.*" };
    expect(pluginMayCall(history, ["sessions.read"], "sessions")).toBe(true);
    expect(pluginMayCall(history, ["conversation.read"], "sessions")).toBe(false);
    expect(pluginMayCall(history, ["conversation.read"], "bots")).toBe(true);
    expect(pluginMayCall(history, ["conversation.read", "sessions.read"])).toBe(false);
    const feed = MOSS_METHODS.get("activity.list")!;
    expect(pluginMayCall(feed, ["activity.read.bots"], "bots")).toBe(true);
    expect(pluginMayCall(feed, ["activity.read.bots"], "sessions")).toBe(false);
  });

  test("a conversation.read OK'd before revision 19 reads no bot's conversation until the plugin asks again", () => {
    expect([grantReadsBots(undefined), grantReadsBots(18), grantReadsBots(19)]).toEqual([false, false, true]);
  });
});

describe("one release (§3.1)", () => {
  test("releases order as semver, a prerelease before its release", () => {
    expect(releaseStanding("1.111.1", "1.111.1")).toBe("same");
    expect(releaseStanding("1.111.1", "1.111.0")).toBe("behind");
    expect(releaseStanding("1.111.1", "1.112.0")).toBe("ahead");
    expect(compareReleases("1.111.1-rc.1", "1.111.1")).toBeLessThan(0);
    expect(compareReleases("1.111.1+build.7", "1.111.1")).toBe(0);
    expect(() => compareReleases("one", "1.0.0")).toThrow();
  });
});

describe("where a card is drawn and answered (§3.5, ruling C)", () => {
  test("a press counts only from the place the router chose", () => {
    const strip = { kind: "strip", program: "code", window: "main" } as const;
    expect(pressMatchesPlacement(strip, { kind: "window", program: "code", window: "main" })).toBe(true);
    expect(pressMatchesPlacement(strip, { kind: "window", program: "moss", window: "main" })).toBe(false);
    expect(pressMatchesPlacement(strip, { kind: "island" })).toBe(false);
    expect(pressMatchesPlacement({ kind: "island" }, { kind: "island" })).toBe(true);
    expect(pressMatchesPlacement({ kind: "elsewhere" }, { kind: "island" })).toBe(false);
  });

  test("a program's statements name the program, and differ from the single key's", () => {
    expect(programAnswerKeyStatement({ device: "d1", program: "host", publicKey: "k", held: "app-keychain" })).toBe("moss/program-answer-key/1\nd1\nhost\nk\napp-keychain\ned25519");
    const card = { id: "card_abcdef", hash: "00", option: "approve", at: 5 };
    expect(programCardAnswerSigningInput({ program: "moss", ...card })).toBe("moss/card-answer/3\nmoss\ncard_abcdef\n00\napprove\n5\n");
    expect(programCardAnswerSigningInput({ program: "moss", ...card })).not.toBe(cardAnswerSigningInput(card));
  });

  test("the three programs' identities, dist and dev", () => {
    expect(programOfIdentifier("com.waifucave.moss.host", "dist")).toBe("host");
    expect(programOfIdentifier("com.waifucave.moss.code.dev", "dev")).toBe("code");
    expect(programOfIdentifier("com.waifucave.moss.code.dev", "dist")).toBeUndefined();
    expect(programOfIdentifier("com.waifucave.moss.core", "dist")).toBeUndefined();
    expect(Object.keys(PROGRAM_IDENTIFIERS).sort()).toEqual(["code", "host", "moss"]);
  });

  test("mount lists: MOSS mounts nothing from plugins, the host the screen and the browser's pages", () => {
    expect(SURFACE_MOUNTS.moss.points).toEqual([]);
    expect(SURFACE_MOUNTS.host.browserPages).toBe(true);
    expect(SURFACE_MOUNTS.code.points).not.toContain("app.surface");
    for (const s of ["moss", "code", "host"] as const) expect(SURFACE_MOUNTS[s].drawsCards).toBe(true);
  });
});

describe("bots and tools as engine data (§6.1, §6.7)", () => {
  test("instructions: the bot and its maker freely, another bot by card, a session that is no bot's never", () => {
    const scout = { id: "scout", madeBy: { kind: "bot" as const, id: "alpha" } };
    expect(instructionsEditRule({ kind: "bot", id: "scout" }, scout)).toBe("free");
    expect(instructionsEditRule({ kind: "bot", id: "alpha" }, scout)).toBe("free");
    expect(instructionsEditRule({ kind: "bot", id: "nova" }, scout)).toBe("card");
    expect(instructionsEditRule({ kind: "other" }, scout)).toBe("refused");
    expect(instructionsEditRule({ kind: "user" }, { id: "alpha", madeBy: { kind: "default" } })).toBe("free");
  });

  test("a tool's default availability is what its plugin declares", () => {
    expect([defaultAvailability("preload"), defaultAvailability("on-demand")]).toEqual(["always", "on-demand"]);
  });
});
