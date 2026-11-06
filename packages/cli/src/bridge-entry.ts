// `clover-core bridge`: the agents' MCP bridge (K-M1, packages/core/src/agents/bridge/), the stdio server an ACP agent
// starts as a child of its own. `bridgeCommand()` hands agents this form in the compiled daemon. Kept apart from
// main.ts's imports, so the CLI loads the bridge only when it is the bridge.
export { bridgeMain } from "../../core/src/agents/bridge/main";
