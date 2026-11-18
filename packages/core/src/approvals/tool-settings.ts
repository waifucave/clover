// The tool setting (spec revision 19, §6.7 "The user sets each plugin tool off, on demand or always on", G10; the contract is
// `contracts/tool-settings.ts`). Per plugin tool, beside the permission (always allow, ask, always block), in one list:
//
//   * AVAILABILITY decides whether a model is OFFERED the tool: `off` (no model is offered it, and a call to it is refused),
//     `on-demand` (behind `Glossary`, or an ACP agent's own tool search), `always` (preloaded). With nothing stored it is
//     what the plugin declares (`defaultAvailability`: `preload` is always on, `on-demand` is on demand).
//   * PERMISSION decides whether a CALL raises a card (`approvals/tool-permissions.ts`).
//
// Where the choice lives: `settings.mcp.toolAvailability` (server → tool → value), ONLY what the user chose, so a plugin's
// update that changes its declaration moves every tool the user never touched, and never one they did. `PluginMcp` reads it
// through `availabilityOf` and is the one place the offered list is built from it (`turn-loop/plugin-mcp.ts` `servers`).
//
// Who sets it: only the user's own client (`tool.setAvailability` is `userOnly`; the handler refuses every other caller),
// so a plugin, a bot or an agent can never raise its own tool's availability.
import { defaultAvailability, ToolAvailability } from "@waifucave/moss-protocol";
import { ContractError, Listeners, type Unsubscribe } from "../contracts/common";
import type { ToolExposure, ToolPermission, ToolSettingRow, ToolSettings } from "../contracts/tool-settings";
import { connectorPermissionTable, setConnectorToolPermission, type Settings } from "../settings";

export type Declared = "preload" | "on-demand";

/** What the tool setting says about one server: the key a model sees it under, and its plugin. */
export interface ListedServer {
  server: string;
  plugin?: string;
  tools: readonly { name: string; declared?: Declared }[];
}

export interface ToolSettingsEvent {
  type: "tool_settings_changed";
  server: string;
  tool?: string;
  permission?: ToolPermission;
  availability?: ToolAvailability;
}

export interface EngineToolSettingsDeps {
  /** The live settings, for the hot reads (the daemon's in-memory copy, which the watcher swaps). */
  read(): Settings | null | undefined;
  /** The settings as the file has them now, for a write. */
  load(): Settings;
  /** Saves the settings and tells every live reader (the connector source's `noteWritten`). */
  save(next: Settings): void;
  /** Every server and tool a plugin lists now (`PluginMcp.toolListing`). */
  listing?(): readonly ListedServer[];
  emit?(event: ToolSettingsEvent): void;
}

/** What the tool setting and the permission read of a settings: the part a write changes and a model's list depends on. */
function slice(settings: Settings | null | undefined): string {
  return JSON.stringify([(settings?.mcp as Extra | undefined)?.toolAvailability ?? null, connectorPermissionTable(settings)]);
}

type Extra = { toolsSeen?: Record<string, string[]>; toolsOwner?: Record<string, string>; toolAvailability?: Record<string, unknown> };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The value stored for one tool, or undefined (nothing stored, or a value that is none of the three). */
export function storedAvailability(settings: Settings | null | undefined, server: string, tool: string): ToolAvailability | undefined {
  const table = (settings?.mcp as Extra | undefined)?.toolAvailability;
  if (!isRecord(table) || !Object.hasOwn(table, server)) return undefined;
  const row = table[server];
  if (!isRecord(row) || !Object.hasOwn(row, tool)) return undefined;
  const parsed = ToolAvailability.safeParse(row[tool]);
  return parsed.success ? parsed.data : undefined;
}

/** `availability` in `settings.mcp.toolAvailability` for `tools` of `server`, a pure transform. */
function withAvailability(settings: Settings, server: string, tools: readonly string[], availability: ToolAvailability): Settings {
  const mcp = (settings.mcp ?? {}) as Extra;
  const table: Record<string, unknown> = { ...(isRecord(mcp.toolAvailability) ? mcp.toolAvailability : {}) };
  const row: Record<string, unknown> = { ...(isRecord(table[server]) ? table[server] as Record<string, unknown> : {}) };
  for (const t of tools) row[t] = availability;
  table[server] = row;
  return { ...settings, mcp: { ...(settings.mcp ?? {}), toolAvailability: table } } as Settings;
}

