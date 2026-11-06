// The ACP backends plugins contribute (spec §5.3 `agentBackends`, the controller's alignment for K-M3): every backend is
// a plugin's entry, the bundled ones included (`plugins/clover/plugins/agent-<id>/`), and the core keeps only the ACP
// client, the manager, the OK and the sandbox logic. An entry names its quirks file (`quirks`), a JSON file in the
// plugin's folder holding the backend's `AgentQuirks`, its read-only mode where it acts without asking, and where the
// row comes from. A third-party plugin adds an ACP backend the same way and goes through the same OK.
//
// * Only `active` entries with `protocol: "acp"` become backends; a cloud agent with its own API is a plugin's handler
//   (none yet).
// * The quirks file is read from inside the plugin's folder only (no `..`, no absolute path, no link out of it) and
//   checked against the descriptor's shape; a file that fails leaves that backend out, with the reason logged.
// * The program is the entry's `command` and `args`, on every OS (what the plugin's OK covers); on Windows the PATH
//   lookup finds its `.exe` or `.cmd`. The file holds everything else about the backend.
// * What the core grants by backend id stays with Clover's own plugin: a sandbox admitted for `cursor` (S8) or Claude
//   Code's placement of plugin parts applies only when the entry is the bundled `clover/agent-<id>`, so another plugin
//   that takes the id once the bundled one is off gets neither.
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import type { AgentBackend, AgentQuirks } from "../contracts/agent-backend";
import type { PluginRegistry } from "../contracts/plugin-registry";

/** The bundled plugin that holds a backend's row: `clover/agent-<id>`. */
export const bundledAgentPluginId = (id: string): string => `clover/agent-${id}`;

const Strings = z.array(z.string().max(4096)).max(256);
const Mark = z.enum(["stores-plain-text", "passes-environment", "no-deny-list", "unsandboxed", "unasked-actions", "persists-model-choice"]);

/** `AgentQuirks` without its command (the manifest entry's), as a quirks file must hold it. */
export const AgentQuirksSchema = z.strictObject({
  launch: z.strictObject({
    identity: z.strictObject({ versionArgs: Strings, versionPattern: z.string().max(1024), signer: z.string().regex(/^[A-Z0-9]{10}$/).optional() }),
    envAllow: Strings,
    envSet: z.record(z.string().max(256), z.string().max(4096)),
    versions: z.string().max(256),
  }),
  capabilities: z.strictObject({ snakeCaseDuplicates: z.boolean(), httpMcpUnadvertised: z.boolean() }),
  mcp: z.strictObject({
    transports: z.array(z.enum(["stdio", "http", "sse"])).max(3),
    storesPlainText: z.boolean(),
    passesEnvironment: z.boolean(),
    instructionsReachPrompt: z.union([z.boolean(), z.literal("unknown")]),
    systemPromptChannel: z.enum(["_meta.antigravity.systemPrompt.append", "acp.systemPrompt", "_meta.systemPrompt"]).nullable(),
    tellsConversationId: z.boolean(),
  }),
  sessions: z.strictObject({
    load: z.strictObject({ supported: z.boolean(), replays: z.boolean() }),
    resume: z.strictObject({ supported: z.boolean(), replays: z.boolean() }),
    replayKeepsToolCallIds: z.boolean(),
    listFiltersHonestly: z.boolean(),
    close: z.boolean(),
  }),
  turns: z.strictObject({
    refusal: z.enum(["ends-turn", "reported-completed", "reported-failed", "unknown"]),
    cancelLeavesToolCallsOpen: z.boolean(),
    reportsUsage: z.boolean(),
    quotaErrorsAsText: z.boolean(),
  }),
  permissions: z.strictObject({
    optionKinds: z.array(z.enum(["allow_once", "allow_always", "reject_once", "reject_always"])).max(4),
    neverAsks: Strings,
    mcpNames: z.strictObject({ server: z.string().max(256), tool: z.string().max(256) }).nullable(),
  }),
  config: z.strictObject({ modelOption: z.string().max(128).nullable(), effortOption: z.string().max(128).nullable(), effortInModel: z.boolean(), choicePersists: z.boolean() }),
  auth: z.strictObject({
    methods: z.array(z.strictObject({ id: z.string().max(128), headless: z.boolean() })).max(16),
    requiredError: z.strictObject({ code: z.number().int().optional(), messagePattern: z.string().max(1024).optional() }),
  }),
  progress: z.strictObject({ countsChildProcesses: z.boolean() }),
  placement: z.enum(["local", "cloud"]),
  marks: z.array(Mark).max(16),
});

