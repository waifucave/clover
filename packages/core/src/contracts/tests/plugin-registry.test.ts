// Runs the PluginRegistry conformance suite against FakePluginRegistry, with the plugin SDK's catalog, and checks the
// contract's unique fields against that catalog.
import { describe, expect, test } from "bun:test";
import { catalogPointDecl } from "../../../../plugin-sdk/src/catalogs/index";
import { CORE_POINTS } from "../../../../plugin-sdk/src/catalogs/points";
import { runPluginRegistryConformance } from "../conformance/plugin-registry";
import { FakePluginRegistry } from "../fakes/plugin-registry";
import { UNIQUE_ENTRY_FIELD } from "../plugin-registry";

runPluginRegistryConformance((opts) => new FakePluginRegistry({ catalog: catalogPointDecl, ...opts }));

describe("the plugin SDK's catalog", () => {
  test("the unique fields agree with the plugin SDK's catalog", () => {
    const fromCatalog = Object.fromEntries(CORE_POINTS.filter((p) => p.uniqueBy && p.name !== "commands").map((p) => [p.name, p.uniqueBy]));
    expect(UNIQUE_ENTRY_FIELD).toEqual(fromCatalog);
  });
});