/** The settings with the stored availability of `server`'s tools that `which` picks removed, or undefined when none was. */
export function clearToolAvailability(settings: Settings, server: string, which: (tool: string) => boolean): Settings | undefined {
  const mcp = settings.mcp as Extra | undefined;
  const table = mcp?.toolAvailability;
  if (!isRecord(table) || !isRecord(table[server])) return undefined;
  const row = { ...(table[server] as Record<string, unknown>) };
  let changed = false;
  for (const tool of Object.keys(row)) if (which(tool)) { delete row[tool]; changed = true; }
  if (!changed) return undefined;
  const next = { ...table };
  if (Object.keys(row).length === 0) delete next[server];
  else next[server] = row;
  const { toolAvailability: _was, ...rest } = (settings.mcp ?? {}) as Extra & Record<string, unknown>;
  return { ...settings, mcp: Object.keys(next).length === 0 ? rest : { ...rest, toolAvailability: next } } as Settings;
}

/** The stored availability of any tool, for callers that hold only the settings (`PluginMcp`'s option). */
export const availabilityOfAny = storedAvailability;

/** The settings with `permission` set for `tool` (or every tool `listed` names now) and what the plugin lists now recorded:
 *  a tool it adds later is new and keeps Ask. Values for tools it no longer lists go. */
export function withToolPermission(settings: Settings, listed: { server: string; plugin?: string; names: readonly string[] }, tool: string | undefined, permission: ToolPermission): Settings {
  let next = settings;
  const row = connectorPermissionTable(next)[listed.server] ?? {};
  for (const stale of Object.keys(row)) if (!listed.names.includes(stale)) next = setConnectorToolPermission(next, listed.server, stale, undefined);
  for (const name of tool === undefined ? listed.names : [tool]) next = setConnectorToolPermission(next, listed.server, name, permission === "ask" ? undefined : permission);
  const mcp = next.mcp as Extra | undefined;
  const seen = { ...(mcp?.toolsSeen ?? {}), [listed.server]: [...listed.names] };
  const owner = listed.plugin === undefined ? { ...(mcp?.toolsOwner ?? {}) } : { ...(mcp?.toolsOwner ?? {}), [listed.server]: listed.plugin };
  return { ...next, mcp: { ...(next.mcp ?? {}), toolsSeen: seen, toolsOwner: owner } } as Settings;
}

/** What a call to a tool the user turned off is told: "turned off", never "blocked" (two different settings). */
export function toolOffMessage(tool: string): string {
  return `The user turned the tool ${tool} off in Settings, so it isn't available. Do not retry it; tell the user if you need it.`;
}

/** The real `ToolSettings`: reads and writes `settings.mcp`, and tells the daemon's event stream. */
export class EngineToolSettings implements ToolSettings {
  readonly #d: EngineToolSettingsDeps;
  readonly #declared = new Map<string, Record<string, Declared>>();
  readonly #listeners = new Listeners<ToolSettingRow>();
  /** What a write just saved. It is read in place of the live settings until the live copy HAS CAUGHT UP to it (carries the
   *  same availability and permissions), not merely until the live copy changes: the watcher's reload of the file as it was a
   *  moment before the write can land after it, and a turn that started then would be offered the tool as it was before the
   *  user's press (found on the acceptance row: set on demand, send at once, the model's list still had the old value). */
  #written: { basis: Settings | null | undefined; settings: Settings; expected: string } | undefined;

  constructor(deps: EngineToolSettingsDeps) {
    this.#d = deps;
  }

