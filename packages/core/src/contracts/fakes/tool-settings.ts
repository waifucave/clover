// FakeToolSettings: the tool setting and the permission beside it, in memory.
import { defaultAvailability, type ToolAvailability } from "@waifucave/moss-protocol";
import { ContractError, Listeners, type Unsubscribe } from "../common";
import type { ToolExposure, ToolPermission, ToolSettingRow, ToolSettings } from "../tool-settings";

export class FakeToolSettings implements ToolSettings {
  readonly #declared = new Map<string, Record<string, "preload" | "on-demand">>();
  readonly #availability = new Map<string, ToolAvailability>();
  readonly #permission = new Map<string, ToolPermission>();
  readonly #listeners = new Listeners<ToolSettingRow>();

  declare(server: string, tools: Record<string, "preload" | "on-demand">): void {
    this.#declared.set(server, { ...tools });
  }

  row(server: string, tool: string): ToolSettingRow | undefined {
    const declared = this.#declared.get(server)?.[tool];
    if (declared === undefined) return undefined;
    const k = `${server}\0${tool}`;
    return { server, tool, declared, availability: this.#availability.get(k) ?? defaultAvailability(declared), permission: this.#permission.get(k) ?? "ask" };
  }

  list(): ToolSettingRow[] {
    return [...this.#declared].flatMap(([server, tools]) => Object.keys(tools).sort().map((tool) => this.row(server, tool)!));
  }

  #tools(server: string, tool: string | undefined): string[] {
    const tools = this.#declared.get(server);
    if (!tools) throw new ContractError("not_found", `no plugin server ${server}`);
    if (tool === undefined) return Object.keys(tools);
    if (!(tool in tools)) throw new ContractError("not_found", `${server} lists no tool ${tool}`);
    return [tool];
  }

  setAvailability(server: string, tool: string | undefined, availability: ToolAvailability): void {
    for (const t of this.#tools(server, tool)) {
      this.#availability.set(`${server}\0${t}`, availability);
      this.#listeners.emit(this.row(server, t)!);
    }
  }

  setPermission(server: string, tool: string | undefined, permission: ToolPermission): void {
    for (const t of this.#tools(server, tool)) {
      this.#permission.set(`${server}\0${t}`, permission);
      this.#listeners.emit(this.row(server, t)!);
    }
  }

  exposure(server: string, tool: string, to: { agent?: { toolSearch: boolean; holdsBack?: boolean } }): ToolExposure {
    const r = this.row(server, tool);
    if (!r || r.availability === "off") return "hidden";
    if (r.availability === "always") return "preloaded";
    if (to.agent?.toolSearch === true) return "agent-search";
    // An agent that can neither search nor take a changed list has nothing to hold the tool back with: it is offered from the start.
    return to.agent?.holdsBack === false ? "preloaded" : "glossary";
  }

  watch(fn: (row: ToolSettingRow) => void): Unsubscribe {
    return this.#listeners.add(fn);
  }
}
