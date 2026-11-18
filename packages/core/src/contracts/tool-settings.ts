// Contract: ToolSettings (spec revision 19, §6.7 "The user sets each plugin tool off, on demand or always on", §6.8, §9.3;
// item 103, G10, R9). Owner: lane TS (the setting's engine half), beside lane A's per-tool permission.
//
// For each plugin tool, two values in one list: its availability (`off`, `on-demand`, `always`) and its permission
// (`deny`, `ask`, `allow`). Not the engine's built-in shell and file tools.
//
// What the contract promises:
// * With no value stored, a tool's availability is what its server declares (`defaultAvailability`: `preload` is always
//   on, `on-demand` on demand) and its permission is `ask`.
// * Setting a whole server (no tool named) sets every tool it lists now; a tool it adds later starts at its own
//   declared default, not at the server-wide value.
// * The two values are independent: `deny` still lists the tool (a call is refused with no card), `off` hides it.
// * `exposure` is what a session gets: `off` is `hidden`; `always` is `preloaded`; `on-demand` is `glossary` (bots and
//   MOSS's own agent, and an ACP agent with no tool search of its own, through the bridge's Glossary) or `agent-search`
//   (an ACP agent's own tool search, when it has one). An agent with neither (`holdsBack: false`: no search, and a tool list
//   that cannot change in a session) is given the tool `preloaded`: nothing can hold it back (agents/exposure.ts).
import type { ToolAvailability } from "@waifucave/moss-protocol";
import type { Unsubscribe } from "./common";

export type ToolPermission = "allow" | "ask" | "deny";

export interface ToolSettingRow {
  server: string;
  tool: string;
  declared: "preload" | "on-demand";
  availability: ToolAvailability;
  permission: ToolPermission;
}

export type ToolExposure = "preloaded" | "glossary" | "agent-search" | "hidden";

export interface ToolSettings {
  /** The registry's word on what a server lists now and how each tool is declared. */
  declare(server: string, tools: Record<string, "preload" | "on-demand">): void;
  list(): ToolSettingRow[];
  row(server: string, tool: string): ToolSettingRow | undefined;
  setAvailability(server: string, tool: string | undefined, availability: ToolAvailability): void;
  setPermission(server: string, tool: string | undefined, permission: ToolPermission): void;
  exposure(server: string, tool: string, to: { agent?: { toolSearch: boolean; holdsBack?: boolean } }): ToolExposure;
  watch(fn: (row: ToolSettingRow) => void): Unsubscribe;
}
