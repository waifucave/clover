// The bundled backends' rows, read from their plugins (`plugins/clover/plugins/agent-<id>/`), for the suites that check
// every row: the same files the registry hands the core, through the same reader.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentQuirks } from "../../contracts/agent-backend";
import { quirksWithCommand, readQuirksFile, type QuirksFile } from "../plugin-backends";

/** The repository's bundled plugins folder. */
export const BUNDLED_PLUGINS_DIR = join(import.meta.dir, "..", "..", "..", "..", "..", "plugins", "clover", "plugins");

export interface BundledBackend {
  id: string;
  pluginId: string;
  folder: string;
  name: string;
  file: QuirksFile;
  /** The descriptor the core builds: the file's quirks with the entry's command. */
  quirks: AgentQuirks;
}

/** Every `agent-<id>` plugin's backend, by id. */
export function bundledBackends(dir = BUNDLED_PLUGINS_DIR): Record<string, BundledBackend> {
  const out: Record<string, BundledBackend> = {};
  for (const name of readdirSync(dir).filter((n) => n.startsWith("agent-")).sort()) {
    const folder = join(dir, name);
    const manifest = JSON.parse(readFileSync(join(folder, "clover.json"), "utf8")) as { contributes: { agentBackends: { id: string; name: string; command: string; args?: string[]; quirks: string }[] } };
    for (const b of manifest.contributes.agentBackends) {
      const file = readQuirksFile(folder, b.quirks);
      out[b.id] = { id: b.id, pluginId: `clover/${name}`, folder, name: b.name, file, quirks: quirksWithCommand(file.quirks, { program: b.command, acpArgs: b.args ?? [] }) };
    }
  }
  return out;
}
