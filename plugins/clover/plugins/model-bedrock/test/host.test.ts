// clover/model-bedrock: its handler describes the adapter its catalog file names, and serves exactly this plugin's rows.
import { describe, expect, test } from "bun:test";
import catalogFile from "../catalog.json" with { type: "json" };
import { adapter, ENTRY, modelAdapter } from "../host/index";

describe("clover/model-bedrock", () => {
  test("describes the adapter its catalog file names, on interface 1", () => {
    const d = adapter.describe();
    expect(d.interfaceVersion).toBe(1);
    expect(d.id).toBe(catalogFile.provider.adapterId);
    expect(d.family).toBe(modelAdapter.family);
    expect(ENTRY.provider).toBe("bedrock");
  });

  test("its rows are its provider's, and the adapter reads its capabilities from them", () => {
    expect(catalogFile.rows.length).toBeGreaterThan(0);
    for (const row of catalogFile.rows) expect(row.providerId).toBe("bedrock");
    const row = catalogFile.rows[0] as never;
    expect(["native", "emulated", "none"]).toContain(modelAdapter.capabilities(row).toolCalling);
  });
});