  /** The live settings, or what a write of this store (or one told to it by `noteWritten`) saved while the live copy is
   *  behind it: the live copy is behind when it lacks the write and the FILE still has it (a reload of the file as it was
   *  before the write landing late). A file someone else has changed since is not ours to stand in for: the live copy then. */
  #now(): Settings | null | undefined {
    const live = this.#d.read();
    const w = this.#written;
    if (w === undefined) return live;
    if (live === w.basis) return w.settings;
    if (slice(live) !== w.expected) {
      let onDisk: string | undefined;
      try { onDisk = slice(this.#d.load()); } catch { onDisk = undefined; }
      if (onDisk === w.expected) return w.settings;
    }
    this.#written = undefined;
    return live;
  }

  /** A write made elsewhere (a plugin dropped, its tools pruned): the daemon tells the store, which reads it until the live copy has it. */
  noteWritten(next: Settings): void {
    this.#written = { basis: this.#d.read(), settings: next, expected: slice(next) };
  }

  #servers(): ListedServer[] {
    const out = new Map<string, ListedServer>();
    for (const l of this.#d.listing?.() ?? []) out.set(l.server, l);
    for (const [server, tools] of this.#declared) {
      if (out.has(server)) continue;
      out.set(server, { server, tools: Object.entries(tools).map(([name, declared]) => ({ name, declared })) });
    }
    return [...out.values()];
  }

  /** `declare` is the registry's word on a server the listing doesn't carry (tests); a listed server's own listing wins. */
  declare(server: string, tools: Record<string, Declared>): void {
    this.#declared.set(server, { ...tools });
  }

  /** What is stored for one tool: undefined when the user chose nothing. This is the one input `PluginMcp` reads. */
  availabilityOf(server: string, tool: string): ToolAvailability | undefined {
    return storedAvailability(this.#now(), server, tool);
  }

  /** The value a model is offered the tool by, from what the plugin declares when nothing is stored. */
  effective(server: string, tool: string, declared: Declared): ToolAvailability {
    return this.availabilityOf(server, tool) ?? defaultAvailability(declared);
  }

  #row(l: ListedServer, tool: string): ToolSettingRow | undefined {
    const t = l.tools.find((x) => x.name === tool);
    if (t === undefined) return undefined;
    const declared = t.declared ?? "on-demand";
    const stored = connectorPermissionTable(this.#now())[l.server]?.[tool];
    return { server: l.server, tool, declared, availability: this.effective(l.server, tool, declared), permission: stored ?? "ask" };
  }

  row(server: string, tool: string): ToolSettingRow | undefined {
    const l = this.#servers().find((x) => x.server === server);
    return l === undefined ? undefined : this.#row(l, tool);
  }

  list(): ToolSettingRow[] {
    return this.#servers().flatMap((l) => l.tools.map((t) => t.name).sort().map((tool) => this.#row(l, tool)!));
  }

  #target(server: string, tool: string | undefined): { listed: ListedServer; tools: string[] } {
    const listed = this.#servers().find((x) => x.server === server);
    if (listed === undefined) throw new ContractError("not_found", `no plugin server ${server}`);
    const names = listed.tools.map((t) => t.name);
    if (tool === undefined) return { listed, tools: names };
    if (tool === "*" || !names.includes(tool)) throw new ContractError("not_found", `${server} lists no tool ${tool}`);
    return { listed, tools: [tool] };
  }

  #owned(settings: Settings, listed: ListedServer): Settings {
    if (listed.plugin === undefined) return settings;
    const mcp = settings.mcp as Extra | undefined;
    return { ...settings, mcp: { ...(settings.mcp ?? {}), toolsOwner: { ...(mcp?.toolsOwner ?? {}), [listed.server]: listed.plugin } } } as Settings;
  }

  #saved(next: Settings): void {
    this.#d.save(next);
    this.noteWritten(next);
  }

  setAvailability(server: string, tool: string | undefined, availability: ToolAvailability): void {
    const { listed, tools } = this.#target(server, tool);
    // Stale values for tools the plugin no longer lists go with this write.
    const names = new Set(listed.tools.map((t) => t.name));
    let next = clearToolAvailability(this.#d.load(), server, (t) => !names.has(t)) ?? this.#d.load();
    next = this.#owned(withAvailability(next, server, tools, availability), listed);
    this.#saved(next);
    for (const t of tools) this.#listeners.emit(this.#row(listed, t)!);
    this.#d.emit?.({ type: "tool_settings_changed", server, ...(tool === undefined ? {} : { tool }), availability });
  }

  setPermission(server: string, tool: string | undefined, permission: ToolPermission): void {
    const { listed, tools } = this.#target(server, tool);
    const next = withToolPermission(this.#d.load(), { server, ...(listed.plugin === undefined ? {} : { plugin: listed.plugin }), names: listed.tools.map((t) => t.name) }, tool, permission);
    this.#saved(next);
    for (const t of tools) this.#listeners.emit(this.#row(listed, t)!);
    this.#d.emit?.({ type: "tool_settings_changed", server, ...(tool === undefined ? {} : { tool }), permission });
  }

  exposure(server: string, tool: string, to: { agent?: { toolSearch: boolean; holdsBack?: boolean } }): ToolExposure {
    const r = this.row(server, tool);
    if (r === undefined || r.availability === "off") return "hidden";
    if (r.availability === "always") return "preloaded";
    if (to.agent?.toolSearch === true) return "agent-search";
    // An agent that can neither search nor take a changed list has nothing to hold the tool back with: it is offered from the start.
    return to.agent?.holdsBack === false ? "preloaded" : "glossary";
  }

  watch(fn: (row: ToolSettingRow) => void): Unsubscribe {
    return this.#listeners.add(fn);
  }
}
