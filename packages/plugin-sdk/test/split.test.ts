// The split's catalog pieces (spec revision 19, §3.6, G4 to G6, item 115): reads by kind with their OK lines, the
// families by kind that gate the activity feed and live pictures, the manifest's `picture` and its OK line, and the
// calls no side serves yet.
import { describe, expect, test } from "bun:test";
import { API_CALLS, CAPABILITIES, PICTURE_OK_LINE, apiCallAllowed, capabilityOkText, describeOk, validateManifest } from "../src/index";

describe("reads by kind (G6)", () => {
  test("code sessions and bots are separate capabilities, each with its own line; pictures warn", () => {
    expect(capabilityOkText("sessions.read")).toBe("reads your code sessions");
    expect(capabilityOkText("activity.read.bots")).toBe("follows what all your bots are doing: their names, their states and which tool they are using, never their words");
    expect(capabilityOkText("activity.read.sessions")).toBe("follows what your code sessions are doing: their titles, their states and which tool they are using");
    for (const kind of ["sessions", "bots"]) {
      const c = CAPABILITIES.find((x) => x.name === `picture.read.${kind}`)!;
      expect(c.warns).toBe(true);
      expect(c.ok).toContain("which can include your own screen and pages you are signed in to");
    }
    // The families stay before call:, network:public and network:<host>.
    expect(CAPABILITIES.slice(-3).map((c) => c.name)).toEqual(["call:<plugin-id>", "network:public", "network:<host>"]);
  });

  test("a family by kind gates by the kind the call reaches, and refuses a call with no kind", () => {
    expect(apiCallAllowed("activity.list", "shared", ["activity.read.bots"], { kind: "bots" })).toBe(true);
    expect(apiCallAllowed("activity.list", "shared", ["activity.read.bots"], { kind: "sessions" })).toBe(false);
    expect(apiCallAllowed("activity.list", "shared", ["activity.read.bots"])).toBe(false);
    expect(apiCallAllowed("pictures.open", "ui", ["picture.read.sessions"], { kind: "sessions" })).toBe(true);
    expect(apiCallAllowed("sessions.history", "ui", ["conversation.read"])).toBe(false);
    expect(apiCallAllowed("sessions.history", "ui", ["sessions.read"])).toBe(true);
  });

  test("every call of the split is listed and served (none is marked not-yet-served)", () => {
    const split = Object.entries(API_CALLS).filter(([k]) => /^(sessions|activity|pictures)\./.test(k));
    expect(split.map(([k]) => k).sort()).toEqual([
      "activity.list", "activity.watch", "pictures.list", "pictures.open", "pictures.publish", "pictures.watch",
      "sessions.follow", "sessions.get", "sessions.history", "sessions.list", "sessions.watch",
    ]);
    for (const [, info] of split) expect((info as { notYet?: string }).notYet).toBeUndefined();
    expect(API_CALLS["pictures.publish"]).toMatchObject({ where: "host" });
  });
});

describe("a tool's live picture in the manifest (G5, item 115)", () => {
  const manifest = (server: Record<string, unknown>) => validateManifest(
    { manifest: 1, id: "acme-cu", name: "Acme", engines: { moss: "^1.0.0" }, host: { entry: "host/index.ts" }, contributes: { mcpServers: { cu: { tools: { Click: "preload" }, ...server } } } },
    { folderName: "acme-cu" },
  );

  test("a host server that publishes one is named on the OK card in the spec's words", () => {
    const r = manifest({ type: "host", picture: true });
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(r.pictureServers).toEqual(["cu"]);
    expect(describeOk(r)).toContain(PICTURE_OK_LINE);
    expect(PICTURE_OK_LINE).toBe("It shows a live picture of what it is doing.");
  });

  test("a stdio server can't publish one; a plugin without the field gets no line", () => {
    const stdio = manifest({ type: "stdio", command: "acme-cu", picture: true });
    expect(stdio.issues.some((i) => i.severity === "error" && i.code === "picture_not_host")).toBe(true);
    const none = manifest({ type: "host" });
    expect(none.pictureServers).toBeUndefined();
    expect(describeOk(none)).not.toContain(PICTURE_OK_LINE);
  });
});
