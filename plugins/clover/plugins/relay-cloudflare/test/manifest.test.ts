// clover.json against lane B's validator, and the host half's handler against B's RelayHandler type.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { type RelayHandler, validateManifest } from "@waifucave/clover-plugin-sdk";

import * as host from "../host/index";

// A compile-time check: the `relays` entry's handler is lane B's RelayHandler.
host.relay satisfies Omit<RelayHandler, "serve">;

const root = join(import.meta.dir, "..");

describe("clover.json", () => {
  test("is valid for lane B's validator, as a bundled child of clover", () => {
    const report = validateManifest(readFileSync(join(root, "clover.json"), "utf8"), { parent: { id: "clover", namespace: "clover" }, bundled: true, folderName: "relay-cloudflare" });
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
  });

  test("its relays entry names a handler the host half exports", () => {
    const manifest = JSON.parse(readFileSync(join(root, "clover.json"), "utf8")) as { contributes: { relays: { handler: string }[] }; auth: { secret: string }[] };
    for (const entry of manifest.contributes.relays) expect(typeof (host as Record<string, unknown>)[entry.handler]).toBe("object");
    expect(manifest.auth.map((a) => a.secret)).toEqual(["relay-key"]);
  });
});
