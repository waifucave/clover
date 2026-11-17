// The tool setting's conformance suite (contracts/conformance/tool-settings.ts) against the engine's real store, which keeps
// its values in the settings (`settings.mcp.toolAvailability` and the connector permission table).
import { runToolSettingsConformance } from "../../src/contracts/conformance/tool-settings";
import { EngineToolSettings } from "../../src/approvals/tool-settings";
import type { Settings } from "../../src/settings";

runToolSettingsConformance(() => {
  let settings = {} as Settings;
  return new EngineToolSettings({ read: () => settings, load: () => settings, save: (next) => { settings = next; } });
});
