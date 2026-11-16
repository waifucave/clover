// What the copy cannot bring over (ruling 7), and the notice that says so once. MOSS never reads the old install's
// Keychain service or its app's protected storage: on macOS that raises a password prompt, which the owner forbids,
// and `MOSS_NEVER_PERMITTED` refuses the name. So model keys, provider and MCP sign-ins, plugins' own secrets, routine
// webhook keys, this computer's answer key and the paired devices stay with the old install. The copy knows which
// existed from the old home's NON-secret records, read only: the secret store's index (names, never values) and the
// device registry (names and kinds, never keys).
import { OLD_APP_NAME as OLD } from "../../other-installs";
import { mapPluginId } from "./names";

export interface LeftBehind {
  v: 1;
  /** Sign-ins and keys the core held (`anthropic:default`, `codex-oauth:default`), by name. */
  core: string[];
  /** Plugins' own secrets, by plugin (mapped id), with their names. */
  plugins: { pluginId: string; names: string[] }[];
  /** Routines whose webhook keys are new. */
  webhooks: number;
  /** The paired devices, by name and kind. */
  devices: { name: string; kind: string }[];
}

/** The core's own items that are the engine's plumbing (made again by themselves), never a sign-in to set up. */
const PLUMBING = /^(?:plugin-registry|registry|harness-token|remote-token|app-token|device|link|box|answer|counter|token|sync|group|pair)/i;

const SECRET_NAME = /^[A-Za-z0-9._:-]{1,128}$/;

/** What was left behind, from the old secret store's index and device registry (each the file's text, or absent). */
export function leftBehindFrom(o: { credentialsIndex?: string; devices?: string }): LeftBehind {
  const out: LeftBehind = { v: 1, core: [], plugins: [], webhooks: 0, devices: [] };
  try {
    const index = o.credentialsIndex === undefined ? undefined : (JSON.parse(o.credentialsIndex) as { items?: Record<string, { ref?: { owner?: { kind?: string; pluginId?: string }; name?: string } }> });
    const byPlugin = new Map<string, Set<string>>();
    for (const meta of Object.values(index?.items ?? {}).slice(0, 4096)) {
      const name = meta?.ref?.name;
      const owner = meta?.ref?.owner;
      if (typeof name !== "string" || !SECRET_NAME.test(name) || owner === undefined) continue;
      if (owner.kind === "plugin" && typeof owner.pluginId === "string") {
        const id = mapPluginId(owner.pluginId);
        byPlugin.set(id, (byPlugin.get(id) ?? new Set()).add(name));
      } else if (owner.kind === "core") {
        if (name.startsWith("routine-webhook:")) out.webhooks++;
        else if (!PLUMBING.test(name) && !out.core.includes(name)) out.core.push(name);
      }
    }
    out.plugins = [...byPlugin].map(([pluginId, names]) => ({ pluginId, names: [...names].sort() })).sort((a, b) => a.pluginId.localeCompare(b.pluginId));
    out.core.sort();
  } catch {
    /* no index that reads: nothing named */
  }
  try {
    const reg = o.devices === undefined ? undefined : (JSON.parse(o.devices) as { self?: string; devices?: { id?: string; name?: string; kind?: string }[] });
    for (const d of (reg?.devices ?? []).slice(0, 1024)) {
      if (d.id === reg?.self || typeof d.name !== "string") continue;
      out.devices.push({ name: d.name.slice(0, 63), kind: typeof d.kind === "string" ? d.kind : "device" });
    }
  } catch {
    /* no registry that reads */
  }
  return out;
}

/** A provider's name as a person says it, from a sign-in's name or a model plugin's id. */
function providerName(s: string): string {
  const base = s.replace(/^moss\//, "").replace(/(?:-oauth)?:.*$/, "");
  const known: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI", codex: "Codex", google: "Google", gemini: "Gemini", groq: "Groq", openrouter: "OpenRouter", xai: "xAI", mistral: "Mistral", fish: "Fish Audio", elevenlabs: "ElevenLabs" };
  return known[base] ?? base;
}

/** The notice's lines, said once after the copy: plain words, no secret, no value. Empty when nothing was left. */
export function leftBehindLines(l: LeftBehind): string[] {
  const lines: string[] = [];
  const signIns = [...new Set([...l.core.map(providerName), ...l.plugins.map((p) => `${providerName(p.pluginId)} (${p.names.join(", ")})`)])];
  if (signIns.length > 0) lines.push(`Sign in again or enter your keys again for: ${signIns.join("; ")}. They stay in ${OLD}'s protected storage, which MOSS doesn't open.`);
  if (l.webhooks > 0) lines.push(`${l.webhooks === 1 ? "One routine's webhook has" : `${l.webhooks} routines' webhooks have`} a new key: give the new address to whatever calls it.`);
  if (l.devices.length > 0) lines.push(`Pair these devices again: ${l.devices.map((d) => `${d.name} (${d.kind})`).join(", ")}.`);
  if (lines.length > 0) lines.push(`This computer's answer key is new too: a phone that answered cards for ${OLD} pairs again.`);
  return lines;
}
