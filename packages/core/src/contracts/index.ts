// The spine's core interfaces (plan §3), one file each, with their owners:
//
// | Contract          | Owner      | File                  |
// | :---------------- | :--------- | :-------------------- |
// | SecretStore       | C          | secret-store.ts       |
// | Fence             | C          | fence.ts              |
// | ApprovalBroker    | C (K signs off for agents) | approval-broker.ts |
// | PluginRegistry    | B          | plugin-registry.ts    |
// | PluginHost        | B          | plugin-host.ts        |
// | SessionHost       | D and A (K signs off for agents) | session-host.ts |
// | LinkTransport     | H          | link-transport.ts     |
// | DeviceRegistry    | H          | device-registry.ts    |
// | Lease             | H          | lease.ts              |
// | Clock             | H          | clock.ts              |
// | ComputerRegistry  | J          | computer-registry.ts  |
// | Tree              | J          | tree.ts               |
// | AgentBackend      | K          | agent-backend.ts      |
// | BrowserApi        | L          | browser-api.ts        |
//
// The UI API (lane E) is in the plugin SDK (`packages/plugin-sdk/src/api/ui-api.ts`). The fakes are in `./fakes`.
export * from "./common";
export * from "./clock";
export * from "./secret-store";
export * from "./fence";
export * from "./approval-broker";
export * from "./plugin-registry";
export * from "./plugin-host";
export * from "./session-host";
export * from "./link-transport";
export * from "./device-registry";
export * from "./lease";
export * from "./computer-registry";
export * from "./tree";
export * from "./agent-backend";
export * from "./browser-api";
