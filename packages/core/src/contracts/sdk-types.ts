// The plugin SDK's types the contracts use, re-exported from its source. Type-only, so nothing here exists at run time.
//
// Why a relative path: `@waifucave/clover-core` doesn't declare `@waifucave/clover-plugin-sdk` as a dependency yet, and
// under Bun's isolated linker an undeclared package doesn't resolve. Adding `"@waifucave/clover-plugin-sdk":
// "workspace:*"` to core's package.json is a root change for the controller (B-M0's report); this file then imports
// from the package name instead, and nothing else changes.
export type {
  AgentBackend as AgentBackendEntry, Bot as BotEntry, Command as CommandEntry, CoreEntries, Hook as HookEntry,
  Manifest, McpServer as McpServerEntry, Model as ModelEntry, PointDecl, Trigger as TriggerEntry, Ui as UiEntry,
} from "../../../plugin-sdk/src/manifest/types";
export type {
  Handler, HandlerContext, HostModule, McpServerTransport, PluginApi,
} from "../../../plugin-sdk/src/api/plugin-api";
