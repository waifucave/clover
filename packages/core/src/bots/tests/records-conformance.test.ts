// The BotRecords conformance suite against the REAL records store (`bots/records.ts`), each case on a fresh temp home.
// The plugins' bot-scoped settings come through the store's port (`BotPluginSettingsPort`); here an in-memory one that
// stands in for the plugin host, driven by the suite's `declareBotSettings`.
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBotRecordsConformance } from "../../contracts/conformance/bot-records";
import { BotRecordStore, type BotPluginSettingsPort } from "../records";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

/** The plugin host's per-bot values, in memory. */
export class MemoryBotSettings implements BotPluginSettingsPort {
  readonly #declared = new Map<string, { key: string; scope: "account" | "device" | "bot"; default?: unknown }[]>();
  readonly #values = new Map<string, unknown>();
  declare(pluginId: string, settings: { key: string; scope: "account" | "device" | "bot"; default?: unknown }[]): void {
    this.#declared.set(pluginId, settings.map((s) => ({ ...s })));
  }
  declared() {
    return [...this.#declared].map(([pluginId, settings]) => ({ pluginId, settings }));
  }
  value(bot: string, pluginId: string, key: string): { set: true; value: unknown } | { set: false } {
    const k = `${bot}\0${pluginId}\0${key}`;
    return this.#values.has(k) ? { set: true, value: this.#values.get(k) } : { set: false };
  }
  async set(bot: string, pluginId: string, key: string, value: unknown): Promise<void> {
    const k = `${bot}\0${pluginId}\0${key}`;
    if (value === null) this.#values.delete(k);
    else this.#values.set(k, value);
  }
}

runBotRecordsConformance(({ clock }) => {
  const home = mkdtempSync(join(tmpdir(), "bt-records-"));
  temps.push(home);
  const settings = new MemoryBotSettings();
  const store = new BotRecordStore({ home, clock, pluginSettings: settings });
  return Object.assign(store, { declareBotSettings: (pluginId: string, s: Parameters<MemoryBotSettings["declare"]>[1]) => settings.declare(pluginId, s) });
});