/** A quirks file: the descriptor, the read-only mode of an agent that acts without asking, and where the row comes from. */
export const QuirksFileSchema = z.strictObject({
  notes: z.string().max(8192).optional(),
  source: z.string().max(256),
  readOnlyMode: z.strictObject({ option: z.string().max(128), values: z.array(z.string().max(128)).min(1).max(8) }).optional(),
  quirks: AgentQuirksSchema,
});

/** A backend's quirks as its file holds them: everything but the command. */
export type FileQuirks = Omit<AgentQuirks, "launch"> & { launch: Omit<AgentQuirks["launch"], "command"> };

export interface QuirksFile {
  notes?: string;
  source: string;
  readOnlyMode?: { option: string; values: readonly string[] };
  quirks: FileQuirks;
}

/** The descriptor the client reads: the file's quirks with the entry's command, the same on every OS. */
export function quirksWithCommand(q: FileQuirks, command: { program: string; acpArgs: readonly string[] }): AgentQuirks {
  const argv = [command.program, ...command.acpArgs];
  return { ...q, launch: { ...q.launch, command: { macos: argv, linux: argv, windows: argv } } };
}

/** Reads and checks a quirks file inside a plugin's folder; throws with the reason. */
export function readQuirksFile(folder: string, path: string): QuirksFile {
  if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) throw new Error(`the quirks file ${JSON.stringify(path)} isn't a path inside the plugin`);
  const root = realpathSync(folder);
  const real = realpathSync(join(root, path));
  const rel = relative(root, real);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) throw new Error(`the quirks file ${JSON.stringify(path)} leads out of the plugin`);
  const raw: unknown = JSON.parse(readFileSync(real, "utf8"));
  const parsed = QuirksFileSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`the quirks file doesn't hold a backend's quirks: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "file"}: ${i.message}`).join("; ")}`);
  return parsed.data as QuirksFile;
}

/** One contributed ACP backend, as the core builds it. */
export interface ContributedBackend {
  id: string;
  pluginId: string;
  name: string;
  /** The bundled `clover/agent-<id>`: what the core grants by backend id applies. */
  bundled: boolean;
  file: QuirksFile;
  /** The entry's program and its ACP arguments. */
  command: { program: string; acpArgs: readonly string[] };
  /** The file's quirks with that command. */
  quirks: AgentQuirks;
}

/** The `agentBackends` entries that are on, read into backends' rows; an entry whose file fails is left out. */
export function contributedBackends(registry: Pick<PluginRegistry, "entries" | "get">, log?: (line: string) => void): ContributedBackend[] {
  const out: ContributedBackend[] = [];
  for (const c of registry.entries("agentBackends")) {
    if (c.state !== "active") continue;
    const v = c.value as { id?: string; name?: string; protocol?: string; command?: string; args?: string[]; quirks?: string };
    const id = v.id ?? c.entryId;
    if (!id || v.protocol !== "acp" || !v.command) continue;
    const record = registry.get(c.pluginId);
    if (!record) continue;
    if (!v.quirks) {
      log?.(`agents: ${c.pluginId}'s backend ${id} names no quirks file, so it isn't offered`);
      continue;
    }
    let file: QuirksFile;
    try {
      file = readQuirksFile(record.folder, v.quirks);
    } catch (err) {
      log?.(`agents: ${c.pluginId}'s backend ${id} isn't offered: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const command = { program: v.command, acpArgs: v.args ?? [] };
    out.push({
      id, pluginId: c.pluginId, name: v.name ?? id, bundled: c.pluginId === bundledAgentPluginId(id) && record.provenance.by === "bundled",
      file, command, quirks: quirksWithCommand(file.quirks, command),
    });
  }
  return out;
}

/** Builds each contributed backend once per plugin tree, so a session keeps its backend object while the plugin holds. */
export class ContributedBackendCache<B extends AgentBackend> {
  readonly #built = new Map<string, { key: string; backend: B }>();
  constructor(private readonly build: (c: ContributedBackend) => B) {}

  backends(registry: Pick<PluginRegistry, "entries" | "get">, log?: (line: string) => void): B[] {
    const seen = new Set<string>();
    const out: B[] = [];
    for (const c of contributedBackends(registry, log)) {
      const key = `${c.pluginId}\u0000${registry.get(c.pluginId)?.treeHash ?? ""}\u0000${JSON.stringify(c.file)}\u0000${JSON.stringify(c.command)}`;
      seen.add(c.id);
      const had = this.#built.get(c.id);
      if (had && had.key === key) {
        out.push(had.backend);
        continue;
      }
      const backend = this.build(c);
      this.#built.set(c.id, { key, backend });
      out.push(backend);
    }
    for (const id of [...this.#built.keys()]) if (!seen.has(id)) this.#built.delete(id);
    return out;
  }
}
