// Runs the ToolSettings conformance suite against FakeToolSettings.
import { runToolSettingsConformance } from "../conformance/tool-settings";
import { FakeToolSettings } from "../fakes/tool-settings";

runToolSettingsConformance(() => new FakeToolSettings());
