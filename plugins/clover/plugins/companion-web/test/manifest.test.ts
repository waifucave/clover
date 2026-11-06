// clover.json against lane B's validator, and the host half's handler against B's CompanionHandler type.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { type CompanionHandler, validateManifest } from "@waifucave/clover-plugin-sdk";

import * as host from "../host/index";

// A compile-time check: the `companions` entry's handler is lane B's CompanionHandler.
host.companion satisfies CompanionHandler;

const root = join(import.meta.dir, "..");

describe("clover.json", () => {
  test("is valid for lane B's validator, as a bundled child of clover", () => {
    const report = validateManifest(readFileSync(join(root, "clover.json"), "utf8"), { parent: { id: "clover", namespace: "clover" }, bundled: true, folderName: "companion-web" });
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
  });

  test("its companions entry names a handler the host half exports, and it runs on the main", () => {
    const manifest = JSON.parse(readFileSync(join(root, "clover.json"), "utf8")) as { host: { start: string }; contributes: { companions: { handler: string }[] } };
    for (const entry of manifest.contributes.companions) expect(typeof (host as Record<string, unknown>)[entry.handler]).toBe("object");
    expect(manifest.host.start).toBe("main");
  });
});
